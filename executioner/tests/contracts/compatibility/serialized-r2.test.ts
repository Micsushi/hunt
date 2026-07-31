import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractParseError,
  parseErrorEnvelope,
  parseEvidenceManifest,
  parseFixtureManifest,
  parseMcpRequest,
  parseMcpResponse,
  parseApplicantProfile,
  parseTerminalResult,
  serializedSchemas,
  serializedContractVersions,
} from "../../../src/contracts/index.ts";

test("serialized contract versions identify only the changed R2.n shapes", () => {
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
    parseFixtureManifest({
      schemaVersion: 2,
      fixtureSet: "workday-s1",
      pages: [],
    }).schemaVersion,
    2,
  );
  assert.throws(
    () =>
      parseMcpRequest({
        schemaVersion: 1,
        requestId: "request-1",
        method: "journey_status",
        params: { journeyId: "journey_0123456789abcdef" },
      }),
    (error: unknown) =>
      error instanceof ContractParseError &&
      error.code === "incompatible_version",
  );
});

test("error and terminal v1 reject the incompatible stable-error enum", () => {
  assert.throws(
    () =>
      parseErrorEnvelope({
        schemaVersion: 1,
        code: "browser_timeout",
        component: "F3",
        phase: "browser",
        step: "observe",
        retryable: true,
        source: {
          kind: "operation",
          id: "operation_0123456789abcdef",
        },
      }),
    (error: unknown) =>
      error instanceof ContractParseError &&
      error.code === "incompatible_version",
  );
  assert.throws(
    () =>
      parseTerminalResult({
        schemaVersion: 1,
        journeyId: "journey_0123456789abcdef",
        status: "failed",
        completedPages: 0,
        errorCode: "browser_effect_uncertain",
      }),
    (error: unknown) =>
      error instanceof ContractParseError &&
      error.code === "incompatible_version",
  );
});

test("MCP parsers copy and freeze exact v2 input without caller operation IDs", () => {
  const caller = {
    schemaVersion: 2,
    requestId: "request-1",
    method: "start_journey",
    params: {
      jobId: "job-1",
      resumeId: "resume-1",
      profileId: "profile-1",
    },
  };
  const parsed = parseMcpRequest(caller);
  caller.params.jobId = "changed";

  assert.notEqual(parsed, caller);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.params), true);
  assert.equal(parsed.method, "start_journey");
  if (parsed.method !== "start_journey") return;
  assert.equal(parsed.params.jobId, "job-1");
  assert.equal("operationId" in parsed.params, false);
});

test("serialized admission rejects a proxy before executing its traps", () => {
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
      ownKeys() {
        traps += 1;
        return [];
      },
    },
  );

  assert.throws(() => parseMcpRequest(proxy), ContractParseError);
  assert.equal(traps, 0);
});

test("MCP serialized identifiers satisfy the bounded branded grammar", () => {
  assert.throws(
    () =>
      parseMcpRequest({
        schemaVersion: 2,
        requestId: "x".repeat(129),
        method: "journey_status",
        params: { journeyId: "journey_0123456789abcdef" },
      }),
    (error: unknown) =>
      error instanceof ContractParseError && error.code === "invalid_value",
  );
  assert.throws(
    () =>
      parseMcpRequest({
        schemaVersion: 2,
        requestId: "request-1",
        method: "journey_status",
        params: { journeyId: "not-a-generated-journey" },
      }),
    (error: unknown) =>
      error instanceof ContractParseError && error.code === "invalid_value",
  );
});

test("every retained serialized identity rejects oversize and nongenerated values", () => {
  const invalidValue = (run: () => unknown) => assert.throws(
    run,
    (error: unknown) => error instanceof ContractParseError && error.code === "invalid_value",
  );
  invalidValue(() => parseFixtureManifest({
    schemaVersion: 2,
    fixtureSet: "workday-s1",
    pages: [{ id: "x".repeat(129), path: "/", semanticHash: "hash-1" }],
  }));
  invalidValue(() => parseEvidenceManifest({
    schemaVersion: 2,
    journeyId: "journey_0123456789abcdef",
    records: [{
      id: "x".repeat(129), kind: "verification", component: "F8",
      phase: "verification", step: "verify", sha256: "0".repeat(64),
    }],
  }));
  invalidValue(() => parseEvidenceManifest({
    schemaVersion: 2,
    journeyId: "journey_0123456789abcdef",
    records: [{
      id: "evidence-1", kind: "verification", component: "F8",
      phase: "verification", step: "verify", sha256: "0".repeat(64),
    }],
  }));
  invalidValue(() => parseApplicantProfile({
    profileId: "x".repeat(129), revision: 1, facts: [],
  }));
  invalidValue(() => parseMcpResponse({
    schemaVersion: 3,
    requestId: "request-1",
    ok: true,
    result: {
      kind: "accepted",
      operationId: ["applicant.email", "example.invalid"].join("@"),
      journeyId: "journey_0123456789abcdef",
    },
  }));
});

test("serialized identity schemas publish their runtime bounds and generated grammar", () => {
  assert.equal(serializedSchemas.fixtureManifest.properties.pages.items.properties.id.maxLength, 128);
  assert.match(serializedSchemas.durableJourneyState.properties.journeyId.pattern, /^\^journey_/u);
  assert.equal(serializedSchemas.mcpRequest.properties.requestId.maxLength, 128);
  assert.match(
    serializedSchemas.evidenceManifest.properties.records.items.properties.id.pattern,
    /^\^evidence_/u,
  );
  assert.match(
    serializedSchemas.mcpResponse.properties.result.oneOf[0].properties.operationId.pattern,
    /^\^operation_/u,
  );
});
