import type { FactualTerminalOutcomeV4, OptionId } from "../../../contracts/index.ts";
import {
  deriveSanitizedUnknownCandidate,
  type AtsFamilyClassifier,
  type CanonicalAnswerTypeClassifier,
  type SanitizedStructuralObservationV1,
  type UnknownCandidateId,
  type VisibleOptionMapper,
  type WorkdayPageTypeClassifier,
  type UiBehaviorClassifier,
  type QuestionClassifier,
} from "../../../contracts/live/index.ts";
import { liveCoordinatorError, type LiveBlocked, type LiveCoordinatorResult } from "./types.ts";

export interface ClassificationSkeletonDependencies {
  readonly atsFamily: AtsFamilyClassifier;
  readonly pageType: WorkdayPageTypeClassifier;
  readonly uiBehavior: UiBehaviorClassifier;
  readonly question: QuestionClassifier;
  readonly answerType: CanonicalAnswerTypeClassifier;
  readonly visibleOption: VisibleOptionMapper;
  allocateCandidateId(): UnknownCandidateId;
}

export interface ClassificationSkeletonInput {
  readonly schemaVersion: 1;
  readonly observations: {
    readonly atsFamily: SanitizedStructuralObservationV1 & { readonly layer: "ats_family" };
    readonly pageType: SanitizedStructuralObservationV1 & { readonly layer: "workday_page_type" };
    readonly uiBehavior: SanitizedStructuralObservationV1 & { readonly layer: "ui_behavior" };
    readonly question: SanitizedStructuralObservationV1 & { readonly layer: "question" };
    readonly answerType: SanitizedStructuralObservationV1 & { readonly layer: "answer_type" };
    readonly visibleOption: SanitizedStructuralObservationV1 & { readonly layer: "visible_option" };
  };
  readonly canonicalOptionId: OptionId;
  readonly visibleOptionIds: readonly OptionId[];
}

export type ClassificationSkeletonValue =
  | LiveBlocked
  | { readonly kind: "classified"; readonly optionId: OptionId };

export async function runClassificationSkeleton(
  dependencies: ClassificationSkeletonDependencies,
  input: ClassificationSkeletonInput,
  signal: AbortSignal,
): Promise<LiveCoordinatorResult<ClassificationSkeletonValue>> {
  const ats = await dependencies.atsFamily.classify({ schemaVersion: 1, observation: input.observations.atsFamily }, signal);
  if (!ats.ok) return ats;
  if (ats.value.kind !== "classified") return unknown(dependencies, input.observations.atsFamily, ats.value.kind, factual("ats_family", ats.value.kind));

  const page = await dependencies.pageType.classify({ schemaVersion: 1, atsFamilyClassificationId: ats.value.classificationId, observation: input.observations.pageType }, signal);
  if (!page.ok) return page;
  if (page.value.kind !== "classified") return unknown(dependencies, input.observations.pageType, page.value.kind, factual("workday_page_type", page.value.kind));

  const ui = await dependencies.uiBehavior.classify({ schemaVersion: 1, pageTypeClassificationId: page.value.classificationId, observation: input.observations.uiBehavior }, signal);
  if (!ui.ok) return ui;
  if (ui.value.kind !== "classified") {
    const result = ui.value.kind === "ui_variant_unreviewed"
      ? { kind: ui.value.kind, variantId: ui.value.variantId }
      : { kind: ui.value.kind };
    return unknown(dependencies, input.observations.uiBehavior, ui.value.kind, { source: "ui_behavior", result });
  }

  const question = await dependencies.question.classify({ schemaVersion: 1, uiBehaviorClassificationId: ui.value.classificationId, observation: input.observations.question }, signal);
  if (!question.ok) return question;
  if (question.value.kind !== "classified") return unknown(dependencies, input.observations.question, question.value.kind, factual("question_classification", question.value.kind));

  const answer = await dependencies.answerType.classify({ schemaVersion: 1, questionClassificationId: question.value.classificationId, questionId: question.value.questionId, observation: input.observations.answerType }, signal);
  if (!answer.ok) return answer;
  if (answer.value.kind === "profile_answer_missing") {
    return { ok: true, value: { kind: "blocked", factualOutcome: { source: "answer_resolution", result: { kind: "profile_answer_missing", questionId: question.value.questionId } } } };
  }
  if (answer.value.kind !== "classified") {
    return unknown(dependencies, input.observations.answerType, answer.value.kind, { source: "answer_resolution", result: { kind: answer.value.kind, questionId: question.value.questionId } });
  }

  const option = await dependencies.visibleOption.map({
    schemaVersion: 1,
    questionId: question.value.questionId,
    answerTypeClassificationId: answer.value.classificationId,
    canonicalOptionId: input.canonicalOptionId,
    visibleOptionIds: input.visibleOptionIds,
    observation: input.observations.visibleOption,
  }, signal);
  if (!option.ok) return option;
  if (option.value.kind !== "mapped") {
    return unknown(dependencies, input.observations.visibleOption, option.value.kind, { source: "answer_resolution", result: { kind: option.value.kind, questionId: question.value.questionId } });
  }
  return { ok: true, value: { kind: "classified", optionId: option.value.optionId } };
}

function unknown(
  dependencies: ClassificationSkeletonDependencies,
  observation: SanitizedStructuralObservationV1,
  outcome: string,
  factualOutcome: FactualTerminalOutcomeV4,
): LiveCoordinatorResult<ClassificationSkeletonValue> {
  try {
    const candidate = deriveSanitizedUnknownCandidate({
      candidateId: dependencies.allocateCandidateId(),
      observation,
      outcome,
    });
    return { ok: true, value: { kind: "blocked", factualOutcome, candidate } };
  } catch {
    return { ok: false, error: liveCoordinatorError("answer_provenance_invalid") };
  }
}

function factual(
  source: "ats_family" | "workday_page_type" | "question_classification",
  kind: string,
): FactualTerminalOutcomeV4 {
  return { source, result: { kind } } as FactualTerminalOutcomeV4;
}
