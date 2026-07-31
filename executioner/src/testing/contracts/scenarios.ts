import {
  admitContractSnapshot,
  bindAdmissionRequest,
  browserPageId,
  consumeAdmissionPermit,
  consumeEvidenceAdmission,
  generatedOperationId,
  guardRevision,
  mcpRequestId,
  providerError,
} from "../../contracts/index.ts";
import { isDeepStrictEqual } from "node:util";
import type {
  AdmissionBinding,
  BrowserSession,
  BrowserMutationRequest,
  EvidenceAdmissionRequest,
  JourneyControl,
  McpRequest,
  McpResponse,
  PortResult,
  PrivacyAdmissionRequest,
  SafetyAdmissionRequest,
} from "../../contracts/index.ts";
import {
  createBrowserSessionFake,
  createEvidenceStoreFake,
  createEventSinkFake,
  createJourneyStateStoreFake,
  createJourneyControlFake,
  createMcpJourneyApiFake,
  createPrivacyGuardFake,
  createSafetyGuardFake,
} from "./fakes.ts";
import { contractFixtures } from "./fixtures.ts";
import {
  createContractProviderFactory,
  type ContractProviderFactory,
} from "./provider-factories.ts";
import type { ContractCall, ContractFake } from "./types.ts";

export interface ContractScenarioReport<N extends string = string> {
  readonly name: N;
  readonly ports: readonly string[];
  readonly edges: readonly string[];
}

function value<T>(result: PortResult<T, unknown>): T {
  if (!result.ok) throw new TypeError("scenario setup failed");
  return result.value;
}

function freshMutationRequest(seed: string): BrowserMutationRequest {
  const attemptId = generatedOperationId(`operation_${seed}`);
  const binding: AdmissionBinding = {
    journeyId: contractFixtures.journeyState.journeyId,
    attemptId,
    guardRevision: guardRevision("policy-s1"),
  };
  return bindAdmissionRequest(value(admitContractSnapshot(
    {
      policyRevision: binding.guardRevision,
      capability: "field_mutation",
      effect: {
        kind: "browser_mutation",
        sessionId: contractFixtures.browserObservation.sessionId,
        pageId: contractFixtures.browserObservation.pageId,
        operationId: attemptId,
        mutation: {
          kind: "set_text",
          target: contractFixtures.field.target,
          text: "Synthetic",
        },
      },
    },
    "safety",
    binding,
  )));
}

function browserScenarioFactory(): ContractProviderFactory<"BrowserSession"> {
  return createContractProviderFactory("BrowserSession", () => {
    const base = createBrowserSessionFake();
    const calls: ContractCall[] = [];
    let invalidated = false;
    let uncertainPending = true;
    const port: BrowserSession = {
      ...base.port,
      start: async (request, signal) => {
        calls.push({ operation: "start", request });
        invalidated = false;
        return base.port.start(request, signal);
      },
      mutate: async (request, signal) => {
        calls.push({ operation: "mutate", request });
        if (signal.aborted) {
          invalidated = true;
          return { ok: false, error: providerError("operation_cancelled") };
        }
        if (uncertainPending) {
          uncertainPending = false;
          invalidated = true;
          return { ok: false, error: providerError("browser_effect_uncertain") };
        }
        return invalidated
          ? { ok: false, error: providerError("browser_session_invalidated") }
          : {
              ok: true,
              value: {
                operationId: contractFixtures.mutationReceipt.operationId,
                pageId: contractFixtures.browserObservation.pageId,
                attempted: true,
              },
            };
      },
    };
    return { port, calls } satisfies ContractFake<BrowserSession>;
  });
}

function journeyStateScenarioFactory(): ContractProviderFactory<"JourneyStateStore"> {
  return createContractProviderFactory("JourneyStateStore", () => {
    let revision = contractFixtures.journeyState.revision;
    let terminal = false;
    const applied = new Map<string, unknown>();
    return createJourneyStateStoreFake({
      load: (request) => ({
        ok: true,
        value: { state: { ...contractFixtures.journeyState, journeyId: request.journeyId, revision } },
      }),
      transition: (request) => {
        const replay = applied.get(request.operationId);
        if (replay !== undefined) return { ok: true, value: replay } as never;
        if (terminal) return { ok: false, error: providerError("journey_transition_illegal") };
        if (request.expectedRevision !== revision) {
          return { ok: false, error: providerError("journey_revision_conflict") };
        }
        revision += 1;
        terminal = request.status === "review_reached" || request.status === "cancelled" || request.status === "failed";
        const result = {
          state: { ...contractFixtures.journeyState, status: request.status, pageId: request.pageId, revision },
          applied: true,
        };
        applied.set(request.operationId, result);
        return { ok: true, value: result };
      },
    });
  });
}

