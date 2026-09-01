import type {
  BrowserControl,
  BrowserReadback,
  BrowserTargetState,
  UiBehaviorId,
} from "../../contracts/index.ts";
import {
  sharedUiReadbackState,
  sharedUiTypeForBehavior,
  sharedUiTypeForBrowserControl,
} from "../../deterministic/ui-state-model.ts";

export function classifyUiBehavior(
  control: BrowserControl,
): UiBehaviorId | "unsupported" {
  return sharedUiTypeForBrowserControl(control) ?? "unsupported";
}

export function readSemanticState(
  behavior: UiBehaviorId | "unsupported",
  targetState: BrowserTargetState,
  readback: BrowserReadback,
): "empty" | "populated" | "hidden" | "ambiguous" {
  return sharedUiReadbackState(
    sharedUiTypeForBehavior(behavior),
    targetState.visibility,
    readback,
  );
}
