import type {
  CredentialMutationAdapter,
  CredentialMutationErrorCode,
  LivePortResult,
  PersistentBrowserErrorCode,
} from "../../contracts/live/index.ts";
import { s2StableErrorPolicy } from "../../contracts/s2-common-wire.ts";
import {
  accountStateResult,
  accountFactResult,
  type AccountEntryCredentialMutationAdapter,
  type AccountLifecycleCredentialMutationResult,
  type AccountLifecycleCredentialMutationRequest,
  type AccountActionIntent,
  type AccountEntryDependencies,
  type AccountEntryTraceEvent,
  type AccountFieldName,
  type AccountPageAccess,
  type ClassifiedAccountObservation,
} from "./types.ts";

type MutationResult = LivePortResult<
  AccountLifecycleCredentialMutationResult,
  CredentialMutationErrorCode
>;
type MutationFailure = Extract<MutationResult, { readonly ok: false }>;

export function createAccountEntryCredentialMutationAdapter(
  dependencies: AccountEntryDependencies,
): AccountEntryCredentialMutationAdapter {
  const operations = new Map<string, {
    readonly fingerprint: string;
    readonly result: Promise<MutationResult>;
  }>();
  const lifecycle = Object.freeze({
    mutate(request: AccountLifecycleCredentialMutationRequest, signal: AbortSignal): Promise<MutationResult> {
      const fingerprint = JSON.stringify(request);
      const previous = operations.get(request.operationId);
      if (previous !== undefined) {
        return previous.fingerprint === fingerprint
          ? previous.result
          : Promise.resolve(failure("credential_effect_uncertain"));
      }
      const result = mutateOnce(dependencies, request, signal);
      operations.set(request.operationId, { fingerprint, result });
      return result;
    },
  });
  const publicResults = new WeakMap<
    Promise<MutationResult>,
    ReturnType<CredentialMutationAdapter["mutate"]>
  >();
  const adapter: AccountEntryCredentialMutationAdapter = {
    lifecycle,
    mutate(request, signal) {
      const internal = lifecycle.mutate(request, signal);
      const replay = publicResults.get(internal);
      if (replay !== undefined) return replay;
      const result = internal.then((settled) => {
        if (
          settled.ok &&
          (settled.value.kind === "account_absent" ||
            settled.value.kind === "account_exists" ||
            settled.value.kind === "sign_in_required" ||
            settled.value.kind === "create_account_required" ||
            settled.value.kind === "password_reset_required" ||
            settled.value.kind === "password_reset_request" ||
            settled.value.kind === "password_reset_email_sent" ||
            settled.value.kind === "password_reset_set" ||
            settled.value.kind === "navigation_required")
        ) return failure("credential_mutation_denied");
        return settled as Awaited<ReturnType<CredentialMutationAdapter["mutate"]>>;
      });
      publicResults.set(internal, result);
      return result;
    },
  };
  return Object.freeze(adapter);
}

