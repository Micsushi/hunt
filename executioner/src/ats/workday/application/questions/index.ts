import {
  ContractParseError,
  type AnswerProvenance,
  type AnswerResolutionError,
  type AnswerResolver,
  type BrowserPageId,
  type BrowserSessionId,
  type CancellationError,
  type DriverError,
  type FieldDriver,
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
  deriveSanitizedUnknownCandidate,
  type ClassificationLayer,
  type SanitizedStructuralObservationV1,
  type SanitizedUnknownCandidateV1,
  type SanitizedUnknownOutcome,
  type UnknownCandidateId,
} from "../../../../contracts/live/index.ts";
import { createAnswerResolver } from "../../../../form/answers/resolver.ts";
import {
  resolveQuestion,
} from "../../../../form/questions/catalog.ts";
import { normalizeCatalogText } from "../../../../form/questions/normalize.ts";
import {
  resolveActiveListbox,
  type ActiveListboxEvidence,
} from "./active-listbox.ts";
import type { ConfiguredNarrativeProvider } from "./narrative.ts";

export {
  resolveActiveListbox,
  type ActiveListboxEvidence,
  type ActiveListboxResolution,
} from "./active-listbox.ts";
export {
  createConfiguredNarrativeProvider,
  type ConfiguredNarrativeProvider,
} from "./narrative.ts";

const narrativeQuestionId = "s1-question-configured-narrative" as const;

export type ProtectedQuestionCategory = "authorization" | "legal" | "consent";

export interface QuestionnairePageRequest {
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
}

export interface VerifiedQuestionnaireAnswer {
  readonly fieldId: FieldId;
  readonly questionId: QuestionId;
  readonly provenance: AnswerProvenance;
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
  readonly profileQuery: ProfileQuery;
  readonly answerResolver?: AnswerResolver;
  readonly driver: FieldDriver;
  readonly verifier: FieldVerifier;
  readonly narrative: ConfiguredNarrativeProvider;
  nextOperationId(): OperationId;
  allocateCandidateId(): UnknownCandidateId;
  observationFor(
    fieldId: FieldId,
    layer: ClassificationLayer,
  ): SanitizedStructuralObservationV1 | undefined;
}

export function createQuestionnairePageHandler(
  dependencies: QuestionnairePageHandlerDependencies,
): QuestionnairePageHandler {
  if (Object.is(dependencies.driver, dependencies.verifier)) {
    throw new TypeError("driver and verifier must be independent ports");
  }
  const configuredNarrative = dependencies.narrative.resolve(narrativeQuestionId);
  if (configuredNarrative === undefined) {
    throw new TypeError("configured narrative provider must serve the eligible prompt");
  }
  const resolver = dependencies.answerResolver ?? createAnswerResolver(
    dependencies.profileQuery,
    configuredNarrative.text,
  );

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
      for (const field of request.page.fields) {
        if (!field.required || field.state === "hidden") continue;
        const category = protectedCategory(field.label);
        const question = resolveQuestion(field.label);
        const answer = await resolver.resolve({
          field,
          profileId: request.profileId,
          profileRevision: request.profileRevision,
          resume: request.resume,
          resumeArtifact: request.resumeArtifact,
        }, signal);
        if (!answer.ok) {
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
        if (answer.value.kind !== "resolved") {
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
        if (question.kind !== "resolved") {
          const outcome = question.kind === "ambiguous"
            ? "question_ambiguous"
            : "question_unknown";
          const candidate = candidateFor(
            dependencies,
            field.fieldId,
            "question",
            outcome,
          );
          if (candidate === undefined) return candidateInvalid();
          return blocked(
            outcome,
            field.fieldId,
            category,
            candidate,
          );
        }
        if (
          category !== null &&
          answer.value.intent.provenance !== "owner_provided"
        ) {
          return blocked("protected_answer_denied", field.fieldId, category);
        }
        if (
          category !== null &&
          answer.value.intent.kind === "text" &&
          isPlaceholder(answer.value.intent.value)
        ) {
          return blocked("protected_answer_denied", field.fieldId, category);
        }
        if (
          answer.value.intent.fieldId !== field.fieldId ||
          answer.value.intent.target !== field.target ||
          answer.value.intent.behavior !== field.behavior
        ) {
          return blocked("answer_intent_mismatch", field.fieldId, category);
        }

        const narrative = dependencies.narrative.resolve(question.id);
        if (
          narrative !== undefined &&
          (answer.value.intent.kind !== "text" ||
            answer.value.intent.provenance !== "configured_template" ||
            answer.value.intent.value !== narrative.text)
        ) {
          return blocked("narrative_template_mismatch", field.fieldId, category);
        }
        if (
          answer.value.intent.provenance === "configured_template" &&
          narrative === undefined
        ) {
          return blocked("narrative_ineligible", field.fieldId, category);
        }

        if (answer.value.intent.behavior === "listbox") {
          const active = request.activeListboxes?.[field.fieldId];
          const listbox = active === undefined
            ? { kind: "unavailable" as const }
            : resolveActiveListbox(active);
          if (listbox.kind !== "resolved") {
            return blocked(
              listbox.kind === "ambiguous"
                ? "active_listbox_ambiguous"
                : "active_listbox_unavailable",
              field.fieldId,
              category,
            );
          }
        }

        const driven = await dependencies.driver.drive({
          journeyId: request.journeyId,
          sessionId: request.sessionId,
          pageId: request.pageId,
          guardRevision: request.guardRevision,
          operationId: dependencies.nextOperationId(),
          intent: answer.value.intent,
        }, signal);
        if (!driven.ok) return driven;

        const verified = await dependencies.verifier.verify({
          sessionId: request.sessionId,
          pageId: request.pageId,
          intent: answer.value.intent,
          receipt: driven.value,
        }, signal);
        if (!verified.ok) return verified;
        if (verified.value.kind !== "verified") {
          const code = verified.value.kind === "rejected"
            ? "verification_rejected"
            : verified.value.kind === "ambiguous"
              ? "verification_ambiguous"
              : "verification_unavailable";
          return blocked(code, field.fieldId, category);
        }

        answers.push(Object.freeze({
          fieldId: field.fieldId,
          questionId: question.id as QuestionId,
          provenance: answer.value.intent.provenance,
          protectedCategory: category,
          templateRevision: narrative?.revision ?? null,
          verification: "independent",
        }));
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

function protectedCategory(label: string): ProtectedQuestionCategory | null {
  const normalized = normalizeCatalogText(label);
  if (/\b(?:consent|agree|acknowledge|terms|signature)\b/u.test(normalized)) {
    return "consent";
  }
  if (/\b(?:authori[sz](?:e|ed|ation)?|sponsor|visa|work permit)\b/u.test(normalized)) {
    return "authorization";
  }
  if (/\b(?:legal|criminal|background check|disclosure|salary|compensation|at least 18)\b/u.test(normalized)) {
    return "legal";
  }
  return null;
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
): PortResult<QuestionnairePageValue, never> {
  return {
    ok: true,
    value: Object.freeze({
      kind: "blocked",
      code,
      fieldId,
      protectedCategory,
      ...(candidate === undefined ? {} : { candidate }),
    }),
  };
}
