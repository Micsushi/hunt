import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApplicationPage,
  ApplicationPortResult,
  ApplicationPageTruth,
  ApplicationWalkDependencies,
} from "../../../src/ats/workday/application/page-walk.ts";
import { runApplicationPageWalk } from "../../../src/ats/workday/application/page-walk.ts";
import { dependenciesFor, truth } from "./fakes.ts";
import { walkFixture } from "./fixtures.ts";

const pageOrder = ["profile", "resume", "questionnaire"] as const;

test("walks the observed Workday My Information to Experience page order", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([
      truth("profile"), truth("profile"),
      truth("resume"), truth("resume"),
      truth("questionnaire"), truth("questionnaire"),
      truth("pre_review"),
    ], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.ok && result.value.pageChecks.map(({ page }) => page),
    ["profile", "resume", "questionnaire"],
  );
});

test("walks a Resume-first tenant from semantic browser truth", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([
      truth("resume"), truth("resume"),
      truth("profile"), truth("profile"),
      truth("questionnaire"), truth("questionnaire"),
      truth("pre_review"),
    ], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.ok && result.value.pageChecks.map(({ page }) => page),
    ["resume", "profile", "questionnaire"],
  );
});

test("accepts an observed path that skips the optional Resume page", async () => {
  const result = await runApplicationPageWalk(
    dependenciesFor([
      truth("profile"), truth("profile"),
      truth("questionnaire"), truth("questionnaire"),
      truth("pre_review"),
    ], []),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.ok && result.value.pageChecks.map(({ page }) => page),
    ["profile", "questionnaire"],
  );
});

test("recovers between lanes on one physical combined Resume/Profile page", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([
      combinedTruth("unverified"), combinedTruth("verified"),
      truth("questionnaire"), truth("questionnaire"), truth("pre_review"),
    ], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
    {
      resume: {
        currentPage: "resume",
        currentLanes: ["resume", "profile"],
        pageChecks: [verifiedChecks(2)[1]!],
      },
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.ok && result.value.pageChecks.map(({ page }) => page), [
    "resume", "profile", "questionnaire",
  ]);
  assert.equal(calls.some((call) => call.startsWith("reconcile:resume")), false);
  assert.equal(calls.some((call) => call.startsWith("reconcile:profile")), true);
});

test("combined Profile duplicate rows do not fabricate a Resume-lane failure", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([
      combinedTruth("unverified", 1), combinedTruth("unverified", 1),
      combinedTruth("verified", 0), truth("questionnaire"),
      truth("questionnaire"), truth("pre_review"),
    ], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.filter((call) => call.startsWith("reconcile:resume")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("reconcile:profile")).length, 1);
});

test("walks bounded repeated Questionnaire pages", async () => {
  const result = await runApplicationPageWalk(
    dependenciesFor([
      truth("profile"), truth("profile"),
      truth("questionnaire"), truth("questionnaire"),
      truth("questionnaire"), truth("questionnaire"),
      truth("pre_review"),
    ], []),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.ok && result.value.pageChecks.map(({ page }) => page),
    ["profile", "questionnaire", "questionnaire"],
  );
});

test("rescans a Questionnaire after an answer reveals a required control", async () => {
  const calls: string[] = [];
  const revealed = incompleteTruth("questionnaire");
  const result = await runApplicationPageWalk(
    dependenciesFor([
      truth("questionnaire"), revealed, truth("questionnaire"), truth("pre_review"),
    ], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
    { pageRetryLimit: 1 },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls.slice(0, 5), [
    "observe:questionnaire",
    "reconcile:questionnaire:1",
    "observe:questionnaire",
    "reconcile:questionnaire:2",
    "observe:questionnaire",
  ]);
});

test("rejects an unbounded repeated Questionnaire loop", async () => {
  const result = await runApplicationPageWalk(
    dependenciesFor(Array.from({ length: 21 }, () => truth("questionnaire")), []),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.completedPages, 8);
  assert.equal(!result.ok && result.error.failure.code, "navigation_illegal");
});

test("accepts direct Review only from independently observed browser truth", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([truth("pre_review")], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.ok && result.value.pageChecks, []);
  assert.deepEqual(calls, ["observe:pre_review", "progress:pre_review:0"]);
});

