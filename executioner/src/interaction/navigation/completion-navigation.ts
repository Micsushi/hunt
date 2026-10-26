import type {
  CompletionNavigation,
  NavigationReconciliationRequest,
  NavigationResult,
} from "../../contracts/index.ts";
import { completePage } from "../completion/page-completion.ts";

const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;

const semanticPredecessor = {
  profile: "account",
  questionnaire: "profile",
  review: "questionnaire",
} as const;

function reconcile(
  request: NavigationReconciliationRequest,
): NavigationResult | undefined {
  if (
    request.operationId !== request.observation.operationId ||
    request.expected.kind !== "workday"
  ) {
    return undefined;
  }

  if (request.decision.kind === "stop_review") {
    return request.sourcePage.kind === "workday" &&
      request.sourcePage.page === "review" &&
      request.expected.page === "review" &&
      request.observed.kind === "workday" &&
      request.observed.page === "review" &&
      request.observation.fromPageId === request.observation.pageId
      ? {
          kind: "review_reached",
          expected: request.expected,
          observed: request.observed,
        }
      : undefined;
  }

  if (
    request.decision.expectedPage !== request.expected.page ||
    request.sourcePage.kind !== "workday" ||
    request.sourcePage.page !== semanticPredecessor[request.expected.page]
  ) {
    return undefined;
  }
  if (
    request.observation.fromPageId === request.observation.pageId ||
    request.observed.kind !== "workday"
  ) {
    return {
      kind: "uncertain",
      expected: request.expected,
      observed: request.observed,
    };
  }
  if (request.observed.page !== request.expected.page) {
    return {
      kind: "illegal_transition",
      expected: request.expected,
      observed: request.observed,
    };
  }
  return {
    kind: request.expected.page === "review" ? "review_reached" : "advanced",
    expected: request.expected,
    observed: request.observed,
  };
}

export function createCompletionNavigation(): CompletionNavigation {
  return {
    async complete(request, signal) {
      return signal.aborted
        ? cancelled
        : { ok: true, value: completePage(request) };
    },
    async reconcile(request, signal) {
      if (signal.aborted) {
        return cancelled;
      }
      const result = reconcile(request);
      return result === undefined
        ? {
            ok: false,
            error: {
              code: "navigation_illegal",
              retryable: false,
            },
          }
        : { ok: true, value: result };
    },
  };
}
