import {
  bindAdmissionRequest,
  providerError,
  type AnswerResolver,
  type BrowserPageId,
  type BrowserSession,
  type BrowserSessionId,
  type CompletionNavigation,
  type ComponentId,
  type FieldDriver,
  type FieldVerifier,
  type FactualTerminalOutcome,
  type GuardRevision,
  type JourneyId,
  type JourneyInputs,
  type OperationId,
  type OperationIdentityError,
  type PageIdentity,
  type PageUnderstanding,
  type PhaseId,
  type PortError,
  type PortResult,
  type SafetyGuard,
  type SemanticPageSnapshot,
  type StableErrorCode,
  type StepId,
  type VerificationResult,
} from "../../../contracts/index.ts";
import {
  boundedRetry,
  retryDisposition,
  sessionRecoveryDisposition,
} from "../recovery/policy.ts";
import { block, ClosedFactualOutcome, ClosedFailure, fail } from "./closed-outcomes.ts";

export interface PageLoopDependencies {
  readonly browser: BrowserSession;
  readonly understanding: PageUnderstanding;
  readonly answers: AnswerResolver;
  readonly driver: FieldDriver;
  readonly verifier: FieldVerifier;
  readonly completion: CompletionNavigation;
  readonly safety: SafetyGuard;
  readonly nextOperationId: () => PortResult<
    OperationId,
    OperationIdentityError
  >;
  readonly guardRevision: GuardRevision;
}

export interface PageLoopInput {
  readonly journeyId: JourneyId;
  readonly inputs: JourneyInputs;
  readonly sourceId: OperationId;
}

export interface PageLoopOptions {
  readonly pageLimit?: number;
  readonly mutationRetryLimit?: number;
  readonly providerRetryLimit?: number;
}

export interface PageLoopFailure {
  readonly error: PortError<StableErrorCode>;
  readonly component: ComponentId;
  readonly phase: PhaseId;
  readonly step: StepId;
  readonly sourceId: OperationId;
  readonly effect: "none" | "rejected" | "uncertain";
  readonly verificationKind?: Exclude<VerificationResult["kind"], "verified">;
  readonly sessionId?: BrowserSessionId;
}

export type PageLoopResult = PortResult<
  | {
      readonly kind: "review_candidate";
      readonly pageId: BrowserPageId;
      readonly completedPages: number;
      readonly sessionId: BrowserSessionId;
    }
  | {
      readonly kind: "blocked";
      readonly factualOutcome: FactualTerminalOutcome;
      readonly completedPages: number;
      readonly sessionId: BrowserSessionId;
      readonly component: "F5" | "F6" | "F8";
      readonly phase: "page_understanding" | "answer_resolution" | "verification";
      readonly step: "classify" | "resolve" | "verify";
      readonly sourceId: OperationId;
    },
  PageLoopFailure
>;

