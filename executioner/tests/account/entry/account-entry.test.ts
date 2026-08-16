import assert from "node:assert/strict";
import test from "node:test";

import { createAccountEntryCredentialMutationAdapter } from "../../../src/account/entry/index.ts";
import { providerError } from "../../../src/contracts/index.ts";
import type {
  ActiveAccountSecretHandle,
  CredentialMutationRequest,
  LivePortResult,
  PersistentBrowserErrorCode,
  SecretStoreErrorCode,
} from "../../../src/contracts/live/index.ts";
import type {
  AccountActionIntent,
  AccountEntryDependencies,
  AccountFieldName,
  AccountLifecycleCredentialMutationRequest,
  AccountPageAccess,
  ClassifiedAccountObservation,
} from "../../../src/account/entry/index.ts";

const target = {
  schemaVersion: 1,
  atsFamily: "workday",
  hostId: "host_iowa_state" as never,
  tenantId: "tenant_iastatejobs" as never,
  postingId: "posting_R19344" as never,
} as const;

const credential = {
  schemaVersion: 1,
  handleId: "secret_handle_account_0001" as never,
  journeyId: "journey_account_entry_0001" as never,
  provider: "windows_dpapi_current_user_v1",
  purpose: "account_credentials",
  consumer: "credential_mutation_adapter",
  issuedAt: "2026-08-01T12:00:00.000Z",
  expiresAt: "2026-08-02T12:00:00.000Z",
  state: "active",
} as const satisfies ActiveAccountSecretHandle;

function request(
  mode: "create_account" | "sign_in" = "sign_in",
): CredentialMutationRequest {
  return {
    schemaVersion: 1,
    journeyId: credential.journeyId,
    operationId: "operation_account_entry_0001" as never,
    sessionId: "live_session_account_entry_0001" as never,
    target,
    now: "2026-08-01T13:00:00.000Z",
    mode,
    credential,
    fields: ["email", "password"],
  };
}

function lifecycleRequest(
  mode: "show_password_reset" | "request_password_reset" | "complete_password_reset",
  suffix: string,
): AccountLifecycleCredentialMutationRequest {
  return {
    ...request(),
    operationId: `operation_password_reset_${suffix}` as never,
    mode,
  };
}

test("application-ready state returns without resolving or typing credentials", async () => {
  let resolverCalls = 0;
  let accessCalls = 0;
  const dependencies: AccountEntryDependencies = {
    classifiedAccount: {
      inspectClassifiedAccount: async () => ({
        ok: true,
        value: {
          kind: "classified_account",
          state: {
            kind: "application_ready",
            classificationId: "classification_account_ready_v1" as never,
            sourceRevisionId: "classification_revision_live_entry_v1" as never,
          },
          classificationId: "classification_account_ready_v1" as never,
          sourceRevisionId: "classification_revision_live_entry_v1" as never,
          snapshotId: "snapshot_application_ready_0001" as never,
          documentGenerationId: "document_generation_application_ready_0001" as never,
        },
      }),
    },
    accountPage: {
      withOwnedAccountPageAccess: async () => {
        accessCalls += 1;
        return { ok: true, value: undefined };
      },
    },
    credentials: {
      useAccountCredentials: async (_handle, _signal, operation) => {
        resolverCalls += 1;
        return {
          ok: true,
          value: await operation({
            email: Uint8Array.from([101]),
            password: Uint8Array.from([112]),
          }),
        };
      },
    },
  };

  const result = await createAccountEntryCredentialMutationAdapter(dependencies)
    .mutate(request(), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "application_ready", attemptedFields: [] },
  });
  assert.equal(accessCalls, 0);
  assert.equal(resolverCalls, 0);
});

