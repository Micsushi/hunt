import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { canonicalJson, dataRecord } from "../shared.ts";
import {
  acceptedImpactSha,
  verifyFrozenBundle,
  type CurrentFreezeIdentity,
  type FrozenCorpusBundle,
} from "../freeze/index.ts";

type PortFailure = {
  readonly ok: false;
  readonly code: string;
  readonly retryable: boolean;
};

export interface AcceptancePorts {
  currentIdentity(): CurrentFreezeIdentity | Promise<CurrentFreezeIdentity>;
  runFixture(
    fixtureId: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | PortFailure>;
}

export interface FixtureAcceptance {
  readonly fixtureId: string;
  readonly status: "passed" | "failed";
  readonly attempts: number;
  readonly code?: string;
}

export interface ReconciledSlot {
  readonly slotId: string;
  readonly status: "reconciled";
  readonly availability: "available" | "unavailable" | "replaced";
  readonly reason?: string;
  readonly variantIds: readonly string[];
  readonly fixtureIds: readonly string[];
}

export interface AcceptanceReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly bundleIdentity: string;
  readonly impactSha: typeof acceptedImpactSha;
  readonly mode: "deterministic_fixture";
  readonly truthKind: "offline_fixture_artifacts";
  readonly offlineTruthSeal: string;
  readonly liveCorpusCertified: false;
  readonly liveReviewCertified: false;
  readonly status: "accepted_fixture" | "rejected";
  readonly slotCount: 40;
  readonly reconciledCount: number;
  readonly fixtures: readonly FixtureAcceptance[];
  readonly entries: readonly ReconciledSlot[];
  readonly seal: string;
}

interface Ledger {
  readonly schemaVersion: 1;
  readonly bundleIdentity: string;
  readonly fixtures: readonly FixtureAcceptance[];
  readonly entries: readonly ReconciledSlot[];
  readonly seal: string;
}

export async function runFrozenAcceptance(
  bundlePath: string,
  ledgerPath: string,
  ports: AcceptancePorts,
  signal: AbortSignal = new AbortController().signal,
): Promise<AcceptanceReport> {
  const verify = async () =>
    verifyFrozenBundle(bundlePath, await ports.currentIdentity());
  const bundle = await verify();
  await readLedger(ledgerPath, bundle.identity);
  const root = resolve(
    dirname(resolve(bundlePath)),
    bundle.rootRelativeFromBundle,
  );
  const manifest = await inputJson(bundle, root, "corpus_manifest");
  const fixtureManifest = await inputJson(bundle, root, "fixture_manifest");
  const variants = await inputJson(bundle, root, "variant_map");
  const fixtureIds = fixtureIdsFrom(fixtureManifest);
  assertFrozenFixtures(bundle, fixtureIds);

  const fixtures: FixtureAcceptance[] = [];
  for (const fixtureId of fixtureIds) {
    aborted(signal);
    let result: Awaited<ReturnType<AcceptancePorts["runFixture"]>>;
    let attempts = 0;
    do {
      attempts += 1;
      result = await ports.runFixture(fixtureId, signal);
    } while (
      !result.ok &&
      result.retryable &&
      attempts < bundle.maxAttemptsPerFixture
    );
    fixtures.push(Object.freeze(
      result.ok
        ? { fixtureId, status: "passed", attempts }
        : { fixtureId, status: "failed", attempts, code: safeCode(result.code) },
    ));
    await verify();
    if (!result.ok) {
      const rejected = report(bundle, fixtures, []);
      await writeLedger(ledgerPath, bundle.identity, fixtures, []);
      return rejected;
    }
  }

  const entries = reconcile(manifest, fixtureManifest, variants);
  await verify();
  await writeLedger(ledgerPath, bundle.identity, fixtures, entries);
  await verify();
  return report(bundle, fixtures, entries);
}

