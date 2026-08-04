import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  verifyFrozenBundle,
  type CurrentFreezeIdentity,
  type FrozenCorpusBundle,
} from "../freeze/index.ts";

export type PolicyStopReason =
  | "removed"
  | "closed"
  | "not_found"
  | "maintenance"
  | "profile_answer_missing"
  | "mailbox_unavailable"
  | "account_unavailable"
  | "manual_intervention"
  | "posting_unavailable";

export type AcceptedOutcome =
  | { readonly kind: "review_reached" }
  | { readonly kind: "policy_stop"; readonly reason: PolicyStopReason };

export interface SealedTruthSummary {
  readonly outcomes: ReadonlyMap<string, AcceptedOutcome>;
}

type PortFailure = { readonly ok: false; readonly code: string; readonly retryable: boolean };

export interface AcceptancePorts {
  currentIdentity(): CurrentFreezeIdentity | Promise<CurrentFreezeIdentity>;
  runFixture(
    fixtureId: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | PortFailure>;
  captureAndSealTruth(
    slotIds: readonly string[],
    signal: AbortSignal,
  ): Promise<SealedTruthSummary>;
  runSlot(
    slotId: string,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true; readonly outcome: AcceptedOutcome } | PortFailure>;
}

export interface AcceptanceEntry {
  readonly slotId: string;
  readonly status: "accepted" | "rejected";
  readonly code: "accepted" | "browser_truth_mismatch" | "runner_failed";
  readonly attempts: number;
  readonly outcome?: AcceptedOutcome;
}

export interface AcceptanceReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly bundleIdentity: string;
  readonly truthSeal: string;
  readonly mode: "deterministic_fixture" | "live_corpus";
  readonly liveCorpusCertified: boolean;
  readonly status: "accepted" | "accepted_fixture" | "rejected";
  readonly slotCount: 40;
  readonly acceptedCount: number;
  readonly entries: readonly AcceptanceEntry[];
  readonly seal: string;
}

interface Ledger {
  readonly schemaVersion: 1;
  readonly bundleIdentity: string;
  readonly entries: readonly AcceptanceEntry[];
}

export async function runFrozenAcceptance(
  bundlePath: string,
  ledgerPath: string,
  ports: AcceptancePorts,
  signal: AbortSignal = new AbortController().signal,
): Promise<AcceptanceReport> {
  const verify = async () => verifyFrozenBundle(bundlePath, await ports.currentIdentity());
  const bundle = await verify();
  const root = resolve(dirname(resolve(bundlePath)), bundle.rootRelativeFromBundle);
  const manifestInput = bundle.inputs.find((input) => input.kind === "corpus_manifest");
  if (manifestInput === undefined) throw new Error("frozen corpus manifest unavailable");
  const manifest = JSON.parse(await readFile(resolve(root, manifestInput.path), "utf8")) as {
    readonly slots: readonly { readonly slotId: string }[];
  };
  const slotIds = manifest.slots.map((slot) => slot.slotId);
  if (slotIds.length !== 40) throw new Error("frozen corpus manifest invalid");

  for (const fixture of bundle.inputs.filter((input) => input.kind === "fixture")) {
    aborted(signal);
    const result = await ports.runFixture(basename(fixture.path, ".json"), signal);
    if (!result.ok) {
      return report(bundle, `sha256.${hash("fixture-failure")}`, []);
    }
    await verify();
  }

  const capturedTruth = await ports.captureAndSealTruth(Object.freeze(slotIds), signal);
  if (capturedTruth.outcomes.size !== 40) {
    throw new Error("browser truth summary invalid");
  }
  const truth = new Map<string, AcceptedOutcome>();
  for (const slotId of slotIds) {
    const outcome = capturedTruth.outcomes.get(slotId);
    if (outcome === undefined) throw new Error("browser truth summary incomplete");
    truth.set(slotId, parseOutcome(outcome));
  }
  const truthSeal = `sha256.${hash(stable([...truth]))}`;
  await verify();
  const previous = await readLedger(ledgerPath, bundle.identity, slotIds, bundle.maxAttemptsPerSlot);
  const entries = new Map(previous.entries.map((entry) => [entry.slotId, entry]));

  for (const slotId of slotIds) {
    aborted(signal);
    const expected = truth.get(slotId)!;
    let result: Awaited<ReturnType<AcceptancePorts["runSlot"]>> | undefined;
    let attempts = 0;
    do {
      attempts += 1;
      result = await ports.runSlot(slotId, signal);
    } while (!result.ok && result.retryable && attempts < bundle.maxAttemptsPerSlot);

    const observed = result.ok ? parseOutcome(result.outcome) : undefined;
    const entry: AcceptanceEntry = !result.ok
      ? { slotId, status: "rejected", code: "runner_failed", attempts }
      : sameOutcome(observed!, expected)
        ? { slotId, status: "accepted", code: "accepted", attempts, outcome: observed }
        : { slotId, status: "rejected", code: "browser_truth_mismatch", attempts, outcome: observed };
    entries.set(slotId, Object.freeze(entry));
    await writeLedger(ledgerPath, bundle.identity, slotIds.flatMap((id) => entries.get(id) ?? []));
    await verify();
  }

  const ordered = Object.freeze(slotIds.flatMap((id) => entries.get(id) ?? []));
  await verify();
  return report(bundle, truthSeal, ordered);
}