test("verification and manual states preserve exact facts without secret access", async () => {
  const observations: ClassifiedAccountObservation[] = [
    stateObservation("verification_required"),
    {
      ...stateObservation("application_ready"),
      state: {
        kind: "manual_intervention",
        reason: "access_control",
        classificationId: "classification_account_access_v1" as never,
        sourceRevisionId: "classification_revision_live_entry_v1" as never,
      },
    },
  ];
  for (const observation of observations) {
    const base = accountFixture(["existing_account"]);
    const dependencies: AccountEntryDependencies = {
      ...base.dependencies,
      classifiedAccount: {
        inspectClassifiedAccount: async () => ({ ok: true, value: observation }),
      },
    };
    const result = await createAccountEntryCredentialMutationAdapter(dependencies)
      .mutate(request(), new AbortController().signal);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value.attemptedFields, []);
    assert.equal(result.ok && result.value.kind, observation.kind === "classified_account"
      ? observation.state.kind
      : "unreachable");
    assert.equal(base.resolverCalls, 0);
    assert.deepEqual(base.operations, []);
  }
});

test("matching sign-in fills, independently matches, activates, and reclassifies", async () => {
  const fixture = accountFixture(["existing_account", "verification_required"]);
  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "verification_required",
      attemptedFields: ["email", "password"],
    },
  });
  assert.equal(fixture.resolverCalls, 1);
  assert.deepEqual(fixture.operations, [
    "inspectField:email",
    "inspectField:password",
    "inspectAction:submit_sign_in",
    "fill:email",
    "matches:email",
    "fill:password",
    "matches:password",
    "inspectAction:submit_sign_in",
    "activate:submit_sign_in",
  ]);
  assert.equal(fixture.classificationCalls, 2);
});

test("post-submit classification retries transient page states without repeating credentials", async () => {
  const fixture = accountFixture(["existing_account", "application_ready"]);
  const observations: ClassifiedAccountObservation[] = [
    stateObservation("existing_account"),
    { kind: "classification_stopped", pageType: null },
    { kind: "target_ambiguous" },
    stateObservation("application_ready"),
  ];
  let classificationCalls = 0;
  const result = await createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    postSubmitClassificationDelay: async () => {},
    classifiedAccount: {
      inspectClassifiedAccount: async () => ({
        ok: true,
        value: observations[Math.min(classificationCalls++, observations.length - 1)]!,
      }),
    },
  }).mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "application_ready", attemptedFields: ["email", "password"] },
  });
  assert.equal(classificationCalls, 4);
  assert.equal(fixture.operations.filter((operation) =>
    operation === "activate:submit_sign_in"
  ).length, 1);
});

test("password recovery opens, requests, and sets a new password through exact controls", async () => {
  const fixture = accountFixture([
    { kind: "existing_account", accountFact: "password_reset_required" },
    "password_reset_request",
    "password_reset_request",
    "password_reset_email_sent",
    "password_reset_set",
    "existing_account",
  ]);
  const adapter = createAccountEntryCredentialMutationAdapter(fixture.dependencies).lifecycle;

  assert.deepEqual(
    await adapter.mutate(
      lifecycleRequest("show_password_reset", "open_0001"),
      new AbortController().signal,
    ),
    { ok: true, value: { kind: "password_reset_request", attemptedFields: ["email", "password"] } },
  );
  assert.deepEqual(
    await adapter.mutate(
      lifecycleRequest("request_password_reset", "request_01"),
      new AbortController().signal,
    ),
    { ok: true, value: { kind: "password_reset_email_sent", attemptedFields: ["email", "password"] } },
  );
  assert.deepEqual(
    await adapter.mutate(
      lifecycleRequest("complete_password_reset", "complete_1"),
      new AbortController().signal,
    ),
    { ok: true, value: { kind: "sign_in_required", attemptedFields: ["email", "password"] } },
  );
  assert.deepEqual(fixture.operations, [
    "inspectAction:show_password_reset",
    "activate:show_password_reset",
    "inspectField:email",
    "inspectAction:submit_password_reset_request",
    "fill:email",
    "matches:email",
    "activate:submit_password_reset_request",
    "inspectField:password",
    "inspectField:password_confirmation",
    "inspectAction:submit_password_reset",
    "fill:password",
    "matches:password",
    "fill:password_confirmation",
    "matches:password_confirmation",
    "activate:submit_password_reset",
  ]);
  assert.equal(fixture.resolverCalls, 2);
  assert.deepEqual(fixture.traces, [
    "initial_state_password_reset_required",
    "owned_access_started",
    "initial_state_password_reset_request",
    "owned_access_started",
    "fields_admitted",
    "credentials_resolved",
    "email_verified",
    "account_submit_activate_started",
    "account_submit_activated",
    "post_submit_classify_started",
    "post_submit_password_reset_email_sent",
    "initial_state_password_reset_set",
    "owned_access_started",
  ]);
});

