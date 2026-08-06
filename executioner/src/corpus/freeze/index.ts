import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  validateContractImpact,
  type ContractImpact,
} from "../contract-impact/index.ts";
import {
  buildImpactMap,
  validateImpactMap,
  type VariantDeclaration,
} from "../impact-map/index.ts";
import {
  corpusManifestFromCsv,
  validateCorpusManifest,
} from "../manifest/index.ts";
import { canonicalJson, normalizeTextLineEndings } from "../shared.ts";
import { validateCorpusFixtures } from "../capture/index.ts";
import { createCorpusBaseline } from "../runner/index.ts";

export const acceptedImpactSha =
  "sha256.0ef3d9b22e2813d3f459c2c8fab4c344f24f0ab886f23cf69de72ca97c3c62d4" as const;
export const acceptedPrerequisiteTask = "S3-F2-T13" as const;

const dormantF3Paths = [
  "catalogs/workday/reviewed-v1.json",
  "fixtures/workday/s3",
  "fixtures/workday/semantics",
  "scripts/catalog-migrate.ts",
  "scripts/catalog-validate.ts",
  "scripts/corpus-semantic.ts",
  "src/form/answers/semantic-engine.ts",
  "src/form/answers/semantic-matrix.ts",
  "src/form/options/semantic-options.ts",
  "src/form/questions/migration",
  "src/form/questions/workday-catalog.ts",
  "tests/fixtures/workday/semantics",
] as const;

export interface FreezeSource {
  readonly repositoryRoot: string;
  readonly executionerRoot: string;
  readonly sourceRevision: string;
  readonly sourceTree: string;
  readonly clean: boolean;
  readonly packageLockPath: string;
  readonly manifestPath: string;
  readonly variantMapPath: string;
  readonly fixtureManifestPath: string;
  readonly declarationsPath: string;
  readonly impactPath: string;
  readonly baselinePath: string;
  readonly sourceSnapshotPath: string;
  readonly configPath: string;
  readonly fixtureRoot: string;
}

export interface FrozenInput {
  readonly kind:
    | "package_lock"
    | "corpus_manifest"
    | "fixture_manifest"
    | "variant_map"
    | "variant_declarations"
    | "contract_impact"
    | "baseline"
    | "corpus_source"
    | "runtime_config"
    | "fixture";
  readonly path: string;
  readonly sha256: string;
}

export interface F3DormancySummary {
  readonly taskCount: 12;
  readonly activatedCount: 0;
  readonly variantEvidenceCount: 0;
  readonly fixtureEvidenceCount: 0;
  readonly slotEvidenceCount: 0;
}

export interface FrozenCorpusBundle {
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
  readonly sourceTree: string;
  readonly slotCount: 40;
  readonly runId: string;
  readonly identity: string;
  readonly rootRelativeFromBundle: string;
  readonly impactSha: typeof acceptedImpactSha;
  readonly prerequisiteTask: typeof acceptedPrerequisiteTask;
  readonly f3: F3DormancySummary;
  readonly maxAttemptsPerFixture: number;
  readonly mode: "deterministic_fixture";
  readonly inputs: readonly FrozenInput[];
  readonly seal: string;
}

export interface CurrentFreezeIdentity {
  readonly sourceRevision: string;
  readonly sourceTree: string;
  readonly clean: boolean;
}

type JsonObject = Readonly<Record<string, unknown>>;

interface AcceptedInputPaths {
  readonly executionerRoot: string;
  readonly manifestPath: string;
  readonly variantMapPath: string;
  readonly fixtureManifestPath: string;
  readonly declarationsPath: string;
  readonly impactPath: string;
  readonly baselinePath: string;
  readonly sourceSnapshotPath: string;
  readonly configPath: string;
  readonly fixtureRoot: string;
}

