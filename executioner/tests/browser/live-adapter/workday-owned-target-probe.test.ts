import assert from "node:assert/strict";
import { test } from "node:test";

import { liveFixtures } from "../../../src/testing/live/index.ts";
import { WorkdayOwnedTargetProbe } from "../../../src/browser/playwright-live/private/workday-owned-target-probe.ts";
import type { ApprovedTargetBinding } from "../../../src/browser/playwright-live/private/types.ts";

const expected: ApprovedTargetBinding = {
  identity: liveFixtures.target,
  approved: {
    host: "approved.wd5.myworkdayjobs.invalid",
    tenant: "approved",
    posting: "R12345",
  },
};

test("production probe distinguishes foreign pages and every exact target mismatch", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const cases = [
    ["https://careers.example.invalid/job/Example_R12345", { ownership: "foreign" }],
    [
      "https://approved.wd6.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
      owned({ kind: "target_mismatch", dimension: "host" }),
    ],
    [
      "https://other.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
      owned({ kind: "target_mismatch", dimension: "tenant" }),
    ],
    [
      "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R99999",
      owned({ kind: "target_mismatch", dimension: "posting" }),
    ],
  ] as const;

  for (const [url, result] of cases) {
    assert.deepEqual(
      await probe.inspect(new ProbePage(url), expected, new AbortController().signal),
      result,
    );
  }
});

test("production probe admits controlled Workday routes and emits only closed value-free facts", async () => {
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/apply/applyManually",
    {
      '[data-automation-id="createAccountPage"]': 1,
      '[data-automation-id="createAccountSubmitButton"]': 1,
      'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="radio"], [role="checkbox"]': 3,
      '[required], [aria-required="true"]': 3,
      '[role="option"]': 2,
    },
  );

  const result = await new WorkdayOwnedTargetProbe().inspect(
    page,
    expected,
    new AbortController().signal,
  );

  assert.deepEqual(result, owned(
    { kind: "matched" },
    [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_account_entry_v1",
      "structural_trait_account_create_v1",
    ],
    { controlCount: 3, requiredControlCount: 3, optionCount: 2 },
  ));
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "approved.wd5",
    "R12345",
    "createAccountPage",
    "selector",
    "raw",
    "url",
    "text",
    "dom",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("production probe preserves structural ambiguity, unknowns, and exact unavailability", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const url = "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/apply/applyManually";
  const ambiguous = await probe.inspect(new ProbePage(url, {
    '[data-automation-id="applyFlowMyInfoPage"]': 1,
    '[data-automation-id="applyFlowReviewPage"]': 1,
  }), expected, new AbortController().signal);
  assert.deepEqual(ambiguous, owned(
    { kind: "matched" },
    [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_profile_step_v1",
      "structural_trait_page_review_step_v1",
    ],
  ));

  const unknown = await probe.inspect(
    new ProbePage(url),
    expected,
    new AbortController().signal,
  );
  assert.deepEqual(unknown, owned(
    { kind: "matched" },
    ["structural_trait_ats_workday_family_v1"],
  ));

  for (const [selector, reason] of [
    ['[data-automation-id="jobNotFoundPage"]', "not_found"],
    ['[data-automation-id="jobClosedPage"]', "closed"],
    ['[data-automation-id="jobRemovedPage"]', "removed"],
    ['[data-automation-id="jobUnavailablePage"]', "unavailable"],
  ] as const) {
    const unavailable = await probe.inspect(
      new ProbePage(url, { [selector]: 1 }),
      expected,
      new AbortController().signal,
    );
    assert.deepEqual(unavailable, owned({ kind: "posting_unavailable", reason }));
  }
});

test("production probe fails ambiguous routes and contradictory unavailability closed", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const ambiguousRoute = await probe.inspect(
    new ProbePage(
      "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/other/Other_R99999",
    ),
    expected,
    new AbortController().signal,
  );
  assert.deepEqual(ambiguousRoute, owned({ kind: "target_ambiguous" }));

  const contradictory = await probe.inspect(
    new ProbePage(
      "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
      {
        '[data-automation-id="jobClosedPage"]': 1,
        '[data-automation-id="jobRemovedPage"]': 1,
      },
    ),
    expected,
    new AbortController().signal,
  );
  assert.deepEqual(contradictory, owned({ kind: "target_ambiguous" }));
});

test("production probe emits the closed apply-choice navigation trait", async () => {
  const result = await new WorkdayOwnedTargetProbe().inspect(
    new ProbePage(
      "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/apply",
      { '[data-automation-id="applyManually"]': 1 },
    ),
    expected,
    new AbortController().signal,
  );
  assert.equal(result.ownership, "owned");
  if (result.ownership !== "owned") return;
  assert.equal(result.target.kind, "matched");
  assert.deepEqual(result.snapshot.traitIds, [
    "structural_trait_ats_workday_family_v1",
    "structural_trait_navigation_apply_choice_v1",
  ]);
});

class ProbePage {
  readonly currentUrl: string;
  readonly counts: Readonly<Record<string, number>>;

  constructor(
    currentUrl: string,
    counts: Readonly<Record<string, number>> = {},
  ) {
    this.currentUrl = currentUrl;
    this.counts = counts;
  }

  url(): string {
    return this.currentUrl;
  }

  locator(selector: string): { count(): Promise<number> } {
    return { count: async () => this.counts[selector] ?? 0 };
  }

  async goto(): Promise<void> {}
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

function owned(
  target: Record<string, string>,
  traitIds: readonly string[] = ["structural_trait_ats_workday_family_v1"],
  counts: {
    readonly controlCount: number;
    readonly requiredControlCount: number;
    readonly optionCount: number;
  } = { controlCount: 0, requiredControlCount: 0, optionCount: 0 },
) {
  return {
    ownership: "owned" as const,
    target,
    snapshot: {
      schemaVersion: 1 as const,
      traitIds,
      ...counts,
    },
  };
}
