import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { ClassificationLayer, SanitizedStructuralObservationV1 } from "../../../src/contracts/live/index.ts";
import { runClassificationSkeleton, type ClassificationSkeletonDependencies } from "../../../src/control/orchestrator/live/index.ts";

const revision = "classification_revision_0123456789abcdef" as never;
const ids = {
  ats: "classification_atsfamily00000000",
  page: "classification_pagetype000000000",
  ui: "classification_uibehavior0000000",
  question: "classification_question00000000",
  answer: "classification_answer0000000000",
} as const;
const layers = ["ats_family", "workday_page_type", "ui_behavior", "question", "answer_type", "visible_option"] as const;

function observation(layer: ClassificationLayer, index: number): SanitizedStructuralObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `structural_observation_${index.toString().padStart(16, "0")}` as never,
    layer,
    sourceRevisionId: revision,
    parentLineage: layers.slice(0, index).map((parent, parentIndex) => ({
      layer: parent,
      classificationId: Object.values(ids)[parentIndex] as never,
    })),
    traitIds: [`structural_trait_${index.toString().padStart(16, "0")}` as never],
    observedVariantId: layer === "ui_behavior" ? "ui_variant_0123456789abcdef" as never : null,
    controlCount: index + 1,
    requiredControlCount: index,
    optionCount: index === 5 ? 3 : 0,
  };
}

function input() {
  return {
    schemaVersion: 1 as const,
    observations: {
      atsFamily: observation("ats_family", 0) as SanitizedStructuralObservationV1 & { layer: "ats_family" },
      pageType: observation("workday_page_type", 1) as SanitizedStructuralObservationV1 & { layer: "workday_page_type" },
      uiBehavior: observation("ui_behavior", 2) as SanitizedStructuralObservationV1 & { layer: "ui_behavior" },
      question: observation("question", 3) as SanitizedStructuralObservationV1 & { layer: "question" },
      answerType: observation("answer_type", 4) as SanitizedStructuralObservationV1 & { layer: "answer_type" },
      visibleOption: observation("visible_option", 5) as SanitizedStructuralObservationV1 & { layer: "visible_option" },
    },
    canonicalOptionId: "option-country-us" as never,
    visibleOptionIds: ["option-country-us" as never],
  };
}

type StopKind =
  | "ats_unsupported" | "ats_unknown" | "ats_ambiguous"
  | "workday_page_unknown" | "workday_page_ambiguous"
  | "ui_behavior_unknown" | "ui_behavior_ambiguous" | "ui_variant_unreviewed"
  | "question_unknown" | "question_ambiguous"
  | "answer_type_unknown" | "answer_type_ambiguous" | "profile_answer_missing"
  | "option_no_match" | "option_ambiguous" | "answer_provenance_invalid";

function dependencies(stop?: StopKind, cancelAt?: ClassificationLayer) {
  const calls: string[] = [];
  let allocations = 0;
  const cancelled = { ok: false as const, error: { code: "operation_cancelled" as const, retryable: false as const } };
  const check = (signal: AbortSignal) => signal.aborted ? cancelled : undefined;
  return {
    calls,
    get allocations() { return allocations; },
    ports: {
      atsFamily: { async classify(_request: unknown, signal: AbortSignal) {
        calls.push("ats_family"); const aborted = check(signal); if (aborted || cancelAt === "ats_family") return aborted ?? cancelled;
        if (stop?.startsWith("ats_")) return { ok: true as const, value: stop === "ats_unsupported"
          ? { schemaVersion: 1 as const, kind: stop, familyId: "ats_family_other00000000000" as never, sourceRevisionId: revision }
          : { schemaVersion: 1 as const, kind: stop, sourceRevisionId: revision } };
        return { ok: true as const, value: { schemaVersion: 1 as const, kind: "classified" as const, atsFamily: "workday" as const, classificationId: ids.ats as never, sourceRevisionId: revision } };
      } },
      pageType: { async classify(_request: unknown, signal: AbortSignal) {
        calls.push("workday_page_type"); const aborted = check(signal); if (aborted || cancelAt === "workday_page_type") return aborted ?? cancelled;
        if (stop?.startsWith("workday_page_")) return { ok: true as const, value: { schemaVersion: 1 as const, kind: stop, sourceRevisionId: revision } };
        return { ok: true as const, value: { schemaVersion: 1 as const, kind: "classified" as const, pageType: "questionnaire" as const, classificationId: ids.page as never, sourceRevisionId: revision } };
      } },
      uiBehavior: { async classify(_request: unknown, signal: AbortSignal) {
        calls.push("ui_behavior"); const aborted = check(signal); if (aborted || cancelAt === "ui_behavior") return aborted ?? cancelled;
        if (stop?.startsWith("ui_")) return { ok: true as const, value: stop === "ui_variant_unreviewed"
          ? { schemaVersion: 1 as const, kind: stop, variantId: "ui_variant_0123456789abcdef" as never, sourceRevisionId: revision }
          : { schemaVersion: 1 as const, kind: stop, sourceRevisionId: revision } };
        return { ok: true as const, value: { schemaVersion: 1 as const, kind: "classified" as const, behavior: "text" as never, reviewedVariantId: "ui_variant_0123456789abcdef" as never, classificationId: ids.ui as never, sourceRevisionId: revision } };
      } },
      question: { async classify(_request: unknown, signal: AbortSignal) {
        calls.push("question"); const aborted = check(signal); if (aborted || cancelAt === "question") return aborted ?? cancelled;
        if (stop?.startsWith("question_")) return { ok: true as const, value: { schemaVersion: 1 as const, kind: stop, sourceRevisionId: revision } };
        return { ok: true as const, value: { schemaVersion: 1 as const, kind: "classified" as const, questionId: "question-country" as never, classificationId: ids.question as never, sourceRevisionId: revision } };
      } },
      answerType: { async classify(_request: unknown, signal: AbortSignal) {
        calls.push("answer_type"); const aborted = check(signal); if (aborted || cancelAt === "answer_type") return aborted ?? cancelled;
        if (stop === "answer_provenance_invalid") return { ok: false as const, error: { code: stop, retryable: false as const } };
        if (stop?.startsWith("answer_type_") || stop === "profile_answer_missing") return { ok: true as const, value: { schemaVersion: 1 as const, kind: stop, sourceRevisionId: revision } };
        return { ok: true as const, value: { schemaVersion: 1 as const, kind: "classified" as const, answerType: "single_choice" as const, classificationId: ids.answer as never, sourceRevisionId: revision, provenance: { schemaVersion: 1 as const, provenanceId: "answer_provenance_0123456789abcdef" as never, source: "profile" as const, sourceRevisionId: "answer_source_revision_0123456789abcdef" as never } } };
      } },
      visibleOption: { async map(_request: unknown, signal: AbortSignal) {
        calls.push("visible_option"); const aborted = check(signal); if (aborted || cancelAt === "visible_option") return aborted ?? cancelled;
        if (stop?.startsWith("option_")) return { ok: true as const, value: { schemaVersion: 1 as const, kind: stop, sourceRevisionId: revision } };
        return { ok: true as const, value: { schemaVersion: 1 as const, kind: "mapped" as const, optionId: "option-country-us" as never, classificationId: "classification_option0000000000" as never, sourceRevisionId: revision } };
      } },
      allocateCandidateId() { allocations += 1; return `unknown_candidate_${allocations.toString().padStart(16, "0")}` as never; },
    } as ClassificationSkeletonDependencies,
  };
}

