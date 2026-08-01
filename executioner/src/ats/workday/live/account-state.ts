import type {
  ClassificationId,
  ClassificationRevisionId,
  WorkdayPageType,
} from "../../../contracts/live/index.ts";
import { LIVE_ENTRY_CLASSIFICATION_REVISION_ID, LIVE_ENTRY_TRAITS } from "./traits.ts";

type LiveAccountStateMetadata = {
  readonly classificationId: ClassificationId;
  readonly sourceRevisionId: ClassificationRevisionId;
};

export type ResolvedLiveAccountStateResult = LiveAccountStateMetadata & (
  | { readonly kind: "existing_account" | "create_account" | "verification_required" | "application_ready" }
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
    const signIn = traits.has(LIVE_ENTRY_TRAITS.account.signIn);
    const create = traits.has(LIVE_ENTRY_TRAITS.account.create);
    if (signIn && create) return state("account_state_ambiguous");
    if (signIn) return state("existing_account");
    if (create) return state("create_account");
    return state("account_state_unknown");
  }
  if (pageType === "email_verification") return state("verification_required");
  if (["candidate_home", "profile", "questionnaire", "review"].includes(pageType)) {
    return state("application_ready");
  }
  return state("account_state_unknown");
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