async function mutateOnce(
  dependencies: AccountEntryDependencies,
  request: AccountLifecycleCredentialMutationRequest,
  signal: AbortSignal,
): Promise<MutationResult> {
  if (signal.aborted) return cancelled();
  const admitted = admitRequest(request);
  if (admitted !== undefined) return admitted;
  const initial = await classify(dependencies, request, signal);
  if (!initial.ok) return mapReadFailure(initial.error.code);
  if (initial.value.kind !== "classified_account") {
    return failure("credential_mutation_denied");
  }
  emit(
    dependencies,
    initialStateEvent(initial.value.state),
  );
  if (noSecretState(initial.value)) {
    return { ok: true, value: accountStateResult(initial.value.state, []) };
  }

  let state = initial.value;
  let result: AccountLifecycleCredentialMutationResult | undefined;
  let localFailure: MutationFailure | undefined;
  const page = await dependencies.accountPage.withOwnedAccountPageAccess(
    {
      schemaVersion: 1,
      journeyId: request.journeyId,
      operationId: request.operationId,
      sessionId: request.sessionId,
      target: request.target,
      now: request.now,
    },
    signal,
    async (access) => {
      emit(dependencies, "owned_access_started");
      if (passwordResetMode(request.mode)) {
        const reset = await mutatePasswordReset(dependencies, request, state, access, signal);
        if (reset.ok) result = reset.value;
        else localFailure = reset;
        return;
      }
      const expected = request.mode === "sign_in"
        ? "existing_account"
        : "create_account";
      if (state.state.kind !== expected) {
        const action = request.mode === "sign_in"
          ? "show_sign_in"
          : "show_create_account";
        const admitted = await uniqueActionableAction(access, action);
        if (!admitted.ok) {
          localFailure = mapBrowserFailure(admitted.error.code);
          return;
        }
        const activated = await access.activate(action);
        if (!activated.ok) {
          localFailure = mapBrowserFailure(activated.error.code);
          return;
        }
        const switched = await classify(dependencies, request, signal);
        if (!switched.ok || switched.value.kind !== "classified_account") {
          throw new Error("account switch could not be reconciled");
        }
        state = switched.value;
        if (noSecretState(state)) {
          result = accountStateResult(state.state, []);
          return;
        }
        if (state.state.kind !== expected) {
          throw new Error("account switch reached an unexpected state");
        }
        if (request.mode === "sign_in") {
          emit(dependencies, "account_mode_switched_to_sign_in");
        } else {
          emit(dependencies, "account_mode_switched_to_create_account");
        }
        result = {
          kind: request.mode === "sign_in"
            ? "sign_in_required"
            : "create_account_required",
          attemptedFields: ["email", "password"],
        };
        return;
      }

      const fields = request.mode === "sign_in"
        ? (["email", "password"] as const)
        : (["email", "password", "password_confirmation"] as const);
      const submit = request.mode === "sign_in"
        ? "submit_sign_in"
        : "submit_create_account";
      const admittedControls = await admitCredentialFields(
        dependencies,
        access,
        fields,
        signal,
      );
      if (!admittedControls.ok) {
        localFailure = mapBrowserFailure(admittedControls.error.code);
        return;
      }
      emit(dependencies, "fields_admitted");
      let acceptTerms = false;
      if (request.mode === "create_account") {
        const consent = await access.inspectAction("accept_terms");
        if (!consent.ok) {
          localFailure = mapBrowserFailure(consent.error.code);
          return;
        }
        if (consent.value.cardinality > 1 ||
          (consent.value.cardinality === 1 && !consent.value.actionable)) {
          localFailure = failure("credential_mutation_denied");
          return;
        }
        acceptTerms = consent.value.cardinality === 1;
      }
      const admittedSubmit = await admitCredentialAction(
        dependencies,
        access,
        submit,
        signal,
      );
      if (!admittedSubmit.ok) {
        localFailure = mapBrowserFailure(admittedSubmit.error.code);
        return;
      }
      const resolved = await dependencies.credentials.useAccountCredentials(
        request.credential,
        signal,
        async (credential) => {
          emit(dependencies, "credentials_resolved");
          const populated: AccountFieldName[] = [];
          const email = await fillAndVerify(access, "email", credential.email);
          if (!email.ok) {
            localFailure = email.failure;
            return accountStateResult(state.state, []);
          }
          emit(dependencies, "email_verified");
          populated.push("email");
          const password = await fillAndVerify(access, "password", credential.password);
          if (!password.ok) {
            localFailure = await cleanupPopulated(access, populated, dependencies)
              ? password.failure
              : failure("credential_effect_uncertain");
            return accountStateResult(state.state, ["email"]);
          }
          emit(dependencies, "password_verified");
          populated.push("password");
          if (request.mode === "create_account") {
            const confirmation = await fillAndVerify(
              access,
              "password_confirmation",
              credential.password,
            );
            if (!confirmation.ok) {
              localFailure = await cleanupPopulated(access, populated, dependencies)
                ? confirmation.failure
                : failure("credential_effect_uncertain");
              return accountStateResult(state.state, ["email", "password"]);
            }
            populated.push("password_confirmation");
            if (acceptTerms) {
              const accepted = await access.activate("accept_terms");
              if (!accepted.ok) {
                localFailure = await cleanupPopulated(access, populated, dependencies)
                  ? mapBrowserFailure(accepted.error.code)
                  : failure("credential_effect_uncertain");
                return accountStateResult(
                  state.state,
                  ["email", "password"],
                );
              }
            }
          }
          const finalSubmit = await uniqueActionableAction(access, submit);
          if (!finalSubmit.ok) {
            emit(dependencies, "submit_reinspect_failed");
            localFailure = await cleanupPopulated(access, populated, dependencies)
              ? mapBrowserFailure(finalSubmit.error.code)
              : failure("credential_effect_uncertain");
            return accountStateResult(state.state, ["email", "password"]);
          }
          emit(dependencies, "submit_reinspect_succeeded");
          emit(dependencies, "account_submit_activate_started");
          const activated = await access.activate(submit);
          if (!activated.ok) {
            emit(dependencies, "account_submit_activate_failed");
            const activationFailure = mapBrowserFailure(activated.error.code);
            localFailure = await cleanupPopulated(access, populated, dependencies)
              ? activationFailure
              : failure("credential_effect_uncertain");
            return accountStateResult(state.state, ["email", "password"]);
          }
          emit(dependencies, "account_submit_activated");
          emit(dependencies, "post_submit_classify_started");
          const reconciled = await classifyAfterSubmit(dependencies, request, signal);
          if (
            reconciled.ok && reconciled.value.kind === "classification_stopped" &&
            reconciled.value.pageType === "job_posting"
          ) {
            emit(dependencies, "post_submit_navigation_required");
            result = {
              kind: "navigation_required",
              pageType: "job_posting",
              attemptedFields: ["email", "password"],
            };
            return accountStateResult(state.state, ["email", "password"]);
          }
          if (!reconciled.ok || reconciled.value.kind !== "classified_account") {
            emit(dependencies, "post_submit_classify_failed");
            localFailure = failure("credential_effect_uncertain");
            return accountStateResult(state.state, ["email", "password"]);
          }
          const factualResult = accountFactResult(reconciled.value.state);
          emit(dependencies, postSubmitEvent(
            factualResult?.kind ?? reconciled.value.state.kind,
          ));
          if (factualResult !== undefined) {
            if (!await cleanupPopulated(access, populated, dependencies)) {
              localFailure = failure("credential_effect_uncertain");
              return accountStateResult(reconciled.value.state, ["email", "password"]);
            }
            result = factualResult;
            return accountStateResult(reconciled.value.state, ["email", "password"]);
          }
          if (
            request.mode === "create_account" &&
            reconciled.value.state.kind === "existing_account"
          ) {
            emit(dependencies, "post_submit_sign_in_required");
            result = {
              kind: "sign_in_required",
              attemptedFields: ["email", "password"],
            };
            return accountStateResult(reconciled.value.state, ["email", "password"]);
          }
          if (
            reconciled.value.state.kind === "existing_account" ||
            reconciled.value.state.kind === "create_account"
          ) {
            emit(dependencies, "post_submit_no_progress");
            localFailure = await cleanupPopulated(access, populated, dependencies)
              ? failure("credential_mutation_denied")
              : failure("credential_effect_uncertain");
            return accountStateResult(
              reconciled.value.state,
              ["email", "password"],
            );
          }
          return accountStateResult(
            reconciled.value.state,
            ["email", "password"],
          );
        },
      );
      if (!resolved.ok) localFailure = copyFailure(resolved);
      else if (localFailure === undefined && result === undefined) result = resolved.value;
    },
  );
  if (!page.ok) {
    emit(dependencies, "page_scope_failed");
    return mapBrowserFailure(page.error.code);
  }
  if (localFailure !== undefined) return localFailure;
  return result === undefined
    ? failure("credential_mutation_denied")
    : { ok: true, value: result };
}

