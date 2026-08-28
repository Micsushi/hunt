import { createHash } from "node:crypto";

import {
  ContractParseError,
  type AnswerProvenance,
  type AnswerResolutionError,
  type BrowserPageId,
  type BrowserSessionId,
  type CancellationError,
  type DriverError,
  type FieldDriver,
  type FieldIntent,
  type FieldObservation,
  type FieldId,
  type FieldVerifier,
  type GuardRevision,
  type JourneyId,
  type OperationId,
  type PortResult,
  type ProfileId,
  type ProfileQuery,
  type QuestionId,
  type ResumeSelection,
  type ResolvedResumeArtifact,
  type SemanticPageSnapshot,
  type VerificationError,
} from "../../../../contracts/index.ts";
import {
  answerLaneAdmitted,
  type AnswerExecutionMode,
  type ApplicationProfileQuery,
} from "../../../../form/answers/application-types.ts";
import type { ApplicationAnswerResolver } from
  "../../../../form/answers/application-types.ts";
import {
  deriveSanitizedUnknownCandidate,
  type ClassificationLayer,
  type SanitizedStructuralObservationV1,
  type SanitizedUnknownCandidateV1,
  type SanitizedUnknownOutcome,
  type UnknownCandidateId,
} from "../../../../contracts/live/index.ts";
import { createApplicationAnswerResolver } from
  "../../../../form/answers/resolver.ts";
import {
  testingQuestionSemanticType,
  type TestingQuestionSemanticType,
} from "../../../../form/answers/testing-policy.ts";
import {
  questionForField,
  resolveQuestion,
} from "../../../../form/questions/catalog.ts";
import { normalizeCatalogText } from "../../../../form/questions/normalize.ts";
import type { ActiveListboxEvidence } from "./active-listbox.ts";
import type { ConfiguredNarrativeProvider } from "./narrative.ts";
import {
  isContractApprovedPrivacyChoice,
  protectedAnswerProvenanceAllowed,
  protectedQuestionCategory,
  type ProtectedQuestionCategory,
} from "./protected.ts";

export {
  resolveActiveListbox,
  type ActiveListboxEvidence,
  type ActiveListboxResolution,
} from "./active-listbox.ts";
export {
  createConfiguredNarrativeProvider,
  type ConfiguredNarrativeProvider,
} from "./narrative.ts";
export type { ProtectedQuestionCategory } from "./protected.ts";

const narrativeQuestionId = "s1-question-configured-narrative" as const;

const canonicalBinaryProfileFacts = new Set([
  "work_authorization", "sponsorship_required", "age_requirement_met",
  "previously_worked_for_organization", "associate_referral", "current_associate",
  "previously_applied", "relatives_employed", "essential_functions_ability",
  "employment_agreement_prevents_employment", "terms_consent",
]);

export function isCanonicalBinaryQuestionnaireLabel(label: string): boolean {
  const definition = questionForField(label, "listbox");
  return definition?.source.kind === "profile" &&
    canonicalBinaryProfileFacts.has(definition.source.factId) &&
    definition.labels.some((candidate) =>
      normalizeCatalogText(candidate) === normalizeCatalogText(label)
    );
}

export interface QuestionnairePageRequest {
  readonly mode: AnswerExecutionMode;
  readonly journeyId: JourneyId;
  readonly sessionId: BrowserSessionId;
  readonly pageId: BrowserPageId;
  readonly guardRevision: GuardRevision;
  readonly profileId: ProfileId;
  readonly profileRevision: number;
  readonly resume: ResumeSelection;
  readonly resumeArtifact: ResolvedResumeArtifact;
  readonly page: SemanticPageSnapshot;
  readonly activeListboxes?: Readonly<Record<string, ActiveListboxEvidence>>;
  readonly conditionalReveal?: boolean;
}

