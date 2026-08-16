import {
  boundedText,
  optionId,
  questionId,
  type AnswerResolutionRequest,
  type AnswerResolutionResult,
  type AnswerResolver,
  type AnswerProvenance,
  type FieldIntent,
  type FieldObservation,
  type ProfileQuery,
} from "../../contracts/index.ts";
import { mapVisibleOption } from "../options/mapper.ts";
import {
  generatedLearningDefaultFor,
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

const privacyChoiceDefaults = [
  "Prefer not to answer",
  "Prefer not to say",
  "I do not wish to provide this information",
  "Decline to self-identify",
] as const;

function intentFor(
  field: FieldObservation,
  canonicalQuestionId: CanonicalQuestionId,
  value: string | number | boolean,
  provenance: AnswerProvenance,
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
      if (
        field.options.every(({ label }) =>
          placeholderOption.test(String(label).trim().toLowerCase())
        ) && typeof value === "boolean"
      ) {
        const expectedOption = boundedText(value ? "Yes" : "No");
        return Object.freeze({
          kind: "resolved",
          intent: Object.freeze({
            kind: "choice",
            behavior: field.behavior,
            fieldId: field.fieldId,
            target: field.target,
            optionId: optionId(value ? "deferred-yes" : "deferred-no"),
            expectedOption,
            provenance,
          }),
        });
      }
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

function matchedChoiceIntent(
  field: FieldObservation,
  value: string,
): AnswerResolutionResult | undefined {
  if (
    field.behavior !== "radio" && field.behavior !== "select" &&
    field.behavior !== "listbox"
  ) return undefined;
  const option = mapVisibleOption(value, field.options);
  if (option.kind !== "matched") return undefined;
  return {
    kind: "resolved",
    intent: {
      kind: "choice",
      behavior: field.behavior,
      fieldId: field.fieldId,
      target: field.target,
      optionId: option.optionId,
      expectedOption: option.expectedOption,
      provenance: "reviewed_catalog",
    },
  };
}

const placeholderOption = /^(?:select|choose|please select|select one|choose one|none selected)$/u;

function generatedLearningIntent(
  field: FieldObservation,
  resumeArtifact: AnswerResolutionRequest["resumeArtifact"],
): AnswerResolutionResult | undefined {
  if (field.behavior === "text" || field.behavior === "textarea") {
    return {
      kind: "resolved",
      intent: {
        kind: "text",
        behavior: field.behavior,
        fieldId: field.fieldId,
        target: field.target,
        value: "Test response pending owner review.",
        provenance: "reviewed_catalog",
      },
    };
  }
  if (field.behavior === "checkbox") {
    return {
      kind: "resolved",
      intent: {
        kind: "toggle",
        behavior: "checkbox",
        fieldId: field.fieldId,
        target: field.target,
        checked: true,
        provenance: "reviewed_catalog",
      },
    };
  }
  if (field.behavior === "date") {
    return {
      kind: "resolved",
      intent: {
        kind: "date",
        behavior: "date",
        fieldId: field.fieldId,
        target: field.target,
        isoDate: "2026-09-01",
        provenance: "reviewed_catalog",
      },
    };
  }
  if (
    field.behavior === "radio" || field.behavior === "select" ||
    field.behavior === "listbox"
  ) {
    const option = field.options.find(({ label }) =>
      !placeholderOption.test(String(label).trim().toLowerCase())
    );
    if (option === undefined) return undefined;
    return {
      kind: "resolved",
      intent: {
        kind: "choice",
        behavior: field.behavior,
        fieldId: field.fieldId,
        target: field.target,
        optionId: option.id,
        expectedOption: option.label,
        provenance: "visible_option",
      },
    };
  }
  if (field.behavior === "file_upload") {
    return {
      kind: "resolved",
      intent: {
        kind: "resume_upload",
        behavior: "file_upload",
        fieldId: field.fieldId,
        target: field.target,
        artifact: resumeArtifact,
        provenance: "resume_verified",
      },
    };
  }
  return undefined;
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
      if (questionResolution.kind === "unknown") {
        const generated = generatedLearningIntent(field, request.resumeArtifact);
        return generated === undefined
          ? failure("question_unknown")
          : success(generated);
      }
      if (questionResolution.kind === "ambiguous") {
        const generated = generatedLearningIntent(field, request.resumeArtifact);
        return generated === undefined
          ? failure("question_ambiguous")
          : success(generated);
      }

      const canonicalQuestionId = questionResolution.id as CanonicalQuestionId;
      const question = questionForField(field.label, field.behavior);
      if (question === undefined) {
        const generated = generatedLearningIntent(field, request.resumeArtifact);
        return generated === undefined ? unsupported(field) : success(generated);
      }

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
        return resolved({
          kind: "text",
          behavior: "textarea",
          fieldId: field.fieldId,
          target: field.target,
          value: narrativeTemplate ?? question.source.syntheticDefault,
          provenance: narrativeTemplate === undefined
            ? "reviewed_catalog"
            : "configured_template",
        });
      }
      if (question.source.kind === "neutral_disclosure") {
        for (const candidate of privacyChoiceDefaults) {
          const matched = matchedChoiceIntent(field, candidate);
          if (matched !== undefined) return success(matched);
        }
        const generated = generatedLearningIntent(field, request.resumeArtifact);
        return generated === undefined
          ? failure("protected_answer_denied")
          : success(generated);
      }
      if (question.source.kind === "synthetic_placeholder") {
        const intended = intentFor(
          field,
          canonicalQuestionId,
          question.source.value,
          "reviewed_catalog",
        );
        return intended.kind === "resolved"
          ? success(intended)
          : success(generatedLearningIntent(field, request.resumeArtifact) ?? intended);
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
        const generatedDefault = generatedLearningDefaultFor(canonicalQuestionId);
        if (generatedDefault !== undefined) {
          const intended = intentFor(
            field,
            canonicalQuestionId,
            generatedDefault,
            "reviewed_catalog",
          );
          return success(
            intended.kind === "resolved"
              ? intended
              : generatedLearningIntent(field, request.resumeArtifact) ?? intended,
          );
        }
        return success({
          kind: "profile_answer_missing",
          questionId: questionId(canonicalQuestionId),
        });
      }
      if (
        question.source.ownerProvidedOnly === true &&
        answer.value.provenance !== "owner_provided"
      ) {
        const generatedDefault = generatedLearningDefaultFor(canonicalQuestionId);
        if (generatedDefault === undefined) {
          return failure("protected_answer_denied");
        }
        const intended = intentFor(
          field,
          canonicalQuestionId,
          generatedDefault,
          "reviewed_catalog",
        );
        return success(
          intended.kind === "resolved"
            ? intended
            : generatedLearningIntent(field, request.resumeArtifact) ?? intended,
        );
      }
      const intent = intentFor(
        field,
        canonicalQuestionId,
        answer.value.value,
        answer.value.provenance,
      );
      return intent.kind === "resolved"
        ? success(intent)
        : success(generatedLearningIntent(field, request.resumeArtifact) ?? intent);
    },
  });
}
