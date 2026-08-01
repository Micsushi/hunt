import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractParseError,
  parseDurableJourneyState,
  parseErrorEnvelope,
  parseErrorEnvelopeV3,
  parseEventEnvelope,
  parseEventEnvelopeV3,
  parseMcpRequest,
  parseMcpResponse,
  parseMcpResponseV4,
  parseTerminalResult,
  parseTerminalResultV4,
  s2CommonComponentIds,
  s2CommonPhaseIds,
  s2CommonWireSchemas,
  s2CommonWireVersions,
  s2StableErrorPolicy,
  serializedContractVersions,
  stableErrorPolicy,
} from "../../../src/contracts/index.ts";
import {
  errorV3,
  journeyId,
  operationSource,
  requestId,
  s1FactualOutcomeCases,
  s2ComponentIds as expectedS2ComponentIds,
  s2ErrorPolicyCases,
  s2FactualOutcomeCases,
  s2PhaseIds as expectedS2PhaseIds,
  terminalV4,
} from "./fixtures/common-wire-fixtures.ts";

function expectCode(
  run: () => unknown,
  code: ContractParseError["code"],
  path?: string,
): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof ContractParseError &&
      error.code === code &&
      (path === undefined || error.path === path),
  );
}

const oldTerminal = {
  schemaVersion: 3,
  journeyId,
  status: "blocked",
  completedPages: 1,
  factualOutcome: s1FactualOutcomeCases[0],
} as const;

const oldError = {
  schemaVersion: 2,
  code: "browser_timeout",
  component: "F3",
  phase: "browser",
  step: "observe",
  retryable: true,
  source: operationSource,
} as const;

const oldEvent = {
  schemaVersion: 2,
  eventId: "event_0123456789abcdef",
  journeyId,
  component: "F3",
  phase: "browser",
  step: "observe",
  kind: "step_completed",
  at: "2026-08-01T00:00:00.000Z",
  source: operationSource,
} as const;

test("S2 common versions are additive and Stage 1 versions stay frozen", () => {
  assert.deepEqual(serializedContractVersions, {
    fixtureManifest: 2,
    durableJourneyState: 3,
    eventEnvelope: 2,
    errorEnvelope: 2,
    evidenceManifest: 2,
    terminalResult: 3,
    mcpRequest: 2,
    mcpResponse: 3,
  });
  assert.deepEqual(s2CommonWireVersions, {
    terminalResult: 4,
    mcpResponse: 4,
    errorEnvelope: 3,
    eventEnvelope: 3,
    mcpRequest: 2,
    durableJourneyState: 3,
  });
});

test("Stage 1 parsers retain exact old golden behavior", () => {
  assert.deepEqual(parseTerminalResult(oldTerminal), oldTerminal);
  assert.deepEqual(parseErrorEnvelope(oldError), oldError);
  assert.deepEqual(parseEventEnvelope(oldEvent), oldEvent);
  assert.deepEqual(
    parseMcpRequest({
      schemaVersion: 2,
      requestId,
      method: "journey_result",
      params: { journeyId },
    }),
    {
      schemaVersion: 2,
      requestId,
      method: "journey_result",
      params: { journeyId },
    },
  );
  const oldResponse = {
    schemaVersion: 3,
    requestId,
    ok: true,
    result: { kind: "terminal", terminal: oldTerminal },
  } as const;
  assert.deepEqual(parseMcpResponse(oldResponse), oldResponse);
  const oldState = {
    schemaVersion: 3,
    journeyId,
    status: "blocked",
    pageId: "page-questionnaire",
    revision: 4,
  } as const;
  assert.deepEqual(parseDurableJourneyState(oldState), oldState);

  expectCode(() => parseTerminalResult({ ...oldTerminal, schemaVersion: 4 }), "incompatible_version");
  expectCode(() => parseErrorEnvelope({ ...oldError, schemaVersion: 3 }), "incompatible_version");
  expectCode(() => parseEventEnvelope({ ...oldEvent, schemaVersion: 3 }), "incompatible_version");
});

test("terminal v4 preserves every S1 fact and admits every exact S2 fact", () => {
  for (const factualOutcome of [
    ...s1FactualOutcomeCases,
    ...s2FactualOutcomeCases,
  ]) {
    const value = terminalV4(factualOutcome);
    assert.deepEqual(parseTerminalResultV4(value), value);
  }

  for (const schemaVersion of [2, 3, 5]) {
    expectCode(
      () =>
        parseTerminalResultV4({
          ...terminalV4(s2FactualOutcomeCases[0]),
          schemaVersion,
        }),
      "incompatible_version",
    );
  }
});

