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

test("profile reconciliation preserves optional values and reads choices revealed on resume", async () => {
  const page = new MemoryProfilePage({
    pageType: "profile",
    controls: [
      { ...control("education.field_of_study", "multi_select"), required: false },
      { ...control("skills.values", "multi_select", '["Python"]'), required: false },
    ],
    rows: [],
  });
  const result = await completeWorkdayProfilePage({
    mode: "live",
    pageType: "profile",
    fields: [
      field("education.field_of_study", "education", "multi_select", '["Computer Science"]', "resume_verified", '["Computer Science"]'),
      field("skills.values", "skill", "multi_select", '["TypeScript"]', "resume_verified", '["TypeScript"]'),
    ],
    repeatables: [],
  }, page, AbortSignal.any([]));
  assert.equal(result.kind, "verified", JSON.stringify(result));
  if (result.kind !== "verified") return;
  assert.deepEqual(result.verifiedFields, []);
  assert.equal(page.commits.length, 0);
  assert.equal(page.snapshot.controls[1]!.readback, '["Python"]');

  const phone = { ...control("phone.device_type", "search_select", "Mobile"), allowedOptions: ["Mobile"] };
  const resumed = new MemoryProfilePage({pageType:"profile", controls:[phone], rows:[]});
  let firstRead = true;
  resumed.inspect = async () => {
    if (!firstRead) return resumed.snapshot;
    firstRead = false;
    return {...resumed.snapshot, controls:[]};
  };
  const continuation = await completeWorkdayProfilePage({mode:"live", pageType:"profile", fields:[], repeatables:[]},
    resumed, AbortSignal.any([]), "deterministic_site_valid_editable");
  assert.equal(continuation.kind, "verified");
  assert.deepEqual(resumed.commits.map(commit => commit.value), ["Mobile"]);
  assert.equal(resumed.snapshot.controls[0]?.readback, "Mobile");

  for (const [hasOwnerAnswer, readback, lateChange, accepted, writes] of [
    [true, null, false, true, ["Mobile"]], [true, "Mobile", false, true, []],
    [true, "Home", false, false, []], [false, null, false, false, []],
    [true, null, true, false, []],
  ] as const) {
    const live = new MemoryProfilePage({pageType:"profile", controls:[{...phone, readback}], rows:[]});
    const inspect = live.inspect.bind(live);
    live.inspect = async () => {
      const current = await inspect();
      if (lateChange && live.inspections >= 3) {
        return {...current, controls:[{...phone, readback:"Home"}]};
      }
      return live.inspections === 1 ? {...current, controls:[]} : current;
    };
    const ownerField = field("phone.device_type", "phone", "single_select", "Mobile", "owner_provided", "Mobile");
    const outcome = await completeWorkdayProfilePage({mode:"live", pageType:"profile",
      fields:hasOwnerAnswer ? [ownerField] : [], repeatables:[]}, live, AbortSignal.any([]), "owner_facts_only");
    assert.equal(outcome.kind, accepted ? "verified" : "blocked", JSON.stringify(outcome));
    assert.deepEqual(live.commits.map(commit => commit.value), writes);
  }
});

test("binds heterogeneous rows but stops for unmatched foreign history", async () => {
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

  assert.equal(result.kind, "blocked");
  if(result.kind === "blocked") assert.equal(result.code,"profile_row_unverified");
  assert.equal(port.commits.length, 0);
  assert.equal(port.added.length, 0);
  assert.equal(port.removed.length, 0);
  assert.equal(
    port.snapshot.rows.some(({ rowId }) => rowId === "foreign-unrelated"),
    true,
  );
});

test("checks a required current-role control and does not invent an end date after Workday removes it", async () => {
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
          required: true,
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

test("leaves optional unknown checkbox consent and workflow controls untouched even with saved owner answers", async () => {
  for (const initial of ["false", "true"]) {
    for (const explicit of [false, true]) {
      const port = new MemoryProfilePage({ pageType: "profile", rows: [], controls: [
        { ...control("unknown.optional.1", "checkbox", initial, "workday_unknown_required_v1"), required: false },
      ] });
      const result = await completeWorkdayProfilePage({
        mode: "synthetic_test_non_submittable", pageType: "profile", repeatables: [],
        fields: explicit ? [field("unknown.optional.1", "unknown", "boolean", "false")] : [],
      }, port, AbortSignal.any([]));
      assert.equal(result.kind, "verified", JSON.stringify(result));
      assert.equal(port.snapshot.controls[0]?.readback, initial);
      if (result.kind !== "verified") continue;
      assert.equal(result.verifiedFields.length, 0);
      assert.equal(result.committedFields.length, 0);
      assert.ok(result.committedFields.every(({ synthetic }) => !synthetic));
      assert.equal(port.commits.length, 0);
    }
  }
});

test("falls back from an absent dedicated social control to a required website row", async () => {
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
    requiredRepeatableSections: ["websites"],
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
    syntheticFile?: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array };
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
    readonly syntheticFile?: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array };
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
