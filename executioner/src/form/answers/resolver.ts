import { randomInt } from "node:crypto";

import {
  boundedText,
  optionId,
  questionId,
  type AnswerResolutionRequest,
  type AnswerResolutionResult,
  type AnswerResolver,
  type AnswerProvenance,
  type FieldIntent,
  type ProfileQuery,
  type ProfileQueryRequest,
} from "../../contracts/index.ts";
import { generateSyntheticTextValue } from "../../deterministic/synthetic-value.ts";
import type {
  AnswerProvenanceLane,
  ApplicationFieldObservation,
  ApplicationProfileQuery,
} from "./application-types.ts";
import type {
  ApplicationAnswerResolutionRequest,
  ApplicationAnswerResolutionResult,
  ApplicationAnswerResolver,
} from "./application-types.ts";
import { mapVisibleOption } from "../options/mapper.ts";
import {
  generatedLearningDefaultFor,
  questionForField,
  resolveQuestion,
  type CanonicalQuestionId,
} from "../questions/catalog.ts";
import { normalizeCatalogText } from "../questions/normalize.ts";
import {
  contractApprovedPrivacyChoices,
  protectedQuestionCategory,
} from
  "../../ats/workday/application/questions/protected.ts";
import { semanticSyntheticTestDefault } from "./testing-policy.ts";

const cancelled = Object.freeze({
  ok: false as const,
  error: Object.freeze({ code: "operation_cancelled" as const, retryable: false as const }),
});