export async function runPageLoop(
  dependencies: PageLoopDependencies,
  input: PageLoopInput,
  signal: AbortSignal,
  options: PageLoopOptions = {},
): Promise<PageLoopResult> {
  const pageLimit = options.pageLimit ?? 25;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) {
    throw new RangeError("pageLimit must be a positive safe integer");
  }
  const mutationRetryLimit = boundedRetry(
    options.mutationRetryLimit ?? 0,
    "mutationRetryLimit",
  );
  const providerRetryLimit = boundedRetry(
    options.providerRetryLimit ?? 0,
    "providerRetryLimit",
  );

  let ownedSessionId: BrowserSessionId | undefined;
  let completedPages = 0;
  try {
    let browser = await invoke(
      (activeSignal) =>
        dependencies.browser.start(
          { journeyId: input.journeyId, target: input.inputs.job.applyUrl },
          activeSignal,
        ),
      "browser",
      "start",
    );
    ownedSessionId = browser.sessionId;
    let pageId = browser.pageId;
    let page = await observeAndUnderstand(browser.sessionId, pageId);

    async function refreshSession(error: unknown): Promise<void> {
      if (
        !(error instanceof ClosedFailure) ||
        sessionRecoveryDisposition(
          error.failure.error,
          error.failure.phase,
          error.failure.effect,
        ) !== "fresh_session_then_stop"
      ) {
        throw error;
      }
      const recoverySignal = new AbortController().signal;
      const closed = await dependencies.browser.close(
        { sessionId: browser.sessionId },
        recoverySignal,
      );
      if (!closed.ok) {
        fail(
          closed.error,
          "browser",
          "close",
          "uncertain",
          error.failure.sourceId,
        );
      }
      ownedSessionId = undefined;
      const started = await dependencies.browser.start(
        { journeyId: input.journeyId, target: input.inputs.job.applyUrl },
        recoverySignal,
      );
      if (!started.ok) {
        fail(started.error, "browser", "start", "none", error.failure.sourceId);
      }
      browser = started.value;
      ownedSessionId = browser.sessionId;
      const observed = await dependencies.browser.observe(
        { sessionId: browser.sessionId, pageId: browser.pageId },
        recoverySignal,
      );
      if (!observed.ok) {
        fail(
          observed.error,
          "browser",
          "observe",
          "none",
          error.failure.sourceId,
        );
      }
    }

    while (completedPages < pageLimit) {
      const verification: VerificationResult[] = [];
      for (const field of page.fields) {
        if (field.state === "hidden" || field.state === "populated") continue;
        const resolutionSource = nextOperationId();
        const resolution = await invoke(
          (activeSignal) =>
            dependencies.answers.resolve(
              {
                field,
                profileId: input.inputs.profile.profileId,
                profileRevision: input.inputs.profile.revision,
                resume: input.inputs.resume,
                resumeArtifact: input.inputs.resumeArtifact,
              },
              activeSignal,
            ),
          "answer_resolution",
          "resolve",
          resolutionSource,
        );
        if (resolution.kind !== "resolved") {
          block(
            { source: "answer_resolution", result: resolution },
            "F6",
            "answer_resolution",
            "resolve",
            resolutionSource,
          );
        }

        for (let attempt = 0; ; attempt += 1) {
          const operationId = nextOperationId();
          let receipt;
          try {
            receipt = await invoke(
              (activeSignal) =>
                dependencies.driver.drive(
                  {
                    journeyId: input.journeyId,
                    sessionId: browser.sessionId,
                    pageId,
                    guardRevision: dependencies.guardRevision,
                    operationId,
                    intent: resolution.intent,
                  },
                  activeSignal,
                ),
              "field_interaction",
              "mutate",
              operationId,
              "uncertain",
            );
          } catch (error) {
            await refreshSession(error);
            throw error;
          }
          const verificationSource = nextOperationId();
          let verified;
          try {
            verified = await invoke(
              (activeSignal) =>
                dependencies.verifier.verify(
                  {
                    sessionId: browser.sessionId,
                    pageId,
                    intent: resolution.intent,
                    receipt,
                  },
                  activeSignal,
                ),
              "verification",
              "verify",
              verificationSource,
              "uncertain",
            );
          } catch (error) {
            await refreshSession(error);
            throw error;
          }
          if (verified.kind === "verified") {
            verification.push(verified);
            break;
          }
          if (verified.kind === "rejected" && attempt < mutationRetryLimit) {
            continue;
          }
          block(
            { source: "verification", result: verified },
            "F8",
            "verification",
            "verify",
            verificationSource,
          );
        }
      }

      const completion = await invoke(
        (activeSignal) =>
          dependencies.completion.complete({ page, verification }, activeSignal),
        "navigation",
        "complete",
      );
      if (completion.kind === "blocked") {
        fail(
          providerError("page_incomplete"),
          "navigation",
          "complete",
          "none",
          input.sourceId,
        );
      }
      completedPages += 1;
      if (completion.decision.kind === "stop_review") {
        return {
          ok: true,
          value: {
            kind: "review_candidate",
            pageId,
            completedPages,
            sessionId: browser.sessionId,
          },
        };
      }

      const sourcePage = page.pageIdentity;
      const operationId = nextOperationId();
      const safetyInput = {
        policyRevision: dependencies.guardRevision,
        capability: "navigate_next",
        effect: {
          kind: "browser_navigation",
          sessionId: browser.sessionId,
          pageId,
          operationId,
          action: "next",
        },
      } as const;
      const admission = await invoke(
        (activeSignal) =>
          dependencies.safety.admit(
            {
              binding: {
                journeyId: input.journeyId,
                attemptId: operationId,
                guardRevision: dependencies.guardRevision,
              },
              policyRevision: dependencies.guardRevision,
              capability: "navigate_next",
              input: safetyInput,
            },
            activeSignal,
          ),
        "safety",
        "admit",
      );
      const observation = await invoke(
        (activeSignal) =>
          dependencies.browser.navigate(
            bindAdmissionRequest(admission),
            activeSignal,
          ),
        "browser",
        "navigate",
        operationId,
        "uncertain",
      );
      pageId = observation.pageId;
      page = await observeAndUnderstand(browser.sessionId, pageId);
      const expected = {
        kind: "workday",
        page: completion.decision.expectedPage,
      } as const satisfies PageIdentity;
      const reconciled = await invoke(
        (activeSignal) =>
          dependencies.completion.reconcile(
            {
              operationId,
              decision: completion.decision,
              observation,
              sourcePage,
              expected,
              observed: page.pageIdentity,
            },
            activeSignal,
          ),
        "navigation",
        "reconcile",
      );
      if (reconciled.kind === "review_reached") {
        return {
          ok: true,
          value: {
            kind: "review_candidate",
            pageId,
            completedPages,
            sessionId: browser.sessionId,
          },
        };
      }
      if (reconciled.kind !== "advanced") {
        fail(
          providerError(
            reconciled.kind === "illegal_transition"
              ? "navigation_illegal"
              : "navigation_uncertain",
          ),
          "navigation",
          "reconcile",
          "uncertain",
          operationId,
        );
      }
    }

    fail(
      providerError("journey_retry_exhausted"),
      "orchestration",
      "navigate",
      "none",
      input.sourceId,
    );
  } catch (error) {
    if (error instanceof ClosedFactualOutcome && ownedSessionId !== undefined) {
      return {
        ok: true,
        value: {
          kind: "blocked",
          factualOutcome: error.factualOutcome,
          completedPages,
          sessionId: ownedSessionId,
          component: error.component,
          phase: error.phase,
          step: error.step,
          sourceId: error.sourceId,
        },
      };
    }
    if (error instanceof ClosedFailure) {
      return {
        ok: false,
        error:
          ownedSessionId === undefined
            ? error.failure
            : { ...error.failure, sessionId: ownedSessionId },
      };
    }
    throw error;
  }

  async function observeAndUnderstand(
    sessionId: BrowserSessionId,
    pageId: BrowserPageId,
  ): Promise<SemanticPageSnapshot> {
    const observation = await invoke(
      (activeSignal) =>
        dependencies.browser.observe({ sessionId, pageId }, activeSignal),
      "browser",
      "observe",
    );
    const sourceId = nextOperationId();
    const understood = await invoke(
      (activeSignal) =>
        dependencies.understanding.understand({ observation }, activeSignal),
      "page_understanding",
      "classify",
      sourceId,
    );
    if (understood.kind !== "understood") {
      block(
        {
          source: "page_understanding",
          result: { ...understood, pageId },
        },
        "F5",
        "page_understanding",
        "classify",
        sourceId,
      );
    }
    return understood.snapshot;
  }

  async function invoke<T, E extends PortError<StableErrorCode>>(
    operation: (activeSignal: AbortSignal) => Promise<PortResult<T, E>>,
    phase: PhaseId,
    step: StepId,
    sourceId?: OperationId,
    effect: PageLoopFailure["effect"] = "none",
  ): Promise<T> {
    const source = sourceId ?? nextOperationId();
    for (let attempt = 0; ; attempt += 1) {
      const result = await operation(signal);
      if (result.ok) return result.value;
      if (
        retryDisposition(result.error, effect) === "stop" ||
        attempt >= providerRetryLimit
      ) {
        fail(result.error, phase, step, effect, source);
      }
    }
  }

  function nextOperationId(): OperationId {
    const allocated = dependencies.nextOperationId();
    if (!allocated.ok) {
      fail(
        allocated.error,
        "orchestration",
        "transition",
        "none",
        input.sourceId,
      );
    }
    return allocated.value;
  }
}
