import { copyContractDataGraph } from "./admission.ts";
import {
  eventId,
  fixtureRunId,
  generatedEvidenceId,
  generatedOperationId,
  journeyId,
  mcpRequestId,
  questionId,
  stepIds,
} from "./types.ts";
import { ContractParseError, parseMcpResponse, parseTerminalResult } from "./serialized.ts";
import {
  s2CommonComponentIds,
  s2CommonPhaseIds,
  s2StableErrorPolicy,
  type ErrorEnvelopeV3,
  type EventEnvelopeV3,
  type McpResponseV4,
  type S2StableErrorCode,
  type TerminalResultV4,
} from "./s2-common-wire.ts";

export const s2CommonWireVersions = {
  terminalResult: 4,
  mcpResponse: 4,
  errorEnvelope: 3,
  eventEnvelope: 3,
  mcpRequest: 2,
  durableJourneyState: 3,
} as const;

type JsonObject = Record<string, unknown>;

function snapshot(value: unknown): unknown {
  const copied = copyContractDataGraph(value);
  if (!copied.ok) throw new ContractParseError("invalid_type", "$");
  return copied.value;
}

function record(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractParseError("invalid_type", path);
  }
  return value as JsonObject;
}

function exact(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  const result = record(value, path);
  for (const key of required) {
    if (!Object.hasOwn(result, key)) {
      throw new ContractParseError("missing_key", `${path}.${key}`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) {
      throw new ContractParseError("extra_key", `${path}.${key}`);
    }
  }
  return result;
}

function oneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ContractParseError("invalid_value", path);
  }
  return value as T;
}

function versioned(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  version: number,
): JsonObject {
  const result = exact(value, path, ["schemaVersion", ...required], optional);
  if (typeof result.schemaVersion !== "number") {
    throw new ContractParseError("invalid_type", `${path}.schemaVersion`);
  }
  if (result.schemaVersion !== version) {
    throw new ContractParseError("incompatible_version", `${path}.schemaVersion`);
  }
  return result;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractParseError("invalid_type", path);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number") {
    throw new ContractParseError("invalid_type", path);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContractParseError("invalid_value", path);
  }
  return value;
}

function identifier<T>(
  value: unknown,
  path: string,
  parse: (candidate: string) => T,
): T {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  try {
    return parse(value);
  } catch {
    throw new ContractParseError("invalid_value", path);
  }
}

function safeId(value: unknown, path: string): void {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new ContractParseError("invalid_value", path);
  }
}

function sourceReference(value: unknown, path: string): void {
  const source = exact(value, path, ["kind", "id"]);
  const kind = oneOf(
    source.kind,
    ["operation", "event", "evidence", "fixture"],
    `${path}.kind`,
  );
  if (kind === "operation") identifier(source.id, `${path}.id`, generatedOperationId);
  else if (kind === "event") identifier(source.id, `${path}.id`, eventId);
  else if (kind === "evidence") identifier(source.id, `${path}.id`, generatedEvidenceId);
  else identifier(source.id, `${path}.id`, fixtureRunId);
}

const s2StableErrorCodes = Object.freeze(
  Object.keys(s2StableErrorPolicy) as S2StableErrorCode[],
);

function isS1FactualOutcome(value: JsonObject): boolean {
  if (value.source === "page_understanding" || value.source === "verification") {
    return true;
  }
  if (value.source !== "answer_resolution") return false;
  const result = record(value.result, "$.factualOutcome.result");
  return [
    "profile_answer_missing",
    "option_no_match",
    "option_ambiguous",
    "unsupported",
  ].includes(result.kind as string);
}

