import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContractParseError,
  liveClassificationSchemas,
  parseSanitizedStructuralObservation,
  parseSanitizedUnknownCandidate,
} from "../../../src/contracts/index.ts";

const parentLineage = [
  { layer: "ats_family", classificationId: "classification_atsfamily00000000" },
  { layer: "workday_page_type", classificationId: "classification_pagetype000000000" },
  { layer: "ui_behavior", classificationId: "classification_uibehavior0000000" },
] as const;

const observation = {
  schemaVersion: 1,
  observationId: "structural_observation_0123456789abcdef",
  layer: "question",
  sourceRevisionId: "classification_revision_0123456789abcdef",
  parentLineage,
  traitIds: ["structural_trait_0123456789abcdef", "structural_trait_fedcba9876543210"],
  observedVariantId: null,
  controlCount: 4,
  requiredControlCount: 2,
  optionCount: 5,
} as const;

const candidate = {
  schemaVersion: 1,
  candidateId: "unknown_candidate_0123456789abcdef",
  observationId: observation.observationId,
  layer: observation.layer,
  outcome: "question_unknown",
  sourceRevisionId: observation.sourceRevisionId,
  parentLineage,
  traitIds: observation.traitIds,
  observedVariantId: null,
  controlCount: observation.controlCount,
  requiredControlCount: observation.requiredControlCount,
  optionCount: observation.optionCount,
} as const;

function expectInvalid(run: () => unknown, path?: string): void {
  assert.throws(run, (error: unknown) =>
    error instanceof ContractParseError &&
    (path === undefined || error.path === path));
}

test("sanitized observations and unknown candidates preserve only closed structural IDs", () => {
  assert.deepEqual(parseSanitizedStructuralObservation(observation), observation);
  assert.deepEqual(parseSanitizedUnknownCandidate(candidate), candidate);

  const uiObservation = {
    ...observation,
    layer: "ui_behavior",
    parentLineage: parentLineage.slice(0, 2),
    observedVariantId: "ui_variant_0123456789abcdef",
  } as const;
  assert.deepEqual(parseSanitizedStructuralObservation(uiObservation), uiObservation);
});

test("published schemas encode every layer's lineage and outcome constraints", () => {
  assert.equal(liveClassificationSchemas.sanitizedStructuralObservation.additionalProperties, false);
  assert.equal(liveClassificationSchemas.sanitizedUnknownCandidate.additionalProperties, false);
  assert.equal(liveClassificationSchemas.sanitizedStructuralObservation.allOf.length, 71);
  assert.equal(liveClassificationSchemas.sanitizedUnknownCandidate.allOf.length, 71);
  assert.deepEqual(
    liveClassificationSchemas.sanitizedUnknownCandidate.allOf.slice(0, 6).map(
      ({ if: condition }) =>
        "layer" in condition.properties
          ? condition.properties.layer.const
          : null,
    ),
    ["ats_family", "workday_page_type", "ui_behavior", "question", "answer_type", "visible_option"],
  );
});

test("layer outcomes, parent order, unique traits, and UI-only variants fail closed", () => {
  expectInvalid(() => parseSanitizedStructuralObservation({ ...observation, parentLineage: parentLineage.slice(0, 2) }), "$.parentLineage");
  expectInvalid(() => parseSanitizedStructuralObservation({ ...observation, parentLineage: [...parentLineage].reverse() }), "$.parentLineage[0].layer");
  expectInvalid(() => parseSanitizedStructuralObservation({ ...observation, traitIds: [observation.traitIds[0], observation.traitIds[0]] }), "$.traitIds[1]");
  expectInvalid(() => parseSanitizedStructuralObservation({ ...observation, observedVariantId: "ui_variant_0123456789abcdef" }), "$.observedVariantId");
  expectInvalid(() => parseSanitizedUnknownCandidate({ ...candidate, outcome: "ui_behavior_unknown" }), "$.outcome");
  expectInvalid(() => parseSanitizedUnknownCandidate({ ...candidate, layer: "answer_type", outcome: "answer_type_unknown" }), "$.parentLineage");
});

test("proxies, accessors, raw fields, and hash-derived fields are rejected without reading them", () => {
  let reads = 0;
  const accessor = { ...candidate } as Record<string, unknown>;
  Object.defineProperty(accessor, "rawText", { enumerable: true, get() { reads += 1; return "private"; } });
  expectInvalid(() => parseSanitizedUnknownCandidate(accessor));
  assert.equal(reads, 0);

  const proxy = new Proxy(candidate, { get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver); } });
  expectInvalid(() => parseSanitizedUnknownCandidate(proxy));
  assert.equal(reads, 0);

  for (const key of [
    "url", "origin", "path", "selector", "dom", "html", "text", "label",
    "option", "answer", "value", "token", "message", "recipient", "credential",
    "contentHash", "urlHash", "selectorDigest",
  ]) {
    expectInvalid(() => parseSanitizedUnknownCandidate({ ...candidate, [key]: "private" }), `$.${key}`);
  }
});
