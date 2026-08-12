import assert from "node:assert/strict";
import test from "node:test";

import {
  completeWorkdayProfilePage,
  type ProfileControlSnapshot,
  type ProfileFieldPlan,
  type ProfilePagePlan,
  type ProfilePageSnapshot,
  type ProfileRepeatableSection,
  type WorkdayProfilePagePort,
} from "../../../../src/ats/workday/application/profile/index.ts";

const answered = (
  value: string,
  provenance: "owner_provided" | "resume_verified" = "owner_provided",
) => ({ kind: "answered" as const, value, provenance });

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
    },
    {
      fieldId: "address.country",
      questionType: "address",
      answerType: "option",
      uiBehavior: "search_select",
      uiVariant: "workday_search_select_v1",
      provenance: "owner_provided",
      optionMappingProvenance: "visible_option",
    },
    {
      fieldId: "phone.number",
      questionType: "phone",
      answerType: "phone",
      uiBehavior: "phone",
      uiVariant: "workday_phone_v1",
      provenance: "owner_provided",
    },
    {
      fieldId: "experience.start_date",
      questionType: "experience",
      answerType: "date",
      uiBehavior: "date",
      uiVariant: "workday_date_v1",
      provenance: "resume_verified",
    },
  ]);
  assert.ok(port.inspections >= port.commits.length + 1);
});

test("stops on a missing required fact before browser inspection or mutation", async () => {
  const port = new MemoryProfilePage({ pageType: "profile", controls: [], rows: [] });
  const result = await completeWorkdayProfilePage({
    pageType: "profile",
    fields: [{
      fieldId: "identity.family_name",
      questionType: "identity",
      answerType: "text",
      answer: { kind: "profile_answer_missing" },
    }],
    repeatables: [],
  }, port, AbortSignal.any([]));

  assert.deepEqual(result, {
    kind: "blocked",
    code: "profile_answer_missing",
    fieldId: "identity.family_name",
  });
  assert.equal(port.inspections, 0);
  assert.equal(port.commits.length, 0);
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
      pageType: "profile",
      fields: [{
        fieldId: missing.fieldId,
        questionType: missing.questionType,
        answerType: "option",
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

test("unresolved tenant owner inputs do not block a tenant where their controls are absent", async () => {
  const port = new MemoryProfilePage({ pageType: "profile", controls: [], rows: [] });
  const result = await completeWorkdayProfilePage({
    pageType: "profile",
    fields: [
      {
        fieldId: "source.how_did_you_hear",
        questionType: "application_source",
        answerType: "option",
        answer: { kind: "profile_answer_missing" },
      },
      {
        fieldId: "employment.previously_worked_for_organization",
        questionType: "prior_employment",
        answerType: "option",
        answer: { kind: "profile_answer_missing" },
      },
    ],
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

test("accepts a journey-derived application source but no derived employment fact", async () => {
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
    answer: { ...source.answer, provenance: "journey_derived" as const },
  };
  const sourcePort = new MemoryProfilePage({
    pageType: "profile",
    controls: [control("source.how_did_you_hear", "search_select", "")],
    rows: [],
  });

  const accepted = await completeWorkdayProfilePage({
    pageType: "profile",
    fields: [derivedSource],
    repeatables: [],
  }, sourcePort, AbortSignal.any([]));
  assert.equal(accepted.kind, "verified", JSON.stringify(accepted));

  const prior = field(
    "employment.previously_worked_for_organization",
    "prior_employment",
    "option",
    "false",
    "owner_provided",
    "No",
  );
  const rejected = await completeWorkdayProfilePage({
    pageType: "profile",
    fields: [{
      ...prior,
      answer: {
        kind: "answered",
        value: "false",
        provenance: "journey_derived" as const,
      },
    }],
    repeatables: [],
  }, new MemoryProfilePage({ pageType: "profile", controls: [], rows: [] }), AbortSignal.any([]));
  assert.deepEqual(rejected, {
    kind: "blocked",
    code: "profile_plan_invalid",
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

test("rejects invented provenance at runtime before inspecting the page", async () => {
  const port = new MemoryProfilePage({
    pageType: "profile",
    controls: [control("identity.given_name", "text")],
    rows: [],
  });
  const plan = {
    pageType: "profile",
    fields: [{
      fieldId: "identity.given_name",
      questionType: "identity",
      answerType: "text",
      answer: { kind: "answered", value: "Ada", provenance: "invented" },
    }],
    repeatables: [],
  } as unknown as ProfilePagePlan;

  assert.deepEqual(
    await completeWorkdayProfilePage(plan, port, AbortSignal.any([])),
    { kind: "blocked", code: "profile_plan_invalid", fieldId: "identity.given_name" },
  );
  assert.equal(port.inspections, 0);
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
    assert.equal(port.inspections, 0);
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

  constructor(
    snapshot: ProfilePageSnapshot,
    options: {
      readonly ignoreCommits?: boolean;
      readonly rowTemplates?: Partial<Record<ProfileRepeatableSection, readonly ProfileFieldPlan[]>>;
      readonly afterCommit?: () => void;
      readonly afterAdd?: () => void;
    } = {},
  ) {
    this.snapshot = structuredClone(snapshot);
    this.#ignoreCommits = options.ignoreCommits ?? false;
    this.#templates = options.rowTemplates ?? {};
    this.#afterCommit = options.afterCommit;
    this.#afterAdd = options.afterAdd;
  }

  async inspect(): Promise<ProfilePageSnapshot> {
    this.inspections += 1;
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
