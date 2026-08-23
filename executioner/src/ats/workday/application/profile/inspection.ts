import type {
  ProfileInspectionClassification,
  ProfileInspectionDiagnostic,
  ProfileInspectionFailure,
  ProfileInspectionPhase,
  ProfileInspectionFacts,
  ProfileCleanupState,
  ProfilePreservationReason,
  ProfileSessionState,
} from "./types.ts";

const livenessFailure = /(?:browser|context|page|target).*(?:closed|destroyed)|execution context was destroyed/iu;
const bindingFailure = /(?:binding|control|element|locator|owner|profile|repeatable|row|selector).*(?:ambiguous|missing|stale|unavailable|visible|invalid|denied)|(?:ambiguous|missing|stale|unavailable).*(?:binding|control|element|locator|owner|profile|repeatable|row|selector)/iu;

export function classifyProfileInspectionFailure(
  error: unknown,
): ProfileInspectionClassification {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "";
  if (livenessFailure.test(message)) return "liveness";
  if (bindingFailure.test(message)) return "dom_owner_binding";
  return "unknown";
}

export function createProfileInspectionFailure(
  error: unknown,
  phase: ProfileInspectionPhase,
  bindingIds: readonly string[],
  bindingPaths: readonly string[],
  digestInputs: readonly string[],
  digest: (value: string) => string,
  facts?: ProfileInspectionFacts,
): Error {
  const failure: ProfileInspectionFailure = Object.freeze({
    classification: classifyProfileInspectionFailure(error),
    phase,
    bindingIds: Object.freeze([...bindingIds]),
    bindingPaths: Object.freeze([...bindingPaths]),
    bindingDigests: Object.freeze(digestInputs.map(digest)),
    ...(facts ?? {}),
  });
  const wrapped = new TypeError("profile inspection failed");
  Object.defineProperty(wrapped, "profileInspectionFailure", {
    configurable: false,
    enumerable: false,
    value: failure,
    writable: false,
  });
  return wrapped;
}

export function profileInspectionTraceDetails(
  diagnostic: ProfileInspectionDiagnostic,
  context?: {
    readonly sessionState?: ProfileSessionState;
    readonly cleanupState?: ProfileCleanupState;
    readonly preservationEligible?: boolean;
    readonly preservationReason?: ProfilePreservationReason;
    readonly continueAllowed?: false;
  },
): Readonly<Record<string, unknown>> {
  const details: Record<string, unknown> = {
    profileInspectionClassification: diagnostic.classification,
    profileInspectionPhase: diagnostic.phase,
    profileInspectionRetryCount: diagnostic.retryCount,
    profileInspectionDeadlineMs: diagnostic.deadlineMs,
    profileInspectionElapsedMs: diagnostic.elapsedMs,
    profileInspectionBindingIds: diagnostic.bindingIds,
    profileInspectionBindingPaths: diagnostic.bindingPaths,
    profileInspectionBindingDigests: diagnostic.bindingDigests,
  };
  const optional = {
    profileInspectionAttemptCount: diagnostic.attemptCount,
    profileInspectionDeadlineOutcome: diagnostic.deadlineOutcome,
    profileInspectionFrameCount: diagnostic.frameCount,
    profileInspectionFrameIdentityDigests: diagnostic.frameIdentityDigests,
    profileInspectionFrameDomOwnerCandidateCounts: diagnostic.frameDomOwnerCandidateCounts,
    profileInspectionFrameControlCandidateCounts: diagnostic.frameControlCandidateCounts,
    profileInspectionFrameOwnerControlRelationshipDigests:
      diagnostic.frameOwnerControlRelationshipDigests,
    profileInspectionStructuralIdentityDigest: diagnostic.structuralIdentityDigest,
    profileInspectionProfileRootCandidateCount: diagnostic.profileRootCandidateCount,
    profileInspectionProfileRootVisibleCount: diagnostic.profileRootVisibleCount,
    profileInspectionDomOwnerCandidateCount: diagnostic.domOwnerCandidateCount,
    profileInspectionControlCandidateCount: diagnostic.controlCandidateCount,
    profileInspectionControlIdDigests: diagnostic.controlIdDigests,
    profileInspectionSemanticIdDigests: diagnostic.semanticIdDigests,
    profileInspectionBindingDigest: diagnostic.bindingDigest,
    profileInspectionProfilePortState: diagnostic.profilePortState,
    profileInspectionSessionState: context?.sessionState ?? diagnostic.sessionState,
    profileInspectionCleanupState: context?.cleanupState ?? diagnostic.cleanupState,
    profileInspectionPreservationEligible:
      context?.preservationEligible ?? diagnostic.preservationEligible,
    profileInspectionPreservationReason:
      context?.preservationReason ?? diagnostic.preservationReason,
    profileInspectionContinueAllowed: context?.continueAllowed ?? diagnostic.continueAllowed,
  } as const;
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) details[key] = value;
  }
  return Object.freeze(details);
}

export function profileInspectionDiagnostic(
  error: unknown,
  failure: ProfileInspectionFailure | undefined,
  retryCount: number,
  deadlineMs: number,
  elapsedMs: number,
  deadlineOutcome?: "deadline_exceeded_before_return",
  facts?: ProfileInspectionFacts,
  preservation?: Pick<ProfileInspectionDiagnostic, "sessionState" | "cleanupState" |
    "preservationEligible" | "preservationReason" | "continueAllowed">,
): ProfileInspectionDiagnostic {
  const retained = failure ?? {
    classification: classifyProfileInspectionFailure(error),
    phase: "unknown" as const,
    bindingIds: [],
    bindingPaths: [],
    bindingDigests: [],
  };
  return Object.freeze({
    ...retained,
    retryCount,
    deadlineMs,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    ...(facts ?? {}),
    ...(deadlineOutcome === undefined ? {} : {
      attemptCount: retryCount,
      deadlineOutcome,
    }),
    ...(preservation ?? {}),
  });
}

export function profileInspectionFailureFromError(
  error: unknown,
): ProfileInspectionFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const failure = (error as { readonly profileInspectionFailure?: unknown })
    .profileInspectionFailure;
  if (typeof failure !== "object" || failure === null) return undefined;
  return failure as ProfileInspectionFailure;
}
