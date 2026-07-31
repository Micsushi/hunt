import {
  phaseIds,
  parseApplicantProfile,
  parseDurableJourneyState,
  parseEvidenceManifest,
  parseMcpResponse,
  parseTerminalResult,
  stepIds,
  uiBehaviorIds,
} from "../../contracts/index.ts";
import type {
  ContractPortMap,
  ContractPortName,
} from "./types.ts";

export type SuccessValidator = (value: unknown) => boolean;

type PortSuccessValidators<P> = {
  readonly [K in keyof P]: SuccessValidator;
};

function record(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function objectRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function strings(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

function parsed(
  parser: (value: unknown) => unknown,
  value: unknown,
): boolean {
  try {
    parser(value);
    return true;
  } catch {
    return false;
  }
}

function isFixtureStart(value: unknown): boolean {
  return (
    record(value, ["fixtureRunId", "origin", "pageId"]) &&
    strings(value, ["fixtureRunId", "origin", "pageId"])
  );
}

function isFixtureTransition(value: unknown): boolean {
  return (
    record(value, ["transitionId", "pageId", "semanticHash"]) &&
    strings(value, ["transitionId", "pageId", "semanticHash"])
  );
}

function isFixtureReset(value: unknown): boolean {
  return (
    record(value, ["fixtureRunId", "semanticHash"]) &&
    strings(value, ["fixtureRunId", "semanticHash"])
  );
}

function isBrowserSession(value: unknown): boolean {
  return (
    record(value, ["sessionId", "pageId"]) &&
    strings(value, ["sessionId", "pageId"])
  );
}

function isBrowserObservation(value: unknown): boolean {
  return (
    record(value, ["sessionId", "pageId", "origin", "path", "targets"]) &&
    strings(value, ["sessionId", "pageId", "origin", "path"]) &&
    Array.isArray(value.targets) &&
    value.targets.every(isBrowserTarget)
  );
}

function isBrowserTarget(value: unknown): boolean {
  if (
    !record(value, [
      "token",
      "role",
      "name",
      "required",
      "options",
      "state",
      "readback",
    ]) ||
    !strings(value, ["token", "role", "name"]) ||
    ![
      "textbox",
      "radio",
      "checkbox",
      "combobox",
      "listbox",
      "button",
      "file",
    ].includes(String(value.role)) ||
    typeof value.required !== "boolean" ||
    !Array.isArray(value.options) ||
    !value.options.every((option) => typeof option === "string")
  ) {
    return false;
  }
  return isBrowserTargetState(value.state) && isBrowserReadback(value.readback);
}

function isBrowserTargetState(value: unknown): boolean {
  return (
    record(value, ["visibility", "enabled", "actionable"]) &&
    (value.visibility === "visible" || value.visibility === "hidden") &&
    typeof value.enabled === "boolean" &&
    typeof value.actionable === "boolean" &&
    (value.visibility === "visible" || value.actionable === false) &&
    (value.enabled || value.actionable === false)
  );
}

function isBrowserReadback(value: unknown): boolean {
  if (record(value, ["kind"])) {
    return value.kind === "empty" || value.kind === "unavailable";
  }
  if (record(value, ["kind", "value"])) {
    return value.kind === "text" && typeof value.value === "string";
  }
  if (record(value, ["kind", "checked"])) {
    return value.kind === "checked" && typeof value.checked === "boolean";
  }
  if (record(value, ["kind", "option"])) {
    return (
      value.kind === "selected" &&
      (value.option === null || typeof value.option === "string")
    );
  }
  return (
    record(value, ["kind", "resumeId"]) &&
    value.kind === "upload" &&
    (value.resumeId === null || typeof value.resumeId === "string")
  );
}

function isBrowserReceipt(value: unknown): boolean {
  return (
    record(value, ["operationId", "pageId", "attempted"]) &&
    strings(value, ["operationId", "pageId"]) &&
    value.attempted === true
  );
}

function isBrowserNavigation(value: unknown): boolean {
  return (
    record(value, ["operationId", "fromPageId", "pageId"]) &&
    strings(value, ["operationId", "fromPageId", "pageId"])
  );
}

function isJourneyBootstrap(value: unknown): boolean {
  if (
    !record(value, ["journeyId", "inputs", "state"]) ||
    typeof value.journeyId !== "string" ||
    !record(value.inputs, ["job", "resume", "profile"]) ||
    !isJob(value.inputs.job) ||
    !isResume(value.inputs.resume) ||
    !parsed(parseApplicantProfile, value.inputs.profile)
  ) {
    return false;
  }
  return parsed(parseDurableJourneyState, value.state);
}

function isJob(value: unknown): boolean {
  return (
    record(value, ["jobId", "title", "company", "applyUrl"]) &&
    strings(value, ["jobId", "title", "company", "applyUrl"])
  );
}

function isResume(value: unknown): boolean {
  return (
    record(value, ["resumeId", "sha256"]) &&
    strings(value, ["resumeId", "sha256"])
  );
}

function isProfileAnswer(value: unknown): boolean {
  if (record(value, ["kind"])) {
    return value.kind === "profile_answer_missing";
  }
  return (
    record(value, ["kind", "value", "provenance"]) &&
    value.kind === "answered" &&
    ["string", "number", "boolean"].includes(typeof value.value) &&
    ["owner_provided", "resume_verified", "configured_template"].includes(
      String(value.provenance),
    )
  );
}

function isJourneyStateLoad(value: unknown): boolean {
  return (
    record(value, ["state"]) &&
    (value.state === null || parsed(parseDurableJourneyState, value.state))
  );
}

function isJourneyStateTransition(value: unknown): boolean {
  return (
    record(value, ["state", "applied"]) &&
    typeof value.applied === "boolean" &&
    parsed(parseDurableJourneyState, value.state)
  );
}

function isPageUnderstanding(value: unknown): boolean {
  if (record(value, ["kind"])) {
    return value.kind === "unknown" || value.kind === "ambiguous";
  }
  return (
    record(value, ["kind", "snapshot"]) &&
    value.kind === "understood" &&
    isPageSnapshot(value.snapshot)
  );
}

function isPageSnapshot(value: unknown): boolean {
  return (
    record(value, ["pageIdentity", "fields"]) &&
    isPageIdentity(value.pageIdentity) &&
    Array.isArray(value.fields) &&
    value.fields.every(isFieldObservation)
  );
}

function isPageIdentity(value: unknown): boolean {
  if (!record(value, ["kind"])) {
    return (
      record(value, ["kind", "page"]) &&
      value.kind === "workday" &&
      ["account", "profile", "questionnaire", "review"].includes(
        String(value.page),
      )
    );
  }
  return value.kind === "unknown" || value.kind === "ambiguous";
}

function isFieldObservation(value: unknown): boolean {
  return (
    record(value, [
      "fieldId",
      "target",
      "label",
      "required",
      "behavior",
      "options",
      "state",
    ]) &&
    strings(value, ["fieldId", "target", "label", "behavior", "state"]) &&
    [...uiBehaviorIds, "unsupported"].includes(
      value.behavior as (typeof uiBehaviorIds)[number] | "unsupported",
    ) &&
    ["empty", "populated", "hidden", "ambiguous"].includes(
      String(value.state),
    ) &&
    typeof value.required === "boolean" &&
    Array.isArray(value.options) &&
    value.options.every(
      (option) =>
        record(option, ["id", "label"]) &&
        strings(option, ["id", "label"]),
    )
  );
}

function isAnswerResolution(value: unknown): boolean {
  if (
    record(value, ["kind", "intent"]) &&
    value.kind === "resolved"
  ) {
    return isFieldIntent(value.intent);
  }
  if (
    record(value, ["kind", "questionId"]) &&
    typeof value.questionId === "string"
  ) {
    return [
      "profile_answer_missing",
      "option_no_match",
      "option_ambiguous",
    ].includes(String(value.kind));
  }
  return (
    record(value, ["kind", "fieldId"]) &&
    value.kind === "unsupported" &&
    typeof value.fieldId === "string"
  );
}

function isFieldIntent(value: unknown): boolean {
  if (
    !objectRecord(value) ||
    typeof value.kind !== "string"
  ) {
    return false;
  }
  const common = ["fieldId", "target", "provenance"];
  if (!strings(value, common)) {
    return false;
  }
  if (
    ![
      "owner_provided",
      "resume_verified",
      "configured_template",
      "reviewed_catalog",
      "visible_option",
    ].includes(String(value.provenance))
  ) {
    return false;
  }
  if (value.kind === "text") {
    return (
      record(value, ["kind", "behavior", ...common, "value"]) &&
      (value.behavior === "text" || value.behavior === "textarea") &&
      typeof value.value === "string"
    );
  }
  if (value.kind === "choice") {
    return (
      record(value, [
        "kind",
        "behavior",
        ...common,
        "optionId",
        "expectedOption",
      ]) &&
      ["radio", "select", "listbox"].includes(String(value.behavior)) &&
      strings(value, ["optionId", "expectedOption"])
    );
  }
  if (value.kind === "toggle") {
    return (
      record(value, ["kind", "behavior", ...common, "checked"]) &&
      value.behavior === "checkbox" &&
      typeof value.checked === "boolean"
    );
  }
  if (value.kind === "date") {
    return (
      record(value, ["kind", "behavior", ...common, "isoDate"]) &&
      value.behavior === "date" &&
      typeof value.isoDate === "string"
    );
  }
  return (
    value.kind === "resume_upload" &&
    record(value, ["kind", "behavior", ...common, "resumeId"]) &&
    value.behavior === "file_upload" &&
    typeof value.resumeId === "string"
  );
}

function isMutationReceipt(value: unknown): boolean {
  return (
    record(value, ["operationId", "fieldId", "behavior", "attempted"]) &&
    strings(value, ["operationId", "fieldId", "behavior"]) &&
    uiBehaviorIds.includes(
      value.behavior as (typeof uiBehaviorIds)[number],
    ) &&
    value.attempted === true
  );
}

function isVerification(value: unknown): boolean {
  if (
    !objectRecord(value) ||
    typeof value.fieldId !== "string"
  ) {
    return false;
  }
  if (
    ["verified", "ambiguous", "unavailable"].includes(String(value.kind))
  ) {
    return record(value, ["kind", "fieldId"]);
  }
  return (
    value.kind === "rejected" &&
    record(value, ["kind", "fieldId", "reason"]) &&
    (value.reason === "mismatch" || value.reason === "stale")
  );
}

function isPageCompletion(value: unknown): boolean {
  if (
    record(value, ["kind", "decision"]) &&
    value.kind === "complete"
  ) {
    return isApprovedNavigation(value.decision);
  }
  return (
    record(value, ["kind", "fieldIds", "decision"]) &&
    value.kind === "blocked" &&
    Array.isArray(value.fieldIds) &&
    value.fieldIds.every((id) => typeof id === "string") &&
    record(value.decision, ["kind"]) &&
    value.decision.kind === "blocked"
  );
}

function isApprovedNavigation(value: unknown): boolean {
  if (record(value, ["kind"])) {
    return value.kind === "stop_review";
  }
  return (
    record(value, ["kind", "expectedPage"]) &&
    value.kind === "next" &&
    ["profile", "questionnaire", "review"].includes(
      String(value.expectedPage),
    )
  );
}

function isNavigation(value: unknown): boolean {
  return (
    record(value, ["kind", "expected", "observed"]) &&
    ["advanced", "review_reached", "uncertain", "illegal_transition"].includes(
      String(value.kind),
    ) &&
    isPageIdentity(value.expected) &&
    isPageIdentity(value.observed)
  );
}

function isJourneyOperation(value: unknown): boolean {
  return (
    record(value, ["operationId", "journeyId", "accepted"]) &&
    strings(value, ["operationId", "journeyId"]) &&
    typeof value.accepted === "boolean"
  );
}

function isJourneyStatus(value: unknown): boolean {
  return (
    typeof value === "string" &&
    [
      "ready",
      "running",
      "cancelling",
      "review_reached",
      "cancelled",
      "failed",
    ].includes(value)
  );
}

function isProgress(value: unknown): boolean {
  return (
    record(value, ["journeyId", "status", "completedSteps"]) &&
    typeof value.journeyId === "string" &&
    isJourneyStatus(value.status) &&
    typeof value.completedSteps === "number"
  );
}

function isEventAppend(value: unknown): boolean {
  return (
    record(value, ["appended", "progress"]) &&
    typeof value.appended === "boolean" &&
    isProgress(value.progress)
  );
}

function isFailureReport(value: unknown): boolean {
  return (
    record(value, ["report", "notification"]) &&
    record(value.report, ["reportId", "context"]) &&
    typeof value.report.reportId === "string" &&
    isFailureContext(value.report.context) &&
    record(value.notification, ["reportId", "delivered"]) &&
    typeof value.notification.reportId === "string" &&
    typeof value.notification.delivered === "boolean"
  );
}

function isFailureContext(value: unknown): boolean {
  if (!objectRecord(value)) {
    return false;
  }
  const keys = record(value, [
    "journeyId",
    "component",
    "phase",
    "step",
    "code",
    "retryable",
    "source",
  ])
    ? true
    : record(value, [
        "journeyId",
        "component",
        "phase",
        "step",
        "code",
        "retryable",
        "source",
        "cause",
      ]);
  return (
    keys &&
    strings(value, ["journeyId", "component", "phase", "step", "code"]) &&
    [
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7",
      "F8",
      "F9",
      "F10",
      "F11",
    ].includes(String(value.component)) &&
    phaseIds.includes(value.phase as (typeof phaseIds)[number]) &&
    stepIds.includes(value.step as (typeof stepIds)[number]) &&
    typeof value.retryable === "boolean" &&
    isSource(value.source) &&
    (!Object.hasOwn(value, "cause") || isVerifiedCause(value.cause))
  );
}

function isSource(value: unknown): boolean {
  return (
    record(value, ["kind", "id"]) &&
    strings(value, ["kind", "id"]) &&
    ["operation", "event", "evidence", "fixture"].includes(
      String(value.kind),
    )
  );
}

function isVerifiedCause(value: unknown): boolean {
  return (
    record(value, ["verification", "code", "source"]) &&
    value.verification === "verified" &&
    typeof value.code === "string" &&
    isSource(value.source)
  );
}

function isAdmission(value: unknown): boolean {
  return (
    record(value, ["kind", "policyRevision"]) &&
    value.kind === "admitted" &&
    typeof value.policyRevision === "string"
  );
}

function isEvidenceWrite(value: unknown): boolean {
  return (
    record(value, ["recordId", "written"]) &&
    typeof value.recordId === "string" &&
    typeof value.written === "boolean"
  );
}

function isModelSuggestion(value: unknown): boolean {
  return (
    record(value, ["attemptId", "suggestion"]) &&
    typeof value.attemptId === "string" &&
    record(value.suggestion, ["kind", "optionIds"]) &&
    (value.suggestion.kind === "option_ranking" ||
      value.suggestion.kind === "question_hint") &&
    Array.isArray(value.suggestion.optionIds) &&
    value.suggestion.optionIds.every((id) => typeof id === "string")
  );
}

export const successResultValidators = {
  FixtureRuntime: {
    start: isFixtureStart,
    transition: isFixtureTransition,
    reset: isFixtureReset,
    setFault: (value) => value === undefined,
  },
  BrowserSession: {
    start: isBrowserSession,
    observe: isBrowserObservation,
    mutate: isBrowserReceipt,
    navigate: isBrowserNavigation,
    close: (value) => value === undefined,
  },
  JourneyIntake: { bootstrap: isJourneyBootstrap },
  ProfileQuery: { query: isProfileAnswer },
  JourneyStateStore: {
    load: isJourneyStateLoad,
    transition: isJourneyStateTransition,
  },
  PageUnderstanding: { understand: isPageUnderstanding },
  AnswerResolver: { resolve: isAnswerResolution },
  FieldDriver: { drive: isMutationReceipt },
  FieldVerifier: { verify: isVerification },
  CompletionNavigation: {
    complete: isPageCompletion,
    reconcile: isNavigation,
  },
  JourneyControl: {
    start: isJourneyOperation,
    cancel: isJourneyOperation,
    status: isJourneyStatus,
    result: (value) => parsed(parseTerminalResult, value),
  },
  McpJourneyApi: {
    handle: (value) => parsed(parseMcpResponse, value),
  },
  EventSink: { append: isEventAppend },
  ProgressReader: { read: isProgress },
  FailureReporter: { report: isFailureReport },
  PrivacyGuard: { admit: isAdmission },
  SafetyGuard: { admit: isAdmission },
  EvidenceStore: {
    write: isEvidenceWrite,
    read: (value) => parsed(parseEvidenceManifest, value),
  },
  ModelController: { suggest: isModelSuggestion },
} as const satisfies {
  readonly [N in ContractPortName]: PortSuccessValidators<ContractPortMap[N]>;
};
