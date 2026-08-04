import { createHash } from "node:crypto";
import {
  open,
  mkdir,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface FreezeSource {
  readonly repositoryRoot: string;
  readonly executionerRoot: string;
  readonly sourceRevision: string;
  readonly sourceTree: string;
  readonly clean: boolean;
  readonly packageLockPath: string;
  readonly manifestPath: string;
  readonly variantMapPath: string;
  readonly configPath: string;
  readonly fixtureRoot: string;
}

interface FrozenInput {
  readonly kind: "package_lock" | "corpus_manifest" | "variant_map" | "runtime_config" | "fixture";
  readonly path: string;
  readonly sha256: string;
}

export interface FrozenCorpusBundle {
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly sourceTree: string;
  readonly slotCount: 40;
  readonly runId: string;
  readonly identity: string;
  readonly rootRelativeFromBundle: string;
  readonly accountRefs: readonly string[];
  readonly maxAttemptsPerSlot: number;
  readonly mode: "deterministic_fixture" | "live_corpus";
  readonly inputs: readonly FrozenInput[];
  readonly seal: string;
}

export interface CurrentFreezeIdentity {
  readonly sourceRevision: string;
  readonly sourceTree: string;
  readonly clean: boolean;
}

type JsonObject = Readonly<Record<string, unknown>>;

export async function createFrozenBundle(
  source: FreezeSource,
  bundlePath: string,
): Promise<FrozenCorpusBundle> {
  if (!source.clean) throw new Error("dirty source tree");
  if (!/^[0-9a-f]{40}$/u.test(source.sourceRevision)) invalid("source revision");
  if (!/^[0-9a-f]{40}$/u.test(source.sourceTree)) invalid("source tree");

  const manifest = object(await json(source.manifestPath));
  const slots = Array.isArray(manifest.slots) ? manifest.slots : [];
  if (manifest.schemaVersion !== 1 || slots.length !== 40) invalid("corpus manifest");
  const slotIds = new Set<string>();
  const families = new Set<string>();
  for (const value of slots) {
    const slot = object(value);
    if (
      !semanticId(slot.slotId) ||
      slotIds.has(slot.slotId) ||
      !semanticId(slot.variantFamily) ||
      !["available", "removed", "closed", "not_found", "maintenance", "replaced"].includes(
        String(slot.availability),
      )
    ) invalid("corpus manifest");
    slotIds.add(slot.slotId);
    families.add(slot.variantFamily);
  }

  const variantMap = object(await json(source.variantMapPath));
  const mappedFamilies = Array.isArray(variantMap.families) ? variantMap.families : [];
  if (
    variantMap.schemaVersion !== 1 ||
    ![...families].every((family) => mappedFamilies.includes(family))
  ) invalid("variant map");

  const config = object(await json(source.configPath));
  const accountRefs = Array.isArray(config.accountRefs) ? config.accountRefs : [];
  if (
    config.schemaVersion !== 1 ||
    (config.mode !== "deterministic_fixture" && config.mode !== "live_corpus") ||
    !Number.isSafeInteger(config.maxAttemptsPerSlot) ||
    Number(config.maxAttemptsPerSlot) < 1 ||
    Number(config.maxAttemptsPerSlot) > 3 ||
    accountRefs.length === 0 ||
    !accountRefs.every(semanticId) ||
    forbiddenConfigKey(config)
  ) throw new Error("acceptance configuration invalid");

  const fixedInputs = [
    ["package_lock", source.packageLockPath],
    ["corpus_manifest", source.manifestPath],
    ["variant_map", source.variantMapPath],
    ["runtime_config", source.configPath],
  ] as const;
  const fixturePaths = await files(source.fixtureRoot);
  if (fixturePaths.length === 0) invalid("fixture set");
  const inputs: FrozenInput[] = [];
  for (const [kind, path] of fixedInputs) {
    inputs.push({ kind, path: safeRelative(source.repositoryRoot, path), sha256: await hashFile(path) });
  }
  for (const path of fixturePaths) {
    inputs.push({ kind: "fixture", path: safeRelative(source.repositoryRoot, path), sha256: await hashFile(path) });
  }
  inputs.sort((left, right) => left.path.localeCompare(right.path));

  const core = {
    schemaVersion: 1 as const,
    sourceRevision: source.sourceRevision,
    sourceTree: source.sourceTree,
    slotCount: 40 as const,
    rootRelativeFromBundle: relative(dirname(resolve(bundlePath)), resolve(source.repositoryRoot)) || ".",
    accountRefs: Object.freeze(accountRefs as string[]),
    maxAttemptsPerSlot: Number(config.maxAttemptsPerSlot),
    mode: config.mode,
    inputs: Object.freeze(inputs),
  };
  const identity = hash(stable(core));
  const unsealed = { ...core, runId: `corpus-${hash(identity).slice(0, 20)}`, identity };
  const bundle: FrozenCorpusBundle = Object.freeze({
    ...unsealed,
    seal: hash(stable(unsealed)),
  });
  await writeLocked(bundlePath, `${stable(bundle)}\n`);
  return bundle;
}

export async function verifyFrozenBundle(
  bundlePath: string,
  current?: CurrentFreezeIdentity,
): Promise<FrozenCorpusBundle> {
  const bundle = object(await json(bundlePath)) as unknown as FrozenCorpusBundle;
  const { seal, ...unsealed } = bundle;
  if (
    bundle.schemaVersion !== 1 ||
    bundle.slotCount !== 40 ||
    !Array.isArray(bundle.inputs) ||
    seal !== hash(stable(unsealed)) ||
    bundle.identity !== hash(stable({
      schemaVersion: bundle.schemaVersion,
      sourceRevision: bundle.sourceRevision,
      sourceTree: bundle.sourceTree,
      slotCount: bundle.slotCount,
      rootRelativeFromBundle: bundle.rootRelativeFromBundle,
      accountRefs: bundle.accountRefs,
      maxAttemptsPerSlot: bundle.maxAttemptsPerSlot,
      mode: bundle.mode,
      inputs: bundle.inputs,
    })) ||
    bundle.runId !== `corpus-${hash(bundle.identity).slice(0, 20)}`
  ) throw new Error("frozen bundle invalid");
  if (
    current !== undefined &&
    (!current.clean ||
      current.sourceRevision !== bundle.sourceRevision ||
      current.sourceTree !== bundle.sourceTree)
  ) throw new Error("frozen source drift");
  const root = resolve(dirname(resolve(bundlePath)), bundle.rootRelativeFromBundle);
  for (const input of bundle.inputs) {
    const path = resolve(root, input.path);
    if (!inside(root, path) || (await hashFile(path)) !== input.sha256) {
      throw new Error(`frozen input drift: ${input.path}`);
    }
  }
  return Object.freeze(bundle);
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function object(value: unknown): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalid("JSON object");
  return value as JsonObject;
}

function semanticId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/u.test(value);
}

function forbiddenConfigKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenConfigKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    /password|secret|token|credential|email|url|cookie|submit/iu.test(key) || forbiddenConfigKey(child),
  );
}

async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

async function hashFile(path: string): Promise<string> {
  if (!(await stat(path)).isFile()) throw new Error(`frozen input unavailable: ${path}`);
  return hash(await readFile(path));
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeRelative(root: string, path: string): string {
  const normalized = resolve(path);
  if (!inside(root, normalized)) throw new Error("frozen input outside repository");
  return relative(resolve(root), normalized).replaceAll(sep, "/");
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

async function writeLocked(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(value, "utf8");
  } finally {
    await handle.close();
  }
}

function invalid(name: string): never {
  throw new Error(`${name} invalid`);
}