function mcpError(request: McpRequest, code: "journey_request_conflict" | "journey_busy"): McpResponse {
  return {
    schemaVersion: 2,
    requestId: request.requestId,
    ok: false,
    error: {
      schemaVersion: 2,
      code,
      component: "F9",
      phase: "mcp",
      step: "validate",
      retryable: false,
      source: { kind: "operation", id: generatedOperationId("operation_0123456789abcdef") },
    },
  };
}

function mcpScenarioFactory(): ContractProviderFactory<"McpJourneyApi"> {
  return createContractProviderFactory("McpJourneyApi", () => {
    const records = new Map<string, { request: McpRequest; response: McpResponse }>();
    let activeRequest: string | null = null;
    let journeyStatus: "running" | "cancelled" = "running";
    return createMcpJourneyApiFake({
      handle: (request) => {
        const existing = records.get(request.requestId);
        if (existing !== undefined) {
          return {
            ok: true,
            value: JSON.stringify(existing.request) === JSON.stringify(request)
              ? existing.response
              : mcpError(request, "journey_request_conflict"),
          };
        }
        if (activeRequest !== null && request.method === "start_journey") {
          const response = mcpError(request, "journey_busy");
          records.set(request.requestId, { request, response });
          return { ok: true, value: response };
        }
        if (request.method === "start_journey") {
          activeRequest = request.requestId;
          journeyStatus = "running";
        }
        if (request.method === "cancel_journey") {
          activeRequest = null;
          journeyStatus = "cancelled";
        }
        const response: McpResponse = request.method === "journey_result"
          ? {
              schemaVersion: 2,
              requestId: request.requestId,
              ok: true,
              result: {
                kind: "terminal",
                terminal: journeyStatus === "cancelled"
                  ? {
                      schemaVersion: 2,
                      journeyId: contractFixtures.journeyState.journeyId,
                      status: "cancelled",
                      completedPages: 0,
                    }
                  : contractFixtures.terminalResult,
              },
            }
          : request.method === "journey_status"
          ? {
              schemaVersion: 2,
              requestId: request.requestId,
              ok: true,
              result: {
                kind: "status",
                progress: { ...contractFixtures.progress, status: journeyStatus },
              },
            }
          : {
              schemaVersion: 2,
              requestId: request.requestId,
              ok: true,
              result: {
                kind: "accepted",
                operationId: generatedOperationId("operation_0123456789abcdef"),
                journeyId: contractFixtures.journeyState.journeyId,
              },
            };
        records.set(request.requestId, { request, response });
        return { ok: true, value: response };
      },
    });
  });
}

function eventScenarioFactory(): ContractProviderFactory<"EventSink"> {
  return createContractProviderFactory("EventSink", () => {
    const appended = new Set<string>();
    return createEventSinkFake({
      append: (request) => {
        const fresh = !appended.has(request.event.eventId);
        appended.add(request.event.eventId);
        return { ok: true, value: { appended: fresh, progress: contractFixtures.progress } };
      },
    });
  });
}

function evidenceScenarioFactory(): ContractProviderFactory<"EvidenceStore"> {
  return createContractProviderFactory("EvidenceStore", () =>
    createEvidenceStoreFake({
      write: (request) => {
        const admitted = consumeEvidenceAdmission(request);
        return admitted.ok
          ? { ok: true, value: { recordId: admitted.value.record.id, written: true } }
          : admitted;
      },
    }),
  );
}

function privacyScenarioFactory(): ContractProviderFactory<"PrivacyGuard"> {
  return createContractProviderFactory("PrivacyGuard", () =>
    createPrivacyGuardFake({
      admit: (request: PrivacyAdmissionRequest) =>
        admitContractSnapshot(request.input, "privacy", request.binding) as never,
    }),
  );
}