test("walks every application page only after browser-truth verification and stops before Review", async () => {
  const calls: string[] = [];
  const truths = [
    truth("profile"),
    truth("profile"),
    truth("resume"),
    truth("resume"),
    truth("questionnaire"),
    truth("questionnaire"),
    truth("pre_review"),
  ];
  const dependencies = dependenciesFor(truths, calls);

  const result = await runApplicationPageWalk(
    dependencies,
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      checkpoint: "pre_review",
      completedPages: 3,
      pageChecks: [
        { page: "profile", checkpoint: "profile_verified", independentlyVerified: true, requiredFields: 1, verifiedFields: 1, duplicateRows: 0 },
        { page: "resume", checkpoint: "resume_verified", independentlyVerified: true, requiredFields: 1, verifiedFields: 1, duplicateRows: 0 },
        { page: "questionnaire", checkpoint: "questionnaire_verified", independentlyVerified: true, requiredFields: 1, verifiedFields: 1, duplicateRows: 0 },
      ],
      submitActivated: false,
      privacyScan: "pass",
    },
  });
  assert.deepEqual(calls, [
    "observe:profile",
    "reconcile:profile:1",
    "observe:profile",
    "progress:profile_verified:1",
    "next:profile:profile|resume|questionnaire|pre_review",
    "observe:resume",
    "reconcile:resume:1",
    "observe:resume",
    "progress:resume_verified:2",
    "next:resume:profile|questionnaire|pre_review",
    "observe:questionnaire",
    "reconcile:questionnaire:1",
    "observe:questionnaire",
    "progress:questionnaire_verified:3",
    "next:questionnaire:questionnaire|pre_review",
    "observe:pre_review",
    "progress:pre_review:3",
  ]);
});

for (const scenario of [
  { name: "Profile checkpoint", currentPage: "profile" as const, count: 1,
    truths: [truth("profile"), truth("resume"), truth("resume"), truth("questionnaire"), truth("questionnaire"), truth("pre_review")],
    reconciled: ["resume", "questionnaire"] },
  { name: "browser-advanced Resume", currentPage: "resume" as const, count: 1,
    truths: [truth("resume"), truth("resume"), truth("questionnaire"), truth("questionnaire"), truth("pre_review")],
    reconciled: ["resume", "questionnaire"] },
  { name: "Resume checkpoint", currentPage: "resume" as const, count: 2,
    truths: [truth("resume"), truth("questionnaire"), truth("questionnaire"), truth("pre_review")],
    reconciled: ["questionnaire"] },
  { name: "browser-advanced Questionnaire", currentPage: "questionnaire" as const, count: 2,
    truths: [truth("questionnaire"), truth("questionnaire"), truth("pre_review")],
    reconciled: ["questionnaire"] },
  { name: "Questionnaire checkpoint", currentPage: "questionnaire" as const, count: 3,
    truths: [truth("questionnaire"), truth("pre_review")], reconciled: [] },
  { name: "pre-Review checkpoint", currentPage: "pre_review" as const, count: 3,
    truths: [truth("pre_review")], reconciled: [] },
] as const) {
  test(`continues from ${scenario.name} with its exact verified prefix`, async () => {
    const calls: string[] = [];
    const checks = pageOrder.slice(0, scenario.count).map((page) => ({
      page,
      checkpoint: page === "resume" ? "resume_verified" as const
        : page === "profile" ? "profile_verified" as const
        : "questionnaire_verified" as const,
      independentlyVerified: true as const,
      requiredFields: 1,
      verifiedFields: 1,
      duplicateRows: 0,
    }));
    const result = await runApplicationPageWalk(
      dependenciesFor([...scenario.truths], calls),
      { journeyId: walkFixture.journeyId },
      new AbortController().signal,
      { resume: { currentPage: scenario.currentPage, pageChecks: checks } },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.ok && result.value.pageChecks.slice(0, checks.length), checks);
    assert.equal(result.ok && result.value.pageChecks.length, 3);
    for (const page of pageOrder) {
      assert.equal(
        calls.some((call) => call.startsWith(`reconcile:${page}`)),
        scenario.reconciled.includes(page as never),
        page,
      );
    }
  });
}

