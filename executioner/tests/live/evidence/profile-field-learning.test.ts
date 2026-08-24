import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  admitProfileFieldLearningEvidence,
  createProfileFieldLearningCapture,
  type ProfileFieldLearningEvidenceV2,
  type ProfileFieldLearningRecordV2,
} from "../../../src/live/evidence/profile-field-learning.ts";
import type {
  ProfileCommitRequest,
  ProfileControlSnapshot,
  ProfileLearningConversion,
  ProfilePagePlan,
  ProfilePageSnapshot,
  WorkdayProfilePagePort,
} from "../../../src/ats/workday/application/profile/index.ts";
import {
  retainedIntakeControlGuide,
  retainedIntakeTextSha256,
} from "../../../src/form/questions/catalog.ts";

interface MutableObservationBinding {
  operationId: string;
  attempt: number;
  stateObservedAck: boolean;
}

type MutableLearningRecord = Omit<
  ProfileFieldLearningRecordV2,
  "driverAttempt" | "observationBinding" | "visibleOptionIds"
> & {
  driverAttempt: string;
  observationBinding: MutableObservationBinding | null;
  visibleOptionIds: readonly string[];
};

type MutableLearningEvidence = Omit<
  ProfileFieldLearningEvidenceV2,
  "fields" | "liveAcceptanceEligible" | "learningConversion"
> & {
  liveAcceptanceEligible: boolean;
  fields: MutableLearningRecord[];
  learningConversion?: Omit<ProfileLearningConversion, "affected" | "defaultsGenerated" | "fieldIds"> & {
    defaultsGenerated: boolean;
    fieldIds: string[];
    affected: { fieldId: string; reasons: string[] }[];
  };
};

function mutableEvidence(evidence: ProfileFieldLearningEvidenceV2): MutableLearningEvidence {
  return structuredClone(evidence) as unknown as MutableLearningEvidence;
}

function admitMutableEvidence(evidence: MutableLearningEvidence): ProfileFieldLearningEvidenceV2 {
  return admitProfileFieldLearningEvidence(evidence as unknown as ProfileFieldLearningEvidenceV2);
}

function mutableObservationBinding(
  evidence: MutableLearningEvidence,
  index: number,
): MutableObservationBinding {
  const binding = evidence.fields[index]?.observationBinding;
  if (binding === null || binding === undefined) throw new TypeError("missing test observation binding");
  return binding;
}