function journeyControlScenarioFactory(): ContractProviderFactory<"JourneyControl"> {
  return createContractProviderFactory("JourneyControl", () => {
    const base = createJourneyControlFake();
    const calls: ContractCall[] = [];
    const records = new Map<string, unknown>();
    let status: "running" | "cancelled" = "running";
    const port: JourneyControl = {
      start: async (request, signal) => {
        calls.push({ operation: "start", request });
        if (signal.aborted) return base.port.start(request, signal);
        const recorded = records.get(request.operationId);
        if (recorded !== undefined) return { ok: true, value: recorded } as never;
        status = "running";
        const result = { operationId: request.operationId, journeyId: contractFixtures.journeyState.journeyId, accepted: true };
        records.set(request.operationId, result);
        return { ok: true, value: result };
      },
      cancel: async (request, signal) => {
        calls.push({ operation: "cancel", request });
        if (signal.aborted) return base.port.cancel(request, signal);
        const recorded = records.get(request.operationId);
        if (recorded !== undefined) return { ok: true, value: recorded } as never;
        status = "cancelled";
        const result = { operationId: request.operationId, journeyId: request.journeyId, accepted: true };
        records.set(request.operationId, result);
        return { ok: true, value: result };
      },
      status: async (request, signal) => {
        calls.push({ operation: "status", request });
        if (signal.aborted) return base.port.status(request, signal);
        return { ok: true, value: status };
      },
      result: async (request, signal) => {
        calls.push({ operation: "result", request });
        if (signal.aborted) return base.port.result(request, signal);
        return {
          ok: true,
          value: {
            schemaVersion: 2,
            journeyId: request.journeyId,
            status: "cancelled",
            completedPages: 0,
          },
        };
      },
    };
    return { port, calls } satisfies ContractFake<JourneyControl>;
  });
}

function safetyScenarioFactory(): ContractProviderFactory<"SafetyGuard"> {
  return createContractProviderFactory("SafetyGuard", () =>
    createSafetyGuardFake({
      admit: (request: SafetyAdmissionRequest) =>
        admitContractSnapshot(request.input, "safety", request.binding) as never,
    }),
  );
}

export const statefulScenarioProviderFactories = {
  BrowserSession: browserScenarioFactory(),
  JourneyStateStore: journeyStateScenarioFactory(),
  McpJourneyApi: mcpScenarioFactory(),
  EventSink: eventScenarioFactory(),
  EvidenceStore: evidenceScenarioFactory(),
  PrivacyGuard: privacyScenarioFactory(),
  JourneyControl: journeyControlScenarioFactory(),
  SafetyGuard: safetyScenarioFactory(),
} as const;

export async function runBrowserInvalidationScenario(
  factory: ContractProviderFactory<"BrowserSession">,
): Promise<ContractScenarioReport<"browser-invalidation">> {
  const lease = factory.create();
  try {
    const first = await lease.provider.mutate(freshMutationRequest("1111111111111111"), new AbortController().signal);
    if (first.ok || first.error.code !== "browser_effect_uncertain") {
      throw new TypeError("uncertain mutation must be reported");
    }
    const second = await lease.provider.mutate(freshMutationRequest("2222222222222222"), new AbortController().signal);
    if (second.ok || second.error.code !== "browser_session_invalidated") {
      throw new TypeError("post-uncertainty session must reject mutation");
    }
    const restarted = await lease.provider.start(
      { journeyId: contractFixtures.journeyState.journeyId, target: "https://fixture.invalid/profile" },
      new AbortController().signal,
    );
    if (!restarted.ok) throw new TypeError("browser scenario restart failed");
    const cancelled = await lease.provider.mutate(
      freshMutationRequest("3333333333333333"),
      AbortSignal.abort(),
    );
    if (cancelled.ok || cancelled.error.code !== "operation_cancelled") {
      throw new TypeError("cancelled mutation must report operation_cancelled");
    }
    const afterCancel = await lease.provider.mutate(
      freshMutationRequest("4444444444444444"),
      new AbortController().signal,
    );
    if (afterCancel.ok || afterCancel.error.code !== "browser_session_invalidated") {
      throw new TypeError("post-cancel session must reject mutation");
    }
  } finally {
    await lease.cleanup();
  }
  if (!lease.cleaned) throw new TypeError("browser scenario cleanup was not confirmed");
  if (lease.calls.map(({ operation }) => operation).join(",") !== "mutate,mutate,start,mutate,mutate") {
    throw new TypeError("browser scenario call log mismatch");
  }
  return {
    name: "browser-invalidation",
    ports: ["BrowserSession"],
    edges: [
      "mutation-uncertain",
      "session-invalidated",
      "post-invalidation-mutation-rejected",
      "cancellation-invalidated-session",
      "post-cancel-mutation-rejected",
    ],
  };
}