export function verifyAcceptanceReport(value: unknown): readonly string[] {
  const issues: string[] = [];
  const record = dataRecord(value);
  if (record === null) return ["acceptance_report_invalid"];
  const expectedKeys = [
    "schemaVersion",
    "runId",
    "bundleIdentity",
    "impactSha",
    "mode",
    "truthKind",
    "offlineTruthSeal",
    "liveCorpusCertified",
    "liveReviewCertified",
    "status",
    "slotCount",
    "reconciledCount",
    "fixtures",
    "entries",
    "seal",
  ].sort();
  if (!sameKeys(record, expectedKeys)) {
    issues.push("acceptance_report_shape_invalid");
  }
  const { seal, ...core } = record;
  if (seal !== hash(canonicalJson(core))) {
    issues.push("acceptance_report_seal_invalid");
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.runId !== "string" ||
    !/^corpus-[0-9a-f]{20}$/u.test(record.runId) ||
    typeof record.bundleIdentity !== "string" ||
    !/^sha256\.[0-9a-f]{64}$/u.test(record.bundleIdentity) ||
    record.impactSha !== acceptedImpactSha ||
    record.mode !== "deterministic_fixture" ||
    record.truthKind !== "offline_fixture_artifacts" ||
    typeof record.offlineTruthSeal !== "string" ||
    !/^sha256\.[0-9a-f]{64}$/u.test(record.offlineTruthSeal) ||
    record.liveCorpusCertified !== false ||
    record.liveReviewCertified !== false ||
    record.slotCount !== 40 ||
    !Array.isArray(record.fixtures) ||
    !Array.isArray(record.entries)
  ) {
    issues.push("acceptance_report_fields_invalid");
    return unique(issues);
  }
  const fixtures = record.fixtures
    .map(parseFixture)
    .filter((fixture): fixture is FixtureAcceptance => fixture !== undefined);
  if (fixtures.length !== record.fixtures.length) {
    issues.push("acceptance_report_fixture_invalid");
  }
  const entries = record.entries
    .map(parseEntry)
    .filter((entry): entry is ReconciledSlot => entry !== undefined);
  if (entries.length !== record.entries.length) {
    issues.push("acceptance_report_entry_invalid");
  }
  const reconciled = entries.filter((entry) => entry.status === "reconciled")
    .length;
  if (record.reconciledCount !== reconciled) {
    issues.push("acceptance_report_count_invalid");
  }
  const accepted =
    fixtures.length === 4 &&
    fixtures.every((fixture) => fixture.status === "passed") &&
    entries.length === 40 &&
    reconciled === 40;
  if (record.status !== (accepted ? "accepted_fixture" : "rejected")) {
    issues.push("acceptance_report_status_invalid");
  }
  if (
    entries.length !== 0 &&
    (
      entries.length !== 40 ||
      entries.some(
        (entry, index) =>
          entry.slotId !== `WD40-${String(index + 1).padStart(3, "0")}`,
      )
    )
  ) {
    issues.push("acceptance_report_slot_set_invalid");
  }
  if (record.offlineTruthSeal !== hash(canonicalJson(entries))) {
    issues.push("acceptance_report_truth_seal_invalid");
  }
  return unique(issues);
}

