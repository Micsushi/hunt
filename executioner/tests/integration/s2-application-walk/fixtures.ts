import {
  browserPageId,
  fieldId,
  journeyId,
} from "../../../src/contracts/index.ts";

export const walkFixture = {
  journeyId: journeyId("journey_s2_walk_fixture01"),
  pages: {
    resume: browserPageId("s2-resume"),
    profile: browserPageId("s2-profile"),
    questionnaire: browserPageId("s2-questionnaire"),
    pre_review: browserPageId("s2-pre-review"),
  },
  fields: {
    resume: fieldId("resume-artifact"),
    profile: fieldId("contact-email"),
    questionnaire: fieldId("authorization-answer"),
  },
} as const;
