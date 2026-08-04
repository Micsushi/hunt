import { stepIds } from "./types.ts";
import { serializedSchemas } from "./serialized.ts";
import {
  s2CommonComponentIds,
  s2CommonPhaseIds,
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "./s2-common-wire.ts";

const s2StableErrorCodes = Object.freeze(
  Object.keys(s2StableErrorPolicy) as S2StableErrorCode[],
);

const version = (value: number) => ({ const: value }) as const;
const closed = <
  const Required extends readonly string[],
  const Properties extends Readonly<Record<string, unknown>>,
>(
  required: Required,
  properties: Properties,
) => ({ type: "object", additionalProperties: false, required, properties }) as const;

const safeIdentifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
} as const;

const kindOnly = (...kinds: readonly string[]) =>
  closed(["kind"], { kind: { enum: kinds } });

const factual = <const Source extends string, const Result>(
  source: Source,
  result: Result,
) =>
  closed(["source", "result"], {
    source: { const: source },
    result,
  });

const targetIdentitySchema = factual("target_identity", {
  oneOf: [
    closed(["kind", "dimension"], {
      kind: { const: "target_mismatch" },
      dimension: { enum: ["host", "tenant", "posting"] },
    }),
    closed(["kind"], { kind: { const: "target_ambiguous" } }),
    closed(["kind", "reason"], {
      kind: { const: "posting_unavailable" },
      reason: { enum: ["not_found", "closed", "removed", "unavailable", "maintenance", "runtime_error"] },
    }),
  ],
});

const newFactualSchemas = [
  targetIdentitySchema,
  factual(
    "account_access",
    closed(["kind", "reason"], {
      kind: { const: "manual_intervention" },
      reason: { enum: ["captcha", "mfa", "access_control"] },
    }),
  ),
  factual(
    "mailbox_verification",
    kindOnly(
      "mailbox_none",
      "mailbox_ambiguous",
      "mailbox_expired",
      "mailbox_consumed",
    ),
  ),
  factual(
    "verification_navigation",
    kindOnly("verification_target_unavailable"),
  ),
  factual(
    "ats_family",
    kindOnly("ats_unsupported", "ats_unknown", "ats_ambiguous"),
  ),
  factual(
    "workday_page_type",
    kindOnly("workday_page_unknown", "workday_page_ambiguous"),
  ),
  factual("ui_behavior", {
    oneOf: [
      kindOnly("ui_behavior_unknown", "ui_behavior_ambiguous"),
      closed(["kind", "variantId"], {
        kind: { const: "ui_variant_unreviewed" },
        variantId: safeIdentifierSchema,
      }),
    ],
  }),
  factual(
    "question_classification",
    kindOnly("question_unknown", "question_ambiguous"),
  ),
  factual(
    "answer_resolution",
    closed(["kind", "questionId"], {
      kind: { enum: ["answer_type_unknown", "answer_type_ambiguous"] },
      questionId: safeIdentifierSchema,
    }),
  ),
] as const;

const terminalResultV4Schema = {
  ...closed(
    ["schemaVersion", "journeyId", "status", "completedPages"],
    {
      schemaVersion: version(4),
      journeyId: serializedSchemas.terminalResult.properties.journeyId,
      status: serializedSchemas.terminalResult.properties.status,
      completedPages: serializedSchemas.terminalResult.properties.completedPages,
      errorCode: { enum: s2StableErrorCodes },
      factualOutcome: {
        oneOf: [
          ...serializedSchemas.terminalResult.properties.factualOutcome.oneOf,
          ...newFactualSchemas,
        ],
      },
    },
  ),
  allOf: serializedSchemas.terminalResult.allOf,
} as const;

const verifiedCauseV3Schema = closed(
  ["verification", "code", "source"],
  {
    verification: { const: "verified" },
    code: { enum: s2StableErrorCodes },
    source: serializedSchemas.errorEnvelope.properties.source,
  },
);

const errorEnvelopeV3Schema = {
  ...closed(
    ["schemaVersion", "code", "component", "phase", "step", "retryable", "source"],
    {
      schemaVersion: version(3),
      code: { enum: s2StableErrorCodes },
      component: { enum: s2CommonComponentIds },
      phase: { enum: s2CommonPhaseIds },
      step: { enum: stepIds },
      retryable: { type: "boolean" },
      source: serializedSchemas.errorEnvelope.properties.source,
      cause: verifiedCauseV3Schema,
    },
  ),
  allOf: Object.entries(s2StableErrorPolicy).map(([code, policy]) => ({
    if: { properties: { code: { const: code } } },
    then: {
      properties: {
        component: { const: policy.owner },
        retryable: { const: policy.retryable },
      },
    },
  })),
} as const;

const eventEnvelopeV3Schema = closed(
  ["schemaVersion", "eventId", "journeyId", "component", "phase", "step", "kind", "at", "source"],
  {
    ...serializedSchemas.eventEnvelope.properties,
    schemaVersion: version(3),
    component: { enum: s2CommonComponentIds },
    phase: { enum: s2CommonPhaseIds },
  },
);

const mcpResultV4Schemas = [
  serializedSchemas.mcpResponse.properties.result.oneOf[0],
  serializedSchemas.mcpResponse.properties.result.oneOf[1],
  closed(["kind", "terminal"], {
    kind: { const: "terminal" },
    terminal: terminalResultV4Schema,
  }),
] as const;

const mcpResponseV4Schema = {
  ...closed(
    ["schemaVersion", "requestId", "ok"],
    {
      schemaVersion: version(4),
      requestId: serializedSchemas.mcpResponse.properties.requestId,
      ok: { type: "boolean" },
      result: { oneOf: mcpResultV4Schemas },
      error: errorEnvelopeV3Schema,
    },
  ),
  oneOf: serializedSchemas.mcpResponse.oneOf,
} as const;

export const s2CommonWireSchemas = {
  terminalResult: terminalResultV4Schema,
  mcpResponse: mcpResponseV4Schema,
  errorEnvelope: errorEnvelopeV3Schema,
  eventEnvelope: eventEnvelopeV3Schema,
} as const;