function reconcile(
  manifestInput: unknown,
  fixtureManifestInput: unknown,
  variantsInput: unknown,
): readonly ReconciledSlot[] {
  const manifest = requiredRecord(manifestInput, "corpus manifest");
  const fixtureManifest = requiredRecord(
    fixtureManifestInput,
    "fixture manifest",
  );
  const variants = requiredRecord(variantsInput, "variant map");
  const fixtureById = new Map(
    requiredArray(fixtureManifest.fixtures, "fixtures").map((raw) => {
      const fixture = requiredRecord(raw, "fixture");
      return [String(fixture.id), fixture] as const;
    }),
  );
  const variantRows = requiredArray(variants.variants, "variants")
    .map((raw) => requiredRecord(raw, "variant"));
  const slots = requiredArray(manifest.slots, "slots");
  if (slots.length !== 40) throw new Error("frozen corpus manifest invalid");

  return Object.freeze(slots.map((raw, index) => {
    const slot = requiredRecord(raw, "slot");
    const slotId = String(slot.slotId);
    if (slotId !== `WD40-${String(index + 1).padStart(3, "0")}`) {
      throw new Error("frozen corpus slot order invalid");
    }
    const availability = requiredRecord(slot.availability, "availability");
    const kind = String(availability.kind);
    if (!["available", "unavailable", "replaced"].includes(kind)) {
      throw new Error("frozen corpus availability invalid");
    }
    const provingVariants = variantRows
      .filter((variant) =>
        stringArray(variant.affectedSlots).includes(slotId)
      )
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const variantIds = provingVariants.map((variant) => String(variant.id));
    const fixtureIds = [...new Set(provingVariants.flatMap(
      (variant) => stringArray(variant.fixtureIds),
    ))].sort();
    for (const fixtureId of fixtureIds) {
      if (!fixtureById.has(fixtureId)) {
        throw new Error("variant references unknown fixture");
      }
    }
    return Object.freeze({
      slotId,
      status: "reconciled" as const,
      availability: kind as ReconciledSlot["availability"],
      ...(typeof availability.reason === "string"
        ? { reason: safeCode(availability.reason) }
        : {}),
      variantIds: Object.freeze(variantIds),
      fixtureIds: Object.freeze(fixtureIds),
    });
  }));
}

function report(
  bundle: FrozenCorpusBundle,
  fixtures: readonly FixtureAcceptance[],
  entries: readonly ReconciledSlot[],
): AcceptanceReport {
  const accepted =
    fixtures.length === 4 &&
    fixtures.every((fixture) => fixture.status === "passed") &&
    entries.length === 40;
  const core = {
    schemaVersion: 1 as const,
    runId: bundle.runId,
    bundleIdentity: bundle.identity,
    impactSha: acceptedImpactSha,
    mode: "deterministic_fixture" as const,
    truthKind: "offline_fixture_artifacts" as const,
    offlineTruthSeal: hash(canonicalJson(entries)),
    liveCorpusCertified: false as const,
    liveReviewCertified: false as const,
    status: accepted ? "accepted_fixture" as const : "rejected" as const,
    slotCount: 40 as const,
    reconciledCount: entries.length,
    fixtures: Object.freeze([...fixtures]),
    entries: Object.freeze([...entries]),
  };
  const value = Object.freeze({
    ...core,
    seal: hash(canonicalJson(core)),
  });
  const issues = verifyAcceptanceReport(value);
  if (issues.length > 0) {
    throw new Error(`acceptance report invalid: ${issues.join(",")}`);
  }
  return value;
}

async function inputJson(
  bundle: FrozenCorpusBundle,
  root: string,
  kind: FrozenCorpusBundle["inputs"][number]["kind"],
): Promise<unknown> {
  const input = bundle.inputs.find((candidate) => candidate.kind === kind);
  if (input === undefined) throw new Error(`frozen ${kind} unavailable`);
  return JSON.parse(await readFile(resolve(root, input.path), "utf8")) as unknown;
}

function fixtureIdsFrom(input: unknown): string[] {
  const manifest = requiredRecord(input, "fixture manifest");
  const ids = requiredArray(manifest.fixtures, "fixtures")
    .map((raw) => String(requiredRecord(raw, "fixture").id));
  if (
    ids.length !== 4 ||
    new Set(ids).size !== 4 ||
    ids.some((id) => !/^wd-[a-z0-9-]+-v1$/u.test(id))
  ) {
    throw new Error("accepted fixture manifest invalid");
  }
  return ids;
}

function assertFrozenFixtures(
  bundle: FrozenCorpusBundle,
  fixtureIds: readonly string[],
): void {
  const frozenIds = bundle.inputs
    .filter((input) => input.kind === "fixture")
    .map((input) => basename(input.path, ".json"))
    .sort();
  if (canonicalJson(frozenIds) !== canonicalJson([...fixtureIds].sort())) {
    throw new Error("frozen fixture set mismatch");
  }
}

