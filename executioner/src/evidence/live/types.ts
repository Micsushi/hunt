import type {
  ErrorEnvelopeV3,
  S2CommonPhaseId,
  S2StableErrorCode,
  StepId,
} from "../../contracts/index.ts";

export type MilestoneKind =
  | "account_verified"
  | "application_completed"
  | "review_reached"
  | "submit_guarded";
export type VerificationKind =
  | "account"
  | "resume"
  | "required_fields"
  | "review"
  | "submit_guard";
export type MissingEvidenceKind =
  | "account_verification"
  | "application_completion"
  | "required_fields_verification"
  | "resume_verification"
  | "review_proof"
  | "submit_presence";
export type ClassificationLayer =
  | "ats_family"
  | "workday_page_type"
  | "ui_behavior"
  | "question"
  | "answer_type"
  | "visible_option";

export interface LiveEvidenceMilestoneV1 {
  readonly kind: MilestoneKind;
  readonly status: "verified" | "missing";
}

export interface LiveEvidenceVerificationSummaryV1 {
  readonly kind: VerificationKind;
  readonly status: "verified" | "missing";
  readonly verifiedCount: number;
}

export interface LiveEvidenceErrorV1 {
  readonly code: S2StableErrorCode;
  readonly component: ErrorEnvelopeV3["component"];
  readonly phase: S2CommonPhaseId;
  readonly step: StepId;
  readonly retryable: boolean;
}

export interface IndependentBrowserTruthV1 {
  readonly schemaVersion: 1;
  readonly observer: "independent_browser";
  readonly page: "review" | "unknown";
  readonly reviewSignatureIds: readonly string[];
  readonly completionEvidenceIds: readonly string[];
  readonly submitStructurallyPresent: boolean;
  readonly submitActivated: false;
}

export interface UnknownCandidateEvidenceV1 {
  readonly schemaVersion: 1;
  readonly layer: ClassificationLayer;
  readonly acceptedSchemaId: string;
  readonly acceptedRevisionId: string;
  readonly structuralTraitIds: readonly string[];
  readonly controlCount: number;
  readonly requiredControlCount: number;
  readonly optionCount: number;
  readonly reviewLineage: readonly {
    readonly layer: ClassificationLayer;
    readonly classificationId: string;
  }[];
}

export interface LiveEvidencePacketRequestV1 {
  readonly schemaVersion: 1;
  readonly packetRevision: "s2-real-evidence-packet-v1";
  readonly root: string;
  readonly sourceRevision: string;
  readonly configurationRevisionId: string;
  readonly configurationApprovalId: string;
  readonly journeyId: string;
  readonly sealedAt: string;
  readonly retentionDays: 30;
  readonly milestones: readonly LiveEvidenceMilestoneV1[];
  readonly verificationSummaries: readonly LiveEvidenceVerificationSummaryV1[];
  readonly errors: readonly LiveEvidenceErrorV1[];
  readonly missingEvidence: readonly MissingEvidenceKind[];
  readonly browserTruth: IndependentBrowserTruthV1;
  readonly diagnosticProjection: {
    readonly reviewReached: boolean;
    readonly requiredFieldsComplete: boolean;
    readonly submitActivated: false;
  };
  readonly unknownCandidate: UnknownCandidateEvidenceV1 | null;
  readonly forbiddenTokens: readonly string[];
}

export interface LiveEvidenceArtifactManifestEntryV1 {
  readonly file: "browser-truth.json" | "summary.json" | "unknown-candidate.json";
  readonly bytes: number;
  readonly sha256: string;
}

export interface LiveEvidenceArtifactManifestV1 {
  readonly schemaVersion: 1;
  readonly manifestRevision: "s2-real-evidence-manifest-v1";
  readonly sourceRevision: string;
  readonly configurationRevisionId: string;
  readonly configurationApprovalId: string;
  readonly journeyId: string;
  readonly sealedAt: string;
  readonly privacyScan: "pass";
  readonly artifactCount: number;
  readonly totalArtifactBytes: number;
  readonly retention: {
    readonly retentionDays: 30;
    readonly deleteAfter: string;
    readonly disposition: "delete_after_retention";
    readonly screenshotsRetained: false;
    readonly rawDomRetained: false;
  };
  readonly artifacts: readonly LiveEvidenceArtifactManifestEntryV1[];
}
