import type { ValueFreeOwnedPageSnapshot } from "./types.ts";

export type WorkdayAccountNavigationState =
  | { readonly kind: "job_posting" }
  | { readonly kind: "apply_choice" }
  | { readonly kind: "account_boundary" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "invalid" };

const pageTraits = Object.freeze({
  job: "structural_trait_page_job_posting_v1",
  apply: "structural_trait_navigation_apply_choice_v1",
  account: "structural_trait_page_account_entry_v1",
  verification: "structural_trait_page_email_verification_v1",
  candidate: "structural_trait_page_candidate_home_v1",
  profile: "structural_trait_page_profile_step_v1",
  questionnaire: "structural_trait_page_questionnaire_v1",
  review: "structural_trait_page_review_step_v1",
});

const challengeTraits = Object.freeze([
  "structural_trait_challenge_captcha_v1",
  "structural_trait_challenge_mfa_v1",
  "structural_trait_challenge_access_control_v1",
]);

export function classifyWorkdayAccountNavigation(
  snapshot: ValueFreeOwnedPageSnapshot,
): WorkdayAccountNavigationState {
  const traits = new Set(snapshot.traitIds);
  if (challengeTraits.some((trait) => traits.has(trait))) {
    return { kind: "invalid" };
  }
  const pages = Object.entries(pageTraits).filter(([, trait]) => traits.has(trait));
  if (
    pages.length === 2 &&
    traits.has(pageTraits.job) &&
    traits.has(pageTraits.apply)
  ) return { kind: "apply_choice" };
  if (pages.length > 1) return { kind: "ambiguous" };
  if (pages.length === 0) return { kind: "invalid" };
  const page = pages[0]![0];
  if (page === "job") return { kind: "job_posting" };
  if (page === "apply") return { kind: "apply_choice" };
  if (page !== "account") return { kind: "account_boundary" };
  const signIn = traits.has("structural_trait_account_sign_in_v1");
  const create = traits.has("structural_trait_account_create_v1");
  if (signIn && create) return { kind: "ambiguous" };
  return signIn || create ? { kind: "account_boundary" } : { kind: "invalid" };
}
