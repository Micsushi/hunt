import { uiBehaviorIds } from "../types.ts";
import {
  answerProvenanceSources,
  canonicalAnswerTypes,
  workdayPageTypes,
} from "./classification.ts";
import { classificationLayers } from "./learning.ts";

function opaqueIdentifier(prefix: string) {
  return {
    type: "string",
    minLength: prefix.length + 17,
    maxLength: prefix.length + 65,
    pattern: `^${prefix}_[A-Za-z0-9_-]{16,64}$`,
  } as const;
}

function closed(
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  } as const;
}

function versioned(
  required: readonly string[],
  properties: Readonly<Record<string, unknown>>,
) {
  return closed(["schemaVersion", ...required], {
    schemaVersion: { const: 1 },
    ...properties,
  });
}

const boundedIdentifier = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
} as const;

const lineageEntry = closed(["layer", "classificationId"], {
  layer: { enum: classificationLayers },
  classificationId: opaqueIdentifier("classification"),
});

const structuralCount = {
  type: "integer",
  minimum: 0,
  maximum: 64,
} as const;

const structuralFields = {
  observationId: opaqueIdentifier("structural_observation"),
  layer: { enum: classificationLayers },
  sourceRevisionId: opaqueIdentifier("classification_revision"),
  parentLineage: {
    type: "array",
    maxItems: 5,
    items: lineageEntry,
  },
  traitIds: {
    type: "array",
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
    items: opaqueIdentifier("structural_trait"),
  },
  observedVariantId: {
    oneOf: [opaqueIdentifier("ui_variant"), { type: "null" }],
  },
  controlCount: structuralCount,
  requiredControlCount: structuralCount,
  optionCount: structuralCount,
} as const;

const outcomesByLayer = {
  ats_family: ["ats_unsupported", "ats_unknown", "ats_ambiguous"],
  workday_page_type: ["workday_page_unknown", "workday_page_ambiguous"],
  ui_behavior: [
    "ui_behavior_unknown",
    "ui_behavior_ambiguous",
    "ui_variant_unreviewed",
  ],
  question: ["question_unknown", "question_ambiguous"],
  answer_type: ["answer_type_unknown", "answer_type_ambiguous"],
  visible_option: ["option_no_match", "option_ambiguous"],
} as const;

function layerConstraints(includeOutcome: boolean) {
  return classificationLayers.map((layer, index) => ({
    if: { properties: { layer: { const: layer } } },
    then: {
      properties: {
        parentLineage: {
          minItems: index,
          maxItems: index,
          prefixItems: classificationLayers.slice(0, index).map(
            (parentLayer) => ({
              properties: { layer: { const: parentLayer } },
            }),
          ),
        },
        observedVariantId:
          layer === "ui_behavior"
            ? {
                oneOf: [
                  opaqueIdentifier("ui_variant"),
                  { type: "null" },
                ],
              }
            : { type: "null" },
        ...(includeOutcome
          ? { outcome: { enum: outcomesByLayer[layer] } }
          : {}),
      },
    },
  }));
}

const requiredControlCountConstraints = Array.from(
  { length: 65 },
  (_, requiredControlCount) => ({
    if: {
      properties: {
        requiredControlCount: { const: requiredControlCount },
      },
    },
    then: {
      properties: {
        controlCount: { minimum: requiredControlCount },
      },
    },
  }),
);

const factual = (kinds: readonly string[]) =>
  versioned(["kind", "sourceRevisionId"], {
    kind: { enum: kinds },
    sourceRevisionId: opaqueIdentifier("classification_revision"),
  });

const classifiedCommon = {
  kind: { const: "classified" },
  classificationId: opaqueIdentifier("classification"),
  sourceRevisionId: opaqueIdentifier("classification_revision"),
} as const;