test("password recovery waits through unchanged source states without repeating effects", async () => {
  const fixture = accountFixture([
    { kind: "existing_account", accountFact: "password_reset_required" },
    { kind: "existing_account", accountFact: "password_reset_required" },
    "password_reset_request",
    "password_reset_request",
    "password_reset_request",
    "password_reset_email_sent",
    "password_reset_set",
    "password_reset_set",
    "existing_account",
  ]);
  const adapter = createAccountEntryCredentialMutationAdapter(fixture.dependencies).lifecycle;

  assert.equal((await adapter.mutate(
    lifecycleRequest("show_password_reset", "open_wait"),
    new AbortController().signal,
  )).ok, true);
  assert.equal((await adapter.mutate(
    lifecycleRequest("request_password_reset", "request_wait"),
    new AbortController().signal,
  )).ok, true);
  assert.equal((await adapter.mutate(
    lifecycleRequest("complete_password_reset", "complete_wait"),
    new AbortController().signal,
  )).ok, true);
  assert.equal(fixture.operations.filter((item) => item === "activate:show_password_reset").length, 1);
  assert.equal(fixture.operations.filter((item) => item === "activate:submit_password_reset_request").length, 1);
  assert.equal(fixture.operations.filter((item) => item === "activate:submit_password_reset").length, 1);
  assert.equal(fixture.traces.filter((event) => event === "post_submit_classify_retry").length, 3);
});

test("post-submit account-entry uncertainty settles before state-driven routing", async () => {
  const fixture = accountFixture(["existing_account"]);
  let classificationCalls = 0;
  const result = await createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    postSubmitClassificationDelay: async () => {},
    classifiedAccount: {
      inspectClassifiedAccount: async () => ({
        ok: true,
        value: classificationCalls++ === 0
          ? stateObservation("existing_account")
          : classificationCalls === 2
            ? { kind: "classification_stopped", pageType: "account_entry" }
            : stateObservation("application_ready"),
      }),
    },
  }).mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "application_ready", attemptedFields: ["email", "password"] },
  });
  assert.equal(classificationCalls, 3);
});

test("a post-mutation posting returns its classified page for coordinator dispatch", async () => {
  const fixture = accountFixture(["existing_account"]);
  let classificationCalls = 0;
  const events: string[] = [];
  const adapter = createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    postSubmitClassificationDelay: async () => {},
    trace: (event) => events.push(event),
    classifiedAccount: {
      inspectClassifiedAccount: async () => ({
        ok: true,
        value: classificationCalls++ === 0
          ? stateObservation("existing_account")
          : { kind: "classification_stopped", pageType: "job_posting" },
      }),
    },
  });
  const result = await adapter.lifecycle.mutate(
    request("sign_in"),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "navigation_required",
      pageType: "job_posting",
      attemptedFields: ["email", "password"],
    },
  });
  assert.equal(classificationCalls, 2);
  assert.equal(events.at(-1), "post_submit_navigation_required");
  assert.deepEqual(
    await adapter.mutate(request("sign_in"), new AbortController().signal),
    {
      ok: false,
      error: { code: "credential_mutation_denied", retryable: false },
    },
  );
});

