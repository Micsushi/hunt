import type {
  ApplicationLaneAcceptance,
} from "../../ats/workday/application/lane-composition.ts";
import {
  checkpointForApplicationPage,
  isValidApplicationPageSequence,
  type ApplicationCheckpoint,
  type ApplicationPageCheck,
} from "../../ats/workday/application/page-walk-contract.ts";
import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

const reviewedStructuralValues = ["social.linkedin"] as const;
const reviewedSha256Keys = ["profileFieldLearningSha256"] as const;

export interface ApplicationWalkAcceptanceV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-application-walk-acceptance-v1";
  readonly checkpoint: ApplicationCheckpoint;
  readonly status: "passed";
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly completedPages: number;
  readonly pageChecks: readonly ApplicationPageCheck[];
  readonly laneAcceptances: readonly ApplicationLaneAcceptance[];
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pass";
}

export interface WriteApplicationWalkEvidenceRequest {
  readonly root: string;
  readonly acceptance: ApplicationWalkAcceptanceV1;
  readonly sensitiveValues: readonly string[];
}

export async function writeApplicationWalkEvidence(
  request: WriteApplicationWalkEvidenceRequest,
): Promise<void> {
  writeAtomicJsonEvidence({
    root: request.root,
    value: admitApplicationWalkAcceptance(request.acceptance),
    sensitiveValues: request.sensitiveValues,
    reviewedStructuralValues,
    reviewedSha256Keys,
    label: "application-walk",
    fileName: "application-walk-acceptance.json",
  });
}

export function admitApplicationWalkAcceptance(
  value: ApplicationWalkAcceptanceV1,
): ApplicationWalkAcceptanceV1 {
  const expected = [
    "schemaVersion", "evidenceRevision", "checkpoint", "status",
    "sourceRevision", "revisionId", "approvalId", "journeyId",
    "targetHandleId", "completedPages", "pageChecks", "laneAcceptances",
    "submitActivated", "privacyScan", "cleanup",
  ];
  const count = value.pageChecks.length;
  if (!exactKeys(value, expected)) denied("shape");
  if (
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-application-walk-acceptance-v1" ||
    value.status !== "passed" ||
    (value.checkpoint !== "pre_review" &&
      value.pageChecks.at(-1)?.checkpoint !== value.checkpoint) ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(value.revisionId) ||
    !/^approval_[A-Za-z0-9_-]{16,64}$/u.test(value.approvalId) ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    value.completedPages !== count ||
    value.submitActivated !== false ||
    value.privacyScan !== "pass" ||
    value.cleanup !== "pass"
  ) denied("header");
  if (!validPageChecks(value.pageChecks)) denied("page_checks");
  const laneChecks = collapseRevealedQuestionnaireChecks(value.pageChecks);
  if (value.laneAcceptances.length !== laneChecks.length) denied("lane_count");
  const invalidLane = value.laneAcceptances.findIndex((lane, index) =>
    !validLaneAcceptances([lane], [laneChecks[index]!])
  );
  if (invalidLane !== -1) denied(`lane_${invalidLane}`);
  return Object.freeze({
    ...value,
    pageChecks: Object.freeze(value.pageChecks.map((item) => Object.freeze({ ...item }))),
    laneAcceptances: Object.freeze(value.laneAcceptances.map((item) =>
      structuredClone(item)
    )),
  });
}

function collapseRevealedQuestionnaireChecks(
  values: readonly ApplicationPageCheck[],
): readonly ApplicationPageCheck[] {
  const checks: ApplicationPageCheck[] = [];
  for (const value of values) {
    if (
      value.checkpoint === "questionnaire_verified" &&
      checks.at(-1)?.checkpoint === "questionnaire_verified"
    ) checks[checks.length - 1] = value;
    else checks.push(value);
  }
  return checks;
}

function validPageChecks(values: readonly ApplicationPageCheck[]): boolean {
  return isValidApplicationPageSequence(values.map(({ page }) => page)) &&
    values.every((value) =>
    exactKeys(value, [
      "page", "checkpoint", "independentlyVerified", "requiredFields",
      "verifiedFields", "duplicateRows",
    ]) &&
    value.checkpoint === checkpointForApplicationPage(value.page) &&
    value.independentlyVerified === true &&
    Number.isSafeInteger(value.requiredFields) && value.requiredFields >= 0 &&
    value.verifiedFields === value.requiredFields &&
    value.duplicateRows === 0
  );
}

function validLaneAcceptances(
  values: readonly ApplicationLaneAcceptance[],
  checks?: readonly ApplicationPageCheck[],
): boolean {
  return (checks === undefined || values.length === checks.length) &&
    values.every((value, index) =>
    (checks === undefined || value.checkpoint === checks[index]?.checkpoint) &&
    (value.checkpoint === "resume_verified"
      ? validResume(value)
      : value.checkpoint === "profile_verified"
        ? validProfile(value)
        : validQuestionnaire(value))
  );
}

function validResume(
  value: Extract<ApplicationLaneAcceptance, { checkpoint: "resume_verified" }>,
): boolean {
  return exactKeys(value, [
    "schemaVersion", "checkpoint", "artifactId", "sizeBytes", "fileType",
    "browserState", "independentlyVerified", "duplicateUploadAvoided",
    "replacedExisting", "submitActivated", "privacyScan",
  ]) && value.schemaVersion === 1 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.artifactId) &&
    Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0 &&
    value.fileType === "pdf" &&
    exactKeys(value.browserState, [
      "variant", "inputCardinality", "uploadedFileCount", "uploadComplete",
      "requiredErrorVisible", "removeControlCardinality",
    ]) &&
    value.browserState.variant === "workday_resume_file_upload_v1" &&
    value.browserState.inputCardinality === 1 &&
    value.browserState.uploadedFileCount === 1 &&
    value.browserState.uploadComplete === true &&
    value.browserState.requiredErrorVisible === false &&
    (value.browserState.removeControlCardinality === 0 ||
      value.browserState.removeControlCardinality === 1) &&
    value.independentlyVerified === true &&
    typeof value.duplicateUploadAvoided === "boolean" &&
    typeof value.replacedExisting === "boolean" &&
    value.submitActivated === false && value.privacyScan === "pass";
}

