import {
  booleanProfileFactIds,
  journeyBootstrapReferenceKeys,
  numberProfileFactIds,
  phaseIds,
  stepIds,
  textProfileFactIds,
} from "./types.ts";
import type {
  ApplicantProfile,
  ComponentId,
  DurableJourneyState,
  ErrorEnvelope,
  EventEnvelope,
  EvidenceManifest,
  FixtureManifest,
  JourneyStatus,
  McpRequest,
  McpResponse,
  StableErrorCode,
  TerminalResult,
} from "./types.ts";

export const SERIALIZED_CONTRACT_VERSION = 1 as const;

export type ContractParseErrorCode =
  | "invalid_type"
  | "missing_key"
  | "extra_key"
  | "invalid_value"
  | "incompatible_version"
  | "credential_forbidden";

export class ContractParseError extends Error {
  readonly code: ContractParseErrorCode;
  readonly path: string;

  constructor(code: ContractParseErrorCode, path: string) {
    super(`${code}: ${path}`);
    this.name = "ContractParseError";
    this.code = code;
    this.path = path;
  }
}

type JsonObject = Record<string, unknown>;

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

function string(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ContractParseError("invalid_type", path);
  }
  if (value.length === 0) {
    throw new ContractParseError("invalid_value", path);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ContractParseError("invalid_type", path);
  }
  return value;
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContractParseError(
      typeof value === "number" ? "invalid_value" : "invalid_type",
      path,
    );
  }
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ContractParseError("invalid_type", path);
  }
  return value;
}

function oneOf<T extends string>(
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
  optional: readonly string[] = [],
): JsonObject {
  const result = exact(value, path, ["schemaVersion", ...required], optional);
  if (typeof result.schemaVersion !== "number") {
    throw new ContractParseError("invalid_type", `${path}.schemaVersion`);
  }
  if (result.schemaVersion !== SERIALIZED_CONTRACT_VERSION) {
    throw new ContractParseError(
      "incompatible_version",
      `${path}.schemaVersion`,
    );
  }
  return result;
}

function parseSourceReference(value: unknown, path: string): void {
  const source = exact(value, path, ["kind", "id"]);
  oneOf(
    source.kind,
    ["operation", "event", "evidence", "fixture"],
    `${path}.kind`,
  );
  string(source.id, `${path}.id`);
}

function parseVerifiedCause(value: unknown, path: string): void {
  const cause = exact(value, path, ["verification", "code", "source"]);
  oneOf(cause.verification, ["verified"], `${path}.verification`);
  oneOf(cause.code, stableErrorCodes, `${path}.code`);
  parseSourceReference(cause.source, `${path}.source`);
}

const componentIds = [
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
] as const satisfies readonly ComponentId[];

const journeyStatuses = [
  "ready",
  "running",
  "cancelling",
  "review_reached",
  "cancelled",
  "failed",
] as const satisfies readonly JourneyStatus[];

const stableErrorCodes = [
  "operation_cancelled",
  "fixture_not_found",
  "fixture_already_started",
  "fixture_transition_illegal",
  "fixture_transition_replayed",
  "fixture_timeout",
  "browser_target_invalid",
  "browser_page_owned",
  "browser_session_missing",
  "browser_target_stale",
  "browser_target_ambiguous",
  "browser_operation_replayed",
  "browser_timeout",
  "journey_input_invalid",
  "resume_identity_mismatch",
  "profile_missing",
  "profile_revision_mismatch",
  "journey_state_invalid",
  "journey_transition_illegal",
  "journey_revision_conflict",
  "journey_state_unavailable",
  "page_observation_invalid",
  "question_unknown",
  "question_ambiguous",
  "protected_answer_denied",
  "driver_intent_invalid",
  "driver_behavior_unsupported",
  "driver_target_invalid",
  "driver_operation_replayed",
  "verification_input_invalid",
  "verification_timeout",
  "page_incomplete",
  "navigation_illegal",
  "navigation_uncertain",
  "journey_operation_replayed",
  "journey_not_found",
  "journey_already_terminal",
  "journey_busy",
  "journey_retry_exhausted",
  "mcp_request_invalid",
  "mcp_method_unknown",
  "mcp_internal_error",
  "event_invalid",
  "event_store_unavailable",
  "progress_not_found",
  "failure_context_invalid",
  "notification_unavailable",
  "credential_forbidden",
  "token_forbidden",
  "raw_text_forbidden",
  "selector_forbidden",
  "policy_override_forbidden",
  "submit_forbidden",
  "payload_too_large",
  "evidence_denied",
  "evidence_limit_exceeded",
  "evidence_unavailable",
  "model_request_denied",
  "model_result_denied",
  "model_unavailable",
] as const satisfies readonly StableErrorCode[];