test("post-submit classification admits an exact state on the twenty-first observation", async () => {
  const fixture = accountFixture(["create_account"]);
  fixture.controls.set("accept_terms", { cardinality: 0, actionable: false });
  let classificationCalls = 0;
  let delayCalls = 0;
  const adapter = createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    postSubmitClassificationDelay: async () => { delayCalls += 1; },
    classifiedAccount: {
      inspectClassifiedAccount: async () => ({
        ok: true,
        value: classificationCalls++ === 0
          ? stateObservation("create_account")
          : classificationCalls === 22
            ? stateObservation("existing_account")
            : classificationCalls % 2 === 0
              ? { kind: "target_ambiguous" }
              : { kind: "classification_stopped", pageType: null },
      }),
    },
  });

  const result = await adapter.lifecycle.mutate(
    request("create_account"),
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "sign_in_required", attemptedFields: ["email", "password"] },
  });
  assert.equal(classificationCalls, 22);
  assert.equal(delayCalls, 20);
  assert.deepEqual(fixture.operations.filter((operation) =>
    operation.startsWith("activate:submit_")
  ), ["activate:submit_create_account"]);
});

test("post-submit ambiguity exhausts bounded classification without accepting the mutation", async () => {
  const fixture = accountFixture(["existing_account"]);
  let classificationCalls = 0;
  let delayCalls = 0;
  const result = await createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    postSubmitClassificationDelay: async () => { delayCalls += 1; },
    classifiedAccount: {
      inspectClassifiedAccount: async () => ({
        ok: true,
        value: classificationCalls++ === 0
          ? stateObservation("existing_account")
          : { kind: "target_ambiguous" },
      }),
    },
  }).mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_effect_uncertain", retryable: false },
  });
  assert.equal(classificationCalls - 1, 80);
  assert.equal(delayCalls, 79);
  assert.equal(fixture.operations.filter((operation) =>
    operation === "activate:submit_sign_in"
  ).length, 1);
});

test("value-free trace reports only fixed account-stage identifiers", async () => {
  const fixture = accountFixture(["existing_account", "verification_required"]);
  const events: string[] = [];

  await createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    trace: (event) => events.push(event),
  }).mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(events, [
    "initial_state_existing_account",
    "owned_access_started",
    "fields_admitted",
    "credentials_resolved",
    "email_verified",
    "password_verified",
    "submit_reinspect_succeeded",
    "account_submit_activate_started",
    "account_submit_activated",
    "post_submit_classify_started",
    "post_submit_verification_required",
  ]);
  assert.equal(JSON.stringify(events).includes("@"), false);
});

test("sign-in that remains on an entry state clears fields and is denied", async () => {
  const fixture = accountFixture(["existing_account", "existing_account"]);
  const events: string[] = [];

  const result = await createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    trace: (event) => events.push(event),
  })
    .mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_mutation_denied", retryable: false },
  });
  assert.deepEqual(fixture.operations.slice(-4), [
    "clear:password",
    "isEmpty:password",
    "clear:email",
    "isEmpty:email",
  ]);
  assert.deepEqual(events.slice(-3), [
    "post_submit_existing_account",
    "post_submit_no_progress",
    "cleanup_succeeded",
  ]);
});

test("request admission denies a widened or reordered public field set before inspection", async () => {
  const fixture = accountFixture(["existing_account"]);
  const widened = {
    ...request("sign_in"),
    fields: ["password", "email"],
  } as CredentialMutationRequest;

  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(widened, new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_mutation_denied", retryable: false },
  });
  assert.equal(fixture.classificationCalls, 0);
  assert.equal(fixture.resolverCalls, 0);
});

test("secret metadata admission preserves exact invalid, expired, forbidden, and mismatch errors", async () => {
  const cases = [
    [{ state: "revoked" }, "secret_handle_invalid"],
    [{ state: "expired" }, "secret_handle_expired"],
    [{ consumer: "gmail_auth_executor" }, "secret_consumer_forbidden"],
    [{ purpose: "gmail_oauth" }, "secret_handle_mismatched"],
    [{ journeyId: "journey_account_entry_other" }, "secret_handle_mismatched"],
  ] as const;
  for (const [change, code] of cases) {
    const fixture = accountFixture(["existing_account"]);
    const input = {
      ...request(),
      credential: { ...credential, ...change },
    } as unknown as CredentialMutationRequest;
    const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
      .mutate(input, new AbortController().signal);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, code);
    assert.equal(fixture.classificationCalls, 0);
  }
});

