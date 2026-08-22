import type {
  BrowserPageId,
  DurableJourneyState,
  JourneyStateTransitionCommand,
  OperationId,
  PageCompletionResult,
  SemanticPageSnapshot,
  VerificationResult,
} from "../../contracts/index.ts";

export interface ReviewReadOnlyLocator {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  getByRole(
    role: "button",
    options: Readonly<{ name: RegExp }>,
  ): ReviewReadOnlyLocator;
}

export interface ReviewReadOnlyPage {
  locator(selector: string): ReviewReadOnlyLocator;
}

export const workdayReviewSignatures = Object.freeze({
  reviewRoot: '[data-automation-id="applyFlowReviewPage"]:visible',
  activeStep:
    '[data-automation-id="progressBarActiveStep"]:text-is("Review"):visible, ' +
    '[data-automation-id="progressBarActiveStep"]:visible:has(label:text-is("Review"))',
  finalSubmitScope:
    '[data-automation-id="applyFlowReviewPage"]:visible, ' +
    '[data-automation-id="applyFlowPage"] [data-automation-id="pageFooter"]:visible',
  validationError:
    '[data-automation-id="applyFlowReviewPage"] [aria-invalid="true"]:visible, ' +
    '[data-automation-id="applyFlowReviewPage"] [role="alert"]:visible, ' +
    '[data-automation-id="applyFlowReviewPage"] [data-automation-id*="error" i]:visible',
  finalSubmitName: /^(?:Submit|Submit application|Submit my application)$/iu,
});

export interface WorkdayReviewStructuralObservationV1 {
  readonly schemaVersion: 1;
  readonly reviewRoot: {
    readonly count: number;
    readonly visible: boolean;
  };
  readonly activeStep: {
    readonly count: number;
    readonly visible: boolean;
  };
  readonly validationErrorCount: number;
  readonly finalSubmit: {
    readonly count: number;
    readonly visible: boolean;
    readonly enabled: boolean;
  };
}

export type ReviewStopDenialReason =
  | "page_not_review"
  | "completion_unverified"
  | "review_signature_missing"
  | "review_signature_ambiguous"
  | "review_not_visible"
  | "submit_signature_missing"
  | "submit_signature_ambiguous"
  | "submit_not_visible"
  | "state_mismatch";

export interface ReviewStopRequest {
  readonly state: DurableJourneyState;
  readonly operationId: OperationId;
  readonly pageId: BrowserPageId;
  readonly page: SemanticPageSnapshot;
  readonly verification: readonly VerificationResult[];
  readonly completion: PageCompletionResult;
  readonly structure: WorkdayReviewStructuralObservationV1;
}

export type ReviewStopResult =
  | {
      readonly kind: "review_denied";
      readonly reason: ReviewStopDenialReason;
    }
  | {
      readonly kind: "review_confirmed";
      readonly proof: {
        readonly schemaVersion: 1;
        readonly page: "review";
        readonly requiredFieldCount: number;
        readonly verifiedRequiredFieldCount: number;
        readonly validationErrorCount: number;
        readonly finalSubmit: {
          readonly present: true;
          readonly visible: true;
          readonly enabled: boolean;
        };
      };
      readonly transition: JourneyStateTransitionCommand & {
        readonly status: "review_reached";
      };
    };

