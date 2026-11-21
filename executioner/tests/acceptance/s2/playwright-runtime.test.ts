import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { chromium, type BrowserContext, type Page } from "playwright";
import { PlaywrightWorkdayApplicationPage } from
  "../../../src/ats/workday/application/playwright-page.ts";
import { applyMutation, inspectPage } from "../../../src/browser/adapter.ts";
import { discoverFields } from "../../../src/form/discovery/discover-fields.ts";
import type {
  PersistentContext,
  PersistentPage,
} from "../../../src/browser/playwright-live/private/types.ts";
import {
  ownedApplicationPageAccess,
  releaseOwnedApplicationSession,
  retainOwnedApplicationSession,
  suspendOwnedApplicationSession,
  type OwnedApplicationOperation,
} from "../../../src/browser/playwright-live/private/application-page-types.ts";
import { PlaywrightPersistentBrowserSession } from
  "../../../src/browser/playwright-live/session.ts";
import { createQuestionAnswerLearningCapture } from
  "../../../src/live/evidence/question-answer-learning.ts";
import { liveApplicationExecutionPolicy } from
  "../../../src/contracts/application-execution-policy.ts";
import {
  bindQuestionnaireTargets,
  enrichQuestionnaireFields,
  finalizeQuestionnaireReconciliation,
  hydrateQuestionnairePopupOptions,
  isReviewExpectedField,
  isWorkdayReviewOmittedProfileField,
  monitorQuestionnaireCoverage,
  OwnedWorkdayApplicationRuntime,
  questionnairePopupHydrationTargets,
  reviewAnswerCandidates,
} from
  "../../../src/browser/playwright-live/private/workday-application-runtime.ts";

test("Workday Review checks saved display values and every selected skills row", async () => {
  assert.deepEqual([
    "identity.middle_name",
    "address.line2",
    "address.postal_code",
    "address.region",
    "phone.device_type",
    "phone.country_code",
  ].map((fieldId) => isWorkdayReviewOmittedProfileField(fieldId)), Array(6).fill(true));
  assert.equal(isWorkdayReviewOmittedProfileField("address.city"), false);
  assert.equal(isWorkdayReviewOmittedProfileField("social.linkedin"), false);
  assert.equal(
    reviewAnswerCandidates("https://www.linkedin.com/in/wjshi")
      .has("https://linkedin.com/in/wjshi"),
    true,
  );
  assert.equal(reviewAnswerCandidates("https://example.com/in/wjshi").has(
    "https://linkedin.com/in/wjshi",
  ), false);
  assert.equal(reviewAnswerCandidates("Direct Sourcing").has("Recruiter"), true);
  assert.equal(reviewAnswerCandidates("Recruiter Outreach").has("Recruiter"), true);
  assert.equal(reviewAnswerCandidates("Direct Mail").has("Recruiter"), false);

  const browser = await chromium.launch();
  const now = "2026-08-05T12:00:00.000Z";
  const operationId = generatedOperationId("operation_review_skills_01");
  const session = {
    schemaVersion: 1 as const,
    journeyId: journeyId("journey_review_skills_01"),
    sessionId: "live_session_review_skills_01" as LiveSessionId,
    profileLeaseId: "profile_lease_review_skills_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  };
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {} as never, acceptances: { record() {} },
    nextOperationId: () => operationId, timeoutMs: 1_000,
    initialReviewExpected: ["TypeScript", "Python"].map((value, index) => ({
      fieldId: `skills.values.selection.${index}`,
      rowIdentity: `formField-skills.values.selection.${index}`,
      provenance: "owner_provided", valueSha256: createHash("sha256").update(value).digest("hex"),
    })),
    authorizationExpiresAt: session.leaseExpiresAt, now: () => now,
  });
  try {
    runtime.bindSession(session);
    const page = await browser.newPage();
    await page.setContent(`<main data-automation-id="applyFlowPage">
      <div data-automation-id="progressBarActiveStep">Review</div>
      <section data-automation-id="applyFlowReviewPage">
        <div data-automation-id="formField-"><div role="group" aria-labelledby="skills-section">
          <ul data-automation-id="skills"><li>TypeScript</li></ul>
          <button type="button" onclick="this.previousElementSibling.insertAdjacentHTML('beforeend','<li>Python</li>');this.remove()">MORE (1)</button>
        </div></div>
        <button onclick="document.body.dataset.submitted='true'">Submit</button>
      </section></main>`);
    const capture = () => runtime.run(page as never, {
      schemaVersion: 1, journeyId: session.journeyId, sessionId: session.sessionId,
      target: session.target, operationId, now,
    }, { kind: "capture_review" }, new AbortController().signal);
    await capture();
    assert.deepEqual(await page.locator("li").allTextContents(), ["TypeScript", "Python"]);
    await page.locator("li").last().evaluate(element => element.remove());
    await assert.rejects(capture(), /Review field mismatch|Review field hidden/);
    assert.equal(await page.locator("body").getAttribute("data-submitted"), null);
  } finally {
    runtime.dispose();
    await browser.close();
  }
});

