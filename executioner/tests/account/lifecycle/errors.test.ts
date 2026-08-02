import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountVerificationLifecycle } from "../../../src/account/lifecycle/index.ts";
import {
  createCredentialMutationAdapterFake,
  createMailboxProviderFake,
  createPrivilegedVerificationNavigatorFake,
  createVerificationArtifactFake,
} from "../../../src/testing/live/index.ts";
import { accountObserver, lifecycleInput } from "./support.ts";

test("credential, mailbox, artifact, and navigation errors keep exact code and retryability", async () => {
  const cases = [
    {
      state: "existing_account" as const,
      credential: createCredentialMutationAdapterFake({
        mutate: {
          ok: false,
          error: { code: "secret_store_unavailable", retryable: true },
        },
      }),
      mailbox: createMailboxProviderFake(),
      artifacts: createVerificationArtifactFake(),
      navigator: createPrivilegedVerificationNavigatorFake(),
      expected: { code: "secret_store_unavailable", retryable: true },
    },
    {
      state: "verification_required" as const,
      credential: createCredentialMutationAdapterFake(),
      mailbox: createMailboxProviderFake({ responses: {
        poll: {
          ok: false,
          error: { code: "mailbox_timeout", retryable: true },
        },
      } }),
      artifacts: createVerificationArtifactFake(),
      navigator: createPrivilegedVerificationNavigatorFake(),
      expected: { code: "mailbox_timeout", retryable: true },
    },
    {
      state: "verification_required" as const,
      credential: createCredentialMutationAdapterFake(),
      mailbox: createMailboxProviderFake(),
      artifacts: createVerificationArtifactFake({ responses: {
        inspect: {
          ok: false,
          error: { code: "verification_artifact_replayed", retryable: false },
        },
      } }),
      navigator: createPrivilegedVerificationNavigatorFake(),
      expected: { code: "verification_artifact_replayed", retryable: false },
    },
    {
      state: "verification_required" as const,
      credential: createCredentialMutationAdapterFake(),
      mailbox: createMailboxProviderFake(),
      artifacts: createVerificationArtifactFake(),
      navigator: createPrivilegedVerificationNavigatorFake({
        navigate: {
          ok: false,
          error: { code: "browser_timeout", retryable: true },
        },
      }),
      expected: { code: "browser_timeout", retryable: true },
    },
  ];

  for (const item of cases) {
    const lifecycle = new AccountVerificationLifecycle({
      credentialMutation: item.credential.port,
      mailbox: item.mailbox.port,
      artifacts: item.artifacts.port,
      navigator: item.navigator.port,
      accountState: accountObserver(item.state).port,
    });

    const result = await lifecycle.run(lifecycleInput(), new AbortController().signal);

    assert.deepEqual(result, { ok: false, error: item.expected });
  }
});

test("malformed successful values never complete the lifecycle", async () => {
  const accountState = accountObserver("verification_required");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: createCredentialMutationAdapterFake().port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake({
      navigate: { ok: true, value: { kind: "unknown" } } as never,
    }).port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(lifecycleInput(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "verification_navigation_denied", retryable: false },
  });
});
