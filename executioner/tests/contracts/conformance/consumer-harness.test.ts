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
