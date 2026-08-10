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
import type {
  PersistentContext,
  PersistentPage,
} from "../../../src/browser/playwright-live/private/types.ts";
import {
  ownedApplicationPageAccess,
  suspendOwnedApplicationSession,
  type OwnedApplicationOperation,
} from "../../../src/browser/playwright-live/private/application-page-types.ts";
import { PlaywrightPersistentBrowserSession } from
  "../../../src/browser/playwright-live/session.ts";
import { isReviewExpectedField, OwnedWorkdayApplicationRuntime } from
  "../../../src/browser/playwright-live/private/workday-application-runtime.ts";

test("Review monitor ACK is followed by a fresh exact visible field and structure readback", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html data-hunt-page-id="page-review" data-hunt-submit-activated="false"><body data-hunt-application-page="pre_review"><div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><section data-hunt-review-field-id="s1-field-resume">resume.pdf</section><button id="final-submit">Submit application</button></main></body></html>`);
  let monitorCalls = 0;
  const runtime = new OwnedWorkdayApplicationRuntime({
    request: {} as never,
    acceptances: { record() {} },
    nextOperationId: () => generatedOperationId("operation_review_drift_next_01"),
    timeoutMs: 1_000,
    initialReviewExpected: [{
      fieldId: "s1-field-resume",
      provenance: "resume_verified",
      rowIdentity: "formField-s1-field-resume",
      valueSha256: createHash("sha256").update("resume.pdf").digest("hex"),
    }],
    externalMonitor: {
      async auth() {},
      async application() {
        monitorCalls += 1;
        await page.locator('[data-hunt-review-field-id="s1-field-resume"]').evaluate(
          (element) => { element.textContent = "drifted.pdf"; (element as HTMLElement).hidden = true; },
        );
      },
    },
    authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
    now: () => "2026-08-05T12:00:00.000Z",
  });
  runtime.bindSession({
    schemaVersion: 1,
    journeyId: journeyId("journey_review_drift_0001"),
    sessionId: "live_session_review_drift_0001" as LiveSessionId,
    profileLeaseId: "profile_lease_review_drift_01" as ProfileLeaseId,
    target: {} as never,
    leaseExpiresAt: "2026-08-05T13:00:00.000Z",
  });
  try {
    await assert.rejects(
      () => runtime.run(page as never, {
        schemaVersion: 1,
        journeyId: journeyId("journey_review_drift_0001"),
        operationId: generatedOperationId("operation_review_drift_0001"),
        sessionId: "live_session_review_drift_0001" as LiveSessionId,
        target: {} as never,
        now: "2026-08-05T12:00:00.000Z",
      }, { kind: "capture_review" }, new AbortController().signal),
      /Review field hidden|Review field mismatch|Review readback drift denied/u,
    );
    assert.equal(monitorCalls, 1);
    assert.equal(await page.locator("html").getAttribute("data-hunt-submit-activated"), "false");
  } finally {
    runtime.dispose();
    await context.close();
    await browser.close();
  }
});

test("application authority expiring during ACK permits no reconcile, navigation, reload, or Review continuation", async (t) => {
  const cases: readonly [string, OwnedApplicationOperation, string][] = [
    ["resume reconcile", { kind: "reconcile_resume", input: { attempt: 1, pageId: "page-resume" } as never }, "resume"],
    ["profile reconcile", { kind: "reconcile_profile", input: { attempt: 1, pageId: "page-profile" } as never }, "profile"],
    ["questionnaire reconcile", { kind: "reconcile_questionnaire", input: { attempt: 1, pageId: "page-questionnaire" } as never }, "questionnaire"],
    ["forward navigation", { kind: "next", input: { from: "resume", expected: "profile" } as never }, "resume"],
    ["reload", { kind: "reload" }, "resume"],
    ["Review readback", { kind: "capture_review" }, "pre_review"],
  ];
  for (const [name, operation, pageKind] of cases) await t.test(name, async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const review = pageKind === "pre_review"
      ? '<div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><section data-hunt-review-field-id="s1-field-resume">resume.pdf</section><button>Submit application</button></main>'
      : '<main data-automation-id="applyFlowMyInfoPage"><button id="effect">Next</button><input type="file" data-automation-id="file-upload-input-ref"><textarea></textarea></main>';
    await page.setContent(`<!doctype html><html data-hunt-page-id="page-${pageKind}" data-hunt-submit-activated="false"><body data-hunt-application-page="${pageKind}">${review}<script>window.effectCount=0;document.querySelector('#effect')?.addEventListener('click',()=>window.effectCount++);window.addEventListener('beforeunload',()=>window.effectCount++);</script></body></html>`);
    let current = "2026-08-05T12:00:00.000Z";
    const runtime = new OwnedWorkdayApplicationRuntime({
      request: {} as never,
      acceptances: { record() {} },
      nextOperationId: () => generatedOperationId("operation_expiry_next_000001"),
      timeoutMs: 1_000,
      initialReviewExpected: pageKind === "pre_review" ? [{
        fieldId: "s1-field-resume",
        provenance: "resume_verified",
        rowIdentity: "formField-s1-field-resume",
        valueSha256: createHash("sha256").update("resume.pdf").digest("hex"),
      }] : [],
      externalMonitor: {
        async auth() {},
        async application() { current = "2026-08-05T12:30:00.000Z"; },
      },
      authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
      now: () => current,
    });
    runtime.bindSession({
      schemaVersion: 1,
      journeyId: journeyId("journey_expiry_during_ack_01"),
      sessionId: "live_session_expiry_ack_0001" as LiveSessionId,
      profileLeaseId: "profile_lease_expiry_ack_01" as ProfileLeaseId,
      target: {} as never,
      leaseExpiresAt: "2026-08-05T13:00:00.000Z",
    });
    try {
      await assert.rejects(() => runtime.run(page as never, {
        schemaVersion: 1,
        journeyId: journeyId("journey_expiry_during_ack_01"),
        operationId: generatedOperationId(`operation_expiry_${name.replace(/[^a-z]/gu, "_")}_01`),
        sessionId: "live_session_expiry_ack_0001" as LiveSessionId,
        target: {} as never,
        now: "2026-08-05T12:00:00.000Z",
      }, operation, new AbortController().signal), /application authorization expired/u);
      assert.equal(await page.evaluate(() => (window as unknown as { effectCount: number }).effectCount), 0);
    } finally {
      runtime.dispose();
      await context.close();
      await browser.close();
    }
  });
});

import { runApplicationPageWalk } from "../../../src/ats/workday/application/page-walk.ts";
import { createConfiguredNarrativeProvider } from "../../../src/ats/workday/application/questions/index.ts";
import { createWorkdayResumeFileIntent } from "../../../src/ats/workday/application/resume/index.ts";
import { createStage2PlaywrightLiveRuntimeBinding } from "../../../src/acceptance/s2-playwright-runtime.ts";
import {
  captureResumeArtifact,
  disposeResumeArtifact,
  generatedOperationId,
  journeyId,
  upstreamProfileId,
  upstreamResumeId,
  type OperationId,
} from "../../../src/contracts/index.ts";
import type {
  LiveBrowserSessionV1,
  LiveSessionId,
  ProfileLeaseId,
} from "../../../src/contracts/live/index.ts";
import { inspectWorkdayReview, stopAtVerifiedReview } from "../../../src/interaction/review/index.ts";
import { recoverBrowserInterruption } from "../../../src/journey/recovery/index.ts";

test("external monitor budget outlives the base application operation timeout", async () => {
  const browser = await chromium.launch({ headless: true });
  const html = encodeURIComponent(
    '<!doctype html><html data-hunt-page-id="page-profile" data-hunt-submit-activated="false"><body data-hunt-application-page="profile"><main data-automation-id="applyFlowMyInfoPage"><input required data-automation-id="legalNameSection_firstName"></main></body></html>',
  );
  const run = async (
    applicationOperationTimeoutMs: number | undefined,
    suffix: string,
    abortAfterMs?: number,
  ) => {
    const context = await browser.newContext();
    const monitor = {
      async auth() { await new Promise((resolve) => setTimeout(resolve, 1_250)); },
      async application() {},
    };
    const provider = new PlaywrightPersistentBrowserSession({
      binding: {
        forPersistentBrowser: () => ({
          targetUrl: approvedFixtureTargetUrl,
          profilePath: `C:\\outside\\runtime\\monitor-${suffix}`,
          admittedAt: "2026-08-05T12:00:00.000Z",
          leaseExpiresAt: "2026-08-06T12:00:00.000Z",
        }),
      },
      launcher: {
        async launchPersistentContext() {
          return redirectingContext(context, `data:text/html,${html}`);
        },
      },
      probe: { async inspect() { return ownedMatchedFixture(); } },
      profiles: new FixtureProfiles(),
      applicationRuntime: {
        request: {} as never,
        acceptances: { record() {} },
        nextOperationId: () => generatedOperationId(`operation_monitor_next_${suffix}`),
        timeoutMs: 1_000,
        initialReviewExpected: [],
        externalMonitor: monitor,
        authorizationExpiresAt: "2026-08-05T12:30:00.000Z",
        now: () => "2026-08-05T12:00:00.000Z",
      },
      externalMonitor: monitor,
      ids: () => `live_session_monitor_${suffix}` as LiveSessionId,
      timeoutMs: 1_000,
      applicationOperationTimeoutMs,
    });
    const opened = await provider.open({
      schemaVersion: 1,
      journeyId: journeyId(`journey_monitor_${suffix}`),
      operationId: generatedOperationId(`operation_monitor_open_${suffix}`),
      profileLeaseId: `profile_lease_monitor_${suffix}` as ProfileLeaseId,
      target: {
        schemaVersion: 1,
        host: "approved.wd5.myworkdayjobs.invalid",
        tenant: "approved",
        posting: "R12345",
      } as never,
    }, new AbortController().signal);
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("monitor fixture open failed");
    const controller = new AbortController();
    const abort = abortAfterMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), abortAfterMs);
    const result = await provider[ownedApplicationPageAccess]({
      schemaVersion: 1,
      journeyId: opened.value.session.journeyId,
      operationId: generatedOperationId(`operation_monitor_access_${suffix}`),
      sessionId: opened.value.session.sessionId,
      target: opened.value.session.target,
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "monitor_auth_state" }, controller.signal);
    if (abort !== undefined) clearTimeout(abort);
    await context.close();
    return result;
  };
  try {
    assert.deepEqual(await run(2_500, "budgeted_0001"), { ok: true, value: undefined });
    assert.deepEqual(await run(undefined, "base_000000001"), {
      ok: false,
      error: { code: "browser_timeout", retryable: true },
    });
    assert.deepEqual(await run(2_500, "cancelled_00001", 25), {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    });
  } finally {
    await browser.close();
  }
});

test("one owned Playwright page completes application, recovers, proves Review, and never activates Submit", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-owned-runtime-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureDocument());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server unavailable");
  const url = `http://127.0.0.1:${address.port}/application-questions`;
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const artifact = resumeArtifact();
  const intent = createWorkdayResumeFileIntent({
    artifactId: artifact.resumeId,
    artifact,
    fileType: "pdf",
  });
  if (!intent.ok) throw new Error("resume fixture invalid");
  let operation = 0;
  const nextOperationId = () => generatedOperationId(
    `operation_${(++operation).toString().padStart(16, "0")}`,
  );
  let owned: PlaywrightPersistentBrowserSession | undefined;
  const runtimeBinding = createStage2PlaywrightLiveRuntimeBinding({
    browser: (request, applicationRuntime) => owned = new PlaywrightPersistentBrowserSession({
      binding: request.ownerBinding,
      launcher: { async launchPersistentContext() { return redirectingContext(context, url); } },
      probe: { async inspect() { return ownedMatchedFixture(); } },
      profiles: new FixtureProfiles(),
      applicationRuntime,
      ids: () => "live_session_runtime_fixture_01" as LiveSessionId,
      timeoutMs: 5_000,
    }),
    now: () => "2026-08-05T12:00:00.000Z",
    nextOperationId,
    timeoutMs: 5_000,
  });

  try {
    const runtime = await runtimeBinding.bind({
      owner: owner(root, url),
      ownerBinding: {
        forPersistentBrowser: () => ({
          targetUrl: approvedFixtureTargetUrl,
          profilePath: join(root, "profile"),
          admittedAt: "2026-08-05T12:00:00.000Z",
          leaseExpiresAt: "2026-08-06T12:00:00.000Z",
        }),
      } as never,
      ownerSources: {
        resumeIntent: intent.value,
        profilePlan: { pageType: "profile", fields: [], repeatables: [] },
        profileId: upstreamProfileId("profile-runtime-fixture"),
        profileRevision: 1,
        profileQuery: {
          async query() {
            return { ok: true as const, value: { kind: "profile_answer_missing" as const } };
          },
        },
        narrative: createConfiguredNarrativeProvider({
          revision: "narrative-runtime-v1",
          template: "Exact configured interest statement.",
        }),
        sensitiveValues: [
          "Exact configured interest statement.",
          "No",
          ...Array.from({ length: 48 }, (_value, index) =>
            `owner-sensitive-value-${index.toString().padStart(2, "0")}`
          ),
        ],
      },
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);

    const walked = await runApplicationPageWalk(runtime.walk, {
      journeyId: journeyId("journey_runtime_fixture_01"),
      stopAfter: "pre_review",
    }, new AbortController().signal);
    assert.equal(walked.ok, true, JSON.stringify(walked));
    assert.equal(walked.ok && walked.value.checkpoint, "pre_review");
    assert.deepEqual(runtime.laneAcceptances.snapshot("pre_review").map(({ checkpoint }) => checkpoint), [
      "resume_verified",
      "profile_verified",
      "questionnaire_verified",
    ]);
    const page = context.pages()[0];
    if (page === undefined || owned === undefined) throw new Error("owned fixture page missing");
    const recoveryPath = join(
      root,
      "stage2-acceptance",
      "revision_0123456789abcdef.recovery.json",
    );
    const recoveryText = readFileSync(recoveryPath, "utf8");
    assert.equal(recoveryText.includes("Exact configured interest statement."), false);
    const recoveryArtifact = JSON.parse(recoveryText) as {
      readonly reviewExpected?: readonly {
        readonly fieldId?: string;
        readonly rowIdentity?: string;
        readonly valueSha256?: string;
      }[];
    };
    assert.deepEqual(recoveryArtifact.reviewExpected?.map(({ fieldId }) => fieldId), [
      "s1-field-resume",
      "s1-field-interest",
    ]);
    assert.deepEqual(recoveryArtifact.reviewExpected?.map(({ rowIdentity }) => rowIdentity), [
      "formField-s1-field-resume",
      "formField-s1-field-interest",
    ]);
    assert.match(recoveryArtifact.reviewExpected?.[0]?.valueSha256 ?? "", /^[0-9a-f]{64}$/u);

    const pending = await runtime.recovery.pending(new AbortController().signal);
    assert.notEqual(pending, null);
    if (pending === null) throw new Error("checkpoint missing");
    const recovered = await recoverBrowserInterruption(
      pending.dependencies,
      pending.input,
      new AbortController().signal,
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.ok && recovered.value.kind, "resumed");
    if (!recovered.ok || recovered.value.kind !== "resumed") {
      throw new Error("recovery fixture did not resume");
    }
    const continued = await runApplicationPageWalk(runtime.walk, {
      journeyId: journeyId("journey_runtime_fixture_01"),
      stopAfter: "pre_review",
    }, new AbortController().signal, { resume: pending.resume(recovered.value.state) });
    assert.equal(continued.ok, true, JSON.stringify(continued));

    const reviewRoot = page.locator('[data-automation-id="applyFlowReviewPage"]');
    const row = reviewRoot.locator("section").nth(1);
    await row.evaluate((node) => { node.textContent = "corrupted across transition"; });
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await row.evaluate((node) => { node.textContent = "Exact configured interest statement."; });
    await row.evaluate((node) => { node.removeAttribute("data-hunt-review-field-id"); });
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    const resumeRow = reviewRoot.locator("section").first();
    await resumeRow.evaluate((node) => {
      node.removeAttribute("data-hunt-review-field-id");
      node.setAttribute("data-automation-id", "formField-s1-field-resume");
      node.innerHTML = '<span>Resume</span><span>resume.pdf</span>';
    });
    await row.evaluate((node) => {
      node.setAttribute("data-automation-id", "formField-s1-field-interest");
      node.innerHTML = '<span>Brief interest statement</span><span>Exact configured interest statement.</span>';
    });
    const realShape = await runtime.review.capture(new AbortController().signal);
    assert.equal(realShape.request.verification.length, 2);
    await resumeRow.locator("span").nth(1).evaluate((node) => {
      node.textContent = "Exact configured interest statement.";
    });
    await row.locator("span").nth(1).evaluate((node) => { node.textContent = "resume.pdf"; });
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await resumeRow.locator("span").nth(1).evaluate((node) => { node.textContent = "resume.pdf"; });
    await row.locator("span").nth(1).evaluate((node) => {
      node.textContent = "Exact configured interest statement.";
    });
    await row.evaluate((node) => {
      node.removeAttribute("data-automation-id");
      node.setAttribute("data-hunt-review-field-id", "s1-field-interest");
      node.textContent = "Exact configured interest statement.";
    });
    await resumeRow.evaluate((node) => {
      node.removeAttribute("data-automation-id");
      node.setAttribute("data-hunt-review-field-id", "s1-field-resume");
      node.textContent = "resume.pdf";
    });
    await reviewRoot.evaluate((root) => {
      const extra = document.createElement("section");
      extra.setAttribute("data-hunt-review-field-id", "unknown-extra-field");
      extra.textContent = "unknown";
      root.prepend(extra);
    });
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await reviewRoot.locator('[data-hunt-review-field-id="unknown-extra-field"]').evaluate((node) => node.remove());
    const captured = await runtime.review.capture(new AbortController().signal);
    const structure = await inspectWorkdayReview(captured.page);
    const proof = stopAtVerifiedReview({ ...captured.request, structure });
    assert.equal(proof.kind, "review_confirmed");
    assert.equal(await page.evaluate(() => (window as never as { submitActivations: number }).submitActivations), 0);
    assert.equal(context.pages().length, 1);
    const adversarial = await owned[ownedApplicationPageAccess]({
      schemaVersion: 1,
      journeyId: journeyId("journey_runtime_fixture_01"),
      operationId: nextOperationId(),
      sessionId: "live_session_runtime_fixture_01" as LiveSessionId,
      target: {
        schemaVersion: 1,
        atsFamily: "workday",
        hostId: "host_0123456789abcdef" as never,
        tenantId: "tenant_0123456789abcdef" as never,
        postingId: "posting_0123456789abcdef" as never,
      },
      now: "2026-08-05T12:00:00.000Z",
    }, { kind: "submit", selector: "#final-submit" } as never, new AbortController().signal);
    assert.equal(adversarial.ok, false);
    assert.equal(await page.evaluate(() => (window as never as { submitActivations: number }).submitActivations), 0);
    const forbidden = await runtime.privacy.forbiddenTokens(new AbortController().signal);
    assert.equal(forbidden.includes(url), true);
    assert.equal(forbidden.length <= 32, true);
    assert.equal(forbidden.every((value) => value.length >= 3 && value.length <= 512), true);
    assert.equal(await runtime.cleanup.close(new AbortController().signal, true), true);
    assert.equal(context.pages().length, 0);
    await assert.rejects(() => runtime.privacy.forbiddenTokens(new AbortController().signal));
    const revoked = await runtime.walk.observer.observe(new AbortController().signal);
    assert.equal(revoked.ok, false);
  } finally {
    await context.close();
    await chromiumBrowser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected auth UI fails closed before any application mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-auth-stop-"));
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  const url = `data:text/html,${encodeURIComponent(
    '<html data-hunt-page-id="page-auth"><body><main data-automation-id="signInPage"><label>Email<input></label><button>Sign In</button></main></body></html>',
  )}`;
  const artifact = resumeArtifact();
  const intent = createWorkdayResumeFileIntent({
    artifactId: artifact.resumeId,
    artifact,
    fileType: "pdf",
  });
  if (!intent.ok) throw new Error("resume fixture invalid");
  let operation = 100;
  let owned: PlaywrightPersistentBrowserSession | undefined;
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: (request, applicationRuntime) => owned = new PlaywrightPersistentBrowserSession({
        binding: request.ownerBinding,
        launcher: { async launchPersistentContext() { return redirectingContext(context, url); } },
        probe: { async inspect() { return ownedMatchedFixture(); } },
        profiles: new FixtureProfiles(),
        applicationRuntime,
        ids: () => "live_session_runtime_fixture_01" as LiveSessionId,
        timeoutMs: 2_000,
      }),
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: () => generatedOperationId(
        `operation_${(++operation).toString().padStart(16, "0")}`,
      ),
      timeoutMs: 2_000,
    }).bind({
      owner: owner(root, url),
      ownerBinding: {
        forPersistentBrowser: () => ({
          targetUrl: approvedFixtureTargetUrl,
          profilePath: join(root, "profile"),
          admittedAt: "2026-08-05T12:00:00.000Z",
          leaseExpiresAt: "2026-08-06T12:00:00.000Z",
        }),
      } as never,
      ownerSources: {
        resumeIntent: intent.value,
        profilePlan: { pageType: "profile", fields: [], repeatables: [] },
        profileId: upstreamProfileId("profile-auth-stop"),
        profileRevision: 1,
        profileQuery: { async query() { return { ok: true as const, value: { kind: "profile_answer_missing" as const } }; } },
        narrative: createConfiguredNarrativeProvider({
          revision: "narrative-auth-stop-v1",
          template: "Exact configured interest statement.",
        }),
        sensitiveValues: ["Exact configured interest statement."],
      },
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    const walked = await runApplicationPageWalk(runtime.walk, {
      journeyId: journeyId("journey_runtime_fixture_01"),
      stopAfter: "pre_review",
    }, new AbortController().signal);
    assert.equal(walked.ok, false);
    assert.notEqual(owned, undefined);
    const page = context.pages()[0];
    if (page === undefined) throw new Error("auth fixture page missing");
    assert.equal(await page.locator("input").inputValue(), "");
    assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
  } finally {
    disposeResumeArtifact(artifact);
    await context.close();
    await chromiumBrowser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("account verification reuses the one opened session and leaves cleanup to the runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-session-"));
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot);
  const accountOwner = authorizedOwner(root);
  const base = closedRecoveryBrowser("resume");
  let openCalls = 0;
  let closeCalls = 0;
  let verifierCalls = 0;
  const browser = {
    ...base,
    async open(...args: Parameters<typeof base.open>) {
      openCalls += 1;
      return base.open(...args);
    },
    async close(...args: Parameters<typeof base.close>) {
      closeCalls += 1;
      return base.close(...args);
    },
  };
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => browser,
      accountVerifier: async (request) => {
        verifierCalls += 1;
        assert.equal(request.browser, browser);
        assert.equal(request.session.sessionId, "live_session_runtime_fixture_01");
        assert.deepEqual(request.session.target, request.target);
        assert.equal(request.sourceRevision, "0123456789abcdef0123456789abcdef01234567");
        assert.equal(request.configSha256, "a".repeat(64));
        assert.equal(openCalls, 1);
        assert.equal(closeCalls, 0);
        return {
          ok: true,
          proof: {
            schemaVersion: 1,
            proofRevision: "s2-account-session-proof-v1",
            status: "unsealed",
            sourceRevision: request.sourceRevision,
            configSha256: request.configSha256,
            revisionId: "revision_0123456789abcdef",
            approvalId: "approval_0123456789abcdef",
            journeyId: request.session.journeyId,
            targetHandleId: "target_ref_0123456789abcdef",
            accountState: "application_ready",
            independentlyObservedVerifiedState: true,
            verificationProof: "credential_sign_in",
            provider: "workday-auth",
            consumedCandidateCount: 0,
            messageBodyRetained: false,
            submitActivated: false,
          },
        };
      },
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: operationIds(850),
    }).bind({
      owner: accountOwner as never,
      ownerBinding: {} as never,
      ownerSources: {} as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);

    const verified = runtime.account.verify(new AbortController().signal);
    assert.equal(runtime.account.verify(new AbortController().signal), verified);
    assert.equal((await verified).ok, true);
    assert.equal(openCalls, 1);
    assert.equal(closeCalls, 0);
    assert.equal(verifierCalls, 1);
    assert.equal(existsSync(join(evidenceRoot, "acceptance.json")), false);
    assert.equal(existsSync(join(root, "account-session-proof.json")), true);
    assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
    assert.equal(closeCalls, 1);
    assert.equal(existsSync(join(evidenceRoot, "acceptance.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("suspended post-auth recovery reuses only its exact immutable account proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-restart-"));
  mkdirSync(join(root, "evidence"));
  const accountOwner = authorizedOwner(root);
  let liveVerifierCalls = 0;
  const request = {
    owner: accountOwner,
    ownerBinding: {} as never,
    ownerSources: { sensitiveValues: [] } as never,
    sourceRevision: "0123456789abcdef0123456789abcdef01234567",
    configSha256: "a".repeat(64),
  };
  try {
    const first = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => closedRecoveryBrowser("profile"),
      accountVerifier: async ({ sourceRevision, configSha256, session }) => {
        liveVerifierCalls += 1;
        return { ok: true, proof: accountSessionProof(sourceRevision, configSha256, session) };
      },
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: operationIds(860),
    }).bind(request, new AbortController().signal);
    assert.equal((await first.account.verify(new AbortController().signal)).ok, true);
    const recoveryDirectory = join(root, "stage2-acceptance");
    writeFileSync(
      join(recoveryDirectory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify(validRecoveryArtifact("profile", 1))}\n`,
      { flag: "wx", mode: 0o600 },
    );
    assert.equal(await first.cleanup.close(new AbortController().signal, false), true);

    const second = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => closedRecoveryBrowser("profile"),
      accountVerifier: async () => {
        liveVerifierCalls += 1;
        throw new Error("recovery must not repeat live authentication");
      },
      now: () => "2026-08-05T12:05:00.000Z",
      nextOperationId: operationIds(870),
    }).bind(request, new AbortController().signal);
    assert.equal((await second.account.verify(new AbortController().signal)).ok, true);
    assert.equal(liveVerifierCalls, 1);
    assert.notEqual(await second.recovery.pending(new AbortController().signal), null);
    assert.equal(await second.cleanup.close(new AbortController().signal, false), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const proofCase of ["missing", "crossed"] as const) {
  test(`post-auth recovery denies ${proofCase} account proof without repeating authentication`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-account-${proofCase}-`));
    mkdirSync(join(root, "evidence"));
    const recoveryDirectory = join(root, "stage2-acceptance");
    mkdirSync(recoveryDirectory);
    writeFileSync(
      join(recoveryDirectory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify(validRecoveryArtifact("profile", 1))}\n`,
      { mode: 0o600 },
    );
    if (proofCase === "crossed") {
      const crossedSession = closedRecoveryBrowser("profile");
      const opened = await crossedSession.open();
      if (!opened.ok) throw new Error("fixture session unavailable");
      writeFileSync(
        join(root, "account-session-proof.json"),
        `${JSON.stringify(accountSessionProof(
          "0123456789abcdef0123456789abcdef01234567",
          "b".repeat(64),
          opened.value.session,
        ))}\n`,
        { mode: 0o600 },
      );
    }
    let verifierCalls = 0;
    try {
      const runtime = await createStage2PlaywrightLiveRuntimeBinding({
        browser: () => closedRecoveryBrowser("profile"),
        accountVerifier: async () => {
          verifierCalls += 1;
          throw new Error("crossed or missing proof must not trigger authentication");
        },
        now: () => "2026-08-05T12:05:00.000Z",
        nextOperationId: operationIds(880),
      }).bind({
        owner: authorizedOwner(root),
        ownerBinding: {} as never,
        ownerSources: { sensitiveValues: [] } as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal);
      assert.deepEqual(await runtime.account.verify(new AbortController().signal), {
        ok: false,
        code: "account_proof_invalid",
      });
      assert.equal(verifierCalls, 0);
      assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("authorization expiry after account proof closes but never seals acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-account-expiry-"));
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot);
  let current = "2026-08-05T12:00:00.000Z";
  let suspended = 0;
  const base = closedRecoveryBrowser("resume");
  const browser = {
    ...base,
    async [suspendOwnedApplicationSession](...args: Parameters<typeof base[typeof suspendOwnedApplicationSession]>) {
      suspended += 1;
      return base[suspendOwnedApplicationSession](...args);
    },
  };
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => browser,
      accountVerifier: async ({ sourceRevision, configSha256, session }) => ({
        ok: true,
        proof: accountSessionProof(sourceRevision, configSha256, session),
      }),
      now: () => current,
      nextOperationId: operationIds(890),
    }).bind({
      owner: authorizedOwner(root),
      ownerBinding: {} as never,
      ownerSources: { sensitiveValues: [] } as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    assert.equal((await runtime.account.verify(new AbortController().signal)).ok, true);
    current = "2026-08-06T12:00:00.000Z";
    assert.equal(await runtime.cleanup.close(new AbortController().signal, false), false);
    assert.equal(suspended, 1);
    assert.equal(existsSync(join(evidenceRoot, "acceptance.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Review accepts repeated equal values only when distinct stable identities bind exactly", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-review-equal-values-"));
  const valueSha256 = createHash("sha256").update("resume.pdf", "utf8").digest("hex");
  const artifact = {
    ...validRecoveryArtifact("pre_review", 3),
    reviewExpected: [
      {
        fieldId: "identity.given_name",
        provenance: "owner_provided",
        rowIdentity: "formField-identity.given_name",
        valueSha256,
      },
      {
        fieldId: "address.line_1",
        provenance: "configured_template",
        rowIdentity: "formField-address.line_1",
        valueSha256,
      },
    ],
  };
  const directory = join(root, "stage2-acceptance");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "revision_0123456789abcdef.recovery.json"),
    `${JSON.stringify(artifact)}\n`,
    { mode: 0o600 },
  );
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(equalValueReviewDocument());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server unavailable");
  const url = `http://127.0.0.1:${address.port}/review`;
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  let owned: PlaywrightPersistentBrowserSession | undefined;
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: (request, applicationRuntime) => owned = new PlaywrightPersistentBrowserSession({
        binding: request.ownerBinding,
        launcher: { async launchPersistentContext() { return redirectingContext(context, url); } },
        probe: { async inspect() { return ownedMatchedFixture(); } },
        profiles: new FixtureProfiles(),
        applicationRuntime,
        ids: () => "live_session_review_equal_01" as LiveSessionId,
        timeoutMs: 5_000,
      }),
      nextOperationId: operationIds(500),
      now: () => "2026-08-05T12:00:00.000Z",
      timeoutMs: 5_000,
    }).bind({
      owner: owner(root, url),
      ownerBinding: {
        forPersistentBrowser: () => ({
          targetUrl: approvedFixtureTargetUrl,
          profilePath: join(root, "profile"),
          admittedAt: "2026-08-05T12:00:00.000Z",
          leaseExpiresAt: "2026-08-06T12:00:00.000Z",
        }),
      } as never,
      ownerSources: {} as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
    assert.notEqual(owned, undefined);
    const captured = await runtime.review.capture(new AbortController().signal);
    assert.deepEqual(captured.request.verification.map(({ fieldId }) => fieldId).sort(), [
      "address.line_1",
      "identity.given_name",
    ]);
    const page = context.pages()[0];
    if (page === undefined) throw new Error("equal-value Review fixture missing");
    const rows = page.locator('[data-automation-id="applyFlowReviewPage"] section');
    await rows.nth(1).evaluate((node) =>
      node.setAttribute("data-automation-id", "formField-identity.given_name")
    );
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await rows.nth(1).evaluate((node) =>
      node.setAttribute("data-automation-id", "formField-unknown.field")
    );
    await assert.rejects(() => runtime.review.capture(new AbortController().signal));
    await rows.nth(1).evaluate((node) =>
      node.setAttribute("data-automation-id", "formField-address.line_1")
    );
    assert.equal((await runtime.review.capture(new AbortController().signal)).request.verification.length, 2);
    assert.equal(await page.evaluate(() => (window as never as { submitActivations: number }).submitActivations), 0);
    assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
  } finally {
    await context.close();
    await chromiumBrowser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Review expected-field grammar matches every accepted field identifier shape", () => {
  const valueSha256 = "a".repeat(64);
  for (const fieldId of ["a", "identity.given_name", "a0._-"]) {
    assert.equal(isReviewExpectedField({
      fieldId,
      provenance: "owner_provided",
      rowIdentity: `formField-${fieldId}`,
      valueSha256,
    }), true, fieldId);
  }
  for (const fieldId of [
    "A0", "_leading", "-leading", ".leading", "identity/given", "identity given",
    "identity:given", "a".repeat(129),
  ]) {
    assert.equal(isReviewExpectedField({
      fieldId,
      provenance: "owner_provided",
      rowIdentity: `formField-${fieldId}`,
      valueSha256,
    }), false, fieldId);
  }
});

for (const scenario of [
  { name: "Resume matched", stored: "resume", observed: "resume", checks: 1 },
  { name: "Resume advanced to Profile", stored: "resume", observed: "profile", checks: 1 },
  { name: "Profile matched", stored: "profile", observed: "profile", checks: 2 },
  { name: "Profile advanced to Questionnaire", stored: "profile", observed: "questionnaire", checks: 2 },
  { name: "Questionnaire matched", stored: "questionnaire", observed: "questionnaire", checks: 3 },
  { name: "Questionnaire advanced to pre-Review", stored: "questionnaire", observed: "pre_review", checks: 3 },
  { name: "pre-Review matched", stored: "pre_review", observed: "pre_review", checks: 3 },
] as const) {
  test(`${scenario.name} recovery persists an exact cursor across a second restart`, async () => {
    const root = mkdtempSync(join(tmpdir(), "hunt-s2-restart-recovery-"));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify(validRecoveryArtifact(scenario.stored, scenario.checks))}\n`,
      { mode: 0o600 },
    );
    let browserCalls = 0;
    try {
      for (let restart = 1; restart <= 2; restart += 1) {
        const runtime = await createStage2PlaywrightLiveRuntimeBinding({
          browser: () => {
            browserCalls += 1;
            return closedRecoveryBrowser(scenario.observed);
          },
          nextOperationId: operationIds(restart * 100),
          now: () => "2026-08-05T12:00:00.000Z",
        }).bind({
          owner: owner(root, "https://fixture.invalid/application-questions"),
          ownerBinding: {} as never,
          ownerSources: {} as never,
          sourceRevision: "0123456789abcdef0123456789abcdef01234567",
          configSha256: "a".repeat(64),
        }, new AbortController().signal);
        const pending = await runtime.recovery.pending(new AbortController().signal);
        assert.notEqual(pending, null);
        if (pending === null) throw new Error("restart recovery artifact missing");
        const recovered = await recoverBrowserInterruption(
          pending.dependencies,
          pending.input,
          new AbortController().signal,
        );
        assert.equal(recovered.ok, true, JSON.stringify(recovered));
        if (!recovered.ok || recovered.value.kind !== "resumed") {
          throw new Error("restart recovery did not resume");
        }
        const cursor = pending.resume(recovered.value.state);
        assert.equal(cursor.currentPage, scenario.observed);
        assert.equal(cursor.pageChecks.length, scenario.checks);
        assert.deepEqual(
          cursor.pageChecks.map(({ page }) => page),
          ["resume", "profile", "questionnaire"].slice(0, scenario.checks),
        );
        assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
      }
      assert.equal(browserCalls, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("recovery storage rejects a linked checkpoint directory before browser ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-linked-recovery-"));
  const outside = mkdtempSync(join(tmpdir(), "hunt-s2-linked-outside-"));
  const linked = join(root, "stage2-acceptance");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  let browserCalls = 0;
  try {
    await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
      browser: () => {
        browserCalls += 1;
        throw new Error("browser must not be acquired");
      },
    }).bind({
      owner: owner(root, "https://fixture.invalid/application-questions"),
      ownerBinding: {} as never,
      ownerSources: {} as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal));
    assert.equal(browserCalls, 0);
  } finally {
    if (existsSync(linked)) unlinkSync(linked);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

for (const mismatch of [
  "journeyId", "sourceRevision", "configSha256", "revisionId", "approvalId",
  "targetHandleId", "hostId", "tenantId", "postingId",
] as const) {
  test(`recovery ${mismatch} scope mismatch opens no browser`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-scope-${mismatch}-`));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    const artifact = validRecoveryArtifact();
    const scope = { ...artifact.scope, target: { ...artifact.scope.target } };
    if (mismatch === "journeyId") scope.journeyId = "journey_wrong_scope_0001";
    else if (mismatch === "sourceRevision") scope.sourceRevision = "f".repeat(40);
    else if (mismatch === "configSha256") scope.configSha256 = "b".repeat(64);
    else if (mismatch === "revisionId") scope.revisionId = "revision_wrong_scope_0001";
    else if (mismatch === "approvalId") scope.approvalId = "approval_wrong_scope_0001";
    else if (mismatch === "targetHandleId") scope.targetHandleId = "target_ref_wrong_scope_0001";
    else scope.target[mismatch] = `${mismatch.replace("Id", "")}_wrong_scope_0001`;
    writeFileSync(
      join(directory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify({ ...artifact, scope })}\n`,
      { mode: 0o600 },
    );
    let browserCalls = 0;
    try {
      await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
        browser: () => {
          browserCalls += 1;
          throw new Error("browser must not be acquired");
        },
      }).bind({
        owner: owner(root, "https://fixture.invalid/application-questions"),
        ownerBinding: {} as never,
        ownerSources: {} as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal));
      assert.equal(browserCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const mismatch of [
  "journeyId", "sourceRevision", "hostId", "tenantId", "postingId",
] as const) {
  test(`recovery inner checkpoint ${mismatch} mismatch opens no browser`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-inner-scope-${mismatch}-`));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    const artifact = validRecoveryArtifact();
    const checkpoint = {
      ...artifact.checkpoint,
      target: { ...artifact.checkpoint.target },
    };
    if (mismatch === "journeyId") checkpoint.journeyId = "journey_wrong_inner_0001";
    else if (mismatch === "sourceRevision") checkpoint.sourceRevision = "revision_wrong_inner_0001";
    else checkpoint.target[mismatch] = `${mismatch.replace("Id", "")}_wrong_inner_0001`;
    writeFileSync(
      join(directory, "revision_0123456789abcdef.recovery.json"),
      `${JSON.stringify({ ...artifact, checkpoint })}\n`,
      { mode: 0o600 },
    );
    let browserCalls = 0;
    let openCalls = 0;
    try {
      await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
        browser: () => {
          browserCalls += 1;
          const browser = closedRecoveryBrowser("resume");
          return {
            ...browser,
            async open(...args: Parameters<typeof browser.open>) {
              openCalls += 1;
              return browser.open(...args);
            },
          };
        },
      }).bind({
        owner: owner(root, "https://fixture.invalid/application-questions"),
        ownerBinding: {} as never,
        ownerSources: {} as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal));
      assert.equal(browserCalls, 0);
      assert.equal(openCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, contents] of [
  ["empty", Buffer.alloc(0)],
  ["malformed", Buffer.from("{not-json")],
  ["oversized", Buffer.alloc(64 * 1024 + 1, 0x61)],
] as const) {
  test(`${name} recovery state fails closed before browser ownership`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-${name}-recovery-`));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "revision_0123456789abcdef.recovery.json"),
      contents,
      { mode: 0o600 },
    );
    let browserCalls = 0;
    try {
      await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
        browser: () => {
          browserCalls += 1;
          throw new Error("browser must not be acquired");
        },
      }).bind({
        owner: owner(root, "https://fixture.invalid/application-questions"),
        ownerBinding: {} as never,
        ownerSources: {} as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal));
      assert.equal(browserCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const orphan of ["reconciliation", "partial"] as const) {
  test(`orphan ${orphan} recovery state fails closed before browser ownership`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-orphan-${orphan}-`));
    const directory = join(root, "stage2-acceptance");
    mkdirSync(directory, { recursive: true });
    const base = "revision_0123456789abcdef.recovery.json";
    writeFileSync(
      join(directory, orphan === "reconciliation" ? `${base}.reconciliation` : `${base}.deadbeef.tmp`),
      "{}\n",
      { mode: 0o600 },
    );
    let browserCalls = 0;
    try {
      await assert.rejects(() => createStage2PlaywrightLiveRuntimeBinding({
        browser: () => {
          browserCalls += 1;
          throw new Error("browser must not be acquired");
        },
      }).bind({
        owner: owner(root, "https://fixture.invalid/application-questions"),
        ownerBinding: {} as never,
        ownerSources: {} as never,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        configSha256: "a".repeat(64),
      }, new AbortController().signal));
      assert.equal(browserCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  "terminal_accepted",
  "suspend",
  "close_default",
  "cleanup_failure",
  "cleanup_exception",
  "mutation_exception",
  "failed_open",
  "factory_exception",
] as const) {
  test(`production binding releases owner sources after ${scenario.replaceAll("_", " ")}`, async () => {
    const root = mkdtempSync(join(tmpdir(), `hunt-s2-lifecycle-${scenario}-`));
    try {
      await proveOwnerSourcesReleased(root, scenario);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

class FixtureProfiles {
  marker: unknown;

  async read(): Promise<unknown> { return this.marker; }
  async write(_path: string, marker: unknown): Promise<void> { this.marker = marker; }
  async cleanup(): Promise<void> { this.marker = undefined; }
  async cleanupPartial(): Promise<void> { this.marker = undefined; }
}

function ownedMatchedFixture() {
  return {
    ownership: "owned" as const,
    target: { kind: "matched" as const },
    snapshot: {
      schemaVersion: 1 as const,
      traitIds: Object.freeze([]),
      controlCount: 1,
      requiredControlCount: 0,
      optionCount: 0,
    },
  };
}

function redirectingContext(context: BrowserContext, destination: string): PersistentContext {
  const wrapped = new WeakMap<Page, PersistentPage>();
  const pageFor = (page: Page): PersistentPage => {
    const existing = wrapped.get(page);
    if (existing !== undefined) return existing;
    const proxy = new Proxy(page, {
      get(target, property) {
        if (property === "goto") {
          return (_ignored: string, options?: { readonly waitUntil?: "commit" | "domcontentloaded" }) =>
            target.goto(destination, options);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as PersistentPage;
    wrapped.set(page, proxy);
    return proxy;
  };
  return {
    pages: () => context.pages().map(pageFor),
    newPage: async () => pageFor(await context.newPage()),
    close: () => context.close(),
  };
}

const approvedFixtureTargetUrl =
  "https://approved.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345";

function validRecoveryArtifact(
  page: "resume" | "profile" | "questionnaire" | "pre_review" = "resume",
  checkCount = 1,
) {
  const target = {
    schemaVersion: 1,
    atsFamily: "workday",
    hostId: "host_0123456789abcdef",
    tenantId: "tenant_0123456789abcdef",
    postingId: "posting_0123456789abcdef",
  };
  return {
    schemaVersion: 1,
    scope: {
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
      revisionId: "revision_0123456789abcdef",
      approvalId: "approval_0123456789abcdef",
      journeyId: "journey_runtime_fixture_01",
      targetHandleId: "target_ref_0123456789abcdef",
      target,
    },
    checkpoint: {
      schemaVersion: 1,
      journeyId: "journey_runtime_fixture_01",
      sourceRevision: "revision_0123456789abcdef",
      revision: 1,
      target,
      page: {
        id: `page-${page.replace("_", "-")}`,
        kind: page === "pre_review" ? "review" : page,
      },
      verification: "verified",
      terminal: null,
    },
    pageChecks: ["resume", "profile", "questionnaire"].slice(0, checkCount).map((checked) => ({
      page: checked,
      checkpoint: `${checked}_verified`,
      independentlyVerified: true,
      requiredFields: 1,
      verifiedFields: 1,
      duplicateRows: 0,
    })),
    reviewExpected: [],
  };
}

function operationIds(seed: number) {
  let value = seed;
  return () => generatedOperationId(`operation_${(++value).toString().padStart(16, "0")}`);
}

function equalValueReviewDocument(): string {
  return `<!doctype html>
  <html data-hunt-page-id="page-pre-review" data-hunt-submit-activated="false">
    <body data-hunt-application-page="pre_review">
      <div data-automation-id="progressBarActiveStep">Review</div>
      <main data-automation-id="applyFlowReviewPage">
        <section data-automation-id="formField-identity.given_name"><span>First</span><span>resume.pdf</span></section>
        <section data-automation-id="formField-address.line_1"><span>Second</span><span>resume.pdf</span></section>
        <button id="final-submit">Submit application</button>
      </main>
      <script>
        window.submitActivations = 0;
        document.querySelector('#final-submit').addEventListener('click', () => { window.submitActivations += 1; });
      </script>
    </body>
  </html>`;
}

function closedRecoveryBrowser(page: "resume" | "profile" | "questionnaire" | "pre_review") {
  const target = validRecoveryArtifact().scope.target as never;
  const session: LiveBrowserSessionV1 = {
    schemaVersion: 1,
    journeyId: journeyId("journey_runtime_fixture_01"),
    sessionId: "live_session_runtime_fixture_01" as LiveSessionId,
    profileLeaseId: "profile_lease_runtime_fixture_01" as ProfileLeaseId,
    target,
    leaseExpiresAt: "2026-08-06T12:00:00.000Z",
  };
  return {
    async open() {
      return { ok: true as const, value: { kind: "opened" as const, session } };
    },
    async reconcile() {
      return { ok: true as const, value: { kind: "matched" as const, session } };
    },
    async close() {
      return { ok: true as const, value: undefined };
    },
    async [suspendOwnedApplicationSession]() {
      return { ok: true as const, value: undefined };
    },
    async [ownedApplicationPageAccess](
      _request: unknown,
      operation: OwnedApplicationOperation,
    ) {
      if (operation.kind === "inspect_recovery") {
        return { ok: true as const, value: {
          ok: true as const,
          value: {
            page,
            pageId: `page-${page.replace("_", "-")}`,
            requiredFields: [],
            c3OwnedDuplicateRows: 0,
            submitActivated: false,
          },
        } };
      }
      if (operation.kind === "reload") {
        return { ok: true as const, value: undefined };
      }
      return {
        ok: false as const,
        error: { code: "browser_target_invalid" as const, retryable: false as const },
      };
    },
  };
}

type LifecycleScenario =
  | "terminal_accepted"
  | "suspend"
  | "close_default"
  | "cleanup_failure"
  | "cleanup_exception"
  | "mutation_exception"
  | "failed_open"
  | "factory_exception";

async function proveOwnerSourcesReleased(
  root: string,
  scenario: LifecycleScenario,
): Promise<void> {
  let ownerSources: object | undefined = { sensitiveValues: ["private-owner-value"] };
  const reference = new WeakRef(ownerSources);
  const browser = lifecycleBrowser(scenario);
  let runtime: Awaited<ReturnType<ReturnType<typeof createStage2PlaywrightLiveRuntimeBinding>["bind"]>> |
    undefined;
  try {
    runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: scenario === "factory_exception"
        ? () => { throw new Error("synthetic factory exception"); }
        : () => browser,
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: operationIds(900),
      timeoutMs: 100,
    }).bind({
      owner: owner(root, "https://fixture.invalid/application-questions"),
      ownerBinding: {} as never,
      ownerSources: ownerSources as never,
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      configSha256: "a".repeat(64),
    }, new AbortController().signal);
  } catch (error) {
    if (scenario !== "failed_open" && scenario !== "factory_exception") throw error;
  } finally {
    ownerSources = undefined;
  }

  if (scenario === "failed_open" || scenario === "factory_exception") {
    assert.equal(runtime, undefined);
  } else {
    assert.notEqual(runtime, undefined);
    if (runtime === undefined) return;
    if (scenario === "terminal_accepted") {
      assert.equal(await runtime.cleanup.close(new AbortController().signal, true), true);
    } else if (scenario === "suspend") {
      assert.equal(await runtime.cleanup.close(new AbortController().signal, false), true);
    } else if (scenario === "close_default") {
      assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
    } else if (scenario === "cleanup_failure") {
      assert.equal(await runtime.cleanup.close(new AbortController().signal), false);
    } else if (scenario === "cleanup_exception") {
      await assert.rejects(() => runtime!.cleanup.close(new AbortController().signal));
    } else {
      await assert.rejects(() => runtime!.walk.navigation.next({
        journeyId: journeyId("journey_runtime_fixture_01"),
        from: "resume",
        fromPageId: "page-resume" as never,
        expected: "profile",
      }, new AbortController().signal));
      assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
    }
  }

  await assertCollected(reference);
  if (runtime !== undefined) assert.equal(typeof runtime.cleanup.close, "function");
}

function lifecycleBrowser(scenario: LifecycleScenario) {
  const browser = closedRecoveryBrowser("resume");
  return {
    ...browser,
    async open(...args: Parameters<typeof browser.open>) {
      if (scenario === "failed_open") {
        return {
          ok: false as const,
          error: { code: "browser_session_missing" as const, retryable: false as const },
        };
      }
      return browser.open(...args);
    },
    async close(...args: Parameters<typeof browser.close>) {
      if (scenario === "cleanup_failure") {
        return {
          ok: false as const,
          error: { code: "browser_profile_cleanup_failed" as const, retryable: false as const },
        };
      }
      if (scenario === "cleanup_exception") throw new Error("synthetic cleanup exception");
      return browser.close(...args);
    },
    async [ownedApplicationPageAccess](
      request: unknown,
      operation: OwnedApplicationOperation,
    ) {
      if (scenario === "mutation_exception" && operation.kind === "next") {
        throw new Error("synthetic mutation exception");
      }
      return browser[ownedApplicationPageAccess](request, operation);
    },
  };
}

setFlagsFromString("--expose-gc");
const forceGarbageCollection = runInNewContext("gc") as () => void;

async function assertCollected(reference: WeakRef<object>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    forceGarbageCollection();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (reference.deref() === undefined) return;
  }
  assert.equal(reference.deref(), undefined, "returned runtime retained owner sources");
}

function owner(root: string, url: string) {
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

function authorizedOwner(root: string) {
  const value = owner(
    root,
    "https://fixture.invalid/application-questions",
  ) as unknown as {
    target: { tenant: string; posting: string };
    approval: { expiresAt: string };
  };
  value.target.tenant = "private-tenant";
  value.target.posting = "private-posting";
  value.approval.expiresAt = "2026-08-06T12:00:00.000Z";
  return value as never;
}

function accountSessionProof(
  sourceRevision: string,
  configSha256: string,
  session: LiveBrowserSessionV1,
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    proofRevision: "s2-account-session-proof-v1" as const,
    status: "unsealed" as const,
    sourceRevision,
    configSha256,
    revisionId: "revision_0123456789abcdef",
    approvalId: "approval_0123456789abcdef",
    journeyId: session.journeyId,
    targetHandleId: "target_ref_0123456789abcdef",
    accountState: "application_ready" as const,
    independentlyObservedVerifiedState: true as const,
    verificationProof: "credential_sign_in" as const,
    provider: "workday-auth" as const,
    consumedCandidateCount: 0 as const,
    messageBodyRetained: false as const,
    submitActivated: false as const,
  });
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

function fixtureDocument(): string {
  return `<!doctype html>
  <html data-hunt-page-id="page-resume" data-hunt-submit-activated="false">
    <body data-hunt-application-page="resume">
      <script>
        window.submitActivations = 0;
        const render = (kind) => {
          document.body.setAttribute('data-hunt-application-page', kind);
          document.documentElement.setAttribute('data-hunt-page-id', 'page-' + kind.replace('_', '-'));
          if (kind === 'resume') {
            document.body.innerHTML = '<main data-automation-id="applyFlowMyInfoPage"><label>Resume<input required data-hunt-field-id="resume-required" type="file" data-automation-id="file-upload-input-ref"></label><button>Next</button></main>';
            document.querySelector('input').addEventListener('change', () => {
              const item = document.createElement('div');
              item.setAttribute('data-automation-id', 'file-upload-item');
              item.setAttribute('data-upload-state', 'success');
              item.innerHTML = '<button data-automation-id="delete-file" aria-label="Delete resume">Delete</button>';
              document.querySelector('main').append(item);
            });
          } else if (kind === 'profile') {
            document.body.innerHTML = '<main data-automation-id="applyFlowMyInfoPage"><button>Next</button></main>';
          } else if (kind === 'questionnaire') {
            document.body.innerHTML = '<main data-automation-id="applyFlowApplicationQuestionsPage"><label>Brief interest statement<textarea required aria-label="Brief interest statement"></textarea></label><button>Next</button></main>';
          } else {
            document.body.innerHTML = '<div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><section data-hunt-review-field-id="s1-field-resume">resume.pdf</section><section data-hunt-review-field-id="s1-field-interest">Exact configured interest statement.</section><button id="final-submit">Submit application</button></main>';
            document.querySelector('#final-submit').addEventListener('click', () => { window.submitActivations += 1; document.documentElement.setAttribute('data-hunt-submit-activated', 'true'); });
          }
          const next = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Next');
          next?.addEventListener('click', () => render(kind === 'resume' ? 'profile' : kind === 'profile' ? 'questionnaire' : 'pre_review'));
        };
        render('resume');
      </script>
    </body>
  </html>`;
}
