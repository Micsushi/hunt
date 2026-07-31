import {
  admitContractSnapshot,
  bindAdmissionRequest,
  browserPageId,
  ContractParseError,
  fixturePageId,
  fixtureRunId,
  fixtureSemanticHash,
  mcpRequestId,
  generatedOperationId,
  generatedReportId,
  guardRevision,
  parseEvidenceManifest,
  parseMcpResponse,
  type PortResult,
} from "../../contracts/index.ts";
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

function nonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function legalJourneyStatus(value: unknown): boolean {
  return (
    value === "ready" ||
    value === "running" ||
    value === "cancelling" ||
    value === "review_reached" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "failed"
  );
}

function isFactualBlockedTerminalEvent(
  event: {
    readonly kind: string;
    readonly component: string;
    readonly phase: string;
    readonly step: string;
  },
): boolean {
  return event.kind === "journey_terminal" && (
    (
      event.component === "F5" &&
      event.phase === "page_understanding" &&
      event.step === "classify"
    ) || (
      event.component === "F6" &&
      event.phase === "answer_resolution" &&
      event.step === "resolve"
    )
  );
}

const failureContext = {
  journeyId: contractFixtures.journeyState.journeyId,
  component: "F9",
  phase: "orchestration",
  step: "start",
  code: "journey_not_found",
  retryable: false,
  source: { kind: "operation", id: generatedOperationId("operation_0123456789abcdef") },
} as const;

