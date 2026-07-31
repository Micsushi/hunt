import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContractParseError,
  parseErrorEnvelope,
  parseEventEnvelope,
  phaseIds,
  serializedSchemas,
  stepIds,
} from "../../src/contracts/index.ts";

test("events use closed coordinates and a factual source reference", () => {
  const event = parseEventEnvelope({
    schemaVersion: 1,
    eventId: "event-1",
    journeyId: "journey-1",
    component: "F4",
    phase: "intake",
    step: "validate",
    kind: "step_completed",
    at: "2026-07-30T12:00:00.000Z",
    source: { kind: "operation", id: "operation-1" },
  });

  assert.ok(phaseIds.includes(event.phase));
  assert.ok(stepIds.includes(event.step));
  assert.deepEqual(event.source, {
    kind: "operation",
    id: "operation-1",
  });
  assert.deepEqual(
    serializedSchemas.eventEnvelope.properties.phase.enum,
    phaseIds,
  );
  assert.equal(
    serializedSchemas.eventEnvelope.properties.source.additionalProperties,
    false,
  );
});

test("failure cause is optional, separate, and explicitly verified", () => {
  const observed = parseErrorEnvelope({
    schemaVersion: 1,
    code: "browser_timeout",
    component: "F3",
    phase: "browser",
    step: "observe",
    retryable: true,
    source: { kind: "operation", id: "operation-1" },
  });
  assert.equal(observed.cause, undefined);

  const caused = parseErrorEnvelope({
    ...observed,
    cause: {
      verification: "verified",
      code: "fixture_timeout",
      source: { kind: "event", id: "fixture-event-1" },
    },
  });
  assert.equal(caused.cause?.verification, "verified");
  assert.equal(
    serializedSchemas.errorEnvelope.properties.cause.properties.verification
      .const,
    "verified",
  );

  assert.throws(
    () =>
      parseErrorEnvelope({
        ...observed,
        cause: {
          verification: "suspected",
          code: "fixture_timeout",
          source: { kind: "event", id: "fixture-event-1" },
        },
      }),
    (error: unknown) =>
      error instanceof ContractParseError && error.code === "invalid_value",
  );
});
