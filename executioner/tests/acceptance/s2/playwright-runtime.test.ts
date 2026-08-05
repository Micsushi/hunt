import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Page } from "playwright";
import { ownedApplicationPageAccess } from "../../../src/browser/playwright-live/private/application-page-types.ts";

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
  const page = await context.newPage();
  const owned = new FixtureOwnedBrowser(page, url);
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
  const runtimeBinding = createStage2PlaywrightLiveRuntimeBinding({
    browser: () => owned,
    now: () => "2026-08-05T12:00:00.000Z",
    nextOperationId,
    timeoutMs: 5_000,
  });

  try {
    const runtime = await runtimeBinding.bind({
      owner: owner(root, url),
      ownerBinding: {
        forPersistentBrowser: () => ({
          targetUrl: url,
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

    const captured = await runtime.review.capture(new AbortController().signal);
    const structure = await inspectWorkdayReview(captured.page);
    const proof = stopAtVerifiedReview({ ...captured.request, structure });
    assert.equal(proof.kind, "review_confirmed");
    assert.equal(await page.evaluate(() => (window as never as { submitActivations: number }).submitActivations), 0);
    assert.equal(owned.pageIdentities.size, 1);
    const forbidden = await runtime.privacy.forbiddenTokens(new AbortController().signal);
    assert.equal(forbidden.includes(url), true);
    assert.equal(forbidden.length <= 32, true);
    assert.equal(forbidden.every((value) => value.length >= 3 && value.length <= 512), true);
    assert.equal(await runtime.cleanup.close(new AbortController().signal, true), true);
    assert.equal(owned.closed, true);
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
  const page = await context.newPage();
  const url = `data:text/html,${encodeURIComponent(
    '<html data-hunt-page-id="page-auth"><body><main data-automation-id="signInPage"><label>Email<input></label><button>Sign In</button></main></body></html>',
  )}`;
  const owned = new FixtureOwnedBrowser(page, url);
  const artifact = resumeArtifact();
  const intent = createWorkdayResumeFileIntent({
    artifactId: artifact.resumeId,
    artifact,
    fileType: "pdf",
  });
  if (!intent.ok) throw new Error("resume fixture invalid");
  let operation = 100;
  try {
    const runtime = await createStage2PlaywrightLiveRuntimeBinding({
      browser: () => owned,
      now: () => "2026-08-05T12:00:00.000Z",
      nextOperationId: () => generatedOperationId(
        `operation_${(++operation).toString().padStart(16, "0")}`,
      ),
      timeoutMs: 2_000,
    }).bind({
      owner: owner(root, url),
      ownerBinding: {} as never,
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
    }, new AbortController().signal);
    const walked = await runApplicationPageWalk(runtime.walk, {
      journeyId: journeyId("journey_runtime_fixture_01"),
      stopAfter: "pre_review",
    }, new AbortController().signal);
    assert.equal(walked.ok, false);
    assert.deepEqual(owned.effects, ["read"]);
    assert.equal(await page.locator("input").inputValue(), "");
    assert.equal(await runtime.cleanup.close(new AbortController().signal), true);
  } finally {
    disposeResumeArtifact(artifact);
    await context.close();
    await chromiumBrowser.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
    }, new AbortController().signal));
    assert.equal(browserCalls, 0);
  } finally {
    if (existsSync(linked)) unlinkSync(linked);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

class FixtureOwnedBrowser {
  readonly pageIdentities = new Set<Page>();
  readonly effects: string[] = [];
  closed = false;
  readonly #page: Page;
  readonly #url: string;
  readonly #session: LiveBrowserSessionV1;

  constructor(page: Page, url: string) {
    this.#page = page;
    this.#url = url;
    this.#session = {
      schemaVersion: 1,
      journeyId: journeyId("journey_runtime_fixture_01"),
      sessionId: "live_session_runtime_fixture_01" as LiveSessionId,
      profileLeaseId: "profile_lease_runtime_fixture_01" as ProfileLeaseId,
      target: {
        schemaVersion: 1,
        atsFamily: "workday",
        hostId: "host_0123456789abcdef" as never,
        tenantId: "tenant_0123456789abcdef" as never,
        postingId: "posting_0123456789abcdef" as never,
      },
      leaseExpiresAt: "2026-08-06T12:00:00.000Z",
    };
  }

  async open() {
    await this.#page.goto(this.#url);
    return { ok: true as const, value: { kind: "opened" as const, session: this.#session } };
  }

  async reconcile() {
    return { ok: true as const, value: { kind: "matched" as const, session: this.#session } };
  }

  async close() {
    this.closed = true;
    return { ok: true as const, value: undefined };
  }

  async [ownedApplicationPageAccess]<Value>(
    request: unknown,
    _signal: AbortSignal,
    use: (page: Page) => Promise<Value>,
  ) {
    this.pageIdentities.add(this.#page);
    this.effects.push((request as { readonly effect?: string }).effect ?? "unknown");
    try {
      return { ok: true as const, value: await use(this.#page) };
    } catch {
      return {
        ok: false as const,
        error: { code: "browser_effect_uncertain" as const, retryable: false as const },
      };
    }
  }
}

function owner(root: string, url: string) {
  return {
    journeyId: "journey_runtime_fixture_01",
    revisionId: "revision_0123456789abcdef",
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
            document.body.innerHTML = '<div data-automation-id="progressBarActiveStep">Review</div><main data-automation-id="applyFlowReviewPage"><button id="final-submit">Submit application</button></main>';
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