export interface VerifiedQuestionnaireAnswer {
  readonly fieldId: FieldId;
  readonly questionId: QuestionId;
  readonly provenance: AnswerProvenance;
  readonly lane: "live_owner_fact" | "synthetic_test_default";
  readonly protectedCategory: ProtectedQuestionCategory | null;
  readonly templateRevision: string | null;
  readonly verification: "independent";
}

export type QuestionnaireStopCode =
  | "active_listbox_ambiguous"
  | "active_listbox_unavailable"
  | "answer_intent_mismatch"
  | "narrative_ineligible"
  | "narrative_template_mismatch"
  | "option_ambiguous"
  | "option_no_match"
  | "profile_answer_missing"
  | "protected_answer_denied"
  | "question_ambiguous"
  | "question_unknown"
  | "unsupported"
  | "synthetic_test_non_submittable"
  | "verification_ambiguous"
  | "verification_rejected"
  | "verification_unavailable";

export type QuestionnairePageValue =
  | {
      readonly kind: "verified";
      readonly answers: readonly VerifiedQuestionnaireAnswer[];
      readonly protectedPlaceholderCount: 0;
    }
  | {
      readonly kind: "blocked";
      readonly code: QuestionnaireStopCode;
      readonly fieldId: FieldId;
      readonly protectedCategory: ProtectedQuestionCategory | null;
      readonly candidate?: SanitizedUnknownCandidateV1;
      readonly protectedPlaceholderCount?: number;
      readonly placeholderProvenance?: "synthetic_ui_learning";
    };

type QuestionnairePageError =
  | AnswerResolutionError
  | DriverError
  | VerificationError
  | CancellationError
  | {
      readonly code:
        | "questionnaire_candidate_invalid"
        | "questionnaire_page_invalid";
      readonly retryable: false;
    };

export interface QuestionnairePageHandler {
  complete(
    request: QuestionnairePageRequest,
    signal: AbortSignal,
  ): Promise<PortResult<QuestionnairePageValue, QuestionnairePageError>>;
}

export interface QuestionnairePageHandlerDependencies {
  readonly profileQuery: ProfileQuery | ApplicationProfileQuery;
  readonly answerResolver?: ApplicationAnswerResolver;
  readonly driver: FieldDriver;
  readonly verifier: FieldVerifier;
  readonly narrative: ConfiguredNarrativeProvider;
  nextOperationId(): OperationId;
  allocateCandidateId(): UnknownCandidateId;
  observationFor(
    fieldId: FieldId,
    layer: ClassificationLayer,
  ): SanitizedStructuralObservationV1 | undefined;
  readonly previouslyVerified?: (input: {
    readonly pageId: BrowserPageId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
  }) => boolean;
  readonly recordVerified?: (input: {
    readonly pageId: BrowserPageId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
  }) => void;
  readonly recordAnswer?: (input: {
    readonly operationId: OperationId;
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
    readonly lane: "live_owner_fact" | "synthetic_test_default";
    readonly protectedCategory: ProtectedQuestionCategory | null;
    readonly generatedDefault: boolean;
    readonly conditionalReveal?: boolean;
    readonly semanticQuestionType?: TestingQuestionSemanticType;
  }) => void;
  readonly recordAttempt?: (input: {
    readonly operationId: OperationId;
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly intent: FieldIntent;
    readonly lane: "live_owner_fact" | "synthetic_test_default";
    readonly protectedCategory: ProtectedQuestionCategory | null;
    readonly generatedDefault: boolean;
    readonly conditionalReveal?: boolean;
    readonly semanticQuestionType?: TestingQuestionSemanticType;
    readonly syntheticReplacementReason?:
      | "committed_value_adopted"
      | "cached_option_unavailable";
  }) => void;
  readonly recordObserved?: (input: {
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly conditionalReveal?: boolean;
    readonly semanticQuestionType?: TestingQuestionSemanticType;
  }) => void;
  readonly recordUnset?: (input: {
    readonly questionId: QuestionId;
    readonly field: FieldObservation;
    readonly conditionalReveal?: boolean;
    readonly semanticQuestionType?: TestingQuestionSemanticType;
  }) => void;
  readonly recordFailure?: (input: {
    readonly operationId: OperationId;
    readonly code: string;
    readonly retryable: boolean;
    readonly stage: "driver" | "verification";
  }) => void;
}

