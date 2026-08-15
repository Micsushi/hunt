import {
  boundedText,
  fieldId,
  optionId,
  type BrowserTargetObservation,
  type FieldObservation,
  type UiBehaviorId,
} from "../../contracts/index.ts";
import { classifyUiBehavior, readSemanticState } from "../ui/classify.ts";

interface CatalogRow {
  readonly target?: string;
  readonly fieldId: string;
  readonly label: string;
  readonly behavior: UiBehaviorId;
  readonly group?: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

const rows: readonly CatalogRow[] = [
  { target: "target-given-name", fieldId: "field-given-name", label: "Given name", behavior: "text", options: [] },
  { fieldId: "s1-field-given-name", label: "Given name", behavior: "text", options: [] },
  { fieldId: "s1-field-family-name", label: "Family name", behavior: "text", options: [] },
  { fieldId: "s1-field-phone-number", label: "Phone number", behavior: "text", options: [] },
  { fieldId: "s1-field-interest", label: "Brief interest statement", behavior: "textarea", options: [] },
  {
    fieldId: "s1-field-work-authorization",
    label: "Are you authorized to work in this location?",
    behavior: "radio",
    group: "Are you authorized to work in this location?",
    options: [
      { id: "s1-option-work-authorization-yes", label: "Yes" },
      { id: "s1-option-work-authorization-no", label: "No" },
    ],
  },
  {
    fieldId: "s1-field-age-requirement",
    label: "I am at least 18 years of age.",
    behavior: "checkbox",
    group: "Are you at least 18 years of age?",
    options: [],
  },
  {
    fieldId: "s1-field-sponsorship",
    label: "Will you require sponsorship?",
    behavior: "select",
    options: [
      { id: "s1-option-sponsorship-yes", label: "Yes" },
      { id: "s1-option-sponsorship-no", label: "No" },
    ],
  },
  {
    fieldId: "s1-field-country",
    label: "Country",
    behavior: "listbox",
    options: [
      { id: "s1-option-country-us", label: "United States" },
      { id: "s1-option-country-ca", label: "Canada" },
    ],
  },
  { fieldId: "s1-field-start-date", label: "Available start date", behavior: "date", options: [] },
  { fieldId: "s1-field-resume", label: "Resume", behavior: "file_upload", options: [] },
] as const;

const catalog = new Map(rows.map((row) => [row.target ?? `target-${row.fieldId}`, row]));

export class UnsupportedTargetError extends TypeError {}

function matchesCatalog(target: BrowserTargetObservation, row: CatalogRow): boolean {
  const behavior = classifyUiBehavior(target.control);
  if (behavior !== row.behavior) return false;
  if (target.control.kind === "choice" && target.control.group !== row.group) {
    return false;
  }
  if (target.control.kind === "select") {
    const labels = row.options.map(({ label }) => label);
    if (
      target.control.options.length !== labels.length ||
      target.control.options.some((label, index) => label !== labels[index])
    ) return false;
  }
  return true;
}

function hasContradictoryReadback(
  target: BrowserTargetObservation,
  row: CatalogRow,
): boolean {
  const { control, readback } = target;
  if (control.kind === "select" && readback.kind === "selected") {
    return readback.option !== null &&
      (!control.options.includes(readback.option) ||
        !row.options.some(({ label }) => label === readback.option));
  }
  if (control.kind !== "choice") return false;
  if (readback.kind === "checked") {
    return control.checked !== readback.checked;
  }
  if (control.choice === "radio" && readback.kind === "selected") {
    return control.checked !== (readback.option !== null) ||
      (readback.option !== null &&
        !row.options.some(({ label }) => label === readback.option));
  }
  return false;
}

function fieldFromTarget(
  target: BrowserTargetObservation,
  row: CatalogRow,
): FieldObservation {
  if (hasContradictoryReadback(target, row)) {
    throw new UnsupportedTargetError("contradictory target evidence");
  }
  const supported = matchesCatalog(target, row);
  const behavior = supported ? row.behavior : "unsupported";
  const options = supported
    ? row.options.map((option) => Object.freeze({
        id: optionId(option.id),
        label: boundedText(option.label),
      }))
    : [];
  return Object.freeze({
    fieldId: fieldId(row.fieldId),
    target: target.token,
    label: boundedText(row.label),
    required: target.required,
    behavior,
    options: Object.freeze(options),
    state: readSemanticState(behavior, target.state, target.readback),
  });
}

function dynamicFieldFromTarget(target: BrowserTargetObservation): FieldObservation {
  const behavior = classifyUiBehavior(target.control);
  const fieldSuffix = target.token.startsWith("target-")
    ? target.token.slice("target-".length)
    : target.token;
  const labels = target.control.kind === "select"
    ? target.control.options
    : (target as BrowserTargetObservation & {
        readonly options?: readonly ReturnType<typeof boundedText>[];
      }).options ?? [];
  return Object.freeze({
    fieldId: fieldId(`field-${fieldSuffix}`),
    target: target.token,
    label: boundedText(target.name),
    required: target.required,
    behavior,
    options: Object.freeze(labels.map((label, index) => Object.freeze({
      id: optionId(`option-${fieldSuffix}-${index + 1}`),
      label: boundedText(label),
    }))),
    state: readSemanticState(behavior, target.state, target.readback),
  });
}

export function discoverFields(
  targets: readonly BrowserTargetObservation[],
): readonly FieldObservation[] {
  const seen = new Set<string>();
  const fields: FieldObservation[] = [];
  for (const target of targets) {
    if (seen.has(target.token)) {
      throw new TypeError(`duplicate browser target: ${target.token}`);
    }
    seen.add(target.token);
    if (target.control.kind === "button") continue;
    if (
      target.state.visibility === "visible" &&
      (!target.state.enabled || !target.state.actionable)
    ) continue;
    const row = catalog.get(target.token);
    if (row === undefined) {
      if (!target.token.startsWith("target-workday-")) {
        throw new UnsupportedTargetError("unsupported target coordinate");
      }
      fields.push(dynamicFieldFromTarget(target));
    } else fields.push(fieldFromTarget(target, row));
  }
  return Object.freeze(fields.sort((left, right) =>
    left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0
  ));
}