for (const scenario of [
  { page: "resume" as const, prefixCount: 1, stopAfter: "resume_verified" as const },
  { page: "questionnaire" as const, prefixCount: 2, stopAfter: "questionnaire_verified" as const },
]) {
  test(`reconciles an incomplete browser-advanced ${scenario.page} and persists a restartable checkpoint`, async () => {
    const prefix = verifiedChecks(scenario.prefixCount);
    const calls: string[] = [];
    const first = await runApplicationPageWalk(
      dependenciesFor([incompleteTruth(scenario.page), truth(scenario.page)], calls),
      { journeyId: walkFixture.journeyId, stopAfter: scenario.stopAfter },
      new AbortController().signal,
      { resume: { currentPage: scenario.page, pageChecks: prefix } },
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(calls.some((call) => call.startsWith(`reconcile:${scenario.page}:`)), true);
    if (!first.ok) return;
    assert.equal(first.value.pageChecks.length, scenario.prefixCount + 1);

    const restartCalls: string[] = [];
    const restartTruths = scenario.page === "resume"
      ? [truth("resume"), truth("questionnaire"), truth("questionnaire"), truth("pre_review")]
      : [truth("questionnaire"), truth("pre_review")];
    const second = await runApplicationPageWalk(
      dependenciesFor(restartTruths, restartCalls),
      { journeyId: walkFixture.journeyId },
      new AbortController().signal,
      { resume: { currentPage: scenario.page, pageChecks: first.value.pageChecks } },
    );
    assert.equal(second.ok, true, JSON.stringify(second));
  });
}

test("recovery denies incomplete persisted fields, corrupted prefixes, and regressions", async () => {
  for (const resume of [
    { currentPage: "resume" as const, pageChecks: verifiedChecks(2) },
    { currentPage: "resume" as const, pageChecks: [{ ...verifiedChecks(1)[0]!, verifiedFields: 0 }] },
    { currentPage: "resume" as const, pageChecks: verifiedChecks(3) },
  ]) {
    const calls: string[] = [];
    const result = await runApplicationPageWalk(
      dependenciesFor([incompleteTruth(resume.currentPage)], calls),
      { journeyId: walkFixture.journeyId },
      new AbortController().signal,
      { resume },
    );
    assert.equal(result.ok, false);
    assert.equal(calls.some((call) => call.startsWith("reconcile:")), false);
  }
});

test("reruns only the affected page after a bounded retryable handler failure", async () => {
  const calls: string[] = [];
  const truths = [
    truth("profile"),
    truth("profile"),
    truth("resume"),
    truth("resume"),
    truth("questionnaire"),
    truth("questionnaire"),
    truth("pre_review"),
  ];
  const dependencies = dependenciesFor(truths, calls, (page, attempt, pageId) =>
    page === "resume" && attempt === 1
      ? {
          ok: false,
          error: {
            code: "browser_timeout",
            classifier: "resume_page",
            primitive: "file_upload",
            unknownLayer: "ui_behavior",
          },
        }
      : {
          ok: true,
          value: {
            page,
            pageId,
            checkpoint: page === "resume"
              ? "resume_verified"
              : page === "profile"
                ? "profile_verified"
                : "questionnaire_verified",
            independentlyVerified: true,
          },
        },
  );

  const result = await runApplicationPageWalk(
    dependencies,
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
    { pageRetryLimit: 1 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(5, 10), [
    "observe:resume",
    "reconcile:resume:1",
    "reconcile:resume:2",
    "observe:resume",
    "progress:resume_verified:2",
  ]);
});

test("stops when a page handler causes an unapproved transition", async () => {
  const calls: string[] = [];
  const dependencies = dependenciesFor(
    [truth("profile"), truth("resume")],
    calls,
  );

  const result = await runApplicationPageWalk(
    dependencies,
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
    { pageRetryLimit: 1 },
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      checkpoint: "resume",
      completedPages: 0,
      failure: {
        code: "navigation_uncertain",
        retryable: false,
        owner: "browser_truth",
        classifier: "workday_page",
        primitive: "page_observation",
        unknownLayer: "navigation",
        page: "resume",
        attempt: 1,
      },
      submitActivated: false,
      privacyScan: "pass",
    },
  });
  assert.deepEqual(calls, [
    "observe:profile",
    "reconcile:profile:1",
    "observe:resume",
  ]);
});

test("stops immediately if browser truth reports Submit activation", async () => {
  const calls: string[] = [];
  const dependencies = dependenciesFor(
    [truth("profile"), { ...truth("profile"), submitActivated: true }],
    calls,
  );

  const result = await runApplicationPageWalk(
    dependencies,
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.failure, {
    code: "submit_forbidden",
    retryable: false,
    owner: "browser_truth",
    classifier: "workday_page",
    primitive: "page_observation",
    unknownLayer: "navigation",
    page: "profile",
    attempt: 1,
  });
  assert.deepEqual(calls, [
    "observe:profile",
    "reconcile:profile:1",
    "observe:profile",
  ]);
});