export function createQuestionnairePageHandler(
  dependencies: QuestionnairePageHandlerDependencies,
): QuestionnairePageHandler {
  if (Object.is(dependencies.driver, dependencies.verifier)) {
    throw new TypeError("driver and verifier must be independent ports");
  }
  const resolver = dependencies.answerResolver ?? createQuestionnaireAnswerResolver({
    profileQuery: dependencies.profileQuery,
    narrative: dependencies.narrative,
  });

  return Object.freeze({
    async complete(
      request: QuestionnairePageRequest,
      signal: AbortSignal,
    ): Promise<PortResult<QuestionnairePageValue, QuestionnairePageError>> {
      if (
        request.page.pageIdentity.kind !== "workday" ||
        request.page.pageIdentity.page !== "questionnaire"
      ) {
        return {
          ok: false,
          error: { code: "questionnaire_page_invalid", retryable: false },
        };
      }

      const answers: VerifiedQuestionnaireAnswer[] = [];
      const mode = request.mode;
      for (const field of request.page.fields) {
        if (field.state === "hidden") continue;
        const question = resolveQuestion(field.label);
        const category = protectedQuestionCategory(
          field.label,
          question.kind === "resolved" ? question.id : undefined,
        );
        const definition = question.kind === "resolved" &&
            field.behavior !== "unsupported"
          ? questionForField(field.label, field.behavior)
          : undefined;
        const resolvedQuestionId = question.kind === "resolved"
          ? question.id as QuestionId
          : observedQuestionId(field.label);
        const recordUnset = () => dependencies.recordUnset?.({
          questionId: resolvedQuestionId,
          field,
          conditionalReveal: request.conditionalReveal ?? false,
          semanticQuestionType: testingQuestionSemanticType(field.label),
        });
        dependencies.recordObserved?.({
          questionId: resolvedQuestionId,
          field,
          conditionalReveal: request.conditionalReveal ?? false,
          semanticQuestionType: testingQuestionSemanticType(field.label),
        });
        const answer = await resolver.resolve({
          mode,
          field,
          profileId: request.profileId,
          profileRevision: request.profileRevision,
          resume: request.resume,
          resumeArtifact: request.resumeArtifact,
        }, signal);
        if (!answer.ok) {
          recordUnset();
          if (
            answer.error.code === "question_unknown" ||
            answer.error.code === "question_ambiguous" ||
            answer.error.code === "protected_answer_denied"
          ) {
            const candidate = answer.error.code === "protected_answer_denied"
              ? undefined
              : candidateFor(
                  dependencies,
                  field.fieldId,
                  "question",
                  answer.error.code,
                );
            if (
              answer.error.code !== "protected_answer_denied" &&
              candidate === undefined
            ) return candidateInvalid();
            return blocked(answer.error.code, field.fieldId, category, candidate);
          }
          return answer;
        }
        if (answer.value.kind === "readback_only") continue;
        if (answer.value.kind !== "resolved") {
          recordUnset();
          const candidate = answer.value.kind === "option_no_match" ||
              answer.value.kind === "option_ambiguous"
            ? candidateFor(
                dependencies,
                field.fieldId,
                "visible_option",
                answer.value.kind,
              )
            : undefined;
          if (
            (answer.value.kind === "option_no_match" ||
              answer.value.kind === "option_ambiguous") &&
            candidate === undefined
          ) return candidateInvalid();
          return blocked(
            answer.value.kind,
            field.fieldId,
            category,
            candidate,
          );
        }
        if (!answerLaneAdmitted(mode, answer.value.lane)) {
          recordUnset();
          return blocked("profile_answer_missing", field.fieldId, category);
        }
        const syntheticLearningDefault =
          mode === "synthetic_test_non_submittable" &&
          answer.value.lane === "synthetic_test_default";
        if (
          category !== null &&
          !syntheticLearningDefault &&
          !protectedAnswerProvenanceAllowed(
            answer.value.intent.provenance,
            definition?.source.kind === "neutral_disclosure" &&
              answer.value.intent.kind === "choice" &&
              isContractApprovedPrivacyChoice(answer.value.intent.expectedOption),
          )
        ) {
          recordUnset();
          return blocked("protected_answer_denied", field.fieldId, category);
        }
        if (
          category !== null &&
          !syntheticLearningDefault &&
          answer.value.intent.kind === "text" &&
          isPlaceholder(answer.value.intent.value)
        ) {
          recordUnset();
          return blocked("protected_answer_denied", field.fieldId, category);
        }
        if (
          answer.value.intent.fieldId !== field.fieldId ||
          answer.value.intent.target !== field.target ||
          answer.value.intent.behavior !== field.behavior
        ) {
          recordUnset();
          return blocked("answer_intent_mismatch", field.fieldId, category);
        }

        const narrative = question.kind === "resolved"
          ? dependencies.narrative.resolve(question.id)
          : undefined;
        if (
          narrative !== undefined &&
          (answer.value.intent.kind !== "text" ||
            answer.value.intent.provenance !== "configured_template" ||
            answer.value.intent.value !== narrative.text)
        ) {
          recordUnset();
          return blocked("narrative_template_mismatch", field.fieldId, category);
        }
        if (
          question.kind === "resolved" &&
          question.id === narrativeQuestionId &&
          narrative === undefined &&
          (
            definition?.source.kind !== "narrative" ||
            answer.value.intent.kind !== "text" ||
            answer.value.intent.provenance !== "reviewed_catalog" ||
            answer.value.intent.value !== definition.source.syntheticDefault
          )
        ) {
          recordUnset();
          return blocked("narrative_template_mismatch", field.fieldId, category);
        }
        if (
          answer.value.intent.provenance === "configured_template" &&
          narrative === undefined
        ) {
          recordUnset();
          return blocked("narrative_ineligible", field.fieldId, category);
        }

        if (dependencies.previouslyVerified?.({
          pageId: request.pageId,
          field,
          intent: answer.value.intent,
        }) === true) {
          if (mode === "live") {
            answers.push(Object.freeze({
              fieldId: field.fieldId,
              questionId: resolvedQuestionId,
              provenance: answer.value.intent.provenance,
              lane: answer.value.lane,
              protectedCategory: category,
              templateRevision: narrative?.revision ?? null,
              verification: "independent",
            }));
          }
          continue;
        }

        const operationId = dependencies.nextOperationId();
        const generatedDefault = question.kind !== "resolved" ||
          answer.value.intent.provenance === "reviewed_catalog" ||
          answer.value.intent.provenance === "visible_option";
        dependencies.recordAttempt?.({
          operationId,
          questionId: resolvedQuestionId,
          field,
          intent: answer.value.intent,
          lane: answer.value.lane,
          protectedCategory: category,
          generatedDefault,
          conditionalReveal: request.conditionalReveal ?? false,
          semanticQuestionType: testingQuestionSemanticType(field.label),
          ...(answer.value.syntheticReplacementReason === undefined
            ? {}
            : { syntheticReplacementReason: answer.value.syntheticReplacementReason }),
        });
        const driven = await dependencies.driver.drive({
          journeyId: request.journeyId,
          sessionId: request.sessionId,
          pageId: request.pageId,
          guardRevision: request.guardRevision,
          operationId,
          intent: answer.value.intent,
        }, signal);
        if (!driven.ok) {
          dependencies.recordFailure?.({
            operationId,
            code: driven.error.code,
            retryable: driven.error.retryable,
            stage: "driver",
          });
          return driven;
        }

        const verified = await dependencies.verifier.verify({
          sessionId: request.sessionId,
          pageId: request.pageId,
          intent: answer.value.intent,
          receipt: driven.value,
        }, signal);
        if (!verified.ok) {
          dependencies.recordFailure?.({
            operationId,
            code: verified.error.code,
            retryable: verified.error.retryable,
            stage: "verification",
          });
          return verified;
        }
        if (verified.value.kind !== "verified") {
          const code = verified.value.kind === "rejected"
            ? "verification_rejected"
            : verified.value.kind === "ambiguous"
              ? "verification_ambiguous"
              : "verification_unavailable";
          dependencies.recordFailure?.({
            operationId,
            code,
            retryable: false,
            stage: "verification",
          });
          return blocked(code, field.fieldId, category);
        }

        dependencies.recordAnswer?.({
          operationId,
          questionId: resolvedQuestionId,
          field,
          intent: answer.value.intent,
          lane: answer.value.lane,
          protectedCategory: category,
          generatedDefault,
        });
        dependencies.recordVerified?.({
          pageId: request.pageId,
          field,
          intent: answer.value.intent,
        });

        if (mode === "live") {
          answers.push(Object.freeze({
            fieldId: field.fieldId,
            questionId: resolvedQuestionId,
            provenance: answer.value.intent.provenance,
            lane: answer.value.lane,
            protectedCategory: category,
            templateRevision: narrative?.revision ?? null,
            verification: "independent",
          }));
        }
      }
      return {
        ok: true,
        value: Object.freeze({
          kind: "verified",
          answers: Object.freeze(answers),
          protectedPlaceholderCount: 0,
        }),
      };
    },
  });
}

