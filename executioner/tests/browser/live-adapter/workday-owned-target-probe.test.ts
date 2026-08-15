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

test("production probe owns a current three-digit Workday shard", async () => {
  const expected108: ApprovedTargetBinding = {
    identity: liveFixtures.target,
    approved: {
      host: "approved.wd108.myworkdayjobs.invalid",
      tenant: "approved",
      posting: "R12345",
    },
  };
  const result = await new WorkdayOwnedTargetProbe().inspect(
    new ProbePage(
      "https://approved.wd108.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
    ),
    expected108,
    new AbortController().signal,
  );
  assert.deepEqual(result, owned(
    { kind: "matched" },
    [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_job_posting_v1",
    ],
  ));
});

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
      'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="radio"], [role="checkbox"]': 3,
      '[required], [aria-required="true"]': 3,
      '[role="option"]': 2,
    },
    {
      'selector:[data-automation-id="email"]': 1,
      'selector:[data-automation-id="password"]': 1,
      'selector:[data-automation-id="verifyPassword"]': 1,
      'selector:[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="createAccountSubmitButton"]) [data-automation-id="click_filter"][role="button"]': 1,
      'selector:[data-automation-id="signInLink"]': 1,
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

test("production probe recognizes the exact semantic sign-in boundary", async () => {
  const result = await new WorkdayOwnedTargetProbe().inspect(
    new ProbePage(
      "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/apply/applyManually",
      {},
      {
        'selector:[data-automation-id="email"]': 1,
        'selector:[data-automation-id="password"]': 1,
        'selector:[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]': 1,
        'selector:[data-automation-id="createAccountLink"]': 1,
      },
    ),
    expected,
    new AbortController().signal,
  );

  assert.deepEqual(result, owned(
    { kind: "matched" },
    [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_account_entry_v1",
      "structural_trait_account_sign_in_v1",
    ],
  ));
});

test("only an exactly matched page may continue onto a posting-free account descendant", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/apply/applyManually",
    { '[data-automation-id="createAccountPage"]': 1 },
  );

  assert.equal(
    (await probe.inspect(page, expected, new AbortController().signal)).ownership,
    "owned",
  );
  page.currentUrl =
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/account/emailVerification";
  page.counts = { '[data-automation-id="emailVerificationPage"]': 1 };

  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned(
      { kind: "matched" },
      [
        "structural_trait_ats_workday_family_v1",
        "structural_trait_page_email_verification_v1",
      ],
    ),
  );
  assert.deepEqual(
    await new WorkdayOwnedTargetProbe().inspect(
      page,
      expected,
      new AbortController().signal,
    ),
    owned({ kind: "target_ambiguous" }),
  );
});

test("a target contradiction revokes posting-free lineage for that page", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  );
  assert.equal(
    (await probe.inspect(page, expected, new AbortController().signal)).ownership,
    "owned",
  );

  page.currentUrl =
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Other_R99999";
  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned({ kind: "target_mismatch", dimension: "posting" }),
  );

  page.currentUrl =
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/account/emailVerification";
  page.counts = { '[data-automation-id="emailVerificationPage"]': 1 };
  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned({ kind: "target_ambiguous" }),
  );
});

test("production probe treats Workday posting URL case as canonical", async () => {
  const result = await new WorkdayOwnedTargetProbe().inspect(
    new ProbePage(
      "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_r12345",
    ),
    expected,
    new AbortController().signal,
  );

  assert.deepEqual(result, owned(
    { kind: "matched" },
    [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_job_posting_v1",
    ],
  ));
});

test("a transient posting-free snapshot preserves exact lineage for a settled descendant", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  );
  assert.equal(
    (await probe.inspect(page, expected, new AbortController().signal)).ownership,
    "owned",
  );

  page.currentUrl = "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/apply";
  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned({ kind: "target_ambiguous" }),
  );

  page.counts = { '[data-automation-id="applyFlowMyInfoPage"]': 1 };
  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned(
      { kind: "matched" },
      [
        "structural_trait_ats_workday_family_v1",
        "structural_trait_page_profile_step_v1",
      ],
    ),
  );
});

test("posting-free lineage rejects conflicting descendant page types", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  );
  await probe.inspect(page, expected, new AbortController().signal);
  page.currentUrl =
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/account/emailVerification";
  page.counts = {
    '[data-automation-id="emailVerificationPage"]': 1,
    '[data-automation-id="candidateHomePage"]': 1,
  };

  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned(
      { kind: "target_ambiguous" },
      [
        "structural_trait_ats_workday_family_v1",
        "structural_trait_page_email_verification_v1",
        "structural_trait_page_candidate_home_v1",
      ],
    ),
  );
});

