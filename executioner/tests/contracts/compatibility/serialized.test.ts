import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContractParseError,
  parseApplicantProfile,
  parseDurableJourneyState,
  parseErrorEnvelope,
  parseEventEnvelope,
  parseEvidenceManifest,
  parseFixtureManifest,
  parseMcpRequest,
  parseMcpResponse,
  parseTerminalResult,
} from "../../../src/contracts/index.ts";

const serializedCases = [
  {
    name: "fixture manifest",
    parse: parseFixtureManifest,
    value: {
      schemaVersion: 1,
      fixtureSet: "workday-s1",
      pages: [
        {
          id: "account",
          path: "/account",
          semanticHash: "sha256:account",
        },
      ],
    },
  },
  {
    name: "durable journey state",
    parse: parseDurableJourneyState,
    value: {
      schemaVersion: 1,
      journeyId: "journey-1",
      status: "ready",
      pageId: null,
      revision: 0,
    },
  },
  {
    name: "event envelope",
    parse: parseEventEnvelope,
    value: {
      schemaVersion: 1,
      eventId: "event-1",
      journeyId: "journey-1",
      component: "F4",
      phase: "intake",
      step: "validate",
      kind: "step_completed",
      at: "2026-07-30T12:00:00.000Z",
      source: { kind: "operation", id: "operation-1" },
    },
  },
  {
    name: "error envelope",
    parse: parseErrorEnvelope,
    value: {
      schemaVersion: 1,
      code: "browser_timeout",
      component: "F3",
      phase: "browser",
      step: "observe",
      retryable: true,
      source: { kind: "operation", id: "operation-1" },
    },
  },
  {
    name: "evidence manifest",
    parse: parseEvidenceManifest,
    value: {
      schemaVersion: 1,
      journeyId: "journey-1",
      records: [
        {
          id: "evidence-1",
          kind: "semantic_snapshot",
          component: "F5",
          phase: "page_understanding",
          step: "classify",
          sha256: "sha256:evidence",
        },
      ],
    },
  },
  {
    name: "MCP request",
    parse: parseMcpRequest,
    value: {
      schemaVersion: 1,
      requestId: "request-1",
      method: "start_journey",
      params: {
        operationId: "operation-1",
        jobId: "job-1",
        resumeId: "resume-1",
        profileId: "profile-1",
      },
    },
  },
  {
    name: "MCP response",
    parse: parseMcpResponse,
    value: {
      schemaVersion: 1,
      requestId: "request-1",
      ok: true,
      result: {
        kind: "accepted",
        operationId: "operation-1",
        journeyId: "journey-1",
      },
    },
  },
  {
    name: "terminal result",
    parse: parseTerminalResult,
    value: {
      schemaVersion: 1,
      journeyId: "journey-1",
      status: "review_reached",
      completedPages: 3,
    },
  },
] as const;

function expectCode(run: () => unknown, code: ContractParseError["code"]): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof ContractParseError && error.code === code,
  );
}

for (const contract of serializedCases) {
  test(`${contract.name} accepts its frozen version`, () => {
    assert.deepEqual(contract.parse(contract.value), contract.value);
  });

  test(`${contract.name} rejects an incompatible version`, () => {
    expectCode(
      () => contract.parse({ ...contract.value, schemaVersion: 2 }),
      "incompatible_version",
    );
  });

  test(`${contract.name} rejects extra keys`, () => {
    expectCode(
      () => contract.parse({ ...contract.value, unexpected: true }),
      "extra_key",
    );
  });
}

test("serialized inputs reject malformed fields with stable codes", () => {
  expectCode(
    () =>
      parseTerminalResult({
        schemaVersion: 1,
        journeyId: "journey-1",
        status: "review_reached",
        completedPages: "three",
      }),
    "invalid_type",
  );
  expectCode(
    () =>
      parseMcpRequest({
        schemaVersion: 1,
        requestId: "request-1",
        method: "submit",
        params: {},
      }),
    "invalid_value",
  );
  expectCode(
    () =>
      parseMcpRequest({
        schemaVersion: 1,
        requestId: "request-1",
        method: "start_journey",
        params: {
          operationId: "operation-1",
          jobId: "job-1",
          resumeId: "resume-1",
          profileId: "profile-1",
          selector: "#submit",
        },
      }),
    "extra_key",
  );
});

test("MCP accepted results return operation and journey identity", () => {
  assert.deepEqual(
    parseMcpResponse({
      schemaVersion: 1,
      requestId: "request-1",
      ok: true,
      result: {
        kind: "accepted",
        operationId: "operation-1",
        journeyId: "journey-1",
      },
    }),
    {
      schemaVersion: 1,
      requestId: "request-1",
      ok: true,
      result: {
        kind: "accepted",
        operationId: "operation-1",
        journeyId: "journey-1",
      },
    },
  );
});

test("MCP status returns the value-free progress projection", () => {
  assert.deepEqual(
    parseMcpResponse({
      schemaVersion: 1,
      requestId: "request-2",
      ok: true,
      result: {
        kind: "status",
        progress: {
          journeyId: "journey-1",
          status: "running",
          completedSteps: 4,
        },
      },
    }),
    {
      schemaVersion: 1,
      requestId: "request-2",
      ok: true,
      result: {
        kind: "status",
        progress: {
          journeyId: "journey-1",
          status: "running",
          completedSteps: 4,
        },
      },
    },
  );
});

test("ApplicantProfile rejects credential fields at its intake boundary", () => {
  assert.deepEqual(
    parseApplicantProfile({
      profileId: "profile-1",
      revision: 1,
      facts: [
        {
          factId: "work_authorization",
          value: true,
          provenance: "owner_provided",
        },
      ],
    }),
    {
      profileId: "profile-1",
      revision: 1,
      facts: [
        {
          factId: "work_authorization",
          value: true,
          provenance: "owner_provided",
        },
      ],
    },
  );
  expectCode(
    () =>
      parseApplicantProfile({
        profileId: "profile-1",
        revision: 1,
        facts: [],
        password: "forbidden",
      }),
    "extra_key",
  );
  for (const factId of [
    "password",
    "workdayPassword",
    "apiKey",
    "accessToken",
    "sessionCookie",
    "authorizationHeader",
  ]) {
    expectCode(
      () =>
        parseApplicantProfile({
          profileId: "profile-1",
          revision: 1,
          facts: [
            {
              factId,
              value: "forbidden",
              provenance: "owner_provided",
            },
          ],
        }),
      "credential_forbidden",
    );
  }
});
