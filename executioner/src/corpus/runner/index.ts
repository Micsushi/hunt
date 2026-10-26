import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson, dataRecord, sha256 } from "../shared.ts";
import { validateCorpusFixtures } from "../capture/index.ts";
import { validateImpactMap } from "../impact-map/index.ts";
import { validateCorpusManifest } from "../manifest/index.ts";

export interface BaselineInputs {
  readonly manifest: unknown;
  readonly fixtures: unknown;
  readonly variants: unknown;
  readonly sourceRevision: string;
  readonly fixtureRoot: string;
}

export interface BaselineOutcome {
  sequence: number;
  slotId: string;
  kind: "application_ready" | "posting_unavailable" | "access_blocked" | "profile_answer_missing" | "product_failure";
  reason?: "maintenance" | "removed" | "closed" | "not_found" | "access_control";
  owner: "corpus-observation" | "external-site" | "applicant-profile" | "executioner";
  affectedVariants: string[];
}

export interface BaselineReport {
  schemaVersion: 1;
  reportId: string;
  corpusId: "workday-40";
  sourceRevision: string;
  observedAt: string;
  manifestHash: string;
  fixtureManifestHash: string;
  variantMapHash: string;
  execution: { mode: "offline-fixture-replay"; concurrency: 1; resumable: true };
  preflight: { manifestValidated: true; fixturesReplayed: number };
  outcomes: BaselineOutcome[];
  cleanup: { browserOpened: false; retainedRawCapture: false };
  safety: { liveAccountMutation: false; finalSubmitActivated: false };
  reportHash: string;
}

export function createCorpusBaseline(
  inputs: BaselineInputs,
  completedOutcomes: readonly BaselineOutcome[] = [],
): BaselineReport {
  if (!/^[a-f0-9]{40}$/u.test(inputs.sourceRevision)) throw new TypeError("baseline source revision is invalid");
  const manifestErrors = validateCorpusManifest(inputs.manifest);
  if (manifestErrors.length > 0) throw new TypeError(`baseline manifest validation failed: ${manifestErrors.join("; ")}`);
  const fixtureErrors = validateCorpusFixtures(inputs.fixtureRoot, inputs.fixtures, inputs.manifest);
  if (fixtureErrors.length > 0) throw new TypeError(`baseline fixture validation failed: ${fixtureErrors.join("; ")}`);
  const mapErrors = validateImpactMap(inputs.variants, inputs.fixtures, inputs.manifest, resolve(inputs.fixtureRoot, "../../.."));
  if (mapErrors.length > 0) throw new TypeError(`baseline impact-map validation failed: ${mapErrors.join("; ")}`);
  const manifest = requireRecord(inputs.manifest, "manifest");
  const fixtureManifest = requireRecord(inputs.fixtures, "fixture manifest");
  const variantMap = requireRecord(inputs.variants, "variant map");
  const slots = Array.isArray(manifest.slots) ? manifest.slots.map((slot) => requireRecord(slot, "slot")) : [];
  if (slots.length !== 40) throw new RangeError("baseline requires exactly 40 slots");
  const variants = Array.isArray(variantMap.variants) ? variantMap.variants.map((variant) => requireRecord(variant, "variant")) : [];
  const expectedOutcomes = slots.map((slot, index) => baselineOutcome(slot, index, variants));
  for (const [index, outcome] of completedOutcomes.entries()) {
    if (canonicalJson(outcome) !== canonicalJson(expectedOutcomes[index])) {
      throw new TypeError(`resume outcome ${index + 1} does not match the frozen baseline`);
    }
  }
  if (completedOutcomes.length > expectedOutcomes.length) throw new RangeError("resume has more outcomes than corpus slots");
  const outcomes = [...completedOutcomes.map((outcome) => structuredClone(outcome)), ...expectedOutcomes.slice(completedOutcomes.length)];
  const observedAt = String(dataRecord(slots[0]?.availability)?.observedAt ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(observedAt)) throw new TypeError("baseline observation date is invalid");
  const base = {
    schemaVersion: 1 as const,
    corpusId: "workday-40" as const,
    sourceRevision: inputs.sourceRevision,
    observedAt,
    manifestHash: String(dataRecord(manifest.freeze)?.digest ?? ""),
    fixtureManifestHash: String(dataRecord(fixtureManifest.freeze)?.digest ?? ""),
    variantMapHash: String(dataRecord(variantMap.freeze)?.digest ?? ""),
    execution: { mode: "offline-fixture-replay" as const, concurrency: 1 as const, resumable: true as const },
    preflight: {
      manifestValidated: true as const,
      fixturesReplayed: Array.isArray(fixtureManifest.fixtures) ? fixtureManifest.fixtures.length : 0,
    },
    outcomes,
    cleanup: { browserOpened: false as const, retainedRawCapture: false as const },
    safety: { liveAccountMutation: false as const, finalSubmitActivated: false as const },
  };
  const identity = sha256(canonicalJson(base));
  const withId = { ...base, reportId: `baseline-${identity.slice(7, 23)}` };
  return { ...withId, reportHash: sha256(canonicalJson(withId)) };
}

export function validateBaselineReport(input: unknown, inputs: BaselineInputs): string[] {
  const report = dataRecord(input);
  if (report === null) return ["baseline report must be an object"];
  let expected: BaselineReport;
  try {
    expected = createCorpusBaseline(inputs);
  } catch (error) {
    return [`baseline inputs are invalid: ${error instanceof Error ? error.message : "unknown error"}`];
  }
  return canonicalJson(report) === canonicalJson(expected)
    ? []
    : ["baseline report does not match the deterministic corpus outcome"];
}

export function writeImmutableBaseline(report: BaselineReport, outputRoot: string): string {
  if (!/^baseline-[a-f0-9]{16}$/u.test(report.reportId)) throw new TypeError("baseline reportId is unsafe");
  const root = resolve(outputRoot);
  mkdirSync(root, { recursive: true });
  const path = resolve(root, `${report.reportId}.json`);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  try {
    writeFileSync(path, payload, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== payload) throw new Error("immutable baseline report collision");
  }
  return path;
}

function baselineOutcome(
  slot: Record<string, unknown>,
  index: number,
  variants: Record<string, unknown>[],
): BaselineOutcome {
  const slotId = String(slot.slotId ?? "");
  const affectedVariants = variants
    .filter((variant) => Array.isArray(variant.affectedSlots) && variant.affectedSlots.includes(slotId))
    .map((variant) => String(variant.id))
    .sort();
  const availability = requireRecord(slot.availability, `${slotId}.availability`);
  if (availability.kind === "available" || availability.kind === "replaced") {
    return { sequence: index + 1, slotId, kind: "application_ready", owner: "corpus-observation", affectedVariants };
  }
  const reason = String(availability.reason) as BaselineOutcome["reason"];
  if (!new Set(["maintenance", "removed", "closed", "not_found", "access_control"]).has(String(reason))) {
    throw new TypeError(`${slotId} has unsupported unavailable reason`);
  }
  if (reason === "access_control") {
    return { sequence: index + 1, slotId, kind: "access_blocked", reason, owner: "external-site", affectedVariants };
  }
  return { sequence: index + 1, slotId, kind: "posting_unavailable", reason, owner: "external-site", affectedVariants };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = dataRecord(value);
  if (record === null) throw new TypeError(`${label} must be an object`);
  return record;
}
