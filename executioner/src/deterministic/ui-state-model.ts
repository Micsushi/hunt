import type {
  BrowserControl,
  BrowserMutation,
  BrowserReadback,
  FieldIntent,
  UiBehaviorId,
} from "../contracts/types.ts";

export const sharedUiTypes = [
  "text",
  "textarea",
  "contenteditable",
  "phone",
  "number",
  "url",
  "select",
  "search_select",
  "listbox",
  "checkbox",
  "radio",
  "radio_group",
  "date",
  "month",
  "year",
  "multi_select",
  "file_upload",
  "repeatable",
  "address",
] as const;

export type SharedUiType = (typeof sharedUiTypes)[number];
export const sharedUiStateRevisionAttribute = "data-hunt-shared-ui-state-revision";
export const sharedUiTypeAttribute = "data-hunt-shared-ui-type";
export const sharedUiBackingAttribute = "data-hunt-shared-ui-backing-state";
export const sharedUiDerivedBackingRules = Object.freeze([Object.freeze({
  type: "search_select" as const,
  canonicalFieldId: "phone.country_code",
  browserFieldId: "phoneNumber--countryPhoneCode",
  upstreamBrowserFieldId: "country--country",
})]);
export const sharedProfileUiTypes = [
  "checkbox",
  "file",
  "text",
  "textarea",
  "phone",
  "date",
  "month",
  "year",
  "number",
  "url",
  "select",
  "multi_select",
  "search_select",
  "radio_group",
] as const;
export type SharedProfileUiType = (typeof sharedProfileUiTypes)[number];
export type SharedUiOwner = "native" | "controlled" | "custom_aria" | "composite";
export type SharedUiVariant =
  | "native"
  | "controlled"
  | "custom_aria"
  | "masked"
  | "segmented"
  | "tokenized"
  | "repeatable";
export type SharedUiMutation =
  | "input"
  | "select_option"
  | "toggle"
  | "popup_option"
  | "date_input"
  | "masked_date_input"
  | "segmented_date_input"
  | "token_list"
  | "upload"
  | "row_action";
export type SharedUiBackingProof =
  | "native_property"
  | "controlled_state"
  | "selection_state"
  | "date_aggregate"
  | "token_state"
  | "upload_artifact"
  | "row_identity";

export interface SharedUiContract {
  readonly type: SharedUiType;
  readonly mutation: SharedUiMutation;
  readonly backingProof: SharedUiBackingProof;
  readonly semanticReadback: "scalar" | "boolean" | "option" | "option_set" | "date" | "file";
}

const contracts: Readonly<Record<SharedUiType, SharedUiContract>> = Object.freeze({
  text: contract("text", "input", "native_property", "scalar"),
  textarea: contract("textarea", "input", "native_property", "scalar"),
  contenteditable: contract("contenteditable", "input", "controlled_state", "scalar"),
  phone: contract("phone", "input", "controlled_state", "scalar"),
  number: contract("number", "input", "native_property", "scalar"),
  url: contract("url", "input", "native_property", "scalar"),
  select: contract("select", "select_option", "selection_state", "option"),
  search_select: contract("search_select", "popup_option", "selection_state", "option"),
  listbox: contract("listbox", "popup_option", "selection_state", "option"),
  checkbox: contract("checkbox", "toggle", "controlled_state", "boolean"),
  radio: contract("radio", "toggle", "selection_state", "option"),
  radio_group: contract("radio_group", "toggle", "selection_state", "option"),
  date: contract("date", "date_input", "date_aggregate", "date"),
  month: contract("month", "input", "native_property", "scalar"),
  year: contract("year", "input", "native_property", "scalar"),
  multi_select: contract("multi_select", "token_list", "token_state", "option_set"),
  file_upload: contract("file_upload", "upload", "upload_artifact", "file"),
  repeatable: contract("repeatable", "row_action", "row_identity", "option_set"),
  address: contract("address", "input", "controlled_state", "scalar"),
});

export interface SharedUiStateInput {
  readonly type: SharedUiType;
  readonly ownerState: "exact" | "missing" | "ambiguous" | "changed";
  readonly backingState: "committed" | "empty" | "mismatch" | "unknown";
  readonly stabilizationState: "stable" | "remounted_stable" | "pending" | "rolled_back";
  readonly readbackState: "matches" | "empty" | "mismatch" | "unavailable";
  readonly validationState: "clear" | "invalid" | "unknown";
  readonly navigationEffect?: "not_attempted" | "reconciled_clear" | "validation_appeared";
}

