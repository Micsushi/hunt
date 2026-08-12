import {
  questionId,
  type AnswerResolutionRequest,
  type AnswerResolutionResult,
  type AnswerResolver,
  type FieldIntent,
  type FieldObservation,
  type ProfileAnswerProvenance,
  type ProfileQuery,
} from "../../contracts/index.ts";
import { mapVisibleOption } from "../options/mapper.ts";
import {
  questionForField,
  resolveQuestion,
  type CanonicalQuestionId,
} from "../questions/catalog.ts";

const cancelled = Object.freeze({
  ok: false as const,
  error: Object.freeze({ code: "operation_cancelled" as const, retryable: false as const }),
});

function success(value: AnswerResolutionResult) {
  return Object.freeze({ ok: true as const, value: Object.freeze(value) });
}

function failure(
  code: "question_unknown" | "question_ambiguous" | "protected_answer_denied",
) {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code, retryable: false as const }),
  });
}

function unsupported(field: FieldObservation) {
  return success({ kind: "unsupported", fieldId: field.fieldId });
}

function resolved(intent: FieldIntent) {
  return success({ kind: "resolved", intent: Object.freeze(intent) });
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function intentFor(
  field: FieldObservation,
  canonicalQuestionId: CanonicalQuestionId,
  value: string | number | boolean,
  provenance: ProfileAnswerProvenance,
): AnswerResolutionResult {
  if (
    (field.behavior === "text" || field.behavior === "textarea") &&
    typeof value !== "boolean"
  ) {
    return Object.freeze({
      kind: "resolved",
      intent: Object.freeze({
        kind: "text",
        behavior: field.behavior,
        fieldId: field.fieldId,
        target: field.target,
        value: String(value),
        provenance,
      }),
    });
  }
  if (field.behavior === "date" && typeof value === "string" && isIsoDate(value)) {
    return Object.freeze({
      kind: "resolved",
      intent: Object.freeze({
        kind: "date",
        behavior: "date",
        fieldId: field.fieldId,
        target: field.target,
        isoDate: value,
        provenance,
      }),
    });
  }
  if (
    field.behavior === "radio" ||
    field.behavior === "select" ||
    field.behavior === "listbox"
  ) {
    const option = mapVisibleOption(value, field.options);
    if (option.kind !== "matched") {
      return Object.freeze({
        kind: option.kind,
        questionId: questionId(canonicalQuestionId),
      });
    }
    return Object.freeze({
      kind: "resolved",
      intent: Object.freeze({
        kind: "choice",
        behavior: field.behavior,
        fieldId: field.fieldId,
        target: field.target,
        optionId: option.optionId,
        expectedOption: option.expectedOption,
        provenance,
      }),
    });
  }
  if (field.behavior === "checkbox" && typeof value === "boolean") {
    return Object.freeze({
      kind: "resolved",
      intent: Object.freeze({
        kind: "toggle",
        behavior: "checkbox",
        fieldId: field.fieldId,
        target: field.target,
        checked: value,
        provenance,
      }),
    });
  }
  return Object.freeze({ kind: "unsupported", fieldId: field.fieldId });
}

export function createAnswerResolver(
  profileQuery: ProfileQuery,
  narrativeTemplate: string | undefined,
): AnswerResolver {
  if (narrativeTemplate !== undefined && narrativeTemplate.trim() === "") {
    throw new TypeError("narrative template must not be empty");
  }

  return Object.freeze({
    async resolve(request: AnswerResolutionRequest, signal: AbortSignal) {
      if (signal.aborted) return cancelled;

      const { field } = request;
      if (
        field.behavior === "unsupported" ||
        field.state === "hidden" ||
        field.state === "ambiguous"
      ) {
        return unsupported(field);
      }

      const questionResolution = resolveQuestion(field.label);
      if (questionResolution.kind === "unknown") return failure("question_unknown");
      if (questionResolution.kind === "ambiguous") return failure("question_ambiguous");

      const canonicalQuestionId = questionResolution.id as CanonicalQuestionId;
      const question = questionForField(field.label, field.behavior);
      if (question === undefined) return unsupported(field);

      if (question.source.kind === "resume") {
        return resolved({
          kind: "resume_upload",
          behavior: "file_upload",
          fieldId: field.fieldId,
          target: field.target,
          artifact: request.resumeArtifact,
          provenance: "resume_verified",
        });
      }
      if (question.source.kind === "narrative") {
        if (narrativeTemplate === undefined) {
          return success({
            kind: "profile_answer_missing",
            questionId: questionId(canonicalQuestionId),
          });
        }
        return resolved({
          kind: "text",
          behavior: "textarea",
          fieldId: field.fieldId,
          target: field.target,
          value: narrativeTemplate,
          provenance: "configured_template",
        });
      }
      if (question.source.kind === "neutral_disclosure") {
        return failure("protected_answer_denied");
      }
      if (question.source.kind === "synthetic_placeholder") {
        if (question.source.protected) return failure("protected_answer_denied");
        return success({
          kind: "profile_answer_missing",
          questionId: questionId(canonicalQuestionId),
        });
      }

      const answer = await profileQuery.query(
        {
          profileId: request.profileId,
          profileRevision: request.profileRevision,
          factId: question.source.factId,
        },
        signal,
      );
      if (!answer.ok) {
        return answer;
      }
      if (answer.value.kind === "profile_answer_missing") {
        return success({
          kind: "profile_answer_missing",
          questionId: questionId(canonicalQuestionId),
        });
      }
      if (
        question.source.ownerProvidedOnly === true &&
        answer.value.provenance !== "owner_provided"
      ) {
        return failure("protected_answer_denied");
      }

      return success(intentFor(
        field,
        canonicalQuestionId,
        answer.value.value,
        answer.value.provenance,
      ));
    },
  });
}
