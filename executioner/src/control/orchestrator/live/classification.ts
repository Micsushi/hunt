import {
  ContractParseError,
  type FactualTerminalOutcomeV4,
  type OptionId,
} from "../../../contracts/index.ts";
import {
  deriveSanitizedUnknownCandidate,
  classificationLayers,
  parseAtsFamilyClassificationResult,
  parseCanonicalAnswerTypeClassificationResult,
  parseQuestionClassificationResult,
  parseSanitizedStructuralObservation,
  parseUiBehaviorClassificationResult,
  parseVisibleOptionMappingResult,
  parseWorkdayPageTypeClassificationResult,
  type AtsFamilyClassifier,
  type CanonicalAnswerTypeClassifier,
  type ClassificationId,
  type ClassificationRevisionId,
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
  const admitted = admitObservations(input);
  if (!admitted.ok) return admitted;
  const { observations, revision } = admitted.value;

  const atsResult = await dependencies.atsFamily.classify(
    { schemaVersion: 1, observation: observations.atsFamily },
    signal,
  );
  if (!atsResult.ok) return atsResult;
  const ats = parseResult(atsResult.value, parseAtsFamilyClassificationResult);
  if (!ats.ok) return ats;
  if (ats.value.sourceRevisionId !== revision) return mismatch();
  if (ats.value.kind !== "classified") {
    return unknown(
      dependencies,
      observations.atsFamily,
      ats.value.kind,
      factual("ats_family", ats.value.kind),
    );
  }

  if (!lineageMatches(observations.pageType, [ats.value.classificationId])) {
    return mismatch();
  }
  const pageResult = await dependencies.pageType.classify({
    schemaVersion: 1,
    atsFamilyClassificationId: ats.value.classificationId,
    observation: observations.pageType,
  }, signal);
  if (!pageResult.ok) return pageResult;
  const page = parseResult(
    pageResult.value,
    parseWorkdayPageTypeClassificationResult,
  );
  if (!page.ok) return page;
  if (page.value.sourceRevisionId !== revision) return mismatch();
  if (page.value.kind !== "classified") {
    return unknown(
      dependencies,
      observations.pageType,
      page.value.kind,
      factual("workday_page_type", page.value.kind),
    );
  }

  if (!lineageMatches(observations.uiBehavior, [
    ats.value.classificationId,
    page.value.classificationId,
  ])) return mismatch();
  const uiResult = await dependencies.uiBehavior.classify({
    schemaVersion: 1,
    pageTypeClassificationId: page.value.classificationId,
    observation: observations.uiBehavior,
  }, signal);
  if (!uiResult.ok) return uiResult;
  const ui = parseResult(
    uiResult.value,
    parseUiBehaviorClassificationResult,
  );
  if (!ui.ok) return ui;
  if (ui.value.sourceRevisionId !== revision) return mismatch();
  if (ui.value.kind !== "classified") {
    const result = ui.value.kind === "ui_variant_unreviewed"
      ? { kind: ui.value.kind, variantId: ui.value.variantId }
      : { kind: ui.value.kind };
    return unknown(
      dependencies,
      observations.uiBehavior,
      ui.value.kind,
      { source: "ui_behavior", result },
    );
  }

  if (!lineageMatches(observations.question, [
    ats.value.classificationId,
    page.value.classificationId,
    ui.value.classificationId,
  ])) return mismatch();
  const questionResult = await dependencies.question.classify({
    schemaVersion: 1,
    uiBehaviorClassificationId: ui.value.classificationId,
    observation: observations.question,
  }, signal);
  if (!questionResult.ok) return questionResult;
  const question = parseResult(
    questionResult.value,
    parseQuestionClassificationResult,
  );
  if (!question.ok) return question;
  if (question.value.sourceRevisionId !== revision) return mismatch();
  if (question.value.kind !== "classified") {
    return unknown(
      dependencies,
      observations.question,
      question.value.kind,
      factual("question_classification", question.value.kind),
    );
  }

  if (!lineageMatches(observations.answerType, [
    ats.value.classificationId,
    page.value.classificationId,
    ui.value.classificationId,
    question.value.classificationId,
  ])) return mismatch();
  const answerResult = await dependencies.answerType.classify({
    schemaVersion: 1,
    questionClassificationId: question.value.classificationId,
    questionId: question.value.questionId,
    observation: observations.answerType,
  }, signal);
  if (!answerResult.ok) return answerResult;
  const answer = parseResult(
    answerResult.value,
    parseCanonicalAnswerTypeClassificationResult,
  );
  if (!answer.ok) return answer;
  if (answer.value.sourceRevisionId !== revision) return mismatch();
  if (answer.value.kind === "profile_answer_missing") {
    return { ok: true, value: { kind: "blocked", factualOutcome: { source: "answer_resolution", result: { kind: "profile_answer_missing", questionId: question.value.questionId } } } };
  }
  if (answer.value.kind !== "classified") {
    return unknown(
      dependencies,
      observations.answerType,
      answer.value.kind,
      { source: "answer_resolution", result: { kind: answer.value.kind, questionId: question.value.questionId } },
    );
  }

  if (!lineageMatches(observations.visibleOption, [
    ats.value.classificationId,
    page.value.classificationId,
    ui.value.classificationId,
    question.value.classificationId,
    answer.value.classificationId,
  ])) return mismatch();
  const optionResult = await dependencies.visibleOption.map({
    schemaVersion: 1,
    questionId: question.value.questionId,
    answerTypeClassificationId: answer.value.classificationId,
    canonicalOptionId: input.canonicalOptionId,
    visibleOptionIds: input.visibleOptionIds,
    observation: observations.visibleOption,
  }, signal);
  if (!optionResult.ok) return optionResult;
  const option = parseResult(
    optionResult.value,
    parseVisibleOptionMappingResult,
  );
  if (!option.ok) return option;
  if (option.value.sourceRevisionId !== revision) return mismatch();
  if (option.value.kind !== "mapped") {
    return unknown(
      dependencies,
      observations.visibleOption,
      option.value.kind,
      { source: "answer_resolution", result: { kind: option.value.kind, questionId: question.value.questionId } },
    );
  }
  return { ok: true, value: { kind: "classified", optionId: option.value.optionId } };
}