export const contractOperationCases = {
  FixtureRuntime: {
    start: {
      request: { fixtureRunId: fixtureRunId("fixture-run-synthetic") },
      expected: {
        fixtureRunId: fixtureRunId("fixture-run-synthetic"),
        origin: "https://fixture.invalid",
        pageId: fixturePageId("fixture-account"),
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
    reset: {
      request: { fixtureRunId: fixtureRunId("fixture-run-synthetic") },
      expected: {
        fixtureRunId: fixtureRunId("fixture-run-synthetic"),
        semanticHash: fixtureSemanticHash("sha256.fixture-reset"),
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
        fixtureRunId: fixtureRunId("fixture-run-synthetic"),
        fault: "component_failure",
      },
      expected: undefined,
    },
  },
  BrowserSession: {
    start: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
        target: "https://fixture.invalid/profile",
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
        const operation = generatedOperationId("operation_0123456789abcdef");
        const revision = guardRevision("policy-s1");
        const admitted = admitContractSnapshot(
          {
            policyRevision: revision,
            capability: "field_mutation",
            effect: {
              kind: "browser_mutation",
              sessionId: started.sessionId,
              pageId: started.pageId,
              operationId: operation,
              mutation: { kind: "set_text", target: contractFixtures.field.target, text: "Synthetic" },
            },
          },
          "safety",
          { journeyId: contractFixtures.journeyState.journeyId, attemptId: operation, guardRevision: revision },
        );
        if (!admitted.ok) throw new TypeError("synthetic mutation admission failed");
        return bindAdmissionRequest(admitted.value);
      },
      expected: {
        operationId: contractFixtures.mutationReceipt.operationId,
        pageId: contractFixtures.browserObservation.pageId,
        attempted: true,
      },
      assert: (value, request) => {
        return (
          exactKeys(value, ["operationId", "pageId", "attempted"]) &&
          value.operationId === request.snapshot.effect.operationId &&
          value.pageId === request.snapshot.effect.pageId &&
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
        const operation = generatedOperationId("operation_fedcba9876543210");
        const revision = guardRevision("policy-s1");
        const admitted = admitContractSnapshot(
          {
            policyRevision: revision,
            capability: "navigate_next",
            effect: {
              kind: "browser_navigation",
              sessionId: started.sessionId,
              pageId: started.pageId,
              operationId: operation,
              action: "next",
            },
          },
          "safety",
          { journeyId: contractFixtures.journeyState.journeyId, attemptId: operation, guardRevision: revision },
        );
        if (!admitted.ok) throw new TypeError("synthetic navigation admission failed");
        return bindAdmissionRequest(admitted.value);
      },
      expected: {
        operationId: generatedOperationId("operation_fedcba9876543210"),
        fromPageId: contractFixtures.browserObservation.pageId,
        pageId: browserPageId("page-questionnaire"),
      },
      assert: (value, request) => {
        return (
          exactKeys(value, ["operationId", "fromPageId", "pageId"]) &&
          value.operationId === request.snapshot.effect.operationId &&
          value.fromPageId === request.snapshot.effect.pageId &&
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
        jobId: contractFixtures.job.jobId,
        resumeId: contractFixtures.resume.resumeId,
        profileId: contractFixtures.profile.profileId,
      },
      expected: {
        journeyId: contractFixtures.journeyState.journeyId,
        inputs: contractFixtures.journeyInputs,
        state: {
          schemaVersion: 3,
          journeyId: contractFixtures.journeyState.journeyId,
          status: "ready",
          pageId: null,
          revision: 0,
        },
      },
      assert: (value, request) =>
        exactKeys(value, ["journeyId", "inputs", "state"]) &&
        nonEmpty(value.journeyId) &&
        exactKeys(value.inputs, ["job", "resume", "resumeArtifact", "profile"]) &&
        isDeepStrictEqual(value.inputs.job, contractFixtures.job) &&
        value.inputs.job.jobId === request.jobId &&
        isDeepStrictEqual(value.inputs.resume, contractFixtures.resume) &&
        value.inputs.resume.resumeId === request.resumeId &&
        isDeepStrictEqual(value.inputs.profile, contractFixtures.profile) &&
        value.inputs.profile.profileId === request.profileId &&
        value.inputs.profile.revision === contractFixtures.profile.revision &&
        exactKeys(value.state, [
          "schemaVersion",
          "journeyId",
          "status",
          "pageId",
          "revision",
        ]) &&
        value.state.schemaVersion === 3 &&
        value.state.journeyId === value.journeyId &&
        value.state.status === "ready" &&
        value.state.pageId === null &&
        value.state.revision === 0,
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
      assert: (value, request) =>
        exactKeys(value, ["state"]) &&
        value.state !== null &&
        exactKeys(value.state, [
          "schemaVersion",
          "journeyId",
          "status",
          "pageId",
          "revision",
        ]) &&
        value.state.schemaVersion === 3 &&
        value.state.journeyId === request.journeyId &&
        legalJourneyStatus(value.state.status) &&
        (value.state.pageId === null || nonEmpty(value.state.pageId)) &&
        nonNegativeInteger(value.state.revision),
    },
    transition: {
      request: (results) => {
        const loaded = results.load?.state;
        if (loaded === undefined || loaded === null) {
          throw new TypeError("JourneyStateStore.load state is required");
        }
        return {
          journeyId: loaded.journeyId,
          operationId: generatedOperationId("operation_0123456789abcdef"),
          expectedRevision: loaded.revision,
          status: loaded.status,
          pageId: loaded.pageId,
        };
      },
      expected: {
        state: {
          ...contractFixtures.journeyState,
          revision: contractFixtures.journeyState.revision + 1,
        },
        applied: true,
      },
      assert: (value, request) =>
        exactKeys(value, ["state", "applied"]) &&
        value.applied === true &&
        exactKeys(value.state, [
          "schemaVersion",
          "journeyId",
          "status",
          "pageId",
          "revision",
        ]) &&
        value.state.schemaVersion === 3 &&
        value.state.journeyId === request.journeyId &&
        value.state.status === request.status &&
        value.state.pageId === request.pageId &&
        value.state.revision === request.expectedRevision + 1,
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
        resumeArtifact: contractFixtures.resumeArtifact,
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
        journeyId: contractFixtures.journeyState.journeyId,
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        guardRevision: guardRevision("policy-s1"),
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
          pageId: browserPageId("page-questionnaire"),
        },
        sourcePage: { kind: "workday", page: "profile" },
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
        operationId: generatedOperationId("operation_0123456789abcdef"),
        jobId: contractFixtures.job.jobId,
        resumeId: contractFixtures.resume.resumeId,
        profileId: contractFixtures.profile.profileId,
      },
      expected: {
        operationId: generatedOperationId("operation_0123456789abcdef"),
        journeyId: contractFixtures.journeyState.journeyId,
        accepted: true,
      },
      assert: (value, request) =>
        exactKeys(value, ["operationId", "journeyId", "accepted"]) &&
        value.operationId === request.operationId &&
        nonEmpty(value.journeyId) &&
        value.accepted === true,
    },
    status: {
      request: (results) => {
        const started = results.start;
        if (started === undefined) {
          throw new TypeError("JourneyControl.start result is required");
        }
        return { journeyId: started.journeyId };
      },
      expected: "running",
    },
    cancel: {
      request: (results) => {
        const started = results.start;
        if (started === undefined) {
          throw new TypeError("JourneyControl.start result is required");
        }
        return {
          operationId: generatedOperationId("operation_cafebabecafebabe"),
          journeyId: started.journeyId,
        };
      },
      expected: {
        operationId: generatedOperationId("operation_cafebabecafebabe"),
        journeyId: contractFixtures.journeyState.journeyId,
        accepted: true,
      },
      assert: (value, request) =>
        exactKeys(value, ["operationId", "journeyId", "accepted"]) &&
        value.operationId === request.operationId &&
        value.journeyId === request.journeyId &&
        value.accepted === true,
    },
    result: {
      request: (results) => {
        const started = results.start;
        if (started === undefined) {
          throw new TypeError("JourneyControl.start result is required");
        }
        return { journeyId: started.journeyId };
      },
      expected: {
        schemaVersion: 3,
        journeyId: contractFixtures.journeyState.journeyId,
        status: "cancelled",
        completedPages: contractFixtures.terminalResult.completedPages,
      },
      assert: (value, request) =>
        exactKeys(value, [
          "schemaVersion",
          "journeyId",
          "status",
          "completedPages",
        ]) &&
        value.schemaVersion === 3 &&
        value.journeyId === request.journeyId &&
        value.status === "cancelled" &&
        nonNegativeInteger(value.completedPages),
    },
  },
  McpJourneyApi: {
    handle: {
      request: {
        schemaVersion: 2,
        requestId: mcpRequestId("request-synthetic"),
        method: "journey_result",
        params: {
          journeyId: contractFixtures.journeyState.journeyId,
        },
      },
      expected: {
        schemaVersion: 3,
        requestId: mcpRequestId("request-synthetic"),
        ok: true,
        result: {
          kind: "terminal",
          terminal: contractFixtures.terminalResult,
        },
      },
      assert: (value, request) => {
        try {
          const response = parseMcpResponse(value);
          return (
            response.requestId === request.requestId &&
            response.ok === true &&
            request.method === "journey_result" &&
            response.result.kind === "terminal" &&
            response.result.terminal.journeyId ===
              request.params.journeyId
          );
        } catch (error) {
          if (error instanceof ContractParseError) {
            return false;
          }
          throw error;
        }
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
      assert: (value, request) =>
        exactKeys(value, ["appended", "progress"]) &&
        value.appended === true &&
        exactKeys(value.progress, [
          "journeyId",
          "status",
          "completedSteps",
        ]) &&
        value.progress.journeyId === request.event.journeyId &&
        value.progress.status === (
          isFactualBlockedTerminalEvent(request.event)
            ? "blocked"
            : contractFixtures.progress.status
        ) &&
        nonNegativeInteger(value.progress.completedSteps),
    },
  },
  ProgressReader: {
    read: {
      request: {
        journeyId: contractFixtures.journeyState.journeyId,
      },
      expected: contractFixtures.progress,
      assert: (value, request) =>
        exactKeys(value, [
          "journeyId",
          "status",
          "completedSteps",
        ]) &&
        value.journeyId === request.journeyId &&
        legalJourneyStatus(value.status) &&
        nonNegativeInteger(value.completedSteps),
    },
  },
  FailureReporter: {
    report: {
      request: {
        reportId: generatedReportId("report_0123456789abcdef"),
        context: failureContext,
      },
      expected: {
        report: {
          reportId: generatedReportId("report_0123456789abcdef"),
          context: failureContext,
        },
        notification: {
          reportId: generatedReportId("report_0123456789abcdef"),
          delivered: true,
        },
      },
      assert: (value, request) =>
        exactKeys(value, ["report", "notification"]) &&
        exactKeys(value.report, ["reportId", "context"]) &&
        value.report.reportId === request.reportId &&
        isDeepStrictEqual(value.report.context, request.context) &&
        exactKeys(value.notification, ["reportId", "delivered"]) &&
        value.notification.reportId === request.reportId &&
        typeof value.notification.delivered === "boolean",
    },
  },
  PrivacyGuard: {
    admit: {
      request: {
        binding: {
          journeyId: contractFixtures.privacyAdmission.journeyId,
          attemptId: contractFixtures.privacyAdmission.attemptId,
          guardRevision: contractFixtures.privacyAdmission.guardRevision,
        },
        purpose: "privacy",
        input: { policyRevision: "policy-s1", semanticPayload: { fieldId: "field-given-name" } },
      },
      expected: contractFixtures.privacyAdmission,
    },
  },
  SafetyGuard: {
    admit: {
      request: {
        binding: {
          journeyId: contractFixtures.safetyAdmission.journeyId,
          attemptId: contractFixtures.safetyAdmission.attemptId,
          guardRevision: contractFixtures.safetyAdmission.guardRevision,
        },
        policyRevision: contractFixtures.safetyAdmission.guardRevision,
        capability: "field_mutation",
        input: contractFixtures.safetyAdmission.snapshot,
      },
      expected: contractFixtures.safetyAdmission,
    },
  },
  EvidenceStore: {
    write: {
      request: () => {
        const operation = generatedOperationId("operation_e1e1e1e1e1e1e1e1");
        const revision = guardRevision("policy-s1");
        const admitted = admitContractSnapshot(
          {
            journeyId: contractFixtures.journeyState.journeyId,
            operationId: operation,
            record: contractFixtures.evidenceRecord,
          },
          "evidence",
          { journeyId: contractFixtures.journeyState.journeyId, attemptId: operation, guardRevision: revision },
        );
        if (!admitted.ok) throw new TypeError("synthetic evidence admission failed");
        return bindAdmissionRequest(admitted.value);
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
      assert: (value, request) => {
        try {
          return (
            parseEvidenceManifest(value).journeyId ===
            request.journeyId
          );
        } catch (error) {
          if (error instanceof ContractParseError) {
            return false;
          }
          throw error;
        }
      },
    },
  },
} as const satisfies {
  readonly [N in ContractPortName]: PortCases<ContractPortMap[N]>;
};
