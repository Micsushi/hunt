import { types as utilTypes } from "node:util";

import {
  providerError,
  type BrowserControl,
  type BrowserObservation,
  type BrowserReadback,
  type BrowserTargetObservation,
  type BrowserTargetState,
  type CancellationError,
  type PageUnderstanding,
  type PageUnderstandingError,
  type PageUnderstandingRequest,
  type PageUnderstandingResult,
  type PortResult,
} from "../../contracts/index.ts";
import {
  discoverFields,
  UnsupportedTargetError,
} from "../../form/discovery/discover-fields.ts";
import { createSemanticSnapshot } from "../../form/semantic-snapshot.ts";
import { detectWorkdayPage } from "./detector.ts";

function dataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) return undefined;
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function dataArray(value: unknown, maximum: number): readonly unknown[] | undefined {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maximum) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key === "symbol")) return undefined;
  const elements = ownKeys.filter(
    (key): key is string => typeof key === "string" && key !== "length",
  );
  if (
    elements.length !== value.length ||
    elements.some((key, index) => key !== `${index}`)
  ) return undefined;
  const copy: unknown[] = [];
  for (const key of elements) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    copy.push(descriptor.value);
  }
  return copy;
}

function boundedString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && [...value].length <= maximum;
}

function opaqueIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function copyState(value: unknown): BrowserTargetState | undefined {
  const state = dataRecord(value, ["visibility", "enabled", "actionable"]);
  if (
    state === undefined ||
    (state.visibility !== "visible" && state.visibility !== "hidden") ||
    typeof state.enabled !== "boolean" ||
    typeof state.actionable !== "boolean" ||
    (state.actionable && (state.visibility !== "visible" || !state.enabled)) ||
    (state.visibility === "hidden" && state.actionable) ||
    (!state.enabled && state.actionable)
  ) return undefined;
  return Object.freeze({ ...state }) as unknown as BrowserTargetState;
}

function copyControl(value: unknown): BrowserControl | undefined {
  const kindRecord = dataRecord(value, ["kind", "element"]);
  if (kindRecord?.kind === "text" &&
    (kindRecord.element === "input" || kindRecord.element === "textarea")) {
    return Object.freeze({ ...kindRecord }) as unknown as BrowserControl;
  }
  if (kindRecord?.kind === "date" && kindRecord.element === "input") {
    return Object.freeze({ ...kindRecord }) as unknown as BrowserControl;
  }
  if (kindRecord?.kind === "button" && kindRecord.element === "button") {
    return Object.freeze({ ...kindRecord }) as unknown as BrowserControl;
  }
  if (kindRecord?.kind === "file" && kindRecord.element === "input") {
    return Object.freeze({ ...kindRecord }) as unknown as BrowserControl;
  }
  const choice = dataRecord(value, ["kind", "element", "choice", "group", "checked"]);
  if (
    choice?.kind === "choice" &&
    choice.element === "input" &&
    (choice.choice === "radio" || choice.choice === "checkbox") &&
    boundedString(choice.group) &&
    typeof choice.checked === "boolean"
  ) return Object.freeze({ ...choice }) as unknown as BrowserControl;
  const select = dataRecord(value, ["kind", "element", "options"]);
  const options = dataArray(select?.options, 64);
  if (
    select?.kind === "select" &&
    (select.element === "select" || select.element === "listbox") &&
    options !== undefined &&
    options.every((option) => boundedString(option))
  ) return Object.freeze({
    kind: "select",
    element: select.element,
    options: Object.freeze(options),
  }) as unknown as BrowserControl;
  return undefined;
}

