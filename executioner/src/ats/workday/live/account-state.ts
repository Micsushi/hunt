import type {
  ClassificationId,
  ClassificationRevisionId,
  WorkdayPageType,
} from "../../../contracts/live/index.ts";
import { LIVE_ENTRY_CLASSIFICATION_REVISION_ID, LIVE_ENTRY_TRAITS } from "./traits.ts";

const EMAIL_SIGN_IN_CHOICE_TRAIT =
  "structural_trait_navigation_email_sign_in_choice_v1";

type LiveAccountStateMetadata = {
  readonly classificationId: ClassificationId;
  readonly sourceRevisionId: ClassificationRevisionId;
};

export type ResolvedLiveAccountStateResult = LiveAccountStateMetadata & (
  | {
      readonly kind: "existing_account" | "create_account";
      readonly accountFact?: "absent" | "exists";
    }
  | { readonly kind: "verification_required" | "application_ready" }
  | { readonly kind: "manual_intervention"; readonly reason: "captcha" | "mfa" | "access_control" }
);

export type UnresolvedLiveAccountStateResult = LiveAccountStateMetadata & {
  readonly kind: "account_state_unknown" | "account_state_ambiguous";
};

export type LiveAccountStateResult =
  | ResolvedLiveAccountStateResult
  | UnresolvedLiveAccountStateResult;

const ACCOUNT_CLASSIFICATION_IDS = Object.freeze({
  existing_account: "classification_account_existing_v1",
  create_account: "classification_account_create_v1",
  account_absent: "classification_account_absent_v1",
  account_exists: "classification_account_exists_v1",
  verification_required: "classification_account_verify_v1",
  application_ready: "classification_account_ready_v1",
  manual_intervention_captcha: "classification_account_captcha_v1",
  manual_intervention_mfa: "classification_account_mfa_challenge_v1",
  manual_intervention_access_control: "classification_account_access_v1",
  account_state_unknown: "classification_account_unknown_v1",
  account_state_ambiguous: "classification_account_ambiguous_v1",
}) as unknown as Readonly<Record<
  | "existing_account"
  | "create_account"
  | "account_absent"
  | "account_exists"
  | "verification_required"
  | "application_ready"
  | "manual_intervention_captcha"
  | "manual_intervention_mfa"
  | "manual_intervention_access_control"
  | "account_state_unknown"
  | "account_state_ambiguous",
  ClassificationId
>>;

export function classifyLiveAccountState(
  pageType: WorkdayPageType,
  traitIds: readonly string[],
): LiveAccountStateResult {
  const traits = new Set(traitIds);
  const challenges = [
    ["captcha", LIVE_ENTRY_TRAITS.challenge.captcha],
    ["mfa", LIVE_ENTRY_TRAITS.challenge.mfa],
    ["access_control", LIVE_ENTRY_TRAITS.challenge.accessControl],
  ] as const;
  const challengeMatches = challenges.filter(([, trait]) => traits.has(trait));
  if (challengeMatches.length > 1) return state("account_state_ambiguous");
  if (challengeMatches.length === 1) {
    const reason = challengeMatches[0]![0];
    return Object.freeze({
      kind: "manual_intervention",
      reason,
      classificationId: ACCOUNT_CLASSIFICATION_IDS[`manual_intervention_${reason}`],
      sourceRevisionId: LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
    });
  }
  if (pageType === "account_entry") {
    const signIn = traits.has(LIVE_ENTRY_TRAITS.account.signIn) ||
      traits.has(EMAIL_SIGN_IN_CHOICE_TRAIT);
    const create = traits.has(LIVE_ENTRY_TRAITS.account.create);
    const absent = traits.has(LIVE_ENTRY_TRAITS.accountFact.absent);
    const exists = traits.has(LIVE_ENTRY_TRAITS.accountFact.exists);
    if (
      (signIn && create) ||
      (absent && exists) ||
      (absent && !signIn) ||
      (exists && !create)
    ) return state("account_state_ambiguous");
    if (signIn) return entryState("existing_account", absent ? "absent" : undefined);
    if (create) return entryState("create_account", exists ? "exists" : undefined);
    return state("account_state_unknown");
  }
  if (pageType === "email_verification") return state("verification_required");
  if (["candidate_home", "profile", "questionnaire", "review"].includes(pageType)) {
    return state("application_ready");
  }
  return state("account_state_unknown");
}

function entryState(
  kind: "existing_account" | "create_account",
  accountFact: "absent" | "exists" | undefined,
): ResolvedLiveAccountStateResult {
  return Object.freeze({
    kind,
    ...(accountFact === undefined ? {} : { accountFact }),
    classificationId: ACCOUNT_CLASSIFICATION_IDS[
      accountFact === "absent"
        ? "account_absent"
        : accountFact === "exists"
          ? "account_exists"
          : kind
    ],
    sourceRevisionId: LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
  });
}

function state(
  kind: "existing_account" | "create_account" | "verification_required" |
    "application_ready" | "account_state_unknown" | "account_state_ambiguous",
): LiveAccountStateResult {
  return Object.freeze({
    kind,
    classificationId: ACCOUNT_CLASSIFICATION_IDS[kind] as ClassificationId,
    sourceRevisionId: LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
  });
}
