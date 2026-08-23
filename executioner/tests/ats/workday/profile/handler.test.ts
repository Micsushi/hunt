import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyProfileInspectionFailure,
  completeWorkdayProfilePage,
  profileInspectionDiagnostic,
  type ProfileControlSnapshot,
  type ProfileFieldPlan,
  type ProfilePagePlan,
  type ProfilePageSnapshot,
  type ProfileRepeatableSection,
  type WorkdayProfilePagePort,
} from "../../../../src/ats/workday/application/profile/index.ts";
import {
  createProfileInspectionFailure,
  profileInspectionFailureFromError,
} from "../../../../src/ats/workday/application/profile/inspection.ts";

const answered = (
  value: string,
  provenance: "owner_provided" | "resume_verified" = "owner_provided",
) => ({
  kind: "answered" as const,
  value,
  provenance,
  lane: "live_owner_fact" as const,
});

const field = (
  fieldId: string,
  questionType: ProfileFieldPlan["questionType"],
  answerType: ProfileFieldPlan["answerType"],
  value: string,
  provenance: "owner_provided" | "resume_verified" = "owner_provided",
  visibleOption?: string,
): ProfileFieldPlan => ({
  fieldId,
  questionType,
  answerType,
  allowedOptions: visibleOption === undefined ? [] : [visibleOption],
  answer: answered(value, provenance),
  ...(visibleOption === undefined
    ? {}
    : {
        optionMapping: {
          canonicalValue: value,
          visibleOption,
          provenance: "visible_option" as const,
        },
      }),
});

const control = (
  fieldId: string,
  behavior: ProfileControlSnapshot["uiBehavior"],
  readback: string | null = null,
  variant = `workday_${behavior}_v1`,
): ProfileControlSnapshot => ({
  controlId: `control-${fieldId}`,
  fieldId,
  required: true,
  uiBehavior: behavior,
  uiVariant: variant,
  readback,
});

test("fills identity, address, phone, dates, and search-selects with independent verification", async () => {
  const plan: ProfilePagePlan = {
    mode: "live",
    pageType: "contact",
    fields: [
      field("identity.given_name", "identity", "text", "Ada"),
      field("address.country", "address", "option", "CA", "owner_provided", "Canada"),
      field("phone.number", "phone", "phone", "+1 555 0100"),
      field("experience.start_date", "experience", "date", "2021-03-01", "resume_verified"),
    ],
    repeatables: [],
  };
  const port = new MemoryProfilePage({
    pageType: "contact",
    controls: [
      control("identity.given_name", "text"),
      control("address.country", "search_select"),
      control("phone.number", "phone"),
      control("experience.start_date", "date"),
    ],
    rows: [],
  });

  const result = await completeWorkdayProfilePage(plan, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified");
  if (result.kind !== "verified") return;
  assert.equal(result.pageType, "contact");
  assert.equal(result.ownedDuplicateRows, 0);
  assert.deepEqual(port.commits.map(({ uiBehavior, value }) => [uiBehavior, value]), [
    ["text", "Ada"],
    ["search_select", "Canada"],
    ["phone", "+1 555 0100"],
    ["date", "2021-03-01"],
  ]);
  assert.deepEqual(result.verifiedFields, [
    {
      fieldId: "identity.given_name",
      questionType: "identity",
      answerType: "text",
      uiBehavior: "text",
      uiVariant: "workday_text_v1",
      provenance: "owner_provided",
      lane: "live_owner_fact",
    },
    {
      fieldId: "address.country",
      questionType: "address",
      answerType: "option",
      uiBehavior: "search_select",
      uiVariant: "workday_search_select_v1",
      provenance: "owner_provided",
      lane: "live_owner_fact",
      optionMappingProvenance: "visible_option",
    },
    {
      fieldId: "phone.number",
      questionType: "phone",
      answerType: "phone",
      uiBehavior: "phone",
      uiVariant: "workday_phone_v1",
      provenance: "owner_provided",
      lane: "live_owner_fact",
    },
    {
      fieldId: "experience.start_date",
      questionType: "experience",
      answerType: "date",
      uiBehavior: "date",
      uiVariant: "workday_date_v1",
      provenance: "resume_verified",
      lane: "live_owner_fact",
    },
  ]);
  assert.ok(port.inspections >= port.commits.length + 1);
});

test("converts a typed metadata mismatch into non-submittable UI learning", async () => {
  let commits = 0;
  const failure = {
    code: "profile_metadata_reconciliation_failed" as const,
    mismatches: [{
      fieldId: "profile.address.country",
      uiBehavior: "search_select" as const,
      uiVariant: "workday_search_select_v2",
      reasons: ["option_catalog" as const],
    }],
  };
  const page: WorkdayProfilePagePort = {
    async inspect() {
      throw new TypeError("profile metadata reconciliation failed");
    },
    metadataReconciliationFailure: () => failure,
    async commit() { commits += 1; },
    async addOwnedRow() { throw new TypeError("not used"); },
    async removeOwnedRow() { throw new TypeError("not used"); },
  };
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [field("address.country", "address", "option", "CA", "owner_provided", "Canada")],
    repeatables: [],
  }, page, AbortSignal.any([]));

  assert.deepEqual(result, {
    kind: "blocked",
    code: "profile_metadata_reconciliation_failed",
    metadataReconciliationFailure: failure,
    learningConversion: {
      kind: "profile_ui_learning",
      executionMode: "synthetic_test_non_submittable",
      testOnly: true,
      mutationAllowed: false,
      defaultsGenerated: false,
      liveAcceptanceEligible: false,
      fieldIds: ["profile.address.country"],
    },
  });
  assert.equal(commits, 0);
});

