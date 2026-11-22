import { uploadLabelKind } from '../../../extension/page-runtime/upload-label.js';
import {
  boundedText,
  optionId,
  questionId,
  type AnswerResolutionRequest,
  type AnswerResolutionResult,
  type AnswerResolver,
  type AnswerProvenance,
  type BrowserReadback,
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
import { isEmptyCatalogMessage } from "../options/catalog.ts";
import { consentOption, mapVisibleOption } from "../options/mapper.ts";
import {
  canadianWorkEligibilityLabels,
  generatedLearningDefaultFor,
  inspectQuestionMatch,
  questionForField,
  resolveQuestion,
  type CanonicalQuestionId,
} from "../questions/catalog.ts";
import { normalizeCatalogText } from "../questions/normalize.ts";
import { employmentQuestion, referralQuestion, sameEmployer } from '../questions/matching.ts';
import {
  contractApprovedPrivacyChoices,
  isApplicationAccuracyDeclaration,
  isCriminalConvictionDisclosure,
  isRecruitmentTermsConsent,
  protectedQuestionCategory,
} from "../questions/protected.ts";
import { semanticSyntheticTestDefault, syntheticTestDate } from "./testing-policy.ts";

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

function hasSafeCommittedValue(
  field: ApplicationFieldObservation,
  value: BrowserReadback | undefined,
): boolean {
  return field.populatedValueValid === true &&
    (field.behavior === "text" || field.behavior === "textarea" || field.behavior === "date") &&
    value?.kind === "text" && value.value.trim() !== "";
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
    (field.behavior === "text" || field.behavior === "textarea")
  ) {
    if (field.constraints?.inputType === "number" && (
      typeof value !== "number" || !Number.isFinite(value) ||
      (field.constraints.min != null && value < field.constraints.min) ||
      (field.constraints.max != null && value > field.constraints.max) ||
      (field.constraints.step != null && field.constraints.step > 0 &&
        Math.abs((value - (field.constraints.min ?? 0)) / field.constraints.step -
          Math.round((value - (field.constraints.min ?? 0)) / field.constraints.step)) > 1e-8)
    )) return Object.freeze({ kind: "unsupported", fieldId: field.fieldId });
    return Object.freeze({
      kind: "resolved",
      lane,
      intent: Object.freeze({
        kind: "text",
        behavior: field.behavior,
        fieldId: field.fieldId,
        target: field.target,
        value: typeof value==='boolean' ? value?'Yes':'No' : String(value),
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
    const option = mapVisibleOption(value, field.options, canonicalQuestionId);
    if (option.kind !== "matched") {
      if (option.kind === 'option_no_match' && field.queryable && typeof value === 'string' && value.trim() &&
          normalizeCatalogText(field.searchQuery ?? '') !== normalizeCatalogText(value) && [...value].length <= 512) {
        return Object.freeze({kind:'resolved',lane,intent:Object.freeze({kind:'choice',behavior:field.behavior,
          fieldId:field.fieldId,target:field.target,optionId:optionId('deferred-search'),
          expectedOption:boundedText(value),provenance})});
      }
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
    const generated = generateSyntheticTextValue(field.constraints, field.rawQuestion ?? field.label);
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
        isoDate: syntheticTestDate(field.rawQuestion ?? field.label, generatedDate),
        provenance: "reviewed_catalog",
      },
    };
  }
  if (
    field.behavior === "radio" || field.behavior === "select" ||
    field.behavior === "listbox"
  ) {
    const options = field.options.filter(({ label }) =>
      !placeholderOption.test(String(label).trim().toLowerCase()) && !isEmptyCatalogMessage(String(label))
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
  selectRandomIndex: (length: number) => number = () => 0,
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
      !placeholderOption.test(String(label).trim().toLowerCase()) && !isEmptyCatalogMessage(String(label))
    );
    if (options.length !== length) throw new TypeError("synthetic option set mismatch");
    // Identical physical occurrences must receive one class intent so a
    // tokenless reorder cannot swap answers. Including behavior and the exact
    // option catalog keeps same-labelled questions with different choices
    // independent.
    const fieldKey = String(field.fieldId);
    const classKey = [
      normalizeCatalogText(field.rawQuestion ?? field.label),
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
    }
    const committed = request.committedReadback?.kind === "selected"
      ? request.committedReadback.option
      : null;
    const adopted = committed === null || committed === undefined
      ? -1
      : options.findIndex(({ label }) => normalizeCatalogText(label) === normalizeCatalogText(committed));
    if (adopted >= 0) {
      remember(normalizeCatalogText(options[adopted]!.label));
      if (existing !== undefined) syntheticReplacementReasons.set(fieldKey, "committed_value_adopted");
      return adopted;
    }
    const selected = selectRandomIndex(length);
    if (Number.isSafeInteger(selected) && selected >= 0 && selected < length) {
      remember(normalizeCatalogText(options[selected]!.label));
      if (existing !== undefined) syntheticReplacementReasons.set(fieldKey, "cached_option_unavailable");
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
      // Optional fields are outside fill scope, including saved facts and test defaults.
      // readback_only means no intent; it does not certify the existing value.
      if (!field.required) return success({ kind: "readback_only", fieldId: field.fieldId });
      const syntheticMode = request.mode === "synthetic_test_non_submittable";
      const fallbackAllowed = syntheticMode ||
        request.answerFallbackPolicy === "deterministic_site_valid_editable";
      const provisionalAnswer = () => {
        if (!fallbackAllowed) return failure("protected_answer_denied");
        const generated = semanticLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        ) ?? generatedLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        );
        return generated === undefined ? unsupported(field) : generatedSuccess(field, generated);
      };
      const questionText = field.rawQuestion ?? field.label;
      // A required upload can be a transcript, portfolio or another document.
      // A draft fallback never authorizes attaching the applicant's résumé to it.
      if (field.behavior === 'file_upload' && (field.state === 'ambiguous' || uploadLabelKind(questionText) !== 'resume')) {
        return unsupported(field);
      }
      if (field.readOnly === true || field.constraints?.readOnly === true) {
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

      // The saved profile has no conviction-history fact. Existing answers still need owner review.
      if (isCriminalConvictionDisclosure(questionText) || isApplicationAccuracyDeclaration(questionText)) {
        return failure("protected_answer_denied");
      }
      if ((field.rawQuestion !== undefined || field.rawOptions !== undefined) && field.state === 'populated' &&
          (!['text', 'textarea', 'date'].includes(field.behavior) || field.populatedValueValid !== false)) {
        const current = request.committedReadback;
        const committed = current === undefined ||
          field.behavior === 'checkbox' && current.kind === 'checked' && current.checked ||
          ['text', 'textarea', 'date'].includes(field.behavior) && current.kind === 'text' && current.value.trim() !== '' ||
          ['select', 'radio', 'listbox'].includes(field.behavior) && current.kind === 'selected' && current.option !== null && current.option.trim() !== '' &&
            !placeholderOption.test(normalizeCatalogText(current.option)) && !isEmptyCatalogMessage(current.option);
        if (committed) return success({kind: 'readback_only', fieldId: field.fieldId});
      }
      const questionResolution = resolveQuestion(questionText, request.employerNames);
      const protectedCategory = protectedQuestionCategory(questionText,
        questionResolution.kind === 'resolved' ? questionResolution.id : undefined, field.rawOptions ?? field.options.map(option => option.label));
      if ((field.rawQuestion !== undefined || field.rawOptions !== undefined) && field.behavior === 'file_upload') {
        return unsupported(field);
      }
      if (protectedCategory === "consent") {
        if (field.state === "populated") return success({kind:'readback_only',fieldId:field.fieldId});
        const backgroundCheck = questionResolution.kind === "resolved" && questionResolution.id === "owner-question-background-check-willing" &&
          field.required && field.behavior === "radio" && field.options.length === 2 &&
          ["yes", "no"].every(answer => field.options.some(option => normalizeCatalogText(option.label) === answer));
        if (!backgroundCheck && !isRecruitmentTermsConsent(questionText, field.required ? request.employerNames : undefined)) return failure("protected_answer_denied");
        const factId = backgroundCheck ? "background_check_willing" : "terms_consent";
        const consent = await query({profileId:request.profileId, profileRevision:request.profileRevision, factId}, signal);
        if (!consent.ok) return consent;
        if (consent.value.kind !== "answered" || consent.value.provenance !== "owner_provided" ||
            consent.value.lane !== "live_owner_fact" || typeof consent.value.value !== "boolean") return failure("protected_answer_denied");
        const value = consent.value.value;
        if (field.behavior === "select" || field.behavior === "radio" || field.behavior === "listbox") {
          const choice = consentOption(value, field.options, field.rawOptions);
          if (!choice) return failure("protected_answer_denied");
          return resolved({kind:"choice", behavior:field.behavior, fieldId:field.fieldId, target:field.target,
            optionId:choice.id, expectedOption:choice.label, provenance:"owner_provided"}, "live_owner_fact");
        }
        return success(intentFor(field, undefined, value, "owner_provided", "live_owner_fact"));
      }
      if (field.rawOptions !== undefined) {
        if (!fallbackAllowed) return failure('protected_answer_denied');
        if (field.behavior !== 'select' && field.behavior !== 'radio' && field.behavior !== 'listbox') return unsupported(field);
        const choices = field.rawOptions.map((label, i) => ({label, option: field.options[i]}))
          .filter(({label}) => label.trim() && !placeholderOption.test(normalizeCatalogText(label)) && !isEmptyCatalogMessage(label));
        const negatives = choices.filter(({label}) => /^(?:no|n|false)$/u.test(normalizeCatalogText(label)));
        const option = (negatives.length === 1 ? negatives[0] : choices[0])?.option;
        if (!option) return unsupported(field);
        return resolved({kind: 'choice', behavior: field.behavior, fieldId: field.fieldId,
          target: field.target, optionId: option.id, expectedOption: option.label, provenance: 'visible_option'}, 'synthetic_test_default');
      }
      if (!syntheticMode && field.state === "populated" &&
          hasSafeCommittedValue(field, request.committedReadback)) {
        return success({ kind: "readback_only", fieldId: field.fieldId });
      }

      if (normalizeCatalogText(field.label)==='are you legally eligible to work in canada without sponsorship') {
        const values=[];
        for(const factId of ['work_authorization_canada','sponsorship_required_canada'] as const) {
          const answer=await query({profileId:request.profileId,profileRevision:request.profileRevision,factId},signal);
          if(!answer.ok)return answer;
          values.push(answer.value);
        }
        if(values.every(answer=>answer.kind==='answered' && answer.provenance==='owner_provided' && typeof answer.value==='boolean')) {
          const authorized=values[0]!,sponsorship=values[1]!;
          if(authorized.kind==='answered' && sponsorship.kind==='answered') {
            const intended=intentFor(field,undefined,authorized.value===true && sponsorship.value===false,'owner_provided','live_owner_fact');
            if(intended.kind==='resolved')return success(intended);
          }
        }
      }
      const employment = employmentQuestion(questionText);
      const referral=referralQuestion(questionText);
      // Complete long employment/referral wording can still apply the scoped owner
      // answer. All other long questions remain provisional, never prefix matches.
      if (field.rawQuestion !== undefined &&
          !((employment && !employment.negated) || (referral && !referral.negated))) return provisionalAnswer();
      const ownerDefaults = (profileQuery as ApplicationProfileQuery).ownerDefaults;
      const employerMatches = !employment?.employer || request.employerNames?.some(name=>sameEmployer(name,employment.employer!)) === true;
      if (employment && !employment.negated && employerMatches && ownerDefaults &&
          (employment.includesAnotherEmployer || !/\b(?:subsidiar|affiliate)\w*/iu.test(questionText))) {
        const ids = employment.period==='ever' ? ['current_associate','previously_worked_for_organization'] as const :
          employment.period==='current' ? ['current_associate'] as const : ['previously_worked_for_organization'] as const;
        const answers = [];
        for (const factId of ids) {
          const result = await query({profileId:request.profileId,profileRevision:request.profileRevision,factId},signal);
          if (!result.ok) return result;
          answers.push(result.value);
        }
        const positive = answers.some(answer=>answer.kind==='answered' && answer.value===true);
        if (employment.includesAnotherEmployer) {
          // Employment by the hiring company proves Yes. Its No default leaves the other employer unknown.
          const verified = answers.find(answer=>answer.kind==='answered' && answer.value===true && answer.provenance!=='configured_template');
          if (!verified && !fallbackAllowed) return failure('question_unknown');
          const intended = intentFor(field, undefined, positive, verified?.kind==='answered' ? verified.provenance : 'reviewed_catalog',
            verified ? 'live_owner_fact' : 'synthetic_test_default');
          return intended.kind==='resolved' || !fallbackAllowed ? success(intended) : provisionalAnswer();
        }
        // Broad owner defaults cover contract/internship and current/former wording;
        // a positive saved fact does not prove a qualified relationship.
        if (!employment.qualified || !positive) {
          const negativeOptions = !positive && employment.period === 'past' && employment.employer ?
            field.options.filter(({label}) => {
              const employer = /^i have not previously been employed at (.+)$/u.exec(normalizeCatalogText(label))?.[1];
              return employer !== undefined && sameEmployer(employer, employment.employer!);
            }) : [];
          const intended = intentFor(field, employment.period==='current' ? 'workday-question-current-associate' : 'workday-placeholder-prior-employment',
            negativeOptions.length === 1 ? negativeOptions[0]!.label : positive, 'owner_provided', 'live_owner_fact');
          if (intended.kind==='resolved') return success(intended);
          if (!fallbackAllowed) return success(intended);
          const generated=generatedLearningIntent(field,request.resumeArtifact,generatedDate,stableRandomIndexFor(request));
          return generated===undefined ? unsupported(field) : generatedSuccess(field,generated);
        }
      }
      // Employer-specific profile facts cannot answer questions about a third party.
      if (referral?.employer && request.employerNames!==undefined && !request.employerNames.some(name=>sameEmployer(name,referral.employer!))) {
        if(!fallbackAllowed)return failure('question_unknown');
        const generated=generatedLearningIntent(field,request.resumeArtifact,generatedDate,stableRandomIndexFor(request));
        return generated===undefined?unsupported(field):generatedSuccess(field,generated);
      }
      if (employment?.qualified && inspectQuestionMatch(questionText).provisional ||
          employment?.employer && request.employerNames !== undefined && !request.employerNames.some(name=>sameEmployer(name,employment.employer!))) {
        if (!fallbackAllowed) return failure('question_unknown');
        const generated = generatedLearningIntent(field,request.resumeArtifact,generatedDate,stableRandomIndexFor(request));
        return generated === undefined ? unsupported(field) : generatedSuccess(field,generated);
      }
      const employmentScope = questionResolution.kind === "resolved" &&
        (questionResolution.id === "s1-question-work-authorization" ||
          questionResolution.id === "s1-question-sponsorship-required");
      const employmentLabel = employmentScope ? normalizeCatalogText(field.label) : "";
      const canadianSponsoringEmployer = /^(?:do you now or will you in the future require (?:immigration )?sponsorship to work for (.+)|will you(?: now or in the future)? require (?:immigration )?sponsorship from (.+) to work) in canada$/u.exec(employmentLabel)?.slice(1).find(Boolean);
      const canadaScope = canadianWorkEligibilityLabels.some(label => normalizeCatalogText(label) === employmentLabel) ||
        /^(?:are you (?:legally )?(?:authorized|authorised|entitled) to work(?: (?:legally|lawfully))? in (?:the )?canada|(?:will you(?: now or in the future)? require|do you(?: now or in the future)? (?:require|need)) (?:employment |visa |employer )?sponsorship(?: to work(?: legally)?)? in (?:the )?canada)$/u.test(employmentLabel) ||
        canadianSponsoringEmployer!==undefined && request.employerNames?.some(name=>sameEmployer(name,canadianSponsoringEmployer))===true;
      const generalScope = /^(?:are you (?:legally )?(?:authorized|authorised) to work in this (?:location|country)|(?:will you(?: now or in the future)? require|do you require) (?:employment |visa |employer )?sponsorship(?: now or in the future)?)$/u.test(employmentLabel);
      if (questionResolution.kind === "resolved" &&
          questionResolution.id === "s1-question-work-authorization" &&
          /\b(?:any employer|without restrictions?|no restrictions?|unrestricted|(?:provide|show|present) proof|proof of|open work permit)\b/iu.test(field.label)) {
        return provisionalAnswer();
      }
      if (employmentScope && !canadaScope && !generalScope) {
        // A country-scoped fact cannot answer a different or qualified scope.
        // An authorized draft fallback must remain visibly provisional instead.
        return provisionalAnswer();
      }
      if (questionResolution.kind === "unknown") {
        if (!fallbackAllowed) {
          return failure(protectedCategory === null ? "question_unknown" : "protected_answer_denied");
        }
        const generated = semanticLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        ) ??
          generatedLearningIntent(
            field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
          );
        return generated === undefined
          ? failure("question_unknown")
          : generatedSuccess(field, generated);
      }
      if (questionResolution.kind === "ambiguous") {
        if (!fallbackAllowed) {
          return failure(protectedCategory === null ? "question_ambiguous" : "protected_answer_denied");
        }
        const generated = semanticLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        ) ??
          generatedLearningIntent(
            field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
          );
        return generated === undefined
          ? failure("question_ambiguous")
          : generatedSuccess(field, generated);
      }

      const canonicalQuestionId = questionResolution.id as CanonicalQuestionId;
      const question = questionForField(questionText, field.behavior);
      if (question === undefined) {
        if (!fallbackAllowed) {
          return protectedCategory === null
            ? unsupported(field)
            : failure("protected_answer_denied");
        }
        const generated = semanticLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        ) ??
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
        }, syntheticMode ? "synthetic_test_default" : "live_owner_fact");
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
        if (!fallbackAllowed) {
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
        if (!fallbackAllowed) return failure("protected_answer_denied");
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
        if (!fallbackAllowed) return failure("protected_answer_denied");
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

      let answer = await query(
        {
          profileId: request.profileId,
          profileRevision: request.profileRevision,
          factId: question.source.factId === "work_authorization" && canadaScope
            ? "work_authorization_canada"
            : question.source.factId === "sponsorship_required" && canadaScope
            ? "sponsorship_required_canada"
            : question.source.factId === "salary_expectations" && field.constraints?.inputType === "number"
            ? "desired_salary"
            : question.source.factId,
        },
        signal,
      );
      if (!answer.ok) {
        return answer;
      }
      if (employment?.period === 'ever') {
        const current = await query({profileId:request.profileId,profileRevision:request.profileRevision,
          factId:'current_associate'},signal);
        if (!current.ok) return current;
        // Current or former is an OR, not an alias for either individual answer.
        if (current.value.kind==='answered' && current.value.value===true) answer=current;
        else if (answer.value.kind==='answered' && answer.value.value===false &&
            !(current.value.kind==='answered' && current.value.value===false)) {
          if (!fallbackAllowed) return success({kind:'profile_answer_missing',questionId:questionId(canonicalQuestionId)});
          const generated=semanticLearningIntent(field,request.resumeArtifact,generatedDate,stableRandomIndexFor(request)) ??
            generatedLearningIntent(field,request.resumeArtifact,generatedDate,stableRandomIndexFor(request));
          return generated===undefined ? unsupported(field) : generatedSuccess(field,generated);
        }
      }
      const savedSource=answer.value.kind==='answered'?answer.value.value:undefined;
      if (question.source.factId==='application_source' && ownerDefaults?.applicationSources &&
          (answer.value.kind==='profile_answer_missing' ||
            typeof savedSource==='string' && ownerDefaults.applicationSources.some(value=>normalizeCatalogText(value)===normalizeCatalogText(savedSource)))) {
        // These are owner-approved alternatives, not semantically identical labels.
        const preferences=typeof savedSource==='string'?[savedSource,...ownerDefaults.applicationSources]:ownerDefaults.applicationSources;
        for (const value of preferences) {
          const intended=intentFor(field,canonicalQuestionId,value,'owner_provided','live_owner_fact');
          if (intended.kind==='resolved') return success(intended);
        }
      }
      if (answer.value.kind === "profile_answer_missing") {
        if (question.source.factId==='associate_referral' && ownerDefaults) {
          const intended=intentFor(field,canonicalQuestionId,ownerDefaults.associateReferral,'owner_provided','live_owner_fact');
          if (intended.kind==='resolved') return success(intended);
        }
        if (!fallbackAllowed) {
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
        if (!fallbackAllowed) return failure("protected_answer_denied");
        const generated = generatedLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        );
        return generated === undefined
          ? failure("protected_answer_denied")
          : generatedSuccess(field, generated);
      }
      const answerValue = answer.value.value;
      const coopText = canonicalQuestionId === "owner-question-current-coop-wil" &&
        (field.behavior === "text" || field.behavior === "textarea") &&
        field.constraints?.inputType !== "number" && typeof answerValue === "boolean";
      const intent = intentFor(
        field,
        canonicalQuestionId,
        coopText ? (answerValue ? "Yes" : "No") : answerValue,
        answer.value.provenance,
        answer.value.lane,
      );
      if (intent.kind === "resolved") return success(intent);
      if (intent.kind === 'option_ambiguous' && question.source.ownerProvidedOnly === true && !fallbackAllowed) return failure('protected_answer_denied');
      if (!fallbackAllowed && (intent.kind === "option_ambiguous" ||
          (intent.kind === "option_no_match" && question.source.ownerProvidedOnly !== true))) {
        return success(intent);
      }
      if (question.source.ownerProvidedOnly === true) {
        if (!fallbackAllowed) return failure("protected_answer_denied");
        const generated = generatedLearningIntent(
          field, request.resumeArtifact, generatedDate, stableRandomIndexFor(request),
        );
        return generated === undefined
          ? failure("protected_answer_denied")
          : generatedSuccess(field, generated);
      }
      return fallbackAllowed
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
  selectRandomIndex: (length: number) => number,
): ApplicationAnswerResolutionResult | undefined {
  const value = semanticSyntheticTestDefault(field.rawQuestion ?? field.label);
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
    : generatedLearningIntent(field, resumeArtifact, generatedDate, selectRandomIndex);
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
        answerFallbackPolicy: "deterministic_site_valid_editable",
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
