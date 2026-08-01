import { createHash } from "node:crypto";

import type {
  ClassificationId,
  ClassificationLineageV1,
  LivePortResult,
  PersistentBrowserErrorCode,
  SanitizedStructuralObservationV1,
  StructuralObservationId,
  StructuralTraitId,
} from "../../../contracts/live/index.ts";
import { providerError } from "../../../contracts/index.ts";
import {
  classifyLiveAccountState,
  type LiveAccountStateResult,
  type UnresolvedLiveAccountStateResult,
} from "./account-state.ts";
import {
  createLiveAtsFamilyClassifier,
  createLiveWorkdayPageTypeClassifier,
} from "./classifiers.ts";
import { LIVE_ENTRY_CLASSIFICATION_REVISION_ID } from "./traits.ts";
import type {
  ClassifiedAccountObservationSource,
  ClassifiedAccountObservation,
  LiveEntryInspectionRequest,
} from "./types.ts";
import type {
  LiveEntryStructuralSnapshot,
  LiveEntryStructuralInspection,
  LiveEntryStructuralSource,
  LiveEntryVerificationResult,
  LiveEntryVerifier,
} from "./private/structural-source.ts";

export function createLiveEntryVerifier(
  source: LiveEntryStructuralSource,
): LiveEntryVerifier {
  const atsFamily = createLiveAtsFamilyClassifier();
  const pageType = createLiveWorkdayPageTypeClassifier();
  return Object.freeze({
    async inspectFresh(
      request: LiveEntryInspectionRequest,
      signal: AbortSignal,
    ): Promise<LivePortResult<LiveEntryVerificationResult, PersistentBrowserErrorCode>> {
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      const inspected = await source.inspectFresh(request, signal);
      if (!inspected.ok) return inspected;
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      if (!isMatchedStructuralInspection(inspected.value)) {
        return { ok: true, value: copyTargetFact(inspected.value.target) };
      }
      const snapshot = copySnapshot(inspected.value.snapshot);
      const atsObservation = observation("ats_family", snapshot, []);
      const atsResult = await atsFamily.classify({
        schemaVersion: 1,
        observation: atsObservation,
      }, signal);
      if (!atsResult.ok) return atsResult;
      if (atsResult.value.kind !== "classified") {
        return {
          ok: true,
          value: withSnapshot(atsResult.value, atsObservation, snapshot),
        };
      }
      const atsLineage = [{
        layer: "ats_family" as const,
        classificationId: atsResult.value.classificationId,
      }];
      const pageObservation = observation("workday_page_type", snapshot, atsLineage);
      const pageResult = await pageType.classify({
        schemaVersion: 1,
        atsFamilyClassificationId: atsResult.value.classificationId,
        observation: pageObservation,
      }, signal);
      if (!pageResult.ok) return pageResult;
      if (pageResult.value.kind !== "classified") {
        return {
          ok: true,
          value: withSnapshot(pageResult.value, pageObservation, snapshot),
        };
      }
      const state = classifyLiveAccountState(pageResult.value.pageType, snapshot.traitIds);
      if (isUnresolvedAccountState(state)) {
        return Object.freeze({
          ok: true,
          value: Object.freeze({
            kind: state.kind,
            classificationId: state.classificationId,
            sourceRevisionId: state.sourceRevisionId,
            observation: pageObservation,
            snapshotId: snapshot.snapshotId,
            documentGenerationId: snapshot.documentGenerationId,
          }),
        });
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          kind: "classified_account",
          pageType: pageResult.value.pageType,
          atsFamilyClassificationId: atsResult.value.classificationId,
          pageTypeClassificationId: pageResult.value.classificationId,
          state,
          classificationId: state.classificationId,
          sourceRevisionId: state.sourceRevisionId,
          snapshotId: snapshot.snapshotId,
          documentGenerationId: snapshot.documentGenerationId,
        }),
      });
    },
  });
}

export function createClassifiedAccountObservationSource(
  verifier: LiveEntryVerifier,
): ClassifiedAccountObservationSource {
  return Object.freeze({
    async inspectClassifiedAccount(
      request: LiveEntryInspectionRequest,
      signal: AbortSignal,
    ): Promise<LivePortResult<ClassifiedAccountObservation, PersistentBrowserErrorCode>> {
      const inspected = await verifier.inspectFresh(request, signal);
      if (!inspected.ok) return inspected;
      const result = inspected.value;
      if (isTargetFact(result)) return { ok: true, value: result };
      if (result.kind === "classified_account") {
        return Object.freeze({
          ok: true,
          value: Object.freeze({
            kind: result.kind,
            state: result.state,
            classificationId: result.classificationId,
            sourceRevisionId: result.sourceRevisionId,
            snapshotId: result.snapshotId,
            documentGenerationId: result.documentGenerationId,
          }),
        });
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          kind: "classification_stopped",
          outcome: result.kind,
          classificationId: "classificationId" in result
            ? result.classificationId
            : null,
          sourceRevisionId: result.sourceRevisionId,
          snapshotId: result.snapshotId,
          documentGenerationId: result.documentGenerationId,
        }),
      });
    },
  });
}