test("observes the page before a missing required fact stops mutation", async () => {
  const port = new MemoryProfilePage({ pageType: "profile", controls: [], rows: [] });
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [{
      fieldId: "identity.family_name",
      questionType: "identity",
      answerType: "text",
      allowedOptions: [],
      answer: { kind: "profile_answer_missing" },
    }],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.deepEqual(result, {
    kind: "blocked",
    code: "profile_answer_missing",
    fieldId: "identity.family_name",
  });
  assert.equal(port.inspections, 1);
  assert.equal(port.commits.length, 0);
});

test("accepts a tenant CELL readback for the canonical Mobile phone device type", async () => {
  const plan: ProfilePagePlan = {
    mode: "live",
    pageType: "profile",
    fields: [field("phone.device_type", "phone", "option", "Mobile", "owner_provided", "Mobile")],
    repeatables: [],
  };
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [control("phone.device_type", "search_select", "CELL", "workday_search_select_v2")],
    rows: [],
  });

  const result = await completeWorkdayProfilePage(plan, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified");
  assert.equal(port.commits.length, 0);
});

test("retries a transient read-only inspection after a committed field", async () => {
  let failuresRemaining = 1;
  let port!: MemoryProfilePage;
  port = new MemoryProfilePage({
    pageType: "profile",
    controls: [control("identity.given_name", "text")],
    rows: [],
  }, {
    inspectFailure: () =>
      port.commits.length === 1 && port.inspections >= 3 && failuresRemaining-- > 0,
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [field("identity.given_name", "identity", "text", "Ada")],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(port.commits.length, 1);
  assert.ok(port.inspections >= 4);
});

test("retains value-free typed diagnostics for liveness, binding, and unknown inspection failures", () => {
  const cases = [
    {
      error: new Error("Target page, context or browser has been closed"),
      classification: "liveness" as const,
    },
    {
      error: new TypeError("Workday profile control binding is missing"),
      classification: "dom_owner_binding" as const,
    },
    {
      error: new Error("opaque profile inspection backend fault"),
      classification: "unknown" as const,
    },
  ];

  for (const { error, classification } of cases) {
    assert.equal(classifyProfileInspectionFailure(error), classification);
    const diagnostic = profileInspectionDiagnostic(error, {
      classification,
      phase: "scalar",
      bindingIds: ["identity.given_name"],
      bindingPaths: ["profile.scalar"],
      bindingDigests: ["a".repeat(64)],
    }, 4, 1_000, 1_002);

    assert.deepEqual(diagnostic, {
      classification,
      phase: "scalar",
      bindingIds: ["identity.given_name"],
      bindingPaths: ["profile.scalar"],
      bindingDigests: ["a".repeat(64)],
      retryCount: 4,
      deadlineMs: 1_000,
      elapsedMs: 1_002,
    });
    assert.doesNotMatch(JSON.stringify(diagnostic), /opaque|closed|missing|secret|Ada/u);
  }
});

test("preserves the sanitized unknown-control denial through inspection wrapping", () => {
  const wrap = (message: string) => createProfileInspectionFailure(
    new TypeError(message),
    "unknown_controls",
    ["unknown_controls"],
    ["profile.unknown_controls"],
    ["profile.interactive"],
    (value) => value,
  );

  const identityDenied = wrap("Workday unknown required control identity denied");
  assert.equal(identityDenied.message, "Workday unknown required control identity denied");
  assert.equal(profileInspectionFailureFromError(identityDenied)?.phase, "unknown_controls");
  assert.equal(wrap("opaque profile inspection backend fault").message, "profile inspection failed");
});

for (const missing of [
  {
    fieldId: "source.how_did_you_hear",
    questionType: "application_source",
    uiBehavior: "search_select",
    uiVariant: "workday_source_select_v1",
  },
  {
    fieldId: "employment.previously_worked_for_organization",
    questionType: "prior_employment",
    uiBehavior: "radio_group",
    uiVariant: "workday_previous_worker_radio_v1",
  },
] as const) {
  test(`requires owner input for ${missing.fieldId} before browser mutation`, async () => {
    const port = new MemoryProfilePage({
      pageType: "profile",
      controls: [control(
        missing.fieldId,
        missing.uiBehavior,
        null,
        missing.uiVariant,
      )],
      rows: [],
    });

    assert.deepEqual(await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
      fields: [{
        fieldId: missing.fieldId,
        questionType: missing.questionType,
        answerType: "option",
        allowedOptions: missing.questionType === "prior_employment" ? ["Yes", "No"] : [],
        answer: { kind: "profile_answer_missing" },
      }],
      repeatables: [],
    }, port, AbortSignal.any([])), {
      kind: "blocked",
      code: "profile_answer_missing",
      fieldId: missing.fieldId,
    });
    assert.equal(port.inspections, 1);
    assert.equal(port.commits.length, 0);
  });
}