test("terminal v4 closes factual, error, raw, and extra-field channels", () => {
  const blocked = terminalV4(s2FactualOutcomeCases[0]);
  const { factualOutcome: _outcome, ...missingOutcome } = blocked;
  expectCode(() => parseTerminalResultV4(missingOutcome), "missing_key");
  expectCode(
    () => parseTerminalResultV4({ ...blocked, errorCode: "journey_busy" }),
    "extra_key",
  );
  expectCode(
    () => parseTerminalResultV4({ ...blocked, retryable: false }),
    "extra_key",
  );
  expectCode(
    () => parseTerminalResultV4({ ...blocked, completedPages: "0" }),
    "invalid_type",
    "$.completedPages",
  );
  expectCode(
    () =>
      parseTerminalResultV4(
        terminalV4({
          source: "ui_behavior",
          result: { kind: "ui_variant_unreviewed", variantId: 1 },
        }),
      ),
    "invalid_type",
    "$.factualOutcome.result.variantId",
  );
  expectCode(
    () =>
      parseTerminalResultV4({
        schemaVersion: 4,
        journeyId,
        status: "failed",
        completedPages: 0,
      }),
    "missing_key",
  );
  expectCode(
    () =>
      parseTerminalResultV4({
        schemaVersion: 4,
        journeyId,
        status: "failed",
        completedPages: 0,
        errorCode: "secret_store_unavailable",
        factualOutcome: s2FactualOutcomeCases[0],
      }),
    "extra_key",
  );

  for (const [key, value] of [
    ["rawUrl", "raw-url-value"],
    ["urlHash", "hash"],
    ["host", "host-value"],
    ["tenant", "tenant-value"],
    ["posting", "posting-value"],
    ["subject", "subject-value"],
    ["sender", "sender-value"],
    ["recipient", "recipient-value"],
    ["messageId", "message-value"],
    ["threadId", "thread-value"],
    ["token", "token-value"],
    ["body", "body-value"],
    ["selector", "selector-value"],
  ] as const) {
    const factualOutcome = {
      source: "target_identity",
      result: { kind: "target_ambiguous", [key]: value },
    };
    expectCode(
      () => parseTerminalResultV4(terminalV4(factualOutcome)),
      "extra_key",
    );
  }
});

test("mailbox observation and replay remain different terminal channels", () => {
  const consumed = terminalV4({
    source: "mailbox_verification",
    result: { kind: "mailbox_consumed" },
  });
  assert.deepEqual(parseTerminalResultV4(consumed), consumed);

  const replay = {
    schemaVersion: 4,
    journeyId,
    status: "failed",
    completedPages: 0,
    errorCode: "verification_artifact_replayed",
  } as const;
  assert.deepEqual(parseTerminalResultV4(replay), replay);
  expectCode(
    () =>
      parseTerminalResultV4({
        ...consumed,
        factualOutcome: {
          source: "mailbox_verification",
          result: { kind: "verification_artifact_replayed" },
        },
      }),
    "invalid_value",
  );
});

test("error v3 publishes the exact new owner and retry policy", () => {
  assert.deepEqual(
    Object.keys(s2StableErrorPolicy).filter(
      (code) => !Object.hasOwn(stableErrorPolicy, code),
    ),
    Object.keys(s2ErrorPolicyCases),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(s2ErrorPolicyCases).map(([code, [owner, retryable]]) => [
        code,
        { owner, retryable },
      ]),
    ),
    Object.fromEntries(
      Object.keys(s2ErrorPolicyCases).map((code) => [
        code,
        s2StableErrorPolicy[code as keyof typeof s2StableErrorPolicy],
      ]),
    ),
  );

  for (const code of Object.keys(
    s2ErrorPolicyCases,
  ) as (keyof typeof s2ErrorPolicyCases)[]) {
    const value = errorV3(code);
    assert.deepEqual(parseErrorEnvelopeV3(value), value);
    expectCode(
      () => parseErrorEnvelopeV3({ ...value, component: "F9" }),
      "invalid_value",
      "$.component",
    );
    expectCode(
      () => parseErrorEnvelopeV3({ ...value, retryable: !value.retryable }),
      "invalid_value",
      "$.retryable",
    );
    expectCode(
      () => parseErrorEnvelope({ ...value, schemaVersion: 2 }),
      "invalid_value",
      "$.code",
    );
  }

  const preserved = { ...oldError, schemaVersion: 3 } as const;
  assert.deepEqual(parseErrorEnvelopeV3(preserved), preserved);
});

test("event v3 widens only component and phase identity", () => {
  assert.deepEqual(
    s2CommonComponentIds.slice(-expectedS2ComponentIds.length),
    expectedS2ComponentIds,
  );
  assert.deepEqual(
    s2CommonPhaseIds.slice(-expectedS2PhaseIds.length),
    expectedS2PhaseIds,
  );
  for (const [index, component] of expectedS2ComponentIds.entries()) {
    const value = {
      ...oldEvent,
      schemaVersion: 3,
      component,
      phase: expectedS2PhaseIds[index % expectedS2PhaseIds.length],
    } as const;
    assert.deepEqual(parseEventEnvelopeV3(value), value);
    expectCode(
      () => parseEventEnvelope({ ...value, schemaVersion: 2 }),
      "invalid_value",
    );
    expectCode(
      () => parseEventEnvelopeV3({ ...value, payload: {} }),
      "extra_key",
    );
  }
  expectCode(
    () => parseEventEnvelopeV3({ ...oldEvent, schemaVersion: 3, at: 1 }),
    "invalid_type",
    "$.at",
  );
});