async function cleanupPopulated(
  access: AccountPageAccess,
  populated: readonly AccountFieldName[],
  dependencies: AccountEntryDependencies,
): Promise<boolean> {
  let clean = true;
  for (const field of [...populated].reverse()) {
    const cleared = await access.clear(field);
    if (!cleared.ok) {
      emit(dependencies, "cleanup_clear_failed");
      clean = false;
      continue;
    }
    const empty = await access.isEmpty(field);
    if (!empty.ok || !empty.value) {
      emit(dependencies, "cleanup_empty_failed");
      clean = false;
    }
  }
  emit(dependencies, clean ? "cleanup_succeeded" : "cleanup_failed");
  return clean;
}

function passwordResetMode(
  mode: AccountLifecycleCredentialMutationRequest["mode"],
): mode is "show_password_reset" | "request_password_reset" | "complete_password_reset" {
  return mode === "show_password_reset" ||
    mode === "request_password_reset" ||
    mode === "complete_password_reset";
}

async function mutatePasswordReset(
  dependencies: AccountEntryDependencies,
  request: AccountLifecycleCredentialMutationRequest,
  state: Extract<ClassifiedAccountObservation, { readonly kind: "classified_account" }>,
  access: AccountPageAccess,
  signal: AbortSignal,
): Promise<MutationResult> {
  if (request.mode === "show_password_reset") {
    if (
      state.state.kind !== "existing_account" ||
      state.state.accountFact !== "password_reset_required"
    ) return failure("credential_mutation_denied");
    const admitted = await uniqueActionableAction(access, "show_password_reset");
    if (!admitted.ok) return mapBrowserFailure(admitted.error.code);
    const activated = await access.activate("show_password_reset");
    if (!activated.ok) return mapBrowserFailure(activated.error.code);
    const observed = await classifyAfterSubmit(
      dependencies,
      request,
      signal,
      (candidate) => candidate.kind === "existing_account" &&
        candidate.accountFact === "password_reset_required",
    );
    return observed.ok && observed.value.kind === "classified_account" &&
        observed.value.state.kind === "password_reset_request"
      ? { ok: true, value: { kind: "password_reset_request", attemptedFields: ["email", "password"] } }
      : failure("credential_mutation_denied");
  }

  if (request.mode === "request_password_reset") {
    if (state.state.kind !== "password_reset_request") {
      return failure("credential_mutation_denied");
    }
    const field = await uniqueActionableField(access, "email");
    const submit = await uniqueActionableAction(access, "submit_password_reset_request");
    if (!field.ok) return mapBrowserFailure(field.error.code);
    if (!submit.ok) return mapBrowserFailure(submit.error.code);
    emit(dependencies, "fields_admitted");
    let local: MutationFailure | undefined;
    const resolved = await dependencies.credentials.useAccountCredentials(
      request.credential,
      signal,
      async (credential) => {
        emit(dependencies, "credentials_resolved");
        const filled = await fillAndVerify(access, "email", credential.email);
        if (!filled.ok) local = filled.failure;
        else {
          emit(dependencies, "email_verified");
          emit(dependencies, "account_submit_activate_started");
          const activated = await access.activate("submit_password_reset_request");
          if (!activated.ok) {
            emit(dependencies, "account_submit_activate_failed");
            local = mapBrowserFailure(activated.error.code);
          } else {
            emit(dependencies, "account_submit_activated");
          }
        }
        return { kind: "existing_account" as const, attemptedFields: ["email"] as const };
      },
    );
    if (!resolved.ok) return copyFailure(resolved);
    if (local !== undefined) return local;
    emit(dependencies, "post_submit_classify_started");
    const observed = await classifyAfterSubmit(
      dependencies,
      request,
      signal,
      (candidate) => candidate.kind === "password_reset_request",
    );
    if (!observed.ok || observed.value.kind !== "classified_account") {
      emit(dependencies, "post_submit_classify_failed");
      return failure("credential_mutation_denied");
    }
    emit(dependencies, postSubmitEvent(observed.value.state.kind));
    if (observed.value.state.kind === "password_reset_request") {
      return failure("credential_effect_uncertain");
    }
    return observed.ok && observed.value.kind === "classified_account" &&
        observed.value.state.kind === "password_reset_email_sent"
      ? { ok: true, value: { kind: "password_reset_email_sent", attemptedFields: ["email", "password"] } }
      : failure("credential_mutation_denied");
  }

  if (state.state.kind !== "password_reset_set") {
    return failure("credential_mutation_denied");
  }
  for (const field of ["password", "password_confirmation"] as const) {
    const admitted = await uniqueActionableField(access, field);
    if (!admitted.ok) return mapBrowserFailure(admitted.error.code);
  }
  const submit = await uniqueActionableAction(access, "submit_password_reset");
  if (!submit.ok) return mapBrowserFailure(submit.error.code);
  let local: MutationFailure | undefined;
  const resolved = await dependencies.credentials.useAccountCredentials(
    request.credential,
    signal,
    async (credential) => {
      const populated: AccountFieldName[] = [];
      for (const field of ["password", "password_confirmation"] as const) {
        const filled = await fillAndVerify(access, field, credential.password);
        if (!filled.ok) {
          local = await cleanupPopulated(access, populated, dependencies)
            ? filled.failure
            : failure("credential_effect_uncertain");
          break;
        }
        populated.push(field);
      }
      if (local === undefined) {
        const activated = await access.activate("submit_password_reset");
        if (!activated.ok) local = mapBrowserFailure(activated.error.code);
      }
      return { kind: "existing_account" as const, attemptedFields: ["password"] as const };
    },
  );
  if (!resolved.ok) return copyFailure(resolved);
  if (local !== undefined) return local;
  const observed = await classifyAfterSubmit(
    dependencies,
    request,
    signal,
    (candidate) => candidate.kind === "password_reset_set",
  );
  if (!observed.ok || observed.value.kind !== "classified_account") {
    return failure("credential_mutation_denied");
  }
  if (observed.value.state.kind === "application_ready") {
    return { ok: true, value: { kind: "application_ready", attemptedFields: ["email", "password"] } };
  }
  return observed.value.state.kind === "existing_account"
    ? { ok: true, value: { kind: "sign_in_required", attemptedFields: ["email", "password"] } }
    : failure("credential_mutation_denied");
}