export async function createFrozenBundle(
  source: FreezeSource,
  bundlePath: string,
): Promise<FrozenCorpusBundle> {
  if (!source.clean) throw new Error("dirty source tree");
  if (!/^[0-9a-f]{40}$/u.test(source.sourceRevision)) invalid("source revision");
  if (!/^[0-9a-f]{40}$/u.test(source.sourceTree)) invalid("source tree");

  const { f3, maxAttemptsPerFixture } = await validateAcceptedInputs(source);

  const fixedInputs = [
    ["package_lock", source.packageLockPath],
    ["corpus_manifest", source.manifestPath],
    ["fixture_manifest", source.fixtureManifestPath],
    ["variant_map", source.variantMapPath],
    ["variant_declarations", source.declarationsPath],
    ["contract_impact", source.impactPath],
    ["baseline", source.baselinePath],
    ["corpus_source", source.sourceSnapshotPath],
    ["runtime_config", source.configPath],
  ] as const;
  const fixturePaths = (await files(source.fixtureRoot))
    .filter((path) => resolve(path) !== resolve(source.fixtureManifestPath));
  if (fixturePaths.length !== 4) invalid("accepted fixture set");

  const inputs: FrozenInput[] = [];
  for (const [kind, path] of fixedInputs) {
    inputs.push({
      kind,
      path: safeRelative(source.repositoryRoot, path),
      sha256: await hashFile(path),
    });
  }
  for (const path of fixturePaths) {
    inputs.push({
      kind: "fixture",
      path: safeRelative(source.repositoryRoot, path),
      sha256: await hashFile(path),
    });
  }
  inputs.sort((left, right) => left.path.localeCompare(right.path));

  const identityCore = {
    schemaVersion: 1 as const,
    sourceRevision: source.sourceRevision,
    sourceTree: source.sourceTree,
    slotCount: 40 as const,
    impactSha: acceptedImpactSha,
    prerequisiteTask: acceptedPrerequisiteTask,
    f3,
    maxAttemptsPerFixture,
    mode: "deterministic_fixture" as const,
    inputs: Object.freeze(inputs),
  };
  const identity = hash(canonicalJson(identityCore));
  const unsealed = {
    ...identityCore,
    runId: `corpus-${digestHex(identity).slice(0, 20)}`,
    identity,
    rootRelativeFromBundle: (
      relative(dirname(resolve(bundlePath)), resolve(source.repositoryRoot)) || "."
    ).replaceAll(sep, "/"),
  };
  const bundle: FrozenCorpusBundle = Object.freeze({
    ...unsealed,
    seal: hash(canonicalJson(unsealed)),
  });
  await writeLocked(bundlePath, `${canonicalJson(bundle)}\n`);
  return bundle;
}

export async function verifyFrozenBundle(
  bundlePath: string,
  current?: CurrentFreezeIdentity,
): Promise<FrozenCorpusBundle> {
  const bundle = object(await json(bundlePath)) as unknown as FrozenCorpusBundle;
  const { seal, ...unsealed } = bundle;
  const identityCore = {
    schemaVersion: bundle.schemaVersion,
    sourceRevision: bundle.sourceRevision,
    sourceTree: bundle.sourceTree,
    slotCount: bundle.slotCount,
    impactSha: bundle.impactSha,
    prerequisiteTask: bundle.prerequisiteTask,
    f3: bundle.f3,
    maxAttemptsPerFixture: bundle.maxAttemptsPerFixture,
    mode: bundle.mode,
    inputs: bundle.inputs,
  };
  if (
    !exactKeys(bundle as unknown as JsonObject, [
      "schemaVersion",
      "sourceRevision",
      "sourceTree",
      "slotCount",
      "runId",
      "identity",
      "rootRelativeFromBundle",
      "impactSha",
      "prerequisiteTask",
      "f3",
      "maxAttemptsPerFixture",
      "mode",
      "inputs",
      "seal",
    ]) ||
    bundle.schemaVersion !== 1 ||
    !/^[0-9a-f]{40}$/u.test(bundle.sourceRevision) ||
    !/^[0-9a-f]{40}$/u.test(bundle.sourceTree) ||
    bundle.slotCount !== 40 ||
    bundle.impactSha !== acceptedImpactSha ||
    bundle.prerequisiteTask !== acceptedPrerequisiteTask ||
    bundle.mode !== "deterministic_fixture" ||
    !validF3(bundle.f3) ||
    !Number.isSafeInteger(bundle.maxAttemptsPerFixture) ||
    bundle.maxAttemptsPerFixture < 1 ||
    bundle.maxAttemptsPerFixture > 3 ||
    !validFrozenInputs(bundle.inputs) ||
    typeof bundle.rootRelativeFromBundle !== "string" ||
    bundle.rootRelativeFromBundle === "" ||
    bundle.rootRelativeFromBundle.includes("\\") ||
    !/^sha256\.[0-9a-f]{64}$/u.test(bundle.identity) ||
    !/^sha256\.[0-9a-f]{64}$/u.test(bundle.seal) ||
    seal !== hash(canonicalJson(unsealed)) ||
    bundle.identity !== hash(canonicalJson(identityCore)) ||
    bundle.runId !== `corpus-${digestHex(bundle.identity).slice(0, 20)}`
  ) {
    throw new Error("frozen bundle invalid");
  }
  if (
    current !== undefined &&
    (!current.clean ||
      current.sourceRevision !== bundle.sourceRevision ||
      current.sourceTree !== bundle.sourceTree)
  ) {
    throw new Error("frozen source drift");
  }

  const root = resolve(
    dirname(resolve(bundlePath)),
    bundle.rootRelativeFromBundle,
  );
  for (const input of bundle.inputs) {
    const path = resolve(root, input.path);
    if (!inside(root, path) || await hashFile(path) !== input.sha256) {
      throw new Error(`frozen input drift: ${input.path}`);
    }
  }
  const paths = await acceptedPathsFromBundle(bundle, root);
  const accepted = await validateAcceptedInputs(paths);
  if (
    canonicalJson(accepted.f3) !== canonicalJson(bundle.f3) ||
    accepted.maxAttemptsPerFixture !== bundle.maxAttemptsPerFixture
  ) {
    throw new Error("frozen acceptance assertions changed");
  }
  return Object.freeze(bundle);
}

