import { createHash } from "node:crypto";

import type { BrowserPageId } from "../../../contracts/index.ts";
import type { CommittedProfileField } from "./profile/index.ts";

export interface ProfileSyntheticFieldEvidence {
  readonly occurrenceId: string;
  readonly questionId: string;
  readonly fieldId: string;
  readonly rowKey: string | null;
  readonly labelSha256: string;
  readonly required: boolean;
  readonly semanticQuestionType: "unknown";
  readonly answerType: "text" | "boolean" | "single_select" | "multi_select" | "date" | "file";
  readonly controlType: "text" | "textarea" | "checkbox" | "radio" | "select" | "listbox" | "date" | "file_upload";
  readonly uiVariant: string;
  readonly optionsSha256: string;
  readonly constraintsSha256: string;
  readonly committedReadbackSha256: string;
  readonly provenance: "generated_default";
}

export function profileSyntheticFieldEvidence(
  pageId: BrowserPageId,
  field: CommittedProfileField,
): ProfileSyntheticFieldEvidence {
  const rowKey = field.rowKey ?? null;
  return Object.freeze({
    occurrenceId: sha256(`${pageId}\0${rowKey ?? ""}\0${field.fieldId}`),
    questionId: `question.profile.${field.fieldId}`,
    fieldId: field.fieldId,
    rowKey,
    labelSha256: sha256(field.label.normalize("NFC")),
    required: field.required,
    semanticQuestionType: "unknown",
    answerType: pendingProfileAnswerType(field.answerType),
    controlType: pendingProfileControlType(field.uiBehavior),
    uiVariant: field.uiVariant,
    optionsSha256: sha256(JSON.stringify(field.allowedOptions)),
    constraintsSha256: sha256(JSON.stringify(pendingProfileConstraints(field))),
    committedReadbackSha256: sha256(field.committedReadback.normalize("NFC")),
    provenance: "generated_default",
  });
}

function pendingProfileAnswerType(value: CommittedProfileField["answerType"]): ProfileSyntheticFieldEvidence["answerType"] {
  if (value === "boolean") return "boolean";
  if (value === "multi_select") return "multi_select";
  if (value === "option" || value === "single_select") return "single_select";
  if (value === "date") return "date";
  if (value === "file") return "file";
  return "text";
}

function pendingProfileControlType(value: CommittedProfileField["uiBehavior"]): ProfileSyntheticFieldEvidence["controlType"] {
  if (value === "textarea") return "textarea";
  if (value === "checkbox") return "checkbox";
  if (value === "radio_group") return "radio";
  if (value === "select") return "select";
  if (value === "multi_select" || value === "search_select") return "listbox";
  if (value === "date") return "date";
  if (value === "file") return "file_upload";
  return "text";
}

function pendingProfileConstraints(field: CommittedProfileField): object | null {
  if (field.answerType === "date") return { displayFormat: "YYYY-MM-DD" };
  if (field.answerType === "file") return {
    acceptedExtensions: field.constraints?.acceptedExtensions ?? [],
    maxFileBytes: field.constraints?.maxFileBytes ?? null,
  };
  if (field.constraints == null || pendingProfileAnswerType(field.answerType) !== "text") return null;
  return {
    inputType: field.constraints.inputType,
    min: field.constraints.min,
    max: field.constraints.max,
    step: field.constraints.step ?? null,
    minLength: field.constraints.minLength ?? null,
    maxLength: field.constraints.maxLength,
    pattern: field.constraints.pattern,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