test("a generated prior-employment default requires owner input before mutation", async () => {
  const fieldId = "employment.previously_worked_for_organization";
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [control(
      fieldId,
      "radio_group",
      null,
      "workday_previous_worker_radio_v1",
    )],
    rows: [],
  });

  assert.deepEqual(await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [{
      fieldId,
      questionType: "prior_employment",
      answerType: "option",
      allowedOptions: ["Yes", "No"],
      answer: {
        kind: "answered",
        value: "false",
        provenance: "generated_default",
        lane: "synthetic_test_default",
      },
      optionMapping: {
        canonicalValue: "false",
        visibleOption: "No",
        provenance: "visible_option",
      },
    }],
    repeatables: [],
  }, port, AbortSignal.any([])), {
    kind: "blocked",
    code: "profile_answer_provenance_denied",
    fieldId,
  });
  assert.equal(port.inspections, 1);
  assert.equal(port.commits.length, 0);
});

test("unresolved tenant owner inputs do not block a tenant where their controls are absent", async () => {
  const port = new MemoryProfilePage({ pageType: "profile", controls: [], rows: [] });
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [
      {
        fieldId: "source.how_did_you_hear",
        questionType: "application_source",
        answerType: "option",
        allowedOptions: [],
        answer: { kind: "profile_answer_missing" },
      },
      {
        fieldId: "employment.previously_worked_for_organization",
        questionType: "prior_employment",
        answerType: "option",
        allowedOptions: ["Yes", "No"],
        answer: { kind: "profile_answer_missing" },
      },
    ],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(port.commits.length, 0);
});

test("a derived email answer is skipped when the tenant renders email as display-only", async () => {
  const port = new MemoryProfilePage({ pageType: "profile", controls: [], rows: [] });
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [field("contact.email", "identity", "text", "owner-email-redacted")],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(port.commits.length, 0);
});

test("maps exact owner source and prior-employment options", async () => {
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [
      control(
        "source.how_did_you_hear",
        "search_select",
        null,
        "workday_source_select_v1",
      ),
      control(
        "employment.previously_worked_for_organization",
        "radio_group",
        null,
        "workday_previous_worker_radio_v1",
      ),
    ],
    rows: [],
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [
      field(
        "source.how_did_you_hear",
        "application_source",
        "option",
        "company-website",
        "owner_provided",
        "Company Website",
      ),
      field(
        "employment.previously_worked_for_organization",
        "prior_employment",
        "option",
        "false",
        "owner_provided",
        "No",
      ),
    ],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.deepEqual(port.commits.map(({ uiBehavior, value }) => [uiBehavior, value]), [
    ["search_select", "Company Website"],
    ["radio_group", "No"],
  ]);
});

test("rejects journey-derived source and employment answers in live mode", async () => {
  const source = field(
    "source.how_did_you_hear",
    "application_source",
    "option",
    "company-website",
    "owner_provided",
    "Company Website",
  );
  const derivedSource = {
    ...source,
    answer: {
      ...source.answer,
      provenance: "journey_derived" as const,
      lane: "synthetic_test_default" as const,
    },
  };
  const sourcePort = new MemoryProfilePage({
    pageType: "profile",
    controls: [control("source.how_did_you_hear", "search_select", "")],
    rows: [],
  });

  const sourceResult = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [derivedSource],
    repeatables: [],
  }, sourcePort, AbortSignal.any([]));
  assert.equal(sourceResult.kind, "blocked", JSON.stringify(sourceResult));
  assert.equal(sourcePort.commits.length, 0);

  const prior = field(
    "employment.previously_worked_for_organization",
    "prior_employment",
    "option",
    "false",
    "owner_provided",
    "No",
  );
  const rejected = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [{
      ...prior,
      answer: {
        kind: "answered",
        value: "false",
        provenance: "journey_derived" as const,
        lane: "synthetic_test_default" as const,
      },
    }],
    repeatables: [],
  }, new MemoryProfilePage({ pageType: "profile", controls: [], rows: [] }), AbortSignal.any([]));
  assert.deepEqual(rejected, {
    kind: "blocked",
    code: "profile_answer_provenance_denied",
    fieldId: "employment.previously_worked_for_organization",
  });
});

test("semantically correct option prefills are verified without mutation", async () => {
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [
      control("address.country", "search_select", "  Canada  "),
      control(
        "employment.previously_worked_for_organization",
        "radio_group",
        "No",
        "workday_previous_worker_radio_v1",
      ),
    ],
    rows: [],
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [
      field("address.country", "address", "option", "CA", "owner_provided", "Canada"),
      field(
        "employment.previously_worked_for_organization",
        "prior_employment",
        "option",
        "false",
        "owner_provided",
        "No",
      ),
    ],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(port.commits.length, 0);
});

