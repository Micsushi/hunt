import {
  browserPageId,
  fieldId,
  journeyId,
  questionId,
  type AnswerResolutionResult,
  type FactualTerminalOutcome,
  type PageUnderstandingResult,
  type TerminalResult,
  type VerificationResult,
} from "../../contracts/index.ts";

type PageFact = Exclude<
  PageUnderstandingResult,
  { readonly kind: "understood" }
>;
type AnswerFact = Exclude<
  AnswerResolutionResult,
  { readonly kind: "resolved" }
>;
type VerificationFact = Exclude<
  VerificationResult,
  { readonly kind: "verified" }
>;

export interface FactualTerminalConsumerCase {
  readonly name: string;
  readonly provider:
    | "PageUnderstanding"
    | "AnswerResolver"
    | "FieldVerifier";
  readonly providerResult: PageFact | AnswerFact | VerificationFact;
  readonly factualOutcome: FactualTerminalOutcome;
  readonly terminalize:
    | "immediately"
    | "after_bounded_verification_retry_exhausted";
  readonly blindRemutationAllowed: false;
  readonly stableErrorCode: null;
  readonly failureReportCode: null;
  readonly terminalEvent: {
    readonly component: "F5" | "F6" | "F8";
    readonly phase:
      | "page_understanding"
      | "answer_resolution"
      | "verification";
    readonly step: "classify" | "resolve" | "verify";
    readonly kind: "journey_terminal";
    readonly providerAttributed: true;
    readonly count: 1;
    readonly progressStatus: "blocked";
  };
  readonly durableTransition: {
    readonly status: "blocked";
    readonly order: "before_terminal_publication";
  };
  readonly expectedTerminal: TerminalResult;
}

const consumerJourneyId = journeyId("journey_0123456789abcdef");
const currentPageId = browserPageId("page-questionnaire");
const countryQuestionId = questionId("question-country");
const countryFieldId = fieldId("field-country");

const terminalEvents = {
  page_understanding: {
    component: "F5",
    phase: "page_understanding",
    step: "classify",
    kind: "journey_terminal",
    providerAttributed: true,
    count: 1,
    progressStatus: "blocked",
  },
  answer_resolution: {
    component: "F6",
    phase: "answer_resolution",
    step: "resolve",
    kind: "journey_terminal",
    providerAttributed: true,
    count: 1,
    progressStatus: "blocked",
  },
  verification: {
    component: "F8",
    phase: "verification",
    step: "verify",
    kind: "journey_terminal",
    providerAttributed: true,
    count: 1,
    progressStatus: "blocked",
  },
} as const;

function consumerCase(
  name: string,
  provider: FactualTerminalConsumerCase["provider"],
  factualOutcome: FactualTerminalOutcome,
  terminalize: FactualTerminalConsumerCase["terminalize"] = "immediately",
): FactualTerminalConsumerCase {
  return {
    name,
    provider,
    providerResult: factualOutcome.result,
    factualOutcome,
    terminalize,
    blindRemutationAllowed: false,
    stableErrorCode: null,
    failureReportCode: null,
    terminalEvent: terminalEvents[factualOutcome.source],
    durableTransition: {
      status: "blocked",
      order: "before_terminal_publication",
    },
    expectedTerminal: {
      schemaVersion: 3,
      journeyId: consumerJourneyId,
      status: "blocked",
      completedPages: 0,
      factualOutcome,
    },
  };
}

export const requiredFactualTerminalConsumerCases = [
  consumerCase("page-unknown", "PageUnderstanding", {
    source: "page_understanding",
    result: { kind: "unknown", pageId: currentPageId },
  }),
  consumerCase("page-ambiguous", "PageUnderstanding", {
    source: "page_understanding",
    result: { kind: "ambiguous", pageId: currentPageId },
  }),
  consumerCase("profile-answer-missing", "AnswerResolver", {
    source: "answer_resolution",
    result: {
      kind: "profile_answer_missing",
      questionId: countryQuestionId,
    },
  }),
  consumerCase("unsupported-field", "AnswerResolver", {
    source: "answer_resolution",
    result: { kind: "unsupported", fieldId: countryFieldId },
  }),
  consumerCase("option-no-match", "AnswerResolver", {
    source: "answer_resolution",
    result: { kind: "option_no_match", questionId: countryQuestionId },
  }),
  consumerCase("option-ambiguous", "AnswerResolver", {
    source: "answer_resolution",
    result: { kind: "option_ambiguous", questionId: countryQuestionId },
  }),
  consumerCase(
    "verification-rejected-mismatch",
    "FieldVerifier",
    {
      source: "verification",
      result: {
        kind: "rejected",
        fieldId: countryFieldId,
        reason: "mismatch",
      },
    },
    "after_bounded_verification_retry_exhausted",
  ),
  consumerCase(
    "verification-rejected-stale",
    "FieldVerifier",
    {
      source: "verification",
      result: {
        kind: "rejected",
        fieldId: countryFieldId,
        reason: "stale",
      },
    },
    "after_bounded_verification_retry_exhausted",
  ),
  consumerCase("verification-ambiguous", "FieldVerifier", {
    source: "verification",
    result: { kind: "ambiguous", fieldId: countryFieldId },
  }),
  consumerCase("verification-unavailable", "FieldVerifier", {
    source: "verification",
    result: { kind: "unavailable", fieldId: countryFieldId },
  }),
] as const satisfies readonly FactualTerminalConsumerCase[];
