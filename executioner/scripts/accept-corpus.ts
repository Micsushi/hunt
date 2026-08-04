import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runFrozenAcceptance,
  type AcceptedOutcome,
  type AcceptancePorts,
} from "../src/corpus/acceptance/index.ts";
import { verifyFrozenBundle } from "../src/corpus/freeze/index.ts";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--frozen") {
  throw new Error("usage: corpus:accept -- --frozen <bundle>");
}
const bundlePath = resolve(args[1]!);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const currentIdentity = () => ({
  sourceRevision: git("rev-parse", "HEAD"),
  sourceTree: git("rev-parse", "HEAD^{tree}"),
  clean: git("status", "--porcelain", "--untracked-files=all") === "",
});
const bundle = await verifyFrozenBundle(bundlePath, currentIdentity());
if (bundle.mode !== "deterministic_fixture") {
  throw new Error("live corpus provider unavailable");
}
const root = resolve(dirname(bundlePath), bundle.rootRelativeFromBundle);
const paths = new Map(bundle.inputs.map((input) => [basename(input.path), resolve(root, input.path)]));
const truthDefinition = await definition("browser-truth.json");
const truthOutcomes = outcomes(truthDefinition);
let diagnosticOutcomes: ReadonlyMap<string, AcceptedOutcome> | undefined;
const ports: AcceptancePorts = {
  currentIdentity,
  async runFixture(fixtureId) {
    const path = paths.get(`${fixtureId}.json`);
    if (path === undefined) return { ok: false, code: "fixture_missing", retryable: false };
    if (fixtureId !== "fixture-matrix") return { ok: true };
    const value = JSON.parse(await readFile(path, "utf8")) as { readonly schemaVersion?: number; readonly expected?: string };
    return value.schemaVersion === 1 && value.expected !== "failed"
      ? { ok: true }
      : { ok: false, code: "fixture_failed", retryable: false };
  },
  async captureAndSealTruth(slotIds) {
    const selected = new Map(slotIds.map((slotId) => [slotId, truthOutcomes.get(slotId)!]));
    return { outcomes: selected };
  },
  async runSlot(slotId) {
    diagnosticOutcomes ??= outcomes(await definition("diagnostics.json"));
    const outcome = diagnosticOutcomes.get(slotId);
    return outcome === undefined
      ? { ok: false, code: "diagnostic_missing", retryable: false }
      : { ok: true, outcome };
  },
};
const runRoot = dirname(bundlePath);
const report = await runFrozenAcceptance(bundlePath, resolve(runRoot, "ledger.json"), ports);
await mkdir(runRoot, { recursive: true });
await writeFile(resolve(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status === "rejected") process.exitCode = 1;

interface Definition {
  readonly schemaVersion: 1;
  readonly defaultOutcome: AcceptedOutcome;
  readonly overrides: Readonly<Record<string, AcceptedOutcome>>;
}

async function definition(name: string): Promise<Definition> {
  const path = paths.get(name);
  if (path === undefined) throw new Error(`${name} unavailable`);
  const value = JSON.parse(await readFile(path, "utf8")) as Definition;
  if (value.schemaVersion !== 1) throw new Error(`${name} invalid`);
  return value;
}

function outcomes(definition: Definition): ReadonlyMap<string, AcceptedOutcome> {
  return new Map(Array.from({ length: 40 }, (_, index) => {
    const slotId = `slot-${String(index + 1).padStart(2, "0")}`;
    return [slotId, definition.overrides[slotId] ?? definition.defaultOutcome];
  }));
}

function git(...gitArgs: string[]): string {
  const result = spawnSync("git", gitArgs, {
    cwd: repository,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed`);
  return result.stdout.trim();
}