test("rejects a driver success when fresh visible readback does not match", async () => {
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [control("identity.family_name", "text")],
    rows: [],
  }, { ignoreCommits: true });
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [field("identity.family_name", "identity", "text", "Lovelace")],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.deepEqual(result, {
    kind: "blocked",
    code: "profile_commit_unverified",
    fieldId: "identity.family_name",
  });
  assert.equal(port.commits.length, 1);
  assert.equal(port.inspections, 2);
});

test("continues after an optional tenant widget rejects its configured default", async () => {
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [{
      ...control("education.field_of_study", "multi_select"),
      required: false,
    }],
    rows: [],
  }, { ignoreCommits: true });
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [field(
      "education.field_of_study",
      "education",
      "multi_select",
      '["Computer Science"]',
      "resume_verified",
      '["Computer Science"]',
    )],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  if (result.kind !== "verified") return;
  assert.deepEqual(result.verifiedFields, []);
  assert.equal(port.commits.length, 1);
});

test("continues a repeatable row after an optional tenant widget rejects its default", async () => {
  const study = field(
    "education.field_of_study",
    "education",
    "multi_select",
    '["Computer Science"]',
    "resume_verified",
    '["Computer Science"]',
  );
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [{
      section: "education",
      rowId: "existing-education",
      ownedByC3: false,
      controls: [{
        ...control("education.field_of_study", "multi_select"),
        required: false,
      }],
    }],
    repeatableSections: ["education"],
  }, { ignoreCommits: true });
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [{
      section: "education",
      rows: [{ rowKey: "education_1", fields: [study] }],
    }],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  if (result.kind !== "verified") return;
  assert.deepEqual(result.verifiedFields, []);
  assert.equal(port.commits.length, 1);
});

test("reconciles repeatables without deleting foreign rows or creating duplicates", async () => {
  const experience = [
    field("experience.company", "experience", "text", "Analytical Engines", "resume_verified"),
    field("experience.title", "experience", "text", "Programmer", "resume_verified"),
  ];
  const education = [
    field("education.school", "education", "text", "University of London", "resume_verified"),
    field("education.end_date", "education", "date", "1835-06-01", "resume_verified"),
  ];
  const skill = [
    field("skills.name", "skill", "option", "TypeScript", "resume_verified", "TypeScript"),
  ];
  const plan: ProfilePagePlan = {
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [
      { section: "experience", rows: [{ rowKey: "experience-1", fields: experience }] },
      { section: "education", rows: [{ rowKey: "education-1", fields: education }] },
      { section: "skills", rows: [{ rowKey: "skill-1", fields: skill }] },
    ],
  };
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [
      row("experience", "foreign-experience", false, experience),
      row("education", "foreign-education", false, education),
      row("education", "owned-duplicate", true, education),
      row("skills", "owned-empty", true, skill, true),
    ],
  }, {
    rowTemplates: {
      experience,
      education,
      skills: skill,
    },
  });

  const first = await completeWorkdayProfilePage(plan, port, AbortSignal.any([]));
  assert.equal(first.kind, "verified");
  if (first.kind === "verified") {
    assert.deepEqual(
      first.verifiedFields.filter(({ rowKey }) => rowKey !== undefined),
      [
        verifiedRow("experience.company", "experience", "text", "text", "experience-1"),
        verifiedRow("experience.title", "experience", "text", "text", "experience-1"),
        verifiedRow("education.school", "education", "text", "text", "education-1"),
        verifiedRow("education.end_date", "education", "date", "date", "education-1"),
        {
          fieldId: "skills.name",
          questionType: "skill",
          answerType: "option",
          uiBehavior: "search_select",
          uiVariant: "workday_search_select_v1",
          provenance: "resume_verified",
          lane: "live_owner_fact",
          optionMappingProvenance: "visible_option",
          rowKey: "skill-1",
        },
      ],
    );
  }
  assert.deepEqual(port.removed, [
    ["education", "owned-duplicate"],
    ["skills", "owned-empty"],
  ]);
  assert.equal(port.added.length, 1);
  assert.equal(port.added[0], "skills");
  assert.equal(port.snapshot.rows.some(({ rowId }) => rowId === "foreign-experience"), true);
  assert.equal(port.snapshot.rows.some(({ rowId }) => rowId === "foreign-education"), true);

  const additions = port.added.length;
  const removals = port.removed.length;
  const second = await completeWorkdayProfilePage(plan, port, AbortSignal.any([]));
  assert.equal(second.kind, "verified");
  assert.equal(port.added.length, additions);
  assert.equal(port.removed.length, removals);
  if (second.kind === "verified") assert.equal(second.ownedDuplicateRows, 0);
});

function verifiedRow(
  fieldId: string,
  questionType: ProfileFieldPlan["questionType"],
  answerType: ProfileFieldPlan["answerType"],
  uiBehavior: ProfileControlSnapshot["uiBehavior"],
  rowKey: string,
) {
  return {
    fieldId,
    questionType,
    answerType,
    uiBehavior,
    uiVariant: `workday_${uiBehavior}_v1`,
    provenance: "resume_verified",
    lane: "live_owner_fact",
    rowKey,
  } as const;
}

