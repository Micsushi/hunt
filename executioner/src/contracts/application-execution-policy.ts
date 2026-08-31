export const browserTransports = ["live_browser", "fixture_browser"] as const;
export type BrowserTransport = (typeof browserTransports)[number];

export const answerFallbackPolicies = [
  "owner_facts_only",
  "deterministic_site_valid_editable",
] as const;
export type AnswerFallbackPolicy = (typeof answerFallbackPolicies)[number];

export const submissionPolicies = ["forbidden"] as const;
export type SubmissionPolicy = (typeof submissionPolicies)[number];

export const liveProofEligibilities = [
  "eligible",
  "ineligible_fixture_transport",
] as const;
export type LiveProofEligibility = (typeof liveProofEligibilities)[number];

export interface ApplicationExecutionPolicy {
  readonly browserTransport: BrowserTransport;
  readonly answerFallbackPolicy: AnswerFallbackPolicy;
  readonly submissionPolicy: SubmissionPolicy;
  readonly liveProofEligibility: LiveProofEligibility;
}

export function liveApplicationExecutionPolicy(
  answerMode: "live" | "synthetic_test_non_submittable",
): ApplicationExecutionPolicy {
  void answerMode;
  return Object.freeze({
    browserTransport: "live_browser" as const,
    answerFallbackPolicy: "deterministic_site_valid_editable" as const,
    submissionPolicy: "forbidden" as const,
    liveProofEligibility: "eligible" as const,
  });
}

export function fixtureApplicationExecutionPolicy(
  answerMode: "live" | "synthetic_test_non_submittable",
): ApplicationExecutionPolicy {
  return Object.freeze({
    ...liveApplicationExecutionPolicy(answerMode),
    browserTransport: "fixture_browser" as const,
    liveProofEligibility: "ineligible_fixture_transport" as const,
  });
}

export function admitApplicationExecutionPolicy(
  value: unknown,
): ApplicationExecutionPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  const policy = value as Record<string, unknown>;
  const keys = [
    "browserTransport", "answerFallbackPolicy", "submissionPolicy",
    "liveProofEligibility",
  ];
  if (Object.keys(policy).length !== keys.length ||
      keys.some((key, index) => Object.keys(policy)[index] !== key) ||
      !browserTransports.includes(policy.browserTransport as BrowserTransport) ||
      !answerFallbackPolicies.includes(policy.answerFallbackPolicy as AnswerFallbackPolicy) ||
      policy.submissionPolicy !== "forbidden" ||
      !liveProofEligibilities.includes(policy.liveProofEligibility as LiveProofEligibility) ||
      (policy.browserTransport === "fixture_browser") !==
        (policy.liveProofEligibility === "ineligible_fixture_transport")) denied();
  return Object.freeze({
    browserTransport: policy.browserTransport as BrowserTransport,
    answerFallbackPolicy: policy.answerFallbackPolicy as AnswerFallbackPolicy,
    submissionPolicy: "forbidden" as const,
    liveProofEligibility: policy.liveProofEligibility as LiveProofEligibility,
  });
}

export function answerModeAllowedByPolicy(
  policy: Pick<ApplicationExecutionPolicy, "answerFallbackPolicy">,
  mode: "live" | "synthetic_test_non_submittable",
): boolean {
  return mode === "live" || policy.answerFallbackPolicy === "deterministic_site_valid_editable";
}

function denied(): never {
  throw new TypeError("application execution policy denied");
}
