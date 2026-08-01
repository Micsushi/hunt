import {
  MAX_BROWSER_READBACK_CODE_POINTS,
  MAX_IDENTIFIER_CODE_POINTS,
  bindAdmissionRequest,
  isResolvedResumeArtifact,
  type BrowserMutation,
  type BrowserMutationAdmissionSnapshot,
  type BrowserSession,
  type DriverRequest,
  type FieldDriver,
  type FieldIntent,
  type SafetyAdmissionRequest,
  type SafetyGuard,
} from "../../contracts/index.ts";

const behaviors = new Set([
  "text",
  "textarea",
  "radio",
  "checkbox",
  "select",
  "listbox",
  "date",
  "file_upload",
]);
const provenances = new Set([
  "owner_provided",
  "resume_verified",
  "configured_template",
  "reviewed_catalog",
  "visible_option",
]);
const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const journeyIdentifier = /^journey_[A-Za-z0-9_-]{16,64}$/u;
const sessionIdentifier = /^browser_session_[A-Za-z0-9_-]{16,64}$/u;
const operationIdentifier = /^operation_[A-Za-z0-9_-]{16,64}$/u;

const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;

export function createFieldDriver(
  browser: BrowserSession,
  safety: SafetyGuard,
): FieldDriver {
  const operations = new Set<string>();

  return {
    async drive(request, signal) {
      if (signal.aborted) return cancelled;

      const error = validate(request);
      if (error !== undefined) {
        return {
          ok: false,
          error: { code: error, retryable: false },
        };
      }
      if (operations.has(request.operationId)) {
        return {
          ok: false,
          error: {
            code: "driver_operation_replayed",
            retryable: false,
          },
        };
      }
      operations.add(request.operationId);

      const mutation = mutationFor(request.intent);
      const input = mutationAdmissionSnapshot(request, mutation);
      const admissionRequest = {
        binding: {
          journeyId: request.journeyId,
          attemptId: request.operationId,
          guardRevision: request.guardRevision,
        },
        policyRevision: request.guardRevision,
        capability: "field_mutation",
        input,
      } as const satisfies SafetyAdmissionRequest<BrowserMutationAdmissionSnapshot>;
      const admitted = await safety.admit(admissionRequest, signal);
      if (!admitted.ok) return admitted;
      if (!matchesAdmission(request, input, admitted.value)) {
        return {
          ok: false,
          error: { code: "admission_mismatch", retryable: false },
        };
      }
      if (signal.aborted) return cancelled;

      const result = await browser.mutate(
        bindAdmissionRequest(admitted.value),
        signal,
      );
      if (!result.ok) return result;

      return {
        ok: true,
        value: {
          operationId: request.operationId,
          fieldId: request.intent.fieldId,
          behavior: request.intent.behavior,
          attempted: true,
        },
      };
    },
  };
}

function mutationAdmissionSnapshot(
  request: DriverRequest,
  mutation: BrowserMutation,
): BrowserMutationAdmissionSnapshot {
  return {
    policyRevision: request.guardRevision,
    capability: "field_mutation",
    effect: {
      kind: "browser_mutation",
      sessionId: request.sessionId,
      pageId: request.pageId,
      operationId: request.operationId,
      mutation,
    },
  };
}

function matchesAdmission(
  request: DriverRequest,
  expected: BrowserMutationAdmissionSnapshot,
  admitted: {
    readonly purpose: string;
    readonly journeyId: string;
    readonly attemptId: string;
    readonly guardRevision: string;
    readonly snapshot: BrowserMutationAdmissionSnapshot;
  },
): boolean {
  return (
    admitted.purpose === "safety" &&
    admitted.journeyId === request.journeyId &&
    admitted.attemptId === request.operationId &&
    admitted.guardRevision === request.guardRevision &&
    sameSnapshot(admitted.snapshot, expected)
  );
}

function sameSnapshot(
  actual: BrowserMutationAdmissionSnapshot,
  expected: BrowserMutationAdmissionSnapshot,
): boolean {
  return (
    actual.policyRevision === expected.policyRevision &&
    actual.capability === expected.capability &&
    actual.effect.kind === expected.effect.kind &&
    actual.effect.sessionId === expected.effect.sessionId &&
    actual.effect.pageId === expected.effect.pageId &&
    actual.effect.operationId === expected.effect.operationId &&
    sameMutation(actual.effect.mutation, expected.effect.mutation)
  );
}

