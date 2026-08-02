import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCredentialMutationAdapterFake,
  createMailboxProviderFake,
  createPrivilegedVerificationNavigatorFake,
  createVerificationArtifactFake,
  liveFixtures,
} from "../../../src/testing/live/index.ts";
import {
  AccountVerificationLifecycle,
  type AccountLifecycleCredentialMutationAdapter,
  type AccountLifecycleCredentialMutationResult,
} from "../../../src/account/lifecycle/index.ts";
import { accountObserver as observer, lifecycleInput as input } from "./support.ts";

test("independently observed application-ready state skips every effect", async () => {
  const credential = createCredentialMutationAdapterFake();
  const mailbox = createMailboxProviderFake();
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer("application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "account_ready",
      path: "already_ready",
      independentlyObserved: true,
      verificationCandidateCount: 0,
      verificationConsumed: false,
    },
  });
  assert.equal(accountState.calls.length, 1);
  assert.equal(credential.calls.length, 0);
  assert.equal(mailbox.calls.length, 0);
  assert.equal(artifacts.calls.length, 0);
  assert.equal(navigator.calls.length, 0);
});

test("an existing account signs in once and completes only after re-observation", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: {
        kind: "application_ready",
        attemptedFields: ["email", "password"],
      },
    },
  });
  const mailbox = createMailboxProviderFake();
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer("existing_account", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "account_ready",
      path: "reused_account",
      independentlyObserved: true,
      verificationCandidateCount: 0,
      verificationConsumed: false,
    },
  });
  assert.deepEqual(
    credential.calls.map(({ request }) => {
      const typed = request as {
        readonly mode: string;
        readonly operationId: string;
        readonly fields: readonly string[];
      };
      return {
        mode: typed.mode,
        operationId: typed.operationId,
        fields: typed.fields,
      };
    }),
    [{
      mode: "sign_in",
      operationId: input().operations.initialCredentialMutation,
      fields: ["email", "password"],
    }],
  );
  assert.equal(accountState.calls.length, 2);
  assert.equal(mailbox.calls.length, 0);
  assert.equal(artifacts.calls.length, 0);
  assert.equal(navigator.calls.length, 0);
});

test("verification consumes through one navigator call and never invalidates separately", async () => {
  const credential = createCredentialMutationAdapterFake();
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer("verification_required", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "account_ready",
      path: "verified_account",
      independentlyObserved: true,
      verificationCandidateCount: 1,
      verificationConsumed: true,
    },
  });
  assert.equal(credential.calls.length, 0);
  assert.deepEqual(mailbox.calls.map(({ operation }) => operation), ["poll"]);
  assert.deepEqual(artifacts.calls.map(({ operation }) => operation), ["inspect"]);
  assert.deepEqual(navigator.calls.map(({ operation }) => operation), ["navigate"]);
  assert.equal(accountState.calls.length, 2);
});

test("fresh-create submits create first even when Workday initially shows sign-in", async () => {
  const credential = privateCredential(
    { kind: "verification_required", attemptedFields: ["email", "password"] },
  );
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer("existing_account", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run({
    ...input(),
    accountIntent: "fresh_create",
  }, new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["create_account"],
  );
  assert.equal(mailbox.calls.length, 1);
  assert.equal(navigator.calls.length, 1);
});

test("sign-in intent submits sign-in from a create-account page and never creates", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: { kind: "application_ready", attemptedFields: ["email", "password"] },
    },
  });
  const accountState = observer("create_account", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["sign_in"],
  );
});

test("fresh-create never uses an ambiguous sign-in rejection as an existence probe", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: { kind: "verification_required", attemptedFields: ["email", "password"] },
    },
  });
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: observer("existing_account", "application_ready").port,
  });

  const result = await lifecycle.run({
    ...input(),
    accountIntent: "fresh_create",
  }, new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["create_account"],
  );
});

test("exact account-exists after create switches to sign-in once", async () => {
  const credential = privateCredential(
    { kind: "account_exists", attemptedFields: ["email", "password"] },
    { kind: "application_ready", attemptedFields: ["email", "password"] },
  );
  const accountState = observer(
    "existing_account",
    "account_exists",
    "application_ready",
  );
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run({
    ...input(),
    accountIntent: "fresh_create",
  }, new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["create_account", "sign_in"],
  );
});