async function validateAcceptedInputs(
  source: AcceptedInputPaths,
): Promise<{
  readonly f3: F3DormancySummary;
  readonly maxAttemptsPerFixture: number;
}> {
  const manifest = await json(source.manifestPath);
  const fixtureManifest = await json(source.fixtureManifestPath);
  const variants = await json(source.variantMapPath);
  const declarations = object(await json(source.declarationsPath));
  const sourceReconciliation = object(await json(source.baselinePath));
  const sourceSnapshot = await readFile(source.sourceSnapshotPath, "utf8");
  const impact = await json(source.impactPath);
  const config = object(await json(source.configPath));

  assertNoErrors("corpus manifest", validateCorpusManifest(manifest));
  if (
    typeof sourceReconciliation.sourceDigest !== "string" ||
    hash(normalizeTextLineEndings(sourceSnapshot)) !== sourceReconciliation.sourceDigest
  ) {
    throw new Error("corpus source digest mismatch");
  }
  const reconciledManifest = corpusManifestFromCsv({
    csv: sourceSnapshot,
    sourceRevision: reconciliationRevision(sourceReconciliation),
    evidenceDigests: strings(sourceReconciliation.evidenceDigests),
    unavailableSlots: unavailableSlots(sourceReconciliation.unavailableSlots),
  });
  if (canonicalJson(manifest) !== canonicalJson(reconciledManifest)) {
    throw new Error("corpus manifest does not match retained source");
  }
  assertNoErrors(
    "corpus fixtures",
    validateCorpusFixtures(source.fixtureRoot, fixtureManifest, manifest),
  );
  assertNoErrors(
    "variant map",
    validateImpactMap(
      variants,
      fixtureManifest,
      manifest,
      source.executionerRoot,
    ),
  );
  assertDeclarations(declarations, fixtureManifest, variants);
  const baseline = createCorpusBaseline({
    manifest,
    fixtures: fixtureManifest,
    variants,
    sourceRevision: reconciliationRevision(sourceReconciliation),
    fixtureRoot: source.fixtureRoot,
  });
  assertNoErrors(
    "contract impact",
    validateContractImpact(impact, {
      manifest,
      fixtures: fixtureManifest,
      variants,
      baseline,
    }),
  );
  const f3 = assertAcceptedImpact(impact as ContractImpact);
  const maxAttemptsPerFixture = assertConfig(config);
  const dormantArtifacts = await findDormantF3Artifacts(
    source.executionerRoot,
  );
  if (dormantArtifacts.length > 0) {
    throw new Error(
      `dormant S3-F3 artifact present: ${dormantArtifacts.join(",")}`,
    );
  }
  return { f3, maxAttemptsPerFixture };
}