export interface SharedUiStateFact extends SharedUiStateInput {
  readonly revision: "shared-ui-state-v1";
  readonly navigationEligible: boolean;
  readonly blockedBy:
    | "owner"
    | "backing"
    | "stabilization"
    | "readback"
    | "validation"
    | "post_navigation_validation"
    | null;
}

export function sharedUiContract(type: SharedUiType): SharedUiContract {
  return contracts[type];
}

export function isSharedUiType(value: unknown): value is SharedUiType {
  return typeof value === "string" && (sharedUiTypes as readonly string[]).includes(value);
}

export function sharedUiTypeForBehavior(value: unknown): SharedUiType | undefined {
  if (value === "file") return "file_upload";
  return isSharedUiType(value) ? value : undefined;
}

export function sharedUiUsesDerivedBacking(
  type: SharedUiType,
  canonicalFieldId: string,
): boolean {
  return sharedUiDerivedBackingRules.some((rule) =>
    rule.type === type && rule.canonicalFieldId === canonicalFieldId
  );
}

export function isSharedProfileUiType(value: unknown): value is SharedProfileUiType {
  return typeof value === "string" &&
    (sharedProfileUiTypes as readonly string[]).includes(value);
}

export function canonicalSharedUiTypes(values: readonly unknown[]): readonly SharedUiType[] {
  const types = values.map(sharedUiTypeForBehavior);
  if (types.some((type) => type === undefined)) {
    throw new TypeError("unsupported shared UI type");
  }
  return Object.freeze([...new Set(types as SharedUiType[])]);
}

export function sharedUiTypeForBrowserControl(
  control: BrowserControl,
): UiBehaviorId | undefined {
  switch (control.kind) {
    case "text":
      return control.element === "textarea" ? "textarea" : "text";
    case "date":
      return "date";
    case "choice":
      return control.choice;
    case "select":
      return control.element;
    case "file":
      return "file_upload";
    case "button":
      return undefined;
  }
}

export function sharedUiAcceptsBrowserMutation(
  type: SharedUiType,
  mutation: BrowserMutation["kind"],
): boolean {
  if (mutation === "set_text") {
    return ["text", "textarea", "contenteditable", "phone", "number", "url", "month", "year", "address"]
      .includes(type);
  }
  if (mutation === "set_date") return type === "date";
  if (mutation === "set_checked") return type === "checkbox";
  if (mutation === "select") {
    return ["select", "search_select", "listbox", "radio", "radio_group", "multi_select"]
      .includes(type);
  }
  return type === "file_upload";
}

export function sharedUiVariant(
  type: SharedUiType,
  variant: string,
): { readonly owner: SharedUiOwner; readonly variant: SharedUiVariant; readonly mutation: SharedUiMutation } {
  const normalized = variant.toLocaleLowerCase("en-US");
  if (type === "repeatable") return variantResult("composite", "repeatable", "row_action");
  if (type === "multi_select") return variantResult("controlled", "tokenized", "token_list");
  if (type === "date" && /segment|composite/u.test(normalized)) {
    return variantResult("composite", "segmented", "segmented_date_input");
  }
  if (type === "date" && /mask|format/u.test(normalized)) {
    return variantResult("controlled", "masked", "masked_date_input");
  }
  if (/aria|role/u.test(normalized)) {
    return variantResult("custom_aria", "custom_aria", contracts[type].mutation);
  }
  if (/react|control|search|prompt|token/u.test(normalized) || [
    "search_select", "phone", "address", "contenteditable",
  ].includes(type)) {
    return variantResult("controlled", "controlled", contracts[type].mutation);
  }
  return variantResult("native", "native", contracts[type].mutation);
}

export function evaluateSharedUiState(input: SharedUiStateInput): SharedUiStateFact {
  const blockedBy = input.ownerState !== "exact" ? "owner" as const
    : input.backingState !== "committed" ? "backing" as const
    : !["stable", "remounted_stable"].includes(input.stabilizationState)
    ? "stabilization" as const
    : input.readbackState !== "matches" ? "readback" as const
    : input.navigationEffect === "validation_appeared" ? "post_navigation_validation" as const
    : input.validationState !== "clear" ? "validation" as const
    : null;
  return Object.freeze({
    revision: "shared-ui-state-v1" as const,
    ...input,
    navigationEligible: blockedBy === null,
    blockedBy,
  });
}

