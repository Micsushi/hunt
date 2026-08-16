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
import {
  accountObserver as observer,
  lifecycleInput as input,
  verificationEmailRequester,
} from "./support.ts";

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
  assert.equal(accountState.calls.length, 2);
  assert.equal(credential.calls.length, 0);
  assert.equal(mailbox.calls.length, 0);
  assert.equal(artifacts.calls.length, 0);
  assert.equal(navigator.calls.length, 0);
});

test("a transient ready observation reclassifies before deciding whether to sign in", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: {
        kind: "application_ready",
        attemptedFields: ["email", "password"],
      },
    },
  });
  const accountState = observer(
    "application_ready",
    "existing_account",
    "application_ready",
  );
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.equal(result.ok && result.value.kind === "account_ready" && result.value.path,
    "reused_account");
  assert.equal(accountState.calls.length, 3);
  assert.equal(credential.calls.length, 1);
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

test("sign-in completion reconciles a bounded transient Workday shell", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: {
      ok: true,
      value: {
        kind: "application_ready",
        attemptedFields: ["email", "password"],
      },
    },
  });
  const values = [
    {
      kind: "classified_account",
      state: { kind: "existing_account" },
    },
    {
      kind: "classification_stopped",
      outcome: "workday_page_unknown",
    },
    {
      kind: "classified_account",
      state: { kind: "application_ready" },
    },
  ] as const;
  let index = 0;
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: {
      async observe() {
        const value = values[Math.min(index, values.length - 1)]!;
        index += 1;
        return { ok: true, value } as never;
      },
    },
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.equal(
    result.ok && result.value.kind === "account_ready" && result.value.path,
    "reused_account",
  );
  assert.equal(index, 3);
});

test("an uncertain sign-in effect recovers from an independently observed ready page", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: { ok: false, error: { code: "credential_effect_uncertain", retryable: false } },
  });
  const accountState = observer("existing_account", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.equal(result.ok && result.value.kind === "account_ready" && result.value.path, "reused_account");
  assert.equal(accountState.calls.length, 2);
  assert.equal(credential.calls.length, 1);
});

test("an uncertain sign-in effect preserves a maintenance page reached during transition", async () => {
  const credential = createCredentialMutationAdapterFake({
    mutate: { ok: false, error: { code: "credential_effect_uncertain", retryable: false } },
  });
  const accountState = observer("existing_account", {
    kind: "posting_unavailable",
    reason: "maintenance",
  });
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake().port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: accountState.port,
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "blocked",
      factualOutcome: {
        source: "target_identity",
        result: { kind: "posting_unavailable", reason: "maintenance" },
      },
    },
  });
  assert.equal(accountState.calls.length, 2);
  assert.equal(credential.calls.length, 1);
});

test("verification consumes through one navigator call and never invalidates separately", async () => {
  const credential = createCredentialMutationAdapterFake();
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer("verification_required", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    verificationEmail: verificationEmailRequester().port,
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

test("an independently confirmed verification-email request occurs once before mailbox polling", async () => {
  const order: string[] = [];
  const requester = verificationEmailRequester({
    order,
    result: {
      ok: true,
      value: { kind: "sent", independentlyObserved: true },
    },
  });
  const mailboxBase = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const mailbox = {
    poll(request: Parameters<typeof mailboxBase.port.poll>[0], signal: AbortSignal) {
      order.push("poll_mailbox");
      return mailboxBase.port.poll(request, signal);
    },
  };
  const events: string[] = [];
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: createCredentialMutationAdapterFake().port,
    verificationEmail: requester.port,
    mailbox,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: observer("verification_required", "application_ready").port,
    trace: (event) => events.push(event),
  });

  const result = await lifecycle.run(input(), new AbortController().signal);

  assert.equal(result.ok, true);
  assert.deepEqual(order, ["request_verification_email", "poll_mailbox"]);
  assert.equal(requester.calls.length, 1);
  assert.deepEqual(requester.calls[0], {
    schemaVersion: 1,
    approvalId: input().approvalId,
    journeyId: input().journeyId,
    operationId: input().operations.requestVerificationEmail,
    sessionId: input().session.sessionId,
    target: input().target,
    now: input().now,
  });
  assert.equal(events.filter((event) =>
    event === "lifecycle_action_verification_email_request"
  ).length, 1);
  assert.doesNotMatch(JSON.stringify(events), /submit|https?:|email@|password|token/iu);
});

test("failed, cancelled, or malformed verification-email requests never poll Gmail", async () => {
  for (const result of [
    { ok: false, error: { code: "browser_effect_uncertain", retryable: false } },
    { ok: false, error: { code: "operation_cancelled", retryable: false } },
    { ok: true, value: { kind: "sent", independentlyObserved: false } },
  ] as const) {
    const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
    const lifecycle = new AccountVerificationLifecycle({
      credentialMutation: createCredentialMutationAdapterFake().port,
      verificationEmail: verificationEmailRequester({ result: result as never }).port,
      mailbox: mailbox.port,
      artifacts: createVerificationArtifactFake().port,
      navigator: createPrivilegedVerificationNavigatorFake().port,
      accountState: observer("verification_required").port,
    });

    assert.equal((await lifecycle.run(input(), new AbortController().signal)).ok, false);
    assert.equal(mailbox.calls.length, 0);
  }
});

test("fresh-create submits create first even when Workday initially shows sign-in", async () => {
  const credential = privateCredential(
    { kind: "create_account_required", attemptedFields: ["email", "password"] },
    { kind: "verification_required", attemptedFields: ["email", "password"] },
  );
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer("existing_account", "create_account", "application_ready");
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    verificationEmail: verificationEmailRequester().port,
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
    credential.calls.map(({ request }) => ({
      mode: (request as { readonly mode: string }).mode,
      operationId: (request as { readonly operationId: string }).operationId,
    })),
    [
      { mode: "create_account", operationId: input().operations.initialCredentialMutation },
      { mode: "create_account", operationId: input().operations.createCredentialMutation },
    ],
  );
  assert.equal(mailbox.calls.length, 1);
  assert.equal(navigator.calls.length, 1);
});