async function readLedger(path: string, identity: string): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const ledger = requiredRecord(value, "acceptance ledger");
  const { seal, ...core } = ledger;
  if (
    !sameKeys(ledger, [
      "schemaVersion",
      "bundleIdentity",
      "fixtures",
      "entries",
      "seal",
    ]) ||
    ledger.schemaVersion !== 1 ||
    ledger.bundleIdentity !== identity ||
    seal !== hash(canonicalJson(core)) ||
    !Array.isArray(ledger.fixtures) ||
    !Array.isArray(ledger.entries) ||
    ledger.fixtures.some((fixture) => parseFixture(fixture) === undefined) ||
    ledger.entries.some((entry) => parseEntry(entry) === undefined)
  ) {
    throw new Error("acceptance ledger invalid");
  }
}

async function writeLedger(
  path: string,
  identity: string,
  fixtures: readonly FixtureAcceptance[],
  entries: readonly ReconciledSlot[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const core = {
    schemaVersion: 1 as const,
    bundleIdentity: identity,
    fixtures,
    entries,
  };
  const value: Ledger = {
    ...core,
    seal: hash(canonicalJson(core)),
  };
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${canonicalJson(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function parseFixture(value: unknown): FixtureAcceptance | undefined {
  const fixture = dataRecord(value);
  if (fixture === null) return undefined;
  const expected = fixture.status === "failed"
    ? ["fixtureId", "status", "attempts", "code"]
    : ["fixtureId", "status", "attempts"];
  if (
    !sameKeys(fixture, expected) ||
    typeof fixture.fixtureId !== "string" ||
    !/^wd-[a-z0-9-]+-v1$/u.test(fixture.fixtureId) ||
    !["passed", "failed"].includes(String(fixture.status)) ||
    !Number.isSafeInteger(fixture.attempts) ||
    Number(fixture.attempts) < 1 ||
    Number(fixture.attempts) > 3 ||
    (
      fixture.status === "failed" &&
      (
        typeof fixture.code !== "string" ||
        !/^[a-z0-9_]{1,64}$/u.test(fixture.code)
      )
    )
  ) {
    return undefined;
  }
  return fixture as unknown as FixtureAcceptance;
}

function parseEntry(value: unknown): ReconciledSlot | undefined {
  const entry = dataRecord(value);
  if (entry === null) return undefined;
  const expected = typeof entry.reason === "string"
    ? [
      "slotId",
      "status",
      "availability",
      "reason",
      "variantIds",
      "fixtureIds",
    ]
    : ["slotId", "status", "availability", "variantIds", "fixtureIds"];
  if (
    !sameKeys(entry, expected) ||
    typeof entry.slotId !== "string" ||
    !/^WD40-\d{3}$/u.test(entry.slotId) ||
    entry.status !== "reconciled" ||
    !["available", "unavailable", "replaced"].includes(
      String(entry.availability),
    ) ||
    (
      entry.reason !== undefined &&
      (
        typeof entry.reason !== "string" ||
        !/^[a-z0-9_]{1,64}$/u.test(entry.reason)
      )
    ) ||
    !stringArrayOrUndefined(entry.variantIds) ||
    !stringArrayOrUndefined(entry.fixtureIds)
  ) {
    return undefined;
  }
  return entry as unknown as ReconciledSlot;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  const record = dataRecord(value);
  if (record === null) throw new Error(`${name} invalid`);
  return record;
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} invalid`);
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringArrayOrUndefined(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length;
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index]);
}

function safeCode(value: string): string {
  if (!/^[a-z0-9_]{1,64}$/u.test(value)) {
    throw new Error("unsafe acceptance code");
  }
  return value;
}

function hash(value: string): string {
  return `sha256.${createHash("sha256").update(value).digest("hex")}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("acceptance cancelled");
}