test("a supported unknown revealed after a profile commit is reconciled in the same live transport", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><label for="name--legalName--firstName">First Name</label><input id="name--legalName--firstName" required><label for="name--legalName--lastName">Last Name</label><input id="name--legalName--lastName" required><input hidden required data-automation-id="unreviewedConditional"></main><script>document.querySelector('#name--legalName--firstName').addEventListener('input',()=>document.querySelector('[data-automation-id="unreviewedConditional"]').hidden=false)</script></body></html>`);
  let nextOperation = 0;
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      ownerSources: {
        executionPolicy: liveApplicationExecutionPolicy("live"),
        profilePlan: {
          mode: "live",
          pageType: "profile",
fields: [
            {
              fieldId: "identity.given_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "identity.family_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Lovelace", provenance: "owner_provided", lane: "live_owner_fact" },
            },
          ],
          repeatables: [],
        },
      },
    } as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId(
      `operation_profile_effect_${String(++nextOperation).padStart(8, "0")}`,
    ),
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: { async auth() {}, async application() {} },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_profile_effect_01"),
    sessionId: "live_session_profile_effect_01" as LiveSessionId,
    profileLeaseId: "profile_lease_effect_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_profile_effect_01"),
      operationId: generatedOperationId("operation_profile_effect_02"),
      sessionId: "live_session_profile_effect_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_profile",
      input: { attempt: 1, pageId: "page-profile" } as never,
    }, new AbortController().signal);
    assert.equal((result as { readonly ok: boolean }).ok, true, JSON.stringify(result));
    assert.equal(
      await page.locator('#name--legalName--firstName').inputValue(),
      "Ada",
    );
    assert.equal(
      await page.locator('#name--legalName--lastName').inputValue(),
      "Lovelace",
    );
    assert.equal(
      await page.locator('[data-automation-id="unreviewedConditional"]').inputValue(),
      "Test response pending owner review.",
    );
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("profile batches external proof once while every field keeps independent readback", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><label>First Name<input required id="name--legalName--firstName"></label><label>Middle Name<input required id="name--legalName--middleName"></label><label>Last Name<input required id="name--legalName--lastName"></label><label>Address Line 2<input required id="address--addressLine2"></label><label>Postal Code<input required id="address--postalCode"></label><div data-automation-id="formField-source"><label for="profile-source">How Did You Hear About Us?</label><button id="profile-source" type="button" role="combobox" data-automation-id="sourcePrompt" aria-controls="source-options">Select One</button><div id="source-options" role="listbox" hidden><div role="option">Referral</div></div></div></main><script>const source = document.querySelector('#profile-source'); const options = document.querySelector('#source-options'); source?.addEventListener('click', () => { options?.removeAttribute('hidden'); source.setAttribute('aria-expanded', 'true'); }); options?.addEventListener('click', (event) => { const option = event.target instanceof Element ? event.target.closest('[role="option"]') : null; if (option === null) return; source.textContent = option.textContent; source.setAttribute('aria-expanded', 'false'); options.setAttribute('hidden', ''); });</script></body></html>`);
  let nextOperation = 0;
  const monitored: { readonly moment: string; readonly operationId: string }[] = [];
  await page.locator("#profile-source").evaluate((element) =>
    element.setAttribute("aria-required", "true")
  );
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      ownerSources: {
        executionPolicy: liveApplicationExecutionPolicy("live"),
        profilePlan: {
          mode: "live",
          pageType: "profile",
fields: [
            {
              fieldId: "identity.given_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Ada", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "identity.family_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Lovelace", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "identity.middle_name",
              questionType: "identity",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Byron", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "address.line2",
              questionType: "address",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "Unit 1", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "address.postal_code",
              questionType: "address",
              answerType: "text",
              allowedOptions: [],
              answer: { kind: "answered", value: "T2P 1A1", provenance: "owner_provided", lane: "live_owner_fact" },
            },
            {
              fieldId: "source.how_did_you_hear",
              questionType: "application_source",
              answerType: "option",
              allowedOptions: ["Referral"],
              answer: { kind: "answered", value: "Referral", provenance: "owner_provided", lane: "live_owner_fact" },
              optionMapping: {
                canonicalValue: "Referral",
                visibleOption: "Referral",
                provenance: "visible_option",
              },
            },
          ],
          repeatables: [],
        },
        sensitiveValues: ["Ada", "Byron", "Lovelace", "Unit 1", "T2P 1A1"],
      },
    } as never,
    acceptances: { record() {} },
    nextOperationId: () => {
      nextOperation += 1;
      return generatedOperationId(`operation_profile_monitor_${nextOperation.toString().padStart(8, "0")}`);
    },
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: {
      async auth() {},
      async application(_page, _pageName, moment, taxonomy, event) {
        monitored.push({ moment, operationId: event.operationId });
        assert.equal(taxonomy.questionTypes.includes("identity"), true);
        assert.equal(taxonomy.submitPresent, false);
      },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_profile_monitor_01"),
    sessionId: "live_session_profile_monitor_01" as LiveSessionId,
    profileLeaseId: "profile_lease_profile_monitor_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  const runOperation = generatedOperationId("operation_profile_monitor_run_01");
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_profile_monitor_01"),
      operationId: runOperation,
      sessionId: "live_session_profile_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_profile",
      input: { attempt: 1, pageId: "page-profile" } as never,
    }, new AbortController().signal);

    assert.equal((result as { ok: boolean }).ok, true);
    assert.deepEqual(monitored.filter(({ operationId }) =>
      operationId === runOperation
    ), []);
    const observationEvents = monitored.filter(({ moment }) => moment === "state_observed");
    assert.equal(observationEvents.length, 1);
    const mutationEvents = monitored.filter(({ moment }) => moment !== "state_observed");
    const operations = [...new Set(mutationEvents.map(({ operationId }) => operationId))];
    assert.equal(operations.length, 1);
    for (const operationId of operations) {
      assert.deepEqual(
        mutationEvents.filter((event) => event.operationId === operationId).map(({ moment }) => moment),
        ["before_mutation", "after_readback"],
      );
    }
    assert.equal(monitored.length, 3);
    assert.equal(monitored.length * 2_500 < 60_000, true);
    assert.equal(await page.locator('#name--legalName--middleName').inputValue(), "Byron");
    assert.equal(await page.locator('#address--addressLine2').inputValue(), "Unit 1");
    assert.equal(await page.locator('#address--postalCode').inputValue(), "T2P 1A1");
    const expectations = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_profile_monitor_01"),
      operationId: generatedOperationId("operation_profile_monitor_review_01"),
      sessionId: "live_session_profile_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "review_expectations" } as never, new AbortController().signal) as readonly {
      readonly fieldId: string;
    }[];
    assert.deepEqual(expectations.map(({ fieldId }) => fieldId), [
      "source.how_did_you_hear",
      "identity.given_name",
      "identity.family_name",
    ]);
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("questionnaire batches external proof once while every field keeps independent readback", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const questionEvidenceRoot = mkdtempSync(join(tmpdir(), "hunt-questionnaire-remount-learning-"));
  const ownerFactsOnlyPolicy = Object.freeze({
    ...liveApplicationExecutionPolicy("live"),
    answerFallbackPolicy: "owner_facts_only" as const,
  });
  const questionLearning = createQuestionAnswerLearningCapture({
    root: questionEvidenceRoot,
    mode: "live",
    executionPolicy: ownerFactsOnlyPolicy,
  });
  const profilePlan = {
    mode: "live" as "live" | "synthetic_test_non_submittable",
  };
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-questionnaire" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage">
    <div data-automation-id="formField-authorization"><label>Are you legally authorized to work in this country? <span aria-hidden="true">*</span></label><button id="mcvf1" type="button" aria-label="Select One Required" aria-haspopup="listbox">Yes</button><div class="options" hidden><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Yes</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">No</div></div></div></div>
    <div data-automation-id="formField-sponsorship"><label>Will you now or in the future require sponsorship? <span aria-hidden="true">*</span></label><button id="mcvf2" type="button" aria-label="Select One Required" aria-haspopup="listbox">No</button><div class="options" hidden><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Yes</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">No</div></div></div></div>
    <label id="conditional-removed">Country<input required aria-label="Country"></label>
    <label>Brief interest statement<textarea id="mcvf3" required aria-label="Brief interest statement"></textarea></label>
    <div data-automation-id="formField-source"><label>How Did You Hear About Us? <span aria-hidden="true">*</span></label><button id="mcvf4" type="button" aria-label="Select One Required" aria-haspopup="listbox">Select One</button><div class="options" hidden><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">LinkedIn</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Indeed</div></div></div></div>
    <div id="conditional-age" data-automation-id="formField-age" hidden><label>Are you at least 18 years of age? <span aria-hidden="true">*</span></label><button id="mcvf5" type="button" aria-label="Select One Required" aria-haspopup="listbox">Select One</button><div class="options" hidden><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">Yes</div></div><div data-automation-id="promptOption"><div data-automation-id="promptLeafNode">No</div></div></div></div>
    <script>
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function(options) {
        if (this.matches('button[aria-haspopup="listbox"]')) {
          this.dataset.scrollBlock = options?.block ?? '';
        }
        return originalScrollIntoView.call(this, options);
      };
      document.addEventListener('click', event => {
        const button = event.target.closest('button[aria-haspopup="listbox"]');
        if (button !== null) {
          button.closest('[data-automation-id^="formField-"]').querySelector('.options').hidden = false;
          return;
        }
        const option = event.target.closest('[data-automation-id="promptOption"]');
        if (option === null) return;
        const field = option.closest('[data-automation-id^="formField-"]');
        const owner = field.querySelector('button[aria-haspopup="listbox"]');
        owner.textContent = option.textContent.trim();
        owner.dataset.committed = 'true';
        field.querySelector('.options').hidden = true;
        if (owner.id === 'mcvf2') {
          document.querySelector('#conditional-age').hidden = false;
          document.querySelector('#conditional-removed')?.remove();
        }
      });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll('.options').forEach(options => { options.hidden = true; });
      });
    </script>
  </main></body></html>`);
  const artifact = resumeArtifact();
  const intent = createWorkdayResumeFileIntent({
    artifactId: artifact.resumeId,
    artifact,
    fileType: "pdf",
  });
  if (!intent.ok) throw new Error("resume fixture invalid");
  let nextOperation = 0;
  const accepted: string[] = [];
  const traces: { readonly event: string; readonly details?: object }[] = [];
  const monitored: {
    readonly moment: string;
    readonly operationId: string;
    readonly attempt: number;
  }[] = [];
  let finalQuestionnaireRemounted = false;
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {
      owner: { revisionId: "revision_questionnaire_monitor" },
      ownerSources: {
        executionPolicy: ownerFactsOnlyPolicy,
        resumeIntent: intent.value,
        profileId: upstreamProfileId("profile-questionnaire-monitor"),
        profileRevision: 1,
        profileQuery: {
          async query(input: ProfileQueryRequest) {
            const facts = {
              work_authorization: { value: true, provenance: "owner_provided" },
              sponsorship_required: { value: false, provenance: "owner_provided" },
              age_requirement_met: { value: true, provenance: "owner_provided" },
              application_source: { value: "LinkedIn", provenance: "owner_provided" },
              country: { value: "Canada", provenance: "owner_provided" },
              configured_narrative: {
                value: "Exact configured interest statement.",
                provenance: "configured_template",
              },
              gender_disclosure: { value: "Prefer not to answer", provenance: "owner_provided" },
              ethnicity_disclosure: { value: "Prefer not to answer", provenance: "owner_provided" },
              veteran_disclosure: { value: "Prefer not to answer", provenance: "owner_provided" },
            } as const;
            const fact = facts[input.factId as keyof typeof facts];
            return fact === undefined
              ? { ok: true as const, value: { kind: "profile_answer_missing" as const } }
              : {
                ok: true as const,
                value: { kind: "answered" as const, ...fact, lane: "live_owner_fact" as const },
              };
          },
        },
        narrative: createConfiguredNarrativeProvider({
          revision: "narrative-questionnaire-monitor-v1",
          template: "Exact configured interest statement.",
        }),
        sensitiveValues: ["Exact configured interest statement."],
        profilePlan,
      },
      questionLearning,
    } as never,
    acceptances: { record(value) { accepted.push(value.checkpoint); } },
    nextOperationId: () => {
      nextOperation += 1;
      return generatedOperationId(`operation_questionnaire_monitor_${nextOperation.toString().padStart(8, "0")}`);
    },
    // This scenario exercises three questionnaire pages and a checkbox that
    // must remain stable for most of the operation window. Leave headroom for
    // Playwright scheduling when the complete browser suite runs concurrently.
    timeoutMs: 10_000,
    trace: (event, details) => traces.push({ event, ...(details === undefined ? {} : { details }) }),
    initialReviewExpected: [],
    externalMonitor: {
      async auth() {},
      async application(_page, _pageName, moment, taxonomy, event) {
        monitored.push({ moment, operationId: event.operationId, attempt: event.attempt });
        if (
          !finalQuestionnaireRemounted && moment === "after_readback" &&
          await page.locator('button[data-committed="true"]').count() === 4 &&
          await page.locator("textarea").inputValue() === "Exact configured interest statement."
        ) {
          finalQuestionnaireRemounted = true;
          await page.locator('[data-automation-id="applyFlowApplicationQuestionsPage"]')
            .evaluate((root) => {
              const replacement = root.cloneNode(true) as HTMLElement;
              const sourceValues = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
                "input, textarea",
              )].map((control) => control.value);
              replacement.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")
                .forEach((control, index) => {
                  control.value = sourceValues[index] ?? "";
                });
              replacement.querySelectorAll("[data-hunt-target-token]").forEach((control) =>
                control.removeAttribute("data-hunt-target-token")
              );
              replacement.querySelectorAll<HTMLElement>("[id^=mcvf]").forEach((control, index) => {
                control.id = `mcvf${index + 101}`;
              });
              root.replaceWith(replacement);
            });
        }
        if (await page.locator('html[data-hunt-page-id="page-questionnaire-mount"]').count() === 1) {
          assert.ok(taxonomy.fieldCount === 0 || taxonomy.fieldCount === 1);
          assert.equal(taxonomy.requiredFieldCount, taxonomy.fieldCount);
          if (moment === "after_readback") assert.equal(taxonomy.fieldCount, 1);
        } else if (taxonomy.fieldCount === 4 && taxonomy.questionTypes.includes("authorization")) {
          assert.deepEqual(taxonomy.questionTypes, ["authorization", "narrative", "unknown"]);
          assert.equal(taxonomy.requiredFieldCount, 4);
        } else if (taxonomy.fieldCount === 5 && taxonomy.questionTypes.includes("authorization")) {
          assert.deepEqual(taxonomy.questionTypes, await page.locator('#conditional-removed').count() === 1
            ? ["authorization", "contact", "narrative", "unknown"]
            : ["authorization", "narrative", "unknown"]);
          assert.equal(taxonomy.requiredFieldCount, 5);
        } else if (taxonomy.fieldCount === 4 && taxonomy.requiredFieldCount === 0) {
          assert.deepEqual(taxonomy.questionTypes, ["demographic"]);
          assert.equal(taxonomy.requiredFieldCount, 0);
        } else if (taxonomy.fieldCount === 4) {
          assert.deepEqual(taxonomy.questionTypes, ["demographic", "unknown"]);
          assert.equal(taxonomy.requiredFieldCount, 4);
        } else if (taxonomy.fieldCount === 5) {
          assert.deepEqual(taxonomy.questionTypes, ["demographic", "legal"]);
          assert.equal(taxonomy.requiredFieldCount, 1);
        } else if (taxonomy.fieldCount === 1 || taxonomy.fieldCount === 3) {
          assert.equal(
            taxonomy.questionTypes.includes("legal") || taxonomy.questionTypes.includes("education") ||
              taxonomy.questionTypes.includes("demographic") || taxonomy.questionTypes.includes("identity"),
            true,
          );
          assert.equal(taxonomy.requiredFieldCount, taxonomy.fieldCount);
        } else {
          assert.equal(taxonomy.questionTypes.includes("unknown"), true);
          assert.equal(taxonomy.questionTypes.every((value) =>
            value === "unknown" || value === "demographic"), true);
          assert.equal(taxonomy.requiredFieldCount, taxonomy.fieldCount);
        }
        assert.equal(taxonomy.submitPresent, false);
      },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_questionnaire_monitor_01"),
    sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
    profileLeaseId: "profile_lease_questionnaire_monitor_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  const runOperation = generatedOperationId("operation_questionnaire_monitor_run_01");
  try {
    const result = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: runOperation,
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-questionnaire" } as never,
    }, new AbortController().signal);

    assert.equal(
      (result as { ok: boolean }).ok,
      true,
      JSON.stringify(result),
    );
    assert.equal(finalQuestionnaireRemounted, true);
    assert.equal(await page.locator('#conditional-removed').count(), 0);
    assert.equal(await page.locator("textarea").inputValue(), "Exact configured interest statement.");
    assert.equal(await page.locator('button[data-committed="true"]').count(), 4);
    assert.deepEqual(
      await page.locator('button[data-committed="true"]').evaluateAll((buttons) =>
        buttons.map((button) => button.dataset.scrollBlock)
      ),
      ["center", "center", "center", "center"],
    );
    assert.deepEqual(
      monitored.filter(({ operationId }) => operationId === runOperation).map(({ moment }) => moment),
      ["state_observed"],
    );
    const fieldEvents = monitored.filter(({ operationId }) => operationId !== runOperation);
    const operations = [...new Set(fieldEvents.map(({ operationId }) => operationId))];
    assert.equal(operations.length, 1);
    for (const operationId of operations) {
      assert.deepEqual(
        fieldEvents.filter((event) => event.operationId === operationId).map(({ moment }) => moment),
        ["before_mutation", "after_readback"],
      );
    }
    assert.equal(monitored.length, 3);
    assert.equal(monitored.length * 2_500 < 60_000, true);
    assert.equal(accepted.filter((checkpoint) => checkpoint === "questionnaire_verified").length, 1);

    const restoreMonitorStart = monitored.length;
    const restoreTraceStart = traces.length;
    profilePlan.mode = "synthetic_test_non_submittable";
    await page.locator('[data-automation-id="formField-sponsorship"] button')
      .evaluate((button) => {
        const owner = button.closest('[data-automation-id="formField-sponsorship"]');
        const options = owner?.querySelector<HTMLElement>('.options');
        button.textContent = "Select One";
        button.removeAttribute("data-committed");
        button.addEventListener("click", () => {
          if (options !== null && options !== undefined) options.hidden = false;
        });
        options?.addEventListener("click", (event) => {
          const option = (event.target as Element).closest('[data-automation-id="promptOption"]');
          if (option === null) return;
          button.textContent = option.textContent?.trim() ?? "";
          (button as HTMLElement).dataset.committed = "true";
          options.hidden = true;
        });
      });
    const restored = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_monitor_restore_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 2, pageId: "page-questionnaire" } as never,
    }, new AbortController().signal);
    assert.equal((restored as { ok: boolean }).ok, true, JSON.stringify(restored));
    profilePlan.mode = "live";
    assert.equal(
      await page.locator('[data-automation-id="formField-sponsorship"] button').innerText(),
      "No",
    );
    const restoreTraces = traces.slice(restoreTraceStart);
    assert.equal(
      restoreTraces.filter(({ event }) => event === "questionnaire_field_drive_started").length,
      1,
    );
    assert.equal(
      restoreTraces.filter(({ event }) => event === "questionnaire_field_verified_reused").length,
      4,
    );
    assert.equal(
      restoreTraces.some(({ event }) => event === "questionnaire_reconciliation_exception"),
      false,
    );
    assert.equal(
      restoreTraces.filter(({ event }) => event === "questionnaire_field_verified_reused")
        .every(({ details }) => (details as { remountGeneration?: number })?.remountGeneration === 2),
      true,
    );
    const restoreOperationIds = new Set(
      monitored.slice(restoreMonitorStart).map(({ operationId }) => operationId),
    );

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-voluntary" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowVoluntaryDisclosuresPage">
      <div data-automation-id="formField-gender"><label>What is your gender?</label><button type="button" aria-haspopup="listbox">Select One</button></div>
      <div data-automation-id="formField-hispanic"><label>Are you Hispanic or Latino?</label><button type="button" aria-haspopup="listbox">Select One</button></div>
      <div data-automation-id="formField-race"><label>What is your race/ethnicity?</label><button type="button" aria-haspopup="listbox">Select One</button></div>
      <div data-automation-id="formField-military"><label>Were you ever in the military?</label><button type="button" aria-haspopup="listbox">Select One</button></div>
      <script>
        const choices = [
          ['Prefer not to answer', 'Woman', 'Man'],
          ['No', 'Yes', 'Prefer not to answer'],
          ['Prefer not to answer', 'Asian', 'White'],
          ['No', 'Yes', 'Prefer not to answer'],
        ];
        let popup;
        const close = () => { popup?.remove(); popup = undefined; };
        document.querySelectorAll('button[aria-haspopup="listbox"]').forEach((button, index) => {
          button.addEventListener('click', () => {
            close();
            popup = document.createElement('div');
            popup.dataset.automationId = 'promptMenu';
            popup.innerHTML = choices[index].map((choice) => '<div data-automation-id="promptOption">' + choice + '</div>').join('');
            popup.addEventListener('click', (event) => {
              const option = event.target.closest('[data-automation-id="promptOption"]');
              if (option === null) return;
              button.textContent = option.textContent.trim();
              button.dataset.committed = 'true';
              close();
            });
            document.body.append(popup);
          });
        });
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
      </script>
    </main></body></html>`);
    const voluntaryOperation = generatedOperationId("operation_questionnaire_voluntary_01");
    const voluntaryResult = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: voluntaryOperation,
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-voluntary" } as never,
    }, new AbortController().signal) as { ok: boolean; error?: { code: string } };
    assert.equal(voluntaryResult.ok, true);
    assert.equal(await page.locator('button[data-committed="true"]').count(), 0);
    assert.deepEqual(await page.locator('button[aria-haspopup="listbox"]').allInnerTexts(), [
      "Select One",
      "Select One",
      "Select One",
      "Select One",
    ]);
    assert.deepEqual(
      monitored.filter(({ operationId }) => operationId === voluntaryOperation)
        .map(({ moment, attempt }) => ({ moment, attempt })),
      [{ moment: "state_observed", attempt: 3 }],
    );
    const voluntaryFieldEvents = monitored.filter(({ operationId }) =>
      operationId !== voluntaryOperation &&
      operationId !== runOperation &&
      !restoreOperationIds.has(operationId) &&
      !fieldEvents.some((event) => event.operationId === operationId)
    );
    const voluntaryOperations = [...new Set(voluntaryFieldEvents.map(({ operationId }) => operationId))];
    assert.equal(voluntaryOperations.length, 1);
    assert.deepEqual(
      voluntaryOperations.map((operationId) => voluntaryFieldEvents
        .filter((event) => event.operationId === operationId)
        .map(({ moment }) => moment)),
      [["before_mutation", "after_readback"]],
    );
    assert.deepEqual(
      [...new Set(voluntaryFieldEvents.map(({ attempt }) => attempt))],
      [3],
    );

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-self-identify" data-hunt-submit-activated="false"><head><style>.visual { display: inline-block; width: 18px; height: 18px; }.date-shell { display: flex; align-items: center; }.date-opener { margin-left: 48px; }</style></head><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowSelfIdentifyPage">
      <div data-automation-id="formField-selfIdentifiedDisabilityData--disabilityForm">
        <label>Language <span data-automation-id="required">*</span></label>
        <button type="button" aria-haspopup="listbox">Select One</button>
      </div>
      <div data-automation-id="formField-selfIdentifiedDisabilityData--name">
        <label>Name <span data-automation-id="required">*</span><input type="text" id="selfIdentifiedDisabilityData--name"></label>
      </div>
      <div data-automation-id="formField-selfIdentifiedDisabilityData--date">
        <label>Date <span data-automation-id="required">*</span></label>
        <div data-automation-id="dateInputWrapper">
          <input role="spinbutton" data-automation-id="dateSectionMonth-input">
          <input role="spinbutton" data-automation-id="dateSectionDay-input">
          <input role="spinbutton" data-automation-id="dateSectionYear-input">
        </div>
      </div>
      <div data-automation-id="formField-disabilityStatus">
        <label>Disability Status <span data-automation-id="required">*</span></label>
        <div class="disability-options">
          <div role="grid">
            <div role="row"><div role="cell"><div class="option"><div class="choice-owner"><input id="has-disability" type="checkbox" aria-checked="false"><span class="visual"></span><div class="decoration"></div></div><label for="has-disability">Yes, I have a disability, or have had one in the past</label></div></div></div>
            <div role="row"><div role="cell"><div class="option"><div class="choice-owner"><input id="no-disability" type="checkbox" aria-checked="false"><span class="visual"></span><div class="decoration"></div></div><label for="no-disability">No, I do not have a disability and have not had one in the past</label></div></div></div>
            <div role="row"><div role="cell"><div class="option"><div class="choice-owner"><input id="decline-disability-input" type="checkbox" aria-checked="false" aria-labelledby="decline-disability disability-context"><span class="visual"></span><div class="decoration"></div></div><label for="decline-disability-input"><span id="decline-disability">I do not want to answer</span></label></div></div></div>
          </div>
          <span id="disability-context">Please check one of the boxes below</span>
        </div>
      </div>
      <script>
        const languageField = document.querySelector('[data-automation-id="formField-selfIdentifiedDisabilityData--disabilityForm"]');
        const bindLanguage = (button) => button.addEventListener('click', () => {
          const popup = document.createElement('div');
          popup.dataset.automationId = 'promptMenu';
          popup.innerHTML = '<div data-automation-id="promptOption">English</div><div data-automation-id="promptOption">Spanish</div>';
          popup.addEventListener('click', (event) => {
            const option = event.target.closest('[data-automation-id="promptOption"]');
            if (option === null) return;
            const replacement = button.cloneNode(true);
            replacement.textContent = option.textContent.trim();
            replacement.removeAttribute('data-hunt-target-token');
            replacement.removeAttribute('data-hunt-popup-options');
            button.replaceWith(replacement);
            bindLanguage(replacement);
            popup.remove();
          });
          document.body.append(popup);
        });
        bindLanguage(languageField.querySelector('button'));
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          document.querySelector('[data-automation-id="promptMenu"]')?.remove();
          const button = languageField.querySelector('button');
          const replacement = button.cloneNode(true);
          replacement.removeAttribute('data-hunt-target-token');
          replacement.removeAttribute('data-hunt-popup-options');
          button.replaceWith(replacement);
          bindLanguage(replacement);
        });
        const name = document.querySelector('#selfIdentifiedDisabilityData--name');
        name.addEventListener('blur', () => {
          const replacement = name.cloneNode(true);
          replacement.value = name.value;
          replacement.removeAttribute('data-hunt-target-token');
          name.replaceWith(replacement);
        });
        document.querySelectorAll('[data-automation-id="formField-disabilityStatus"] input').forEach(input => {
          input.addEventListener('click', () => {
            input.setAttribute('aria-checked', String(input.checked));
            setTimeout(() => {
              if (input.dataset.componentAccepted !== 'true') {
                input.checked = false;
                input.setAttribute('aria-checked', 'false');
              }
            }, 0);
          });
          document.querySelector('label[for="' + input.id + '"]').addEventListener('click', () => {
            document.querySelectorAll('[data-automation-id="formField-disabilityStatus"] input').forEach(candidate => {
              candidate.checked = false;
              candidate.setAttribute('aria-checked', String(candidate.checked));
              delete candidate.dataset.componentAccepted;
            });
            input.dataset.componentAccepted = 'true';
          });
        });
      </script>
    </main></body></html>`);
    const selfIdentifyOperation = generatedOperationId("operation_questionnaire_self_identify_01");
    const selfIdentifyResult = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: selfIdentifyOperation,
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-self-identify" } as never,
    }, new AbortController().signal) as { ok: boolean; error?: { code: string } };
    assert.equal(selfIdentifyResult.ok, false, JSON.stringify(selfIdentifyResult));
    assert.equal(selfIdentifyResult.error?.code, "page_incomplete");
    assert.equal(
      await page.locator('[data-automation-id="formField-selfIdentifiedDisabilityData--disabilityForm"] button').innerText(),
      "Select One",
    );
    assert.equal(await page.locator("#selfIdentifiedDisabilityData--name").inputValue(), "");
    assert.deepEqual(
      await page.locator('[data-automation-id="dateInputWrapper"] input').evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value)
      ),
      ["", "", ""],
    );
    assert.deepEqual(
      await page.locator('[data-automation-id="formField-disabilityStatus"] input:checked')
        .evaluateAll((inputs) => inputs.map((input) => input.closest('[role="row"]')?.textContent?.trim())),
      [],
    );
    const selfIdentifyExpectations = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_review_expectations_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "review_expectations" } as never, new AbortController().signal) as readonly {
      readonly valueSha256: string;
    }[];
    const englishSha256 = createHash("sha256").update("English", "utf8").digest("hex");
    assert.equal(selfIdentifyExpectations.some(({ valueSha256 }) => valueSha256 === englishSha256), false);

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-learning-gap" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-highestEducation">
        <label for="highestEducation">Highest Level of Education <span data-automation-id="required">*</span></label>
        <select id="highestEducation" required><option>Select One</option></select>
      </div>
    </main></body></html>`);
    const learningGap = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_learning_gap_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-learning-gap" } as never,
    }, new AbortController().signal) as { ok: boolean; error?: { code: string } };
    assert.equal(learningGap.ok, false);
    assert.equal(learningGap.error?.code, "page_incomplete");
    const blockedTraces = traces.filter(({ event }) =>
      event === "questionnaire_reconciliation_blocked"
    );
    assert.equal(blockedTraces.length, 2);
    assert.deepEqual(blockedTraces.map(({ details }) => {
      const value = details as {
        pageId: string;
        fieldId: string;
        code: string;
        protectedCategory: string | null;
        candidatePresent: boolean;
        retryable: boolean;
      };
      assert.match(value.fieldId, /^field-workday-[0-9a-f]{8}-1$/u);
      return {
        pageId: value.pageId,
        code: value.code,
        protectedCategory: value.protectedCategory,
        candidatePresent: value.candidatePresent,
        retryable: value.retryable,
      };
    }), [
      {
        pageId: "page-self-identify",
        code: "profile_answer_missing",
        protectedCategory: "legal",
        candidatePresent: false,
        retryable: false,
      },
      {
        pageId: "page-learning-gap",
        code: "profile_answer_missing",
        protectedCategory: "legal",
        candidatePresent: false,
        retryable: false,
      },
    ]);

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-questionnaire-mount" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="instructionalText">Please complete the questions below.</div>
      <script>setTimeout(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-automation-id="formField-authorization"><label for="mount-authorization">Are you legally authorized to work in this country?</label><select id="mount-authorization" required><option>Select One</option><option>Yes</option><option>No</option></select></div>'), 3000);</script>
    </main></body></html>`);
    const mounting = await runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_mount_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-questionnaire-mount" } as never,
    }, new AbortController().signal) as { ok: boolean };
    assert.equal(mounting.ok, true, JSON.stringify(mounting));
    assert.equal(await page.locator('#mount-authorization').inputValue(), 'Yes');

    await page.setContent(`<!doctype html><html data-hunt-page-id="page-questionnaire-gap" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage">
      <div data-automation-id="formField-unsupported"><label>Required unsupported control</label><span data-automation-id="required">*</span><div role="slider" tabindex="0" data-hunt-field-id="unsupported-required"></div></div>
    </main></body></html>`);
    await assert.rejects(runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_monitor_gap_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-questionnaire-gap" } as never,
    }, new AbortController().signal), /questionnaire field coverage mismatch/u);
    await page.setContent(`<!doctype html><html data-hunt-page-id="page-questionnaire-empty" data-hunt-submit-activated="false"><body data-hunt-application-page="questionnaire"><main data-automation-id="applyFlowApplicationQuestionsPage"><p>Questions are loading.</p></main></body></html>`);
    await assert.rejects(runtime.run(page as never, {
      schemaVersion: 1,
      journeyId: journeyId("journey_questionnaire_monitor_01"),
      operationId: generatedOperationId("operation_questionnaire_empty_01"),
      sessionId: "live_session_questionnaire_monitor_01" as LiveSessionId,
      target: {} as never,
      now: "2026-08-05T12:00:00.000Z",
    }, {
      kind: "reconcile_questionnaire",
      input: { attempt: 1, pageId: "page-questionnaire-empty" } as never,
    }, new AbortController().signal), /questionnaire field coverage mismatch/u);
    assert.equal(accepted.filter((checkpoint) => checkpoint === "questionnaire_verified").length, 4);
  } finally {
    runtime.dispose();
    disposeResumeArtifact(artifact);
    rmSync(questionEvidenceRoot, { recursive: true, force: true });
    await context.close();
    await browser.close();
  }
});

test("required synthetic phone survives regional checks while optional fields stay out of Review expectations", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(`<html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><label>Phone Number<input required type="tel" pattern="[0-9]{10}" id="phoneNumber--phoneNumber"></label><label>Phone Extension<input id="phoneNumber--extension"></label></main></body></html>`);
  await page.locator("main").evaluate((root) => {
    root.insertAdjacentHTML("beforeend", '<label>I have a preferred name<input type="checkbox" id="name--preferredCheck"></label>');
  });
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: { ownerSources: {
      executionPolicy: liveApplicationExecutionPolicy("synthetic_test_non_submittable"),
      profilePlan: {
        mode: "synthetic_test_non_submittable", pageType: "profile",
        fields: ["phone.number", "phone.extension"].map((fieldId) => ({ fieldId,
          questionType: "phone", answerType: "text",
          allowedOptions: [], answer: { kind: "profile_answer_missing" } })),
        repeatables: [],
      },
      sensitiveValues: [],
    } } as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId("operation_extension_profile_01"),
    timeoutMs: 1_000,
    initialReviewExpected: [],
    externalMonitor: { async auth() {}, async application() {} },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  const sessionId = "live_session_extension_profile_01" as LiveSessionId;
  const journey = journeyId("journey_extension_profile_01");
  runtime.bindSession({ schemaVersion: 1, journeyId: journey, sessionId,
    profileLeaseId: "profile_lease_extension_01" as ProfileLeaseId,
    target: {} as never, leaseExpiresAt: "2026-08-05T13:00:00.000Z" });
  const request = { schemaVersion: 1 as const, journeyId: journey,
    operationId: generatedOperationId("operation_extension_run_01"), sessionId,
    target: {} as never, now: "2026-08-05T12:00:00.000Z" };
  try {
    const result = await runtime.run(page as never, request, {
      kind: "reconcile_profile", input: { attempt: 1, pageId: "page-profile" } as never,
    }, new AbortController().signal);
    assert.equal((result as { ok: boolean }).ok, true);
    assert.match(await page.locator('[id="phoneNumber--phoneNumber"]').inputValue(), /^\d{10}$/u);
    assert.equal(await page.locator('[id="phoneNumber--extension"]').inputValue(), "");
    assert.equal(await page.locator('[id="name--preferredCheck"]').isChecked(), false);
    const expected = await runtime.run(page as never, request,
      { kind: "review_expectations" } as never, new AbortController().signal) as readonly { fieldId: string; valueSha256: string }[];
    assert.deepEqual(expected.map(({ fieldId }) => fieldId).sort(),
      ["phone.number"]);
  } finally {
    runtime.dispose();
    await browser.close();
  }
});

import { runApplicationPageWalk } from "../../../src/ats/workday/application/page-walk.ts";
import { createConfiguredNarrativeProvider } from "../../../src/ats/workday/application/questions/index.ts";
import {
  createWorkdayResumeFileIntent,
  workdayResumeUploadFileName,
} from "../../../src/ats/workday/application/resume/index.ts";
import { createStage2PlaywrightLiveRuntimeBinding } from "../../../src/acceptance/s2-playwright-runtime.ts";
import {
  captureResumeArtifact,
  disposeResumeArtifact,
  generatedOperationId,
  journeyId,
  upstreamProfileId,
  upstreamResumeId,
  type OperationId,
  type ProfileQueryRequest,
} from "../../../src/contracts/index.ts";
import type {
  LiveBrowserSessionV1,
  LiveSessionId,
  ProfileLeaseId,
} from "../../../src/contracts/live/index.ts";
import { inspectWorkdayReview, stopAtVerifiedReview } from "../../../src/interaction/review/index.ts";
import { recoverBrowserInterruption } from "../../../src/journey/recovery/index.ts";

setFlagsFromString("--expose-gc");

function owner(root: string, url: string) {
  mkdirSync(join(root, "evidence"), { recursive: true });
  return {
    journeyId: "journey_runtime_fixture_01",
    revisionId: "revision_0123456789abcdef",
    approval: { approvalId: "approval_0123456789abcdef" },
    profileRef: "profile_ref_0123456789abcdef",
    target: {
      handleId: "target_ref_0123456789abcdef",
      url,
      host: "127.0.0.1",
      tenant: "fixture",
      posting: "fixture-posting",
    },
    roots: {
      runtime: { path: root },
      secrets: { path: join(root, "secrets") },
      evidence: { path: join(root, "evidence") },
    },
  } as never;
}

function resumeArtifact() {
  const bytes = Buffer.from("%PDF-1.7\nfixture resume\n%%EOF\n");
  const captured = captureResumeArtifact({
    resumeId: upstreamResumeId("resume-runtime-fixture"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, bytes);
  if (!captured.ok) throw new Error("resume capture failed");
  return captured.value;
}