function unknown(
  dependencies: ClassificationSkeletonDependencies,
  observation: SanitizedStructuralObservationV1,
  outcome: string,
  factualOutcome: FactualTerminalOutcomeV4,
): LiveCoordinatorResult<ClassificationSkeletonValue> {
  let candidateId: UnknownCandidateId;
  try {
    candidateId = dependencies.allocateCandidateId();
  } catch {
    return shapeInvalid();
  }
  try {
    const candidate = deriveSanitizedUnknownCandidate({
      candidateId,
      observation,
      outcome,
    });
    return { ok: true, value: { kind: "blocked", factualOutcome, candidate } };
  } catch (error) {
    if (error instanceof ContractParseError) return shapeInvalid();
    throw error;
  }
}

type AdmittedObservations = ClassificationSkeletonInput["observations"];

function admitObservations(
  input: ClassificationSkeletonInput,
): LiveCoordinatorResult<{
  readonly observations: AdmittedObservations;
  readonly revision: ClassificationRevisionId;
}> {
  if (input.schemaVersion !== 1) return shapeInvalid();
  const declarations = [
    ["atsFamily", "ats_family"],
    ["pageType", "workday_page_type"],
    ["uiBehavior", "ui_behavior"],
    ["question", "question"],
    ["answerType", "answer_type"],
    ["visibleOption", "visible_option"],
  ] as const;
  const parsed: Partial<Record<keyof AdmittedObservations, SanitizedStructuralObservationV1>> = {};
  try {
    for (const [key, declaredLayer] of declarations) {
      const observation = parseSanitizedStructuralObservation(
        input.observations[key],
      );
      if (observation.layer !== declaredLayer) return shapeInvalid();
      parsed[key] = observation;
    }
  } catch (error) {
    if (error instanceof ContractParseError) return shapeInvalid();
    throw error;
  }
  const observations = parsed as AdmittedObservations;
  const revision = observations.atsFamily.sourceRevisionId;
  if (declarations.some(([key]) =>
    observations[key].sourceRevisionId !== revision)) return mismatch();
  return { ok: true, value: { observations, revision } };
}

function parseResult<T>(
  value: unknown,
  parser: (candidate: unknown) => T,
): LiveCoordinatorResult<T> {
  try {
    return { ok: true, value: parser(value) };
  } catch (error) {
    if (error instanceof ContractParseError) return shapeInvalid();
    throw error;
  }
}

function lineageMatches(
  observation: SanitizedStructuralObservationV1,
  classificationIds: readonly ClassificationId[],
): boolean {
  return observation.parentLineage.length === classificationIds.length
    && observation.parentLineage.every((entry, index) =>
      entry.layer === classificationLayers[index]
      && entry.classificationId === classificationIds[index]);
}

function shapeInvalid<T>(): LiveCoordinatorResult<T> {
  return { ok: false, error: liveCoordinatorError("admission_shape_invalid") };
}

function mismatch<T>(): LiveCoordinatorResult<T> {
  return { ok: false, error: liveCoordinatorError("admission_mismatch") };
}

function factual(
  source: "ats_family" | "workday_page_type" | "question_classification",
  kind: string,
): FactualTerminalOutcomeV4 {
  return { source, result: { kind } } as FactualTerminalOutcomeV4;
}