test("site route underscores before the job boundary are not posting identities", async () => {
  const result = await new WorkdayOwnedTargetProbe().inspect(
    new ProbePage(
      "https://approved.wd5.myworkdayjobs.invalid/en-US/External_Career/job/Example_R12345",
    ),
    expected,
    new AbortController().signal,
  );

  assert.deepEqual(result, owned(
    { kind: "matched" },
    [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_job_posting_v1",
    ],
  ));
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
    [':text-is("The page you are looking for doesn\'t exist.")', "not_found"],
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

  const corroboratedNotFound = await probe.inspect(
    new ProbePage(url, {
      '[data-automation-id="jobNotFoundPage"]': 1,
      ':text-is("The page you are looking for doesn\'t exist.")': 1,
    }),
    expected,
    new AbortController().signal,
  );
  assert.deepEqual(
    corroboratedNotFound,
    owned({ kind: "posting_unavailable", reason: "not_found" }),
  );
});

test("production probe recognizes Workday's typographic-apostrophe not-found page", async () => {
  const result = await new WorkdayOwnedTargetProbe().inspect(
    new ProbePage(
      "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
      { ':text-is("The page you are looking for doesn’t exist.")': 1 },
    ),
    expected,
    new AbortController().signal,
  );

  assert.deepEqual(
    result,
    owned({ kind: "posting_unavailable", reason: "not_found" }),
  );
});

test("production probe reloads an exact Workday maintenance redirect three times before classifying it", async () => {
  const maintenance = new ProbePage(
    "https://community.workday.com/maintenance-page?d=5&s=1&e=1&o=",
    {
      ':text-is("Workday is currently unavailable.")': 1,
      ':text-is("We are experiencing a service interruption.")': 1,
    },
  );

  assert.deepEqual(
    await new WorkdayOwnedTargetProbe().inspect(
      maintenance,
      expected,
      new AbortController().signal,
    ),
    owned({ kind: "posting_unavailable", reason: "maintenance" }),
  );
  assert.equal(maintenance.reloads, 3);

  maintenance.currentUrl = "https://community.workday.com/other";
  assert.deepEqual(
    await new WorkdayOwnedTargetProbe().inspect(
      maintenance,
      expected,
      new AbortController().signal,
    ),
    { ownership: "foreign" },
  );

  assert.deepEqual(
    await new WorkdayOwnedTargetProbe().inspect(
      new ProbePage(
        "https://community.workday.com/maintenance-page",
        { ':text-is("Workday is currently unavailable.")': 1 },
      ),
      expected,
      new AbortController().signal,
    ),
    { ownership: "foreign" },
  );

  assert.deepEqual(
    await new WorkdayOwnedTargetProbe().inspect(
      new ProbePage(
        "https://community.workday.com:444/maintenance-page",
        {
          ':text-is("Workday is currently unavailable.")': 1,
          ':text-is("We are experiencing a service interruption.")': 1,
        },
      ),
      expected,
      new AbortController().signal,
    ),
    { ownership: "foreign" },
  );
});

test("production probe continues when maintenance clears during the bounded reloads", async () => {
  const maintenance = new ProbePage(
    "https://community.workday.com/maintenance-page?d=5&s=1&e=1&o=",
    {
      ':text-is("Workday is currently unavailable.")': 1,
      ':text-is("We are experiencing a service interruption.")': 1,
    },
    {},
    (page) => {
      page.currentUrl =
        "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345";
      page.counts = {};
    },
  );

  assert.deepEqual(
    await new WorkdayOwnedTargetProbe().inspect(
      maintenance,
      expected,
      new AbortController().signal,
    ),
    owned(
      { kind: "matched" },
      [
        "structural_trait_ats_workday_family_v1",
        "structural_trait_page_job_posting_v1",
      ],
    ),
  );
  assert.equal(maintenance.reloads, 1);
});

test("production probe reloads an exact Workday runtime-error shell three times before classifying it", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  );
  await probe.inspect(page, expected, new AbortController().signal);
  page.currentUrl =
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/apply/applyManually";
  page.counts = {
    ':text-is("Something went wrong")': 1,
    ':text-is("Please refresh the page and then try again.")': 1,
  };

  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned({ kind: "posting_unavailable", reason: "runtime_error" }),
  );
  assert.equal(page.reloads, 3);
});

test("production probe classifies the exact raw Workday 503 body after bounded reloads", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  );
  await probe.inspect(page, expected, new AbortController().signal);
  page.currentUrl =
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/apply/applyManually";
  page.counts = {
    ':text-is("{\\"503\\":\\"service-unavailable\\"}")': 1,
  };

  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned({ kind: "posting_unavailable", reason: "runtime_error" }),
  );
  assert.equal(page.reloads, 3);
});

