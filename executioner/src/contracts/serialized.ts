import {
  booleanProfileFactIds,
  browserPageId,
  eventId,
  fieldId,
  generatedEvidenceId,
  fixturePageId,
  fixtureRunId,
  fixtureSemanticHash,
  generatedOperationId,
  journeyId,
  journeyBootstrapReferenceKeys,
  mcpRequestId,
  numberProfileFactIds,
  phaseIds,
  questionId,
  stableErrorPolicy,
  stepIds,
  textProfileFactIds,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
} from "./types.ts";
import { copyContractDataGraph } from "./admission.ts";
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

export const SERIALIZED_CONTRACT_VERSION = 2 as const;
export const serializedContractVersions = {
  fixtureManifest: 2,
  durableJourneyState: 3,
  eventEnvelope: 2,
  errorEnvelope: 2,
  evidenceManifest: 2,
  terminalResult: 3,
  mcpRequest: 2,
  mcpResponse: 3,
} as const;

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

function identifier<T>(
  value: unknown,
  path: string,
  parse: (candidate: string) => T,
): T {
  const candidate = string(value, path);
  try {
    return parse(candidate);
  } catch {
    throw new ContractParseError("invalid_value", path);
  }
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
  expectedVersion: number = SERIALIZED_CONTRACT_VERSION,
): JsonObject {
  const result = exact(value, path, ["schemaVersion", ...required], optional);
  if (typeof result.schemaVersion !== "number") {
    throw new ContractParseError("invalid_type", `${path}.schemaVersion`);
  }
  if (result.schemaVersion !== expectedVersion) {
    throw new ContractParseError(
      "incompatible_version",
      `${path}.schemaVersion`,
    );
  }
  return result;
}

function admittedSerializedSnapshot(value: unknown): unknown {
  const copied = copyContractDataGraph(value);
  if (!copied.ok) {
    throw new ContractParseError("invalid_type", "$");
  }
  return copied.value;
}

function parseSourceReference(value: unknown, path: string): void {
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
  "blocked",
  "cancelled",
  "failed",
] as const satisfies readonly JourneyStatus[];

const stableErrorCodes = Object.freeze(
  Object.keys(stableErrorPolicy) as StableErrorCode[],
);

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
  const snapshot = admittedSerializedSnapshot(value);
  const manifest = versioned(snapshot, "$", ["fixtureSet", "pages"]);
  oneOf(manifest.fixtureSet, ["workday-s1"], "$.fixtureSet");
  for (const [index, item] of array(manifest.pages, "$.pages").entries()) {
    const page = exact(item, `$.pages[${index}]`, [
      "id",
      "path",
      "semanticHash",
    ]);
    identifier(page.id, `$.pages[${index}].id`, fixturePageId);
    string(page.path, `$.pages[${index}].path`);
    identifier(page.semanticHash, `$.pages[${index}].semanticHash`, fixtureSemanticHash);
  }
  return snapshot as FixtureManifest;
}

export function parseDurableJourneyState(
  value: unknown,
): DurableJourneyState {
  const snapshot = admittedSerializedSnapshot(value);
  const state = versioned(
    snapshot,
    "$",
    ["journeyId", "status", "pageId", "revision"],
    [],
    serializedContractVersions.durableJourneyState,
  );
  identifier(state.journeyId, "$.journeyId", journeyId);
  oneOf(state.status, journeyStatuses, "$.status");
  if (state.pageId !== null) {
    identifier(state.pageId, "$.pageId", browserPageId);
  }
  integer(state.revision, "$.revision");
  return snapshot as DurableJourneyState;
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
  const snapshot = admittedSerializedSnapshot(value);
  const event = versioned(snapshot, "$", [
    "eventId",
    "journeyId",
    "component",
    "phase",
    "step",
    "kind",
    "at",
    "source",
  ]);
  identifier(event.eventId, "$.eventId", eventId);
  identifier(event.journeyId, "$.journeyId", journeyId);
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
  return snapshot as EventEnvelope;
}