export async function inspectWorkdayReview(
  page: ReviewReadOnlyPage,
): Promise<WorkdayReviewStructuralObservationV1> {
  const root = page.locator(workdayReviewSignatures.reviewRoot);
  const activeStep = page.locator(workdayReviewSignatures.activeStep);
  const validationError = page.locator(workdayReviewSignatures.validationError);
  const finalSubmit = page.locator(workdayReviewSignatures.finalSubmitScope).getByRole("button", {
    name: workdayReviewSignatures.finalSubmitName,
  });
  const [
    reviewRootCount,
    activeStepCount,
    validationErrorCount,
    finalSubmitCount,
  ] = await Promise.all([
    root.count(),
    activeStep.count(),
    validationError.count(),
    finalSubmit.count(),
  ]);
  for (const count of [
    reviewRootCount,
    activeStepCount,
    validationErrorCount,
    finalSubmitCount,
  ]) {
    if (!Number.isInteger(count) || count < 0 || count > 64) {
      throw new TypeError("invalid Review structural count");
    }
  }
  const [reviewRootVisible, activeStepVisible, finalSubmitVisible] =
    await Promise.all([
      reviewRootCount === 1 ? root.isVisible() : false,
      activeStepCount === 1 ? activeStep.isVisible() : false,
      finalSubmitCount === 1 ? finalSubmit.isVisible() : false,
    ]);
  const finalSubmitEnabled = finalSubmitVisible
    ? await finalSubmit.isEnabled()
    : false;
  return Object.freeze({
    schemaVersion: 1,
    reviewRoot: Object.freeze({
      count: reviewRootCount,
      visible: reviewRootVisible,
    }),
    activeStep: Object.freeze({
      count: activeStepCount,
      visible: activeStepVisible,
    }),
    validationErrorCount,
    finalSubmit: Object.freeze({
      count: finalSubmitCount,
      visible: finalSubmitVisible,
      enabled: finalSubmitEnabled,
    }),
  });
}

export function stopAtVerifiedReview(
  request: ReviewStopRequest,
): ReviewStopResult {
  if (
    request.page.pageIdentity.kind !== "workday" ||
    request.page.pageIdentity.page !== "review"
  ) return denied("page_not_review");

  if (
    request.completion.kind !== "complete" ||
    request.completion.decision.kind !== "stop_review"
  ) return denied("completion_unverified");

  const requiredFieldIds = request.page.fields
    .filter(({ required }) => required)
    .map(({ fieldId }) => fieldId)
    .filter((fieldId, index, all) => all.indexOf(fieldId) === index);
  const allFieldIds = request.page.fields.map(({ fieldId }) => fieldId);
  if (
    requiredFieldIds.length === 0 ||
    new Set(allFieldIds).size !== allFieldIds.length ||
    request.verification.length !== requiredFieldIds.length ||
    request.verification.some(({ fieldId }) => !requiredFieldIds.includes(fieldId))
  ) return denied("completion_unverified");
  const verifiedRequiredFieldCount = requiredFieldIds.filter((fieldId) => {
    const results = request.verification.filter(
      (result) => result.fieldId === fieldId,
    );
    return results.length === 1 && results[0]?.kind === "verified";
  }).length;
  if (verifiedRequiredFieldCount !== requiredFieldIds.length) {
    return denied("completion_unverified");
  }

  const { reviewRoot, activeStep, finalSubmit } = request.structure;
  if (reviewRoot.count === 0 || activeStep.count === 0) {
    return denied("review_signature_missing");
  }
  if (reviewRoot.count !== 1 || activeStep.count !== 1) {
    return denied("review_signature_ambiguous");
  }
  if (!reviewRoot.visible || !activeStep.visible) {
    return denied("review_not_visible");
  }
  if (request.structure.validationErrorCount !== 0) {
    return denied("completion_unverified");
  }
  if (finalSubmit.count === 0) return denied("submit_signature_missing");
  if (finalSubmit.count !== 1) return denied("submit_signature_ambiguous");
  if (!finalSubmit.visible) return denied("submit_not_visible");
  if (
    request.state.status !== "running" ||
    request.state.pageId !== request.pageId
  ) return denied("state_mismatch");

  return Object.freeze({
    kind: "review_confirmed",
    proof: Object.freeze({
      schemaVersion: 1,
      page: "review",
      requiredFieldCount: requiredFieldIds.length,
      verifiedRequiredFieldCount,
      validationErrorCount: request.structure.validationErrorCount,
      finalSubmit: Object.freeze({
        present: true,
        visible: true,
        enabled: finalSubmit.enabled,
      }),
    }),
    transition: Object.freeze({
      journeyId: request.state.journeyId,
      operationId: request.operationId,
      expectedRevision: request.state.revision,
      status: "review_reached",
      pageId: request.pageId,
    }),
  });
}

function denied(reason: ReviewStopDenialReason): ReviewStopResult {
  return Object.freeze({ kind: "review_denied", reason });
}