test("keeps classification layers independent and stops on an unreviewed UI variant", async () => {
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [control(
      "skills.name",
      "search_select",
      null,
      "workday_search_select_unreviewed",
    )],
    rows: [],
  });
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [field("skills.name", "skill", "option", "TypeScript", "resume_verified", "TypeScript")],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.deepEqual(result, {
    kind: "blocked",
    code: "profile_ui_variant_unreviewed",
    fieldId: "skills.name",
    uiVariant: "workday_search_select_unreviewed",
  });
  assert.equal(port.commits.length, 0);
});

test("rejects invented provenance after one nonmutating page inspection", async () => {
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [control("identity.given_name", "text")],
    rows: [],
  });
  const plan = {
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
        provenance: "invented",
        lane: "live_owner_fact",
      },
    }],
    repeatables: [],
  } as unknown as ProfilePagePlan;

  assert.deepEqual(
    await completeWorkdayProfilePage(plan, port, AbortSignal.any([])),
    { kind: "blocked", code: "profile_plan_invalid", fieldId: "identity.given_name" },
  );
  assert.equal(port.inspections, 1);
});

test("stops before mutation when an observed required field has no authoritative plan", async () => {
  const port = new MemoryProfilePage({
    pageType: "contact",
    controls: [
      control("identity.given_name", "text"),
      control("address.city", "text"),
    ],
    rows: [],
  });

  assert.deepEqual(
    await completeWorkdayProfilePage({
      mode: "live",
      pageType: "contact",
      fields: [field("identity.given_name", "identity", "text", "Ada")],
      repeatables: [],
    }, port, AbortSignal.any([])),
    { kind: "blocked", code: "profile_answer_missing", fieldId: "address.city" },
  );
  assert.equal(port.inspections, 1);
  assert.equal(port.commits.length, 0);
});

test("classifies an unknown required profile control without exposing its identity", async () => {
  const port = new MemoryProfilePage({
    pageType: "contact",
    controls: [
      control("identity.given_name", "text"),
      control("unknown.required.1", "text", null, "workday_unknown_required_v1"),
    ],
    rows: [],
  });

  assert.deepEqual(
    await completeWorkdayProfilePage({
      mode: "live",
      pageType: "contact",
      fields: [field("identity.given_name", "identity", "text", "Ada")],
      repeatables: [],
    }, port, AbortSignal.any([])),
    {
      kind: "blocked",
      code: "answer_type_unknown",
      fieldId: "unknown.required.1",
      uiBehavior: "text",
      uiVariant: "workday_unknown_required_v1",
    },
  );
  assert.equal(port.commits.length, 0);
  assert.equal(port.added.length, 0);
  assert.equal(port.removed.length, 0);
});

test("rechecks required controls revealed after a scalar commit before the next mutation", async () => {
  let port!: MemoryProfilePage;
  port = new MemoryProfilePage({
    pageType: "contact",
    controls: [
      control("identity.given_name", "text"),
      control("identity.family_name", "text"),
    ],
    rows: [],
  }, {
    afterCommit: () => {
      if (port.commits.length !== 1) return;
      port.snapshot = {
        ...port.snapshot,
        controls: [
          ...port.snapshot.controls,
          control("unknown.required.1", "text", null, "workday_unknown_required_v1"),
        ],
      };
    },
  });

  assert.deepEqual(
    await completeWorkdayProfilePage({
      mode: "live",
      pageType: "contact",
      fields: [
        field("identity.given_name", "identity", "text", "Ada"),
        field("identity.family_name", "identity", "text", "Lovelace"),
      ],
      repeatables: [],
    }, port, AbortSignal.any([])),
    {
      kind: "blocked",
      code: "answer_type_unknown",
      fieldId: "unknown.required.1",
      uiBehavior: "text",
      uiVariant: "workday_unknown_required_v1",
    },
  );
  assert.deepEqual(port.commits.map(({ controlId }) => controlId), [
    "control-identity.given_name",
  ]);
  assert.equal(port.added.length, 0);
  assert.equal(port.removed.length, 0);
});

test("rejects invalid runtime classifications and non-opaque repeatable keys", async () => {
  const cases = [
    {
      mode: "live",
      pageType: "profile",
      fields: [{
        fieldId: "identity.given_name",
        questionType: "identity",
        answerType: "holding_value",
        answer: answered("Ada"),
      }],
      repeatables: [],
    },
    {
      mode: "live",
      pageType: "profile",
      fields: [],
      repeatables: [{
        section: "skills",
        rows: [{
          rowKey: "candidate@example.invalid",
          fields: [field("skills.name", "skill", "option", "typescript", "resume_verified", "TypeScript")],
        }],
      }],
    },
  ] as unknown as ProfilePagePlan[];

  for (const plan of cases) {
    const port = new MemoryProfilePage({ pageType: "profile", controls: [], rows: [] });
    const result = await completeWorkdayProfilePage(plan, port, AbortSignal.any([]));
    assert.equal(result.kind, "blocked");
    if (result.kind === "blocked") assert.equal(result.code, "profile_plan_invalid");
    assert.equal(port.inspections, 1);
  }
});