test("reobserves browser truth without replaying a verified page effect", async () => {
  const calls: string[] = [];
  const observations: ApplicationPortResult<ApplicationPageTruth>[] = [
    { ok: true, value: truth("profile") },
    {
      ok: false,
      error: {
        code: "browser_timeout",
        classifier: "workday_page",
        primitive: "page_observation",
        unknownLayer: "ui_behavior",
      },
    },
    { ok: true, value: truth("profile") },
    { ok: true, value: truth("resume") },
    { ok: true, value: truth("resume") },
    { ok: true, value: truth("questionnaire") },
    { ok: true, value: truth("questionnaire") },
    { ok: true, value: truth("pre_review") },
  ];
  let observation = 0;
  const base = dependenciesFor([], calls);
  const dependencies: ApplicationWalkDependencies = {
    ...base,
    observer: {
      async observe() {
        const result = observations[observation++];
        assert.ok(result, "fixture observation exhausted");
        calls.push(result.ok ? `observe:${result.value.page}` : "observe:error");
        return result;
      },
    },
  };

  const result = await runApplicationPageWalk(
    dependencies,
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
    { pageRetryLimit: 1 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(0, 6), [
    "observe:profile",
    "reconcile:profile:1",
    "observe:error",
    "observe:profile",
    "progress:profile_verified:1",
    "next:profile:profile|resume|questionnaire|pre_review",
  ]);
});

for (const scenario of [
  {
    name: "unverified required field",
    truth: {
      ...truth("profile"),
      requiredFields: [
        {
          fieldId: walkFixture.fields.profile,
          verification: "unverified" as const,
        },
      ],
    },
    classifier: "required_field_gate" as const,
    primitive: "required_field_verification" as const,
    unknownLayer: "required_field" as const,
  },
  {
    name: "C3-owned duplicate row",
    truth: { ...truth("profile"), c3OwnedDuplicateRows: 1 },
    classifier: "repeatable_row_gate" as const,
    primitive: "repeatable_row_reconciliation" as const,
    unknownLayer: "repeatable_row" as const,
  },
]) {
  test(`exhausts the page retry bound without navigation for ${scenario.name}`, async () => {
    const calls: string[] = [];
    const result = await runApplicationPageWalk(
      dependenciesFor(
        [truth("profile"), scenario.truth, scenario.truth],
        calls,
      ),
      { journeyId: walkFixture.journeyId },
      new AbortController().signal,
      { pageRetryLimit: 1 },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.error.failure, {
      code: "page_incomplete",
      retryable: false,
      owner: "profile",
      classifier: scenario.classifier,
      primitive: scenario.primitive,
      unknownLayer: scenario.unknownLayer,
      page: "profile",
      attempt: 2,
    });
    assert.equal(calls.some((call) => call.startsWith("next:")), false);
    assert.equal(calls.some((call) => call.startsWith("progress:")), false);
    assert.doesNotMatch(JSON.stringify(result), /resume-artifact/u);
  });
}

test("an already-cancelled walk performs no browser or page effects", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  controller.abort();

  const result = await runApplicationPageWalk(
    dependenciesFor([], calls),
    { journeyId: walkFixture.journeyId },
    controller.signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.failure, {
    code: "operation_cancelled",
    retryable: false,
    owner: "browser_truth",
    classifier: "workday_page",
    primitive: "page_observation",
    unknownLayer: "none",
    page: "profile",
    attempt: 1,
  });
  assert.deepEqual(calls, []);
});