export async function runJourneyStateScenario(
  factory: ContractProviderFactory<"JourneyStateStore">,
): Promise<ContractScenarioReport<"journey-state-replay">> {
  const lease = factory.create();
  const signal = new AbortController().signal;
  try {
    const loaded = await lease.provider.load({ journeyId: contractFixtures.journeyState.journeyId }, signal);
    if (!loaded.ok || loaded.value.state === null) throw new TypeError("journey state load failed");
    const command = {
      journeyId: loaded.value.state.journeyId,
      operationId: generatedOperationId("operation_1111111111111111"),
      expectedRevision: loaded.value.state.revision,
      status: "running" as const,
      pageId: loaded.value.state.pageId,
    };
    const applied = await lease.provider.transition(command, signal);
    const replay = await lease.provider.transition(command, signal);
    if (!applied.ok || !replay.ok || replay.value.state.revision !== applied.value.state.revision) {
      throw new TypeError("duplicate journey transition must replay");
    }
    const concurrent = await lease.provider.transition({ ...command, operationId: generatedOperationId("operation_2222222222222222") }, signal);
    if (concurrent.ok || concurrent.error.code !== "journey_revision_conflict") throw new TypeError("concurrent journey transition must conflict");
    const terminal = await lease.provider.transition({ ...command, operationId: generatedOperationId("operation_3333333333333333"), expectedRevision: applied.value.state.revision, status: "review_reached" }, signal);
    if (!terminal.ok) throw new TypeError("terminal transition must apply");
    const afterTerminal = await lease.provider.transition({ ...command, operationId: generatedOperationId("operation_4444444444444444"), expectedRevision: terminal.value.state.revision }, signal);
    if (afterTerminal.ok || afterTerminal.error.code !== "journey_transition_illegal") throw new TypeError("terminal journey must reject transition");
  } finally {
    await lease.cleanup();
  }
  if (!lease.cleaned) throw new TypeError("journey state scenario cleanup was not confirmed");
  if (lease.calls.map(({ operation }) => operation).join(",") !== "load,transition,transition,transition,transition,transition") {
    throw new TypeError("journey state scenario call log mismatch");
  }
  return {
    name: "journey-state-replay",
    ports: ["JourneyStateStore"],
    edges: ["transition-applied-once", "duplicate-replayed", "concurrent-revision-rejected", "terminal-transition-rejected"],
  };
}