test("MCP v4 nests only terminal v4 or error v3 and request v2 stays closed", () => {
  const terminal = terminalV4(s2FactualOutcomeCases[0]);
  const terminalResponse = {
    schemaVersion: 4,
    requestId,
    ok: true,
    result: { kind: "terminal", terminal },
  } as const;
  assert.deepEqual(parseMcpResponseV4(terminalResponse), terminalResponse);

  const error = errorV3("secret_store_unavailable");
  const errorResponse = {
    schemaVersion: 4,
    requestId,
    ok: false,
    error,
  } as const;
  assert.deepEqual(parseMcpResponseV4(errorResponse), errorResponse);

  expectCode(
    () =>
      parseMcpResponseV4({
        ...terminalResponse,
        result: { kind: "terminal", terminal: oldTerminal },
      }),
    "incompatible_version",
  );
  expectCode(
    () => parseMcpResponseV4({ ...errorResponse, error: oldError }),
    "incompatible_version",
  );
  expectCode(
    () => parseMcpResponseV4({ ...terminalResponse, error }),
    "extra_key",
  );

  for (const extra of [
    { mode: "live" },
    { config: "owner-inputs" },
    { targetHandle: "target-handle" },
    { url: "url-value" },
    { provider: "gmail-api-v1" },
  ]) {
    expectCode(
      () =>
        parseMcpRequest({
          schemaVersion: 2,
          requestId,
          method: "journey_result",
          params: { journeyId },
          ...extra,
        }),
      "extra_key",
    );
  }
});

test("durable state v3 rejects live checkpoint expansion", () => {
  expectCode(
    () =>
      parseDurableJourneyState({
        schemaVersion: 3,
        journeyId,
        status: "running",
        pageId: null,
        revision: 1,
        targetHandle: "target-handle",
      }),
    "extra_key",
  );
});

test("new schemas mirror strict versions, nesting, and closed objects", () => {
  assert.equal(
    s2CommonWireSchemas.terminalResult.properties.schemaVersion.const,
    4,
  );
  assert.equal(
    s2CommonWireSchemas.mcpResponse.properties.schemaVersion.const,
    4,
  );
  assert.equal(
    s2CommonWireSchemas.errorEnvelope.properties.schemaVersion.const,
    3,
  );
  assert.equal(
    s2CommonWireSchemas.eventEnvelope.properties.schemaVersion.const,
    3,
  );
  assert.equal(s2CommonWireSchemas.terminalResult.additionalProperties, false);
  assert.equal(s2CommonWireSchemas.mcpResponse.additionalProperties, false);
  assert.equal(s2CommonWireSchemas.errorEnvelope.additionalProperties, false);
  assert.equal(s2CommonWireSchemas.eventEnvelope.additionalProperties, false);
  assert.equal(
    s2CommonWireSchemas.mcpResponse.properties.result.oneOf[2].properties
      .terminal,
    s2CommonWireSchemas.terminalResult,
  );
  assert.equal(
    s2CommonWireSchemas.mcpResponse.properties.error,
    s2CommonWireSchemas.errorEnvelope,
  );
  assert.equal(s2CommonWireSchemas.terminalResult.allOf.length, 2);
  assert.equal(s2CommonWireSchemas.mcpResponse.oneOf.length, 2);
  assert.deepEqual(
    s2CommonWireSchemas.errorEnvelope.properties.cause.properties.code.enum,
    Object.keys(s2StableErrorPolicy),
  );
  assert.equal(
    s2CommonWireSchemas.errorEnvelope.allOf.length,
    Object.keys(s2StableErrorPolicy).length,
  );
  const policyIndex = Object.keys(s2StableErrorPolicy).indexOf(
    "secret_store_unavailable",
  );
  const policySchema = s2CommonWireSchemas.errorEnvelope.allOf[policyIndex];
  assert.ok(policySchema);
  assert.equal(policySchema.if.properties.code.const, "secret_store_unavailable");
  assert.equal(policySchema.then.properties.component.const, "S2_SECRET_STORE");
  assert.equal(policySchema.then.properties.retryable.const, true);

  const targetIdentity =
    s2CommonWireSchemas.terminalResult.properties.factualOutcome.oneOf[3];
  assert.equal(targetIdentity.properties.source.const, "target_identity");
  assert.equal(targetIdentity.properties.result.oneOf.length, 3);
  assert.deepEqual(
    targetIdentity.properties.result.oneOf[0].properties.dimension.enum,
    ["host", "tenant", "posting"],
  );
  for (const branch of targetIdentity.properties.result.oneOf) {
    assert.equal(branch.additionalProperties, false);
    assert.ok(branch.required.includes("kind"));
  }
});
