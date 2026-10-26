import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ClassificationLayer,
  SanitizedStructuralObservationV1,
} from "../../../src/contracts/live/index.ts";
import {
  runClassificationSkeleton,
  type ClassificationSkeletonDependencies,
  type ClassificationSkeletonInput,
} from "../../../src/control/orchestrator/live/index.ts";

const revision = "classification_revision_0123456789abcdef" as never;
const otherRevision = "classification_revision_fedcba9876543210" as never;
const layers = [
  "ats_family",
  "workday_page_type",
  "ui_behavior",
  "question",
  "answer_type",
  "visible_option",
] as const;
const classificationIds = [
  "classification_atsfamily00000000",
  "classification_pagetype000000000",
  "classification_uibehavior0000000",
  "classification_question00000000",
  "classification_answer0000000000",
  "classification_option0000000000",
] as const;

function observation(
  layer: ClassificationLayer,
  index: number,
): SanitizedStructuralObservationV1 {
  return {
    schemaVersion: 1,
    observationId: `structural_observation_${index.toString().padStart(16, "0")}` as never,
    layer,
    sourceRevisionId: revision,
    parentLineage: layers.slice(0, index).map((parent, parentIndex) => ({
      layer: parent,
      classificationId: classificationIds[parentIndex] as never,
    })),
    traitIds: [`structural_trait_${index.toString().padStart(16, "0")}` as never],
    observedVariantId:
      layer === "ui_behavior"
        ? "ui_variant_0123456789abcdef" as never
        : null,
    controlCount: index + 1,
    requiredControlCount: index,
    optionCount: index === 5 ? 3 : 0,
  };
}

function validInput(): ClassificationSkeletonInput {
  return {
    schemaVersion: 1,
    observations: {
      atsFamily: observation("ats_family", 0) as never,
      pageType: observation("workday_page_type", 1) as never,
      uiBehavior: observation("ui_behavior", 2) as never,
      question: observation("question", 3) as never,
      answerType: observation("answer_type", 4) as never,
      visibleOption: observation("visible_option", 5) as never,
    },
    canonicalOptionId: "option-country-us" as never,
    visibleOptionIds: ["option-country-us" as never],
  };
}

type LayerOverride = (
  value: Record<string, unknown>,
) => Record<string, unknown>;

