import type {
  ClassificationId,
  ClassificationRevisionId,
  LivePortResult,
  LiveSessionId,
  PersistentBrowserErrorCode,
  PersistentBrowserReconcileResult,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import type { ResolvedLiveAccountStateResult } from "./account-state.ts";

declare const liveEntryIdentifierBrand: unique symbol;
export type LiveEntryIdentifier<Kind extends string> = string & {
  readonly [liveEntryIdentifierBrand]: Kind;
};

export type LiveEntrySnapshotId = LiveEntryIdentifier<"snapshot">;
export type LiveEntryDocumentGenerationId =
  LiveEntryIdentifier<"document_generation">;

export type LiveEntryTargetFact = Exclude<
  PersistentBrowserReconcileResult,
  { readonly kind: "matched" }
>;

export interface LiveEntryInspectionRequest {
  readonly schemaVersion: 1;
  readonly sessionId: LiveSessionId;
  readonly target: TargetIdentityV1;
}

export type ClassifiedAccountObservation =
  | LiveEntryTargetFact
  | {
      readonly kind: "classified_account";
      readonly state: ResolvedLiveAccountStateResult;
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
      readonly snapshotId: LiveEntrySnapshotId;
      readonly documentGenerationId: LiveEntryDocumentGenerationId;
    }
  | {
      readonly kind: "classification_stopped";
      readonly outcome:
        | "ats_unsupported"
        | "ats_unknown"
        | "ats_ambiguous"
        | "workday_page_unknown"
        | "workday_page_ambiguous"
        | "account_state_unknown"
        | "account_state_ambiguous";
      readonly classificationId: ClassificationId | null;
      readonly sourceRevisionId: ClassificationRevisionId;
      readonly snapshotId: LiveEntrySnapshotId;
      readonly documentGenerationId: LiveEntryDocumentGenerationId;
    };

export interface ClassifiedAccountObservationSource {
  inspectClassifiedAccount(
    request: LiveEntryInspectionRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<ClassifiedAccountObservation, PersistentBrowserErrorCode>>;
}
