import type {
  ApplicationLaneAcceptance,
} from "../../ats/workday/application/lane-composition.ts";
import type {
  ApplicationCheckpoint,
  ApplicationPageCheck,
} from "../../ats/workday/application/page-walk-contract.ts";
import { writeAtomicJsonEvidence } from "./private/atomic-json-evidence.ts";

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
    value: exactAcceptance(request.acceptance),
    sensitiveValues: request.sensitiveValues,
    label: "application-walk",
  });
}

function exactAcceptance(
  value: ApplicationWalkAcceptanceV1,
): ApplicationWalkAcceptanceV1 {
  const expected = [
    "schemaVersion", "evidenceRevision", "checkpoint", "status",
    "sourceRevision", "revisionId", "approvalId", "journeyId",
    "targetHandleId", "completedPages", "pageChecks", "laneAcceptances",
    "submitActivated", "privacyScan", "cleanup",
  ];
  const count = checkpointCount(value.checkpoint);
  if (
    !exactKeys(value, expected) ||
    value.schemaVersion !== 1 ||
    value.evidenceRevision !== "s2-application-walk-acceptance-v1" ||
    value.status !== "passed" ||
    count === undefined ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision) ||
    !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(value.revisionId) ||
    !/^approval_[A-Za-z0-9_-]{16,64}$/u.test(value.approvalId) ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId) ||
    value.completedPages !== count ||
    value.pageChecks.length !== count ||
    value.laneAcceptances.length !== count ||
    !validPageChecks(value.pageChecks) ||
    !validLaneAcceptances(value.laneAcceptances) ||
    value.submitActivated !== false ||
    value.privacyScan !== "pass" ||
    value.cleanup !== "pass"
  ) denied();
  return Object.freeze({
    ...value,
    pageChecks: Object.freeze(value.pageChecks.map((item) => Object.freeze({ ...item }))),
    laneAcceptances: Object.freeze(value.laneAcceptances.map((item) =>
      structuredClone(item)
    )),
  });
}

function validPageChecks(values: readonly ApplicationPageCheck[]): boolean {
  const pages = ["resume", "profile", "questionnaire"] as const;
  const checkpoints = [
    "resume_verified", "profile_verified", "questionnaire_verified",
  ] as const;
  return values.every((value, index) =>
    exactKeys(value, [
      "page", "checkpoint", "independentlyVerified", "requiredFields",
      "verifiedFields", "duplicateRows",
    ]) &&
    value.page === pages[index] &&
    value.checkpoint === checkpoints[index] &&
    value.independentlyVerified === true &&
    Number.isSafeInteger(value.requiredFields) && value.requiredFields >= 0 &&
    value.verifiedFields === value.requiredFields &&
    value.duplicateRows === 0
  );
}

function validLaneAcceptances(
  values: readonly ApplicationLaneAcceptance[],
): boolean {
  const checkpoints = [
    "resume_verified", "profile_verified", "questionnaire_verified",
  ] as const;
  return values.every((value, index) =>
    value.checkpoint === checkpoints[index] &&
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
    value.browserState.removeControlCardinality === 1 &&
    value.independentlyVerified === true &&
    typeof value.duplicateUploadAvoided === "boolean" &&
    typeof value.replacedExisting === "boolean" &&
    value.submitActivated === false && value.privacyScan === "pass";
}

function validProfile(
  value: Extract<ApplicationLaneAcceptance, { checkpoint: "profile_verified" }>,
): boolean {
  return exactKeys(value, [
    "schemaVersion", "checkpoint", "pageType", "verifiedFields",
    "ownedDuplicateRows", "independentlyVerified", "submitActivated",
    "privacyScan",
  ]) && value.schemaVersion === 1 &&
    (value.pageType === "profile" || value.pageType === "contact") &&
    value.verifiedFields.every((field) => {
      const keys = Object.keys(field);
      const required = [
        "fieldId", "questionType", "answerType", "uiBehavior", "uiVariant",
        "provenance",
      ];
      const optional = ["optionMappingProvenance", "rowKey"];
      return required.every((key) => keys.includes(key)) &&
        keys.every((key) => required.includes(key) || optional.includes(key)) &&
        !keys.includes("value") &&
        /^[a-z][a-z0-9_.-]{0,127}$/u.test(field.fieldId) &&
        new Set(["identity", "address", "phone", "experience", "education", "skill"])
          .has(field.questionType) &&
        new Set(["text", "phone", "date", "option"]).has(field.answerType) &&
        new Set(["text", "phone", "date", "search_select"]).has(field.uiBehavior) &&
        new Set([
          "workday_text_v1", "workday_phone_v1", "workday_date_v1",
          "workday_search_select_v1",
        ]).has(field.uiVariant) &&
        new Set(["owner_provided", "resume_verified", "configured_template"])
          .has(field.provenance) &&
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
        "fieldId", "questionId", "provenance", "protectedCategory",
        "templateRevision", "verification",
      ]) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(answer.fieldId) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(answer.questionId) &&
      new Set([
        "owner_provided", "resume_verified", "configured_template",
        "reviewed_catalog", "visible_option",
      ]).has(answer.provenance) &&
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

function checkpointCount(checkpoint: ApplicationCheckpoint): number | undefined {
  return checkpoint === "resume_verified"
    ? 1
    : checkpoint === "profile_verified"
      ? 2
      : checkpoint === "questionnaire_verified" || checkpoint === "pre_review"
        ? 3
        : undefined;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key, index) => keys[index] === key);
}

function denied(): never {
  throw new Error("application-walk evidence denied");
}
