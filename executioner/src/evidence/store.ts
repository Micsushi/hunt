import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  consumeEvidenceAdmission,
  copyContractDataGraph,
  parseEvidenceManifest,
  type EvidenceAdmissionRequest,
  type EvidenceManifest,
  type EvidenceReadRequest,
  type EvidenceRecord,
  type EvidenceStore,
  type JourneyId,
} from "../contracts/index.ts";

export const EVIDENCE_MAX_RECORDS = 64;
export const EVIDENCE_MAX_MANIFEST_BYTES = 32_768;

interface EvidenceLimits {
  readonly maxRecords?: number;
  readonly maxManifestBytes?: number;
}

const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;
const denied = {
  ok: false,
  error: { code: "evidence_denied", retryable: false },
} as const;
const unavailable = {
  ok: false,
  error: { code: "evidence_unavailable", retryable: true },
} as const;
const writeQueues = new Map<string, Promise<void>>();

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function manifestPath(root: string, journeyId: JourneyId): string {
  return resolve(
    root,
    `${createHash("sha256").update(journeyId).digest("hex")}.json`,
  );
}

function queueKey(root: string, journeyId: JourneyId): string {
  return `${resolve(root)}\u0000${journeyId}`;
}

function emptyManifest(journeyId: JourneyId): EvidenceManifest {
  return parseEvidenceManifest({ schemaVersion: 2, journeyId, records: [] });
}

function exactReadRequest(value: unknown): value is EvidenceReadRequest {
  const copied = copyContractDataGraph(value);
  if (!copied.ok) return false;
  const request = copied.value as { readonly [key: string]: unknown };
  return (
    request !== null &&
    !Array.isArray(request) &&
    typeof request === "object" &&
    Object.getPrototypeOf(request) === Object.prototype &&
    Object.keys(request).length === 1 &&
    Object.hasOwn(request, "journeyId") &&
    typeof request.journeyId === "string" &&
    /^journey_[A-Za-z0-9_-]{16,64}$/u.test(request.journeyId)
  );
}

function safeAdmissionGraph(request: EvidenceAdmissionRequest): boolean {
  return copyContractDataGraph(request).ok;
}

export function createEvidenceStore(
  root: string,
  limits: EvidenceLimits = {},
): EvidenceStore {
  const maxRecords = limits.maxRecords ?? EVIDENCE_MAX_RECORDS;
  const maxManifestBytes = limits.maxManifestBytes ?? EVIDENCE_MAX_MANIFEST_BYTES;
  if (
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    !Number.isSafeInteger(maxManifestBytes) ||
    maxManifestBytes < 1
  ) throw new RangeError("evidence limits must be positive safe integers");

  async function load(journeyId: JourneyId): Promise<EvidenceManifest> {
    let serialized: string;
    try {
      serialized = await readFile(manifestPath(root, journeyId), "utf8");
    } catch (error) {
      if (isEnoent(error)) return emptyManifest(journeyId);
      throw error;
    }
    if (Buffer.byteLength(serialized) > maxManifestBytes) {
      throw new RangeError("stored evidence manifest exceeds limit");
    }
    const manifest = parseEvidenceManifest(JSON.parse(serialized) as unknown);
    if (
      manifest.journeyId !== journeyId ||
      manifest.records.length > maxRecords ||
      new Set(manifest.records.map(({ id }) => id)).size !== manifest.records.length
    ) throw new TypeError("stored evidence manifest is invalid");
    return manifest;
  }

  async function persist(
    journeyId: JourneyId,
    manifest: EvidenceManifest,
    signal: AbortSignal,
  ) {
    const serialized = JSON.stringify(manifest);
    if (
      manifest.records.length > maxRecords ||
      Buffer.byteLength(serialized) > maxManifestBytes
    ) {
      return {
        ok: false,
        error: { code: "evidence_limit_exceeded", retryable: false },
      } as const;
    }

    const path = manifestPath(root, journeyId);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(root, { recursive: true });
      await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
      if (signal.aborted) {
        await rm(temporaryPath, { force: true });
        return cancelled;
      }
      await rename(temporaryPath, path);
      return { ok: true, value: undefined } as const;
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return unavailable;
    }
  }

  async function writeRecord(
    journeyId: JourneyId,
    record: EvidenceRecord,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return cancelled;
    let manifest: EvidenceManifest;
    try {
      manifest = await load(journeyId);
    } catch {
      return unavailable;
    }
    if (signal.aborted) return cancelled;

    const existing = manifest.records.find(({ id }) => id === record.id);
    if (existing !== undefined) {
      return existing.id === record.id &&
        existing.kind === record.kind &&
        existing.component === record.component &&
        existing.phase === record.phase &&
        existing.step === record.step &&
        existing.sha256 === record.sha256
        ? {
            ok: true,
            value: { recordId: record.id, written: false },
          } as const
        : denied;
    }

    let next: EvidenceManifest;
    try {
      next = parseEvidenceManifest({
        schemaVersion: 2,
        journeyId,
        records: [...manifest.records, record],
      });
    } catch {
      return denied;
    }
    const persisted = await persist(journeyId, next, signal);
    return persisted.ok
      ? {
          ok: true,
          value: { recordId: record.id, written: true },
        } as const
      : persisted;
  }

  async function serial<T>(
    journeyId: JourneyId,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = queueKey(root, journeyId);
    const prior = writeQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    writeQueues.set(key, current);
    await prior;
    try {
      return await action();
    } finally {
      release();
      if (writeQueues.get(key) === current) writeQueues.delete(key);
    }
  }

  return {
    async write(request, signal) {
      if (signal.aborted) return cancelled;
      if (!safeAdmissionGraph(request)) return denied;
      let consumed: ReturnType<typeof consumeEvidenceAdmission>;
      try {
        consumed = consumeEvidenceAdmission(request);
      } catch {
        return denied;
      }
      if (!consumed.ok) return consumed;
      const snapshot = consumed.value;
      return serial(snapshot.journeyId, () =>
        writeRecord(snapshot.journeyId, snapshot.record, signal),
      );
    },

    async read(request, signal) {
      if (signal.aborted) return cancelled;
      if (!exactReadRequest(request)) return denied;
      const journeyId = request.journeyId;
      return serial(journeyId, async () => {
        if (signal.aborted) return cancelled;
        try {
          const manifest = await load(journeyId);
          return signal.aborted
            ? cancelled
            : { ok: true, value: manifest } as const;
        } catch {
          return unavailable;
        }
      });
    },
  };
}
