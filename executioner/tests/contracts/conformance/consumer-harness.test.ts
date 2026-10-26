import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createProfileQueryFake,
  contractFixtures,
} from "../../../src/testing/contracts/index.ts";

const request = {
  profileId: contractFixtures.profile.profileId,
  profileRevision: contractFixtures.profile.revision,
  factId: "given_name",
} as const;

test("a consumer harness records requests and can return one explicit fault", async () => {
  const expected = {
    ok: false,
    error: { code: "profile_missing", retryable: false },
  } as const;
  const harness = createProfileQueryFake({ query: expected });

  assert.deepEqual(
    await harness.port.query(request, new AbortController().signal),
    expected,
  );
  assert.deepEqual(harness.calls, [{ operation: "query", request }]);
});

test("all fake operations use the frozen cancellation result", async () => {
  const harness = createProfileQueryFake();

  assert.deepEqual(
    await harness.port.query(request, AbortSignal.abort()),
    {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    },
  );
});

test("fake responders can derive and sequence results from calls", async () => {
  const harness = createProfileQueryFake({
    query: (current, _signal, callIndex) =>
      callIndex === 0
        ? {
            ok: true,
            value: {
              kind: "answered",
              value: current.factId,
              provenance: "owner_provided",
            },
          }
        : {
            ok: true,
            value: { kind: "profile_answer_missing" },
          },
  });

  assert.deepEqual(
    await harness.port.query(request, new AbortController().signal),
    {
      ok: true,
      value: {
        kind: "answered",
        value: "given_name",
        provenance: "owner_provided",
      },
    },
  );
  assert.deepEqual(
    await harness.port.query(request, new AbortController().signal),
    {
      ok: true,
      value: { kind: "profile_answer_missing" },
    },
  );
});
