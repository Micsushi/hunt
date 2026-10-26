import type {
  ApprovedNavigationDecision,
  PageCompletionRequest,
  PageCompletionResult,
  PageIdentity,
} from "../../contracts/index.ts";

const transitions = {
  account: { kind: "next", expectedPage: "profile" },
  profile: { kind: "next", expectedPage: "questionnaire" },
  questionnaire: { kind: "next", expectedPage: "review" },
  review: { kind: "stop_review" },
} as const satisfies Record<
  Extract<PageIdentity, { readonly kind: "workday" }>["page"],
  ApprovedNavigationDecision
>;

export function completePage(
  request: PageCompletionRequest,
): PageCompletionResult {
  if (
    request.page.pageIdentity.kind === "workday" &&
    request.page.pageIdentity.page === "review"
  ) {
    return {
      kind: "complete",
      decision: transitions.review,
    };
  }

  const fieldIds = request.page.fields
    .filter(({ required }) => required)
    .map(({ fieldId }) => fieldId)
    .filter((fieldId, index, all) => all.indexOf(fieldId) === index)
    .filter((fieldId) => {
      const results = request.verification.filter(
        (result) => result.fieldId === fieldId,
      );
      return results.length !== 1 || results[0]?.kind !== "verified";
    });

  if (fieldIds.length > 0 || request.page.pageIdentity.kind !== "workday") {
    return {
      kind: "blocked",
      fieldIds,
      decision: { kind: "blocked" },
    };
  }

  return {
    kind: "complete",
    decision: transitions[request.page.pageIdentity.page],
  };
}