type SameUnion<A, B> =
  [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const componentIdsCoverUnion: SameUnion<
  (typeof componentIds)[number],
  ComponentId
> = true;
const stableErrorCodesCoverUnion: SameUnion<
  (typeof stableErrorCodes)[number],
  StableErrorCode
> = true;

export const serializedContractCoverage = {
  componentIds: componentIdsCoverUnion,
  stableErrorCodes: stableErrorCodesCoverUnion,
} as const;

export function parseFixtureManifest(value: unknown): FixtureManifest {
  const manifest = versioned(value, "$", ["fixtureSet", "pages"]);
  oneOf(manifest.fixtureSet, ["workday-s1"], "$.fixtureSet");
  for (const [index, item] of array(manifest.pages, "$.pages").entries()) {
    const page = exact(item, `$.pages[${index}]`, [
      "id",
      "path",
      "semanticHash",
    ]);
    string(page.id, `$.pages[${index}].id`);
    string(page.path, `$.pages[${index}].path`);
    string(page.semanticHash, `$.pages[${index}].semanticHash`);
  }
  return value as FixtureManifest;
}

export function parseDurableJourneyState(
  value: unknown,
): DurableJourneyState {
  const state = versioned(value, "$", [
    "journeyId",
    "status",
    "pageId",
    "revision",
  ]);
  string(state.journeyId, "$.journeyId");
  oneOf(state.status, journeyStatuses, "$.status");
  if (state.pageId !== null) {
    string(state.pageId, "$.pageId");
  }
  integer(state.revision, "$.revision");
  return value as DurableJourneyState;
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
  const event = versioned(value, "$", [
    "eventId",
    "journeyId",
    "component",
    "phase",
    "step",
    "kind",
    "at",
    "source",
  ]);
  string(event.eventId, "$.eventId");
  string(event.journeyId, "$.journeyId");
  oneOf(event.component, componentIds, "$.component");
  oneOf(event.phase, phaseIds, "$.phase");
  oneOf(event.step, stepIds, "$.step");
  oneOf(
    event.kind,
    ["step_started", "step_completed", "step_failed", "journey_terminal"],
    "$.kind",
  );
  string(event.at, "$.at");
  parseSourceReference(event.source, "$.source");
  return value as EventEnvelope;
}

export function parseErrorEnvelope(value: unknown): ErrorEnvelope {
  const error = versioned(value, "$", [
    "code",
    "component",
    "phase",
    "step",
    "retryable",
    "source",
  ], ["cause"]);
  oneOf(error.code, stableErrorCodes, "$.code");
  oneOf(error.component, componentIds, "$.component");
  oneOf(error.phase, phaseIds, "$.phase");
  oneOf(error.step, stepIds, "$.step");
  boolean(error.retryable, "$.retryable");
  parseSourceReference(error.source, "$.source");
  if (Object.hasOwn(error, "cause")) {
    parseVerifiedCause(error.cause, "$.cause");
  }
  return value as ErrorEnvelope;
}

export function parseEvidenceManifest(value: unknown): EvidenceManifest {
  const manifest = versioned(value, "$", ["journeyId", "records"]);
  string(manifest.journeyId, "$.journeyId");
  for (const [index, item] of array(manifest.records, "$.records").entries()) {
    const evidence = exact(item, `$.records[${index}]`, [
      "id",
      "kind",
      "component",
      "phase",
      "step",
      "sha256",
    ]);
    string(evidence.id, `$.records[${index}].id`);
    oneOf(
      evidence.kind,
      ["semantic_snapshot", "operation_receipt", "verification"],
      `$.records[${index}].kind`,
    );
    oneOf(
      evidence.component,
      componentIds,
      `$.records[${index}].component`,
    );
    oneOf(evidence.phase, phaseIds, `$.records[${index}].phase`);
    oneOf(evidence.step, stepIds, `$.records[${index}].step`);
    string(evidence.sha256, `$.records[${index}].sha256`);
  }
  return value as EvidenceManifest;
}

function parseMcpParams(
  method: McpRequest["method"],
  value: unknown,
): void {
  if (method === "start_journey") {
    const params = exact(value, "$.params", journeyBootstrapReferenceKeys);
    for (const key of Object.keys(params)) {
      string(params[key], `$.params.${key}`);
    }
    return;
  }
  if (method === "cancel_journey") {
    const params = exact(value, "$.params", ["operationId", "journeyId"]);
    string(params.operationId, "$.params.operationId");
    string(params.journeyId, "$.params.journeyId");
    return;
  }
  const params = exact(value, "$.params", ["journeyId"]);
  string(params.journeyId, "$.params.journeyId");
}

export function parseMcpRequest(value: unknown): McpRequest {
  const request = versioned(value, "$", ["requestId", "method", "params"]);
  string(request.requestId, "$.requestId");
  const method = oneOf(
    request.method,
    ["start_journey", "cancel_journey", "journey_status", "journey_result"],
    "$.method",
  );
  parseMcpParams(method, request.params);
  return value as McpRequest;
}

function parseMcpResult(value: unknown): void {
  const result = record(value, "$.result");
  const kind = oneOf(
    result.kind,
    ["accepted", "status", "terminal"],
    "$.result.kind",
  );
  if (kind === "accepted") {
    const accepted = exact(result, "$.result", [
      "kind",
      "operationId",
      "journeyId",
    ]);
    string(accepted.operationId, "$.result.operationId");
    string(accepted.journeyId, "$.result.journeyId");
    return;
  }
  if (kind === "status") {
    const status = exact(result, "$.result", ["kind", "progress"]);
    const progress = exact(status.progress, "$.result.progress", [
      "journeyId",
      "status",
      "completedSteps",
    ]);
    string(progress.journeyId, "$.result.progress.journeyId");
    oneOf(progress.status, journeyStatuses, "$.result.progress.status");
    integer(progress.completedSteps, "$.result.progress.completedSteps");
    return;
  }
  const terminal = exact(result, "$.result", ["kind", "terminal"]);
  parseTerminalResult(terminal.terminal);
}

export function parseMcpResponse(value: unknown): McpResponse {
  const response = versioned(value, "$", ["requestId", "ok"], [
    "result",
    "error",
  ]);
  string(response.requestId, "$.requestId");
  const ok = boolean(response.ok, "$.ok");
  if (ok) {
    if (!Object.hasOwn(response, "result")) {
      throw new ContractParseError("missing_key", "$.result");
    }
    if (Object.hasOwn(response, "error")) {
      throw new ContractParseError("extra_key", "$.error");
    }
    parseMcpResult(response.result);
  } else {
    if (!Object.hasOwn(response, "error")) {
      throw new ContractParseError("missing_key", "$.error");
    }
    if (Object.hasOwn(response, "result")) {
      throw new ContractParseError("extra_key", "$.result");
    }
    parseErrorEnvelope(response.error);
  }
  return value as McpResponse;
}

export function parseTerminalResult(value: unknown): TerminalResult {
  const result = versioned(value, "$", [
    "journeyId",
    "status",
    "completedPages",
  ], ["errorCode"]);
  string(result.journeyId, "$.journeyId");
  const status = oneOf(
    result.status,
    ["review_reached", "cancelled", "failed"],
    "$.status",
  );
  integer(result.completedPages, "$.completedPages");
  if (status === "failed") {
    if (!Object.hasOwn(result, "errorCode")) {
      throw new ContractParseError("missing_key", "$.errorCode");
    }
    oneOf(result.errorCode, stableErrorCodes, "$.errorCode");
  } else if (Object.hasOwn(result, "errorCode")) {
    throw new ContractParseError("extra_key", "$.errorCode");
  }
  return value as TerminalResult;
}

export function parseApplicantProfile(value: unknown): ApplicantProfile {
  const profile = exact(value, "$", ["profileId", "revision", "facts"]);
  string(profile.profileId, "$.profileId");
  integer(profile.revision, "$.revision");
  for (const [index, item] of array(profile.facts, "$.facts").entries()) {
    const fact = exact(item, `$.facts[${index}]`, [
      "factId",
      "value",
      "provenance",
    ]);
    const factId = string(
      fact.factId,
      `$.facts[${index}].factId`,
    );
    const normalizedFactId = factId
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
    if (
      /(?:^|_)(?:credential|credentials|password|passcode|passphrase|secret|private_key|api_key|access_token|refresh_token|bearer_token|auth_token|oauth_token|session_token|session_cookie|cookie|authorization_header|client_secret)(?:$|_)/.test(
        normalizedFactId,
      )
    ) {
      throw new ContractParseError(
        "credential_forbidden",
        `$.facts[${index}].factId`,
      );
    }
    if ((textProfileFactIds as readonly string[]).includes(factId)) {
      string(fact.value, `$.facts[${index}].value`);
    } else if (
      (booleanProfileFactIds as readonly string[]).includes(factId)
    ) {
      boolean(fact.value, `$.facts[${index}].value`);
    } else if ((numberProfileFactIds as readonly string[]).includes(factId)) {
      if (
        typeof fact.value !== "number" ||
        !Number.isFinite(fact.value) ||
        fact.value < 0
      ) {
        throw new ContractParseError(
          typeof fact.value === "number" ? "invalid_value" : "invalid_type",
          `$.facts[${index}].value`,
        );
      }
    } else {
      throw new ContractParseError(
        "invalid_value",
        `$.facts[${index}].factId`,
      );
    }
    oneOf(
      fact.provenance,
      ["owner_provided", "resume_verified", "configured_template"],
      `$.facts[${index}].provenance`,
    );
  }
  return value as ApplicantProfile;
}

const nonEmptyString = { type: "string", minLength: 1 } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const schemaVersion = { const: SERIALIZED_CONTRACT_VERSION } as const;

const sourceReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { enum: ["operation", "event", "evidence", "fixture"] },
    id: nonEmptyString,
  },
} as const;

const verifiedCauseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verification", "code", "source"],
  properties: {
    verification: { const: "verified" },
    code: { enum: stableErrorCodes },
    source: sourceReferenceSchema,
  },
} as const;

const errorEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "code",
    "component",
    "phase",
    "step",
    "retryable",
    "source",
  ],
  properties: {
    schemaVersion,
    code: { enum: stableErrorCodes },
    component: { enum: componentIds },
    phase: { enum: phaseIds },
    step: { enum: stepIds },
    retryable: { type: "boolean" },
    source: sourceReferenceSchema,
    cause: verifiedCauseSchema,
  },
} as const;

const terminalResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "journeyId", "status", "completedPages"],
  properties: {
    schemaVersion,
    journeyId: nonEmptyString,
    status: { enum: ["review_reached", "cancelled", "failed"] },
    completedPages: nonNegativeInteger,
    errorCode: { enum: stableErrorCodes },
  },
  allOf: [
    {
      if: { properties: { status: { const: "failed" } } },
      then: { required: ["errorCode"] },
      else: { not: { required: ["errorCode"] } },
    },
  ],
} as const;

export const serializedSchemas = {
  fixtureManifest: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "fixtureSet", "pages"],
    properties: {
      schemaVersion,
      fixtureSet: { const: "workday-s1" },
      pages: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "path", "semanticHash"],
          properties: {
            id: nonEmptyString,
            path: nonEmptyString,
            semanticHash: nonEmptyString,
          },
        },
      },
    },
  },
  durableJourneyState: {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "journeyId",
      "status",
      "pageId",
      "revision",
    ],
    properties: {
      schemaVersion,
      journeyId: nonEmptyString,
      status: { enum: journeyStatuses },
      pageId: { type: ["string", "null"], minLength: 1 },
      revision: nonNegativeInteger,
    },
  },
  eventEnvelope: {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "eventId",
      "journeyId",
      "component",
      "phase",
      "step",
      "kind",
      "at",
      "source",
    ],
    properties: {
      schemaVersion,
      eventId: nonEmptyString,
      journeyId: nonEmptyString,
      component: { enum: componentIds },
      phase: { enum: phaseIds },
      step: { enum: stepIds },
      kind: {
        enum: [
          "step_started",
          "step_completed",
          "step_failed",
          "journey_terminal",
        ],
      },
      at: nonEmptyString,
      source: sourceReferenceSchema,
    },
  },
  errorEnvelope: errorEnvelopeSchema,
  evidenceManifest: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "journeyId", "records"],
    properties: {
      schemaVersion,
      journeyId: nonEmptyString,
      records: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "component", "phase", "step", "sha256"],
          properties: {
            id: nonEmptyString,
            kind: {
              enum: [
                "semantic_snapshot",
                "operation_receipt",
                "verification",
              ],
            },
            component: { enum: componentIds },
            phase: { enum: phaseIds },
            step: { enum: stepIds },
            sha256: nonEmptyString,
          },
        },
      },
    },
  },
  mcpRequest: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "requestId", "method", "params"],
    properties: {
      schemaVersion,
      requestId: nonEmptyString,
      method: {
        enum: [
          "start_journey",
          "cancel_journey",
          "journey_status",
          "journey_result",
        ],
      },
      params: { type: "object" },
    },
    oneOf: [
      {
        properties: {
          method: { const: "start_journey" },
          params: {
            type: "object",
            additionalProperties: false,
            required: journeyBootstrapReferenceKeys,
            properties: {
              operationId: nonEmptyString,
              jobId: nonEmptyString,
              resumeId: nonEmptyString,
              profileId: nonEmptyString,
            },
          },
        },
      },
      {
        properties: {
          method: { const: "cancel_journey" },
          params: {
            type: "object",
            additionalProperties: false,
            required: ["operationId", "journeyId"],
            properties: {
              operationId: nonEmptyString,
              journeyId: nonEmptyString,
            },
          },
        },
      },
      {
        properties: {
          method: { enum: ["journey_status", "journey_result"] },
          params: {
            type: "object",
            additionalProperties: false,
            required: ["journeyId"],
            properties: { journeyId: nonEmptyString },
          },
        },
      },
    ],
  },
  mcpResponse: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "requestId", "ok"],
    properties: {
      schemaVersion,
      requestId: nonEmptyString,
      ok: { type: "boolean" },
      result: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "operationId", "journeyId"],
            properties: {
              kind: { const: "accepted" },
              operationId: nonEmptyString,
              journeyId: nonEmptyString,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "progress"],
            properties: {
              kind: { const: "status" },
              progress: {
                type: "object",
                additionalProperties: false,
                required: ["journeyId", "status", "completedSteps"],
                properties: {
                  journeyId: nonEmptyString,
                  status: { enum: journeyStatuses },
                  completedSteps: nonNegativeInteger,
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "terminal"],
            properties: {
              kind: { const: "terminal" },
              terminal: terminalResultSchema,
            },
          },
        ],
      },
      error: errorEnvelopeSchema,
    },
    oneOf: [
      {
        properties: { ok: { const: true } },
        required: ["result"],
        not: { required: ["error"] },
      },
      {
        properties: { ok: { const: false } },
        required: ["error"],
        not: { required: ["result"] },
      },
    ],
  },
  terminalResult: terminalResultSchema,
} as const;
