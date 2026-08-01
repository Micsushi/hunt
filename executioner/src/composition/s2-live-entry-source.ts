import { createHash } from "node:crypto";

import type {
  LivePortResult,
  LiveSessionId,
  PersistentBrowserErrorCode,
  StructuralTraitId,
  TargetIdentityV1,
} from "../contracts/live/index.ts";
import { providerError } from "../contracts/index.ts";
import type {
  LiveEntryDocumentGenerationId,
  LiveEntryInspectionRequest,
  LiveEntrySnapshotId,
  LiveEntryTargetFact,
} from "../ats/workday/live/index.ts";
import type {
  LiveEntryStructuralInspection,
  LiveEntryStructuralSource,
} from "../ats/workday/live/private/structural-source.ts";

interface OwnedTargetSnapshot {
  readonly schemaVersion: 1;
  readonly traitIds: readonly string[];
  readonly controlCount: number;
  readonly requiredControlCount: number;
  readonly optionCount: number;
}

interface OwnedTargetInspectionCapability {
  inspectOwnedTarget(
    sessionId: LiveSessionId,
    expectedTarget: TargetIdentityV1,
    signal: AbortSignal,
  ): Promise<LivePortResult<{
    readonly target: LiveEntryTargetFact | { readonly kind: "matched" };
    readonly snapshot: OwnedTargetSnapshot;
  }, PersistentBrowserErrorCode>>;
}

export function createPlaywrightLiveEntryStructuralSource(
  browser: OwnedTargetInspectionCapability,
): LiveEntryStructuralSource {
  let generation = 0;
  return Object.freeze({
    async inspectFresh(
      request: LiveEntryInspectionRequest,
      signal: AbortSignal,
    ): Promise<LivePortResult<LiveEntryStructuralInspection, PersistentBrowserErrorCode>> {
      const inspected = await browser.inspectOwnedTarget(
        request.sessionId,
        request.target,
        signal,
      );
      if (!inspected.ok) return inspected;
      const inspectedTarget = inspected.value.target;
      if (inspectedTarget.kind !== "matched") {
        return {
          ok: true,
          value: { target: copyTarget(inspectedTarget) },
        };
      }
      generation += 1;
      const snapshot = inspected.value.snapshot;
      const structural = copyStructural(snapshot);
      if (structural === undefined) {
        return { ok: false, error: providerError("browser_target_stale") };
      }
      const snapshotHash = digest(structural);
      return {
        ok: true,
        value: {
          target: { kind: "matched" },
          snapshot: Object.freeze({
            ...structural,
            snapshotId: `snapshot_${snapshotHash}` as LiveEntrySnapshotId,
            documentGenerationId: `document_generation_${digest({
              sessionId: request.sessionId,
              snapshotHash,
              generation,
            })}` as LiveEntryDocumentGenerationId,
          }),
        },
      };
    },
  });
}

function copyStructural(snapshot: OwnedTargetSnapshot): {
  readonly schemaVersion: 1;
  readonly traitIds: readonly StructuralTraitId[];
  readonly controlCount: number;
  readonly requiredControlCount: number;
  readonly optionCount: number;
} | undefined {
  if (
    snapshot.schemaVersion !== 1 ||
    !Array.isArray(snapshot.traitIds) ||
    snapshot.traitIds.length === 0 ||
    snapshot.traitIds.length > 32 ||
    snapshot.traitIds.some((trait) =>
      typeof trait !== "string" ||
      !/^structural_trait_[A-Za-z0-9_-]{16,64}$/u.test(trait)
    ) ||
    new Set(snapshot.traitIds).size !== snapshot.traitIds.length ||
    !boundedCount(snapshot.controlCount) ||
    !boundedCount(snapshot.requiredControlCount) ||
    !boundedCount(snapshot.optionCount) ||
    snapshot.requiredControlCount > snapshot.controlCount
  ) return undefined;
  return Object.freeze({
    schemaVersion: 1,
    traitIds: Object.freeze([...snapshot.traitIds]) as readonly StructuralTraitId[],
    controlCount: snapshot.controlCount,
    requiredControlCount: snapshot.requiredControlCount,
    optionCount: snapshot.optionCount,
  });
}

function boundedCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 64;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function copyTarget(
  target: LiveEntryTargetFact,
): LiveEntryTargetFact {
  if (target.kind === "target_mismatch") {
    return Object.freeze({ kind: target.kind, dimension: target.dimension });
  }
  if (target.kind === "posting_unavailable") {
    return Object.freeze({ kind: target.kind, reason: target.reason });
  }
  return Object.freeze({ kind: "target_ambiguous" });
}