function initialStateEvent(
  state: Extract<ClassifiedAccountObservation, { readonly kind: "classified_account" }>["state"],
): AccountEntryTraceEvent {
  if (state.kind === "existing_account") {
    return state.accountFact === "password_reset_required"
      ? "initial_state_password_reset_required"
      : "initial_state_existing_account";
  }
  if (state.kind === "password_reset_request") return "initial_state_password_reset_request";
  if (state.kind === "password_reset_email_sent") return "initial_state_password_reset_email_sent";
  if (state.kind === "password_reset_set") return "initial_state_password_reset_set";
  return "initial_state_create_account";
}

function postSubmitEvent(
  kind: "existing_account" | "create_account" | "verification_required" |
    "password_reset_required" | "password_reset_request" |
    "password_reset_email_sent" | "password_reset_set" |
    "application_ready" | "manual_intervention" | "account_absent" | "account_exists",
) {
  return `post_submit_${kind}` as const;
}

function emit(
  dependencies: AccountEntryDependencies,
  event: Parameters<NonNullable<AccountEntryDependencies["trace"]>>[0],
): void {
  try {
    dependencies.trace?.(event);
  } catch {
    // Diagnostic observation cannot affect account behavior.
  }
}

function admitRequest(request: AccountLifecycleCredentialMutationRequest): MutationFailure | undefined {
  if (
    request.schemaVersion !== 1 ||
    request.target.schemaVersion !== 1 ||
    request.target.atsFamily !== "workday" ||
    ![
      "sign_in", "create_account", "show_password_reset",
      "request_password_reset", "complete_password_reset",
    ].includes(request.mode) ||
    request.fields.length !== 2 ||
    request.fields[0] !== "email" ||
    request.fields[1] !== "password" ||
    !validTime(request.now)
  ) return failure("credential_mutation_denied");
  const handle = request.credential;
  const state = handle.state as string;
  const consumer = handle.consumer as string;
  if (state === "expired") return failure("secret_handle_expired");
  if (state !== "active") return failure("secret_handle_invalid");
  if (consumer !== "credential_mutation_adapter") {
    return failure("secret_consumer_forbidden");
  }
  if (
    handle.schemaVersion !== 1 ||
    handle.journeyId !== request.journeyId ||
    handle.provider !== "windows_dpapi_current_user_v1" ||
    handle.purpose !== "account_credentials" ||
    !validTime(handle.issuedAt) ||
    !validTime(handle.expiresAt) ||
    Date.parse(handle.issuedAt) >= Date.parse(handle.expiresAt)
  ) return failure("secret_handle_mismatched");
  if (Date.parse(handle.expiresAt) <= Date.parse(request.now)) {
    return failure("secret_handle_expired");
  }
  return undefined;
}