function success(value: ApplicationAnswerResolutionResult) {
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

function unsupported(field: ApplicationFieldObservation) {
  return success({ kind: "unsupported", fieldId: field.fieldId });
}

function resolved(intent: FieldIntent, lane: AnswerProvenanceLane) {
  return success({ kind: "resolved", intent: Object.freeze(intent), lane });
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function localIsoDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function intentFor(
  field: ApplicationFieldObservation,
  canonicalQuestionId: CanonicalQuestionId | undefined,
  value: string | number | boolean,
  provenance: AnswerProvenance,
  lane: AnswerProvenanceLane,
): ApplicationAnswerResolutionResult {
  if (
    (field.behavior === "text" || field.behavior === "textarea") &&
    typeof value !== "boolean"
  ) {
    return Object.freeze({
      kind: "resolved",
      lane,
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
      lane,
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
          lane,
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
      if (canonicalQuestionId === undefined) {
        return Object.freeze({ kind: "unsupported", fieldId: field.fieldId });
      }
      return Object.freeze({
        kind: option.kind,
        questionId: questionId(canonicalQuestionId),
      });
    }
    return Object.freeze({
      kind: "resolved",
      lane,
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
      lane,
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
  field: ApplicationFieldObservation,
  value: string,
): ApplicationAnswerResolutionResult | undefined {
  if (
    field.behavior !== "radio" && field.behavior !== "select" &&
    field.behavior !== "listbox"
  ) return undefined;
  const option = mapVisibleOption(value, field.options);
  if (option.kind !== "matched") return undefined;
  return {
    kind: "resolved",
    lane: "synthetic_test_default",
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
  field: ApplicationFieldObservation,
  resumeArtifact: ApplicationAnswerResolutionRequest["resumeArtifact"],
  generatedDate: string,
  selectRandomIndex: (length: number) => number,
): ApplicationAnswerResolutionResult | undefined {
  if (field.behavior === "text" || field.behavior === "textarea") {
    const generated = generateSyntheticTextValue(field.constraints);
    if (generated.kind === "unsupported_constraint") {
      return { kind: "unsupported_constraint", fieldId: field.fieldId };
    }
    return {
      kind: "resolved",
      lane: "synthetic_test_default",
      intent: {
        kind: "text",
        behavior: field.behavior,
        fieldId: field.fieldId,
        target: field.target,
        value: generated.value,
        provenance: "reviewed_catalog",
      },
    };
  }
  if (field.behavior === "checkbox") {
    return {
      kind: "resolved",
      lane: "synthetic_test_default",
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
      lane: "synthetic_test_default",
      intent: {
        kind: "date",
        behavior: "date",
        fieldId: field.fieldId,
        target: field.target,
        isoDate: generatedDate,
        provenance: "reviewed_catalog",
      },
    };
  }
  if (
    field.behavior === "radio" || field.behavior === "select" ||
    field.behavior === "listbox"
  ) {
    const options = field.options.filter(({ label }) =>
      !placeholderOption.test(String(label).trim().toLowerCase())
    );
    if (options.length === 0) return undefined;
    const index = selectRandomIndex(options.length);
    if (!Number.isSafeInteger(index) || index < 0 || index >= options.length) {
      throw new TypeError("random option index denied");
    }
    const option = options[index]!;
    return {
      kind: "resolved",
      lane: "synthetic_test_default",
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
      lane: "synthetic_test_default",
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

export function createApplicationAnswerResolver(
  profileQuery: ProfileQuery | ApplicationProfileQuery,
  narrativeTemplate: string | undefined,
  generatedDate = localIsoDate(new Date()),
  selectRandomIndex: (length: number) => number = randomInt,
): ApplicationAnswerResolver {
  if (narrativeTemplate !== undefined && narrativeTemplate.trim() === "") {
    throw new TypeError("narrative template must not be empty");
  }
  if (!isIsoDate(generatedDate)) throw new TypeError("generated date must be an ISO date");

  const syntheticChoiceLabelsByField = new Map<string, {
    readonly classKey: string;
    readonly label: string;
  }>();
  const syntheticChoiceLabelsByClass = new Map<string, string>();
  const syntheticReplacementReasons = new Map<
    string,
    "committed_value_adopted" | "cached_option_unavailable"
  >();
  const stableRandomIndexFor = (
    request: ApplicationAnswerResolutionRequest,
  ) => (length: number): number => {
    const { field } = request;
    const options = field.options.filter(({ label }) =>
      !placeholderOption.test(String(label).trim().toLowerCase())
    );
    if (options.length !== length) throw new TypeError("synthetic option set mismatch");
    // Identical physical occurrences must receive one class intent so a
    // tokenless reorder cannot swap answers. Including behavior and the exact
    // option catalog keeps same-labelled questions with different choices
    // independent.
    const fieldKey = String(field.fieldId);
    const classKey = [
      normalizeCatalogText(field.label),
      field.behavior,
      field.selectionMode ?? "single",
      JSON.stringify({
        inputType: field.constraints?.inputType ?? null,
        min: field.constraints?.min ?? null,
        max: field.constraints?.max ?? null,
        step: field.constraints?.step ?? null,
        minLength: field.constraints?.minLength ?? null,
        maxLength: field.constraints?.maxLength ?? null,
        pattern: field.constraints?.pattern ?? null,
        readOnly: field.constraints?.readOnly ?? false,
      }),
      ...options.map(({ label }) => normalizeCatalogText(label)).sort(),
    ].join("\u0000");
    const remember = (label: string) => {
      syntheticChoiceLabelsByField.set(fieldKey, { classKey, label });
      syntheticChoiceLabelsByClass.set(classKey, label);
    };
    const fieldChoice = syntheticChoiceLabelsByField.get(fieldKey);
    const existing = (fieldChoice?.classKey === classKey ? fieldChoice.label : undefined) ??
      syntheticChoiceLabelsByClass.get(classKey) ??
      (fieldChoice === undefined ? undefined : "");
    if (existing !== undefined) {
      const rebound = options.findIndex(({ label }) => normalizeCatalogText(label) === existing);
      if (rebound >= 0) return rebound;
      const committed = request.committedReadback?.kind === "selected"
        ? request.committedReadback.option
        : null;
      const adopted = committed === null || committed === undefined
        ? -1
        : options.findIndex(({ label }) =>
          normalizeCatalogText(label) === normalizeCatalogText(committed)
        );
      if (adopted >= 0) {
        remember(normalizeCatalogText(options[adopted]!.label));
        syntheticReplacementReasons.set(fieldKey, "committed_value_adopted");
        return adopted;
      }
      const selected = selectRandomIndex(length);
      if (Number.isSafeInteger(selected) && selected >= 0 && selected < length) {
        remember(normalizeCatalogText(options[selected]!.label));
        syntheticReplacementReasons.set(fieldKey, "cached_option_unavailable");
      }
      return selected;
    }
    const selected = selectRandomIndex(length);
    if (Number.isSafeInteger(selected) && selected >= 0 && selected < length) {
      remember(normalizeCatalogText(options[selected]!.label));
    }
    return selected;
  };
  const generatedSuccess = (
    field: ApplicationFieldObservation,
    value: ApplicationAnswerResolutionResult,
  ) => {
    const replacementReason = syntheticReplacementReasons.get(String(field.fieldId));
    syntheticReplacementReasons.delete(String(field.fieldId));
    return success(
      replacementReason === undefined || value.kind !== "resolved"
        ? value
        : { ...value, syntheticReplacementReason: replacementReason },
    );
  };

  const query = profileQuery.query as ApplicationProfileQuery["query"];
  return Object.freeze({
    async resolve(request: ApplicationAnswerResolutionRequest, signal: AbortSignal) {
      if (signal.aborted) return cancelled;

      const { field } = request;
      const synthetic = request.mode === "synthetic_test_non_submittable";
      if (field.readOnly === true) {
        return field.state === "populated"
          ? success({ kind: "readback_only", fieldId: field.fieldId })
          : unsupported(field);
      }
      if (
        field.behavior === "unsupported" ||
        field.state === "hidden" ||
        field.state === "ambiguous"
      ) {
        return unsupported(field);
      }

      const questionResolution = resolveQuestion(field.label);
      const protectedCategory = protectedQuestionCategory(
        field.label,
        questionResolution.kind === "resolved" ? questionResolution.id : undefined,
      );
      if (questionResolution.kind === "unknown") {
        if (!synthetic) {
          return failure(protectedCategory === null ? "question_unknown" : "protected_answer_denied");
        }
        const generated = semanticLearningIntent(field, request.resumeArtifact, generatedDate) ??
          generatedLearningIntent(
            field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
          );
        return generated === undefined
          ? failure("question_unknown")
          : generatedSuccess(field, generated);
      }
      if (questionResolution.kind === "ambiguous") {
        if (!synthetic) {
          return failure(protectedCategory === null ? "question_ambiguous" : "protected_answer_denied");
        }
        const generated = semanticLearningIntent(field, request.resumeArtifact, generatedDate) ??
          generatedLearningIntent(
            field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
          );
        return generated === undefined
          ? failure("question_ambiguous")
          : generatedSuccess(field, generated);
      }

      const canonicalQuestionId = questionResolution.id as CanonicalQuestionId;
      const question = questionForField(field.label, field.behavior);
      if (question === undefined) {
        if (!synthetic) {
          return protectedCategory === null
            ? unsupported(field)
            : failure("protected_answer_denied");
        }
        const generated = semanticLearningIntent(field, request.resumeArtifact, generatedDate) ??
          generatedLearningIntent(
            field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
          );
        return generated === undefined ? unsupported(field) : generatedSuccess(field, generated);
      }

      if (question.source.kind === "resume") {
        return resolved({
          kind: "resume_upload",
          behavior: "file_upload",
          fieldId: field.fieldId,
          target: field.target,
          artifact: request.resumeArtifact,
          provenance: "resume_verified",
        }, synthetic ? "synthetic_test_default" : "live_owner_fact");
      }
      if (question.source.kind === "narrative") {
        const configured = await query({
          profileId: request.profileId,
          profileRevision: request.profileRevision,
          factId: "configured_narrative",
        }, signal);
        if (!configured.ok) return configured;
        if (configured.value.kind === "answered") {
          if (
            configured.value.provenance !== "configured_template" ||
            configured.value.lane !== "live_owner_fact" ||
            typeof configured.value.value !== "string" ||
            narrativeTemplate !== configured.value.value
          ) return failure("protected_answer_denied");
          return resolved({
            kind: "text",
            behavior: "textarea",
            fieldId: field.fieldId,
            target: field.target,
            value: configured.value.value,
            provenance: "configured_template",
          }, configured.value.lane);
        }
        if (!synthetic) {
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
          value: question.source.syntheticDefault,
          provenance: "reviewed_catalog",
        }, "synthetic_test_default");
      }
      if (question.source.kind === "neutral_disclosure") {
        if (!synthetic) return failure("protected_answer_denied");
        for (const candidate of contractApprovedPrivacyChoices) {
          const matched = matchedChoiceIntent(field, candidate);
          if (matched !== undefined) return success(matched);
        }
        const generated = generatedLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        );
        return generated === undefined
          ? failure("protected_answer_denied")
          : generatedSuccess(field, generated);
      }
      if (question.source.kind === "synthetic_placeholder") {
        if (!synthetic) return failure("protected_answer_denied");
        const intended = intentFor(
          field,
          canonicalQuestionId,
          question.source.value,
          "reviewed_catalog",
          "synthetic_test_default",
        );
        return intended.kind === "resolved"
          ? success(intended)
          : generatedSuccess(field, generatedLearningIntent(
              field,
              request.resumeArtifact,
              generatedDate,
              stableRandomIndexFor(request),
            ) ?? intended);
      }

      const answer = await query(
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
        if (!synthetic) {
          return success({
            kind: "profile_answer_missing",
            questionId: questionId(canonicalQuestionId),
          });
        }
        const semanticDefault = semanticSyntheticTestDefault(field.label);
        const generatedDefault = semanticDefault ?? question.source.syntheticDefault ??
          generatedLearningDefaultFor(canonicalQuestionId);
        if (generatedDefault !== undefined) {
          const intended = intentFor(
            field,
            canonicalQuestionId,
            generatedDefault,
            "reviewed_catalog",
            "synthetic_test_default",
          );
          return generatedSuccess(
            field,
            intended.kind === "resolved"
              ? intended
              : generatedLearningIntent(
                  field,
                  request.resumeArtifact,
                  generatedDate,
                  stableRandomIndexFor(request),
                ) ?? intended,
          );
        }
        const generated = generatedLearningIntent(
          field,
          request.resumeArtifact,
          generatedDate,
          stableRandomIndexFor(request),
        );
        return generated === undefined
          ? success({
              kind: "profile_answer_missing",
              questionId: questionId(canonicalQuestionId),
            })
          : generatedSuccess(field, generated);
      }
      if (
        question.source.ownerProvidedOnly === true &&
        (answer.value.provenance !== "owner_provided" ||
          answer.value.lane !== "live_owner_fact")
      ) {
        if (!synthetic) return failure("protected_answer_denied");
        const generated = generatedLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        );
        return generated === undefined
          ? failure("protected_answer_denied")
          : generatedSuccess(field, generated);
      }
      const intent = intentFor(
        field,
        canonicalQuestionId,
        answer.value.value,
        answer.value.provenance,
        answer.value.lane,
      );
      if (intent.kind === "resolved") return success(intent);
      if (question.source.ownerProvidedOnly === true) {
        if (!synthetic) return failure("protected_answer_denied");
        const generated = generatedLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        );
        return generated === undefined
          ? failure("protected_answer_denied")
          : generatedSuccess(field, generated);
      }
      return synthetic
        ? generatedSuccess(field, generatedLearningIntent(
            field,
            request.resumeArtifact,
            generatedDate,
            stableRandomIndexFor(request),
          ) ?? intent)
        : success(intent);
    },
  });
}

function semanticLearningIntent(
  field: ApplicationFieldObservation,
  resumeArtifact: ApplicationAnswerResolutionRequest["resumeArtifact"],
  generatedDate: string,
): ApplicationAnswerResolutionResult | undefined {
  const value = semanticSyntheticTestDefault(field.label);
  if (value === undefined) return undefined;
  const intended = intentFor(
    field,
    undefined,
    value,
    "reviewed_catalog",
    "synthetic_test_default",
  );
  return intended.kind === "resolved"
    ? intended
    : generatedLearningIntent(field, resumeArtifact, generatedDate, () => 0);
}

/** Frozen F6 compatibility boundary. Live Workday code must use the application resolver. */
export function createAnswerResolver(
  profileQuery: ProfileQuery,
  narrativeTemplate: string | undefined,
  generatedDate = localIsoDate(new Date()),
): AnswerResolver {
  const applicationQuery: ApplicationProfileQuery = {
    async query(request, signal) {
      const result = await profileQuery.query(request as ProfileQueryRequest, signal);
      if (!result.ok) return result;
      if (result.value.kind === "profile_answer_missing") {
        return { ok: true as const, value: result.value };
      }
      return {
        ok: true,
        value: {
          ...result.value,
          lane: "live_owner_fact",
        },
      };
    },
  };
  const resolver = createApplicationAnswerResolver(
    applicationQuery,
    narrativeTemplate,
    generatedDate,
  );
  return Object.freeze({
    async resolve(request: AnswerResolutionRequest, signal: AbortSignal) {
      const result = await resolver.resolve({
        ...request,
        mode: "synthetic_test_non_submittable",
      }, signal);
      if (!result.ok) return result;
      if (result.value.kind !== "resolved") {
        return { ok: true as const, value: result.value as AnswerResolutionResult };
      }
      const value: AnswerResolutionResult = {
        kind: "resolved",
        intent: result.value.intent,
      };
      return { ok: true as const, value };
    },
  });
}