export async function runMcpLifecycleScenario(
  factory: ContractProviderFactory<"McpJourneyApi">,
): Promise<ContractScenarioReport<"mcp-lifecycle">> {
  const lease = factory.create();
  const signal = new AbortController().signal;
  const start = {
    schemaVersion: 2,
    requestId: mcpRequestId("request-start"),
    method: "start_journey",
    params: { jobId: contractFixtures.job.jobId, resumeId: contractFixtures.resume.resumeId, profileId: contractFixtures.profile.profileId },
  } as const satisfies McpRequest;
  try {
    const accepted = await lease.provider.handle(start, signal);
    const duplicate = await lease.provider.handle(start, signal);
    if (!accepted.ok || !duplicate.ok || JSON.stringify(accepted.value) !== JSON.stringify(duplicate.value)) throw new TypeError("identical MCP request must replay");
    const changed = await lease.provider.handle({ ...start, method: "journey_status", params: { journeyId: contractFixtures.journeyState.journeyId } }, signal);
    if (!changed.ok || changed.value.ok || changed.value.error.code !== "journey_request_conflict") throw new TypeError("changed MCP request must conflict");
    const busyRequest = { ...start, requestId: mcpRequestId("request-busy") };
    const busy = await lease.provider.handle(busyRequest, signal);
    const busyReplay = await lease.provider.handle(busyRequest, signal);
    if (!busy.ok || busy.value.ok || !busyReplay.ok || JSON.stringify(busy.value) !== JSON.stringify(busyReplay.value)) throw new TypeError("busy MCP request must be recorded");
    const cancelRequest = { schemaVersion: 2, requestId: mcpRequestId("request-cancel"), method: "cancel_journey", params: { journeyId: contractFixtures.journeyState.journeyId } } as const;
    const cancel = await lease.provider.handle(cancelRequest, signal);
    const cancelReplay = await lease.provider.handle(cancelRequest, signal);
    if (!cancel.ok || !cancel.value.ok || !cancelReplay.ok || JSON.stringify(cancel.value) !== JSON.stringify(cancelReplay.value)) {
      throw new TypeError("MCP cancellation must be recorded and replayed");
    }
    const status = await lease.provider.handle({ schemaVersion: 2, requestId: mcpRequestId("request-status"), method: "journey_status", params: { journeyId: contractFixtures.journeyState.journeyId } }, signal);
    if (
      !status.ok ||
      !status.value.ok ||
      status.value.result.kind !== "status" ||
      status.value.result.progress.status !== "cancelled"
    ) throw new TypeError("post-cancel status must be cancelled");
    const terminalRequest = { schemaVersion: 2, requestId: mcpRequestId("request-result"), method: "journey_result", params: { journeyId: contractFixtures.journeyState.journeyId } } as const;
    const terminal = await lease.provider.handle(terminalRequest, signal);
    const terminalReplay = await lease.provider.handle(terminalRequest, signal);
    if (
      !terminal.ok ||
      !terminal.value.ok ||
      terminal.value.result.kind !== "terminal" ||
      terminal.value.result.terminal.status !== "cancelled"
    ) throw new TypeError("post-cancel terminal must be cancelled");
    if (!terminalReplay.ok || JSON.stringify(terminal.value) !== JSON.stringify(terminalReplay.value)) throw new TypeError("terminal MCP result must replay");
  } finally {
    await lease.cleanup();
  }
  if (!lease.cleaned) throw new TypeError("MCP scenario cleanup was not confirmed");
  const methods = lease.calls.map(({ request }) => (request as McpRequest).method);
  if (
    lease.calls.length !== 10 ||
    lease.calls.some(({ operation }) => operation !== "handle") ||
    methods.join(",") !== "start_journey,start_journey,journey_status,start_journey,start_journey,cancel_journey,cancel_journey,journey_status,journey_result,journey_result"
  ) {
    throw new TypeError("MCP scenario call log mismatch");
  }
  return {
    name: "mcp-lifecycle",
    ports: ["McpJourneyApi"],
    edges: ["duplicate-replayed", "changed-request-conflict", "distinct-request-busy-recorded", "cancel-recorded", "terminal-replayed"],
  };
}

function freshEvidenceRequest(): EvidenceAdmissionRequest {
  const binding: AdmissionBinding = {
    journeyId: contractFixtures.journeyState.journeyId,
    attemptId: generatedOperationId("operation_e1e1e1e1e1e1e1e1"),
    guardRevision: guardRevision("policy-s1"),
  };
  return bindAdmissionRequest(value(admitContractSnapshot({ journeyId: binding.journeyId, operationId: binding.attemptId, record: contractFixtures.evidenceRecord }, "evidence", binding)));
}