function sameMutation(actual: BrowserMutation, expected: BrowserMutation): boolean {
  if (actual.kind !== expected.kind || actual.target !== expected.target) {
    return false;
  }
  switch (actual.kind) {
    case "set_text":
      return expected.kind === "set_text" && actual.text === expected.text;
    case "set_date":
      return expected.kind === "set_date" && actual.isoDate === expected.isoDate;
    case "set_checked":
      return expected.kind === "set_checked" && actual.checked === expected.checked;
    case "select":
      return expected.kind === "select" && actual.option === expected.option;
    case "upload":
      return expected.kind === "upload" && actual.artifact === expected.artifact;
  }
}

function mutationFor(intent: FieldIntent): BrowserMutation {
  switch (intent.kind) {
    case "text":
      return { kind: "set_text", target: intent.target, text: intent.value };
    case "choice":
      return {
        kind: "select",
        target: intent.target,
        option: intent.expectedOption,
      };
    case "toggle":
      return {
        kind: "set_checked",
        target: intent.target,
        checked: intent.checked,
      };
    case "date":
      return {
        kind: "set_date",
        target: intent.target,
        isoDate: intent.isoDate,
      };
    case "resume_upload":
      return {
        kind: "upload",
        target: intent.target,
        artifact: intent.artifact,
      };
  }
}

function validate(
  request: DriverRequest,
):
  | "driver_intent_invalid"
  | "driver_behavior_unsupported"
  | "driver_target_invalid"
  | undefined {
  const intent = request.intent as unknown;
  if (
    !validGeneratedIdentifier(request.journeyId, journeyIdentifier) ||
    !validGeneratedIdentifier(request.sessionId, sessionIdentifier) ||
    !validOpaque(request.pageId) ||
    !validOpaque(request.guardRevision) ||
    !validGeneratedIdentifier(request.operationId, operationIdentifier) ||
    typeof intent !== "object" ||
    intent === null
  ) {
    return "driver_intent_invalid";
  }

  const value = intent as Record<string, unknown>;
  if (typeof value.behavior !== "string" || !behaviors.has(value.behavior)) {
    return "driver_behavior_unsupported";
  }
  if (
    !validOpaque(value.target) ||
    /submit/iu.test(value.target)
  ) {
    return "driver_target_invalid";
  }
  if (
    !validOpaque(value.fieldId) ||
    typeof value.provenance !== "string" ||
    !provenances.has(value.provenance) ||
    !validIntent(value)
  ) {
    return "driver_intent_invalid";
  }
}

function validIntent(intent: Record<string, unknown>): intent is FieldIntent {
  switch (intent.kind) {
    case "text":
      return (
        (intent.behavior === "text" || intent.behavior === "textarea") &&
        typeof intent.value === "string" &&
        hasBoundedCodePoints(
          intent.value,
          0,
          MAX_BROWSER_READBACK_CODE_POINTS,
        )
      );
    case "choice":
      return (
        (intent.behavior === "radio" ||
          intent.behavior === "select" ||
          intent.behavior === "listbox") &&
        validOpaque(intent.optionId) &&
        typeof intent.expectedOption === "string" &&
        hasBoundedCodePoints(
          intent.expectedOption,
          1,
          MAX_BROWSER_READBACK_CODE_POINTS,
        )
      );
    case "toggle":
      return (
        intent.behavior === "checkbox" &&
        typeof intent.checked === "boolean"
      );
    case "date":
      return (
        intent.behavior === "date" &&
        typeof intent.isoDate === "string" &&
        isIsoDate(intent.isoDate)
      );
    case "resume_upload":
      return (
        intent.behavior === "file_upload" &&
        isResolvedResumeArtifact(intent.artifact)
      );
    default:
      return false;
  }
}

function validOpaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    hasBoundedCodePoints(value, 1, MAX_IDENTIFIER_CODE_POINTS) &&
    opaqueIdentifier.test(value)
  );
}

function validGeneratedIdentifier(
  value: unknown,
  pattern: RegExp,
): value is string {
  return (
    typeof value === "string" &&
    hasBoundedCodePoints(value, 1, MAX_IDENTIFIER_CODE_POINTS) &&
    pattern.test(value)
  );
}

function hasBoundedCodePoints(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return count >= minimum;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