test("fresh signup may land on sign-in and then reach the application", async () => {
  const credential = privateCredential(
    { kind: "sign_in_required", attemptedFields: ["email", "password"] },
    { kind: "application_ready", attemptedFields: ["email", "password"] },
  );
  const accountState = observer(
    "existing_account",
    "existing_account",
    "application_ready",
  );
  const events: string[] = [];
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: accountState.port,
    trace: (event) => events.push(event),
  });

  const result = await lifecycle.run({
    ...input(),
    accountIntent: "fresh_create",
  }, new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.equal(result.ok && result.value.kind === "account_ready" && result.value.path, "created_account");
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["create_account", "sign_in"],
  );
  assert.deepEqual(events, [
    "lifecycle_page_sign_in",
    "lifecycle_action_create_account",
    "lifecycle_page_sign_in",
    "lifecycle_action_sign_in",
    "lifecycle_page_application_ready",
  ]);
});

test("create-to-sign-in fallback stops instead of cycling back to signup", async () => {
  const credential = privateCredential(
    { kind: "sign_in_required", attemptedFields: ["email", "password"] },
    { kind: "account_absent", attemptedFields: ["email", "password"] },
  );
  const events: string[] = [];
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: observer("existing_account", "existing_account").port,
    trace: (event) => events.push(event),
  });

  const result = await lifecycle.run({
    ...input(),
    accountIntent: "fresh_create",
  }, new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_mutation_denied", retryable: false },
  });
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["create_account", "sign_in"],
  );
  assert.equal(events.at(-1), "lifecycle_cycle_stopped");
});

test("create-to-sign-in fallback rejects an independently observed absent account", async () => {
  const credential = privateCredential(
    { kind: "sign_in_required", attemptedFields: ["email", "password"] },
  );
  const events: string[] = [];
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: observer("existing_account", "account_absent").port,
    trace: (event) => events.push(event),
  });

  const result = await lifecycle.run({
    ...input(),
    accountIntent: "fresh_create",
  }, new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_mutation_denied", retryable: false },
  });
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["create_account"],
  );
  assert.equal(events.at(-1), "lifecycle_cycle_stopped");
});

test("create completion requires an independent application-ready observation", async () => {
  const credential = privateCredential(
    { kind: "application_ready", attemptedFields: ["email", "password"] },
  );
  const accountState = observer("create_account", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run({
    ...input(),
    accountIntent: "fresh_create",
  }, new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.equal(result.ok && result.value.kind === "account_ready" && result.value.path, "created_account");
  assert.equal(accountState.calls.length, 2);
});

test("post-navigation existing-account state signs in and is reclassified", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: {
        kind: "application_ready",
        attemptedFields: ["email", "password"],
      },
    },
  });
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer(
    "verification_required",
    "existing_account",
    "application_ready",
  );
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "account_ready",
      path: "verified_account",
      independentlyObserved: true,
      verificationCandidateCount: 1,
      verificationConsumed: true,
    },
  });
  assert.deepEqual(
    credential.calls.map(({ request }) => ({
      mode: (request as { readonly mode: string }).mode,
      operationId: (request as { readonly operationId: string }).operationId,
    })),
    [{
      mode: "sign_in",
      operationId: input().operations.postVerificationSignIn,
    }],
  );
  assert.equal(accountState.calls.length, 3);
});

test("post-navigation create-account state switches to sign-in and is reclassified", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: {
        kind: "application_ready",
        attemptedFields: ["email", "password"],
      },
    },
  });
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer(
    "verification_required",
    "create_account",
    "application_ready",
  );
  const events: string[] = [];
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
    trace: (event) => events.push(event),
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.deepEqual(
    credential.calls.map(({ request }) => ({
      mode: (request as { readonly mode: string }).mode,
      operationId: (request as { readonly operationId: string }).operationId,
    })),
    [{
      mode: "sign_in",
      operationId: input().operations.postVerificationSignIn,
    }],
  );
  assert.equal(accountState.calls.length, 3);
  assert.deepEqual(events, [
    "lifecycle_page_verification_required",
    "lifecycle_action_verification_link",
    "lifecycle_page_create_account",
    "lifecycle_action_sign_in",
    "lifecycle_page_application_ready",
  ]);
});

test("a reused account may require mailbox verification after sign-in", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: {
        kind: "verification_required",
        attemptedFields: ["email", "password"],
      },
    },
  });
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer("existing_account", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: mailbox.port,
    artifacts: artifacts.port,
    navigator: navigator.port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.equal(mailbox.calls.length, 1);
  assert.equal(navigator.calls.length, 1);
  assert.equal(accountState.calls.length, 2);
});

function privateCredential(
  ...results: readonly AccountLifecycleCredentialMutationResult[]
) {
  const calls: Array<{ readonly request: unknown }> = [];
  let index = 0;
  const port: AccountLifecycleCredentialMutationAdapter = {
    async mutate(request, signal) {
      calls.push({ request });
      if (signal.aborted) {
        return {
          ok: false,
          error: { code: "operation_cancelled", retryable: false },
        };
      }
      const value = results[Math.min(index, results.length - 1)]!;
      index += 1;
      return { ok: true, value };
    },
  };
  return { calls, port };
}
