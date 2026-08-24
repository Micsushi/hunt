import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserContext } from "playwright";

import { assertCurrentProcessIsOnIsolatedDesktop } from
  "../src/browser/playwright-live/private/windows-isolated-desktop-attestation.ts";
import { PlaywrightPersistentContextLauncher } from
  "../src/browser/playwright-live/private/playwright-launcher.ts";
import {
  createStage2ExternalMonitorRuntime,
  currentProcessStartedAt,
} from "../src/live/evidence/external-monitor-runtime.ts";
import { readStage2ExternalMonitorObserverBinding } from
  "../src/live/evidence/external-monitor-authority.ts";

const SYNTHETIC_HOST = "readiness.wd5.myworkdayjobs.com";
const SYNTHETIC_TENANT = "readiness";
const SYNTHETIC_POSTING = "R-READY-01";
const SYNTHETIC_URL = `https://${SYNTHETIC_HOST}/en-US/Careers/job/Hunt-C3-Readiness_${SYNTHETIC_POSTING}/apply/applyManually`;

const args = parseArgs(process.argv.slice(2));
let sequence = 0;
let monitorFailed = false;
let context: Awaited<ReturnType<PlaywrightPersistentContextLauncher["launchPersistentContext"]>> | undefined;
let exitCode = 0;

const report = async (
  phase: "child_spawn" | "browser_launch" | "page_binding" | "monitor" | "evidence" | "cleanup",
  status: "started" | "pass" | "failed",
  failureClass?: "browser_launch" | "page_binding" | "evidence" | "monitor" | "cleanup",
  evidenceSha256?: string,
) => {
  const response = await fetch(`${args.monitorOrigin}/readiness`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hunt-readiness-token": args.token,
    },
    body: JSON.stringify({
      schemaVersion: 1,
      sequence: ++sequence,
      phase,
      status,
      pid: process.pid,
      submitActivated: false,
      ...(failureClass === undefined ? {} : { failureClass }),
      ...(evidenceSha256 === undefined ? {} : { evidenceSha256 }),
    }),
  });
  if (!response.ok || (await response.json() as { readonly observerReady?: unknown }).observerReady !== true) {
    throw new Error("readiness monitor unavailable");
  }
};

