import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountVerificationLifecycle } from "../../../src/account/lifecycle/index.ts";
import {
  createCredentialMutationAdapterFake,
  createMailboxProviderFake,
  createPrivilegedVerificationNavigatorFake,
  createVerificationArtifactFake,
  liveFixtures,
} from "../../../src/testing/live/index.ts";
import { accountObserver, lifecycleInput } from "./support.ts";

test("same operation replays one frozen receipt and a changed fingerprint conflicts", async () => {
  const credential = createCredentialMutationAdapterFake();
  const mailbox = createMailboxProviderFake();
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = accountObserver("application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
  });
  const request = lifecycleInput();

  const first = await lifecycle.run(request, new AbortController().signal);
  const replay = await lifecycle.run(request, new AbortController().signal);
  const conflict = await lifecycle.run(
    { ...request, accountIntent: "fresh_create" },
    new AbortController().signal,
  );
  const approvalConflict = await lifecycle.run(
    { ...request, approvalId: "approval_otherabcdefghijkl" },
    new AbortController().signal,
  );
  const requestOperationConflict = await lifecycle.run({
    ...request,
    operations: {
      ...request.operations,
      requestVerificationEmail: "operation_other_request_abc" as never,
    },
  }, new AbortController().signal);

  assert.deepEqual(replay, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.ok && Object.isFrozen(first.value), true);
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: "journey_request_conflict", retryable: false },
  });
  assert.deepEqual(approvalConflict, conflict);
  assert.deepEqual(requestOperationConflict, conflict);
  assert.equal(accountState.calls.length, 1);
  assert.equal(credential.calls.length, 0);
  assert.equal(mailbox.calls.length, 0);
  assert.equal(artifacts.calls.length, 0);
  assert.equal(navigator.calls.length, 0);
});
