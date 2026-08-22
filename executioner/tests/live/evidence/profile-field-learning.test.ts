import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  admitProfileFieldLearningEvidence,
  createProfileFieldLearningCapture,
} from "../../../src/live/evidence/profile-field-learning.ts";
import type {
  ProfileCommitRequest,
  ProfilePagePlan,
  ProfilePageSnapshot,
  WorkdayProfilePagePort,
} from "../../../src/ats/workday/application/profile/index.ts";

test("retains value-free field learning through prefill, driver, and readback", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-profile-learning-"));
  const port = new FakeProfilePort(snapshot("Canada"));
  const capture = createProfileFieldLearningCapture({
    page: port,
    plan: profilePlan(),
    root,
    sensitiveValues: ["Ada", "Canada", "United States", "private@example.invalid"],
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
    assert.deepEqual(JSON.parse(text), {
      schemaVersion: 4,
      evidenceRevision: "s2-profile-field-learning-v4",
      page: "profile",
      executionMode: "live",
      testOnly: false,
      liveAcceptanceEligible: false,
      visibleControlCount: 3,
      fields: [
        {
          fieldIdentity: "profile.identity.given_name",
          uiType: "text",
          uiVariant: "workday_text_v1",
          questionCategory: "identity",
          answerCategory: "text",
          required: true,
          answerState: "answered",
          lane: "live_owner_fact",
          visibleOptionIds: [],
          selectedOptionId: null,
          optionMapping: "not_applicable",
          prefillDisposition: "already_correct",
          driverAttempt: "none",
          monitorBinding: null,
          terminalDisposition: "verified_without_mutation",
          mechanics: mechanics("text", "not_attempted"),
        },
        {
          fieldIdentity: "profile.address.country",
          uiType: "search_select",
          uiVariant: "workday_search_select_v1",
          questionCategory: "address",
          answerCategory: "option",
          required: true,
          answerState: "answered",
          lane: "live_owner_fact",
          visibleOptionIds: ["option_ref_01", "option_ref_02"],
          selectedOptionId: "option_ref_02",
          optionMapping: "owner_visible_option",
          prefillDisposition: "conflict",
          driverAttempt: "search_select",
          monitorBinding: binding(1),
          terminalDisposition: "verified",
          mechanics: {
            popupBound: "observed",
            optionFocused: "observed",
            optionActivated: "observed",
            popupClosed: "observed",
            backingValueCommitted: "observed",
            validationCleared: "observed",
            persistentReadback: "verified_after_rescan",
          },
        },
        {
          fieldIdentity: "profile.unknown.required.1",
          uiType: "text",
          uiVariant: "workday_unknown_required_v1",
          questionCategory: "unknown",
          answerCategory: "unknown",
          required: true,
          answerState: "unset",
          lane: null,
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
    sensitiveValues: ["linkedin"],
  });
  try {
    await capture.page.inspect(AbortSignal.any([]));
    assert.match(capture.write() ?? "", /^[0-9a-f]{64}$/u);
    const text = readFileSync(join(root, "profile-field-learning.json"), "utf8");
    assert.equal(text.includes('"linkedin"'), false);
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

test("admits reviewed website repeatable identities", () => {
  const admitted = admitProfileFieldLearningEvidence({
    schemaVersion: 4,
    evidenceRevision: "s2-profile-field-learning-v4",
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
      visibleOptionIds: [],
      selectedOptionId: null,
      optionMapping: "not_applicable",
      prefillDisposition: "blank",
      driverAttempt: "none",
      monitorBinding: observationBinding(1),
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
    schemaVersion: 4,
    evidenceRevision: "s2-profile-field-learning-v4",
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
});

test("admits a reviewed v2 variant for a duplicated scalar field identity", () => {
  const admitted = admitProfileFieldLearningEvidence({
    schemaVersion: 4,
    evidenceRevision: "s2-profile-field-learning-v4",
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
    schemaVersion: 4,
    evidenceRevision: "s2-profile-field-learning-v4",
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
    schemaVersion: 4 as const,
    evidenceRevision: "s2-profile-field-learning-v4" as const,
    page: "profile" as const,
    executionMode: "live" as const,
    testOnly: false as const,
    liveAcceptanceEligible: false as const,
    visibleControlCount: 1,
    fields: [{
      fieldIdentity: "profile.identity.given_name",
      uiType: "text" as const,
      uiVariant: "workday_text_v1",
      questionCategory: "identity" as const,
      answerCategory: "text" as const,
      required: true,
      answerState: "answered" as const,
      lane: "live_owner_fact" as const,
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
    { ...base, fields: [(() => {
      const { lane: _lane, ...field } = base.fields[0]!;
      return field;
    })()] },
    { ...base, fields: [{ ...base.fields[0], lane: "invalid" }] },
    { ...base, fields: [{ ...base.fields[0], lane: "synthetic_test_default" }] },
    {
      ...base,
      executionMode: "synthetic_test_non_submittable",
      testOnly: true,
      liveAcceptanceEligible: false,
    },
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
        uiVariant: "workday_text_v1",
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
        uiVariant: "workday_text_v1",
        readback: "Ada",
      },
      {
        controlId: "address-control",
        fieldId: "address.line1",
        required: false,
        uiBehavior: "text",
        uiVariant: "workday_text_v1",
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
    observationBinding: observationBinding(9),
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
    assert.deepEqual(evidence.fields.map(({ monitorBinding }) => monitorBinding), [
      observationBinding(9), observationBinding(9),
    ]);
    for (const mutate of [
      (value: any) => { value.fields[0].monitorBinding = null; },
      (value: any) => { value.fields[0].monitorBinding.operationId = "bad"; },
      (value: any) => { value.fields[0].monitorBinding.stateObservedAck = false; },
    ]) {
      const tampered = structuredClone(evidence) as any;
      mutate(tampered);
      assert.throws(() => admitProfileFieldLearningEvidence(tampered));
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
    answerCategory: "option" as const,
    required: true,
    answerState: "answered" as const,
    lane: "live_owner_fact" as const,
    visibleOptionIds: [] as const,
    selectedOptionId: null,
    optionMapping: "owner_visible_option" as const,
    prefillDisposition: "already_correct" as const,
    driverAttempt: "none" as const,
    monitorBinding: observationBinding(1),
    terminalDisposition: "verified_without_mutation" as const,
    mechanics: mechanics(input.uiType, "not_attempted"),
  };
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
        uiVariant: "workday_text_v1",
        readback: "Ada",
      },
      {
        controlId: "country-control",
        fieldId: "address.country",
        required: true,
        uiBehavior: "search_select",
        uiVariant: "workday_search_select_v1",
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
