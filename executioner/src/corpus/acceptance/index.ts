import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { verifyFrozenBundle } from "../freeze/index.ts";

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
  readonly seal: string;
  readonly outcomes: ReadonlyMap<string, AcceptedOutcome>;
}

type PortFailure = { readonly ok: false; readonly code: string; readonly retryable: boolean };

export interface AcceptancePorts {
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
  readonly status: "accepted" | "rejected";
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
  const bundle = await verifyFrozenBundle(bundlePath);
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
      return report(bundle.runId, bundle.identity, "fixture-failure", []);
    }
    await verifyFrozenBundle(bundlePath);
  }

  const truth = await ports.captureAndSealTruth(Object.freeze(slotIds), signal);
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(truth.seal) || truth.outcomes.size !== 40) {
    throw new Error("browser truth summary invalid");
  }
  const previous = await readLedger(ledgerPath, bundle.identity);
  const entries = new Map(previous.entries.map((entry) => [entry.slotId, entry]));

  for (const slotId of slotIds) {
    aborted(signal);
    if (entries.get(slotId)?.status === "accepted") continue;
    const expected = truth.outcomes.get(slotId);
    if (expected === undefined) throw new Error("browser truth summary incomplete");
    let result: Awaited<ReturnType<AcceptancePorts["runSlot"]>> | undefined;
    let attempts = 0;
    do {
      attempts += 1;
      result = await ports.runSlot(slotId, signal);
    } while (!result.ok && result.retryable && attempts < bundle.maxAttemptsPerSlot);

    const entry: AcceptanceEntry = !result.ok
      ? { slotId, status: "rejected", code: "runner_failed", attempts }
      : sameOutcome(result.outcome, expected)
        ? { slotId, status: "accepted", code: "accepted", attempts, outcome: result.outcome }
        : { slotId, status: "rejected", code: "browser_truth_mismatch", attempts, outcome: result.outcome };
    entries.set(slotId, Object.freeze(entry));
    await writeLedger(ledgerPath, bundle.identity, slotIds.flatMap((id) => entries.get(id) ?? []));
    await verifyFrozenBundle(bundlePath);
  }

  const ordered = Object.freeze(slotIds.flatMap((id) => entries.get(id) ?? []));
  await verifyFrozenBundle(bundlePath);
  return report(bundle.runId, bundle.identity, truth.seal, ordered);
}

function report(
  runId: string,
  bundleIdentity: string,
  truthSeal: string,
  entries: readonly AcceptanceEntry[],
): AcceptanceReport {
  const acceptedCount = entries.filter((entry) => entry.status === "accepted").length;
  const core = {
    schemaVersion: 1 as const,
    runId,
    bundleIdentity,
    truthSeal,
    status: acceptedCount === 40 ? "accepted" as const : "rejected" as const,
    slotCount: 40 as const,
    acceptedCount,
    entries,
  };
  return Object.freeze({ ...core, seal: hash(stable(core)) });
}

async function readLedger(path: string, identity: string): Promise<Ledger> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Ledger;
    if (value.schemaVersion !== 1 || value.bundleIdentity !== identity || !Array.isArray(value.entries)) {
      throw new Error("acceptance ledger identity mismatch");
    }
    return value;
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