function copyReadback(value: unknown): BrowserReadback | undefined {
  const unit = dataRecord(value, ["kind"]);
  if (unit?.kind === "empty" || unit?.kind === "unavailable") {
    return Object.freeze({ ...unit }) as BrowserReadback;
  }
  const text = dataRecord(value, ["kind", "value"]);
  if (text?.kind === "text" && boundedString(text.value)) {
    return Object.freeze({ ...text }) as unknown as BrowserReadback;
  }
  const checked = dataRecord(value, ["kind", "checked"]);
  if (checked?.kind === "checked" && typeof checked.checked === "boolean") {
    return Object.freeze({ ...checked }) as unknown as BrowserReadback;
  }
  const selected = dataRecord(value, ["kind", "option"]);
  if (
    selected?.kind === "selected" &&
    (selected.option === null || boundedString(selected.option))
  ) return Object.freeze({ ...selected }) as unknown as BrowserReadback;
  const upload = dataRecord(value, ["kind", "resumeId", "sha256"]);
  if (upload?.kind !== "upload") return undefined;
  if (upload.resumeId === null && upload.sha256 === null) {
    return Object.freeze({ ...upload }) as unknown as BrowserReadback;
  }
  if (
    opaqueIdentifier(upload.resumeId) &&
    typeof upload.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(upload.sha256)
  ) return Object.freeze({ ...upload }) as unknown as BrowserReadback;
  return undefined;
}

function copyTarget(value: unknown): BrowserTargetObservation | undefined {
  const target = dataRecord(value, [
    "token",
    "name",
    "required",
    "control",
    "state",
    "readback",
  ]);
  const control = copyControl(target?.control);
  const state = copyState(target?.state);
  const readback = copyReadback(target?.readback);
  if (
    target === undefined ||
    !opaqueIdentifier(target.token) ||
    !boundedString(target.name) ||
    typeof target.required !== "boolean" ||
    control === undefined ||
    state === undefined ||
    readback === undefined
  ) return undefined;
  return Object.freeze({
    token: target.token,
    name: target.name,
    required: target.required,
    control,
    state,
    readback,
  }) as BrowserTargetObservation;
}

function copyObservation(value: unknown): BrowserObservation | undefined {
  const observation = dataRecord(value, ["sessionId", "pageId", "origin", "path", "targets"]);
  const targets = dataArray(observation?.targets, 64);
  if (
    observation === undefined ||
    typeof observation.sessionId !== "string" ||
    !/^browser_session_[A-Za-z0-9_-]{16,64}$/u.test(observation.sessionId) ||
    !opaqueIdentifier(observation.pageId) ||
    typeof observation.origin !== "string" ||
    typeof observation.path !== "string" ||
    !observation.path.startsWith("/") ||
    observation.path.length > 2048 ||
    targets === undefined
  ) return undefined;
  try {
    if (new URL(observation.origin).origin !== observation.origin) return undefined;
  } catch {
    return undefined;
  }
  const copiedTargets = targets.map(copyTarget);
  if (copiedTargets.some((target) => target === undefined)) return undefined;
  return Object.freeze({
    sessionId: observation.sessionId,
    pageId: observation.pageId,
    origin: observation.origin,
    path: observation.path,
    targets: Object.freeze(copiedTargets),
  }) as BrowserObservation;
}

function copyRequest(value: unknown): BrowserObservation | undefined {
  const request = dataRecord(value, ["observation"]);
  return copyObservation(request?.observation);
}

export function createWorkdayPageUnderstanding(): PageUnderstanding {
  const provider: PageUnderstanding = {
    async understand(
      request: PageUnderstandingRequest,
      signal: AbortSignal,
    ): Promise<PortResult<PageUnderstandingResult, PageUnderstandingError | CancellationError>> {
      if (signal.aborted) {
        return { ok: false, error: providerError("operation_cancelled") };
      }
      const observation = copyRequest(request);
      if (observation === undefined) {
        return { ok: false, error: providerError("page_observation_invalid") };
      }
      const pageIdentity = detectWorkdayPage(observation);
      if (pageIdentity.kind !== "workday") {
        return { ok: true, value: Object.freeze({ kind: pageIdentity.kind }) };
      }
      try {
        return {
          ok: true,
          value: Object.freeze({
            kind: "understood",
            snapshot: createSemanticSnapshot(
              pageIdentity,
              discoverFields(observation.targets),
            ),
          }),
        };
      } catch (error) {
        if (error instanceof UnsupportedTargetError) {
          return { ok: true, value: Object.freeze({ kind: "ambiguous" }) };
        }
        if (error instanceof TypeError) {
          return { ok: false, error: providerError("page_observation_invalid") };
        }
        throw error;
      }
    },
  };
  return Object.freeze(provider);
}