test("failure projection drops non-contract adapter detail", async () => {
  const calls: string[] = [];
  const leakedFailure = {
    ok: false,
    error: {
      code: "page_incomplete",
      classifier: "resume_page",
      primitive: "file_upload",
      unknownLayer: "required_field",
      detail: "sensitive-value",
    },
  } as unknown as ApplicationPortResult<{
    readonly page: Exclude<ApplicationPage, "pre_review">;
    readonly pageId: ApplicationPageTruth["pageId"];
  }>;
  const result = await runApplicationPageWalk(
    dependenciesFor([truth("profile")], calls, () => leakedFailure),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(Object.keys(result.error.failure).sort(), [
    "attempt",
    "classifier",
    "code",
    "owner",
    "page",
    "primitive",
    "retryable",
    "unknownLayer",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-value/u);
});

test("failure projection replaces malformed enum values with safe metadata", async () => {
  const malformedFailure = {
    ok: false,
    error: {
      code: "page_incomplete",
      classifier: "sensitive-value",
      primitive: "file_upload",
      unknownLayer: "required_field",
    },
  } as unknown as ApplicationPortResult<{
    readonly page: Exclude<ApplicationPage, "pre_review">;
    readonly pageId: ApplicationPageTruth["pageId"];
  }>;
  const result = await runApplicationPageWalk(
    dependenciesFor([truth("profile")], [], () => malformedFailure),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.failure, {
    code: "failure_context_invalid",
    retryable: false,
    owner: "profile",
    classifier: "workday_page",
    primitive: "page_observation",
    unknownLayer: "none",
    page: "profile",
    attempt: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /sensitive-value/u);
});

test("waits through a same-page loading shell after navigation", async () => {
  const calls: string[] = [];
  const loading = {
    ...truth("profile"),
    requiredFields: [],
  };
  const result = await runApplicationPageWalk(
    dependenciesFor([
      truth("profile"), truth("profile"),
      loading,
      truth("resume"), truth("resume"),
      truth("questionnaire"), truth("questionnaire"),
      truth("pre_review"),
    ], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.filter((call) => call === "observe:profile").length, 3);
});

test("waits through transient browser truth while Workday remounts the destination", async () => {
  const calls: string[] = [];
  const base = dependenciesFor([
    truth("profile"), truth("profile"),
    truth("resume"), truth("resume"),
  ], calls);
  const observe = base.observer.observe.bind(base.observer);
  let observations = 0;
  const result = await runApplicationPageWalk(
    {
      ...base,
      observer: {
        async observe(signal) {
          observations += 1;
          if (observations === 3) {
            return {
              ok: false,
              error: {
                code: "browser_target_ambiguous",
                classifier: "workday_page",
                primitive: "page_observation",
                unknownLayer: "page_type",
              },
            } as const;
          }
          return observe(signal);
        },
      },
    },
    { journeyId: walkFixture.journeyId, stopAfter: "resume_verified" },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && result.value.checkpoint, "resume_verified");
  assert.equal(observations, 5);
});

test("uses the settled navigation destination without reobserving a remounted loading shell", async () => {
  const calls: string[] = [];
  const base = dependenciesFor([
    truth("profile"), truth("profile"), truth("questionnaire"),
  ], calls);
  let observations = 0;
  const destinations = [truth("questionnaire"), truth("pre_review")];
  const observe = base.observer.observe.bind(base.observer);
  const result = await runApplicationPageWalk(
    {
      ...base,
      observer: {
        async observe(signal) {
          observations += 1;
          return observe(signal);
        },
      },
      navigation: {
        async next(request) {
          calls.push(`next:${request.from}:${request.allowed.join("|")}`);
          const destination = destinations.shift();
          assert.ok(destination, "fixture navigation destination exhausted");
          return {
            ok: true,
            value: {
              advanced: true,
              destination,
            },
          };
        },
      },
    },
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(observations, 3);
  assert.deepEqual(result.ok && result.value.pageChecks.map(({ page }) => page), [
    "profile", "questionnaire",
  ]);
});

test("walks distinct My Information and My Experience profile roots", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([
      truth("profile"), truth("profile"),
      truth("profile"), truth("profile"),
      truth("questionnaire"), truth("questionnaire"),
      truth("pre_review"),
    ], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.ok && result.value.pageChecks.map(({ page }) => page),
    ["profile", "profile", "questionnaire"],
  );
});

test("fills an independently entered application page without forcing earlier pages", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([
      truth("questionnaire"), truth("questionnaire"), truth("pre_review"),
    ], calls),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.ok && result.value.pageChecks.map(({ page }) => page),
    ["questionnaire"],
  );
  assert.equal(calls.some((call) => call.startsWith("reconcile:profile")), false);
  assert.equal(calls.some((call) => call.startsWith("reconcile:resume")), false);
});

test("failure projection preserves bounded synthetic placeholder provenance", async () => {
  const placeholderFailure = {
    ok: false,
    error: {
      code: "protected_answer_denied",
      classifier: "questionnaire_page",
      primitive: "question_control",
      unknownLayer: "question",
      protectedPlaceholderCount: 1,
      placeholderProvenance: "synthetic_ui_learning",
      detail: "must-not-escape",
    },
  } as unknown as ApplicationPortResult<never>;
  const result = await runApplicationPageWalk(
    dependenciesFor([truth("profile")], [], () => placeholderFailure),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.failure.protectedPlaceholderCount, 1);
  assert.equal(result.error.failure.placeholderProvenance, "synthetic_ui_learning");
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape/u);
});

test("failure projection rejects incomplete placeholder metadata", async () => {
  const malformedPlaceholder = {
    ok: false,
    error: {
      code: "protected_answer_denied",
      classifier: "questionnaire_page",
      primitive: "question_control",
      unknownLayer: "question",
      protectedPlaceholderCount: 1,
    },
  } as unknown as ApplicationPortResult<never>;
  const result = await runApplicationPageWalk(
    dependenciesFor([truth("profile")], [], () => malformedPlaceholder),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.failure.code, "failure_context_invalid");
  assert.equal("protectedPlaceholderCount" in result.error.failure, false);
});

test("does not navigate when a lane reports the wrong independent checkpoint", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([truth("profile")], calls, (page, _attempt, pageId) => ({
      ok: true,
      value: {
        page,
        pageId,
        checkpoint: "resume_verified",
        independentlyVerified: true,
      },
    })),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.failure.code, "failure_context_invalid");
  assert.equal(result.error.failure.owner, "profile");
  assert.equal(calls.some((call) => call.startsWith("next:")), false);
  assert.equal(calls.some((call) => call.startsWith("progress:")), false);
});

