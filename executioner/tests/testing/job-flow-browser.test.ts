import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { loadJobFlowMatrix } from "../../src/testing/job-flow-campaign.ts";
import { PlaywrightWorkdayApplicationPage } from "../../src/ats/workday/application/playwright-page.ts";
import { runApplicationPageWalk, type ApplicationPageHandlerPort, type ApplicationHandlerPage, type ApplicationWalkDependencies, type ApplicationWalkProgress } from "../../src/ats/workday/application/page-walk.ts";
import { journeyId } from "../../src/contracts/index.ts";
import { jobFlowFixture } from "./job-flow-fixture.ts";

const matrix = loadJobFlowMatrix(resolve("fixtures/job-flow-campaign/v1.json"), process.cwd());
const signal = () => new AbortController().signal;

for (const job of matrix.baselineJobs) {
  test(`${job.id}: real browser walks production navigation, checkpoints and Review with mocked sensitive handlers`, { timeout: 120_000 }, async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ serviceWorkers: "block" });
    const requests: string[] = [];
    const output = process.env.HUNT_JOB_FLOW_EVIDENCE_DIR;
    const evidenceRoot = output ? join(resolve(output), job.id) : undefined;
    if (evidenceRoot) {
      await mkdir(evidenceRoot, { recursive: true });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    await context.route("**/*", async (route) => {
      const request = route.request();
      requests.push(`${request.method()} ${new URL(request.url()).hostname}`);
      if (request.url() !== "https://fixture.invalid/" || request.method() !== "GET") return route.abort();
      return route.fulfill({ contentType: "text/html", body: jobFlowFixture(job) });
    });
    let page = await context.newPage();
    const progress: ApplicationWalkProgress[] = [];
    try {
      await page.goto("https://fixture.invalid/");
      await page.getByRole("button", { name: "Apply to synthetic fixture" }).click();
      await page.getByLabel("Synthetic email").fill("campaign@example.invalid");
      await page.getByRole("button", { name: "Mock sign in" }).click();
      if (job.permittedJourney.includes("verification_required")) {
        await page.getByRole("button", { name: "Verify fixture identity" }).click();
      } else {
        assert.equal(await page.getByRole("button", { name: "Verify fixture identity" }).count(), 0);
      }
      const input = { journeyId: journeyId("journey_campaign_fixture") };
      // A verified prefix survives a page/session loss, without repeating Next.
      if (job.id === matrix.baselineJobs[0]!.id) {
        const stopped = await runApplicationPageWalk(dependencies(page, progress), { ...input, stopAfter: "profile_verified" }, signal());
        assert.equal(stopped.ok, true, JSON.stringify(stopped));
        const checkpoint = JSON.parse(JSON.stringify(progress.at(-1))) as ApplicationWalkProgress;
        if (evidenceRoot) await writeFile(join(evidenceRoot, "checkpoint.json"), JSON.stringify(checkpoint));
        await page.close();
        page = await context.newPage();
        await page.goto("https://fixture.invalid/");
        const resumed = await runApplicationPageWalk(dependencies(page, progress), input, signal(), {
          resume: { currentPage: checkpoint.browserPage, currentLanes: checkpoint.browserLanes, pageChecks: checkpoint.pageChecks },
        });
        assert.equal(resumed.ok, true, JSON.stringify(resumed));
      } else {
        const result = await runApplicationPageWalk(dependencies(page, progress), input, signal());
        assert.equal(result.ok, true, JSON.stringify(result));
      }
      assert.equal(progress.at(-1)?.checkpoint, "pre_review");
      assert.equal(await page.getByRole("button", { name: "Submit", exact: true }).isDisabled(), true);
      const effects = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture")!).effects as number);
      assert.equal(effects, job.permittedJourney.filter((state) => ["profile", "resume", "questionnaire"].includes(state)).length);
      assert.equal(requests.every((request) => request === "GET fixture.invalid"), true);
      if (evidenceRoot) {
        await page.screenshot({ path: join(evidenceRoot, "review.png") });
        await writeFile(join(evidenceRoot, "result.json"), JSON.stringify({ job: job.id, transport: "synthetic_browser", terminal: "review", externalRequests: 0, effects, progress }, null, 2));
      }
    } catch (error) {
      if (evidenceRoot && !page.isClosed()) await page.screenshot({ path: join(evidenceRoot, "failure.png") }).catch(() => {});
      throw error;
    } finally {
      if (evidenceRoot) await context.tracing.stop({ path: join(evidenceRoot, "trace.zip") });
    }
  });
}

function dependencies(page: Page, progress: ApplicationWalkProgress[]): ApplicationWalkDependencies {
  const adapter = new PlaywrightWorkdayApplicationPage(page, { timeoutMs: 1000, navigationSettleTimeoutMs: 5000 });
  const handler = <T extends ApplicationHandlerPage>(kind: T, checkpoint: T extends "resume" ? "resume_verified" : T extends "profile" ? "profile_verified" : "questionnaire_verified"): ApplicationPageHandlerPort<T> => ({
    async reconcile(request) {
      if (kind === "profile") {
        await page.getByLabel("First name Required").fill("Synthetic");
        await page.getByLabel("Region Required").selectOption({ index: 1 });
      } else if (kind === "resume") {
        await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic fixture resume; not an applicant.") });
      } else {
        await page.getByLabel("Fixture answer Required").fill("Synthetic fixture answer");
        await page.getByLabel("Show follow-up").check();
        await page.getByLabel("Follow-up Required").fill("Synthetic follow-up");
      }
      const observed = await adapter.observe(signal());
      assert.equal(observed.ok, true, JSON.stringify(observed));
      if (!observed.ok) throw Error("fixture observation failed");
      assert.ok(observed.value.requiredFields.every((field) => field.verification === "verified"), JSON.stringify(observed));
      return { ok: true, value: { page: kind, pageId: request.pageId, checkpoint, independentlyVerified: true } };
    },
  });
  return {
    observer: adapter,
    navigation: adapter,
    handlers: { profile: handler("profile", "profile_verified"), resume: handler("resume", "resume_verified"), questionnaire: handler("questionnaire", "questionnaire_verified") },
    progress: { async record(value) { progress.push(value); return { ok: true, value: undefined }; } },
  };
}
