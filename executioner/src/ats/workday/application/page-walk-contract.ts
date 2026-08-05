import type {
  BrowserPageId,
  FieldId,
  JourneyId,
  PortResult,
} from "../../../contracts/index.ts";
import type { S2StableErrorCode } from "../../../contracts/s2-common-wire.ts";

export const applicationPages = [
  "resume",
  "profile",
  "questionnaire",
] as const;
export const applicationClassifiers = [
  "workday_page",
  "resume_page",
  "profile_page",
  "questionnaire_page",
  "required_field_gate",
  "repeatable_row_gate",
  "page_navigation",
  "progress_projection",
] as const;
export const applicationPrimitives = [
  "page_observation",
  "file_upload",
  "profile_control",
  "question_control",
  "required_field_verification",
  "repeatable_row_reconciliation",
  "next",
  "record",
] as const;
export const applicationUnknownLayers = [
  "none",
  "page_type",
  "ui_behavior",
  "required_field",
  "repeatable_row",
  "question",
  "answer",
  "navigation",
] as const;

export type ApplicationHandlerPage = (typeof applicationPages)[number];
export type ApplicationPage = ApplicationHandlerPage | "pre_review";
export type ApplicationVerifiedCheckpoint =
  | "resume_verified"
  | "profile_verified"
  | "questionnaire_verified";
export type ApplicationCheckpoint = ApplicationVerifiedCheckpoint | "pre_review";
export type ApplicationUnknownLayer =
  (typeof applicationUnknownLayers)[number];
export type ApplicationClassifier = (typeof applicationClassifiers)[number];
export type ApplicationPrimitive = (typeof applicationPrimitives)[number];

export interface ApplicationPageTruth {
  readonly page: ApplicationPage;
  readonly pageId: BrowserPageId;
  readonly requiredFields: readonly {
    readonly fieldId: FieldId;
    readonly verification: "verified" | "unverified";
  }[];
  readonly c3OwnedDuplicateRows: number;
  readonly submitActivated: boolean;
}

export interface ApplicationPortFailure {
  readonly code: S2StableErrorCode;
  readonly classifier: ApplicationClassifier;
  readonly primitive: ApplicationPrimitive;
  readonly unknownLayer: ApplicationUnknownLayer;
}

export type ApplicationPortResult<T> = PortResult<T, ApplicationPortFailure>;

export interface ApplicationPageHandlerPort<
  Page extends ApplicationHandlerPage = ApplicationHandlerPage,
> {
  reconcile(
    request: {
      readonly journeyId: JourneyId;
      readonly pageId: BrowserPageId;
      readonly attempt: number;
    },
    signal: AbortSignal,
  ): Promise<
    ApplicationPortResult<{
      readonly page: Page;
      readonly pageId: BrowserPageId;
      readonly checkpoint: Page extends "resume"
        ? "resume_verified"
        : Page extends "profile"
          ? "profile_verified"
          : "questionnaire_verified";
      readonly independentlyVerified: true;
    }>
  >;
}

export interface ApplicationWalkProgress {
  readonly checkpoint: ApplicationCheckpoint;
  readonly browserPage: ApplicationPage;
  readonly completedPages: number;
  readonly reconciledPages: readonly ApplicationHandlerPage[];
}

export interface ApplicationWalkDependencies {
  readonly observer: {
    observe(signal: AbortSignal): Promise<ApplicationPortResult<ApplicationPageTruth>>;
  };
  readonly handlers: {
    readonly resume: ApplicationPageHandlerPort<"resume">;
    readonly profile: ApplicationPageHandlerPort<"profile">;
    readonly questionnaire: ApplicationPageHandlerPort<"questionnaire">;
  };
  readonly navigation: {
    next(
      request: {
        readonly journeyId: JourneyId;
        readonly from: ApplicationHandlerPage;
        readonly fromPageId: BrowserPageId;
        readonly expected: ApplicationPage;
      },
      signal: AbortSignal,
    ): Promise<ApplicationPortResult<{ readonly advanced: true }>>;
  };
  readonly progress: {
    record(
      progress: ApplicationWalkProgress,
      signal: AbortSignal,
    ): Promise<ApplicationPortResult<void>>;
  };
}

export interface ApplicationPageCheck {
  readonly page: ApplicationHandlerPage;
  readonly checkpoint: ApplicationVerifiedCheckpoint;
  readonly independentlyVerified: true;
  readonly requiredFields: number;
  readonly verifiedFields: number;
  readonly duplicateRows: number;
}

export interface ApplicationWalkFailurePacket {
  readonly code: S2StableErrorCode;
  readonly retryable: boolean;
  readonly owner:
    | ApplicationHandlerPage
    | "browser_truth"
    | "navigation"
    | "progress";
  readonly classifier: ApplicationClassifier;
  readonly primitive: ApplicationPrimitive;
  readonly unknownLayer: ApplicationUnknownLayer;
  readonly page: ApplicationPage;
  readonly attempt: number;
}

export type ApplicationWalkResult = PortResult<
  {
    readonly checkpoint: ApplicationCheckpoint;
    readonly completedPages: number;
    readonly pageChecks: readonly ApplicationPageCheck[];
    readonly submitActivated: false;
    readonly privacyScan: "pass";
  },
  {
    readonly checkpoint: ApplicationPage;
    readonly completedPages: number;
    readonly failure: ApplicationWalkFailurePacket;
    readonly submitActivated: false;
    readonly privacyScan: "pass";
  }
>;

export interface ApplicationWalkOptions {
  readonly pageRetryLimit?: number;
}

export interface ApplicationWalkInput {
  readonly journeyId: JourneyId;
  readonly stopAfter?: ApplicationCheckpoint;
}
