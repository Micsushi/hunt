import type { ValueFreeOwnedPageSnapshot } from "./types.ts";

const readyTraits = Object.freeze(new Set([
  "structural_trait_page_candidate_home_v1",
  "structural_trait_page_profile_step_v1",
  "structural_trait_page_questionnaire_v1",
  "structural_trait_page_review_step_v1",
]));

const challengeTraits = Object.freeze(new Set([
  "structural_trait_challenge_captcha_v1",
  "structural_trait_challenge_mfa_v1",
  "structural_trait_challenge_access_control_v1",
]));

export function isStablePostVerificationState(
  snapshot: ValueFreeOwnedPageSnapshot,
): boolean {
  const traits = new Set(snapshot.traitIds);
  if ([...challengeTraits].some((trait) => traits.has(trait))) return false;
  const pageTraits = [
    "structural_trait_page_account_entry_v1",
    "structural_trait_page_email_verification_v1",
    ...readyTraits,
  ].filter((trait) => traits.has(trait));
  if (pageTraits.length !== 1) return false;
  if (pageTraits[0] === "structural_trait_page_account_entry_v1") {
    return traits.has("structural_trait_account_sign_in_v1") &&
      !traits.has("structural_trait_account_create_v1");
  }
  return pageTraits[0] === "structural_trait_page_email_verification_v1" ||
    readyTraits.has(pageTraits[0]!);
}