export function createQuestionnaireAnswerResolver(input: {
  readonly profileQuery: ProfileQuery | ApplicationProfileQuery;
  readonly narrative: ConfiguredNarrativeProvider;
}): ApplicationAnswerResolver {
  return createApplicationAnswerResolver(
    input.profileQuery,
    input.narrative.resolve(narrativeQuestionId)?.text,
  );
}

function observedQuestionId(label: string): QuestionId {
  return `observed-question-${createHash("sha256").update(label, "utf8").digest("hex").slice(0, 24)}` as QuestionId;
}

function isPlaceholder(value: string): boolean {
  return /^(?:n a|na|none|not applicable|placeholder|tbd|todo|unknown)$/u.test(
    normalizeCatalogText(value),
  );
}

function candidateFor(
  dependencies: QuestionnairePageHandlerDependencies,
  fieldId: FieldId,
  layer: ClassificationLayer,
  outcome: SanitizedUnknownOutcome,
): SanitizedUnknownCandidateV1 | undefined {
  const observation = dependencies.observationFor(fieldId, layer);
  if (observation === undefined) return undefined;
  try {
    return deriveSanitizedUnknownCandidate({
      candidateId: dependencies.allocateCandidateId(),
      observation,
      outcome,
    });
  } catch (error) {
    if (error instanceof ContractParseError) return undefined;
    return undefined;
  }
}

function candidateInvalid(): PortResult<QuestionnairePageValue, QuestionnairePageError> {
  return {
    ok: false,
    error: { code: "questionnaire_candidate_invalid", retryable: false },
  };
}

function blocked(
  code: QuestionnaireStopCode,
  fieldId: FieldId,
  protectedCategory: ProtectedQuestionCategory | null,
  candidate?: SanitizedUnknownCandidateV1,
  placeholderProvenance?: "synthetic_ui_learning",
  protectedPlaceholder = false,
): PortResult<QuestionnairePageValue, never> {
  return {
    ok: true,
    value: Object.freeze({
      kind: "blocked",
      code,
      fieldId,
      protectedCategory,
      ...(candidate === undefined ? {} : { candidate }),
      ...(placeholderProvenance === undefined
        ? {}
        : {
            protectedPlaceholderCount: protectedPlaceholder ? 1 : 0,
            placeholderProvenance,
          }),
    }),
  };
}
