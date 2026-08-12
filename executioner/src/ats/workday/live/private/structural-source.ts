import type {
  AtsFamilyClassificationResultV1,
  ClassificationId,
  ClassificationRevisionId,
  LivePortResult,
  PersistentBrowserErrorCode,
  SanitizedStructuralObservationV1,
  StructuralTraitId,
  WorkdayPageType,
  WorkdayPageTypeClassificationResultV1,
} from "../../../../contracts/live/index.ts";
import type { ResolvedLiveAccountStateResult } from "../account-state.ts";
import type {
  LiveEntryDocumentGenerationId,
  LiveEntryInspectionRequest,
  LiveEntrySnapshotId,
  LiveEntryTargetFact,
} from "../types.ts";

export interface LiveEntryStructuralSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: LiveEntrySnapshotId;
  readonly documentGenerationId: LiveEntryDocumentGenerationId;
  readonly traitIds: readonly StructuralTraitId[];
  readonly controlCount: number;
  readonly requiredControlCount: number;
  readonly optionCount: number;
}

export type LiveEntryStructuralInspection =
  | { readonly target: LiveEntryTargetFact }
  | {
      readonly target: { readonly kind: "matched" };
      readonly snapshot: LiveEntryStructuralSnapshot;
    };

export interface LiveEntryStructuralSource {
  inspectFresh(
    request: LiveEntryInspectionRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<LiveEntryStructuralInspection, PersistentBrowserErrorCode>>;
}

type AtsStop = Exclude<
  AtsFamilyClassificationResultV1,
  { readonly kind: "classified" }
>;
type PageStop = Exclude<
  WorkdayPageTypeClassificationResultV1,
  { readonly kind: "classified" }
>;

export type LiveEntryVerificationResult =
  | LiveEntryTargetFact
  | (AtsStop & {
      readonly observation: SanitizedStructuralObservationV1 & {
        readonly layer: "ats_family";
      };
      readonly snapshotId: LiveEntrySnapshotId;
      readonly documentGenerationId: LiveEntryDocumentGenerationId;
    })
  | (PageStop & {
      readonly observation: SanitizedStructuralObservationV1 & {
        readonly layer: "workday_page_type";
      };
      readonly snapshotId: LiveEntrySnapshotId;
      readonly documentGenerationId: LiveEntryDocumentGenerationId;
    })
  | {
      readonly kind: "account_state_unknown" | "account_state_ambiguous";
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
      readonly pageType: WorkdayPageType;
      readonly observation: SanitizedStructuralObservationV1 & {
        readonly layer: "workday_page_type";
      };
      readonly snapshotId: LiveEntrySnapshotId;
      readonly documentGenerationId: LiveEntryDocumentGenerationId;
    }
  | {
      readonly kind: "classified_account";
      readonly pageType: WorkdayPageType;
      readonly atsFamilyClassificationId: ClassificationId;
      readonly pageTypeClassificationId: ClassificationId;
      readonly state: ResolvedLiveAccountStateResult;
      readonly classificationId: ClassificationId;
      readonly sourceRevisionId: ClassificationRevisionId;
      readonly snapshotId: LiveEntrySnapshotId;
      readonly documentGenerationId: LiveEntryDocumentGenerationId;
    };

export interface LiveEntryVerifier {
  inspectFresh(
    request: LiveEntryInspectionRequest,
    signal: AbortSignal,
  ): Promise<LivePortResult<LiveEntryVerificationResult, PersistentBrowserErrorCode>>;
}