test("runtime-error bodies never bypass exact target ownership", async () => {
  const cases = [
    [
      "https://careers.example.invalid/job/Example_R12345",
      { ownership: "foreign" },
    ],
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

  for (const [url, expectedResult] of cases) {
    const page = new ProbePage(url, {
      ':text-is("{\\"503\\":\\"service-unavailable\\"}")': 1,
    });
    assert.deepEqual(
      await new WorkdayOwnedTargetProbe().inspect(
        page,
        expected,
        new AbortController().signal,
      ),
      expectedResult,
    );
    assert.equal(page.reloads, 0);
  }
});

test("a cleared runtime error re-admits ownership after its reload redirect", async () => {
  const redirects = [
    [
      "https://careers.example.invalid/job/Example_R12345",
      { ownership: "foreign" },
    ],
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

  for (const [redirectUrl, expectedResult] of redirects) {
    const page = new ProbePage(
      "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
      { ':text-is("{\\"503\\":\\"service-unavailable\\"}")': 1 },
      {},
      (current) => {
        current.currentUrl = redirectUrl;
        current.counts = {};
      },
    );
    assert.deepEqual(
      await new WorkdayOwnedTargetProbe().inspect(
        page,
        expected,
        new AbortController().signal,
      ),
      expectedResult,
    );
    assert.equal(page.reloads, 1);
  }
});

test("production probe continues when the Workday runtime-error shell clears", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  );
  await probe.inspect(page, expected, new AbortController().signal);
  page.currentUrl =
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345/apply/applyManually";
  page.counts = {
    ':text-is("Something went wrong")': 1,
    ':text-is("Please refresh the page and then try again.")': 1,
  };
  page.onReload = (current) => {
    current.counts = { '[data-automation-id="applyFlowMyInfoPage"]': 1 };
  };

  assert.deepEqual(
    await probe.inspect(page, expected, new AbortController().signal),
    owned(
      { kind: "matched" },
      [
        "structural_trait_ats_workday_family_v1",
        "structural_trait_page_profile_step_v1",
      ],
    ),
  );
  assert.equal(page.reloads, 1);
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

test("an exact email sign-in choice remains one posting-free account descendant", async () => {
  const probe = new WorkdayOwnedTargetProbe();
  const page = new ProbePage(
    "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
  );
  assert.equal(
    (await probe.inspect(page, expected, new AbortController().signal)).ownership,
    "owned",
  );
  page.currentUrl = "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/apply";
  page.counts = {
    '[data-automation-id="authPage"]': 1,
    '[data-automation-id="signInContent"]:has([data-automation-id="SignInWithEmailButton"])': 1,
  };

  const result = await probe.inspect(page, expected, new AbortController().signal);

  assert.deepEqual(result, owned(
    { kind: "matched" },
    [
      "structural_trait_ats_workday_family_v1",
      "structural_trait_page_account_entry_v1",
      "structural_trait_navigation_email_sign_in_choice_v1",
    ],
  ));
});

class ProbePage {
  currentUrl: string;
  counts: Readonly<Record<string, number>>;
  readonly semanticCounts: Readonly<Record<string, number>>;
  onReload?: (page: ProbePage, reload: number) => void;
  reloads = 0;

  constructor(
    currentUrl: string,
    counts: Readonly<Record<string, number>> = {},
    semanticCounts: Readonly<Record<string, number>> = {},
    onReload?: (page: ProbePage, reload: number) => void,
  ) {
    this.currentUrl = currentUrl;
    this.counts = counts;
    this.semanticCounts = semanticCounts;
    this.onReload = onReload;
  }

  url(): string {
    return this.currentUrl;
  }

  locator(selector: string): SemanticLocator {
    return semanticLocator(
      this.counts[selector] ?? this.semanticCounts[`selector:${selector}`] ?? 0,
    );
  }

  getByLabel(name: string): SemanticLocator {
    return semanticLocator(this.semanticCounts[`label:${name}`] ?? 0);
  }

  getByRole(role: string, options: { readonly name: string }): SemanticLocator {
    return semanticLocator(this.semanticCounts[`role:${role}:${options.name}`] ?? 0);
  }

  async goto(): Promise<void> {}
  async reload(): Promise<void> {
    this.reloads += 1;
    this.onReload?.(this, this.reloads);
  }
  isClosed(): boolean { return false; }
  async close(): Promise<void> {}
}

interface SemanticLocator {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isEditable(): Promise<boolean>;
}

function semanticLocator(count: number): SemanticLocator {
  return {
    count: async () => count,
    isVisible: async () => count === 1,
    isEnabled: async () => count === 1,
    isEditable: async () => count === 1,
  };
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