export const liveClassificationSchemas = {
  atsFamilyClassification: {
    oneOf: [
      versioned(
        ["kind", "atsFamily", "classificationId", "sourceRevisionId"],
        { ...classifiedCommon, atsFamily: { const: "workday" } },
      ),
      versioned(["kind", "familyId", "sourceRevisionId"], {
        kind: { const: "ats_unsupported" },
        familyId: opaqueIdentifier("ats_family"),
        sourceRevisionId: opaqueIdentifier("classification_revision"),
      }),
      factual(["ats_unknown", "ats_ambiguous"]),
    ],
  },
  workdayPageTypeClassification: {
    oneOf: [
      versioned(
        ["kind", "pageType", "classificationId", "sourceRevisionId"],
        { ...classifiedCommon, pageType: { enum: workdayPageTypes } },
      ),
      factual(["workday_page_unknown", "workday_page_ambiguous"]),
    ],
  },
  uiBehaviorClassification: {
    oneOf: [
      versioned(
        [
          "kind",
          "behavior",
          "reviewedVariantId",
          "classificationId",
          "sourceRevisionId",
        ],
        {
          ...classifiedCommon,
          behavior: { enum: uiBehaviorIds },
          reviewedVariantId: opaqueIdentifier("ui_variant"),
        },
      ),
      factual(["ui_behavior_unknown", "ui_behavior_ambiguous"]),
      versioned(["kind", "variantId", "sourceRevisionId"], {
        kind: { const: "ui_variant_unreviewed" },
        variantId: opaqueIdentifier("ui_variant"),
        sourceRevisionId: opaqueIdentifier("classification_revision"),
      }),
    ],
  },
  questionClassification: {
    oneOf: [
      versioned(
        ["kind", "questionId", "classificationId", "sourceRevisionId"],
        { ...classifiedCommon, questionId: boundedIdentifier },
      ),
      factual(["question_unknown", "question_ambiguous"]),
    ],
  },
  canonicalAnswerTypeClassification: {
    oneOf: [
      versioned(
        [
          "kind",
          "answerType",
          "classificationId",
          "sourceRevisionId",
          "provenance",
        ],
        {
        kind: { const: "classified" },
        answerType: { enum: canonicalAnswerTypes },
        classificationId: opaqueIdentifier("classification"),
        sourceRevisionId: opaqueIdentifier("classification_revision"),
        provenance: versioned(
          ["provenanceId", "source", "sourceRevisionId"],
          {
            provenanceId: opaqueIdentifier("answer_provenance"),
            source: { enum: answerProvenanceSources },
            sourceRevisionId: opaqueIdentifier("answer_source_revision"),
          },
        ),
        },
      ),
      factual([
        "answer_type_unknown",
        "answer_type_ambiguous",
        "profile_answer_missing",
      ]),
    ],
  },
  visibleOptionMapping: {
    oneOf: [
      versioned(
        ["kind", "optionId", "classificationId", "sourceRevisionId"],
        {
          kind: { const: "mapped" },
          optionId: boundedIdentifier,
          classificationId: opaqueIdentifier("classification"),
          sourceRevisionId: opaqueIdentifier("classification_revision"),
        },
      ),
      factual(["option_no_match", "option_ambiguous"]),
    ],
  },
  sanitizedStructuralObservation: {
    ...versioned(
      [
        "observationId",
        "layer",
        "sourceRevisionId",
        "parentLineage",
        "traitIds",
        "observedVariantId",
        "controlCount",
        "requiredControlCount",
        "optionCount",
      ],
      structuralFields,
    ),
    allOf: [...layerConstraints(false), ...requiredControlCountConstraints],
  },
  sanitizedUnknownCandidate: {
    ...versioned(
      [
        "candidateId",
        "observationId",
        "layer",
        "outcome",
        "sourceRevisionId",
        "parentLineage",
        "traitIds",
        "observedVariantId",
        "controlCount",
        "requiredControlCount",
        "optionCount",
      ],
      {
        candidateId: opaqueIdentifier("unknown_candidate"),
        ...structuralFields,
        outcome: {
          enum: Object.values(outcomesByLayer).flat(),
        },
      },
    ),
    allOf: [...layerConstraints(true), ...requiredControlCountConstraints],
  },
  reviewedPromotionRecord: {
    ...versioned(
      [
        "promotionId",
        "candidateId",
        "layer",
        "scope",
        "reviewerDecisionId",
        "reviewedFixtureIds",
        "testEvidenceIds",
        "sourceRevisionId",
        "decision",
        "sourceChangeId",
        "acceptedRevisionId",
      ],
      {
        promotionId: opaqueIdentifier("promotion"),
        candidateId: opaqueIdentifier("unknown_candidate"),
        layer: { enum: classificationLayers },
        scope: { const: "between_runs" },
        reviewerDecisionId: opaqueIdentifier("reviewer_decision"),
        reviewedFixtureIds: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: opaqueIdentifier("reviewed_fixture"),
        },
        testEvidenceIds: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: opaqueIdentifier("test_evidence"),
        },
        sourceRevisionId: opaqueIdentifier("classification_revision"),
        decision: { enum: ["accepted", "rejected"] },
        sourceChangeId: {
          oneOf: [opaqueIdentifier("source_change"), { type: "null" }],
        },
        acceptedRevisionId: {
          oneOf: [
            opaqueIdentifier("classification_revision"),
            { type: "null" },
          ],
        },
      },
    ),
    allOf: [
      {
        if: { properties: { decision: { const: "accepted" } } },
        then: {
          properties: {
            sourceChangeId: opaqueIdentifier("source_change"),
            acceptedRevisionId: opaqueIdentifier("classification_revision"),
          },
        },
      },
      {
        if: { properties: { decision: { const: "rejected" } } },
        then: {
          properties: {
            sourceChangeId: { type: "null" },
            acceptedRevisionId: { type: "null" },
          },
        },
      },
    ],
  },
} as const;

export const liveClassificationVersions = {
  atsFamilyClassification: 1,
  workdayPageTypeClassification: 1,
  uiBehaviorClassification: 1,
  questionClassification: 1,
  canonicalAnswerTypeClassification: 1,
  visibleOptionMapping: 1,
  sanitizedStructuralObservation: 1,
  sanitizedUnknownCandidate: 1,
  reviewedPromotionRecord: 1,
} as const;