function validProfile(
  value: Extract<ApplicationLaneAcceptance, { checkpoint: "profile_verified" }>,
): boolean {
  const requiredKeys = [
    "schemaVersion", "checkpoint", "pageType", "verifiedFields",
    "ownedDuplicateRows", "independentlyVerified", "submitActivated",
    "privacyScan",
  ];
  const learningKeys = [
    "schemaVersion", "checkpoint", "pageType", "verifiedFields",
    "ownedDuplicateRows", "independentlyVerified", "profileFieldLearningSha256",
    "submitActivated", "privacyScan",
  ];
  const hasLearningDigest = Object.hasOwn(value, "profileFieldLearningSha256");
  const hasSyntheticDefault = value.verifiedFields.some((field) =>
    field.lane === "synthetic_test_default"
  );
  return (hasLearningDigest
    ? exactKeys(value, learningKeys) &&
      typeof value.profileFieldLearningSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(value.profileFieldLearningSha256)
    : exactKeys(value, requiredKeys)) &&
    value.schemaVersion === 1 &&
    (value.pageType === "profile" || value.pageType === "contact") &&
    (!hasSyntheticDefault || hasLearningDigest) &&
    value.verifiedFields.every((field) => {
      const keys = Object.keys(field);
      const required = [
        "fieldId", "questionType", "answerType", "uiBehavior", "uiVariant",
        "provenance", "lane",
      ];
      const optional = ["optionMappingProvenance", "rowKey"];
      return required.every((key) => keys.includes(key)) &&
        keys.every((key) => required.includes(key) || optional.includes(key)) &&
        !keys.includes("value") &&
        /^[a-z][a-z0-9_.-]{0,127}$/u.test(field.fieldId) &&
        new Set([
          "identity", "address", "phone", "application_source", "prior_employment",
          "employment", "experience", "education", "skill", "language", "website",
          "social_network",
        ])
          .has(field.questionType) &&
        new Set([
          "text", "phone", "date", "month", "year", "number", "url", "boolean",
          "option", "single_select", "multi_select",
        ]).has(field.answerType) &&
        new Set([
          "text", "textarea", "phone", "date", "month", "year", "number", "url",
          "checkbox", "select", "multi_select", "search_select", "radio_group",
        ])
          .has(field.uiBehavior) &&
        new Set([
          "workday_text_v1", "workday_text_v2", "workday_phone_v1", "workday_phone_v2",
          "workday_date_v1", "workday_checkbox_v2", "workday_search_select_v1",
          "workday_month_v1", "workday_year_v1", "workday_number_v1",
          "workday_textarea_v1", "workday_select_v1", "workday_multi_select_v1",
          "workday_search_select_v2",
          "workday_source_select_v1", "workday_previous_worker_radio_v1",
        ]).has(field.uiVariant) &&
        new Set([
          "owner_provided", "resume_verified", "configured_template", "journey_derived",
          "generated_default",
        ])
          .has(field.provenance) &&
        ((field.lane === "live_owner_fact" && field.provenance !== "generated_default") ||
          (field.lane === "synthetic_test_default" && field.provenance === "generated_default")) &&
        (field.optionMappingProvenance === undefined ||
          field.optionMappingProvenance === "visible_option") &&
        (field.rowKey === undefined ||
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(field.rowKey));
    }) &&
    value.ownedDuplicateRows === 0 && value.independentlyVerified === true &&
    value.submitActivated === false && value.privacyScan === "pass";
}

function validQuestionnaire(
  value: Extract<ApplicationLaneAcceptance, { checkpoint: "questionnaire_verified" }>,
): boolean {
  return exactKeys(value, [
    "schemaVersion", "checkpoint", "answers", "protectedPlaceholderCount",
    "independentlyVerified", "submitActivated", "privacyScan",
  ]) && value.schemaVersion === 1 &&
    value.answers.every((answer) =>
      exactKeys(answer, [
        "fieldId", "questionId", "provenance", "lane", "protectedCategory",
        "templateRevision", "verification",
      ]) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(answer.fieldId) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(answer.questionId) &&
      new Set([
        "owner_provided", "resume_verified", "configured_template",
        "reviewed_catalog", "visible_option",
      ]).has(answer.provenance) &&
      ((answer.lane === "live_owner_fact" &&
        answer.provenance !== "reviewed_catalog" && answer.provenance !== "visible_option") ||
        (answer.lane === "synthetic_test_default" &&
          (answer.provenance === "reviewed_catalog" || answer.provenance === "visible_option"))) &&
      (answer.protectedCategory === null ||
        new Set(["authorization", "legal", "consent"])
          .has(answer.protectedCategory)) &&
      (answer.templateRevision === null ||
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(answer.templateRevision)) &&
      answer.verification === "independent"
    ) &&
    value.protectedPlaceholderCount === 0 &&
    value.independentlyVerified === true && value.submitActivated === false &&
    value.privacyScan === "pass";
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key, index) => keys[index] === key);
}

function denied(reason = "invalid"): never {
  throw new Error(`application-walk evidence denied: ${reason}`);
}