test("fresh-create switches and submits through two independently classified operations", async () => {
  const fixture = accountFixture([
    "existing_account",
    "create_account",
    "create_account",
    "verification_required",
  ]);
  const events: string[] = [];
  const adapter = createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    trace: (event) => events.push(event),
  });
  const switched = await adapter.lifecycle.mutate(
    request("create_account"),
    new AbortController().signal,
  );
  const result = await adapter.lifecycle.mutate({
    ...request("create_account"),
    operationId: "operation_account_entry_0002" as never,
  }, new AbortController().signal);

  assert.deepEqual(switched, {
    ok: true,
    value: { kind: "create_account_required", attemptedFields: ["email", "password"] },
  });
  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: "verification_required",
      attemptedFields: ["email", "password"],
    },
  });
  assert.deepEqual(fixture.operations, [
    "inspectAction:show_create_account",
    "activate:show_create_account",
    "inspectField:email",
    "inspectField:password",
    "inspectField:password_confirmation",
    "inspectAction:accept_terms",
    "inspectAction:submit_create_account",
    "fill:email",
    "matches:email",
    "fill:password",
    "matches:password",
    "fill:password_confirmation",
    "matches:password_confirmation",
    "activate:accept_terms",
    "inspectAction:submit_create_account",
    "activate:submit_create_account",
  ]);
  assert.equal(fixture.classificationCalls, 4);
  assert.equal(fixture.resolverCalls, 1);
  assert.deepEqual(events.slice(0, 3), [
    "initial_state_existing_account",
    "owned_access_started",
    "account_mode_switched_to_create_account",
  ]);
});

test("create-account that reaches sign-in reports the next required page", async () => {
  const fixture = accountFixture(["create_account", "existing_account"]);
  const events: string[] = [];

  const adapter = createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    trace: (event) => events.push(event),
  });
  const accountRequest = request("create_account");
  const result = await adapter.lifecycle.mutate(
    accountRequest,
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { kind: "sign_in_required", attemptedFields: ["email", "password"] },
  });
  assert.equal(fixture.operations.some((operation) => operation.startsWith("clear:")), false);
  assert.deepEqual(events.slice(-2), [
    "post_submit_existing_account",
    "post_submit_sign_in_required",
  ]);
  assert.deepEqual(
    await adapter.mutate(accountRequest, new AbortController().signal),
    {
      ok: false,
      error: { code: "credential_mutation_denied", retryable: false },
    },
  );
});

test("sign-in switches and submits through two independently classified operations", async () => {
  const fixture = accountFixture([
    "create_account",
    "existing_account",
    "existing_account",
    "verification_required",
  ]);
  const events: string[] = [];

  const adapter = createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    trace: (event) => events.push(event),
  });
  const switched = await adapter.lifecycle.mutate(
    request("sign_in"),
    new AbortController().signal,
  );
  const result = await adapter.lifecycle.mutate({
    ...request("sign_in"),
    operationId: "operation_account_entry_0002" as never,
  }, new AbortController().signal);

  assert.deepEqual(switched, {
    ok: true,
    value: { kind: "sign_in_required", attemptedFields: ["email", "password"] },
  });
  assert.equal(result.ok && result.value.kind, "verification_required");
  assert.deepEqual(fixture.operations, [
    "inspectAction:show_sign_in",
    "activate:show_sign_in",
    "inspectField:email",
    "inspectField:password",
    "inspectAction:submit_sign_in",
    "fill:email",
    "matches:email",
    "fill:password",
    "matches:password",
    "inspectAction:submit_sign_in",
    "activate:submit_sign_in",
  ]);
  assert.deepEqual(events.slice(0, 3), [
    "initial_state_create_account",
    "owned_access_started",
    "account_mode_switched_to_sign_in",
  ]);
});