function s2FactualOutcome(value: unknown, path: string): void {
  const outcome = exact(value, path, ["source", "result"]);
  const source = oneOf(
    outcome.source,
    [
      "target_identity",
      "account_access",
      "mailbox_verification",
      "verification_navigation",
      "ats_family",
      "workday_page_type",
      "ui_behavior",
      "question_classification",
      "answer_resolution",
    ],
    `${path}.source`,
  );
  const resultPath = `${path}.result`;
  const result = record(outcome.result, resultPath);

  if (source === "target_identity") {
    const kind = oneOf(
      result.kind,
      ["target_mismatch", "target_ambiguous", "posting_unavailable"],
      `${resultPath}.kind`,
    );
    if (kind === "target_mismatch") {
      const exactResult = exact(result, resultPath, ["kind", "dimension"]);
      oneOf(exactResult.dimension, ["host", "tenant", "posting"], `${resultPath}.dimension`);
    } else if (kind === "posting_unavailable") {
      const exactResult = exact(result, resultPath, ["kind", "reason"]);
      oneOf(exactResult.reason, ["not_found", "closed", "removed", "unavailable", "maintenance", "runtime_error"], `${resultPath}.reason`);
    } else exact(result, resultPath, ["kind"]);
    return;
  }
  if (source === "account_access") {
    const exactResult = exact(result, resultPath, ["kind", "reason"]);
    oneOf(exactResult.kind, ["manual_intervention"], `${resultPath}.kind`);
    oneOf(exactResult.reason, ["captcha", "mfa", "access_control"], `${resultPath}.reason`);
    return;
  }
  if (source === "mailbox_verification") {
    const exactResult = exact(result, resultPath, ["kind"]);
    oneOf(exactResult.kind, ["mailbox_none", "mailbox_ambiguous", "mailbox_expired", "mailbox_consumed"], `${resultPath}.kind`);
    return;
  }
  if (source === "verification_navigation") {
    const exactResult = exact(result, resultPath, ["kind"]);
    oneOf(exactResult.kind, ["verification_target_unavailable"], `${resultPath}.kind`);
    return;
  }
  if (source === "ats_family") {
    const exactResult = exact(result, resultPath, ["kind"]);
    oneOf(exactResult.kind, ["ats_unsupported", "ats_unknown", "ats_ambiguous"], `${resultPath}.kind`);
    return;
  }
  if (source === "workday_page_type") {
    const exactResult = exact(result, resultPath, ["kind"]);
    oneOf(exactResult.kind, ["workday_page_unknown", "workday_page_ambiguous"], `${resultPath}.kind`);
    return;
  }
  if (source === "ui_behavior") {
    const kind = oneOf(result.kind, ["ui_behavior_unknown", "ui_behavior_ambiguous", "ui_variant_unreviewed"], `${resultPath}.kind`);
    if (kind === "ui_variant_unreviewed") {
      const exactResult = exact(result, resultPath, ["kind", "variantId"]);
      safeId(exactResult.variantId, `${resultPath}.variantId`);
    } else exact(result, resultPath, ["kind"]);
    return;
  }
  if (source === "question_classification") {
    const exactResult = exact(result, resultPath, ["kind"]);
    oneOf(exactResult.kind, ["question_unknown", "question_ambiguous"], `${resultPath}.kind`);
    return;
  }
  const exactResult = exact(result, resultPath, ["kind", "questionId"]);
  oneOf(exactResult.kind, ["answer_type_unknown", "answer_type_ambiguous"], `${resultPath}.kind`);
  identifier(exactResult.questionId, `${resultPath}.questionId`, questionId);
}

export function parseTerminalResultV4(value: unknown): TerminalResultV4 {
  const copy = snapshot(value);
  const result = versioned(
    copy,
    "$",
    ["journeyId", "status", "completedPages"],
    ["errorCode", "factualOutcome"],
    s2CommonWireVersions.terminalResult,
  );
  identifier(result.journeyId, "$.journeyId", journeyId);
  const status = oneOf(
    result.status,
    ["review_reached", "blocked", "cancelled", "failed"],
    "$.status",
  );
  integer(result.completedPages, "$.completedPages");
  if (status === "failed") {
    if (!Object.hasOwn(result, "errorCode")) {
      throw new ContractParseError("missing_key", "$.errorCode");
    }
    oneOf(result.errorCode, s2StableErrorCodes, "$.errorCode");
    if (Object.hasOwn(result, "factualOutcome")) {
      throw new ContractParseError("extra_key", "$.factualOutcome");
    }
  } else if (status === "blocked") {
    if (Object.hasOwn(result, "errorCode")) {
      throw new ContractParseError("extra_key", "$.errorCode");
    }
    if (!Object.hasOwn(result, "factualOutcome")) {
      throw new ContractParseError("missing_key", "$.factualOutcome");
    }
    const outcome = record(result.factualOutcome, "$.factualOutcome");
    if (isS1FactualOutcome(outcome)) {
      parseTerminalResult({ ...result, schemaVersion: 3 });
    } else s2FactualOutcome(outcome, "$.factualOutcome");
  } else {
    if (Object.hasOwn(result, "errorCode")) {
      throw new ContractParseError("extra_key", "$.errorCode");
    }
    if (Object.hasOwn(result, "factualOutcome")) {
      throw new ContractParseError("extra_key", "$.factualOutcome");
    }
  }
  return copy as TerminalResultV4;
}