async function acceptedPathsFromBundle(
  bundle: FrozenCorpusBundle,
  root: string,
): Promise<AcceptedInputPaths> {
  const path = (kind: FrozenInput["kind"]): string => {
    const matches = bundle.inputs.filter((input) => input.kind === kind);
    if (matches.length !== 1) throw new Error("frozen input set invalid");
    return resolve(root, matches[0]!.path);
  };
  const packageLockPath = path("package_lock");
  const fixtureManifestPath = path("fixture_manifest");
  const fixtureRoot = dirname(fixtureManifestPath);
  const expectedFixtures = (await files(fixtureRoot))
    .filter((fixture) => resolve(fixture) !== resolve(fixtureManifestPath))
    .map((fixture) => resolve(fixture))
    .sort();
  const frozenFixtures = bundle.inputs
    .filter((input) => input.kind === "fixture")
    .map((input) => resolve(root, input.path))
    .sort();
  if (
    frozenFixtures.length !== 4 ||
    canonicalJson(frozenFixtures) !== canonicalJson(expectedFixtures)
  ) {
    throw new Error("frozen fixture set invalid");
  }
  return {
    executionerRoot: dirname(packageLockPath),
    manifestPath: path("corpus_manifest"),
    variantMapPath: path("variant_map"),
    fixtureManifestPath,
    declarationsPath: path("variant_declarations"),
    impactPath: path("contract_impact"),
    baselinePath: path("baseline"),
    sourceSnapshotPath: path("corpus_source"),
    configPath: path("runtime_config"),
    fixtureRoot,
  };
}

function assertAcceptedImpact(impact: ContractImpact): F3DormancySummary {
  if (impact.impactSha !== acceptedImpactSha) {
    throw new Error("accepted impact SHA mismatch");
  }
  const prerequisite = impact.taskActivations.find(
    (task) => task.taskId === acceptedPrerequisiteTask,
  );
  if (
    prerequisite?.decision !== "activated" ||
    !prerequisite.exactBlocks.includes("S3-F4-T1")
  ) {
    throw new Error("S3-F4 prerequisite mismatch");
  }
  const f3 = impact.taskActivations
    .filter((task) => /^S3-F3-T(?:[1-9]|1[0-2])$/u.test(task.taskId));
  const exactIds = Array.from(
    { length: 12 },
    (_, index) => `S3-F3-T${index + 1}`,
  );
  const byId = new Map(f3.map((task) => [task.taskId, task]));
  if (
    f3.length !== 12 ||
    exactIds.some((id) => {
      const task = byId.get(id);
      return task === undefined ||
      task.decision !== "not-activated" ||
      task.variantIds.length !== 0 ||
      task.provingFixtures.length !== 0 ||
      task.provingSlots.length !== 0;
    })
  ) {
    throw new Error("dormant S3-F3 assertion failed");
  }
  return Object.freeze({
    taskCount: 12,
    activatedCount: 0,
    variantEvidenceCount: 0,
    fixtureEvidenceCount: 0,
    slotEvidenceCount: 0,
  });
}

function assertConfig(config: JsonObject): number {
  if (
    !exactKeys(config, [
      "schemaVersion",
      "mode",
      "prerequisiteTask",
      "impactSha",
      "maxAttemptsPerFixture",
    ]) ||
    config.schemaVersion !== 1 ||
    config.mode !== "deterministic_fixture" ||
    config.prerequisiteTask !== acceptedPrerequisiteTask ||
    config.impactSha !== acceptedImpactSha ||
    !Number.isSafeInteger(config.maxAttemptsPerFixture) ||
    Number(config.maxAttemptsPerFixture) < 1 ||
    Number(config.maxAttemptsPerFixture) > 3
  ) {
    throw new Error("acceptance configuration invalid");
  }
  return Number(config.maxAttemptsPerFixture);
}

function assertDeclarations(
  declarations: JsonObject,
  fixtureManifest: unknown,
  variants: unknown,
): void {
  if (
    !exactKeys(declarations, ["schemaVersion", "variants"]) ||
    declarations.schemaVersion !== 1 ||
    !Array.isArray(declarations.variants)
  ) {
    invalid("variant declarations");
  }
  const built = buildImpactMap(
    fixtureManifest,
    declarations.variants as readonly VariantDeclaration[],
  );
  if (canonicalJson(built) !== canonicalJson(variants)) {
    invalid("variant declarations");
  }
}