function validTime(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function classify(
  dependencies: AccountEntryDependencies,
  request: AccountLifecycleCredentialMutationRequest,
  signal: AbortSignal,
) {
  return dependencies.classifiedAccount.inspectClassifiedAccount(
    { schemaVersion: 1, sessionId: request.sessionId, target: request.target },
    signal,
  );
}

async function classifyAfterSubmit(
  dependencies: AccountEntryDependencies,
  request: AccountLifecycleCredentialMutationRequest,
  signal: AbortSignal,
  unchangedState?: (
    state: Extract<ClassifiedAccountObservation, { readonly kind: "classified_account" }>["state"],
  ) => boolean,
) {
  const attempts = 80;
  let inspected = await classify(dependencies, request, signal);
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (
      !inspected.ok ||
      (inspected.value.kind === "classified_account" &&
        (unchangedState === undefined || !unchangedState(inspected.value.state))) ||
      inspected.value.kind === "target_mismatch" ||
      inspected.value.kind === "posting_unavailable" ||
      (inspected.value.kind === "classification_stopped" &&
        inspected.value.pageType === "job_posting")
    ) return inspected;
    if (signal.aborted) return inspected;
    emit(dependencies, "post_submit_classify_retry");
    await (dependencies.postSubmitClassificationDelay ?? postSubmitClassificationDelay)();
    inspected = await classify(dependencies, request, signal);
  }
  return inspected;
}

function postSubmitClassificationDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

function noSecretState(
  value: Extract<ClassifiedAccountObservation, { readonly kind: "classified_account" }>,
): boolean {
  return value.state.kind === "application_ready" ||
    value.state.kind === "verification_required" ||
    value.state.kind === "manual_intervention";
}

async function uniqueActionableField(access: AccountPageAccess, field: AccountFieldName) {
  const inspected = await access.inspectField(field);
  return exactControl(inspected);
}

async function uniqueActionableAction(access: AccountPageAccess, action: AccountActionIntent) {
  const inspected = await access.inspectAction(action);
  return exactControl(inspected);
}

async function admitCredentialFields(
  dependencies: AccountEntryDependencies,
  access: AccountPageAccess,
  fields: readonly AccountFieldName[],
  signal: AbortSignal,
): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
  const attempts = 20;
  let last: LivePortResult<void, PersistentBrowserErrorCode> | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) {
      return {
        ok: false,
        error: { code: "operation_cancelled", retryable: false },
      };
    }
    last = undefined;
    for (const field of fields) {
      last = await uniqueActionableField(access, field);
      if (!last.ok) break;
    }
    if (last?.ok === true) return last;
    if (last?.ok === false && last.error.code !== "browser_target_invalid") {
      return last;
    }
    if (attempt + 1 < attempts) {
      await (dependencies.controlAdmissionDelay ?? controlAdmissionDelay)();
    }
  }
  return last ?? {
    ok: false,
    error: { code: "browser_target_invalid", retryable: false },
  };
}

