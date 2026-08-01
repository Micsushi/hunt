import assert from "node:assert/strict";
import test from "node:test";

import {
  generatedOperationId,
  guardRevision,
  mcpRequestId,
  providerError,
  upstreamJobId,
  type JourneyControl,
  type McpRequest,
} from "../../../src/contracts/index.ts";
import {
  contractFixtures,
  createJourneyControlFake,
  createPrivacyGuardFake,
  createProgressReaderFake,
} from "../../../src/testing/contracts/index.ts";
import { createMcpFacade } from "../../../src/control/mcp/index.ts";

function operations() {
  let next = 0;
  return () => ({
    ok: true as const,
    value: generatedOperationId(
      `operation_${(++next).toString(16).padStart(16, "0")}`,
    ),
  });
}

function request(
  requestId: string,
  method: McpRequest["method"] = "start_journey",
): McpRequest {
  return method === "start_journey"
    ? {
        schemaVersion: 2,
        requestId: mcpRequestId(requestId),
        method,
        params: {
          jobId: contractFixtures.job.jobId,
          resumeId: contractFixtures.resume.resumeId,
          profileId: contractFixtures.profile.profileId,
        },
      }
    : {
        schemaVersion: 2,
        requestId: mcpRequestId(requestId),
        method,
        params: { journeyId: contractFixtures.journeyState.journeyId },
      };
}

function facade(control = createJourneyControlFake()) {
  const privacyRequests: unknown[] = [];
  const privacy = createPrivacyGuardFake({
    admit: async (input, signal) => {
      privacyRequests.push(input);
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      return { ok: true, value: contractFixtures.privacyAdmission };
    },
  });
  return {
    control,
    privacyRequests,
    api: createMcpFacade({
      control: control.port,
      progress: createProgressReaderFake().port,
      privacy: privacy.port,
      nextOperationId: operations(),
      guardRevision: guardRevision("policy-s1"),
      startJourneyId: contractFixtures.journeyState.journeyId,
    }),
  };
}

test("the facade routes all four exact v2 methods through one replay registry", async () => {
  const fixture = facade();
  for (const method of [
    "start_journey",
    "journey_status",
    "cancel_journey",
    "journey_result",
  ] as const) {
    const input = request(`request-${method}`, method);
    const first = await fixture.api.handle(input, new AbortController().signal);
    const replay = await fixture.api.handle(
      structuredClone(input),
      new AbortController().signal,
    );
    assert.equal(first.ok, true);
    assert.deepEqual(replay, first);
  }
  assert.equal(fixture.control.calls.length, 4);
  assert.equal(fixture.privacyRequests.length, 4);
  for (const captured of fixture.privacyRequests) {
    assert.deepEqual(Object.keys(captured as object).sort(), [
      "binding",
      "input",
      "purpose",
    ]);
    const input = (captured as { input: Record<string, unknown> }).input;
    assert.deepEqual(Object.keys(input).sort(), [
      "policyRevision",
      "semanticPayload",
    ]);
    assert.doesNotMatch(JSON.stringify(input), /selector|submit|password/iu);
  }
});

test("changed input conflicts and a concurrently recorded busy response remains busy", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const control = createJourneyControlFake({
    start: async (input) => {
      await blocked;
      const command = input as Parameters<JourneyControl["start"]>[0];
      return {
        ok: true,
        value: {
          operationId: command.operationId,
          journeyId: contractFixtures.journeyState.journeyId,
          accepted: true,
        },
      };
    },
  });
  const fixture = facade(control);
  const activeRequest = request("request-active");
  const active = fixture.api.handle(activeRequest, new AbortController().signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pendingReplay = fixture.api.handle(
    structuredClone(activeRequest),
    new AbortController().signal,
  );

  const busyRequest = request("request-busy");
  const busy = await fixture.api.handle(busyRequest, new AbortController().signal);
  assert.equal(busy.ok, true);
  if (!busy.ok || busy.value.ok) return;
  assert.equal(busy.value.error.code, "journey_busy");

  if (activeRequest.method !== "start_journey") return;
  const changed: McpRequest = {
    ...activeRequest,
    params: { ...activeRequest.params, jobId: upstreamJobId("job-changed") },
  };
  const conflict = await fixture.api.handle(changed, new AbortController().signal);
  assert.equal(conflict.ok, true);
  if (!conflict.ok || conflict.value.ok) return;
  assert.equal(conflict.value.error.code, "journey_request_conflict");
  assert.equal(
    conflict.value.error.source.kind === "operation"
      ? conflict.value.error.source.id
      : null,
    generatedOperationId("operation_0000000000000001"),
  );
  assert.equal(
    busy.value.error.source.kind === "operation"
      ? busy.value.error.source.id
      : null,
    generatedOperationId("operation_0000000000000001"),
  );

  release();
  assert.deepEqual(await pendingReplay, await active);
  assert.deepEqual(
    await fixture.api.handle(busyRequest, new AbortController().signal),
    busy,
  );
  assert.equal(control.calls.length, 1);
});

test("hostile or denied inputs fail before control and never execute getters", async () => {
  const fixture = facade();
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, "schemaVersion", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 2;
    },
  });
  const invalid = await fixture.api.handle(
    hostile as McpRequest,
    new AbortController().signal,
  );
  assert.deepEqual(invalid, {
    ok: false,
    error: providerError("mcp_request_invalid"),
  });
  assert.equal(getterCalls, 0);

  const privacy = createPrivacyGuardFake({
    admit: { ok: false, error: providerError("raw_text_forbidden") },
  });
  const denied = createMcpFacade({
    control: fixture.control.port,
    progress: createProgressReaderFake().port,
    privacy: privacy.port,
    nextOperationId: operations(),
    guardRevision: guardRevision("policy-s1"),
    startJourneyId: contractFixtures.journeyState.journeyId,
  });
  const result = await denied.handle(
    request("request-denied"),
    new AbortController().signal,
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.value.ok) return;
  assert.equal(result.value.error.code, "raw_text_forbidden");
  assert.equal(fixture.control.calls.length, 0);
});

test("operation identity allocation fails closed without a fabricated source", async () => {
  const control = createJourneyControlFake();
  const api = createMcpFacade({
    control: control.port,
    progress: createProgressReaderFake().port,
    privacy: createPrivacyGuardFake().port,
    nextOperationId: () => ({
      ok: false,
      error: providerError("operation_identity_source_invalid"),
    }),
    guardRevision: guardRevision("policy-s1"),
    startJourneyId: contractFixtures.journeyState.journeyId,
  });

  assert.deepEqual(
    await api.handle(request("request-no-identity"), new AbortController().signal),
    { ok: false, error: providerError("mcp_internal_error") },
  );
  assert.equal(control.calls.length, 0);
});
