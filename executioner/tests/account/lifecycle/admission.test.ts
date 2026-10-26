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

test("outer session, secret, and mailbox bindings fail before observation or effects", async () => {
  const base = lifecycleInput();
  const cases = [
    [
      { ...base, approvalId: "approval_invalid" },
      "mcp_request_invalid",
    ],
    [
      { ...base, accountIntent: "create_from_page_default" as never },
      "mcp_request_invalid",
    ],
    [
      { ...base, credential: { ...base.credential, journeyId: liveFixtures.otherJourneyId } },
      "secret_handle_mismatched",
    ],
    [
      { ...base, session: { ...base.session, journeyId: liveFixtures.otherJourneyId } },
      "browser_session_invalidated",
    ],
    [
      { ...base, session: { ...base.session, target: liveFixtures.otherTarget } },
      "browser_session_invalidated",
    ],
    [
      {
        ...base,
        now: base.session.leaseExpiresAt,
        credential: {
          ...base.credential,
          expiresAt: new Date(Date.parse(base.session.leaseExpiresAt) + 1_000).toISOString(),
        },
      },
      "browser_session_invalidated",
    ],
    [
      {
        ...base,
        mailboxRequest: {
          ...base.mailboxRequest,
          journeyId: liveFixtures.otherJourneyId,
        },
      },
      "mailbox_query_invalid",
    ],
    [
      {
        ...base,
        mailboxRequest: { ...base.mailboxRequest, target: liveFixtures.otherTarget },
      },
      "mailbox_query_invalid",
    ],
    [
      {
        ...base,
        mailboxRequest: {
          ...base.mailboxRequest,
          notBefore: base.mailboxRequest.notAfter,
        },
      },
      "mailbox_query_invalid",
    ],
  ] as const;

  for (const [request, code] of cases) {
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

    const result = await lifecycle.run(request, new AbortController().signal);

    assert.deepEqual(result, {
      ok: false,
      error: { code, retryable: false },
    });
    assert.equal(accountState.calls.length, 0, code);
    assert.equal(credential.calls.length, 0, code);
    assert.equal(mailbox.calls.length, 0, code);
    assert.equal(artifacts.calls.length, 0, code);
    assert.equal(navigator.calls.length, 0, code);
  }
});

test("pre-cancel returns one stable cancellation receipt without calling dependencies", async () => {
  const accountState = accountObserver("application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: createCredentialMutationAdapterFake().port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: accountState.port,
  });
  const controller = new AbortController();
  controller.abort();

  const first = await lifecycle.run(lifecycleInput(), controller.signal);
  const replay = await lifecycle.run(lifecycleInput(), new AbortController().signal);

  assert.deepEqual(first, {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.deepEqual(replay, first);
  assert.equal(accountState.calls.length, 0);
});