test("post-submit exact account facts survive while unchanged entry pages remain denials", async () => {
  for (const [mode, fact, kind] of [
    ["sign_in", "absent", "account_absent"],
    ["create_account", "exists", "account_exists"],
  ] as const) {
    const pageKind = mode === "sign_in" ? "existing_account" : "create_account";
    const fixture = accountFixture([
      pageKind,
      { kind: pageKind, accountFact: fact },
    ]);

    const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
      .lifecycle.mutate(request(mode), new AbortController().signal);

    assert.deepEqual(result, {
      ok: true,
      value: { kind, attemptedFields: ["email", "password"] },
    });
    assert.equal(fixture.operations.includes("clear:email"), true);
    assert.equal(fixture.operations.includes("clear:password"), true);
    assert.equal(
      fixture.operations.includes("clear:password_confirmation"),
      mode === "create_account",
    );
  }
});

test("create-account that remains on an entry state clears every field and is denied", async () => {
  const fixture = accountFixture(["create_account", "create_account"]);

  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("create_account"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_mutation_denied", retryable: false },
  });
  assert.deepEqual(fixture.operations.slice(-6), [
    "clear:password_confirmation",
    "isEmpty:password_confirmation",
    "clear:password",
    "isEmpty:password",
    "clear:email",
    "isEmpty:email",
  ]);
});

test("unchanged entry state with unproven cleanup is effect-uncertain", async () => {
  const fixture = accountFixture(["existing_account", "existing_account"]);
  fixture.emptyResults.set("email", false);

  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_effect_uncertain", retryable: false },
  });
});

test("missing, ambiguous, hidden, and disabled controls deny before secret resolution", async () => {
  for (const fact of [
    { cardinality: 0, actionable: false },
    { cardinality: 2, actionable: true },
    { cardinality: 1, actionable: false },
  ]) {
    const fixture = accountFixture(["existing_account"]);
    fixture.controls.set("email", fact);
    const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
      .mutate(request("sign_in"), new AbortController().signal);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "credential_mutation_denied");
    assert.equal(fixture.resolverCalls, 0);
  }
});

test("a field mismatch clears the exact field and verifies emptiness before denial", async () => {
  const fixture = accountFixture(["existing_account"]);
  fixture.matchResults.set("email", false);
  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_mutation_denied", retryable: false },
  });
  assert.deepEqual(fixture.operations.slice(-4), [
    "fill:email",
    "matches:email",
    "clear:email",
    "isEmpty:email",
  ]);
});

test("a later mismatch clears every previously populated credential field", async () => {
  const fixture = accountFixture(["existing_account"]);
  fixture.matchResults.set("password", false);
  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("sign_in"), new AbortController().signal);

  assert.equal(result.ok, false);
  assert.deepEqual(fixture.operations.slice(-6), [
    "fill:password",
    "matches:password",
    "clear:password",
    "isEmpty:password",
    "clear:email",
    "isEmpty:email",
  ]);
});

test("a submit denial after verified fills clears every credential field", async () => {
  const fixture = accountFixture(["existing_account"]);
  fixture.access.activate = async (action) => {
    fixture.operations.push(`activate:${action}`);
    return {
      ok: false,
      error: { code: "browser_target_invalid", retryable: false },
    };
  };
  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_mutation_denied", retryable: false },
  });
  assert.deepEqual(fixture.operations.slice(-5), [
    "activate:submit_sign_in",
    "clear:password",
    "isEmpty:password",
    "clear:email",
    "isEmpty:email",
  ]);
});

test("a submit that becomes disabled after verified fills is traced and never activated", async () => {
  const fixture = accountFixture(["existing_account"]);
  const events: string[] = [];
  let submitInspections = 0;
  fixture.access.inspectAction = async (action) => {
    fixture.operations.push(`inspectAction:${action}`);
    if (action === "submit_sign_in" && ++submitInspections === 2) {
      return { ok: true, value: { cardinality: 1, actionable: false } };
    }
    return { ok: true, value: fixture.controls.get(action)! };
  };

  const result = await createAccountEntryCredentialMutationAdapter({
    ...fixture.dependencies,
    trace: (event) => events.push(event),
  }).mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_mutation_denied", retryable: false },
  });
  assert.equal(fixture.operations.includes("activate:submit_sign_in"), false);
  assert.deepEqual(events.slice(-2), [
    "submit_reinspect_failed",
    "cleanup_succeeded",
  ]);
});