test("does not claim pre-Review while final browser truth is incomplete", async () => {
  const calls: string[] = [];
  const incompletePreReview: ApplicationPageTruth = {
    ...truth("pre_review"),
    requiredFields: [
      {
        fieldId: walkFixture.fields.questionnaire,
        verification: "unverified",
      },
    ],
  };
  const result = await runApplicationPageWalk(
    dependenciesFor(
      [
        truth("profile"),
        truth("profile"),
        truth("resume"),
        truth("resume"),
        truth("questionnaire"),
        truth("questionnaire"),
        incompletePreReview,
      ],
      calls,
    ),
    { journeyId: walkFixture.journeyId },
    new AbortController().signal,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.failure, {
    code: "page_incomplete",
    retryable: false,
    owner: "browser_truth",
    classifier: "required_field_gate",
    primitive: "required_field_verification",
    unknownLayer: "required_field",
    page: "pre_review",
    attempt: 1,
  });
  assert.equal(result.error.completedPages, 3);
  assert.equal(calls.at(-1), "observe:pre_review");
});

test("honors verification checkpoint stops without advancing beyond browser truth", async () => {
  const calls: string[] = [];
  const result = await runApplicationPageWalk(
    dependenciesFor([truth("profile"), truth("profile")], calls),
    {
      journeyId: walkFixture.journeyId,
      stopAfter: "profile_verified",
    },
    new AbortController().signal,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.checkpoint, "profile_verified");
  assert.equal(result.value.completedPages, 1);
  assert.deepEqual(result.value.pageChecks.map(({ checkpoint }) => checkpoint), [
    "profile_verified",
  ]);
  assert.equal(calls.some((call) => call.startsWith("next:")), false);
  assert.equal(calls.at(-1), "progress:profile_verified:1");
});

function verifiedChecks(count: number) {
  return pageOrder.slice(0, count).map((page) => ({
    page,
    checkpoint: page === "resume" ? "resume_verified" as const
      : page === "profile" ? "profile_verified" as const
      : "questionnaire_verified" as const,
    independentlyVerified: true as const,
    requiredFields: 1,
    verifiedFields: 1,
    duplicateRows: 0,
  }));
}

function combinedTruth(
  profileVerification: "verified" | "unverified",
  c3OwnedDuplicateRows = 0,
): ApplicationPageTruth {
  return {
    ...truth("resume"),
    lanes: ["resume", "profile"],
    c3OwnedDuplicateRows,
    requiredFields: [
      {
        fieldId: walkFixture.fields.resume,
        page: "resume",
        verification: "verified",
      },
      {
        fieldId: walkFixture.fields.profile,
        page: "profile",
        verification: profileVerification,
      },
    ],
  };
}

function incompleteTruth(page: "resume" | "questionnaire"): ApplicationPageTruth {
  return {
    ...truth(page),
    requiredFields: [{
      fieldId: walkFixture.fields[page],
      verification: "unverified",
    }],
  };
}
