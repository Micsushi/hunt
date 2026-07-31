import { isDeepStrictEqual } from "node:util";

import type { PortResult } from "../../contracts/index.ts";
import { contractOperationCases } from "./operation-cases.ts";
import type {
  ContractPortMap,
  ContractPortName,
} from "./types.ts";

const redactionCodes = [
  "credential_forbidden",
  "token_forbidden",
  "raw_text_forbidden",
  "selector_forbidden",
  "policy_override_forbidden",
  "submit_forbidden",
  "payload_too_large",
] as const;

const declaredErrorCodes = {
  FixtureRuntime: [
    "fixture_not_found",
    "fixture_already_started",
    "fixture_transition_illegal",
    "fixture_transition_replayed",
    "fixture_timeout",
  ],
  BrowserSession: [
    "browser_target_invalid",
    "browser_page_owned",
    "browser_session_missing",
    "browser_target_stale",
    "browser_target_ambiguous",
    "browser_operation_replayed",
    "browser_timeout",
  ],
  JourneyIntake: [
    "journey_input_invalid",
    "resume_identity_mismatch",
  ],
  ProfileQuery: ["profile_missing", "profile_revision_mismatch"],
  JourneyStateStore: [
    "journey_state_invalid",
    "journey_transition_illegal",
    "journey_revision_conflict",
    "journey_state_unavailable",
  ],
  PageUnderstanding: ["page_observation_invalid"],
  AnswerResolver: [
    "question_unknown",
    "question_ambiguous",
    "protected_answer_denied",
  ],
  FieldDriver: [
    "driver_intent_invalid",
    "driver_behavior_unsupported",
    "driver_target_invalid",
    "driver_operation_replayed",
  ],
  FieldVerifier: [
    "verification_input_invalid",
    "verification_timeout",
  ],
  CompletionNavigation: [
    "page_incomplete",
    "navigation_illegal",
    "navigation_uncertain",
  ],
  JourneyControl: [
    "journey_operation_replayed",
    "journey_not_found",
    "journey_already_terminal",
    "journey_busy",
    "journey_retry_exhausted",
  ],
  McpJourneyApi: [
    "mcp_request_invalid",
    "mcp_method_unknown",
    "mcp_internal_error",
  ],
  EventSink: [
    "event_invalid",
    "event_store_unavailable",
    "progress_not_found",
  ],
  ProgressReader: [
    "event_invalid",
    "event_store_unavailable",
    "progress_not_found",
  ],
  FailureReporter: [
    "failure_context_invalid",
    "notification_unavailable",
  ],
  PrivacyGuard: redactionCodes,
  SafetyGuard: redactionCodes,
  EvidenceStore: [
    "evidence_denied",
    "evidence_limit_exceeded",
    "evidence_unavailable",
  ],
  ModelController: [
    "model_request_denied",
    "model_result_denied",
    "model_unavailable",
  ],
} as const satisfies Record<ContractPortName, readonly string[]>;

export const contractPortOperations = Object.fromEntries(
  Object.entries(contractOperationCases).map(([name, cases]) => [
    name,
    Object.keys(cases),
  ]),
) as unknown as {
  readonly [N in ContractPortName]: readonly (keyof ContractPortMap[N] & string)[];
};

export async function assertProviderConformance<N extends ContractPortName>(
  name: N,
  provider: ContractPortMap[N],
): Promise<void> {
  const dynamicProvider = provider as unknown as Record<
    string,
    (request: unknown, signal: AbortSignal) => Promise<unknown>
  >;
  const cases = contractOperationCases[name] as Record<
    string,
    { readonly request: unknown; readonly expected: unknown }
  >;

  for (const [operation, operationCase] of Object.entries(cases)) {
    const invoke = dynamicProvider[operation];
    const coordinate = `${name}.${operation}`;
    if (typeof invoke !== "function") {
      throw new TypeError(`${coordinate} must be a function`);
    }

    const result = await invoke.call(
      provider,
      operationCase.request,
      new AbortController().signal,
    );
    assertLiveResult(
      coordinate,
      result,
      operationCase.expected,
      declaredErrorCodes[name],
    );

    const cancelledResult = await invoke.call(
      provider,
      operationCase.request,
      AbortSignal.abort(),
    );
    assertCancelledResult(coordinate, cancelledResult);
  }
}

function assertLiveResult(
  coordinate: string,
  value: unknown,
  expected: unknown,
  allowedErrors: readonly string[],
): asserts value is PortResult<unknown, unknown> {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new TypeError(`${coordinate} must return a PortResult object`);
  }

  if (value.ok === true) {
    if (
      !Object.hasOwn(value, "value") ||
      Object.hasOwn(value, "error") ||
      Object.keys(value).some((key) => key !== "ok" && key !== "value")
    ) {
      throw new TypeError(
        `${coordinate} success must contain only ok and value`,
      );
    }
    if (
      !isDeepStrictEqual(
        (value as unknown as { readonly value: unknown }).value,
        expected,
      )
    ) {
      throw new TypeError(
        `${coordinate} did not return the expected success fixture`,
      );
    }
    return;
  }

  if (
    value.ok !== false ||
    !Object.hasOwn(value, "error") ||
    Object.hasOwn(value, "value") ||
    Object.keys(value).some((key) => key !== "ok" && key !== "error")
  ) {
    throw new TypeError(
      `${coordinate} failure must contain only ok and error`,
    );
  }

  const error = (value as unknown as { readonly error: unknown }).error;
  if (
    typeof error !== "object" ||
    error === null ||
    typeof (error as { code?: unknown }).code !== "string" ||
    typeof (error as { retryable?: unknown }).retryable !== "boolean"
  ) {
    throw new TypeError(
      `${coordinate} error must contain code and retryable`,
    );
  }
  if (
    Object.keys(error).some(
      (key) => key !== "code" && key !== "retryable",
    )
  ) {
    throw new TypeError(
      `${coordinate} error must contain only code and retryable`,
    );
  }

  const code = (error as { readonly code: string }).code;
  if (code === "operation_cancelled") {
    throw new TypeError(
      `${coordinate} live signal returned operation_cancelled`,
    );
  }
  if (!allowedErrors.includes(code)) {
    throw new TypeError(
      `${coordinate} returned ${code}, which is not a declared error`,
    );
  }
}

function assertCancelledResult(
  coordinate: string,
  value: unknown,
): void {
  if (
    !(
      typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 2 &&
      (value as { readonly ok?: unknown }).ok === false &&
      Object.hasOwn(value, "error")
    )
  ) {
    throw new TypeError(
      `${coordinate} aborted signal must return operation_cancelled`,
    );
  }
  const error = (value as { readonly error: unknown }).error;
  if (
    !(
      typeof error === "object" &&
      error !== null &&
      Object.keys(error).length === 2 &&
      (error as { readonly code?: unknown }).code ===
        "operation_cancelled" &&
      (error as { readonly retryable?: unknown }).retryable === false
    )
  ) {
    throw new TypeError(
      `${coordinate} aborted signal must return operation_cancelled`,
    );
  }
}