export function sharedUiIntentMatchesReadback(
  intent: FieldIntent,
  readback: BrowserReadback,
): boolean {
  switch (intent.kind) {
    case "text":
      return readback.kind === "text" && sharedUiValueMatches(
        intent.behavior,
        intent.value,
        readback.value,
      );
    case "choice":
      return readback.kind === "selected" && readback.option !== null &&
        sharedUiValueMatches(intent.behavior, intent.expectedOption, readback.option);
    case "toggle":
      return readback.kind === "checked" && readback.checked === intent.checked;
    case "date":
      return readback.kind === "text" && sharedUiValueMatches("date", intent.isoDate, readback.value);
    case "resume_upload":
      return readback.kind === "upload" &&
        readback.resumeId === intent.artifact.resumeId &&
        readback.sha256 === intent.artifact.sha256;
  }
}

export function sharedUiReadbackState(
  type: SharedUiType | undefined,
  visibility: "hidden" | "visible",
  readback: BrowserReadback,
): "empty" | "populated" | "hidden" | "ambiguous" {
  if (visibility === "hidden") return "hidden";
  if (type === undefined || readback.kind === "unavailable") return "ambiguous";
  if (readback.kind === "empty") return "empty";
  const contract = sharedUiContract(type);
  if (contract.semanticReadback === "boolean") {
    return readback.kind === "checked" && readback.checked ? "populated" :
      readback.kind === "checked" ? "empty" : "ambiguous";
  }
  if (contract.semanticReadback === "option" || contract.semanticReadback === "option_set") {
    return readback.kind === "selected" && readback.option !== null ? "populated" :
      readback.kind === "selected" ? "empty" : "ambiguous";
  }
  if (contract.semanticReadback === "file") {
    return readback.kind === "upload" && readback.resumeId !== null ? "populated" :
      readback.kind === "upload" ? "empty" : "ambiguous";
  }
  return readback.kind === "text" && readback.value.length > 0 ? "populated" :
    readback.kind === "text" ? "empty" : "ambiguous";
}

export function sharedUiValueMatches(
  type: SharedUiType,
  expected: string,
  actual: string,
): boolean {
  if (type === "phone") return digits(expected) === digits(actual);
  if (type === "month") {
    return /^(?:0?[1-9]|1[0-2])$/u.test(actual) && Number(actual) === Number(expected);
  }
  if (type === "multi_select") {
    const left = optionList(expected);
    const right = optionList(actual);
    return left !== undefined && right !== undefined && sameOptions(left, right);
  }
  if (["select", "search_select", "listbox", "radio", "radio_group"].includes(type)) {
    return normalizeOption(expected) === normalizeOption(actual);
  }
  if (type === "textarea" || type === "contenteditable") {
    return expected.normalize("NFC").replace(/\r\n?/gu, "\n") ===
      actual.normalize("NFC").replace(/\r\n?/gu, "\n");
  }
  return normalizeScalar(expected) === normalizeScalar(actual);
}

export function sharedUiKnownSemanticAliasMatches(
  fieldId: string,
  actual: string,
  expected: string,
): boolean | undefined {
  const pair = new Set([normalizeOption(actual), normalizeOption(expected)]);
  if (fieldId === "phone.device_type") {
    if (pair.size === 1) return true;
    return pair.size === 2 && pair.has("mobile") && pair.has("cell") ? true : undefined;
  }
  if (fieldId === "source.how_did_you_hear") {
    if (pair.size === 1) return true;
    return pair.size === 2 && pair.has("recruiter") &&
        (pair.has("direct sourcing") || pair.has("recruiter outreach"))
      ? true
      : undefined;
  }
  return undefined;
}

function contract(
  type: SharedUiType,
  mutation: SharedUiMutation,
  backingProof: SharedUiBackingProof,
  semanticReadback: SharedUiContract["semanticReadback"],
): SharedUiContract {
  return Object.freeze({ type, mutation, backingProof, semanticReadback });
}

function variantResult(
  owner: SharedUiOwner,
  variant: SharedUiVariant,
  mutation: SharedUiMutation,
) {
  return Object.freeze({ owner, variant, mutation });
}

function normalizeScalar(value: string): string {
  return value.normalize("NFC").trim();
}

function normalizeOption(value: string): string {
  return normalizeScalar(value).replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function digits(value: string): string {
  return value.replace(/\D/gu, "");
}

function optionList(value: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 ||
        parsed.some((item) => typeof item !== "string" || normalizeScalar(item) === "")) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function sameOptions(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = right.map(normalizeOption);
  for (const value of left.map(normalizeOption)) {
    const index = remaining.indexOf(value);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}
