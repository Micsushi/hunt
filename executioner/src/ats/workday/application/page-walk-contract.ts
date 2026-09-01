import type {
  BrowserPageId,
  FieldId,
  JourneyId,
  PortResult,
} from "../../../contracts/index.ts";
import type { SharedUiStateFact } from
  "../../../deterministic/ui-state-model.ts";
import type { S2StableErrorCode } from "../../../contracts/s2-common-wire.ts";

export const applicationPages = [
  "profile",
  "resume",
  "questionnaire",
] as const;
export const applicationCheckpoints = [
  "profile_verified",
  "resume_verified",
  "questionnaire_verified",
] as const;
export const maximumApplicationPageVisits = 8;
export const WORKDAY_APPLICATION_PAGE_SELECTORS = Object.freeze({
  myInformation: '[data-automation-id="applyFlowMyInfoPage"]',
  experience:
    '[data-automation-id="applyFlowMyExperiencePage"], [data-automation-id="applyFlowMyExpPage"]',
  primaryQuestions: '[data-automation-id="applyFlowPrimaryQuestionsPage"]',
  primaryQuestionnaire: '[data-automation-id="applyFlowPrimaryQuestionnairePage"]',
  applicationQuestions: '[data-automation-id="applyFlowApplicationQuestionsPage"]',
  voluntaryDisclosuresAndSelfIdentify:
    '[data-automation-id="applyFlowVoluntaryDisclosuresPage"], ' +
    '[data-automation-id="applyFlowSelfIdentifyPage"]',
  review: '[data-automation-id="applyFlowReviewPage"]',
});
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
  (typeof applicationCheckpoints)[number];
export type ApplicationCheckpoint = ApplicationVerifiedCheckpoint | "pre_review";
export type ApplicationUnknownLayer =
  (typeof applicationUnknownLayers)[number];
export type ApplicationClassifier = (typeof applicationClassifiers)[number];
export type ApplicationPrimitive = (typeof applicationPrimitives)[number];

export interface ApplicationPageTruth {
  readonly page: ApplicationPage;
  readonly lanes?: readonly ApplicationHandlerPage[];
  readonly pageId: BrowserPageId;
  readonly requiredFields: readonly {
    readonly fieldId: FieldId;
    readonly page?: ApplicationHandlerPage;
    readonly verification: "verified" | "unverified";
    readonly uiState?: SharedUiStateFact;
  }[];
  readonly c3OwnedDuplicateRows: number;
  readonly submitActivated: boolean;
}

export function isApplicationFieldNavigationEligible(
  field: ApplicationPageTruth["requiredFields"][number],
): boolean {
  return field.verification === "verified" &&
    (field.uiState === undefined ||
      field.uiState.revision === "shared-ui-state-v1" && field.uiState.navigationEligible);
}

export interface ApplicationPortFailure {
  readonly code: S2StableErrorCode;
  readonly classifier: ApplicationClassifier;
  readonly primitive: ApplicationPrimitive;
  readonly unknownLayer: ApplicationUnknownLayer;
  readonly protectedPlaceholderCount?: 0 | 1;
  readonly placeholderProvenance?: "synthetic_ui_learning";
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
  readonly browserLanes: readonly ApplicationHandlerPage[];
  readonly completedPages: number;
  readonly reconciledPages: readonly ApplicationHandlerPage[];
  readonly pageChecks: readonly ApplicationPageCheck[];
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
        readonly allowed: readonly ApplicationPage[];
      },
      signal: AbortSignal,
    ): Promise<ApplicationPortResult<{
      readonly advanced: true;
      readonly destination?: ApplicationPageTruth;
    }>>;
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
  readonly protectedPlaceholderCount?: 0 | 1;
  readonly placeholderProvenance?: "synthetic_ui_learning";
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
  readonly resume?: ApplicationWalkResume;
}

export interface ApplicationWalkResume {
  readonly currentPage: ApplicationPage;
  readonly currentLanes?: readonly ApplicationHandlerPage[];
  readonly pageChecks: readonly ApplicationPageCheck[];
}

export interface ApplicationWalkInput {
  readonly journeyId: JourneyId;
  readonly stopAfter?: ApplicationCheckpoint;
}

export function checkpointForApplicationPage(
  page: ApplicationHandlerPage,
): ApplicationVerifiedCheckpoint {
  return page === "resume"
    ? "resume_verified"
    : page === "profile"
      ? "profile_verified"
      : "questionnaire_verified";
}

export function applicationPageForCheckpoint(
  checkpoint: ApplicationVerifiedCheckpoint,
): ApplicationHandlerPage {
  return checkpoint === "resume_verified"
    ? "resume"
    : checkpoint === "profile_verified"
      ? "profile"
      : "questionnaire";
}

export function applicationNextPages(
  page: ApplicationHandlerPage,
): readonly ApplicationPage[] {
  return page === "questionnaire"
    ? ["questionnaire", "pre_review"]
    : page === "profile"
      ? ["profile", "resume", "questionnaire", "pre_review"]
      : ["profile", "questionnaire", "pre_review"];
}

export function isAllowedApplicationTransition(
  from: ApplicationHandlerPage,
  to: ApplicationPage,
  visited: readonly ApplicationHandlerPage[] = [],
): boolean {
  if (!applicationNextPages(from).includes(to)) return false;
  // Workday can expose My Information and My Experience as two distinct
  // physical roots that both belong to the profile handler lane. Admit that
  // exact two-step lane once; the browser adapter separately requires a root
  // or semantic transition, so ordinary DOM churn is not enough.
  if (from === "profile" && to === "profile") {
    return visited.filter((page) => page === "profile").length === 1;
  }
  if (from === "resume" && to === "profile") return true;
  return to === "questionnaire" || to === "pre_review" || !visited.includes(to);
}

export function isValidApplicationPageSequence(
  pages: readonly ApplicationHandlerPage[],
): boolean {
  if (pages.length > maximumApplicationPageVisits) return false;
  const visited: ApplicationHandlerPage[] = [];
  for (const page of pages) {
    if (!applicationPages.includes(page)) return false;
    const previous = visited.at(-1);
    if (
      previous !== undefined &&
      !isAllowedApplicationTransition(previous, page, visited)
    ) return false;
    if (
      page !== "questionnaire" && visited.includes(page) &&
      !(page === "profile" && (
        previous === "resume" ||
        (previous === "profile" &&
          visited.filter((visitedPage) => visitedPage === "profile").length === 1)
      ))
    ) return false;
    visited.push(page);
  }
  return true;
}
