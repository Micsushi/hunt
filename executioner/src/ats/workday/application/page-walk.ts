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

  const resume = options.resume;
  const pageChecks: ApplicationPageCheck[] = resume === undefined
    ? []
    : [...resume.pageChecks];
  const reconciledPages: ApplicationHandlerPage[] = pageChecks.map(({ page }) => page);
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

  let startIndex = 0;
  if (resume !== undefined) {
    const resumed = validateResume(resume.currentPage, pageChecks, current.value);
    if (!resumed.ok) {
      return failure("browser_truth", resumed.error, current.value.page, 1);
    }
    startIndex = resumed.startIndex;
    if (resume.currentPage !== "pre_review") {
      const from = applicationPages[startIndex - 1]!;
      const expected = applicationPages[startIndex] ?? "pre_review";
      const advanced = await dependencies.navigation.next(
        { journeyId: input.journeyId, from, fromPageId: current.value.pageId, expected },
        signal,
      );
      if (!advanced.ok) return failure("navigation", advanced.error, current.value.page, 1);
      current = await dependencies.observer.observe(signal);
      if (!current.ok) return failure("browser_truth", current.error, expected, 1);
      if (current.value.page !== expected || current.value.submitActivated) {
        return failure(
          "navigation",
          current.value.submitActivated ? submitFailure() : internalFailure(
            "navigation_uncertain", "page_navigation", "next", "navigation",
          ),
          current.value.page,
          1,
        );
      }
    }
  }

  for (let index = startIndex; index < applicationPages.length; index += 1) {
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
        pageChecks: [...pageChecks],
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
      pageChecks: [...pageChecks],
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

function validateResume(
  currentPage: Exclude<ApplicationPage, "resume">,
  checks: readonly ApplicationPageCheck[],
  truth: ApplicationPageTruth,
): { readonly ok: true; readonly startIndex: number } | {
  readonly ok: false;
  readonly error: ApplicationPortFailure;
} {
  const expectedCount = currentPage === "profile" ? 2 : 3;
  if (truth.page !== currentPage || checks.length !== expectedCount) {
    return { ok: false, error: internalFailure(
      "recovery_state_ambiguous", "progress_projection", "record", "page_type",
    ) };
  }
  for (let index = 0; index < checks.length; index += 1) {
    const page = applicationPages[index];
    const check = checks[index];
    if (
      page === undefined || check === undefined || check.page !== page ||
      check.checkpoint !== checkpointFor(page) || check.independentlyVerified !== true ||
      !Number.isSafeInteger(check.requiredFields) || check.requiredFields < 0 ||
      check.verifiedFields !== check.requiredFields || check.duplicateRows !== 0
    ) return { ok: false, error: internalFailure(
      "recovery_state_ambiguous", "progress_projection", "record", "required_field",
    ) };
  }
  if (currentPage !== "pre_review") {
    const currentCheck = checks.at(-1)!;
    const observed = pageCheck(currentCheck.page, currentCheck.checkpoint, truth);
    if (
      observed.requiredFields !== currentCheck.requiredFields ||
      observed.verifiedFields !== currentCheck.verifiedFields ||
      observed.duplicateRows !== 0
    ) return { ok: false, error: internalFailure(
      "recovery_state_ambiguous", "progress_projection", "record", "required_field",
    ) };
  } else if (
    truth.requiredFields.some(({ verification }) => verification !== "verified") ||
    truth.c3OwnedDuplicateRows !== 0
  ) return { ok: false, error: internalFailure(
    "recovery_state_ambiguous", "progress_projection", "record", "required_field",
  ) };
  return { ok: true, startIndex: expectedCount };
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