export function parseErrorEnvelope(value: unknown): ErrorEnvelope {
  const snapshot = admittedSerializedSnapshot(value);
  const error = versioned(snapshot, "$", [
    "code",
    "component",
    "phase",
    "step",
    "retryable",
    "source",
  ], ["cause"], serializedContractVersions.errorEnvelope);
  const code = oneOf(error.code, stableErrorCodes, "$.code");
  const component = oneOf(error.component, componentIds, "$.component");
  if (component !== stableErrorPolicy[code].owner) {
    throw new ContractParseError("invalid_value", "$.component");
  }
  oneOf(error.phase, phaseIds, "$.phase");
  oneOf(error.step, stepIds, "$.step");
  const retryable = boolean(error.retryable, "$.retryable");
  if (retryable !== stableErrorPolicy[code].retryable) {
    throw new ContractParseError("invalid_value", "$.retryable");
  }
  parseSourceReference(error.source, "$.source");
  if (Object.hasOwn(error, "cause")) {
    parseVerifiedCause(error.cause, "$.cause");
  }
  return snapshot as ErrorEnvelope;
}

export function parseEvidenceManifest(value: unknown): EvidenceManifest {
  const snapshot = admittedSerializedSnapshot(value);
  const manifest = versioned(snapshot, "$", ["journeyId", "records"]);
  identifier(manifest.journeyId, "$.journeyId", journeyId);
  for (const [index, item] of array(manifest.records, "$.records").entries()) {
    const evidence = exact(item, `$.records[${index}]`, [
      "id",
      "kind",
      "component",
      "phase",
      "step",
      "sha256",
    ]);
    identifier(evidence.id, `$.records[${index}].id`, generatedEvidenceId);
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
    if (!/^[a-f0-9]{64}$/u.test(string(evidence.sha256, `$.records[${index}].sha256`))) {
      throw new ContractParseError("invalid_value", `$.records[${index}].sha256`);
    }
  }
  return snapshot as EvidenceManifest;
}

function parseMcpParams(
  method: McpRequest["method"],
  value: unknown,
): void {
  if (method === "start_journey") {
    const params = exact(value, "$.params", journeyBootstrapReferenceKeys);
    identifier(params.jobId, "$.params.jobId", upstreamJobId);
    identifier(params.resumeId, "$.params.resumeId", upstreamResumeId);
    identifier(params.profileId, "$.params.profileId", upstreamProfileId);
    return;
  }
  if (method === "cancel_journey") {
    const params = exact(value, "$.params", ["journeyId"]);
    identifier(params.journeyId, "$.params.journeyId", journeyId);
    return;
  }
  const params = exact(value, "$.params", ["journeyId"]);
  identifier(params.journeyId, "$.params.journeyId", journeyId);
}

export function parseMcpRequest(value: unknown): McpRequest {
  const snapshot = admittedSerializedSnapshot(value);
  const request = versioned(
    snapshot,
    "$",
    ["requestId", "method", "params"],
    [],
    serializedContractVersions.mcpRequest,
  );
  identifier(request.requestId, "$.requestId", mcpRequestId);
  const method = oneOf(
    request.method,
    ["start_journey", "cancel_journey", "journey_status", "journey_result"],
    "$.method",
  );
  parseMcpParams(method, request.params);
  return snapshot as McpRequest;
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
    identifier(accepted.operationId, "$.result.operationId", generatedOperationId);
    identifier(accepted.journeyId, "$.result.journeyId", journeyId);
    return;
  }
  if (kind === "status") {
    const status = exact(result, "$.result", ["kind", "progress"]);
    const progress = exact(status.progress, "$.result.progress", [
      "journeyId",
      "status",
      "completedSteps",
    ]);
    identifier(progress.journeyId, "$.result.progress.journeyId", journeyId);
    oneOf(progress.status, journeyStatuses, "$.result.progress.status");
    integer(progress.completedSteps, "$.result.progress.completedSteps");
    return;
  }
  const terminal = exact(result, "$.result", ["kind", "terminal"]);
  parseTerminalResult(terminal.terminal);
}

export function parseMcpResponse(value: unknown): McpResponse {
  const snapshot = admittedSerializedSnapshot(value);
  const response = versioned(
    snapshot,
    "$",
    ["requestId", "ok"],
    ["result", "error"],
    serializedContractVersions.mcpResponse,
  );
  identifier(response.requestId, "$.requestId", mcpRequestId);
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
  return snapshot as McpResponse;
}