test("retains value-free field learning through prefill, driver, and readback", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-"));
  const port = new FakeProfilePort(snapshot("Canada"));
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: profilePlan(),
    root,
    sensitiveValues: [
      "Ada", "Canada", "United States", "private@example.invalid",
      retainedIntakeTextSha256("Canada").slice(8, 20),
    ],
    observeControl: observer(),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    capture.monitorAck(monitor("country-control", 1, "before_mutation"));
    await capture.page.commit({
      controlId: "country-control",
      uiBehavior: "search_select",
      value: "United States",
    }, AbortSignal.any([]));
    capture.monitorAck(monitor("country-control", 1, "after_readback"));
    port.current = snapshot("United States");
    await capture.page.inspect(AbortSignal.any([]));

    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    assert.deepEqual(readdirSync(root), ["profile-field-learning.json"]);
    const text = readFileSync(join(root, "profile-field-learning.json"), "utf8");
    for (const forbidden of [
      "Ada", "Canada", "United States", "private@example.invalid",
      "Software Engineer", "C:\\private\\resume.pdf",
    ]) assert.equal(text.includes(forbidden), false);
    const evidence = admitProfileFieldLearningEvidence(JSON.parse(text));
    assert.equal(evidence.schemaVersion, 5);
    assert.equal(evidence.evidenceRevision, "s2-profile-field-learning-v5");
    assert.equal(evidence.visibleControlCount, 3);
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.equal(new Set(evidence.fields.map(({ observationBinding }) =>
      observationBinding?.operationId
    )).size, 3);
    assert.equal(evidence.fields[0]!.metadataReconciliation, "matched");
    assert.equal(evidence.fields[1]!.answerCategory, "single_select");
    assert.equal(evidence.fields[1]!.visibleOptionIds.length, 2);
    assert.match(evidence.fields[1]!.selectedOptionId ?? "", /^option_sha256_[0-9a-f]{64}$/u);
    assert.equal(evidence.fields[1]!.monitorBinding?.operationId, operation(1));
    assert.equal(evidence.fields[2]!.metadataReconciliation, "unresolved");
    assert.equal(evidence.fields[2]!.terminalDisposition, "required_unset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits dynamic search catalogs when selection reveals more options", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-dynamic-options-"));
  const sourceControl = (readback: string | null): ProfilePageSnapshot => ({
    pageType: "profile",
    controls: [{
      controlId: "source-control",
      fieldId: "source.how_did_you_hear",
      required: true,
      uiBehavior: "search_select",
      uiVariant: "workday_source_select_v1",
      readback,
    }],
    rows: [],
  });
  const port = new FakeProfilePort(sourceControl(null));
  const baseObserver = observer();
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: {
      mode: "live",
      pageType: "profile",
      fields: [{
        fieldId: "source.how_did_you_hear",
        questionType: "application_source",
        answerType: "option",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "LinkedIn",
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
        optionMapping: {
          canonicalValue: "LinkedIn",
          visibleOption: "LinkedIn",
          provenance: "visible_option",
        },
      }],
      repeatables: [],
    },
    root,
    sensitiveValues: ["LinkedIn"],
    observeControl: async (control) => {
      const observed = await baseObserver(control);
      return {
        ...observed,
        observation: {
          ...observed.observation,
          optionCatalogState: "observed" as const,
          visibleOptionIds: optionIds(["LinkedIn"]),
        },
      };
    },
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    capture.monitorAck(monitor("source-control", 1, "before_mutation"));
    await capture.page.commit({
      controlId: "source-control",
      uiBehavior: "search_select",
      value: "LinkedIn",
    }, AbortSignal.any([]));
    capture.monitorAck(monitor("source-control", 1, "after_readback"));
    port.current = sourceControl("LinkedIn");
    await capture.page.inspect(AbortSignal.any([]));

    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const evidence = admitProfileFieldLearningEvidence(JSON.parse(readFileSync(
      join(root, "profile-field-learning.json"), "utf8",
    )));
    assert.equal(evidence.fields[0]!.metadataReconciliation, "matched");
    assert.equal(evidence.fields[0]!.terminalDisposition, "verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns all value-free metadata mismatches for learning conversion", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-metadata-mismatch-"));
  const fields = [
    ["source.how_did_you_hear", "search_select", "workday_source_select_v1", true],
    ["employment.previously_worked_for_organization", "radio_group", "workday_previous_worker_radio_v1", true],
    ["address.country", "search_select", "workday_search_select_v2", true],
    ["address.region", "search_select", "workday_search_select_v1", false],
    ["phone.device_type", "search_select", "workday_search_select_v2", true],
  ] as const;
  const plan: ProfilePagePlan = {
    mode: "live",
    pageType: "profile",
    fields: fields.map(([fieldId], index) => ({
      fieldId,
      questionType: fieldId === "source.how_did_you_hear"
        ? "address" as const
        : fieldId === "employment.previously_worked_for_organization"
          ? "prior_employment" as const
          : fieldId.startsWith("phone.") ? "phone" as const : "address" as const,
      answerType: fieldId.startsWith("phone.") ? "option" as const : "option" as const,
      allowedOptions: fieldId === "employment.previously_worked_for_organization"
        ? ["Yes", "No"] : [],
      answer: {
        kind: "answered" as const,
        value: `answer-${index}`,
        provenance: "owner_provided" as const,
        lane: "live_owner_fact" as const,
      },
      ...(fieldId === "employment.previously_worked_for_organization" ? {
        optionMapping: { canonicalValue: "No", visibleOption: "No", provenance: "visible_option" as const },
      } : {}),
    })),
    repeatables: [],
  };
  const port = new FakeProfilePort({
    pageType: "profile",
    controls: fields.map(([fieldId, uiBehavior, uiVariant, required], index) => ({
      controlId: `metadata-control-${index}`,
      fieldId,
      required,
      uiBehavior,
      uiVariant,
      readback: null,
    })),
    rows: [],
  });
  const baseObserver = observer(40);
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan,
    root,
    sensitiveValues: ["answer-0", "answer-1", "answer-2", "answer-3", "answer-4"],
    observeControl: async (control) => {
      const observed = await baseObserver(control);
      if (control.fieldId === "source.how_did_you_hear") {
        return { ...observed, observation: { ...observed.observation, sanitizedLabelSha256: "0".repeat(64) } };
      }
      if (control.fieldId === "employment.previously_worked_for_organization") {
        return { ...observed, observation: { ...observed.observation, visibleOptionIds: optionIds(["Yes"]) } };
      }
      if (control.fieldId === "address.country") {
        return { ...observed, observation: { ...observed.observation, binderStrategy: "opaque_machine_key" as const } };
      }
      if (control.fieldId === "phone.device_type") {
        return { ...observed, observation: { ...observed.observation, sanitizedLabelSha256: "1".repeat(64) } };
      }
      return observed;
    },
  });
  try {
    await assert.rejects(
      capture.page.inspect(AbortSignal.any([])),
      (error: unknown) => error instanceof TypeError &&
        error.message === "profile metadata reconciliation failed",
    );
    const failure = capture.page.metadataReconciliationFailure?.();
    assert.deepEqual(failure?.mismatches.map(({ fieldId }) => fieldId), fields.map(([fieldId]) =>
      `profile.${fieldId}`
    ));
    assert.deepEqual(failure?.mismatches.map(({ reasons }) => reasons), [
      ["label_digest", "plan_binding"],
      ["option_catalog"],
      ["binder_strategy"],
      ["ui_variant"],
      ["label_digest"],
    ]);
    assert.equal(capture.write() !== null, true);
    const evidence = JSON.parse(readFileSync(join(root, "profile-field-learning.json"), "utf8"));
    assert.equal(evidence.executionMode, "synthetic_test_non_submittable");
    assert.equal(evidence.testOnly, true);
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.deepEqual(evidence.learningConversion, {
      kind: "profile_ui_learning",
      executionMode: "synthetic_test_non_submittable",
      testOnly: true,
      mutationAllowed: false,
      defaultsGenerated: false,
      liveAcceptanceEligible: false,
      fieldIds: fields.map(([fieldId]) => `profile.${fieldId}`),
      affected: fields.map(([fieldId], index) => ({
        fieldId: `profile.${fieldId}`,
        reasons: [["label_digest", "plan_binding"], ["option_catalog"], ["binder_strategy"], ["ui_variant"], ["label_digest"]][index]!,
      })),
    });
    assert.deepEqual(evidence.fields[0]!.planBinding, {
      questionType: "address",
      answerType: "option",
    });
    const stripped = structuredClone(evidence) as MutableLearningEvidence;
    delete (stripped.learningConversion as unknown as Record<string, unknown>).affected;
    assert.throws(() => admitMutableEvidence(stripped), TypeError);
    const contradictory = structuredClone(evidence) as MutableLearningEvidence;
    (contradictory.learningConversion as unknown as {
      affected: { reasons: string[] }[];
    }).affected[0]!.reasons = [];
    assert.throws(() => admitMutableEvidence(contradictory), TypeError);
    const omitted = structuredClone(evidence) as MutableLearningEvidence;
    omitted.learningConversion!.fieldIds = omitted.learningConversion!.fieldIds.slice(1);
    omitted.learningConversion!.affected = omitted.learningConversion!.affected.slice(1);
    assert.throws(() => admitMutableEvidence(omitted), TypeError);
    const substituted = structuredClone(evidence) as MutableLearningEvidence;
    substituted.learningConversion!.affected[0]!.fieldId =
      substituted.learningConversion!.fieldIds[1]!;
    assert.throws(() => admitMutableEvidence(substituted), TypeError);
    const tamperedReason = structuredClone(evidence) as MutableLearningEvidence;
    tamperedReason.learningConversion!.affected[0]!.reasons = ["option_catalog"];
    assert.throws(() => admitMutableEvidence(tamperedReason), TypeError);
    const tamperedPlanBinding = structuredClone(evidence) as MutableLearningEvidence;
    (tamperedPlanBinding.fields[0] as unknown as {
      planBinding: { questionType: string; answerType: string };
    }).planBinding = { questionType: "application_source", answerType: "option" };
    assert.throws(() => admitMutableEvidence(tamperedPlanBinding), TypeError);
    const missingObservedBinding = structuredClone(evidence) as MutableLearningEvidence;
    missingObservedBinding.fields[0]!.observationBinding = null;
    assert.throws(() => admitMutableEvidence(missingObservedBinding), TypeError);
    const missingPlanBinding = structuredClone(evidence) as MutableLearningEvidence;
    (missingPlanBinding.fields[0] as unknown as { planBinding: null }).planBinding = null;
    assert.throws(() => admitMutableEvidence(missingPlanBinding), TypeError);
    const planlessOwnerInput = structuredClone(evidence) as MutableLearningEvidence;
    (planlessOwnerInput.fields[0] as unknown as { planBinding: null }).planBinding = null;
    planlessOwnerInput.learningConversion!.affected[0]!.reasons = ["label_digest"];
    assert.equal(admitMutableEvidence(planlessOwnerInput).fields[0]!.planBinding, null);
    const mutation = structuredClone(evidence) as MutableLearningEvidence;
    mutation.fields[0]!.driverAttempt = "search_select";
    assert.throws(() => admitMutableEvidence(mutation), TypeError);
    const defaulted = structuredClone(evidence) as MutableLearningEvidence;
    defaulted.learningConversion!.defaultsGenerated = true;
    assert.throws(() => admitMutableEvidence(defaulted), TypeError);
    assert.equal(evidence.fields.every((field: { answerState: string; lane: unknown; driverAttempt: string }) =>
      field.answerState === "unset" && field.lane === null && field.driverAttempt === "none"), true);
    assert.equal(JSON.stringify(evidence).includes("answer-"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records a failed driver without changing the delegated failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-failure-"));
  const expected = new TypeError("delegated driver failure");
  const port = new FakeProfilePort(snapshot(null), expected);
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: profilePlan(),
    root,
    sensitiveValues: [],
    observeControl: observer(),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    capture.monitorAck(monitor("country-control", 2, "before_mutation"));
    await assert.rejects(
      capture.page.commit({
        controlId: "country-control",
        uiBehavior: "search_select",
        value: "United States",
      }, AbortSignal.any([])),
      (error) => error === expected,
    );
    capture.monitorAck(monitor("country-control", 2, "after_readback"));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const evidence = JSON.parse(readFileSync(
      join(root, "profile-field-learning.json"), "utf8",
    ));
    assert.equal(evidence.fields[1].prefillDisposition, "blank");
    assert.equal(evidence.fields[1].driverAttempt, "search_select");
    assert.equal(evidence.fields[1].mechanics.persistentReadback, "driver_failed");
    assert.equal(evidence.fields[1].terminalDisposition, "driver_failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeatable learning identity survives DOM row reordering", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-rows-"));
  const port = new FakeProfilePort(repeatableSnapshot(["row-a", "row-b"]));
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: profilePlan(),
    root,
    sensitiveValues: ["Changed"],
    observeControl: observer(),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    port.current = repeatableSnapshot(["row-b", "row-a"]);
    await capture.page.inspect(AbortSignal.any([]));
    capture.monitorAck(monitor("row-a-company", 3, "before_mutation"));
    await capture.page.commit({
      controlId: "row-a-company",
      uiBehavior: "text",
      value: "Changed",
    }, AbortSignal.any([]));
    capture.monitorAck(monitor("row-a-company", 3, "after_readback"));
    port.current = repeatableSnapshot(["row-b", "row-a"], "Changed");
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);

    const evidence = JSON.parse(readFileSync(
      join(root, "profile-field-learning.json"), "utf8",
    ));
    const rowA = evidence.fields.find(
      ({ fieldIdentity }: { readonly fieldIdentity: string }) =>
        fieldIdentity === "profile.experience.1.experience.company",
    );
    const rowB = evidence.fields.find(
      ({ fieldIdentity }: { readonly fieldIdentity: string }) =>
        fieldIdentity === "profile.experience.2.experience.company",
    );
    assert.equal(rowA.driverAttempt, "text");
    assert.equal(rowA.questionCategory, "employment");
    assert.equal(rowA.answerCategory, "text");
    assert.equal(rowA.mechanics.persistentReadback, "verified_after_rescan");
    assert.equal(rowB.driverAttempt, "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unavailable evidence storage is passive", async () => {
  const port = new FakeProfilePort(snapshot(null));
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: profilePlan(),
    sensitiveValues: [],
    observeControl: observer(),
  });
  assert.equal((await capture.page.inspect(AbortSignal.any([]))).pageType, "profile");
  assert.equal(capture.write(), null);
});

test("writes a distinct immutable learning artifact for the second profile state", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-second-"));
  const capture = createProfileFieldLearningCapture({
    page: new FakeProfilePort(snapshot(null)),
    plan: profilePlan(),
    root,
    fileName: "profile-field-learning-02.json",
    sensitiveValues: [],
    observeControl: observer(),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    assert.deepEqual(readdirSync(root), ["profile-field-learning-02.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixed structural vocabulary does not collide with an equal private answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-structural-"));
  const capture = createProfileFieldLearningCapture({
    page: new FakeProfilePort({
      pageType: "profile",
      controls: [{
        controlId: "linkedin-control",
        fieldId: "social.linkedin",
        required: false,
        uiBehavior: "text",
        uiVariant: "workday_text_v2",
        readback: null,
      }],
      rows: [],
    }),
    plan: {
      mode: "synthetic_test_non_submittable",
      pageType: "profile",
fields: [{
        fieldId: "social.linkedin",
      questionType: "social_network",
        answerType: "url",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "linkedin",
          provenance: "generated_default",
          lane: "synthetic_test_default",
        },
      }],
      repeatables: [],
    },
    root,
    sensitiveValues: ["linkedin", "None"],
    observeControl: observer(),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const text = readFileSync(join(root, "profile-field-learning.json"), "utf8");
    assert.equal(text.includes('"linkedin"'), false);
    assert.equal(text.includes('"None"'), false);
    assert.equal(text.includes("profile.social.linkedin"), true);
    const evidence = admitProfileFieldLearningEvidence(JSON.parse(text));
    assert.equal(evidence.executionMode, "synthetic_test_non_submittable");
    assert.equal(evidence.testOnly, true);
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.equal(evidence.fields[0]?.lane, "synthetic_test_default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits a synthetic non-submittable page with only owner facts and optional unset controls", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-owner-only-"));
  const capture = createProfileFieldLearningCapture({
    page: new FakeProfilePort({
      pageType: "profile",
      controls: [
        {
          controlId: "linkedin-control",
          fieldId: "social.linkedin",
          required: false,
          uiBehavior: "text",
          uiVariant: "workday_text_v2",
          readback: "https://www.linkedin.com/in/example",
        },
        {
          controlId: "facebook-control",
          fieldId: "social.facebook",
          required: false,
          uiBehavior: "text",
          uiVariant: "workday_text_v2",
          readback: null,
        },
        {
          controlId: "twitter-control",
          fieldId: "social.twitter",
          required: false,
          uiBehavior: "text",
          uiVariant: "workday_text_v2",
          readback: null,
        },
      ],
      rows: [],
    }),
    plan: {
      mode: "synthetic_test_non_submittable",
      pageType: "profile",
      fields: [{
        fieldId: "social.linkedin",
        questionType: "social_network",
        answerType: "url",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "https://www.linkedin.com/in/example",
          provenance: "resume_verified",
          lane: "live_owner_fact",
        },
      }],
      repeatables: [],
    },
    root,
    sensitiveValues: ["https://www.linkedin.com/in/example"],
    observeControl: observer(),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const evidence = admitProfileFieldLearningEvidence(JSON.parse(
      readFileSync(join(root, "profile-field-learning.json"), "utf8"),
    ));
    assert.equal(evidence.executionMode, "synthetic_test_non_submittable");
    assert.equal(evidence.testOnly, true);
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.equal(evidence.fields.some(({ lane }) => lane === "synthetic_test_default"), false);
    assert.deepEqual(evidence.fields.map(({ fieldIdentity }) => fieldIdentity), [
      "profile.social.linkedin",
      "profile.social.facebook",
      "profile.social.twitter",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated operation ids do not collide with private answer fragments", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-operation-id-"));
  const observe = observer();
  const capture = createProfileFieldLearningCapture({
    page: new FakeProfilePort({
      pageType: "profile",
      controls: [{
        controlId: "linkedin-control",
        fieldId: "social.linkedin",
        required: false,
        uiBehavior: "text",
        uiVariant: "workday_text_v2",
        readback: null,
      }],
      rows: [],
    }),
    plan: {
      mode: "synthetic_test_non_submittable",
      pageType: "profile",
      fields: [{
        fieldId: "social.linkedin",
        questionType: "social_network",
        answerType: "url",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "000",
          provenance: "generated_default",
          lane: "synthetic_test_default",
        },
      }],
      repeatables: [],
    },
    root,
    sensitiveValues: ["000"],
    observeControl: async (control) => {
      const observed = await observe(control);
      return {
        ...observed,
        binding: {
          ...observed.binding,
          operationId: "operation_profile_learning_0001",
        },
      };
    },
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const text = readFileSync(join(root, "profile-field-learning.json"), "utf8");
    assert.equal(text.includes('"000"'), false);
    assert.equal(
      admitProfileFieldLearningEvidence(JSON.parse(text)).fields[0]?.observationBinding?.operationId,
      "operation_profile_learning_0001",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciles the retained My Experience skills control", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-skills-"));
  const capture = createProfileFieldLearningCapture({
    page: new FakeProfilePort({
      pageType: "profile",
      controls: [{
        controlId: "skills-control",
        fieldId: "skills.values",
        required: false,
        uiBehavior: "multi_select",
        uiVariant: "workday_multi_select_v1",
        readback: null,
      }],
      rows: [],
    }),
    plan: {
      mode: "live",
      pageType: "profile",
      fields: [],
      repeatables: [],
    },
    root,
    sensitiveValues: [],
    observeControl: observer(),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const evidence = admitProfileFieldLearningEvidence(JSON.parse(readFileSync(
      join(root, "profile-field-learning.json"), "utf8",
    )));
    assert.equal(evidence.fields[0]?.fieldIdentity, "profile.skills.values");
    assert.equal(evidence.fields[0]?.uiType, "multi_select");
    assert.equal(evidence.fields[0]?.metadataReconciliation, "matched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits reviewed website repeatable identities", () => {
  const admitted = admitProfileFieldLearningEvidence({
    schemaVersion: 5,
    evidenceRevision: "s2-profile-field-learning-v5",
    page: "profile",
    executionMode: "live",
    testOnly: false,
    liveAcceptanceEligible: true,
    visibleControlCount: 1,
    fields: [{
      fieldIdentity: "profile.websites.1.website.url",
      uiType: "text",
      uiVariant: "workday_text_v1",
      questionCategory: "website",
      answerCategory: "url",
      required: false,
      answerState: "unset",
      lane: null,
      ...repeatableObservation(1),
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: "not_applicable",
      prefillDisposition: "blank",
      driverAttempt: "none",
      monitorBinding: null,
      terminalDisposition: "optional_unset",
      mechanics: mechanics("text", "not_attempted"),
    }],
  });
  assert.equal(admitted.fields[0]?.fieldIdentity, "profile.websites.1.website.url");
});

test("retains the maximum admitted field inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-maximum-"));
  const port = new FakeProfilePort({
    pageType: "profile",
    controls: Array.from({ length: 128 }, (_value, index) => ({
      controlId: `unknown-control-${index + 1}`,
      fieldId: `unknown.required.${index + 1}`,
      required: true,
      uiBehavior: "text" as const,
      uiVariant: "workday_unknown_required_v1",
      readback: null,
    })),
    rows: [],
  });
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: { mode: "live", pageType: "profile", fields: [], repeatables: [] },
    root,
    sensitiveValues: [],
    observeControl: observer(),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const evidence = JSON.parse(readFileSync(
      join(root, "profile-field-learning.json"), "utf8",
    ));
    assert.equal(evidence.fields.length, 128);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admits reviewed owner-input source and prior-employment controls", () => {
  const admitted = admitProfileFieldLearningEvidence({
    schemaVersion: 5,
    evidenceRevision: "s2-profile-field-learning-v5",
    page: "profile",
    executionMode: "live",
    testOnly: false,
    liveAcceptanceEligible: true,
    visibleControlCount: 2,
    fields: [
      learningField({
        fieldIdentity: "profile.source.how_did_you_hear",
        uiType: "search_select",
        uiVariant: "workday_source_select_v1",
        questionCategory: "application_source",
      }),
      learningField({
        fieldIdentity: "profile.employment.previously_worked_for_organization",
        uiType: "radio_group",
        uiVariant: "workday_previous_worker_radio_v1",
        questionCategory: "prior_employment",
      }),
    ],
  });
  assert.equal(admitted.fields.length, 2);
  const mismatchedOptions = mutableEvidence(admitted);
  mismatchedOptions.fields[1]!.visibleOptionIds = optionIds(["Yes"]);
  assert.throws(() => admitMutableEvidence(mismatchedOptions));
});

test("admits a reviewed v2 variant for a duplicated scalar field identity", () => {
  const admitted = admitProfileFieldLearningEvidence({
    schemaVersion: 5,
    evidenceRevision: "s2-profile-field-learning-v5",
    page: "profile",
    executionMode: "live",
    testOnly: false,
    liveAcceptanceEligible: false,
    visibleControlCount: 1,
    fields: [{
      fieldIdentity: "profile.identity.given_name",
      uiType: "text",
      uiVariant: "workday_text_v2",
      questionCategory: "identity",
      answerCategory: "text",
      required: true,
      answerState: "unset",
      lane: null,
      ...knownObservation("identity.given_name", 1),
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: "not_applicable",
      prefillDisposition: "blank",
      driverAttempt: "none",
      monitorBinding: null,
      terminalDisposition: "required_unset",
      mechanics: mechanics("text", "not_attempted"),
    }],
  });

  assert.equal(admitted.fields[0]?.uiVariant, "workday_text_v2");
});

test("admits privacy-safe optional checkbox and required file inventory", () => {
  const admitted = admitProfileFieldLearningEvidence({
    schemaVersion: 5,
    evidenceRevision: "s2-profile-field-learning-v5",
    page: "profile",
    executionMode: "live",
    testOnly: false,
    liveAcceptanceEligible: false,
    visibleControlCount: 2,
    fields: [
      {
        fieldIdentity: "profile.unknown.optional.1",
        uiType: "checkbox",
        uiVariant: "workday_unknown_required_v1",
        questionCategory: "unknown",
        answerCategory: "unknown",
        required: false,
        answerState: "unset",
        lane: null,
        ...unknownObservation(1),
        visibleOptionIds: [],
        selectedOptionId: null,
        optionMapping: "unresolved",
        prefillDisposition: "needs_owner_input",
        driverAttempt: "none",
        monitorBinding: null,
        terminalDisposition: "optional_unset",
        mechanics: mechanics("text", "not_attempted"),
      },
      {
        fieldIdentity: "profile.unknown.required.2",
        uiType: "file",
        uiVariant: "workday_unknown_required_v1",
        questionCategory: "unknown",
        answerCategory: "unknown",
        required: true,
        answerState: "unset",
        lane: null,
        ...unknownObservation(2),
        visibleOptionIds: [],
        selectedOptionId: null,
        optionMapping: "unresolved",
        prefillDisposition: "needs_owner_input",
        driverAttempt: "none",
        monitorBinding: null,
        terminalDisposition: "required_unset",
        mechanics: mechanics("text", "not_attempted"),
      },
    ],
  });

  assert.deepEqual(admitted.fields.map(({ fieldIdentity, uiType, required }) => ({
    fieldIdentity,
    uiType,
    required,
  })), [
    { fieldIdentity: "profile.unknown.optional.1", uiType: "checkbox", required: false },
    { fieldIdentity: "profile.unknown.required.2", uiType: "file", required: true },
  ]);
});

test("denies widened, duplicate, and non-opaque learning records", () => {
  const base = {
    schemaVersion: 5 as const,
    evidenceRevision: "s2-profile-field-learning-v5" as const,
    page: "profile" as const,
    executionMode: "live" as const,
    testOnly: false as const,
    liveAcceptanceEligible: false as const,
    visibleControlCount: 1,
    fields: [{
      fieldIdentity: "profile.identity.given_name",
      uiType: "text" as const,
      uiVariant: "workday_text_v2",
      questionCategory: "identity" as const,
      answerCategory: "text" as const,
      required: true,
      answerState: "answered" as const,
      lane: "live_owner_fact" as const,
      ...knownObservation("identity.given_name", 1),
      visibleOptionIds: [] as const,
      selectedOptionId: null,
      optionMapping: "not_applicable" as const,
      prefillDisposition: "blank" as const,
      driverAttempt: "none" as const,
      monitorBinding: null,
      terminalDisposition: "pending" as const,
      mechanics: mechanics("text", "not_attempted"),
    }],
  };
  const invalidEvidence = [
    { ...base, rawLabel: "Full legal name" },
    { ...base, fields: [...base.fields, ...base.fields] },
    { ...base, fields: [{
      ...base.fields[0],
      sanitizedLabelSha256: "0".repeat(64),
    }] },
    { ...base, fields: [{ ...base.fields[0], questionCategory: "address" }] },
    { ...base, fields: [{ ...base.fields[0], required: false }] },
    { ...base, fields: [{ ...base.fields[0], binderStrategy: "opaque_machine_key" }] },
    { ...base, fields: [(() => {
      const { lane: _lane, ...field } = base.fields[0]!;
      return field;
    })()] },
    { ...base, fields: [{ ...base.fields[0], lane: "invalid" }] },
    { ...base, fields: [{ ...base.fields[0], lane: "synthetic_test_default" }] },
    {
      ...base,
      fields: [{ ...base.fields[0], visibleOptionIds: ["Canada"] }],
    },
    {
      ...base,
      fields: [{ ...base.fields[0], fieldIdentity: "profile.private@example.invalid" }],
    },
    {
      ...base,
      fields: [{ ...base.fields[0], fieldIdentity: "profile.unknown.ada" }],
    },
    {
      ...base,
      fields: [{ ...base.fields[0], uiVariant: "workday_ada_v1" }],
    },
    {
      ...base,
      fields: [{
        ...base.fields[0],
        uiType: "file",
        uiVariant: "workday_unknown_required_v1",
      }],
    },
    {
      ...base,
      fields: [{
        ...base.fields[0],
        fieldIdentity: "profile.unknown.required.1",
        uiType: "checkbox",
        uiVariant: "workday_text_v2",
        questionCategory: "unknown",
        answerCategory: "unknown",
        optionMapping: "unresolved",
        prefillDisposition: "needs_owner_input",
      }],
    },
    {
      ...base,
      fields: [{
        ...base.fields[0],
        uiType: "search_select",
        uiVariant: "workday_search_select_v1",
        answerCategory: "option",
        visibleOptionIds: ["option_ref_02"],
      }],
    },
    {
      ...base,
      fields: [{ ...base.fields[0], driverAttempt: "search_select" }],
    },
    {
      ...base,
      fields: [{
        ...base.fields[0],
        mechanics: mechanics("text", "verified_after_rescan"),
      }],
    },
  ];
  invalidEvidence.forEach((invalid, index) => {
    assert.throws(
      () => admitProfileFieldLearningEvidence(invalid as never),
      (error) => error instanceof TypeError,
      `invalid evidence ${index} was admitted`,
    );
  });
});

test("rejects duplicate visible control bindings before mutation", async () => {
  const port = new FakeProfilePort({
    pageType: "profile",
    controls: [
      {
        controlId: "given-control-a",
        fieldId: "identity.given_name",
        required: true,
        uiBehavior: "text",
        uiVariant: "workday_text_v2",
        readback: null,
      },
      {
        controlId: "given-control-b",
        fieldId: "identity.given_name",
        required: true,
        uiBehavior: "text",
        uiVariant: "workday_text_v2",
        readback: null,
      },
    ],
    rows: [],
  });
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: profilePlan(),
    sensitiveValues: [],
    observeControl: observer(),
  });
  await assert.rejects(
    capture.page.inspect(AbortSignal.any([])),
    /duplicate profile control binding denied/u,
  );
});

test("already-correct and optional-unset controls require truthful observation bindings", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-observation-"));
  const port = new FakeProfilePort({
    pageType: "profile",
    controls: [
      {
        controlId: "given-control",
        fieldId: "identity.given_name",
        required: true,
        uiBehavior: "text",
        uiVariant: "workday_text_v2",
        readback: "Ada",
      },
      {
        controlId: "address-control",
        fieldId: "address.line1",
        required: false,
        uiBehavior: "text",
        uiVariant: "workday_text_v2",
        readback: null,
      },
    ],
    rows: [],
  });
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: {
      mode: "live",
      pageType: "profile",
      fields: [{
        fieldId: "identity.given_name",
        questionType: "identity",
        answerType: "text",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "Ada",
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
      }],
      repeatables: [],
    },
    root,
    sensitiveValues: ["Ada"],
    observeControl: observer(9),
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const evidence = admitProfileFieldLearningEvidence(JSON.parse(readFileSync(
      join(root, "profile-field-learning.json"), "utf8",
    )));
    assert.equal(evidence.liveAcceptanceEligible, true);
    assert.deepEqual(evidence.fields.map(({ terminalDisposition }) => terminalDisposition), [
      "verified_without_mutation", "optional_unset",
    ]);
    assert.equal(new Set(evidence.fields.map(({ observationBinding }) =>
      observationBinding?.operationId
    )).size, 2);
    assert.deepEqual(evidence.fields.map(({ monitorBinding }) => monitorBinding), [null, null]);
    const mutations: readonly ((value: MutableLearningEvidence) => void)[] = [
      (value) => {
        value.fields[0]!.observationBinding = null;
        value.liveAcceptanceEligible = true;
      },
      (value) => { mutableObservationBinding(value, 0).operationId = "bad"; },
      (value) => { mutableObservationBinding(value, 0).stateObservedAck = false; },
      (value) => {
        mutableObservationBinding(value, 1).operationId =
          mutableObservationBinding(value, 0).operationId;
      },
    ];
    for (const mutate of mutations) {
      const tampered = mutableEvidence(evidence);
      mutate(tampered);
      assert.throws(() => admitMutableEvidence(tampered));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeProfilePort implements WorkdayProfilePagePort {
  current: ProfilePageSnapshot;
  private readonly commitFailure?: Error;

  constructor(
    current: ProfilePageSnapshot,
    commitFailure?: Error,
  ) {
    this.current = current;
    this.commitFailure = commitFailure;
  }

  async inspect(): Promise<ProfilePageSnapshot> {
    return this.current;
  }

  async commit(_request: ProfileCommitRequest): Promise<void> {
    if (this.commitFailure !== undefined) throw this.commitFailure;
  }

  async addOwnedRow(): Promise<string> {
    throw new TypeError("not used");
  }

  async removeOwnedRow(): Promise<void> {
    throw new TypeError("not used");
  }

  interaction(controlId: string) {
    if (controlId === "source-control" && this.commitFailure === undefined) {
      return {
        popupBound: true,
        optionFocused: true,
        optionActivated: true,
        popupClosed: true,
        backingValueCommitted: true,
        validationCleared: true,
        visibleOptionCount: 27,
        selectedOptionOrdinal: 16,
      };
    }
    if (controlId === "row-a-company" && this.commitFailure === undefined) {
      return {
        popupBound: null,
        optionFocused: null,
        optionActivated: null,
        popupClosed: null,
        backingValueCommitted: true,
        validationCleared: true,
        visibleOptionCount: null,
        selectedOptionOrdinal: null,
      };
    }
    return controlId === "country-control" && this.commitFailure === undefined
      ? {
          popupBound: true,
          optionFocused: true,
          optionActivated: true,
          popupClosed: true,
          backingValueCommitted: true,
          validationCleared: true,
          visibleOptionCount: 2,
          selectedOptionOrdinal: 2,
        }
      : undefined;
  }
}

function learningField(input: {
  readonly fieldIdentity: string;
  readonly uiType: "search_select" | "radio_group";
  readonly uiVariant: string;
  readonly questionCategory: "application_source" | "prior_employment";
}) {
  return {
    ...input,
    answerCategory: "single_select" as const,
    required: true,
    answerState: "answered" as const,
    lane: "live_owner_fact" as const,
    ...knownObservation(input.fieldIdentity.slice("profile.".length),
      input.questionCategory === "application_source" ? 1 : 2, {
      backingState: "set",
    }),
    visibleOptionIds: input.fieldIdentity ===
        "profile.employment.previously_worked_for_organization"
      ? optionIds(["Yes", "No"])
      : [] as const,
    selectedOptionId: null,
    optionMapping: "owner_visible_option" as const,
    prefillDisposition: "already_correct" as const,
    driverAttempt: "none" as const,
    monitorBinding: null,
    terminalDisposition: "verified_without_mutation" as const,
    mechanics: mechanics(input.uiType, "not_attempted"),
  };
}

function observer(start = 100) {
  let index = start;
  return async (control: ProfileControlSnapshot) => {
    index += 1;
    const guide = retainedIntakeControlGuide.find((entry) =>
      entry.page === "profile" && entry.identity === control.fieldId
    );
    const unknown = control.fieldId.startsWith("unknown.");
    const options = observedOptions(control.fieldId);
    const visibleOptionIds = optionIds(options);
    const selectedOptionId = control.readback === null
      ? null
      : visibleOptionIds[options.indexOf(control.readback)] ?? null;
    return {
      observation: {
        controlId: control.controlId,
        binderStrategy: unknown ? "opaque_machine_key" as const :
          "catalog_selector_exact" as const,
        sanitizedLabelSha256: guide?.sanitizedLabel == null
          ? null
          : retainedIntakeTextSha256(guide.sanitizedLabel),
        backingState: control.readback === null ? "unset" as const : "set" as const,
        validationState: "clear" as const,
        optionCatalogState: unknown
          ? "unknown" as const
          : options.length > 0
          ? "observed" as const
          : isChoiceBehavior(control.uiBehavior)
          ? "unknown" as const
          : "not_applicable" as const,
        visibleOptionIds,
        selectedOptionId,
      },
      binding: observationBinding(index),
    };
  };
}

function knownObservation(
  identity: string,
  index: number,
  overrides: { readonly backingState?: "set" | "unset" } = {},
) {
  const guide = retainedIntakeControlGuide.find((entry) =>
    entry.page === "profile" && entry.identity === identity
  );
  if (guide === undefined) throw new TypeError(`missing retained guide ${identity}`);
  return {
    binderStrategy: "catalog_selector_exact" as const,
    sanitizedLabelSha256: guide.sanitizedLabel === null
      ? null
      : retainedIntakeTextSha256(guide.sanitizedLabel),
    metadataReconciliation: "matched" as const,
    backingState: overrides.backingState ?? "unset" as const,
    validationState: "clear" as const,
    optionCatalogState: guide.allowedOptions.length > 0
      ? "observed" as const
      : isChoiceBehavior(guide.behavior)
      ? "unknown" as const
      : "not_applicable" as const,
    observationBinding: observationBinding(index),
  };
}

function repeatableObservation(index: number) {
  return {
    binderStrategy: "catalog_selector_exact" as const,
    sanitizedLabelSha256: null,
    metadataReconciliation: "matched" as const,
    backingState: "unset" as const,
    validationState: "clear" as const,
    optionCatalogState: "not_applicable" as const,
    observationBinding: observationBinding(index),
  };
}

function unknownObservation(index: number) {
  return {
    binderStrategy: "opaque_machine_key" as const,
    sanitizedLabelSha256: null,
    metadataReconciliation: "unresolved" as const,
    backingState: "unset" as const,
    validationState: "clear" as const,
    optionCatalogState: "unknown" as const,
    observationBinding: observationBinding(index),
  };
}

function observedOptions(fieldId: string): readonly string[] {
  switch (fieldId) {
    case "address.country": return ["Canada", "United States"];
    case "employment.previously_worked_for_organization": return ["Yes", "No"];
    default: return [];
  }
}

function optionIds(options: readonly string[]): readonly string[] {
  return options.map((value) => `option_sha256_${retainedIntakeTextSha256(value)}`);
}

function isChoiceBehavior(behavior: string): boolean {
  return ["search_select", "select", "multi_select", "radio", "radio_group", "checkbox"]
    .includes(behavior);
}

function operation(index: number): string {
  return `operation_profile_learning_${String(index).padStart(4, "0")}`;
}

function monitor(
  controlId: string,
  index: number,
  moment: "before_mutation" | "after_readback",
) {
  return { controlId, operationId: operation(index), attempt: index, moment } as const;
}

function binding(index: number) {
  return {
    operationId: operation(index),
    attempt: index,
    beforeMutationAck: true,
    afterReadbackAck: true,
  } as const;
}

function observationBinding(index: number) {
  return {
    operationId: operation(index),
    attempt: index,
    stateObservedAck: true,
  } as const;
}

function mechanics(
  behavior: "text" | "search_select" | "radio_group",
  persistentReadback: string,
) {
  const popup = behavior === "search_select";
  const choice = popup || behavior === "radio_group";
  return {
    popupBound: popup ? "not_observed" : "not_applicable",
    optionFocused: popup ? "not_observed" : "not_applicable",
    optionActivated: choice ? "not_observed" : "not_applicable",
    popupClosed: popup ? "not_observed" : "not_applicable",
    backingValueCommitted: "not_observed",
    validationCleared: "not_observed",
    persistentReadback,
  };
}

function snapshot(country: string | null): ProfilePageSnapshot {
  return {
    pageType: "profile",
    controls: [
      {
        controlId: "name-control",
        fieldId: "identity.given_name",
        required: true,
        uiBehavior: "text",
        uiVariant: "workday_text_v2",
        readback: "Ada",
      },
      {
        controlId: "country-control",
        fieldId: "address.country",
        required: true,
        uiBehavior: "search_select",
        uiVariant: "workday_search_select_v2",
        readback: country,
      },
      {
        controlId: "unknown-required:1",
        fieldId: "unknown.required.1",
        required: true,
        uiBehavior: "text",
        uiVariant: "workday_unknown_required_v1",
        readback: null,
      },
    ],
    rows: [],
  };
}

function repeatableSnapshot(
  rowIds: readonly string[],
  rowAReadback = "Original",
): ProfilePageSnapshot {
  return {
    pageType: "profile",
    controls: [],
    rows: rowIds.map((rowId) => ({
      rowId,
      section: "experience" as const,
      ownedByC3: true,
      controls: [{
        controlId: `${rowId}-company`,
        fieldId: "experience.company",
        required: true,
        uiBehavior: "text" as const,
        uiVariant: "workday_text_v1",
        readback: rowId === "row-a" ? rowAReadback : "Other",
      }],
    })),
  };
}

function profilePlan(): ProfilePagePlan {
  return {
    mode: "live",
    pageType: "profile",
fields: [
      {
        fieldId: "identity.given_name",
        questionType: "identity",
        answerType: "text",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "Ada",
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
      },
      {
        fieldId: "address.country",
        questionType: "address",
        answerType: "option",
        allowedOptions: ["United States"],
        answer: {
          kind: "answered",
          value: "US",
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
        optionMapping: {
          canonicalValue: "US",
          visibleOption: "United States",
          provenance: "visible_option",
        },
      },
    ],
    repeatables: [{
      section: "experience",
      rows: [{
        rowKey: "experience-1",
        fields: [{
          fieldId: "experience.company",
          questionType: "employment",
          answerType: "text",
          allowedOptions: [],
          answer: {
            kind: "answered",
            value: "Original",
            provenance: "resume_verified",
            lane: "live_owner_fact",
          },
        }],
      }],
    }],
  };
}