function report(
  bundle: FrozenCorpusBundle,
  truthSeal: string,
  entries: readonly AcceptanceEntry[],
): AcceptanceReport {
  const acceptedCount = entries.filter((entry) => entry.status === "accepted").length;
  const core = {
    schemaVersion: 1 as const,
    runId: bundle.runId,
    bundleIdentity: bundle.identity,
    truthSeal,
    mode: bundle.mode,
    liveCorpusCertified: bundle.mode === "live_corpus" && acceptedCount === 40,
    status: acceptedCount !== 40
      ? "rejected" as const
      : bundle.mode === "live_corpus"
        ? "accepted" as const
        : "accepted_fixture" as const,
    slotCount: 40 as const,
    acceptedCount,
    entries,
  };
  const value = Object.freeze({ ...core, seal: hash(stable(core)) });
  if (verifyAcceptanceReport(value).length > 0) throw new Error("acceptance report invalid");
  return value;
}

export function verifyAcceptanceReport(value: unknown): readonly string[] {
  const issues: string[] = [];
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return ["acceptance_report_invalid"];
  }
  const report = value as Record<string, unknown>;
  const expectedKeys = [
    "acceptedCount",
    "bundleIdentity",
    "entries",
    "liveCorpusCertified",
    "mode",
    "runId",
    "schemaVersion",
    "seal",
    "slotCount",
    "status",
    "truthSeal",
  ].sort();
  const actualKeys = Object.keys(report).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    issues.push("acceptance_report_shape_invalid");
  }
  const { seal, ...core } = report;
  if (typeof seal !== "string" || seal !== hash(stable(core))) issues.push("acceptance_report_seal_invalid");
  if (
    report.schemaVersion !== 1 ||
    report.slotCount !== 40 ||
    typeof report.bundleIdentity !== "string" ||
    !/^[0-9a-f]{64}$/u.test(report.bundleIdentity) ||
    typeof report.runId !== "string" ||
    !/^corpus-[0-9a-f]{20}$/u.test(report.runId) ||
    typeof report.truthSeal !== "string" ||
    !/^sha256\.[0-9a-f]{64}$/u.test(report.truthSeal) ||
    (report.mode !== "deterministic_fixture" && report.mode !== "live_corpus") ||
    !Array.isArray(report.entries)
  ) {
    issues.push("acceptance_report_fields_invalid");
    return [...new Set(issues)].sort();
  }
  const entries: AcceptanceEntry[] = [];
  try {
    for (const entry of report.entries) entries.push(parseEntry(entry, 3));
  } catch {
    issues.push("acceptance_report_entry_invalid");
  }
  const accepted = entries.filter((entry) => entry.status === "accepted").length;
  if (report.acceptedCount !== accepted) issues.push("acceptance_report_count_invalid");
  const expectedStatus = accepted !== 40
    ? "rejected"
    : report.mode === "live_corpus"
      ? "accepted"
      : "accepted_fixture";
  if (report.status !== expectedStatus) issues.push("acceptance_report_status_invalid");
  if (report.liveCorpusCertified !== (expectedStatus === "accepted")) {
    issues.push("acceptance_report_provenance_invalid");
  }
  if (entries.length !== 0 && entries.length !== 40) issues.push("acceptance_report_slot_count_invalid");
  if (new Set(entries.map((entry) => entry.slotId)).size !== entries.length) {
    issues.push("acceptance_report_duplicate_slot");
  }
  return [...new Set(issues)].sort();
}

