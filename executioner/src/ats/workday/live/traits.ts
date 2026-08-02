import type {
  ClassificationRevisionId,
  StructuralTraitId,
} from "../../../contracts/live/index.ts";

export const LIVE_ENTRY_CLASSIFICATION_REVISION_ID =
  "classification_revision_workday_entry_v1" as ClassificationRevisionId;

export const LIVE_ENTRY_TRAITS = Object.freeze({
  neutral: "structural_trait_neutral_entry_v1" as StructuralTraitId,
  ats: Object.freeze({
    workday: "structural_trait_ats_workday_family_v1" as StructuralTraitId,
    nonWorkday: "structural_trait_ats_non_workday_v1" as StructuralTraitId,
  }),
  pages: Object.freeze({
    job_posting: "structural_trait_page_job_posting_v1" as StructuralTraitId,
    account_entry: "structural_trait_page_account_entry_v1" as StructuralTraitId,
    email_verification: "structural_trait_page_email_verification_v1" as StructuralTraitId,
    candidate_home: "structural_trait_page_candidate_home_v1" as StructuralTraitId,
    profile: "structural_trait_page_profile_step_v1" as StructuralTraitId,
    questionnaire: "structural_trait_page_questionnaire_v1" as StructuralTraitId,
    review: "structural_trait_page_review_step_v1" as StructuralTraitId,
  }),
  account: Object.freeze({
    signIn: "structural_trait_account_sign_in_v1" as StructuralTraitId,
    create: "structural_trait_account_create_v1" as StructuralTraitId,
  }),
  accountFact: Object.freeze({
    absent: "structural_trait_account_absent_v1" as StructuralTraitId,
    exists: "structural_trait_account_exists_v1" as StructuralTraitId,
  }),
  challenge: Object.freeze({
    captcha: "structural_trait_challenge_captcha_v1" as StructuralTraitId,
    mfa: "structural_trait_challenge_mfa_v1" as StructuralTraitId,
    accessControl: "structural_trait_challenge_access_control_v1" as StructuralTraitId,
  }),
});