export async function runEventEvidenceScenario(
  eventFactory: ContractProviderFactory<"EventSink">,
  evidenceFactory: ContractProviderFactory<"EvidenceStore">,
): Promise<ContractScenarioReport<"event-evidence-idempotency">> {
  const eventLease = eventFactory.create();
  const evidenceLease = evidenceFactory.create();
  const signal = new AbortController().signal;
  try {
    const firstEvent = await eventLease.provider.append({ event: contractFixtures.event }, signal);
    const duplicateEvent = await eventLease.provider.append({ event: contractFixtures.event }, signal);
    if (!firstEvent.ok || !firstEvent.value.appended || !duplicateEvent.ok || duplicateEvent.value.appended) throw new TypeError("event duplicate must not append twice");
    const request = freshEvidenceRequest();
    const outcomes = await Promise.all([
      evidenceLease.provider.write(request, signal),
      evidenceLease.provider.write(request, signal),
    ]);
    if (outcomes.filter((outcome) => outcome.ok).length !== 1 || !outcomes.some((outcome) => !outcome.ok && outcome.error.code === "admission_consumed")) throw new TypeError("evidence duplicate must consume once");
  } finally {
    await eventLease.cleanup();
    await evidenceLease.cleanup();
  }
  if (!eventLease.cleaned || !evidenceLease.cleaned) throw new TypeError("event/evidence cleanup was not confirmed");
  if (
    eventLease.calls.map(({ operation }) => operation).join(",") !== "append,append" ||
    evidenceLease.calls.map(({ operation }) => operation).join(",") !== "write,write"
  ) throw new TypeError("event/evidence scenario call log mismatch");
  return {
    name: "event-evidence-idempotency",
    ports: ["EventSink", "EvidenceStore"],
    edges: ["event-appended-once", "event-duplicate-replayed", "evidence-written-once", "evidence-concurrent-duplicate-rejected"],
  };
}

export async function runAdmissionOneUseScenario(
  factory: ContractProviderFactory<"PrivacyGuard">,
): Promise<ContractScenarioReport<"admission-one-use">> {
  const lease = factory.create();
  const input = { policyRevision: "policy-s1", semanticPayload: { fieldId: "field-given-name" } };
  const binding: AdmissionBinding = {
    journeyId: contractFixtures.journeyState.journeyId,
    attemptId: generatedOperationId("operation_a1a1a1a1a1a1a1a1"),
    guardRevision: guardRevision("policy-s1"),
  };
  try {
    const result = await lease.provider.admit({ binding, purpose: "privacy", input }, new AbortController().signal);
    if (!result.ok) throw new TypeError("privacy provider must admit valid snapshot");
    input.semanticPayload.fieldId = "changed-after-admission";
    const snapshot = result.value.snapshot;
    if (
      !Object.isFrozen(snapshot) ||
      snapshot === null ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot) ||
      !("semanticPayload" in snapshot)
    ) throw new TypeError("admission snapshot must be frozen");
    const request = bindAdmissionRequest(result.value);
    if (!consumeAdmissionPermit(request).ok) throw new TypeError("first admission use must pass");
    const replay = consumeAdmissionPermit(request);
    if (replay.ok || replay.error.code !== "admission_consumed") throw new TypeError("second admission use must fail consumed");
    const fresh = await lease.provider.admit({ binding, purpose: "privacy", input: { policyRevision: "policy-s1", semanticPayload: { fieldId: "field-given-name" } } }, new AbortController().signal);
    if (!fresh.ok) throw new TypeError("fresh admission must pass");
    const bound = bindAdmissionRequest(fresh.value);
    const mismatch = consumeAdmissionPermit({ ...bound, snapshot: { ...(bound.snapshot as object) } });
    if (mismatch.ok || mismatch.error.code !== "admission_mismatch") throw new TypeError("substitute snapshot must fail mismatch");
  } finally {
    await lease.cleanup();
  }
  if (!lease.cleaned) throw new TypeError("admission scenario cleanup was not confirmed");
  if (lease.calls.map(({ operation }) => operation).join(",") !== "admit,admit") {
    throw new TypeError("admission scenario call log mismatch");
  }
  return {
    name: "admission-one-use",
    ports: ["PrivacyGuard"],
    edges: ["snapshot-copied-and-frozen", "capability-consumed-once", "substitute-snapshot-rejected"],
  };
}

