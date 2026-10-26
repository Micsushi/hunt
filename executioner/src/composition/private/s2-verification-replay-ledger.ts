import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import type { DurableVerificationReplayGuard } from "../../mailbox/providers/gmail/private/atomic-artifact-consumer.ts";

const recipientPattern = /^recipient_[a-f0-9]{32}$/u;
const hostPattern = /^[a-z0-9.-]{4,253}$/u;
const tenantPattern = /^[a-z0-9-]{2,64}$/u;
const recordPattern = /^[a-f0-9]{64}\.json$/u;
const retentionMs = 30 * 86_400_000;

export interface Stage2VerificationReplayLedgerOptions {
  readonly root: string;
  readonly recipientBindingId: string;
  readonly host: string;
  readonly tenant: string;
  readonly now?: () => string;
}

export class Stage2VerificationReplayLedger implements DurableVerificationReplayGuard {
  readonly #options: Stage2VerificationReplayLedgerOptions;

  constructor(options: Stage2VerificationReplayLedgerOptions) {
    this.#options = options;
  }

  async claim(
    coordinate: Readonly<Uint8Array>,
    signal: AbortSignal,
  ): Promise<"claimed" | "replayed"> {
    if (signal.aborted) throw signal.reason;
    const root = admittedRoot(this.#options.root);
    const now = this.#options.now?.() ?? new Date().toISOString();
    if (
      coordinate.byteLength !== 32 ||
      !recipientPattern.test(this.#options.recipientBindingId) ||
      !hostPattern.test(this.#options.host) ||
      !tenantPattern.test(this.#options.tenant) ||
      !canonicalTimestamp(now)
    ) throw new Error("verification replay admission denied");
    const digest = createHash("sha256")
      .update("hunt-verification-replay-v1\u0000", "utf8")
      .update(this.#options.recipientBindingId, "utf8")
      .update("\u0000", "utf8")
      .update(this.#options.host, "utf8")
      .update("\u0000", "utf8")
      .update(this.#options.tenant, "utf8")
      .update("\u0000", "utf8")
      .update(coordinate)
      .digest("hex");
    const path = join(root, `${digest}.json`);
    const partial = join(root, `.${randomBytes(16).toString("hex")}.partial`);
    const record = Object.freeze({
      schemaVersion: 1,
      replayRevision: "s2-verification-replay-v1",
      consumedAt: now,
      retainUntil: new Date(Date.parse(now) + retentionMs).toISOString(),
    });
    const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let descriptor: number | undefined;
    try {
      descriptor = openSync(partial, "wx", 0o600);
      writeFileSync(descriptor, payload);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(partial, path);
      return "claimed";
    } catch (error) {
      if (!existsSync(path)) throw error;
      readReplayRecord(path);
      return "replayed";
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      payload.fill(0);
      rmSync(partial, { force: true });
    }
  }
}

export function sweepExpiredVerificationReplayClaims(
  rootValue: string,
  now: string,
): { readonly removed: number; readonly retained: number } {
  if (!canonicalTimestamp(now)) throw new Error("verification replay sweep denied");
  const root = admittedRoot(rootValue);
  const names = readdirSync(root);
  if (names.length > 4_096) throw new Error("verification replay sweep denied");
  let removed = 0;
  let retained = 0;
  for (const name of names) {
    if (!recordPattern.test(name)) throw new Error("verification replay sweep denied");
    const path = join(root, name);
    const record = readReplayRecord(path);
    if (Date.parse(record.retainUntil) <= Date.parse(now)) {
      rmSync(path, { force: false });
      removed += 1;
    } else {
      retained += 1;
    }
  }
  return Object.freeze({ removed, retained });
}

function readReplayRecord(path: string): {
  readonly consumedAt: string;
  readonly retainUntil: string;
} {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || status.size < 1 || status.size > 512) {
    throw new Error("verification replay record denied");
  }
  const stored = readFileSync(path);
  try {
    const parsed = JSON.parse(stored.toString("utf8")) as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(parsed)) !== JSON.stringify([
        "schemaVersion",
        "replayRevision",
        "consumedAt",
        "retainUntil",
      ]) ||
      parsed.schemaVersion !== 1 ||
      parsed.replayRevision !== "s2-verification-replay-v1" ||
      typeof parsed.consumedAt !== "string" ||
      typeof parsed.retainUntil !== "string" ||
      !canonicalTimestamp(parsed.consumedAt) ||
      !canonicalTimestamp(parsed.retainUntil) ||
      Date.parse(parsed.retainUntil) - Date.parse(parsed.consumedAt) !== retentionMs
    ) throw new Error("verification replay record denied");
    return Object.freeze({
      consumedAt: parsed.consumedAt,
      retainUntil: parsed.retainUntil,
    });
  } finally {
    stored.fill(0);
  }
}

function admittedRoot(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new Error("verification replay root denied");
  }
  if (!existsSync(value)) mkdirSync(value, { recursive: true, mode: 0o700 });
  const status = lstatSync(value);
  if (status.isSymbolicLink() || !statSync(value).isDirectory()) {
    throw new Error("verification replay root denied");
  }
  const canonical = realpathSync.native(value);
  if (!samePath(canonical, resolve(value))) {
    throw new Error("verification replay root denied");
  }
  return canonical;
}

function canonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