test("reports exact cancellation when the signal aborts during a field effect", async () => {
  const controller = new AbortController();
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [control("identity.given_name", "text")],
    rows: [],
  }, { afterCommit: () => controller.abort() });

  assert.deepEqual(
    await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
      fields: [field("identity.given_name", "identity", "text", "Ada")],
      repeatables: [],
    }, port, controller.signal),
    { kind: "blocked", code: "operation_cancelled" },
  );
});

test("stops when a repeatable row exposes an unplanned required subfield", async () => {
  const desired = [
    field("experience.company", "experience", "text", "Analytical Engines", "resume_verified"),
  ];
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [{
      section: "experience",
      rowId: "foreign-experience",
      ownedByC3: false,
      controls: [
        control("experience.company", "text", "Analytical Engines"),
        control("experience.end_date", "date"),
      ],
    }],
  });

  assert.deepEqual(
    await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
      fields: [],
      repeatables: [{
        section: "experience",
        rows: [{ rowKey: "experience-1", fields: desired }],
      }],
    }, port, AbortSignal.any([])),
    {
      kind: "blocked",
      code: "profile_answer_missing",
      fieldId: "experience.end_date",
    },
  );
  assert.equal(port.commits.length, 0);
});

test("preflights required repeatable fields before cleaning any owned row", async () => {
  const desired = [
    field("experience.company", "experience", "text", "Analytical Engines", "resume_verified"),
  ];
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [
      {
        section: "experience",
        rowId: "foreign-experience",
        ownedByC3: false,
        controls: [
          control("experience.company", "text", "Analytical Engines"),
          control("experience.start_date", "date"),
        ],
      },
      row("education", "owned-empty", true, [
        field("education.school", "education", "text", "Example", "resume_verified"),
      ], true),
    ],
  });

  assert.deepEqual(
    await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
      fields: [],
      repeatables: [{
        section: "experience",
        rows: [{ rowKey: "experience-1", fields: desired }],
      }],
    }, port, AbortSignal.any([])),
    {
      kind: "blocked",
      code: "profile_answer_missing",
      fieldId: "experience.start_date",
    },
  );
  assert.equal(port.commits.length, 0);
  assert.equal(port.added.length, 0);
  assert.equal(port.removed.length, 0);
});

test("binds heterogeneous repeatable requirements only to each selected row", async () => {
  const past = [
    field("experience.company", "experience", "text", "Past Company", "resume_verified"),
    field("experience.title", "experience", "text", "Engineer", "resume_verified"),
    field("experience.end_date", "experience", "date", "2024-01-31", "resume_verified"),
  ];
  const current = [
    field("experience.company", "experience", "text", "Current Company", "resume_verified"),
    field("experience.title", "experience", "text", "Senior Engineer", "resume_verified"),
  ];
  const unrelated = [
    field("experience.company", "experience", "text", "Preserved Company", "resume_verified"),
    field("experience.start_date", "experience", "date", "2018-01-01", "resume_verified"),
  ];
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [
      row("experience", "foreign-past", false, past),
      row("experience", "foreign-current", false, current),
      row("experience", "foreign-unrelated", false, unrelated),
    ],
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [{
      section: "experience",
      rows: [
        { rowKey: "experience-past", fields: past },
        { rowKey: "experience-current", fields: current },
      ],
    }],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified");
  assert.equal(port.commits.length, 0);
  assert.equal(port.added.length, 0);
  assert.equal(port.removed.length, 0);
  assert.equal(
    port.snapshot.rows.some(({ rowId }) => rowId === "foreign-unrelated"),
    true,
  );
});

test("reuses one semantic job when the tenant omits an optional subfield", async () => {
  const desired = [
    field("experience.company", "employment", "text", "Analytical Engines", "resume_verified"),
    field("experience.title", "employment", "text", "Engineer", "resume_verified"),
    field("experience.location", "employment", "text", "London", "resume_verified"),
  ];
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [{
      section: "experience",
      rowId: "tenant-job-1",
      ownedByC3: false,
      controls: [
        control("experience.company", "text", "Analytical Engines"),
        control("experience.title", "text", "Engineer"),
      ],
    }],
    repeatableSections: ["experience"],
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [{
      section: "experience",
      rows: [{ rowKey: "experience-1", fields: desired }],
    }],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(port.added.length, 0);
  assert.equal(port.commits.length, 0);
});

