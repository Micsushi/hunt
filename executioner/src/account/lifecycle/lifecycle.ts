import {
  parseCredentialMutationResult,
  parseMailboxPollResult,
  parseVerificationArtifactMetadata,
} from "../../contracts/live/index.ts";
import { liveCoordinatorError } from "../../control/orchestrator/live/types.ts";
import type {
  AccountLifecycleDependencies,
  AccountLifecycleInput,
  AccountLifecycleResult,
} from "./types.ts";
import {
  blocked,
  classificationBlocked,
  denied,
  frozen,
  mailboxBlocked,
  mailboxInvalid,
  navigationBlocked,
  navigationDenied,
  ready,
  replayed,
  requestFingerprint,
  sameTarget,
  targetBlocked,
  validInstant,
} from "./private/lifecycle-support.ts";

export class AccountVerificationLifecycle {
  readonly #dependencies: AccountLifecycleDependencies;
  readonly #receipts = new Map<AccountLifecycleInput["operationId"], {
    readonly fingerprint: string;
    readonly result: Promise<AccountLifecycleResult>;
  }>();

  constructor(dependencies: AccountLifecycleDependencies) {
    this.#dependencies = dependencies;
  }

  run(
    input: AccountLifecycleInput,
    signal: AbortSignal,
  ): Promise<AccountLifecycleResult> {
    const fingerprint = requestFingerprint(input);
    const existing = this.#receipts.get(input.operationId);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        ? existing.result
        : Promise.resolve(frozen({
          ok: false,
          error: liveCoordinatorError("journey_request_conflict"),
        }));
    }
    const result = this.#execute(input, signal).then(frozen);
    this.#receipts.set(input.operationId, { fingerprint, result });
    return result;
  }

  async #execute(
    input: AccountLifecycleInput,
    signal: AbortSignal,
  ): Promise<AccountLifecycleResult> {
    if (signal.aborted) {
      return { ok: false, error: liveCoordinatorError("operation_cancelled") };
    }
    if (
      input.schemaVersion !== 1 ||
      !validInstant(input.now) ||
      (input.accountIntent !== "sign_in" && input.accountIntent !== "fresh_create")
    ) {
      return { ok: false, error: liveCoordinatorError("mcp_request_invalid") };
    }
    if (input.credential.journeyId !== input.journeyId) {
      return { ok: false, error: liveCoordinatorError("secret_handle_mismatched") };
    }
    if (input.credential.consumer !== "credential_mutation_adapter") {
      return { ok: false, error: liveCoordinatorError("secret_consumer_forbidden") };
    }
    if (
      input.credential.provider !== "windows_dpapi_current_user_v1" ||
      input.credential.purpose !== "account_credentials" ||
      input.credential.state !== "active"
    ) {
      return { ok: false, error: liveCoordinatorError("secret_handle_invalid") };
    }
    if (Date.parse(input.credential.expiresAt) <= Date.parse(input.now)) {
      return { ok: false, error: liveCoordinatorError("secret_handle_expired") };
    }
    if (
      input.session.journeyId !== input.journeyId ||
      !sameTarget(input.session.target, input.target) ||
      Date.parse(input.session.leaseExpiresAt) <= Date.parse(input.now)
    ) {
      return { ok: false, error: liveCoordinatorError("browser_session_invalidated") };
    }
    if (
      input.mailboxRequest.journeyId !== input.journeyId ||
      !sameTarget(input.mailboxRequest.target, input.target) ||
      !validInstant(input.mailboxRequest.notBefore) ||
      !validInstant(input.mailboxRequest.notAfter) ||
      Date.parse(input.mailboxRequest.notBefore) >= Date.parse(input.mailboxRequest.notAfter)
    ) {
      return mailboxInvalid();
    }
    const observed = await this.#dependencies.accountState.observe({
      schemaVersion: 1,
      journeyId: input.journeyId,
      sessionId: input.session.sessionId,
      target: input.target,
    }, signal);
    if (!observed.ok) return observed;
    if (observed.value.kind === "target_mismatch") {
      return targetBlocked({
        kind: observed.value.kind,
        dimension: observed.value.dimension,
      });
    }
    if (observed.value.kind === "target_ambiguous") {
      return targetBlocked({ kind: observed.value.kind });
    }
    if (observed.value.kind === "posting_unavailable") {
      return targetBlocked({
        kind: observed.value.kind,
        reason: observed.value.reason,
      });
    }
    if (observed.value.kind === "classification_stopped") {
      if (
        observed.value.outcome === "ats_unsupported" ||
        observed.value.outcome === "ats_unknown" ||
        observed.value.outcome === "ats_ambiguous"
      ) {
        return classificationBlocked("ats_family", observed.value.outcome);
      }
      if (
        observed.value.outcome === "workday_page_unknown" ||
        observed.value.outcome === "workday_page_ambiguous"
      ) {
        return classificationBlocked("workday_page_type", observed.value.outcome);
      }
    }
    if (
      observed.value.kind === "classified_account" &&
      observed.value.state.kind === "manual_intervention"
    ) {
      return blocked("account_access", {
        kind: "manual_intervention",
        reason: observed.value.state.reason,
      });
    }
    if (
      observed.value.kind === "classified_account" &&
      observed.value.state.kind === "application_ready"
    ) {
      return ready("already_ready", 0, false);
    }
    if (
      observed.value.kind === "classified_account" &&
      observed.value.state.kind === "verification_required"
    ) {
      return this.#verify(input, signal);
    }
    if (
      observed.value.kind !== "classified_account" ||
      (observed.value.state.kind !== "existing_account" &&
        observed.value.state.kind !== "create_account")
    ) return denied();
    return this.#signIn(input, signal);
  }

  async #signIn(
    input: AccountLifecycleInput,
    signal: AbortSignal,
  ): Promise<AccountLifecycleResult> {
    const mutation = await this.#credentialMutation(
      input,
      signal,
      "sign_in",
      input.operations.initialCredentialMutation,
    );
    if (!mutation.ok) return mutation;
    let result;
    try {
      result = parseCredentialMutationResult(mutation.value);
    } catch {
      return denied();
    }
    if (result.kind === "manual_intervention") {
      return blocked("account_access", {
        kind: "manual_intervention",
        reason: result.reason,
      });
    }
    if (result.kind === "verification_required") return this.#verify(input, signal);
    if (result.kind === "application_ready") {
      return this.#confirmReady(input, signal, "reused_account");
    }
    if (result.kind !== "account_absent" || input.accountIntent !== "fresh_create") {
      return denied();
    }
    const confirmed = await this.#observe(input, signal);
    if (!confirmed.ok) return confirmed;
    if (
      confirmed.value.kind !== "classified_account" ||
      confirmed.value.state.kind !== "existing_account" ||
      confirmed.value.state.accountFact !== "absent"
    ) return denied();
    return this.#create(input, signal);
  }

  async #create(
    input: AccountLifecycleInput,
    signal: AbortSignal,
  ): Promise<AccountLifecycleResult> {
    const mutation = await this.#credentialMutation(
      input,
      signal,
      "create_account",
      input.operations.createCredentialMutation,
    );
    if (!mutation.ok) return mutation;
    let result;
    try {
      result = parseCredentialMutationResult(mutation.value);
    } catch {
      return denied();
    }
    if (result.kind === "manual_intervention") {
      return blocked("account_access", {
        kind: "manual_intervention",
        reason: result.reason,
      });
    }
    if (result.kind === "verification_required") return this.#verify(input, signal);
    if (result.kind === "application_ready") {
      return this.#confirmReady(input, signal, "created_account");
    }
    if (result.kind !== "account_exists") return denied();
    const confirmed = await this.#observe(input, signal);
    if (!confirmed.ok) return confirmed;
    if (
      confirmed.value.kind !== "classified_account" ||
      confirmed.value.state.kind !== "create_account" ||
      confirmed.value.state.accountFact !== "exists"
    ) return denied();
    const signedIn = await this.#credentialMutation(
      input,
      signal,
      "sign_in",
      input.operations.accountExistsSignIn,
    );
    if (!signedIn.ok) return signedIn;
    let signInResult;
    try {
      signInResult = parseCredentialMutationResult(signedIn.value);
    } catch {
      return denied();
    }
    if (signInResult.kind === "manual_intervention") {
      return blocked("account_access", {
        kind: "manual_intervention",
        reason: signInResult.reason,
      });
    }
    if (signInResult.kind === "verification_required") return this.#verify(input, signal);
    return signInResult.kind === "application_ready"
      ? this.#confirmReady(input, signal, "reused_account")
      : denied();
  }

  #credentialMutation(
    input: AccountLifecycleInput,
    signal: AbortSignal,
    mode: "sign_in" | "create_account",
    operationId: AccountLifecycleInput["operationId"],
  ) {
    return this.#dependencies.credentialMutation.mutate({
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId,
      sessionId: input.session.sessionId,
      target: input.target,
      now: input.now,
      mode,
      credential: input.credential,
      fields: ["email", "password"],
    }, signal);
  }

  #observe(input: AccountLifecycleInput, signal: AbortSignal) {
    return this.#dependencies.accountState.observe({
      schemaVersion: 1,
      journeyId: input.journeyId,
      sessionId: input.session.sessionId,
      target: input.target,
    }, signal);
  }

  async #confirmReady(
    input: AccountLifecycleInput,
    signal: AbortSignal,
    path: "reused_account" | "created_account",
  ): Promise<AccountLifecycleResult> {
    const confirmed = await this.#observe(input, signal);
    if (!confirmed.ok) return confirmed;
    return confirmed.value.kind === "classified_account" &&
        confirmed.value.state.kind === "application_ready"
      ? ready(path, 0, false)
      : denied();
  }

  async #verify(
    input: AccountLifecycleInput,
    signal: AbortSignal,
  ): Promise<AccountLifecycleResult> {
    const polled = await this.#dependencies.mailbox.poll(input.mailboxRequest, signal);
    if (!polled.ok) return polled;
    let mailbox;
    try {
      mailbox = parseMailboxPollResult(polled.value);
    } catch {
      return mailboxInvalid();
    }
    if (mailbox.candidateCount === 0) return mailboxBlocked("mailbox_none");
    if (mailbox.candidateCount > 1) return mailboxBlocked("mailbox_ambiguous");
    if (mailbox.verificationHandle === null) return mailboxBlocked("mailbox_consumed");
    if (
      mailbox.expiresAt === null ||
      Date.parse(mailbox.expiresAt) <= Date.parse(input.now)
    ) {
      return mailboxBlocked("mailbox_expired");
    }
    const inspected = await this.#dependencies.artifacts.inspect({
      schemaVersion: 1,
      journeyId: input.journeyId,
      handleId: mailbox.verificationHandle,
      expectedRecipientBindingId: input.mailboxRequest.recipientBindingId,
      expectedTarget: input.target,
    }, signal);
    if (!inspected.ok) return inspected;
    let artifact;
    try {
      artifact = parseVerificationArtifactMetadata(inspected.value);
    } catch {
      return mailboxInvalid();
    }
    if (
      artifact.handleId !== mailbox.verificationHandle ||
      artifact.journeyId !== input.journeyId ||
      artifact.recipientBindingId !== input.mailboxRequest.recipientBindingId ||
      !sameTarget(artifact.target, input.target)
    ) {
      return replayed();
    }
    if (artifact.state === "expired") return mailboxBlocked("mailbox_expired");
    if (artifact.state !== "available") return mailboxBlocked("mailbox_consumed");
    const navigated = await this.#dependencies.navigator.navigate({
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId: input.operations.navigateVerification,
      sessionId: input.session.sessionId,
      expectedRecipientBindingId: input.mailboxRequest.recipientBindingId,
      expectedTarget: input.target,
      now: input.now,
      artifact: { ...artifact, state: "available" },
    }, signal);
    if (!navigated.ok) return navigated;
    if (navigated.value.kind === "target_unavailable") {
      return navigationBlocked();
    }
    if (navigated.value.kind !== "navigated") {
      return navigationDenied();
    }
    const confirmed = await this.#dependencies.accountState.observe({
      schemaVersion: 1,
      journeyId: input.journeyId,
      sessionId: input.session.sessionId,
      target: input.target,
    }, signal);
    if (!confirmed.ok) return confirmed;
    if (confirmed.value.kind !== "classified_account") return denied();
    if (confirmed.value.state.kind === "application_ready") {
      return ready("verified_account", 1, true);
    }
    if (confirmed.value.state.kind === "manual_intervention") {
      return blocked("account_access", {
        kind: "manual_intervention",
        reason: confirmed.value.state.reason,
      });
    }
    if (confirmed.value.state.kind !== "existing_account") return denied();
    const signedIn = await this.#dependencies.credentialMutation.mutate({
      schemaVersion: 1,
      journeyId: input.journeyId,
      operationId: input.operations.postVerificationSignIn,
      sessionId: input.session.sessionId,
      target: input.target,
      now: input.now,
      mode: "sign_in",
      credential: input.credential,
      fields: ["email", "password"],
    }, signal);
    if (!signedIn.ok) return signedIn;
    try {
      const result = parseCredentialMutationResult(signedIn.value);
      if (result.kind === "manual_intervention") {
        return blocked("account_access", {
          kind: "manual_intervention",
          reason: result.reason,
        });
      }
      if (result.kind !== "application_ready") return denied();
    } catch {
      return denied();
    }
    const final = await this.#dependencies.accountState.observe({
      schemaVersion: 1,
      journeyId: input.journeyId,
      sessionId: input.session.sessionId,
      target: input.target,
    }, signal);
    if (!final.ok) return final;
    return final.value.kind === "classified_account" &&
        final.value.state.kind === "application_ready"
      ? ready("verified_account", 1, true)
      : denied();
  }
}
