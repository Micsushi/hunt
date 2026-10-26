import {
  admitContractSnapshot,
  copyContractDataGraph,
  phaseIds,
  stepIds,
  type AdmittedSnapshot,
  type AdmissionBinding,
  type CancellationError,
  type FrozenJson,
  type PortResult,
  type PrivacyAdmissionRequest,
  type PrivacyDenial,
  type PrivacyGuard,
  type RedactionCode,
  type SafetyDenial,
  type SafetyAdmissionInput,
  type SafetyAdmissionRequest,
  type SafetyGuard,
} from "../contracts/index.ts";

export const PRIVACY_MAX_PAYLOAD_KEYS = 32;
export const PRIVACY_MAX_STRING_CODE_POINTS = 128;

const cancelled = {
  ok: false,
  error: { code: "operation_cancelled", retryable: false },
} as const;
const safeStringKeys = new Set([
  "fixture",
  "fixture_run_id",
  "job_id",
  "resume_id",
  "profile_id",
  "journey_id",
  "operation_id",
  "request_id",
  "event_id",
  "report_id",
  "record_id",
  "page_id",
  "question_id",
  "field_id",
  "option_id",
  "attempt_id",
  "transition_id",
  "component",
  "phase",
  "step",
  "method",
  "kind",
  "status",
  "code",
  "source_kind",
  "source_id",
]);
const safeNumberKeys = new Set(["revision", "completed_steps", "completed_pages"]);
const safeBooleanKeys = new Set(["retryable", "written", "delivered", "verified"]);
const methods = new Set([
  "start_journey",
  "cancel_journey",
  "journey_status",
  "journey_result",
]);
const components = new Set(
  Array.from({ length: 10 }, (_, index) => `F${index + 2}`),
);
const statuses = new Set([
  "ready",
  "running",
  "cancelling",
  "review_reached",
  "cancelled",
  "blocked",
  "failed",
]);
const kinds = new Set([
  "accepted",
  "status",
  "terminal",
  "step_started",
  "step_completed",
  "step_failed",
  "journey_terminal",
  "semantic_snapshot",
  "operation_receipt",
  "verification",
  "operation",
  "event",
  "evidence",
  "fixture",
  "admitted",
]);
const semanticString = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

type JsonObject = { readonly [key: string]: FrozenJson };

function jsonObject(value: FrozenJson | undefined): value is JsonObject {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function normalize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function tooLong(value: string): boolean {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length > PRIVACY_MAX_STRING_CODE_POINTS) return true;
  }
  return false;
}

function denied(code: RedactionCode | PrivacyDenial["code"] | SafetyDenial["code"]) {
  return { ok: false, error: { code, retryable: false } } as const;
}

function keyDenial(key: string): RedactionCode | undefined {
  const normalized = normalize(key);
  if (/(?:^|_)submit(?:_|$)/u.test(normalized)) return "submit_forbidden";
  if (
    /(?:^|_)(?:selector|locator|xpath|css_path|target|target_token)(?:_|$)/u.test(
      normalized,
    )
  ) return "selector_forbidden";
  if (
    /(?:^|_)(?:access_token|refresh_token|bearer_token|auth_token|oauth_token|session_token|token)(?:_|$)/u.test(
      normalized,
    )
  ) return "token_forbidden";
  if (
    /(?:^|_)(?:credential|credentials|password|passcode|passphrase|secret|private_key|api_key|client_secret|session_cookie|cookie|authorization_header)(?:_|$)/u.test(
      normalized,
    )
  ) return "credential_forbidden";
  if (
    /(?:^|_)(?:policy_override|override_policy|system_prompt|developer_prompt|prompt|instruction|bypass)(?:_|$)/u.test(
      normalized,
    )
  ) return "policy_override_forbidden";
  if (/(?:^|_)(?:email_body|message_body|raw_text|raw_page_text)(?:_|$)/u.test(normalized)) {
    return "raw_text_forbidden";
  }
  return undefined;
}

function stringDenial(value: string): RedactionCode | undefined {
  if (tooLong(value)) return "payload_too_large";
  const normalized = normalize(value);
  if (/(?:^|_)submit(?:_|$)/u.test(normalized)) return "submit_forbidden";
  if (/(?:^|_)(?:access_token|bearer_token|auth_token|oauth_token|token)(?:_|$)/u.test(normalized)) {
    return "token_forbidden";
  }
  if (/(?:^|_)(?:credential|password|passcode|passphrase|secret|api_key|client_secret)(?:_|$)/u.test(normalized)) {
    return "credential_forbidden";
  }
  if (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ||
    /^bearer\s/iu.test(value) ||
    /^[\w-]+\.[\w-]+\.[\w-]+$/u.test(value) ||
    !semanticString.test(value)
  ) return "raw_text_forbidden";
  return undefined;
}