test("sign-in intent submits sign-in from a create-account page and never creates", async () => {
  const credential = privateCredential(
    { kind: "sign_in_required", attemptedFields: ["email", "password"] },
    { kind: "application_ready", attemptedFields: ["email", "password"] },
  );
  const accountState = observer("create_account", "existing_account", "application_ready");
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
    credential.calls.map(({ request }) => ({
      mode: (request as { readonly mode: string }).mode,
      operationId: (request as { readonly operationId: string }).operationId,
    })),
    [
      { mode: "sign_in", operationId: input().operations.initialCredentialMutation },
      { mode: "sign_in", operationId: input().operations.accountExistsSignIn },
    ],
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
    verificationEmail: verificationEmailRequester().port,
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

test("fresh signup consumes an automatically sent verification email after generic sign-in rejection", async () => {
  const credential = privateCredential(
    { kind: "sign_in_required", attemptedFields: ["email", "password"] },
    { kind: "account_exists", attemptedFields: ["email", "password"] },
    { kind: "application_ready", attemptedFields: ["email", "password"] },
  );
  const requester = verificationEmailRequester();
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    verificationEmail: requester.port,
    mailbox: mailbox.port,
    artifacts: createVerificationArtifactFake().port,
    navigator: createPrivilegedVerificationNavigatorFake().port,
    accountState: observer(
      "existing_account",
      "existing_account",
      "existing_account",
      "application_ready",
    ).port,
  });

  const result = await lifecycle.run({
    ...input(),
    accountIntent: "fresh_create",
  }, new AbortController().signal);

  assert.equal(result.ok && result.value.kind, "account_ready");
  assert.equal(result.ok && result.value.kind === "account_ready" && result.value.path, "verified_account");
  assert.equal(requester.calls.length, 0);
  assert.equal(mailbox.calls.length, 1);
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["create_account", "sign_in", "sign_in"],
  );
});

test("create-to-sign-in fallback checks auto-verification once instead of cycling to signup", async () => {
  const credential = privateCredential(
    { kind: "sign_in_required", attemptedFields: ["email", "password"] },
    { kind: "account_absent", attemptedFields: ["email", "password"] },
  );
  const events: string[] = [];
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    mailbox: createMailboxProviderFake({ result: liveFixtures.mailboxFactualResults[0] }).port,
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
    ok: true,
    value: {
      kind: "blocked",
      factualOutcome: {
        source: "mailbox_verification",
        result: { kind: "mailbox_none" },
      },
    },
  });
  assert.deepEqual(
    credential.calls.map(({ request }) => (request as { readonly mode: string }).mode),
    ["create_account", "sign_in"],
  );
  assert.equal(events.includes("lifecycle_cycle_stopped"), false);
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
    verificationEmail: verificationEmailRequester().port,
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
  const credential = privateCredential(
    { kind: "sign_in_required", attemptedFields: ["email", "password"] },
    { kind: "application_ready", attemptedFields: ["email", "password"] },
  );
  const mailbox = createMailboxProviderFake({ result: liveFixtures.mailboxAvailable });
  const artifacts = createVerificationArtifactFake();
  const navigator = createPrivilegedVerificationNavigatorFake();
  const accountState = observer(
    "verification_required",
    "create_account",
    "existing_account",
    "application_ready",
  );
  const events: string[] = [];
  const lifecycle = new AccountVerificationLifecycle({
    credentialMutation: credential.port,
    verificationEmail: verificationEmailRequester().port,
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
    [
      {
        mode: "sign_in",
        operationId: input().operations.postVerificationSignIn,
      },
      {
        mode: "sign_in",
        operationId: input().operations.postVerificationCredentialSubmit,
      },
    ],
  );
  assert.equal(accountState.calls.length, 4);
  assert.deepEqual(events, [
    "lifecycle_page_verification_required",
    "lifecycle_action_verification_link",
    "lifecycle_page_create_account",
    "lifecycle_action_sign_in",
    "lifecycle_page_sign_in",
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
    verificationEmail: verificationEmailRequester().port,
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
