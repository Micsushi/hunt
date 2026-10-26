import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ClassificationId,
  SanitizedStructuralObservationV1,
} from "../../../../src/contracts/live/index.ts";
import {
  LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
  LIVE_ENTRY_TRAITS,
  createLiveAtsFamilyClassifier,
  createLiveWorkdayPageTypeClassifier,
} from "../../../../src/ats/workday/live/index.ts";
import {
  parseAtsFamilyClassificationResult,
  parseWorkdayPageTypeClassificationResult,
} from "../../../../src/contracts/live/index.ts";

const signal = new AbortController().signal;

test("ATS family classification uses only the sanitized structural observation", async () => {
  const classifier = createLiveAtsFamilyClassifier();
  const classified = await classifier.classify({
    schemaVersion: 1,
    observation: observation("ats_family", [LIVE_ENTRY_TRAITS.ats.workday]),
  }, signal);
  assert.equal(classified.ok && classified.value.kind, "classified");
  if (!classified.ok || classified.value.kind !== "classified") return;
  assert.equal(classified.value.atsFamily, "workday");
  assert.equal(classified.value.sourceRevisionId, LIVE_ENTRY_CLASSIFICATION_REVISION_ID);

  const unsupported = await classifier.classify({
    schemaVersion: 1,
    observation: observation("ats_family", [LIVE_ENTRY_TRAITS.ats.nonWorkday]),
  }, signal);
  assert.equal(unsupported.ok && unsupported.value.kind, "ats_unsupported");

  const unknown = await classifier.classify({
    schemaVersion: 1,
    observation: observation("ats_family", [LIVE_ENTRY_TRAITS.neutral]),
  }, signal);
  assert.equal(unknown.ok && unknown.value.kind, "ats_unknown");

  const ambiguous = await classifier.classify({
    schemaVersion: 1,
    observation: observation("ats_family", [
      LIVE_ENTRY_TRAITS.ats.workday,
      LIVE_ENTRY_TRAITS.ats.nonWorkday,
    ]),
  }, signal);
  assert.equal(ambiguous.ok && ambiguous.value.kind, "ats_ambiguous");
});

test("all seven exact Workday page types classify independently", async () => {
  const classifier = createLiveWorkdayPageTypeClassifier();
  const atsFamilyClassificationId = "classification_aaaaaaaaaaaaaaaa" as ClassificationId;
  for (const [pageType, traitId] of Object.entries(LIVE_ENTRY_TRAITS.pages)) {
    const result = await classifier.classify({
      schemaVersion: 1,
      atsFamilyClassificationId,
      observation: observation(
        "workday_page_type",
        [traitId],
        [{ layer: "ats_family", classificationId: atsFamilyClassificationId }],
      ),
    }, signal);
    assert.equal(result.ok && result.value.kind, "classified", pageType);
    if (result.ok && result.value.kind === "classified") {
      assert.equal(result.value.pageType, pageType);
      assert.equal(result.value.sourceRevisionId, LIVE_ENTRY_CLASSIFICATION_REVISION_ID);
    }
  }
});

test("page classification preserves exact unknown and ambiguous facts", async () => {
  const classifier = createLiveWorkdayPageTypeClassifier();
  const atsFamilyClassificationId = "classification_aaaaaaaaaaaaaaaa" as ClassificationId;
  const base = {
    schemaVersion: 1 as const,
    atsFamilyClassificationId,
  };
  const unknown = await classifier.classify({
    ...base,
    observation: observation(
      "workday_page_type",
      [LIVE_ENTRY_TRAITS.neutral],
      [{ layer: "ats_family", classificationId: atsFamilyClassificationId }],
    ),
  }, signal);
  assert.equal(unknown.ok && unknown.value.kind, "workday_page_unknown");

  const ambiguous = await classifier.classify({
    ...base,
    observation: observation(
      "workday_page_type",
      [LIVE_ENTRY_TRAITS.pages.profile, LIVE_ENTRY_TRAITS.pages.review],
      [{ layer: "ats_family", classificationId: atsFamilyClassificationId }],
    ),
  }, signal);
  assert.equal(ambiguous.ok && ambiguous.value.kind, "workday_page_ambiguous");
});

test("every live classifier output conforms to the frozen result parsers", async () => {
  const ats = createLiveAtsFamilyClassifier();
  for (const traits of [
    [LIVE_ENTRY_TRAITS.ats.workday],
    [LIVE_ENTRY_TRAITS.ats.nonWorkday],
    [LIVE_ENTRY_TRAITS.neutral],
    [LIVE_ENTRY_TRAITS.ats.workday, LIVE_ENTRY_TRAITS.ats.nonWorkday],
  ]) {
    const result = await ats.classify({
      schemaVersion: 1,
      observation: observation("ats_family", traits),
    }, signal);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(parseAtsFamilyClassificationResult(result.value), result.value);
  }
  const atsFamilyClassificationId = "classification_aaaaaaaaaaaaaaaa" as ClassificationId;
  const pages = createLiveWorkdayPageTypeClassifier();
  for (const traits of [
    ...Object.values(LIVE_ENTRY_TRAITS.pages).map((trait) => [trait]),
    [LIVE_ENTRY_TRAITS.neutral],
    [LIVE_ENTRY_TRAITS.pages.profile, LIVE_ENTRY_TRAITS.pages.review],
  ]) {
    const result = await pages.classify({
      schemaVersion: 1,
      atsFamilyClassificationId,
      observation: observation("workday_page_type", traits, [
        { layer: "ats_family", classificationId: atsFamilyClassificationId },
      ]),
    }, signal);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(parseWorkdayPageTypeClassificationResult(result.value), result.value);
  }
});

function observation(
  layer: "ats_family",
  traitIds: readonly string[],
  parentLineage?: SanitizedStructuralObservationV1["parentLineage"],
): SanitizedStructuralObservationV1 & { readonly layer: "ats_family" };
function observation(
  layer: "workday_page_type",
  traitIds: readonly string[],
  parentLineage: SanitizedStructuralObservationV1["parentLineage"],
): SanitizedStructuralObservationV1 & { readonly layer: "workday_page_type" };
function observation(
  layer: "ats_family" | "workday_page_type",
  traitIds: readonly string[],
  parentLineage: SanitizedStructuralObservationV1["parentLineage"] = [],
): SanitizedStructuralObservationV1 {
  return {
    schemaVersion: 1,
    observationId: "structural_observation_0123456789abcdef" as never,
    layer,
    sourceRevisionId: LIVE_ENTRY_CLASSIFICATION_REVISION_ID,
    parentLineage,
    traitIds: traitIds as SanitizedStructuralObservationV1["traitIds"],
    observedVariantId: null,
    controlCount: 1,
    requiredControlCount: 0,
    optionCount: 0,
  };
}