test("a field that cannot be proven empty is effect-uncertain", async () => {
  const fixture = accountFixture(["existing_account"]);
  fixture.matchResults.set("email", false);
  fixture.emptyResults.set("email", false);
  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("sign_in"), new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_effect_uncertain", retryable: false },
  });
});

test("identical concurrent and later replays share one mutation; changed reuse is uncertain", async () => {
  const fixture = accountFixture(["existing_account", "application_ready"]);
  const adapter = createAccountEntryCredentialMutationAdapter(fixture.dependencies);
  const input = request("sign_in");
  const first = adapter.mutate(input, new AbortController().signal);
  const concurrent = adapter.mutate(input, new AbortController().signal);
  assert.equal(first, concurrent);
  const [left, right] = await Promise.all([first, concurrent]);
  assert.deepEqual(left, right);
  assert.equal(fixture.resolverCalls, 1);
  assert.deepEqual(await adapter.mutate(input, new AbortController().signal), left);
  assert.equal(fixture.resolverCalls, 1);

  const conflict = await adapter.mutate(
    { ...input, mode: "create_account" },
    new AbortController().signal,
  );
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: "credential_effect_uncertain", retryable: false },
  });
});

test("cancellation before any possible effect is exact and does not inspect the page", async () => {
  const fixture = accountFixture(["existing_account"]);
  const controller = new AbortController();
  controller.abort();
  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("sign_in"), controller.signal);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "operation_cancelled", retryable: false },
  });
  assert.equal(fixture.classificationCalls, 0);
  assert.equal(fixture.resolverCalls, 0);
});

test("timeout or ownership loss around a possible field effect is uncertain", async () => {
  for (const code of ["browser_timeout", "browser_session_invalidated"] as const) {
    const fixture = accountFixture(["existing_account"]);
    fixture.access.fill = async (field) => {
      fixture.operations.push(`fill:${field}`);
      return code === "browser_timeout"
        ? { ok: false, error: { code, retryable: true } }
        : { ok: false, error: { code, retryable: false } };
    };
    const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
      .mutate(request("sign_in"), new AbortController().signal);
    assert.deepEqual(result, {
      ok: false,
      error: { code: "credential_effect_uncertain", retryable: false },
    });
  }
});

test("an unreconciled post-activation state invalidates as credential-effect uncertainty", async () => {
  const fixture = accountFixture(["existing_account"]);
  let inspections = 0;
  const dependencies: AccountEntryDependencies = {
    ...fixture.dependencies,
    classifiedAccount: {
      inspectClassifiedAccount: async () => {
        inspections += 1;
        return inspections === 1
          ? { ok: true, value: stateObservation("existing_account") }
          : {
              ok: false,
              error: { code: "browser_target_stale", retryable: false },
            };
      },
    },
  };
  const result = await createAccountEntryCredentialMutationAdapter(dependencies)
    .mutate(request("sign_in"), new AbortController().signal);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "credential_effect_uncertain", retryable: false },
  });
});

test("observable results retain no credential or confirmation material", async () => {
  const fixture = accountFixture(["create_account", "application_ready"]);
  const result = await createAccountEntryCredentialMutationAdapter(fixture.dependencies)
    .mutate(request("create_account"), new AbortController().signal);
  assert.doesNotMatch(
    JSON.stringify(result),
    /password_confirmation|credential|secret|\b101\b|\b112\b/iu,
  );
  assert.deepEqual(result, {
    ok: true,
    value: { kind: "application_ready", attemptedFields: ["email", "password"] },
  });
});

type ResolvedStateKind =
  | "existing_account"
  | "create_account"
  | "verification_required"
  | "password_reset_request"
  | "password_reset_email_sent"
  | "password_reset_set"
  | "application_ready";

type ResolvedState = ResolvedStateKind | {
  readonly kind: "existing_account" | "create_account";
  readonly accountFact: "absent" | "exists" | "password_reset_required";
};

