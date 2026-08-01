import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  runCrossWindowsUserDpapiGate,
  type SecondaryWindowsUserContext,
} from "../../src/secrets/windows-dpapi/cross-user-gate.ts";

const activeSignal = () => new AbortController().signal;

test("cross-user gate fails closed with a value-free prerequisite when no context exists", async () => {
  const result = await runCrossWindowsUserDpapiGate({}, activeSignal());
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "environment_prerequisite",
    code: "authorized_secondary_user_context_unavailable",
  });
  assert.deepEqual(Object.keys(result).sort(), ["code", "kind", "schemaVersion"]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /"(?:userSid|path|ciphertext|entropy|value)"|S-\d+-/u,
  );
});

test("cross-user gate passes only a different-user rejection and clears synthetic bytes", async () => {
  let protectedValue: Uint8Array | undefined;
  let protectedEntropy: Uint8Array | undefined;
  let probedCiphertext: Uint8Array | undefined;
  let probedEntropy: Uint8Array | undefined;
  const context: SecondaryWindowsUserContext = {
    async attempt(request) {
      probedCiphertext = request.ciphertext;
      probedEntropy = request.entropy;
      return {
        schemaVersion: 1,
        context: "different_windows_user",
        outcome: "rejected",
      };
    },
  };
  const result = await runCrossWindowsUserDpapiGate({
    bridge: {
      async protect(value, entropy) {
        protectedValue = value;
        protectedEntropy = entropy;
        return Uint8Array.from([131, 137, 139]);
      },
    },
    context,
    randomBytes: (size) => new Uint8Array(size).fill(size),
  }, activeSignal());

  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "passed",
    scope: "windows_dpapi_current_user_v1",
  });
  for (const view of [protectedValue, protectedEntropy, probedCiphertext, probedEntropy]) {
    assert.equal(view?.every((byte) => byte === 0), true);
  }
});

test("cross-user gate rejects decrypted, same-user, malformed, and failed probes", async () => {
  const cases: Array<{
    readonly context: SecondaryWindowsUserContext;
    readonly code: "dpapi_cross_user_isolation_failed" | "dpapi_cross_user_probe_failed";
  }> = [
    {
      context: {
        attempt: async () => ({
          schemaVersion: 1,
          context: "different_windows_user",
          outcome: "decrypted",
        }),
      },
      code: "dpapi_cross_user_isolation_failed",
    },
    {
      context: {
        attempt: async () => ({
          schemaVersion: 1,
          context: "current_windows_user",
          outcome: "rejected",
        }),
      },
      code: "dpapi_cross_user_isolation_failed",
    },
    {
      context: { attempt: async () => ({}) as never },
      code: "dpapi_cross_user_probe_failed",
    },
    {
      context: { attempt: async () => { throw new Error("synthetic probe failure"); } },
      code: "dpapi_cross_user_probe_failed",
    },
  ];
  for (const { context, code } of cases) {
    assert.deepEqual(await runCrossWindowsUserDpapiGate({
      bridge: { protect: async () => Uint8Array.from([149, 151]) },
      context,
      randomBytes: (size) => new Uint8Array(size).fill(1),
    }, activeSignal()), {
      schemaVersion: 1,
      kind: "failed",
      code,
    });
  }
});

test("cross-user command reports the unmet environment prerequisite without a skip", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-dpapi-cross-user.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    kind: "environment_prerequisite",
    code: "authorized_secondary_user_context_unavailable",
  });
});
