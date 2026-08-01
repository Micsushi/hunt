import type {
  BrowserControl,
  BrowserReadback,
  BrowserTargetState,
  UiBehaviorId,
} from "../../contracts/index.ts";

export function classifyUiBehavior(
  control: BrowserControl,
): UiBehaviorId | "unsupported" {
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
      return "unsupported";
  }
}

export function readSemanticState(
  behavior: UiBehaviorId | "unsupported",
  targetState: BrowserTargetState,
  readback: BrowserReadback,
): "empty" | "populated" | "hidden" | "ambiguous" {
  if (targetState.visibility === "hidden") return "hidden";
  if (behavior === "unsupported" || readback.kind === "unavailable") {
    return "ambiguous";
  }
  if (readback.kind === "empty") return "empty";
  switch (behavior) {
    case "text":
    case "textarea":
    case "date":
      return readback.kind === "text"
        ? readback.value.length === 0 ? "empty" : "populated"
        : "ambiguous";
    case "radio":
      return readback.kind === "selected"
        ? readback.option === null ? "empty" : "populated"
        : "ambiguous";
    case "checkbox":
      return readback.kind === "checked"
        ? readback.checked ? "populated" : "empty"
        : "ambiguous";
    case "select":
    case "listbox":
      return readback.kind === "selected"
        ? readback.option === null ? "empty" : "populated"
        : "ambiguous";
    case "file_upload":
      return readback.kind === "upload"
        ? readback.resumeId === null ? "empty" : "populated"
        : "ambiguous";
  }
}