function accountFixture(states: readonly ResolvedState[]) {
  const operations: string[] = [];
  const traces: string[] = [];
  let classificationCalls = 0;
  let resolverCalls = 0;
  let index = 0;
  const controls = new Map<AccountFieldName | AccountActionIntent, {
    cardinality: number;
    actionable: boolean;
  }>();
  const matchResults = new Map<AccountFieldName, boolean>();
  const emptyResults = new Map<AccountFieldName, boolean>();
  for (const control of [
    "email",
    "password",
    "password_confirmation",
    "show_sign_in",
    "show_create_account",
    "show_password_reset",
    "submit_sign_in",
    "submit_create_account",
    "submit_password_reset_request",
    "submit_password_reset",
    "accept_terms",
  ] as const) controls.set(control, { cardinality: 1, actionable: true });
  const access: AccountPageAccess = {
    inspectField: async (field) => {
      operations.push(`inspectField:${field}`);
      return { ok: true, value: controls.get(field)! };
    },
    inspectAction: async (action) => {
      operations.push(`inspectAction:${action}`);
      return { ok: true, value: controls.get(action)! };
    },
    fill: async (field) => {
      operations.push(`fill:${field}`);
      return { ok: true, value: undefined };
    },
    matches: async (field) => {
      operations.push(`matches:${field}`);
      return { ok: true, value: matchResults.get(field) ?? true };
    },
    clear: async (field) => {
      operations.push(`clear:${field}`);
      return { ok: true, value: undefined };
    },
    isEmpty: async (field) => {
      operations.push(`isEmpty:${field}`);
      return { ok: true, value: emptyResults.get(field) ?? true };
    },
    activate: async (action) => {
      operations.push(`activate:${action}`);
      return { ok: true, value: undefined };
    },
  };
  const dependencies: AccountEntryDependencies = {
    trace: (event) => traces.push(event),
    classifiedAccount: {
      inspectClassifiedAccount: async () => {
        classificationCalls += 1;
        const state = states[Math.min(index, states.length - 1)]!;
        index += 1;
        return {
          ok: true,
          value: stateObservation(
            typeof state === "string" ? state : state.kind,
            typeof state === "string" ? undefined : state.accountFact,
          ),
        };
      },
    },
    accountPage: {
      withOwnedAccountPageAccess: async (_accountRequest, _signal, use) => {
        try {
          await use(access);
          return { ok: true, value: undefined };
        } catch {
          return {
            ok: false,
            error: { code: "browser_effect_uncertain", retryable: false },
          };
        }
      },
    },
    credentials: {
      useAccountCredentials: async (_handle, _signal, operation) => {
        resolverCalls += 1;
        const email = Uint8Array.from([101]);
        const password = Uint8Array.from([112]);
        try {
          return { ok: true, value: await operation({ email, password }) };
        } finally {
          email.fill(0);
          password.fill(0);
        }
      },
    },
  };
  return {
    dependencies,
    access,
    controls,
    matchResults,
    emptyResults,
    operations,
    traces,
    get classificationCalls() {
      return classificationCalls;
    },
    get resolverCalls() {
      return resolverCalls;
    },
  };
}

function stateObservation(
  kind: ResolvedStateKind,
  accountFact?: "absent" | "exists" | "password_reset_required",
): Extract<ClassifiedAccountObservation, { readonly kind: "classified_account" }> {
  return {
    kind: "classified_account",
    state: {
      kind,
      ...(accountFact === undefined ? {} : { accountFact }),
      classificationId: `classification_account_${kind}_v1` as never,
      sourceRevisionId: "classification_revision_live_entry_v1" as never,
    },
    classificationId: `classification_account_${kind}_v1` as never,
    sourceRevisionId: "classification_revision_live_entry_v1" as never,
    snapshotId: `snapshot_${kind}_0001`,
    documentGenerationId: `document_generation_${kind}_0001`,
  };
}

void providerError;
void (undefined as unknown as LivePortResult<void, PersistentBrowserErrorCode>);
void (undefined as unknown as LivePortResult<void, SecretStoreErrorCode>);