test("checks a current role and does not invent an end date after Workday removes it", async () => {
  const desired = [
    field("experience.company", "employment", "text", "Current Company", "resume_verified"),
    field("experience.title", "employment", "text", "Engineer", "resume_verified"),
    field("experience.current", "employment", "boolean", "true", "resume_verified"),
    field("experience.end_month", "employment", "month", "12", "resume_verified"),
    field("experience.end_year", "employment", "year", "2026", "resume_verified"),
  ];
  let port!: MemoryProfilePage;
  port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [{
      section: "experience",
      rowId: "current-job-1",
      ownedByC3: false,
      controls: [
        control("experience.company", "text", "Current Company"),
        control("experience.title", "text", "Engineer"),
        {
          ...control(
            "experience.current",
            "checkbox",
            "false",
            "workday_checkbox_v2",
          ),
          required: false,
        },
        control("experience.end_month", "month", "11"),
        control("experience.end_year", "year", "2025"),
      ],
    }],
    repeatableSections: ["experience"],
  }, {
    afterCommit: () => {
      if (port.commits.at(-1)?.controlId !== "control-experience.current") return;
      port.snapshot = {
        ...port.snapshot,
        rows: port.snapshot.rows.map((item) => ({
          ...item,
          controls: item.controls.filter(({ fieldId }) =>
            fieldId !== "experience.end_month" && fieldId !== "experience.end_year"
          ),
        })),
      };
    },
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [{
      section: "experience",
      rows: [{ rowKey: "experience-current", fields: desired }],
    }],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.deepEqual(port.commits.map(({ controlId, value }) => [controlId, value]), [
    ["control-experience.current", "true"],
  ]);
  assert.equal(port.added.length, 0);
});

test("defers repeatable data when the current UI state has no matching section", async () => {
  const desired = [
    field("experience.company", "experience", "text", "Analytical Engines", "resume_verified"),
  ];
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [],
    repeatableSections: [],
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [{
      section: "experience",
      rows: [{ rowKey: "experience-1", fields: desired }],
    }],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(port.added.length, 0);
});

test("rechecks required controls revealed by a repeatable add before filling the row", async () => {
  const desired = [
    field("experience.company", "experience", "text", "Analytical Engines", "resume_verified"),
  ];
  let port!: MemoryProfilePage;
  port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [],
  }, {
    rowTemplates: { experience: desired },
    afterAdd: () => {
      port.snapshot = {
        ...port.snapshot,
        controls: [
          ...port.snapshot.controls,
          control("unknown.required.1", "text", null, "workday_unknown_required_v1"),
        ],
      };
    },
  });

  assert.deepEqual(
    await completeWorkdayProfilePage({
      mode: "live",
      pageType: "profile",
      fields: [],
      repeatables: [{
        section: "experience",
        rows: [{ rowKey: "experience-1", fields: desired }],
      }],
    }, port, AbortSignal.any([])),
    {
      kind: "blocked",
      code: "answer_type_unknown",
      fieldId: "unknown.required.1",
      uiBehavior: "text",
      uiVariant: "workday_unknown_required_v1",
    },
  );
  assert.deepEqual(port.added, ["experience"]);
  assert.equal(port.commits.length, 0);
  assert.equal(port.removed.length, 0);
});

test("fills the tenant-provided blank first repeatable row before adding another", async () => {
  const desired = [
    field("experience.company", "employment", "text", "INVIDI Technologies", "resume_verified"),
    field("experience.title", "employment", "text", "Software Developer", "resume_verified"),
  ];
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [{
      ...row("experience", "workExperience-4", false, desired, true),
      controls: [
        ...row("experience", "workExperience-4", false, desired, true).controls,
        { ...control("experience.current", "checkbox", "false"), required: false },
      ],
    }],
    repeatableSections: ["experience"],
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [{
      section: "experience",
      rows: [{ rowKey: "experience_1", fields: desired }],
    }],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(port.added.length, 0);
  assert.deepEqual(port.commits.map(({ value }) => value), [
    "INVIDI Technologies",
    "Software Developer",
  ]);
});

test("accepts an unpadded Workday month readback for a zero-padded plan month", async () => {
  const desired = [
    field("experience.start_month", "employment", "month", "09", "resume_verified"),
  ];
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [{
      section: "experience",
      rowId: "workExperience-4",
      ownedByC3: false,
      controls: [control("experience.start_month", "month", "9", "workday_month_v1")],
    }],
    repeatableSections: ["experience"],
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [],
    repeatables: [{
      section: "experience",
      rows: [{ rowKey: "experience_1", fields: desired }],
    }],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.equal(port.commits.length, 0);
});

test("routes dedicated social URLs before deduplicated generic website rows", async () => {
  const linkedin = field(
    "social.linkedin",
    "social_network",
    "url",
    "https://www.linkedin.com/in/example",
  );
  const genericLinkedin = field(
    "website.url",
    "website",
    "url",
    "https://www.linkedin.com/in/example",
  );
  const portfolio = field(
    "website.url",
    "website",
    "url",
    "https://portfolio.example.com",
  );
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [{
      ...control("social.linkedin", "text", null, "workday_text_v2"),
      required: false,
    }],
    rows: [],
    repeatableSections: ["websites"],
  }, { rowTemplates: { websites: [portfolio] } });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [linkedin],
    repeatables: [{
      section: "websites",
      rows: [
        { rowKey: "website-linkedin", fields: [genericLinkedin] },
        { rowKey: "website-portfolio", fields: [portfolio] },
      ],
    }],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.deepEqual(port.added, ["websites"]);
  assert.deepEqual(port.commits.map(({ value }) => value), [
    "https://portfolio.example.com",
    "https://www.linkedin.com/in/example",
  ]);
});

