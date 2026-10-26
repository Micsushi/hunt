import {
  boundedText,
  browserTargetToken,
  sha256Digest,
  type BrowserControl,
  type BrowserObservation,
  type BrowserReadback,
  type BrowserTargetObservation,
} from "../../../../src/contracts/index.ts";
import { requiredFieldFlowCases } from "../../../../src/testing/contracts/field-flow-cases.ts";
import { contractFixtures } from "../../../../src/testing/contracts/fixtures.ts";

export type CanonicalFieldCase = (typeof requiredFieldFlowCases)[number];

function shape(field: CanonicalFieldCase): {
  readonly control: BrowserControl;
  readonly readback: BrowserReadback;
} {
  switch (field.behavior) {
    case "text":
      return {
        control: { kind: "text", element: "input" },
        readback: { kind: "text", value: boundedText("private value") },
      };
    case "textarea":
      return {
        control: { kind: "text", element: "textarea" },
        readback: { kind: "text", value: boundedText("private narrative") },
      };
    case "date":
      return {
        control: { kind: "date", element: "input" },
        readback: { kind: "text", value: boundedText("2026-08-01") },
      };
    case "radio":
      return {
        control: {
          kind: "choice",
          element: "input",
          choice: "radio",
          group: boundedText(field.questionLabel),
          checked: true,
        },
        readback: { kind: "selected", option: boundedText("Yes") },
      };
    case "checkbox":
      return {
        control: {
          kind: "choice",
          element: "input",
          choice: "checkbox",
          group: boundedText(field.questionLabel),
          checked: true,
        },
        readback: { kind: "checked", checked: true },
      };
    case "select":
    case "listbox":
      return {
        control: {
          kind: "select",
          element: field.behavior === "select" ? "select" : "listbox",
          options: field.options.map(({ label }) => boundedText(label)),
        },
        readback: { kind: "selected", option: boundedText(field.options[0]!.label) },
      };
    case "file_upload":
      return {
        control: { kind: "file", element: "input" },
        readback: {
          kind: "upload",
          resumeId: contractFixtures.resume.resumeId,
          sha256: sha256Digest(contractFixtures.resume.sha256),
        },
      };
  }
}

export function canonicalTarget(field: CanonicalFieldCase): BrowserTargetObservation {
  return {
    token: browserTargetToken(`target-${field.fieldId}`),
    name: boundedText(`untrusted ${field.fieldLabel}`),
    required: true,
    state: { visibility: "visible", enabled: true, actionable: true },
    ...shape(field),
  };
}

export function canonicalObservation(): BrowserObservation {
  return {
    ...contractFixtures.browserObservation,
    origin: "https://fixture.invalid",
    path: "/profile",
    targets: requiredFieldFlowCases.map(canonicalTarget),
  };
}