function reconciliationRevision(value: JsonObject): string {
  if (
    value.schemaVersion !== 1 ||
    typeof value.sourceRevision !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision)
  ) {
    invalid("source reconciliation");
  }
  return value.sourceRevision;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : invalid("source reconciliation evidence digests");
}

function unavailableSlots(value: unknown): ReadonlyMap<
  number,
  "maintenance" | "removed" | "closed" | "not_found" | "access_control"
> {
  const record = object(value);
  const allowed = new Set(["maintenance", "removed", "closed", "not_found", "access_control"]);
  const entries = Object.entries(record).map(([slot, reason]) => {
    const number = Number(slot);
    if (!Number.isInteger(number) || number < 1 || number > 40 ||
      typeof reason !== "string" || !allowed.has(reason)) {
      invalid("source reconciliation unavailable slots");
    }
    return [number, reason] as const;
  });
  return new Map(entries) as ReadonlyMap<
    number,
    "maintenance" | "removed" | "closed" | "not_found" | "access_control"
  >;
}

export async function findDormantF3Artifacts(
  executionerRoot: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const path of dormantF3Paths) {
    let dormant;
    try {
      dormant = await stat(resolve(executionerRoot, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      dormant.isDirectory() &&
      (await files(resolve(executionerRoot, path))).length === 0
    ) {
      continue;
    }
    found.push(path);
  }
  const packageJson = object(
    await json(resolve(executionerRoot, "package.json")),
  );
  const scripts = object(packageJson.scripts);
  found.push(...Object.keys(scripts)
    .filter((name) => /(?:catalog|semantic)/u.test(name))
    .map((name) => `package-script:${name}`));
  return Object.freeze([...new Set(found)].sort());
}

function validF3(value: unknown): value is F3DormancySummary {
  const record = object(value);
  return exactKeys(record, [
    "taskCount",
    "activatedCount",
    "variantEvidenceCount",
    "fixtureEvidenceCount",
    "slotEvidenceCount",
  ]) &&
    record.taskCount === 12 &&
    record.activatedCount === 0 &&
    record.variantEvidenceCount === 0 &&
    record.fixtureEvidenceCount === 0 &&
    record.slotEvidenceCount === 0;
}

function validFrozenInputs(value: unknown): value is readonly FrozenInput[] {
  if (!Array.isArray(value) || value.length !== 13) return false;
  const allowed = new Set([
    "package_lock",
    "corpus_manifest",
    "fixture_manifest",
    "variant_map",
    "variant_declarations",
    "contract_impact",
    "baseline",
    "corpus_source",
    "runtime_config",
    "fixture",
  ]);
  const paths = new Set<string>();
  for (const candidate of value) {
    const input = object(candidate);
    if (
      !exactKeys(input, ["kind", "path", "sha256"]) ||
      typeof input.kind !== "string" ||
      !allowed.has(input.kind) ||
      typeof input.path !== "string" ||
      input.path === "" ||
      input.path.includes("\\") ||
      paths.has(input.path) ||
      typeof input.sha256 !== "string" ||
      !/^sha256\.[0-9a-f]{64}$/u.test(input.sha256)
    ) {
      return false;
    }
    paths.add(input.path);
  }
  return true;
}

function assertNoErrors(name: string, errors: readonly string[]): void {
  if (errors.length > 0) {
    throw new Error(`${name} invalid: ${errors.join("; ")}`);
  }
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function object(value: unknown): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    invalid("JSON object");
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index]);
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
  if (!(await stat(path)).isFile()) {
    throw new Error(`frozen input unavailable: ${path}`);
  }
  return hash(normalizeTextLineEndings(await readFile(path, "utf8")));
}

function hash(value: string | Uint8Array): string {
  return `sha256.${createHash("sha256").update(value).digest("hex")}`;
}

function digestHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelative(root: string, path: string): string {
  const normalized = resolve(path);
  if (!inside(root, normalized)) {
    throw new Error("frozen input outside repository");
  }
  return relative(resolve(root), normalized).replaceAll(sep, "/");
}

function inside(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" ||
    (!child.startsWith("..") && !child.includes(`..${sep}`));
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
