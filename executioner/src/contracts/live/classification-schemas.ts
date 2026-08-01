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

const structuralFields = {
  observationId: opaqueIdentifier("structural_observation"),
  layer: { enum: classificationLayers },
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
  answer_type: [
    "answer_type_unknown",
    "answer_type_ambiguous",
    "profile_answer_missing",
  ],
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

const factual = (kinds: readonly string[]) =>
  versioned(["kind"], { kind: { enum: kinds } });

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
      versioned(["kind", "variantId"], {
        kind: { const: "ui_variant_unreviewed" },
        variantId: opaqueIdentifier("ui_variant"),
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
      versioned(["kind", "questionId", "answerType", "provenance"], {
        kind: { const: "classified" },
        questionId: boundedIdentifier,
        answerType: { enum: canonicalAnswerTypes },
        provenance: versioned(
          ["provenanceId", "source", "sourceRevisionId"],
          {
            provenanceId: opaqueIdentifier("answer_provenance"),
            source: { enum: answerProvenanceSources },
            sourceRevisionId: opaqueIdentifier("answer_source_revision"),
          },
        ),
      }),
      versioned(["kind", "questionId"], {
        kind: {
          enum: [
            "answer_type_unknown",
            "answer_type_ambiguous",
            "profile_answer_missing",
          ],
        },
        questionId: boundedIdentifier,
      }),
    ],
  },
  visibleOptionMapping: {
    oneOf: [
      versioned(
        ["kind", "questionId", "optionId", "sourceRevisionId"],
        {
          kind: { const: "mapped" },
          questionId: boundedIdentifier,
          optionId: boundedIdentifier,
          sourceRevisionId: opaqueIdentifier("classification_revision"),
        },
      ),
      versioned(["kind", "questionId"], {
        kind: { enum: ["option_no_match", "option_ambiguous"] },
        questionId: boundedIdentifier,
      }),
    ],
  },
  sanitizedStructuralObservation: {
    ...versioned(
      [
        "observationId",
        "layer",
        "parentLineage",
        "traitIds",
        "observedVariantId",
      ],
      structuralFields,
    ),
    allOf: layerConstraints(false),
  },
  sanitizedUnknownCandidate: {
    ...versioned(
      [
        "candidateId",
        "observationId",
        "layer",
        "outcome",
        "parentLineage",
        "traitIds",
        "observedVariantId",
      ],
      {
        candidateId: opaqueIdentifier("unknown_candidate"),
        ...structuralFields,
        outcome: {
          enum: Object.values(outcomesByLayer).flat(),
        },
      },
    ),
    allOf: layerConstraints(true),
  },
  reviewedPromotionRecord: {
    ...versioned(
      [
        "promotionId",
        "candidateId",
        "layer",
        "scope",
        "sourceRevisionId",
        "decision",
        "acceptedRevisionId",
      ],
      {
        promotionId: opaqueIdentifier("promotion"),
        candidateId: opaqueIdentifier("unknown_candidate"),
        layer: { enum: classificationLayers },
        scope: { const: "between_runs" },
        sourceRevisionId: opaqueIdentifier("classification_revision"),
        decision: { enum: ["accepted", "rejected"] },
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
            acceptedRevisionId: opaqueIdentifier("classification_revision"),
          },
        },
      },
      {
        if: { properties: { decision: { const: "rejected" } } },
        then: { properties: { acceptedRevisionId: { type: "null" } } },
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