test("canonicalizes a bare LinkedIn host for Workday URL validation", async () => {
  const linkedin = field(
    "social.linkedin",
    "social_network",
    "url",
    "https://linkedin.com/in/example",
  );
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [{
      ...control("social.linkedin", "text", null, "workday_text_v2"),
      required: false,
    }],
    rows: [],
  });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [linkedin],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.deepEqual(port.commits.map(({ value }) => value), [
    "https://www.linkedin.com/in/example",
  ]);
});

test("falls back from an absent dedicated social control to a generic website row", async () => {
  const linkedin = field(
    "social.linkedin",
    "social_network",
    "url",
    "https://www.linkedin.com/in/example",
  );
  const generic = field(
    "website.url",
    "website",
    "url",
    "https://www.linkedin.com/in/example",
  );
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [],
    rows: [],
    repeatableSections: ["websites"],
  }, { rowTemplates: { websites: [generic] } });

  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [linkedin],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.equal(result.kind, "verified", JSON.stringify(result));
  assert.deepEqual(port.added, ["websites"]);
  assert.deepEqual(port.commits.map(({ value }) => value), [
    "https://www.linkedin.com/in/example",
  ]);
});

function row(
  section: ProfileRepeatableSection,
  rowId: string,
  ownedByC3: boolean,
  fields: readonly ProfileFieldPlan[],
  empty = false,
) {
  return {
    section,
    rowId,
    ownedByC3,
    controls: fields.map((item) => control(
      item.fieldId,
      item.answerType === "date"
        ? "date"
        : item.answerType === "phone"
          ? "phone"
          : item.answerType === "option"
            ? "search_select"
            : "text",
      empty || item.answer.kind !== "answered"
        ? null
        : item.optionMapping?.visibleOption ?? item.answer.value,
    )),
  } as const;
}

class MemoryProfilePage implements WorkdayProfilePagePort {
  snapshot: ProfilePageSnapshot;
  inspections = 0;
  readonly commits: Array<{
    controlId: string;
    uiBehavior: ProfileControlSnapshot["uiBehavior"];
    value: string;
  }> = [];
  readonly added: ProfileRepeatableSection[] = [];
  readonly removed: Array<readonly [ProfileRepeatableSection, string]> = [];
  readonly #ignoreCommits: boolean;
  readonly #templates: Partial<Record<ProfileRepeatableSection, readonly ProfileFieldPlan[]>>;
  readonly #afterCommit: (() => void) | undefined;
  readonly #afterAdd: (() => void) | undefined;
  readonly #inspectFailure: (() => boolean) | undefined;

  constructor(
    snapshot: ProfilePageSnapshot,
    options: {
      readonly ignoreCommits?: boolean;
      readonly rowTemplates?: Partial<Record<ProfileRepeatableSection, readonly ProfileFieldPlan[]>>;
      readonly afterCommit?: () => void;
      readonly afterAdd?: () => void;
      readonly inspectFailure?: () => boolean;
    } = {},
  ) {
    this.snapshot = structuredClone(snapshot);
    this.#ignoreCommits = options.ignoreCommits ?? false;
    this.#templates = options.rowTemplates ?? {};
    this.#afterCommit = options.afterCommit;
    this.#afterAdd = options.afterAdd;
    this.#inspectFailure = options.inspectFailure;
  }

  async inspect(): Promise<ProfilePageSnapshot> {
    this.inspections += 1;
    if (this.#inspectFailure?.()) throw new TypeError("transient inspect failure");
    return structuredClone(this.snapshot);
  }

  async commit(request: {
    readonly controlId: string;
    readonly uiBehavior: ProfileControlSnapshot["uiBehavior"];
    readonly value: string;
  }): Promise<void> {
    this.commits.push({ ...request });
    if (this.#ignoreCommits) {
      this.#afterCommit?.();
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      controls: this.snapshot.controls.map((item) =>
        item.controlId === request.controlId
          ? { ...item, readback: request.value }
          : item
      ),
      rows: this.snapshot.rows.map((current) => ({
        ...current,
        controls: current.controls.map((item) =>
          item.controlId === request.controlId
            ? { ...item, readback: request.value }
            : item
        ),
      })),
    };
    this.#afterCommit?.();
  }

  async addOwnedRow(section: ProfileRepeatableSection): Promise<string> {
    this.added.push(section);
    const rowId = `owned-${section}-${this.added.length}`;
    const template = this.#templates[section] ?? [];
    this.snapshot = {
      ...this.snapshot,
      rows: [...this.snapshot.rows, row(section, rowId, true, template, true)],
    };
    this.#afterAdd?.();
    return rowId;
  }

  async removeOwnedRow(section: ProfileRepeatableSection, rowId: string): Promise<void> {
    const candidate = this.snapshot.rows.find((item) => item.rowId === rowId);
    assert.equal(candidate?.ownedByC3, true, "the handler may remove only C3-owned rows");
    this.removed.push([section, rowId]);
    this.snapshot = {
      ...this.snapshot,
      rows: this.snapshot.rows.filter((item) => item.rowId !== rowId),
    };
  }
}
