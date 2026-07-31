import type { PortResult } from "../../contracts/index.ts";
import { isDeepStrictEqual } from "node:util";

import { contractFixtures } from "./fixtures.ts";
import type {
  ContractPortMap,
  ContractPortName,
} from "./types.ts";

type SuccessOf<M> = M extends (
  request: never,
  signal: AbortSignal,
) => Promise<PortResult<infer S, unknown>>
  ? S
  : never;

type PortSuccesses<P> = {
  readonly [K in keyof P]: SuccessOf<P[K]>;
};

type OperationCase<M, P> = M extends (
  request: infer R,
  signal: AbortSignal,
) => Promise<PortResult<infer S, unknown>>
  ? {
      readonly request:
        | R
        | ((results: Partial<PortSuccesses<P>>) => R);
      readonly expected: S;
      readonly assert?: (value: S, request: R) => boolean;
    }
  : never;

type PortCases<P> = {
  readonly [K in keyof P]: OperationCase<P[K], P>;
};

function exactKeys(
  value: object,
  keys: readonly string[],
): boolean {
  return isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const failureContext = {
  journeyId: contractFixtures.journeyState.journeyId,
  component: "F9",
  phase: "orchestration",
  step: "start",
  code: "journey_not_found",
  retryable: false,
  source: { kind: "operation", id: "operation-synthetic" },
} as const;

export const contractOperationCases = {
  FixtureRuntime: {
    start: {
      request: { fixtureRunId: "fixture-run-synthetic" },
      expected: {
        fixtureRunId: "fixture-run-synthetic",
        origin: "https://fixture.invalid",
        pageId: "fixture-account",
      },
      assert: (value, request) => {
        return (
          exactKeys(value, ["fixtureRunId", "origin", "pageId"]) &&
          value.fixtureRunId === request.fixtureRunId &&
          nonEmpty(value.origin) &&
          URL.canParse(value.origin) &&
          nonEmpty(value.pageId)
        );
      },
    },
    transition: {
      request: {
        fixtureRunId: "fixture-run-synthetic",
        transitionId: "transition-synthetic",
        toPageId: "fixture-profile",
      },
      expected: {
        transitionId: "transition-synthetic",
        pageId: "fixture-profile",
        semanticHash: "sha256:fixture-profile",
      },
      assert: (value, request) => {
        return (
          exactKeys(value, ["transitionId", "pageId", "semanticHash"]) &&
          value.transitionId === request.transitionId &&
          value.pageId === request.toPageId &&
          nonEmpty(value.semanticHash)
        );
      },
    },
    reset: {
      request: { fixtureRunId: "fixture-run-synthetic" },
      expected: {
        fixtureRunId: "fixture-run-synthetic",
        semanticHash: "sha256:fixture-reset",
      },
      assert: (value, request) => {
        return (
          exactKeys(value, ["fixtureRunId", "semanticHash"]) &&
          value.fixtureRunId === request.fixtureRunId &&
          nonEmpty(value.semanticHash)
        );
      },
    },
    setFault: {
      request: {
        fixtureRunId: "fixture-run-synthetic",
        fault: "component_failure",
      },
      expected: undefined,
    },
  },
  BrowserSession: {
    start: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
        target: "https://fixture.invalid/account",
      },
      expected: {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
      },
      assert: (value) => {
        return (
          exactKeys(value, ["sessionId", "pageId"]) &&
          nonEmpty(value.sessionId) &&
          nonEmpty(value.pageId)
        );
      },
    },
    observe: {
      request: (results) => {
        const started = results.start;
        if (started === undefined) {
          throw new TypeError("BrowserSession.start result is required");
        }
        return {
          sessionId: started.sessionId,
          pageId: started.pageId,
        };
      },
      expected: contractFixtures.browserObservation,
      assert: (value, request) =>
        exactKeys(value, [
          "sessionId",
          "pageId",
          "origin",
          "path",
          "targets",
        ]) &&
        value.sessionId === request.sessionId &&
        value.pageId === request.pageId &&
        value.origin === contractFixtures.browserObservation.origin &&
        value.path === contractFixtures.browserObservation.path &&
        isDeepStrictEqual(
          value.targets,
          contractFixtures.browserObservation.targets,
        ),
    },
    mutate: {
      request: (results) => {
        const started = results.start;
        if (started === undefined) {
          throw new TypeError("BrowserSession.start result is required");
        }
        return {
          sessionId: started.sessionId,
          pageId: started.pageId,
          operationId: contractFixtures.mutationReceipt.operationId,
          mutation: {
            kind: "type" as const,
            target: contractFixtures.field.target,
            text: "Synthetic",
          },
        };
      },
      expected: {
        operationId: contractFixtures.mutationReceipt.operationId,
        pageId: contractFixtures.browserObservation.pageId,
        attempted: true,
      },
      assert: (value, request) => {
        return (
          exactKeys(value, ["operationId", "pageId", "attempted"]) &&
          value.operationId === request.operationId &&
          value.pageId === request.pageId &&
          value.attempted === true
        );
      },
    },
    navigate: {
      request: (results) => {
        const started = results.start;
        if (started === undefined) {
          throw new TypeError("BrowserSession.start result is required");
        }
        return {
          sessionId: started.sessionId,
          pageId: started.pageId,
          operationId: contractFixtures.mutationReceipt.operationId,
          action: "next" as const,
        };
      },
      expected: {
        operationId: contractFixtures.mutationReceipt.operationId,
        fromPageId: contractFixtures.browserObservation.pageId,
        pageId: "page-questionnaire",
      },
      assert: (value, request) => {
        return (
          exactKeys(value, ["operationId", "fromPageId", "pageId"]) &&
          value.operationId === request.operationId &&
          value.fromPageId === request.pageId &&
          nonEmpty(value.pageId)
        );
      },
    },
    close: {
      request: (results) => {
        const started = results.start;
        if (started === undefined) {
          throw new TypeError("BrowserSession.start result is required");
        }
        return { sessionId: started.sessionId };
      },
      expected: undefined,
    },
  },
  JourneyIntake: {
    bootstrap: {
      request: {
        operationId: "operation-synthetic",
        jobId: contractFixtures.job.jobId,
        resumeId: contractFixtures.resume.resumeId,
        profileId: contractFixtures.profile.profileId,
      },
      expected: {
        journeyId: contractFixtures.journeyState.journeyId,
        inputs: contractFixtures.journeyInputs,
        state: contractFixtures.journeyState,
      },
    },
  },
  ProfileQuery: {
    query: {
      request: {
        profileId: contractFixtures.profile.profileId,
        profileRevision: contractFixtures.profile.revision,
        factId: "given_name",
      },
      expected: {
        kind: "answered",
        value: "Synthetic",
        provenance: "owner_provided",
      },
    },
  },
  JourneyStateStore: {
    load: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
      },
      expected: { state: contractFixtures.journeyState },
    },
    transition: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
        operationId: "operation-synthetic",
        expectedRevision: contractFixtures.journeyState.revision,
        status: "running",
        pageId: contractFixtures.journeyState.pageId,
      },
      expected: {
        state: contractFixtures.journeyState,
        applied: true,
      },
    },
  },
  PageUnderstanding: {
    understand: {
      request: {
        observation: contractFixtures.browserObservation,
      },
      expected: {
        kind: "understood",
        snapshot: contractFixtures.pageSnapshot,
      },
    },
  },
  AnswerResolver: {
    resolve: {
      request: {
        field: contractFixtures.field,
        profileId: contractFixtures.profile.profileId,
        profileRevision: contractFixtures.profile.revision,
        resume: contractFixtures.resume,
      },
      expected: {
        kind: "resolved",
        intent: contractFixtures.intent,
      },
    },
  },
  FieldDriver: {
    drive: {
      request: {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        operationId: contractFixtures.mutationReceipt.operationId,
        intent: contractFixtures.intent,
      },
      expected: contractFixtures.mutationReceipt,
    },
  },
  FieldVerifier: {
    verify: {
      request: {
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        intent: contractFixtures.intent,
        receipt: contractFixtures.mutationReceipt,
      },
      expected: contractFixtures.verification,
    },
  },
  CompletionNavigation: {
    complete: {
      request: {
        page: contractFixtures.pageSnapshot,
        verification: [contractFixtures.verification],
      },
      expected: {
        kind: "complete",
        decision: { kind: "next", expectedPage: "questionnaire" },
      },
    },
    reconcile: {
      request: {
        operationId: contractFixtures.mutationReceipt.operationId,
        decision: { kind: "next", expectedPage: "questionnaire" },
        observation: {
          operationId: contractFixtures.mutationReceipt.operationId,
          fromPageId: contractFixtures.browserObservation.pageId,
          pageId: "page-questionnaire",
        },
        expected: { kind: "workday", page: "questionnaire" },
        observed: { kind: "workday", page: "questionnaire" },
      },
      expected: {
        kind: "advanced",
        expected: { kind: "workday", page: "questionnaire" },
        observed: { kind: "workday", page: "questionnaire" },
      },
    },
  },
  JourneyControl: {
    start: {
      request: {
        operationId: "operation-synthetic",
        jobId: contractFixtures.job.jobId,
        resumeId: contractFixtures.resume.resumeId,
        profileId: contractFixtures.profile.profileId,
      },
      expected: {
        operationId: "operation-synthetic",
        journeyId: contractFixtures.journeyState.journeyId,
        accepted: true,
      },
    },
    cancel: {
      request: {
        operationId: "operation-cancel-synthetic",
        journeyId: contractFixtures.journeyState.journeyId,
      },
      expected: {
        operationId: "operation-cancel-synthetic",
        journeyId: contractFixtures.journeyState.journeyId,
        accepted: true,
      },
    },
    status: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
      },
      expected: "running",
    },
    result: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
      },
      expected: contractFixtures.terminalResult,
    },
  },
  McpJourneyApi: {
    handle: {
      request: {
        schemaVersion: 1,
        requestId: "request-synthetic",
        method: "journey_result",
        params: {
          journeyId: contractFixtures.journeyState.journeyId,
        },
      },
      expected: {
        schemaVersion: 1,
        requestId: "request-synthetic",
        ok: true,
        result: {
          kind: "terminal",
          terminal: contractFixtures.terminalResult,
        },
      },
    },
  },
  EventSink: {
    append: {
      request: { event: contractFixtures.event },
      expected: {
        appended: true,
        progress: contractFixtures.progress,
      },
    },
  },
  ProgressReader: {
    read: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
      },
      expected: contractFixtures.progress,
    },
  },
  FailureReporter: {
    report: {
      request: {
        reportId: "report-synthetic",
        context: failureContext,
      },
      expected: {
        report: {
          reportId: "report-synthetic",
          context: failureContext,
        },
        notification: {
          reportId: "report-synthetic",
          delivered: true,
        },
      },
    },
  },
  PrivacyGuard: {
    admit: {
      request: {
        policyRevision: "policy-s1",
        semanticPayload: { fixture: "synthetic" },
      },
      expected: {
        kind: "admitted",
        policyRevision: "policy-s1",
      },
    },
  },
  SafetyGuard: {
    admit: {
      request: {
        policyRevision: "policy-s1",
        capability: "observe",
      },
      expected: {
        kind: "admitted",
        policyRevision: "policy-s1",
      },
    },
  },
  EvidenceStore: {
    write: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
        record: contractFixtures.evidenceRecord,
      },
      expected: {
        recordId: contractFixtures.evidenceRecord.id,
        written: true,
      },
    },
    read: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
      },
      expected: contractFixtures.evidenceManifest,
    },
  },
  ModelController: {
    suggest: {
      request: {
        attemptId: "attempt-synthetic",
        questionId: "question-synthetic",
        allowedOptionIds: ["option-synthetic"],
      },
      expected: {
        attemptId: "attempt-synthetic",
        suggestion: {
          kind: "option_ranking",
          optionIds: ["option-synthetic"],
        },
      },
    },
  },
} as const satisfies {
  readonly [N in ContractPortName]: PortCases<ContractPortMap[N]>;
};