try {
  await report("child_spawn", "pass");
} catch {
  // No browser process exists yet; the isolated job still owns this child.
  process.exit(24);
}
const heartbeat = setInterval(() => {
  void fetch(`${args.monitorOrigin}/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hunt-readiness-token": args.token,
    },
    body: JSON.stringify({ schemaVersion: 1, pid: process.pid }),
  }).then((response) => { if (!response.ok) monitorFailed = true; }, () => { monitorFailed = true; });
}, 250);

try {
  try {
    await report("browser_launch", "started");
    await assertCurrentProcessIsOnIsolatedDesktop();
    context = await new PlaywrightPersistentContextLauncher({ timeoutMs: 30_000 })
      .launchPersistentContext(args.profileRoot, { headless: false });
    await report("browser_launch", "pass");
  } catch {
    exitCode = 21;
    await safeFailure("browser_launch", "browser_launch");
  }
  if (exitCode === 0) {
    try {
      await report("page_binding", "started");
      const browserContext = context as unknown as BrowserContext;
      const fixtureResponse = await fetch(args.pageUrl);
      if (!fixtureResponse.ok) throw new Error("synthetic fixture unavailable");
      const fixtureHtml = await fixtureResponse.text();
      await browserContext.route(`${SYNTHETIC_URL}**`, (route) => route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fixtureHtml,
      }));
      const page = browserContext.pages()[0] ?? await browserContext.newPage();
      const response = await page.goto(SYNTHETIC_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const submit = page.getByRole("button", { name: "Submit application", exact: true });
      if (response?.status() !== 200 || page.url() !== SYNTHETIC_URL ||
          await page.locator('html[data-fixture-page-id="fixture-review"]').count() !== 1 ||
          await submit.count() !== 1 || await submit.isEnabled()) {
        throw new Error("synthetic page binding invalid");
      }
      await report("page_binding", "pass");
      try {
        await report("monitor", "started");
        const monitorRuntimeRoot = args.runtimeRoot;
        const processNonce = process.env.HUNT_C3_PROCESS_LIVE_NONCE;
        const processIssuedAt = process.env.HUNT_C3_PROCESS_ISSUED_AT;
        if (processNonce === undefined || processIssuedAt === undefined) throw new Error("process binding unavailable");
        const productionMonitor = createStage2ExternalMonitorRuntime({
          runtimeRoot: monitorRuntimeRoot,
          evidenceRoot: args.evidenceRoot,
          journeyId: "journey_readiness_synthetic_01",
          targetHandleId: "target_ref_readiness_synthetic_01",
          sourceRevision: args.sourceRevision,
          configSha256: createHash("sha256").update(readFileSync(args.configPath)).digest("hex"),
          host: SYNTHETIC_HOST,
          tenant: SYNTHETIC_TENANT,
          posting: SYNTHETIC_POSTING,
          processLiveNonceSha256: createHash("sha256").update(Buffer.from(processNonce, "base64")).digest("hex"),
          processIssuedAt,
          processOwnerPid: process.pid,
          processOwnerStartedAt: currentProcessStartedAt(),
          acknowledgementTimeoutMs: 10_000,
          acknowledgementPollMs: 25,
          observer: readStage2ExternalMonitorObserverBinding(monitorRuntimeRoot, {
            journeyId: "journey_readiness_synthetic_01",
            targetHandleId: "target_ref_readiness_synthetic_01",
          }),
        });
        try {
          const reviewSurface = await page.evaluate(() => ({
            title: document.title,
            body: document.body.innerHTML,
          }));
          await page.evaluate(() => {
            document.body.innerHTML = "<main><h1>My Information</h1><button type=\"button\">Next</button></main>";
          });
          await page.getByRole("button", { name: "Next", exact: true }).waitFor({ state: "visible" });
          await page.waitForTimeout(250);
          await page.evaluate(() => { document.title = "My Information"; });
          await productionMonitor.auth(page, "application_ready", "state_observed", {
            fieldCount: 0,
            requiredFieldCount: 0,
            controlTypes: [],
            questionTypes: [],
            answerTypes: [],
            validationState: "clear",
            submitPresent: false,
            submitActivated: false,
          }, { operationId: "operation_readiness_auth_monitor_01", attempt: 1 }, new AbortController().signal);
          await page.evaluate((surface) => {
            document.body.innerHTML = surface.body;
          }, reviewSurface);
          await submit.waitFor({ state: "visible" });
          await page.waitForTimeout(250);
          await page.evaluate((title) => { document.title = title; }, reviewSurface.title);
          await productionMonitor.application(page, "review", "review_readback", {
            fieldCount: 0,
            requiredFieldCount: 0,
            controlTypes: [],
            questionTypes: [],
            answerTypes: [],
            validationState: "clear",
            submitPresent: true,
            submitActivated: false,
          }, { operationId: "operation_readiness_monitor_01", attempt: 1 }, new AbortController().signal);
        } finally {
          productionMonitor.close();
        }
        await report("monitor", "pass");
      } catch {
        exitCode = 24;
        await safeFailure("monitor", "monitor");
      }
      if (exitCode !== 0) throw new Error("production monitor failed");
      try {
        const screenshot = await page.screenshot({ type: "png", fullPage: true });
        if (screenshot.byteLength < 1) throw new Error("synthetic evidence empty");
        const evidenceSha256 = createHash("sha256").update(screenshot).digest("hex");
        await report("evidence", "pass", undefined, evidenceSha256);
      } catch {
        exitCode = 23;
        await safeFailure("evidence", "evidence");
      }
    } catch {
      if (exitCode === 0) {
        exitCode = 22;
        await safeFailure("page_binding", "page_binding");
      }
    }
  }
} finally {
  clearInterval(heartbeat);
  try {
    await report("cleanup", "started");
    await context?.close();
    context = undefined;
    if (monitorFailed) throw new Error("readiness heartbeat failed");
    await report("cleanup", "pass");
  } catch {
    exitCode = exitCode === 0 ? 25 : exitCode;
    await safeFailure("cleanup", "cleanup");
  }
}

process.exitCode = exitCode;

async function safeFailure(
  phase: "browser_launch" | "page_binding" | "monitor" | "evidence" | "cleanup",
  failureClass: "browser_launch" | "page_binding" | "monitor" | "evidence" | "cleanup",
): Promise<void> {
  try { await report(phase, "failed", failureClass); }
  catch { exitCode = 24; }
}

function parseArgs(values: readonly string[]) {
  if (values.length !== 16) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || parsed.has(key) ||
        !["--profile-root", "--page-url", "--monitor-origin", "--token", "--evidence-root", "--runtime-root", "--source-revision", "--config"].includes(key)) invalid();
    parsed.set(key, value);
  }
  const profileRoot = parsed.get("--profile-root");
  const pageUrl = parsed.get("--page-url");
  const monitorOrigin = parsed.get("--monitor-origin");
  const token = parsed.get("--token");
  const evidenceRoot = parsed.get("--evidence-root");
  const runtimeRoot = parsed.get("--runtime-root");
  const sourceRevision = parsed.get("--source-revision");
  const configPath = parsed.get("--config");
  if (profileRoot === undefined || pageUrl === undefined || monitorOrigin === undefined || token === undefined ||
      evidenceRoot === undefined || runtimeRoot === undefined || sourceRevision === undefined || configPath === undefined ||
      !/^[0-9a-f]{40}$/u.test(sourceRevision) ||
      !URL.canParse(pageUrl) || !URL.canParse(monitorOrigin) ||
      new URL(pageUrl).hostname !== "127.0.0.1" || new URL(monitorOrigin).hostname !== "127.0.0.1" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(token)) invalid();
  return Object.freeze({
    profileRoot, pageUrl, monitorOrigin, token, evidenceRoot, runtimeRoot, sourceRevision, configPath,
  });
}

function invalid(): never {
  throw new TypeError("synthetic readiness child denied");
}