function fixture(options: {
  readonly overrideAt?: ClassificationLayer;
  readonly override?: LayerOverride;
  readonly unknownAt?: ClassificationLayer;
  readonly allocator?: () => unknown;
  readonly throwAt?: ClassificationLayer;
} = {}) {
  const calls: ClassificationLayer[] = [];
  const requests: unknown[] = [];
  let allocations = 0;
  const finish = (
    layer: ClassificationLayer,
    request: unknown,
    value: Record<string, unknown>,
  ) => {
    calls.push(layer);
    requests.push(request);
    if (options.throwAt === layer) throw new RangeError("classifier bug");
    const selected = options.overrideAt === layer && options.override
      ? options.override(value)
      : value;
    return { ok: true as const, value: selected };
  };
  const ports = {
    atsFamily: { async classify(request: unknown) {
      return finish("ats_family", request, options.unknownAt === "ats_family"
        ? { schemaVersion: 1, kind: "ats_unknown", sourceRevisionId: revision }
        : { schemaVersion: 1, kind: "classified", atsFamily: "workday", classificationId: classificationIds[0], sourceRevisionId: revision });
    } },
    pageType: { async classify(request: unknown) {
      return finish("workday_page_type", request, options.unknownAt === "workday_page_type"
        ? { schemaVersion: 1, kind: "workday_page_unknown", sourceRevisionId: revision }
        : { schemaVersion: 1, kind: "classified", pageType: "questionnaire", classificationId: classificationIds[1], sourceRevisionId: revision });
    } },
    uiBehavior: { async classify(request: unknown) {
      return finish("ui_behavior", request, options.unknownAt === "ui_behavior"
        ? { schemaVersion: 1, kind: "ui_behavior_unknown", sourceRevisionId: revision }
        : { schemaVersion: 1, kind: "classified", behavior: "text", reviewedVariantId: "ui_variant_0123456789abcdef", classificationId: classificationIds[2], sourceRevisionId: revision });
    } },
    question: { async classify(request: unknown) {
      return finish("question", request, options.unknownAt === "question"
        ? { schemaVersion: 1, kind: "question_unknown", sourceRevisionId: revision }
        : { schemaVersion: 1, kind: "classified", questionId: "question-country", classificationId: classificationIds[3], sourceRevisionId: revision });
    } },
    answerType: { async classify(request: unknown) {
      return finish("answer_type", request, options.unknownAt === "answer_type"
        ? { schemaVersion: 1, kind: "answer_type_unknown", sourceRevisionId: revision }
        : { schemaVersion: 1, kind: "classified", answerType: "single_choice", classificationId: classificationIds[4], sourceRevisionId: revision, provenance: { schemaVersion: 1, provenanceId: "answer_provenance_0123456789abcdef", source: "profile", sourceRevisionId: "answer_source_revision_0123456789abcdef" } });
    } },
    visibleOption: { async map(request: unknown) {
      return finish("visible_option", request, options.unknownAt === "visible_option"
        ? { schemaVersion: 1, kind: "option_no_match", sourceRevisionId: revision }
        : { schemaVersion: 1, kind: "mapped", optionId: "option-country-us", classificationId: classificationIds[5], sourceRevisionId: revision });
    } },
    allocateCandidateId() {
      allocations += 1;
      return options.allocator
        ? options.allocator()
        : "unknown_candidate_0123456789abcdef";
    },
  } as unknown as ClassificationSkeletonDependencies;
  return { calls, requests, ports, get allocations() { return allocations; } };
}

async function expectError(
  dependencies: ClassificationSkeletonDependencies,
  input: ClassificationSkeletonInput,
  code: "admission_shape_invalid" | "admission_mismatch",
) {
  const result = await runClassificationSkeleton(
    dependencies,
    input,
    new AbortController().signal,
  );
  assert.deepEqual(result, { ok: false, error: { code, retryable: false } });
}

test("all observations are parsed and pinned to one revision before any classifier call", async () => {
  const malformedFixture = fixture();
  const source = validInput();
  const malformed = {
    ...source,
    observations: {
      ...source.observations,
      atsFamily: { ...source.observations.atsFamily, traitIds: [] },
    },
  } as ClassificationSkeletonInput;
  await expectError(malformedFixture.ports, malformed, "admission_shape_invalid");
  assert.deepEqual(malformedFixture.calls, []);

  const observationKeys = [
    "atsFamily",
    "pageType",
    "uiBehavior",
    "question",
    "answerType",
    "visibleOption",
  ] as const;
  for (let index = 0; index < observationKeys.length; index += 1) {
    const declaredFixture = fixture();
    const declaredInput = validInput();
    const key = observationKeys[index] as (typeof observationKeys)[number];
    const replacement = declaredInput.observations[
      observationKeys[(index + 1) % observationKeys.length] as (typeof observationKeys)[number]
    ];
    const wrongLayer = {
      ...declaredInput,
      observations: { ...declaredInput.observations, [key]: replacement },
    } as ClassificationSkeletonInput;
    await expectError(declaredFixture.ports, wrongLayer, "admission_shape_invalid");
    assert.deepEqual(declaredFixture.calls, [], key);
  }

  for (const key of ["pageType", "uiBehavior", "question", "answerType", "visibleOption"] as const) {
    const mismatchFixture = fixture();
    const sourceInput = validInput();
    const input = {
      ...sourceInput,
      observations: {
        ...sourceInput.observations,
        [key]: { ...sourceInput.observations[key], sourceRevisionId: otherRevision },
      },
    } as ClassificationSkeletonInput;
    await expectError(mismatchFixture.ports, input, "admission_mismatch");
    assert.deepEqual(mismatchFixture.calls, [], key);
  }
});