function semanticValueDenial(key: string, value: FrozenJson): RedactionCode | undefined {
  const normalized = normalize(key);
  if (safeStringKeys.has(normalized)) {
    if (typeof value !== "string") return "raw_text_forbidden";
    const denial = stringDenial(value);
    if (denial !== undefined) return denial;
    if (normalized === "method" && !methods.has(value)) return "raw_text_forbidden";
    if (normalized === "component" && !components.has(value)) return "raw_text_forbidden";
    if (normalized === "phase" && !(phaseIds as readonly string[]).includes(value)) return "raw_text_forbidden";
    if (normalized === "step" && !(stepIds as readonly string[]).includes(value)) return "raw_text_forbidden";
    if (normalized === "status" && !statuses.has(value)) return "raw_text_forbidden";
    if ((normalized === "kind" || normalized === "source_kind") && !kinds.has(value)) return "raw_text_forbidden";
    return undefined;
  }
  if (safeNumberKeys.has(normalized)) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? undefined
      : "raw_text_forbidden";
  }
  if (safeBooleanKeys.has(normalized)) {
    return typeof value === "boolean" ? undefined : "raw_text_forbidden";
  }
  return keyDenial(key) ?? "raw_text_forbidden";
}

function firstWrapperDenial(
  value: JsonObject,
  expected: readonly string[],
): RedactionCode | undefined {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) return keyDenial(key) ?? "policy_override_forbidden";
  }
  return undefined;
}

async function admitPrivacy(
  request: PrivacyAdmissionRequest,
  signal: AbortSignal,
): Promise<PortResult<
  AdmittedSnapshot<"privacy" | "evidence">,
  PrivacyDenial | CancellationError
>> {
      if (signal.aborted) return cancelled;
      const copied = copyContractDataGraph(request);
      if (!copied.ok) return copied;
      if (!jsonObject(copied.value)) return denied("admission_shape_invalid");
      const wrapperDenial = firstWrapperDenial(copied.value, ["binding", "purpose", "input"]);
      if (wrapperDenial !== undefined) return denied(wrapperDenial);
      if (!exactKeys(copied.value, ["binding", "purpose", "input"])) {
        return denied("admission_shape_invalid");
      }
      const binding = copied.value.binding;
      const purpose = copied.value.purpose;
      const input = copied.value.input;
      if (
        !jsonObject(binding) ||
        !exactKeys(binding, ["journeyId", "attemptId", "guardRevision"]) ||
        (purpose !== "privacy" && purpose !== "evidence") ||
        !jsonObject(input)
      ) return denied("admission_shape_invalid");

      if (purpose === "privacy") {
        if (!exactKeys(input, ["policyRevision", "semanticPayload"])) {
          return denied("admission_shape_invalid");
        }
        const payload = input.semanticPayload;
        if (!jsonObject(payload)) return denied("admission_shape_invalid");
        const entries = Object.entries(payload);
        if (entries.length > PRIVACY_MAX_PAYLOAD_KEYS) return denied("payload_too_large");
        for (const [key, value] of entries) {
          if (tooLong(key)) return denied("payload_too_large");
          const denial = keyDenial(key) ?? semanticValueDenial(key, value);
          if (denial !== undefined) return denied(denial);
        }
      }

      return admitContractSnapshot(
        input,
        purpose,
        binding as unknown as AdmissionBinding,
      ) as PortResult<
        AdmittedSnapshot<"privacy" | "evidence">,
        PrivacyDenial
      >;
}

export function createPrivacyGuard(): PrivacyGuard {
  return { admit: admitPrivacy };
}

async function admitSafety<const I extends SafetyAdmissionInput>(
  request: SafetyAdmissionRequest<I>,
  signal: AbortSignal,
): Promise<PortResult<
  AdmittedSnapshot<"safety", I>,
  SafetyDenial | CancellationError
>> {
      if (signal.aborted) return cancelled;
      const copied = copyContractDataGraph(request);
      if (!copied.ok) return copied;
      if (!jsonObject(copied.value)) return denied("admission_shape_invalid");
      const wrapperDenial = firstWrapperDenial(copied.value, [
        "binding",
        "policyRevision",
        "capability",
        "input",
      ]);
      if (wrapperDenial !== undefined) return denied(wrapperDenial);
      if (!exactKeys(copied.value, ["binding", "policyRevision", "capability", "input"])) {
        return denied("admission_shape_invalid");
      }
      if (
        typeof copied.value.capability === "string" &&
        /(?:^|_)submit(?:_|$)/u.test(normalize(copied.value.capability))
      ) return denied("submit_forbidden");
      if (
        copied.value.capability !== "field_mutation" &&
        copied.value.capability !== "navigate_next"
      ) return denied("policy_override_forbidden");
      if (
        !jsonObject(copied.value.binding) ||
        !exactKeys(copied.value.binding, [
          "journeyId",
          "attemptId",
          "guardRevision",
        ]) ||
        !jsonObject(copied.value.input)
      ) {
        return denied("admission_shape_invalid");
      }
      if (
        copied.value.policyRevision !== copied.value.binding.guardRevision ||
        copied.value.capability !== copied.value.input.capability
      ) return denied("admission_shape_invalid");
      return admitContractSnapshot(
        copied.value.input,
        "safety",
        copied.value.binding as unknown as AdmissionBinding,
      ) as PortResult<AdmittedSnapshot<"safety", I>, SafetyDenial>;
}

export function createSafetyGuard(): SafetyGuard {
  return { admit: admitSafety };
}