export function parseErrorEnvelopeV3(value: unknown): ErrorEnvelopeV3 {
  const copy = snapshot(value);
  const error = versioned(copy, "$", ["code", "component", "phase", "step", "retryable", "source"], ["cause"], s2CommonWireVersions.errorEnvelope);
  const code = oneOf(error.code, s2StableErrorCodes, "$.code");
  const component = oneOf(error.component, s2CommonComponentIds, "$.component");
  if (component !== s2StableErrorPolicy[code].owner) {
    throw new ContractParseError("invalid_value", "$.component");
  }
  oneOf(error.phase, s2CommonPhaseIds, "$.phase");
  oneOf(error.step, stepIds, "$.step");
  if (boolean(error.retryable, "$.retryable") !== s2StableErrorPolicy[code].retryable) {
    throw new ContractParseError("invalid_value", "$.retryable");
  }
  sourceReference(error.source, "$.source");
  if (Object.hasOwn(error, "cause")) {
    const cause = exact(error.cause, "$.cause", ["verification", "code", "source"]);
    oneOf(cause.verification, ["verified"], "$.cause.verification");
    oneOf(cause.code, s2StableErrorCodes, "$.cause.code");
    sourceReference(cause.source, "$.cause.source");
  }
  return copy as ErrorEnvelopeV3;
}

export function parseEventEnvelopeV3(value: unknown): EventEnvelopeV3 {
  const copy = snapshot(value);
  const event = versioned(copy, "$", ["eventId", "journeyId", "component", "phase", "step", "kind", "at", "source"], [], s2CommonWireVersions.eventEnvelope);
  identifier(event.eventId, "$.eventId", eventId);
  identifier(event.journeyId, "$.journeyId", journeyId);
  oneOf(event.component, s2CommonComponentIds, "$.component");
  oneOf(event.phase, s2CommonPhaseIds, "$.phase");
  oneOf(event.step, stepIds, "$.step");
  oneOf(event.kind, ["step_started", "step_completed", "step_failed", "journey_terminal"], "$.kind");
  if (typeof event.at !== "string") {
    throw new ContractParseError("invalid_type", "$.at");
  }
  if (event.at.length === 0) {
    throw new ContractParseError("invalid_value", "$.at");
  }
  sourceReference(event.source, "$.source");
  return copy as EventEnvelopeV3;
}

export function parseMcpResponseV4(value: unknown): McpResponseV4 {
  const copy = snapshot(value);
  const response = versioned(copy, "$", ["requestId", "ok"], ["result", "error"], s2CommonWireVersions.mcpResponse);
  identifier(response.requestId, "$.requestId", mcpRequestId);
  const ok = boolean(response.ok, "$.ok");
  if (ok) {
    if (!Object.hasOwn(response, "result")) throw new ContractParseError("missing_key", "$.result");
    if (Object.hasOwn(response, "error")) throw new ContractParseError("extra_key", "$.error");
    const result = record(response.result, "$.result");
    const kind = oneOf(result.kind, ["accepted", "status", "terminal"], "$.result.kind");
    if (kind === "terminal") {
      const terminal = exact(result, "$.result", ["kind", "terminal"]);
      parseTerminalResultV4(terminal.terminal);
    } else {
      parseMcpResponse({ ...response, schemaVersion: 3 });
    }
  } else {
    if (!Object.hasOwn(response, "error")) throw new ContractParseError("missing_key", "$.error");
    if (Object.hasOwn(response, "result")) throw new ContractParseError("extra_key", "$.result");
    parseErrorEnvelopeV3(response.error);
  }
  return copy as McpResponseV4;
}