export async function runJourneyControlScenario(
  factory: ContractProviderFactory<"JourneyControl">,
): Promise<ContractScenarioReport<"journey-control-lifecycle">> {
  const lease = factory.create();
  const signal = new AbortController().signal;
  const start = {
    operationId: generatedOperationId("operation_5151515151515151"),
    jobId: contractFixtures.job.jobId,
    resumeId: contractFixtures.resume.resumeId,
    profileId: contractFixtures.profile.profileId,
  };
  try {
    const firstStart = await lease.provider.start(start, signal);
    const startReplay = await lease.provider.start(start, signal);
    if (!firstStart.ok || !startReplay.ok || JSON.stringify(firstStart.value) !== JSON.stringify(startReplay.value)) {
      throw new TypeError("JourneyControl start must replay");
    }
    const cancel = {
      operationId: generatedOperationId("operation_6161616161616161"),
      journeyId: firstStart.value.journeyId,
    };
    const firstCancel = await lease.provider.cancel(cancel, signal);
    const cancelReplay = await lease.provider.cancel(cancel, signal);
    if (!firstCancel.ok || !cancelReplay.ok || JSON.stringify(firstCancel.value) !== JSON.stringify(cancelReplay.value)) {
      throw new TypeError("JourneyControl cancel must replay");
    }
    const status = await lease.provider.status({ journeyId: cancel.journeyId }, signal);
    if (!status.ok || status.value !== "cancelled") throw new TypeError("post-cancel status must be cancelled");
    const terminal = await lease.provider.result({ journeyId: cancel.journeyId }, signal);
    if (!terminal.ok || terminal.value.status !== "cancelled") throw new TypeError("post-cancel result must be cancelled");
  } finally {
    await lease.cleanup();
  }
  if (!lease.cleaned) throw new TypeError("JourneyControl cleanup was not confirmed");
  if (lease.calls.map(({ operation }) => operation).join(",") !== "start,start,cancel,cancel,status,result") {
    throw new TypeError("JourneyControl lifecycle call log mismatch");
  }
  return {
    name: "journey-control-lifecycle",
    ports: ["JourneyControl"],
    edges: ["start-replayed", "cancel-replayed", "cancelled-status", "cancelled-terminal"],
  };
}

function safetyAdmissionRequest(seed: string): SafetyAdmissionRequest {
  const bound = freshMutationRequest(seed);
  return {
    binding: {
      journeyId: bound.journeyId,
      attemptId: bound.attemptId,
      guardRevision: bound.guardRevision,
    },
    policyRevision: bound.guardRevision,
    capability: "field_mutation",
    input: bound.snapshot,
  };
}

export async function runSafetyGuardScenario(
  factory: ContractProviderFactory<"SafetyGuard">,
): Promise<ContractScenarioReport<"safety-admission-one-use">> {
  const lease = factory.create();
  const firstRequest = safetyAdmissionRequest("7171717171717171");
  const secondRequest = safetyAdmissionRequest("8181818181818181");
  try {
    const first = await lease.provider.admit(firstRequest, new AbortController().signal);
    if (
      !first.ok ||
      first.value.journeyId !== firstRequest.binding.journeyId ||
      first.value.attemptId !== firstRequest.binding.attemptId ||
      !isDeepStrictEqual(first.value.snapshot, firstRequest.input)
    ) throw new TypeError("safety admission request mismatch");
    const firstBound = bindAdmissionRequest(first.value);
    if (!consumeAdmissionPermit(firstBound).ok) throw new TypeError("first safety capability must consume");
    const replay = consumeAdmissionPermit(firstBound);
    if (replay.ok || replay.error.code !== "admission_consumed") throw new TypeError("safety capability must consume once");

    const second = await lease.provider.admit(secondRequest, new AbortController().signal);
    if (!second.ok || second.value.permit === first.value.permit) {
      throw new TypeError("fresh safety admission must produce a fresh capability");
    }
    if (!consumeAdmissionPermit(bindAdmissionRequest(second.value)).ok) {
      throw new TypeError("fresh safety capability must consume");
    }
  } finally {
    await lease.cleanup();
  }
  if (!lease.cleaned) throw new TypeError("SafetyGuard cleanup was not confirmed");
  if (lease.calls.map(({ operation }) => operation).join(",") !== "admit,admit") {
    throw new TypeError("SafetyGuard scenario call log mismatch");
  }
  return {
    name: "safety-admission-one-use",
    ports: ["SafetyGuard"],
    edges: ["exact-request-admitted", "capability-consumed-once", "fresh-request-fresh-capability"],
  };
}