function isMatchedStructuralInspection(
  inspection: LiveEntryStructuralInspection,
): inspection is {
  readonly target: { readonly kind: "matched" };
  readonly snapshot: LiveEntryStructuralSnapshot;
} {
  return inspection.target.kind === "matched";
}

function copyTargetFact(
  target: Extract<LiveEntryVerificationResult, {
    kind: "target_mismatch" | "target_ambiguous" | "posting_unavailable";
  }>,
): Extract<LiveEntryVerificationResult, {
  kind: "target_mismatch" | "target_ambiguous" | "posting_unavailable";
}> {
  if (target.kind === "target_mismatch") {
    return Object.freeze({ kind: target.kind, dimension: target.dimension });
  }
  if (target.kind === "posting_unavailable") {
    return Object.freeze({ kind: target.kind, reason: target.reason });
  }
  return Object.freeze({ kind: target.kind });
}

function isUnresolvedAccountState(
  state: LiveAccountStateResult,
): state is UnresolvedLiveAccountStateResult {
  return state.kind === "account_state_unknown" ||
    state.kind === "account_state_ambiguous";
}

function isTargetFact(
  result: LiveEntryVerificationResult,
): result is Extract<LiveEntryVerificationResult, { kind: "target_mismatch" | "target_ambiguous" | "posting_unavailable" }> {
  return result.kind === "target_mismatch" ||
    result.kind === "target_ambiguous" ||
    result.kind === "posting_unavailable";
}

function copySnapshot(snapshot: LiveEntryStructuralSnapshot): LiveEntryStructuralSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    documentGenerationId: snapshot.documentGenerationId,
    traitIds: Object.freeze([...snapshot.traitIds]),
    controlCount: snapshot.controlCount,
    requiredControlCount: snapshot.requiredControlCount,
    optionCount: snapshot.optionCount,
  });
}

function observation<L extends "ats_family" | "workday_page_type">(
  layer: L,
  snapshot: LiveEntryStructuralSnapshot,
  parentLineage: readonly ClassificationLineageV1[],
): SanitizedStructuralObservationV1 & { readonly layer: L } {
  const identity = createHash("sha256").update(JSON.stringify({
    layer,
    snapshotId: snapshot.snapshotId,
    documentGenerationId: snapshot.documentGenerationId,
    parentLineage,
    traitIds: snapshot.traitIds,
    controlCount: snapshot.controlCount,
    requiredControlCount: snapshot.requiredControlCount,
    optionCount: snapshot.optionCount,
  })).digest("hex").slice(0, 16);
  return Object.freeze({
    schemaVersion: 1,
    observationId: `structural_observation_${identity}` as StructuralObservationId,
    layer,
    sourceRevisionId: LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
    parentLineage: Object.freeze(parentLineage.map((entry) => Object.freeze({ ...entry }))),
    traitIds: snapshot.traitIds as readonly StructuralTraitId[],
    observedVariantId: null,
    controlCount: snapshot.controlCount,
    requiredControlCount: snapshot.requiredControlCount,
    optionCount: snapshot.optionCount,
  });
}

function withSnapshot<
  T extends { readonly kind: string; readonly sourceRevisionId: typeof LIVE_ENTRY_CLASSIFICATION_REVISION_ID },
  L extends "ats_family" | "workday_page_type",
>(
  result: T,
  sanitizedObservation: SanitizedStructuralObservationV1 & { readonly layer: L },
  snapshot: LiveEntryStructuralSnapshot,
): T & {
  readonly observation: SanitizedStructuralObservationV1 & { readonly layer: L };
  readonly snapshotId: LiveEntryStructuralSnapshot["snapshotId"];
  readonly documentGenerationId: LiveEntryStructuralSnapshot["documentGenerationId"];
} {
  return Object.freeze({
    ...result,
    observation: sanitizedObservation,
    snapshotId: snapshot.snapshotId,
    documentGenerationId: snapshot.documentGenerationId,
  });
}