export function parseTerminalResult(value: unknown): TerminalResult {
  const snapshot = admittedSerializedSnapshot(value);
  const result = versioned(snapshot, "$", [
    "journeyId",
    "status",
    "completedPages",
  ], ["errorCode", "factualOutcome"], serializedContractVersions.terminalResult);
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
    oneOf(result.errorCode, stableErrorCodes, "$.errorCode");
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
    parseFactualTerminalOutcome(result.factualOutcome, "$.factualOutcome");
  } else {
    if (Object.hasOwn(result, "errorCode")) {
      throw new ContractParseError("extra_key", "$.errorCode");
    }
    if (Object.hasOwn(result, "factualOutcome")) {
      throw new ContractParseError("extra_key", "$.factualOutcome");
    }
  }
  return snapshot as TerminalResult;
}

function parseFactualTerminalOutcome(value: unknown, path: string): void {
  const outcome = exact(value, path, ["source", "result"]);
  const source = oneOf(
    outcome.source,
    ["page_understanding", "answer_resolution", "verification"],
    `${path}.source`,
  );
  if (source === "page_understanding") {
    const result = exact(outcome.result, `${path}.result`, ["kind", "pageId"]);
    oneOf(result.kind, ["unknown", "ambiguous"], `${path}.result.kind`);
    identifier(result.pageId, `${path}.result.pageId`, browserPageId);
    return;
  }
  const candidate = record(outcome.result, `${path}.result`);
  if (source === "verification") {
    const kind = oneOf(
      candidate.kind,
      ["rejected", "ambiguous", "unavailable"],
      `${path}.result.kind`,
    );
    if (kind === "rejected") {
      const result = exact(
        candidate,
        `${path}.result`,
        ["kind", "fieldId", "reason"],
      );
      identifier(result.fieldId, `${path}.result.fieldId`, fieldId);
      oneOf(result.reason, ["mismatch", "stale"], `${path}.result.reason`);
      return;
    }
    const result = exact(candidate, `${path}.result`, ["kind", "fieldId"]);
    identifier(result.fieldId, `${path}.result.fieldId`, fieldId);
    return;
  }
  const kind = oneOf(
    candidate.kind,
    [
      "profile_answer_missing",
      "option_no_match",
      "option_ambiguous",
      "unsupported",
    ],
    `${path}.result.kind`,
  );
  if (
    kind === "profile_answer_missing" ||
    kind === "option_no_match" ||
    kind === "option_ambiguous"
  ) {
    const result = exact(candidate, `${path}.result`, ["kind", "questionId"]);
    identifier(result.questionId, `${path}.result.questionId`, questionId);
    return;
  }
  const result = exact(candidate, `${path}.result`, ["kind", "fieldId"]);
  identifier(result.fieldId, `${path}.result.fieldId`, fieldId);
}

export function parseApplicantProfile(value: unknown): ApplicantProfile {
  const snapshot = admittedSerializedSnapshot(value);
  const profile = exact(snapshot, "$", ["profileId", "revision", "facts"]);
  identifier(profile.profileId, "$.profileId", upstreamProfileId);
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
  return snapshot as ApplicantProfile;
}

const nonEmptyString = { type: "string", minLength: 1 } as const;
const opaqueIdentifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
} as const;
const journeyIdentifierSchema = {
  type: "string",
  maxLength: 72,
  pattern: "^journey_[A-Za-z0-9_-]{16,64}$",
} as const;
const operationIdentifierSchema = {
  type: "string",
  maxLength: 74,
  pattern: "^operation_[A-Za-z0-9_-]{16,64}$",
} as const;
const evidenceIdentifierSchema = {
  type: "string",
  maxLength: 73,
  pattern: "^evidence_[A-Za-z0-9_-]{16,64}$",
} as const;
const sha256Schema = {
  type: "string",
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
} as const;
const nonNegativeInteger = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
const schemaVersion = { const: SERIALIZED_CONTRACT_VERSION } as const;
const mcpSchemaVersion = {
  const: serializedContractVersions.mcpRequest,
} as const;
const durableJourneyStateSchemaVersion = {
  const: serializedContractVersions.durableJourneyState,
} as const;
const mcpResponseSchemaVersion = {
  const: serializedContractVersions.mcpResponse,
} as const;
const errorSchemaVersion = {
  const: serializedContractVersions.errorEnvelope,
} as const;
const terminalSchemaVersion = {
  const: serializedContractVersions.terminalResult,
} as const;

const sourceReferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id"],
  properties: {
    kind: { enum: ["operation", "event", "evidence", "fixture"] },
    id: opaqueIdentifierSchema,
  },
  allOf: [{
    if: { properties: { kind: { const: "operation" } } },
    then: { properties: { id: operationIdentifierSchema } },
  }, {
    if: { properties: { kind: { const: "evidence" } } },
    then: { properties: { id: evidenceIdentifierSchema } },
  }],
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
    schemaVersion: errorSchemaVersion,
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
    schemaVersion: terminalSchemaVersion,
    journeyId: journeyIdentifierSchema,
    status: { enum: ["review_reached", "blocked", "cancelled", "failed"] },
    completedPages: nonNegativeInteger,
    errorCode: { enum: stableErrorCodes },
    factualOutcome: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["source", "result"],
          properties: {
            source: { const: "page_understanding" },
            result: {
              oneOf: ["unknown", "ambiguous"].map((kind) => ({
                type: "object",
                additionalProperties: false,
                required: ["kind", "pageId"],
                properties: {
                  kind: { const: kind },
                  pageId: opaqueIdentifierSchema,
                },
              })),
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["source", "result"],
          properties: {
            source: { const: "answer_resolution" },
            result: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "questionId"],
                  properties: {
                    kind: { const: "profile_answer_missing" },
                    questionId: opaqueIdentifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "fieldId"],
                  properties: {
                    kind: { const: "unsupported" },
                    fieldId: opaqueIdentifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "questionId"],
                  properties: {
                    kind: { const: "option_no_match" },
                    questionId: opaqueIdentifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "questionId"],
                  properties: {
                    kind: { const: "option_ambiguous" },
                    questionId: opaqueIdentifierSchema,
                  },
                },
              ],
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["source", "result"],
          properties: {
            source: { const: "verification" },
            result: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "fieldId", "reason"],
                  properties: {
                    kind: { const: "rejected" },
                    fieldId: opaqueIdentifierSchema,
                    reason: { enum: ["mismatch", "stale"] },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "fieldId"],
                  properties: {
                    kind: { const: "ambiguous" },
                    fieldId: opaqueIdentifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "fieldId"],
                  properties: {
                    kind: { const: "unavailable" },
                    fieldId: opaqueIdentifierSchema,
                  },
                },
              ],
            },
          },
        },
      ],
    },
  },
  allOf: [
    {
      if: { properties: { status: { const: "failed" } } },
      then: { required: ["errorCode"] },
      else: { not: { required: ["errorCode"] } },
    },
    {
      if: { properties: { status: { const: "blocked" } } },
      then: { required: ["factualOutcome"] },
      else: { not: { required: ["factualOutcome"] } },
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
            id: opaqueIdentifierSchema,
            path: nonEmptyString,
            semanticHash: opaqueIdentifierSchema,
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
      schemaVersion: durableJourneyStateSchemaVersion,
      journeyId: journeyIdentifierSchema,
      status: { enum: journeyStatuses },
      pageId: { type: ["string", "null"], minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
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
      eventId: opaqueIdentifierSchema,
      journeyId: journeyIdentifierSchema,
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
      journeyId: journeyIdentifierSchema,
      records: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "component", "phase", "step", "sha256"],
          properties: {
            id: evidenceIdentifierSchema,
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
            sha256: sha256Schema,
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
      schemaVersion: mcpSchemaVersion,
      requestId: opaqueIdentifierSchema,
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
              jobId: opaqueIdentifierSchema,
              resumeId: opaqueIdentifierSchema,
              profileId: opaqueIdentifierSchema,
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
            required: ["journeyId"],
            properties: {
              journeyId: journeyIdentifierSchema,
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
            properties: { journeyId: journeyIdentifierSchema },
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
      schemaVersion: mcpResponseSchemaVersion,
      requestId: opaqueIdentifierSchema,
      ok: { type: "boolean" },
      result: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "operationId", "journeyId"],
            properties: {
              kind: { const: "accepted" },
              operationId: operationIdentifierSchema,
              journeyId: journeyIdentifierSchema,
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
                  journeyId: journeyIdentifierSchema,
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
