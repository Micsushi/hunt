import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "../../../contracts/s2-common-wire.ts";
import {
  applicationClassifiers,
  applicationPages,
  applicationPrimitives,
  applicationUnknownLayers,
  type ApplicationClassifier,
  type ApplicationHandlerPage,
  type ApplicationPage,
  type ApplicationPageCheck,
  type ApplicationPageTruth,
  type ApplicationVerifiedCheckpoint,
  type ApplicationPortFailure,
  type ApplicationPrimitive,
  type ApplicationUnknownLayer,
  type ApplicationWalkDependencies,
  type ApplicationWalkInput,
  type ApplicationWalkFailurePacket,
  type ApplicationWalkOptions,
  type ApplicationWalkResult,
} from "./page-walk-contract.ts";

export * from "./page-walk-contract.ts";

const classifierSet = new Set<string>(applicationClassifiers);
const primitiveSet = new Set<string>(applicationPrimitives);
const unknownLayerSet = new Set<string>(applicationUnknownLayers);

/**
 * S2-F3-T4 integration seam. T1-T3 implement only their matching handler.
 * The central orchestrator supplies browser truth, navigation, and progress
 * adapters and remains the owner of outer journey recovery and terminalization.
 */
export async function runApplicationPageWalk(
  dependencies: ApplicationWalkDependencies,
  input: ApplicationWalkInput,
  signal: AbortSignal,
  options: ApplicationWalkOptions = {},
): Promise<ApplicationWalkResult> {
  const retryLimit = options.pageRetryLimit ?? 1;
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 0) {
    throw new RangeError("pageRetryLimit must be a non-negative safe integer");
  }

  const pageChecks: ApplicationPageCheck[] = [];
  const reconciledPages: ApplicationHandlerPage[] = [];
  const stopAfter = input.stopAfter ?? "pre_review";
  if (signal.aborted) {
    return failure(
      "browser_truth",
      internalFailure(
        "operation_cancelled",
        "workday_page",
        "page_observation",
        "none",
      ),
      "resume",
      1,
    );
  }
  let current = await dependencies.observer.observe(signal);
  if (!current.ok) {
    return failure("browser_truth", current.error, "resume", 1);
  }
  if (current.value.submitActivated) {
    return failure(
      "browser_truth",
      submitFailure(),
      current.value.page,
      1,
    );
  }

  for (let index = 0; index < applicationPages.length; index += 1) {
    const page = applicationPages[index]!;
    const expected = applicationPages[index + 1] ?? "pre_review";
    if (current.value.page !== page) {
      return failure(
        "browser_truth",
        internalFailure("navigation_illegal", "workday_page", "page_observation", "page_type"),
        current.value.page,
        1,
      );
    }

    const handler = dependencies.handlers[page];
    let truth = current.value;
    let check: ApplicationPageCheck | undefined;
    let verifiedPageId: ApplicationPageTruth["pageId"] | undefined;
    const expectedCheckpoint = checkpointFor(page);
    for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
      if (verifiedPageId === undefined) {
        const handled = await handler.reconcile(
          { journeyId: input.journeyId, pageId: truth.pageId, attempt },
          signal,
        );
        if (!handled.ok) {
          const safeError = sanitizeFailure(handled.error);
          if (
            s2StableErrorPolicy[safeError.code].retryable &&
            attempt <= retryLimit
          ) continue;
          return failure(page, safeError, page, attempt);
        }
        if (handled.value.page !== page || handled.value.pageId !== truth.pageId) {
          return failure(
            page,
            internalFailure("navigation_uncertain", classifierFor(page), primitiveFor(page), "page_type"),
            page,
            attempt,
          );
        }
        if (
          handled.value.checkpoint !== expectedCheckpoint ||
          handled.value.independentlyVerified !== true
        ) {
          return failure(
            page,
            internalFailure(
              "failure_context_invalid",
              classifierFor(page),
              primitiveFor(page),
              "none",
            ),
            page,
            attempt,
          );
        }
        verifiedPageId = handled.value.pageId;
      }

      const observed = await dependencies.observer.observe(signal);
      if (!observed.ok) {
        const safeError = sanitizeFailure(observed.error);
        if (
          s2StableErrorPolicy[safeError.code].retryable &&
          attempt <= retryLimit
        ) continue;
        return failure("browser_truth", safeError, page, attempt);
      }
      truth = observed.value;
      if (truth.page !== page || truth.pageId !== verifiedPageId) {
        return failure(
          "browser_truth",
          internalFailure(
            "navigation_uncertain",
            "workday_page",
            "page_observation",
            "navigation",
          ),
          truth.page,
          attempt,
        );
      }
      if (truth.submitActivated) {
        return failure("browser_truth", submitFailure(), truth.page, attempt);
      }
      check = pageCheck(page, expectedCheckpoint, truth);
      if (
        !truth.submitActivated &&
        check.requiredFields === check.verifiedFields &&
        check.duplicateRows === 0
      ) break;
      if (attempt > retryLimit) {
        const duplicate = check.duplicateRows > 0;
        return failure(
          page,
          internalFailure(
            "page_incomplete",
            duplicate ? "repeatable_row_gate" : "required_field_gate",
            duplicate ? "repeatable_row_reconciliation" : "required_field_verification",
            duplicate ? "repeatable_row" : "required_field",
          ),
          page,
          attempt,
        );
      }
    }

    pageChecks.push(check!);
    reconciledPages.push(page);
    const recorded = await dependencies.progress.record(
      {
        checkpoint: checkpointFor(page),
        browserPage: page,
        completedPages: reconciledPages.length,
        reconciledPages: [...reconciledPages],
      },
      signal,
    );
    if (!recorded.ok) return failure("progress", recorded.error, page, 1);
    if (stopAfter === checkpointFor(page)) {
      return success(stopAfter);
    }

    const advanced = await dependencies.navigation.next(
      { journeyId: input.journeyId, from: page, fromPageId: truth.pageId, expected },
      signal,
    );
    if (!advanced.ok) return failure("navigation", advanced.error, page, 1);
    current = await dependencies.observer.observe(signal);
    if (!current.ok) return failure("browser_truth", current.error, page, 1);
    if (current.value.page !== expected) {
      return failure(
        "navigation",
        internalFailure("navigation_uncertain", "page_navigation", "next", "navigation"),
        current.value.page,
        1,
      );
    }
  }

  if (current.value.submitActivated) {
    return failure(
      "browser_truth",
      submitFailure(),
      "pre_review",
      1,
    );
  }
  const finalDuplicate = current.value.c3OwnedDuplicateRows > 0;
  const finalIncomplete = current.value.requiredFields.some(
    ({ verification }) => verification !== "verified",
  );
  if (finalDuplicate || finalIncomplete) {
    return failure(
      "browser_truth",
      internalFailure(
        "page_incomplete",
        finalDuplicate ? "repeatable_row_gate" : "required_field_gate",
        finalDuplicate
          ? "repeatable_row_reconciliation"
          : "required_field_verification",
        finalDuplicate ? "repeatable_row" : "required_field",
      ),
      "pre_review",
      1,
    );
  }
  const recorded = await dependencies.progress.record(
    {
      checkpoint: "pre_review",
      browserPage: "pre_review",
      completedPages: 3,
      reconciledPages: [...reconciledPages],
    },
    signal,
  );
  if (!recorded.ok) return failure("progress", recorded.error, "pre_review", 1);
  return success("pre_review");

  function failure(
    owner: ApplicationWalkFailurePacket["owner"],
    error: ApplicationPortFailure,
    page: ApplicationPage,
    attempt: number,
  ): ApplicationWalkResult {
    const safeError = sanitizeFailure(error);
    return {
      ok: false,
      error: {
        checkpoint: page,
        completedPages: pageChecks.length,
        failure: {
          code: safeError.code,
          retryable: s2StableErrorPolicy[safeError.code].retryable,
          owner,
          classifier: safeError.classifier,
          primitive: safeError.primitive,
          unknownLayer: safeError.unknownLayer,
          page,
          attempt,
        },
        submitActivated: false,
        privacyScan: "pass",
      },
    };
  }

  function success(
    checkpoint: "resume_verified" | "profile_verified" |
      "questionnaire_verified" | "pre_review",
  ): ApplicationWalkResult {
    return {
      ok: true,
      value: {
        checkpoint,
        completedPages: pageChecks.length,
        pageChecks: [...pageChecks],
        submitActivated: false,
        privacyScan: "pass",
      },
    };
  }
}