async function readLedger(
  path: string,
  identity: string,
  slotIds: readonly string[],
  maxAttempts: number,
): Promise<Ledger> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Ledger;
    if (value.schemaVersion !== 1 || value.bundleIdentity !== identity || !Array.isArray(value.entries)) {
      throw new Error("acceptance ledger identity mismatch");
    }
    const allowedSlots = new Set(slotIds);
    const seen = new Set<string>();
    const entries = value.entries.map((entry) => {
      if (
        !allowedSlots.has(entry.slotId) ||
        seen.has(entry.slotId)
      ) throw new Error("acceptance ledger invalid");
      seen.add(entry.slotId);
      return parseEntry(entry, maxAttempts);
    });
    return { ...value, entries: Object.freeze(entries) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, bundleIdentity: identity, entries: [] };
    }
    throw error;
  }
}

async function writeLedger(path: string, identity: string, entries: readonly AcceptanceEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${stable({ schemaVersion: 1, bundleIdentity: identity, entries })}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function sameOutcome(left: AcceptedOutcome, right: AcceptedOutcome): boolean {
  return left.kind === right.kind &&
    (left.kind === "review_reached" || (right.kind === "policy_stop" && left.reason === right.reason));
}

function parseEntry(value: unknown, maxAttempts: number): AcceptanceEntry {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("acceptance entry invalid");
  }
  const entry = value as Record<string, unknown>;
  const hasOutcome = entry.outcome !== undefined;
  const expected = (hasOutcome
    ? ["slotId", "status", "code", "attempts", "outcome"]
    : ["slotId", "status", "code", "attempts"]
  ).sort();
  const actual = Object.keys(entry).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    typeof entry.slotId !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{0,63}$/u.test(entry.slotId) ||
    !Number.isSafeInteger(entry.attempts) ||
    Number(entry.attempts) < 1 ||
    Number(entry.attempts) > maxAttempts ||
    (entry.status !== "accepted" && entry.status !== "rejected") ||
    (entry.code !== "accepted" && entry.code !== "browser_truth_mismatch" && entry.code !== "runner_failed")
  ) throw new Error("acceptance entry invalid");
  const outcome = hasOutcome ? parseOutcome(entry.outcome) : undefined;
  if ((entry.status === "accepted" || entry.code === "browser_truth_mismatch") && outcome === undefined) {
    throw new Error("acceptance entry invalid");
  }
  if (entry.status === "accepted" && entry.code !== "accepted") throw new Error("acceptance entry invalid");
  return Object.freeze({
    slotId: entry.slotId,
    status: entry.status,
    code: entry.code,
    attempts: Number(entry.attempts),
    ...(outcome === undefined ? {} : { outcome }),
  });
}

const policyStopReasons = new Set<PolicyStopReason>([
  "removed",
  "closed",
  "not_found",
  "maintenance",
  "profile_answer_missing",
  "mailbox_unavailable",
  "account_unavailable",
  "manual_intervention",
  "posting_unavailable",
]);

function parseOutcome(value: unknown): AcceptedOutcome {
  if (value === null || Array.isArray(value) || typeof value !== "object") invalidOutcome();
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (candidate.kind === "review_reached" && keys.length === 1 && keys[0] === "kind") {
    return Object.freeze({ kind: "review_reached" });
  }
  if (
    candidate.kind === "policy_stop" &&
    keys.length === 2 &&
    keys[0] === "kind" &&
    keys[1] === "reason" &&
    policyStopReasons.has(candidate.reason as PolicyStopReason)
  ) return Object.freeze({ kind: "policy_stop", reason: candidate.reason as PolicyStopReason });
  invalidOutcome();
}

function invalidOutcome(): never {
  throw new Error("acceptance outcome invalid");
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("acceptance cancelled");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