async function admitCredentialAction(
  dependencies: AccountEntryDependencies,
  access: AccountPageAccess,
  action: AccountActionIntent,
  signal: AbortSignal,
): Promise<LivePortResult<void, PersistentBrowserErrorCode>> {
  const attempts = 20;
  let last: LivePortResult<void, PersistentBrowserErrorCode> | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) {
      return {
        ok: false,
        error: { code: "operation_cancelled", retryable: false },
      };
    }
    last = await uniqueActionableAction(access, action);
    if (last.ok || last.error.code !== "browser_target_invalid") return last;
    if (attempt + 1 < attempts) {
      await (dependencies.controlAdmissionDelay ?? controlAdmissionDelay)();
    }
  }
  return last ?? {
    ok: false,
    error: { code: "browser_target_invalid", retryable: false },
  };
}

function controlAdmissionDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

function exactControl(
  inspected: Awaited<ReturnType<AccountPageAccess["inspectField"]>>,
): LivePortResult<void, PersistentBrowserErrorCode> {
  if (!inspected.ok) return inspected;
  return inspected.value.cardinality === 1 && inspected.value.actionable
    ? { ok: true, value: undefined }
    : {
        ok: false,
        error: {
          code: inspected.value.cardinality > 1
            ? "browser_target_ambiguous"
            : "browser_target_invalid",
          retryable: false,
        },
      };
}

async function fillAndVerify(
  access: AccountPageAccess,
  field: AccountFieldName,
  value: Readonly<Uint8Array>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: MutationFailure }> {
  const filled = await access.fill(field, value as Uint8Array);
  if (!filled.ok) return { ok: false, failure: mapBrowserFailure(filled.error.code) };
  const matched = await access.matches(field, value as Uint8Array);
  if (!matched.ok) return { ok: false, failure: mapBrowserFailure(matched.error.code) };
  if (matched.value) return { ok: true };
  const cleared = await access.clear(field);
  if (!cleared.ok) return { ok: false, failure: mapBrowserFailure(cleared.error.code) };
  const empty = await access.isEmpty(field);
  if (!empty.ok || !empty.value) {
    return {
      ok: false,
      failure: !empty.ok
        ? mapBrowserFailure(empty.error.code)
        : failure("credential_effect_uncertain"),
    };
  }
  return { ok: false, failure: failure("credential_mutation_denied") };
}

function mapReadFailure(code: string): MutationFailure {
  return code === "operation_cancelled"
    ? cancelled()
    : failure("credential_mutation_denied");
}

function mapBrowserFailure(code: string): MutationFailure {
  if (code === "operation_cancelled") return cancelled();
  return code === "browser_effect_uncertain" ||
      code === "browser_session_invalidated" ||
      code === "browser_timeout"
    ? failure("credential_effect_uncertain")
    : failure("credential_mutation_denied");
}

function copyFailure(
  result: Extract<Awaited<ReturnType<AccountEntryDependencies["credentials"]["useAccountCredentials"]>>, { readonly ok: false }>,
): MutationFailure {
  return { ok: false, error: result.error } as MutationFailure;
}

function failure<const Code extends CredentialMutationErrorCode>(code: Code): MutationFailure {
  return {
    ok: false,
    error: { code, retryable: s2StableErrorPolicy[code].retryable },
  } as MutationFailure;
}

function cancelled(): MutationFailure {
  return { ok: false, error: { code: "operation_cancelled", retryable: false } };
}