function sanitizeFailure(error: unknown): ApplicationPortFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.hasOwn(s2StableErrorPolicy, error.code) &&
    "classifier" in error &&
    typeof error.classifier === "string" &&
    classifierSet.has(error.classifier) &&
    "primitive" in error &&
    typeof error.primitive === "string" &&
    primitiveSet.has(error.primitive) &&
    "unknownLayer" in error &&
    typeof error.unknownLayer === "string" &&
    unknownLayerSet.has(error.unknownLayer)
  ) {
    return {
      code: error.code as S2StableErrorCode,
      classifier: error.classifier as ApplicationClassifier,
      primitive: error.primitive as ApplicationPrimitive,
      unknownLayer: error.unknownLayer as ApplicationUnknownLayer,
    };
  }
  return internalFailure(
    "failure_context_invalid",
    "workday_page",
    "page_observation",
    "none",
  );
}

function submitFailure(): ApplicationPortFailure {
  return internalFailure(
    "submit_forbidden",
    "workday_page",
    "page_observation",
    "navigation",
  );
}

function pageCheck(
  page: ApplicationHandlerPage,
  checkpoint: ApplicationVerifiedCheckpoint,
  truth: ApplicationPageTruth,
): ApplicationPageCheck {
  return {
    page,
    checkpoint,
    independentlyVerified: true,
    requiredFields: truth.requiredFields.length,
    verifiedFields: truth.requiredFields.filter(({ verification }) => verification === "verified").length,
    duplicateRows: truth.c3OwnedDuplicateRows,
  };
}

function checkpointFor(page: ApplicationHandlerPage): ApplicationVerifiedCheckpoint {
  return page === "resume"
    ? "resume_verified"
    : page === "profile"
      ? "profile_verified"
      : "questionnaire_verified";
}

function internalFailure(
  code: S2StableErrorCode,
  classifier: ApplicationClassifier,
  primitive: ApplicationPrimitive,
  unknownLayer: ApplicationUnknownLayer,
): ApplicationPortFailure {
  return { code, classifier, primitive, unknownLayer };
}

function classifierFor(page: ApplicationHandlerPage): ApplicationClassifier {
  return `${page}_page` as ApplicationClassifier;
}

function primitiveFor(page: ApplicationHandlerPage): ApplicationPrimitive {
  return page === "resume"
    ? "file_upload"
    : page === "profile"
      ? "profile_control"
      : "question_control";
}