const structuralStops: readonly StopKind[] = [
  "ats_unsupported", "ats_unknown", "ats_ambiguous",
  "workday_page_unknown", "workday_page_ambiguous",
  "ui_behavior_unknown", "ui_behavior_ambiguous", "ui_variant_unreviewed",
  "question_unknown", "question_ambiguous",
  "answer_type_unknown", "answer_type_ambiguous",
  "option_no_match", "option_ambiguous",
];

test("every structural stop emits one exact sanitized candidate and suppresses downstream classifiers", async () => {
  for (const stop of structuralStops) {
    const fixture = dependencies(stop);
    const sourceInput = input();
    const before = JSON.stringify(sourceInput);
    const result = await runClassificationSkeleton(fixture.ports, sourceInput, new AbortController().signal);
    assert.equal(result.ok, true, stop);
    if (!result.ok || result.value.kind !== "blocked" || result.value.candidate === undefined) continue;
    assert.equal(result.value.candidate.outcome, stop, stop);
    const candidate = result.value.candidate;
    const source = Object.values(sourceInput.observations).find(({ layer }) => layer === candidate.layer);
    assert.deepEqual(candidate, {
      schemaVersion: 1,
      candidateId: candidate.candidateId,
      observationId: source?.observationId,
      layer: source?.layer,
      outcome: stop,
      sourceRevisionId: source?.sourceRevisionId,
      parentLineage: source?.parentLineage,
      traitIds: source?.traitIds,
      observedVariantId: source?.observedVariantId,
      controlCount: source?.controlCount,
      requiredControlCount: source?.requiredControlCount,
      optionCount: source?.optionCount,
    }, stop);
    assert.equal(fixture.allocations, 1, stop);
    assert.equal(JSON.stringify(sourceInput), before, stop);
    const stopIndex = fixture.calls.indexOf(candidate.layer);
    assert.equal(fixture.calls.length, stopIndex + 1, stop);
  }
});

test("missing profile and provenance failures never become learning candidates", async () => {
  const missing = dependencies("profile_answer_missing");
  const blocked = await runClassificationSkeleton(missing.ports, input(), new AbortController().signal);
  assert.equal(blocked.ok, true);
  if (blocked.ok && blocked.value.kind === "blocked") {
    assert.equal("candidate" in blocked.value, false);
    assert.deepEqual(blocked.value.factualOutcome, { source: "answer_resolution", result: { kind: "profile_answer_missing", questionId: "question-country" } });
  }
  assert.equal(missing.allocations, 0);

  const invalid = dependencies("answer_provenance_invalid");
  const failed = await runClassificationSkeleton(invalid.ports, input(), new AbortController().signal);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "answer_provenance_invalid");
  assert.equal(invalid.allocations, 0);
});

test("cancellation at every classifier boundary stops without candidates or downstream work", async () => {
  for (const layer of layers) {
    const fixture = dependencies(undefined, layer);
    const result = await runClassificationSkeleton(fixture.ports, input(), new AbortController().signal);
    assert.equal(result.ok, false, layer);
    if (!result.ok) assert.equal(result.error.code, "operation_cancelled", layer);
    assert.equal(fixture.allocations, 0, layer);
    assert.equal(fixture.calls.at(-1), layer, layer);
    assert.equal(fixture.calls.length, layers.indexOf(layer) + 1, layer);
  }
});

test("classification coordinator has no runtime learning or scheduling surface", () => {
  const source = readFileSync(new URL("../../../src/control/orchestrator/live/classification.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /testing\/live|setTimeout|setInterval|queueMicrotask|promot|reload|catalog|selector|write|mutat|driver/i);
});
