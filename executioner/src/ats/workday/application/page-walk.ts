import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "../../../contracts/s2-common-wire.ts";
import {
  applicationClassifiers,
  applicationNextPages,
  applicationPages,
  applicationPrimitives,
  applicationUnknownLayers,
  checkpointForApplicationPage,
  isAllowedApplicationTransition,
  isValidApplicationPageSequence,
  maximumApplicationPageVisits,
  type ApplicationClassifier,
  type ApplicationHandlerPage,
  type ApplicationPage,
  type ApplicationPageCheck,
  type ApplicationPageTruth,
  type ApplicationPortResult,
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
const navigationLoadingShellTimeoutMs = 60_000;
const transientDestinationObservationCodes = new Set([
  "browser_target_ambiguous",
  "browser_target_stale",
  "browser_effect_uncertain",
]);

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
      applicationPages[0],
      1,
    );
  }
  let current: ApplicationPortResult<ApplicationPageTruth> =
    await dependencies.observer.observe(signal);
  if (!current.ok) {
    return failure("browser_truth", current.error, applicationPages[0], 1);
  }
  if (current.value.submitActivated) {
    return failure(
      "browser_truth",
      submitFailure(),
      current.value.page,
      1,
    );
  }

  let recoveryLanePrefix: number | undefined;
  if (resume !== undefined) {
    const resumed = validateResume(
      resume.currentPage,
      resume.currentLanes,
      pageChecks,
      current.value,
    );
    if (!resumed.ok) {
      return failure("browser_truth", resumed.error, current.value.page, 1);
    }
    recoveryLanePrefix = resumed.processedLanes;
    if (resumed.advanceFromVerifiedCurrent) {
      const from = current.value.page;
      const routeFrom = reconciledPages.at(-1);
      if (from === "pre_review" || routeFrom === undefined) {
        return failure("browser_truth", internalFailure(
          "recovery_state_ambiguous", "progress_projection", "record", "page_type",
        ), from, 1);
      }
      const advanced = await dependencies.navigation.next(
        {
          journeyId: input.journeyId,
          from,
          fromPageId: current.value.pageId,
          allowed: allowedDestinations(routeFrom, reconciledPages),
        },
        signal,
      );
      if (!advanced.ok) return failure("navigation", advanced.error, current.value.page, 1);
      current = advanced.value.destination === undefined
        ? await observeDestination(dependencies, from, signal)
        : { ok: true, value: advanced.value.destination };
      if (!current.ok) return failure("browser_truth", current.error, from, 1);
      if (
        current.value.submitActivated ||
        !isAllowedApplicationTransition(routeFrom, current.value.page, reconciledPages)
      ) {
        return failure(
          "navigation",
          current.value.submitActivated ? submitFailure() : internalFailure(
            "navigation_uncertain", "page_navigation", "next", "navigation",
          ),
          current.value.page,
          1,
        );
      }
      recoveryLanePrefix = undefined;
    }
  }

  while (current.value.page !== "pre_review") {
    const physicalPage: ApplicationPage = current.value.page;
    const lanes = observedLanes(current.value);
    if (lanes === undefined || !applicationPages.includes(physicalPage)) return failure(
      "browser_truth",
      internalFailure("navigation_illegal", "workday_page", "page_observation", "page_type"),
      physicalPage,
      1,
    );
    const processed = recoveryLanePrefix ?? 0;
    recoveryLanePrefix = undefined;
    if (!isValidApplicationPageSequence([
      ...reconciledPages,
      ...lanes.slice(processed),
    ])) return failure("browser_truth", internalFailure(
      "navigation_illegal", "progress_projection", "record", "navigation",
    ), physicalPage, 1);
    let truth: ApplicationPageTruth = current.value;
    for (const lane of lanes.slice(processed)) {
      if (pageChecks.length >= maximumApplicationPageVisits) return failure(
        "browser_truth",
        internalFailure("navigation_illegal", "progress_projection", "record", "navigation"),
        physicalPage,
        1,
      );
      const handler = dependencies.handlers[lane];
      let check: ApplicationPageCheck | undefined;
      let verifiedPageId: ApplicationPageTruth["pageId"] | undefined;
      const expectedCheckpoint = checkpointForApplicationPage(lane);
      for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
        if (verifiedPageId === undefined) {
          const handled = await handler.reconcile(
            { journeyId: input.journeyId, pageId: truth.pageId, attempt }, signal,
          );
          if (!handled.ok) {
            const safeError = sanitizeFailure(handled.error);
            if (s2StableErrorPolicy[safeError.code].retryable && attempt <= retryLimit) continue;
            return failure(lane, safeError, physicalPage, attempt);
          }
          if (handled.value.page !== lane || handled.value.pageId !== truth.pageId) {
            return failure(lane, internalFailure(
              "navigation_uncertain", classifierFor(lane), primitiveFor(lane), "page_type",
            ), physicalPage, attempt);
          }
          if (handled.value.checkpoint !== expectedCheckpoint ||
              handled.value.independentlyVerified !== true) {
            return failure(lane, internalFailure(
              "failure_context_invalid", classifierFor(lane), primitiveFor(lane), "none",
            ), physicalPage, attempt);
          }
          verifiedPageId = handled.value.pageId;
        }
        const observed = await dependencies.observer.observe(signal);
        if (!observed.ok) {
          const safeError = sanitizeFailure(observed.error);
          if (s2StableErrorPolicy[safeError.code].retryable && attempt <= retryLimit) continue;
          return failure("browser_truth", safeError, physicalPage, attempt);
        }
        truth = observed.value;
        if (truth.page !== physicalPage || truth.pageId !== verifiedPageId ||
            !samePages(observedLanes(truth), lanes)) {
          return failure("browser_truth", internalFailure(
            "navigation_uncertain", "workday_page", "page_observation", "navigation",
          ), truth.page, attempt);
        }
        if (truth.submitActivated) return failure(
          "browser_truth", submitFailure(), truth.page, attempt,
        );
        check = pageCheck(lane, expectedCheckpoint, truth);
        if (check.requiredFields === check.verifiedFields && check.duplicateRows === 0) break;
        if (attempt > retryLimit) {
          const duplicate = check.duplicateRows > 0;
          return failure(lane, internalFailure(
            "page_incomplete",
            duplicate ? "repeatable_row_gate" : "required_field_gate",
            duplicate ? "repeatable_row_reconciliation" : "required_field_verification",
            duplicate ? "repeatable_row" : "required_field",
          ), physicalPage, attempt);
        }
      }
      pageChecks.push(check!);
      reconciledPages.push(lane);
      const recorded = await dependencies.progress.record({
        checkpoint: expectedCheckpoint,
        browserPage: physicalPage,
        browserLanes: lanes,
        completedPages: reconciledPages.length,
        reconciledPages: [...reconciledPages],
        pageChecks: [...pageChecks],
      }, signal);
      if (!recorded.ok) return failure("progress", recorded.error, physicalPage, 1);
      if (stopAfter === expectedCheckpoint) return success(stopAfter);
    }

    const routeFrom = reconciledPages.at(-1)!;
    const allowed = allowedDestinations(routeFrom, reconciledPages);
    const advanced = await dependencies.navigation.next(
      { journeyId: input.journeyId, from: physicalPage, fromPageId: truth.pageId, allowed },
      signal,
    );
    if (!advanced.ok) return failure("navigation", advanced.error, physicalPage, 1);
    current = advanced.value.destination === undefined
      ? await observeDestination(dependencies, physicalPage, signal)
      : { ok: true, value: advanced.value.destination };
    if (!current.ok) return failure("browser_truth", current.error, physicalPage, 1);
    if (
      current.value.submitActivated ||
      !isAllowedApplicationTransition(routeFrom, current.value.page, reconciledPages)
    ) {
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
      browserLanes: [],
      completedPages: pageChecks.length,
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
          ...(safeError.placeholderProvenance === undefined
            ? {}
            : {
                protectedPlaceholderCount: safeError.protectedPlaceholderCount,
                placeholderProvenance: safeError.placeholderProvenance,
              }),
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

async function observeDestination(
  dependencies: ApplicationWalkDependencies,
  from: ApplicationHandlerPage,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<ApplicationWalkDependencies["observer"]["observe"]>>> {
  const deadline = Date.now() + navigationLoadingShellTimeoutMs;
  while (true) {
    const observed = await dependencies.observer.observe(signal);
    if (!observed.ok) {
      const loadingObservation = transientDestinationObservationCodes.has(
        observed.error.code,
      );
      if (loadingObservation && !signal.aborted && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      return observed;
    }
    if (observed.value.submitActivated) return observed;
    const loadingShell = observed.value.page === from &&
      observed.value.requiredFields.length === 0;
    if (loadingShell && !signal.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      continue;
    }
    return observed;
  }
}

function validateResume(
  currentPage: ApplicationPage,
  currentLanes: readonly ApplicationHandlerPage[] | undefined,
  checks: readonly ApplicationPageCheck[],
  truth: ApplicationPageTruth,
): {
  readonly ok: true;
  readonly advanceFromVerifiedCurrent: boolean;
  readonly processedLanes: number;
} | {
  readonly ok: false;
  readonly error: ApplicationPortFailure;
} {
  const lanes = observedLanes(truth);
  if (
    truth.page !== currentPage || lanes === undefined ||
    (currentLanes !== undefined && !samePages(currentLanes, lanes)) ||
    !isValidApplicationPageSequence(checks.map(({ page }) => page))
  ) {
    return { ok: false, error: internalFailure(
      "recovery_state_ambiguous", "progress_projection", "record", "page_type",
    ) };
  }
  for (const check of checks) {
    if (
      check.checkpoint !== checkpointForApplicationPage(check.page) ||
      check.independentlyVerified !== true ||
      !Number.isSafeInteger(check.requiredFields) || check.requiredFields < 0 ||
      check.verifiedFields !== check.requiredFields || check.duplicateRows !== 0
    ) return { ok: false, error: internalFailure(
      "recovery_state_ambiguous", "progress_projection", "record", "required_field",
    ) };
  }
  const pages = checks.map(({ page }) => page);
  const previous = pages.at(-1);
  const processed = currentPage === "pre_review" ? 0 : processedLaneCount(pages, lanes);
  if (!isValidApplicationPageSequence([...pages, ...lanes.slice(processed)])) {
    return { ok: false, error: internalFailure(
      "recovery_state_ambiguous", "progress_projection", "record", "page_type",
    ) };
  }
  const currentVerified = currentPage !== "pre_review" &&
    processed === lanes.length && processed > 0;
  const browserAdvancedCurrent = currentPage !== "pre_review" && (
    processed > 0 || previous === undefined ||
    isAllowedApplicationTransition(previous, lanes[0]!, pages)
  );
  const reviewAdvanced = currentPage === "pre_review" && (
    previous === undefined || isAllowedApplicationTransition(
      previous,
      "pre_review",
      pages,
    )
  );
  if (!currentVerified && !browserAdvancedCurrent && !reviewAdvanced) {
    return { ok: false, error: internalFailure(
      "recovery_state_ambiguous", "progress_projection", "record", "page_type",
    ) };
  }
  if (processed > 0) {
    for (const check of checks.slice(-processed)) {
      const observed = pageCheck(check.page, check.checkpoint, truth);
      if (observed.requiredFields !== check.requiredFields ||
          observed.verifiedFields !== check.verifiedFields || observed.duplicateRows !== 0) {
        return { ok: false, error: internalFailure(
          "recovery_state_ambiguous", "progress_projection", "record", "required_field",
        ) };
      }
    }
  }
  return {
    ok: true,
    advanceFromVerifiedCurrent: currentVerified,
    processedLanes: processed,
  };
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
    const failureRecord = error as Record<string, unknown>;
    const hasPlaceholderCount = "protectedPlaceholderCount" in error;
    const hasPlaceholderProvenance = "placeholderProvenance" in error;
    if (
      hasPlaceholderCount !== hasPlaceholderProvenance ||
      (hasPlaceholderCount && (
        (failureRecord.protectedPlaceholderCount !== 0 &&
          failureRecord.protectedPlaceholderCount !== 1) ||
        failureRecord.placeholderProvenance !== "synthetic_ui_learning"
      ))
    ) return internalFailure(
      "failure_context_invalid",
      "workday_page",
      "page_observation",
      "none",
    );
    return {
      code: error.code as S2StableErrorCode,
      classifier: error.classifier as ApplicationClassifier,
      primitive: error.primitive as ApplicationPrimitive,
      unknownLayer: error.unknownLayer as ApplicationUnknownLayer,
      ...(hasPlaceholderCount
        ? {
            protectedPlaceholderCount: failureRecord.protectedPlaceholderCount as 0 | 1,
            placeholderProvenance: "synthetic_ui_learning" as const,
          }
        : {}),
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
  const requiredFields = truth.requiredFields.filter((field) =>
    (field.page ?? truth.page) === page
  );
  return {
    page,
    checkpoint,
    independentlyVerified: true,
    requiredFields: requiredFields.length,
    verifiedFields: requiredFields.filter(({ verification }) => verification === "verified").length,
    duplicateRows: page === "resume" && truth.page === "resume" &&
        truth.lanes?.includes("profile") === true
      ? 0
      : truth.c3OwnedDuplicateRows,
  };
}

function observedLanes(
  truth: ApplicationPageTruth,
): readonly ApplicationHandlerPage[] | undefined {
  if (truth.page === "pre_review") {
    return truth.lanes === undefined || truth.lanes.length === 0 ? [] : undefined;
  }
  const lanes = truth.lanes ?? [truth.page];
  if (lanes.length < 1 || lanes.length > 2 || lanes[0] !== truth.page) return undefined;
  if (lanes.length === 2 && (lanes[0] !== "resume" || lanes[1] !== "profile")) {
    return undefined;
  }
  return new Set(lanes).size === lanes.length ? lanes : undefined;
}

function processedLaneCount(
  reconciled: readonly ApplicationHandlerPage[],
  lanes: readonly ApplicationHandlerPage[],
): number {
  for (let count = lanes.length; count > 0; count -= 1) {
    if (samePages(reconciled.slice(-count), lanes.slice(0, count))) return count;
  }
  return 0;
}

function samePages(
  left: readonly ApplicationHandlerPage[] | undefined,
  right: readonly ApplicationHandlerPage[],
): boolean {
  return left !== undefined && left.length === right.length &&
    left.every((page, index) => page === right[index]);
}

function allowedDestinations(
  from: ApplicationHandlerPage,
  visited: readonly ApplicationHandlerPage[],
): readonly ApplicationPage[] {
  return applicationNextPages(from).filter((page) =>
    isAllowedApplicationTransition(from, page, visited)
  );
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
