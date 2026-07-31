import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractParseError,
  parseDurableJourneyState,
  parseErrorEnvelope,
  parseMcpRequest,
  parseMcpResponse,
  parseTerminalResult,
  serializedContractVersions,
  serializedSchemas,
} from "../../../src/contracts/index.ts";

const journeyId = "journey_0123456789abcdef";

function expectCode(run: () => unknown, code: ContractParseError["code"]): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof ContractParseError && error.code === code,
  );
}

function terminal(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 3,
    journeyId,
    status: "blocked",
    completedPages: 1,
    factualOutcome: {
      source: "page_understanding",
      result: { kind: "unknown", pageId: "page-questionnaire" },
    },
    ...overrides,
  };
}

test("R2.n versions only the three incompatibly changed wire shapes", () => {
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

  assert.equal(
    parseMcpRequest({
      schemaVersion: 2,
      requestId: "request-1",
      method: "journey_status",
      params: { journeyId },
    }).schemaVersion,
    2,
  );
  assert.equal(serializedSchemas.fixtureManifest.properties.schemaVersion.const, 2);
  assert.equal(serializedSchemas.durableJourneyState.properties.schemaVersion.const, 3);
  assert.equal(serializedSchemas.terminalResult.properties.schemaVersion.const, 3);
  assert.equal(serializedSchemas.mcpResponse.properties.schemaVersion.const, 3);
});

test("durable journey state v3 supports blocked and rejects adjacent versions", () => {
  const state = {
    schemaVersion: 3,
    journeyId,
    status: "blocked",
    pageId: "page-questionnaire",
    revision: 4,
  };
  assert.deepEqual(parseDurableJourneyState(state), state);
  for (const schemaVersion of [2, 4]) {
    expectCode(
      () => parseDurableJourneyState({ ...state, schemaVersion }),
      "incompatible_version",
    );
  }
});

test("terminal v3 preserves each approved factual outcome exactly", () => {
  const outcomes = [
    {
      source: "page_understanding",
      result: { kind: "unknown", pageId: "page-questionnaire" },
    },
    {
      source: "page_understanding",
      result: { kind: "ambiguous", pageId: "page-questionnaire" },
    },
    {
      source: "answer_resolution",
      result: { kind: "profile_answer_missing", questionId: "question-work-authorization" },
    },
    {
      source: "answer_resolution",
      result: { kind: "unsupported", fieldId: "field-sponsorship" },
    },
  ] as const;

  for (const factualOutcome of outcomes) {
    const value = terminal({ factualOutcome });
    assert.deepEqual(parseTerminalResult(value), value);
  }
});

test("terminal v3 enforces factual-outcome and error exclusivity", () => {
  const blocked = terminal();
  const { factualOutcome: _omitted, ...missingOutcome } = blocked;
  expectCode(() => parseTerminalResult(missingOutcome), "missing_key");
  expectCode(
    () => parseTerminalResult({ ...blocked, errorCode: "journey_busy" }),
    "extra_key",
  );
  expectCode(
    () => parseTerminalResult({
      ...blocked,
      status: "failed",
      errorCode: "journey_busy",
    }),
    "extra_key",
  );
  expectCode(
    () => parseTerminalResult({
      ...blocked,
      status: "cancelled",
    }),
    "extra_key",
  );
  expectCode(
    () => parseTerminalResult({
      schemaVersion: 3,
      journeyId,
      status: "failed",
      completedPages: 1,
    }),
    "missing_key",
  );
});

test("terminal v3 rejects unapproved, mismatched, and widened factual outcomes", () => {
  const invalidOutcomes = [
    {
      source: "page_understanding",
      result: { kind: "profile_answer_missing", questionId: "question-name" },
    },
    {
      source: "answer_resolution",
      result: { kind: "unknown" },
    },
    {
      source: "answer_resolution",
      result: { kind: "option_no_match", questionId: "question-name" },
    },
    {
      source: "answer_resolution",
      result: { kind: "option_ambiguous", questionId: "question-name" },
    },
    {
      source: "page_understanding",
      result: { kind: "unknown", pageId: "page-questionnaire", rawText: "private" },
    },
    {
      source: "answer_resolution",
      result: { kind: "unsupported", fieldId: "field-name", selector: "#name" },
    },
  ];

  invalidOutcomes.push({
    source: "page_understanding",
    result: { kind: "unknown" },
  });

  for (const factualOutcome of invalidOutcomes) {
    assert.throws(
      () => parseTerminalResult(terminal({ factualOutcome })),
      ContractParseError,
    );
  }
});

test("terminal and MCP response v3 reject v2 and v4", () => {
  for (const schemaVersion of [2, 4]) {
    expectCode(
      () => parseTerminalResult(terminal({ schemaVersion })),
      "incompatible_version",
    );
    expectCode(
      () => parseMcpResponse({
        schemaVersion,
        requestId: "request-1",
        ok: true,
        result: { kind: "terminal", terminal: terminal() },
      }),
      "incompatible_version",
    );
  }
  const response = {
    schemaVersion: 3,
    requestId: "request-1",
    ok: true,
    result: { kind: "terminal", terminal: terminal() },
  } as const;
  assert.deepEqual(parseMcpResponse(response), response);
});

test("factual outcomes never enter the stable error-code channel", () => {
  for (const code of [
    "unknown",
    "ambiguous",
    "profile_answer_missing",
    "unsupported",
  ]) {
    expectCode(
      () => parseErrorEnvelope({
        schemaVersion: 2,
        code,
        component: "F9",
        phase: "orchestration",
        step: "finish",
        retryable: false,
        source: { kind: "operation", id: "operation_0123456789abcdef" },
      }),
      "invalid_value",
    );
  }
});