test("each returned result is parsed and must match the pinned revision", async () => {
  for (const layer of layers) {
    const revisionFixture = fixture({
      overrideAt: layer,
      override: (value) => ({ ...value, sourceRevisionId: otherRevision }),
    });
    await expectError(revisionFixture.ports, validInput(), "admission_mismatch");
    assert.equal(revisionFixture.calls.at(-1), layer);

    const malformedFixture = fixture({
      overrideAt: layer,
      override: (value) => ({
        ...value,
        classificationId: "bad",
      }),
    });
    await expectError(malformedFixture.ports, validInput(), "admission_shape_invalid");
    assert.equal(malformedFixture.calls.at(-1), layer);
  }
});

test("each downstream observation lineage must name prior parsed classifications", async () => {
  for (let index = 1; index < layers.length; index += 1) {
    const mismatchFixture = fixture();
    const sourceInput = validInput();
    const key = ["pageType", "uiBehavior", "question", "answerType", "visibleOption"][index - 1] as keyof ClassificationSkeletonInput["observations"];
    const selected = sourceInput.observations[key];
    const changed = {
      ...selected,
      parentLineage: selected.parentLineage.map((entry, parentIndex) =>
        parentIndex === index - 1
          ? { ...entry, classificationId: "classification_wrong00000000000" as never }
          : entry),
    };
    const input = {
      ...sourceInput,
      observations: { ...sourceInput.observations, [key]: changed },
    } as ClassificationSkeletonInput;
    await expectError(mismatchFixture.ports, input, "admission_mismatch");
    assert.equal(mismatchFixture.calls.length, index);
    assert.equal(mismatchFixture.allocations, 0);
  }
});

test("successful coordination forwards parsed IDs and preserves the caller input", async () => {
  const successFixture = fixture();
  const input = validInput();
  const before = structuredClone(input);
  const result = await runClassificationSkeleton(
    successFixture.ports,
    input,
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    ok: true,
    value: { kind: "classified", optionId: "option-country-us" },
  });
  assert.deepEqual(input, before);
  assert.deepEqual(successFixture.calls, layers);
  assert.equal((successFixture.requests[1] as { atsFamilyClassificationId: string }).atsFamilyClassificationId, classificationIds[0]);
  assert.equal((successFixture.requests[2] as { pageTypeClassificationId: string }).pageTypeClassificationId, classificationIds[1]);
  assert.equal((successFixture.requests[3] as { uiBehaviorClassificationId: string }).uiBehaviorClassificationId, classificationIds[2]);
  assert.equal((successFixture.requests[4] as { questionClassificationId: string }).questionClassificationId, classificationIds[3]);
  assert.equal((successFixture.requests[5] as { answerTypeClassificationId: string }).answerTypeClassificationId, classificationIds[4]);
});

test("candidate allocation and derivation failures are admission-shape failures", async () => {
  for (const allocator of [
    () => "bad",
    () => { throw new TypeError("allocator bug"); },
  ]) {
    const invalid = fixture({ unknownAt: "ats_family", allocator });
    await expectError(invalid.ports, validInput(), "admission_shape_invalid");
    assert.equal(invalid.allocations, 1);
  }
});

test("direct provenance failures pass through and programmer errors are not relabeled", async () => {
  const provenance = fixture();
  provenance.ports.answerType.classify = async () => ({
    ok: false,
    error: { code: "answer_provenance_invalid", retryable: false },
  });
  const failed = await runClassificationSkeleton(
    provenance.ports,
    validInput(),
    new AbortController().signal,
  );
  assert.deepEqual(failed, {
    ok: false,
    error: { code: "answer_provenance_invalid", retryable: false },
  });

  const programmerError = fixture({ throwAt: "ui_behavior" });
  await assert.rejects(
    runClassificationSkeleton(
      programmerError.ports,
      validInput(),
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof RangeError && error.message === "classifier bug",
  );
});
