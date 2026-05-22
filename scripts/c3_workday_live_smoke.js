#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  makeWorkdayProfileDefaults,
  withWorkdayProfileAliases,
} = require("./c3_p_chrome_defaults");
const { CdpClient, httpJson, httpText, js, sleep } = require("./lib/c3_cdp");
const { recordAuditIssues } = require("./lib/c3_issue_registry");
const { verifyEmail } = require("./c3_mail_verify_bridge");
const {
  WorkdayWorkflowIdentifier,
} = require("./lib/c3_workday_identifier");
const {
  WorkdayApplyEntryWorkflow,
} = require("./lib/c3_workday_apply_entry");
const {
  WorkdayAuthWorkflow,
} = require("./lib/c3_workday_auth_workflow");
const {
  buildFillAudit,
  summarizeFill,
  writeAuditJson,
} = require("./lib/c3_workday_audit");

function loadDotEnv(filePath = ".env") {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const DEFAULT_JOB_URL =
  "https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn";
const DEFAULT_EXTENSION_ID = "cbdmkibihimaedoihjhpidclolglnncc";
const AUTH_VERIFICATION_RE =
  /an email has been sent to you\.?\s*please verify your account|verify your account before you sign in|request a verification email/i;
const IDENTIFIER_TIMEOUT_MS = 60_000;
const AUTH_WORKFLOW_TIMEOUT_MS = 120_000;
const APPLY_ENTRY_TIMEOUT_MS = 60_000;
const PAGE_FILL_AND_NEXT_TIMEOUT_MS = 60_000;
const FULL_APPLICATION_TIMEOUT_MS = 300_000;

class PhaseTimeoutError extends Error {
  constructor(phase, timeoutMs) {
    super(`${phase} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = "PhaseTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
    this.reason = `${phase}_timeout`;
  }
}

async function withPhaseTimeout(phase, timeoutMs, work) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new PhaseTimeoutError(phase, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function auditTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function pageReachedReview(page) {
  return Boolean(
    page?.pageKind === "review" ||
      page?.hasSubmit ||
      /review/i.test(page?.currentStep?.title || ""),
  );
}

function pageHasBlockingValidation(page) {
  return Boolean((page?.errors || []).length || page?.workdayRuntimeError);
}

async function reconcilePageFillTimeoutToReview(pageClient) {
  await sleep(1200);
  const page = await inspectPage(pageClient);
  return {
    page,
    reachedReview: pageReachedReview(page) && !pageHasBlockingValidation(page),
  };
}

function fillDidUsefulWork(fill) {
  if (!fill) return false;
  if (Number(fill.filledFieldCount || 0) > 0) return true;
  if ((fill.filledFields || []).length > 0) return true;
  return (fill.fieldInventory || []).some(
    (field) => field.filled || field.valuePut || field.selectedOption,
  );
}

function fillHasNoProgressReason(fill) {
  return (fill?.manualReviewReasons || []).some((reason) =>
    /fill_no_progress_timeout|fill_timeout|fill_retry_timeout|page_fill_and_next_timeout/i.test(
      String(reason || ""),
    ),
  );
}

function pageSettleSignature(page) {
  return [
    page?.href || "",
    page?.currentStep?.current || "",
    page?.currentStep?.title || "",
    page?.hasNext ? "next" : "",
    page?.hasSubmit ? "submit" : "",
    (page?.errors || []).join("|"),
    page?.loadingNodeCount || 0,
  ].join("::");
}

function pageAdvancedFrom(before, after) {
  return Boolean(
    after?.hasSubmit ||
      (after?.currentStep?.current ?? 0) > (before?.currentStep?.current ?? 0) ||
      (after?.href && before?.href && after.href !== before.href),
  );
}

async function setRunnerFillProgress(optionsClient, applyUrl, message) {
  if (!optionsClient || !applyUrl) {
    return { ok: false, reason: "missing_progress_context" };
  }
  return optionsClient.evaluate(
    `(() => {
      const applyUrl = ${JSON.stringify(applyUrl)};
      const message = ${JSON.stringify(message || "")};
      const normalizeWorkdayPathname = (pathname) =>
        String(pathname || "").replace(/\\/apply(?:\\/[^/]+)?\\/?$/, "");
      return (async () => {
        const apply = new URL(applyUrl);
        const applyHost = apply.host;
        const applyPathBase = normalizeWorkdayPathname(apply.pathname);
        const tabs = await chrome.tabs.query({});
        const candidates = tabs.filter((item) => {
          try {
            const url = new URL(item.url || "");
            return url.host === applyHost
              && normalizeWorkdayPathname(url.pathname).startsWith(applyPathBase);
          } catch (_error) {
            return false;
          }
        });
        const tab = candidates.find((item) => item.active)
          || candidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
        if (!tab?.id) {
          return { ok: false, reason: "workday_tab_not_found" };
        }
        const uiMessage = {
          type: "hunt.apply.show_fill_progress",
          message,
          fillRunId: "c3_workday_live_smoke"
        };
        try {
          await chrome.tabs.sendMessage(tab.id, uiMessage);
        } catch (error) {
          if (!/receiving end does not exist|could not establish connection/i.test(String(error?.message || error))) {
            return { ok: false, reason: "progress_message_failed", message: String(error?.message || error) };
          }
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["src/content/bootstrap.js"]
          });
          await chrome.tabs.sendMessage(tab.id, uiMessage);
        }
        return { ok: true, tabId: tab.id };
      })();
    })()`,
    10000,
  );
}

async function hideRunnerFillProgress(optionsClient, applyUrl) {
  if (!optionsClient || !applyUrl) {
    return { ok: false, reason: "missing_progress_context" };
  }
  return optionsClient.evaluate(
    `(() => {
      const applyUrl = ${JSON.stringify(applyUrl)};
      const normalizeWorkdayPathname = (pathname) =>
        String(pathname || "").replace(/\\/apply(?:\\/[^/]+)?\\/?$/, "");
      return (async () => {
        const apply = new URL(applyUrl);
        const applyHost = apply.host;
        const applyPathBase = normalizeWorkdayPathname(apply.pathname);
        const tabs = await chrome.tabs.query({});
        const candidates = tabs.filter((item) => {
          try {
            const url = new URL(item.url || "");
            return url.host === applyHost
              && normalizeWorkdayPathname(url.pathname).startsWith(applyPathBase);
          } catch (_error) {
            return false;
          }
        });
        const tab = candidates.find((item) => item.active)
          || candidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
        if (!tab?.id) {
          return { ok: false, reason: "workday_tab_not_found" };
        }
        await chrome.tabs.sendMessage(tab.id, {
          type: "hunt.apply.hide_fill_progress"
        });
        return { ok: true, tabId: tab.id };
      })();
    })()`,
    10000,
  );
}

async function waitForPostFillSettle(
  pageClient,
  before,
  { args, fillSummary, optionsClient, applyUrl },
) {
  const initialSettleMs = 1000;
  const maxSettleMs = 3000;
  await setRunnerFillProgress(
    optionsClient,
    applyUrl,
    "Waiting for Workday to finish loading",
  ).catch(() => null);
  try {
    const started = Date.now();
    await sleep(initialSettleMs);
    let latest = await inspectPage(pageClient);
    const initialLoading =
      latest.readyState !== "complete" || latest.loadingNodeCount > 0;
    const initialAdvanced = pageAdvancedFrom(before, latest);
    const waitForAdvance =
      args.extensionAutoNext && fillSummary?.nextAction?.clicked;
    if (!initialLoading && (initialAdvanced || !waitForAdvance)) {
      return latest;
    }
    let lastSignature = pageSettleSignature(latest);
    let stableSince = Date.now();
    while (Date.now() - started < maxSettleMs) {
      latest = await inspectPage(pageClient);
      const signature = pageSettleSignature(latest);
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      }
      const stableMs = Date.now() - stableSince;
      const loading =
        latest.readyState !== "complete" || latest.loadingNodeCount > 0;
      const advanced = pageAdvancedFrom(before, latest);
      const waitForAdvance =
        args.extensionAutoNext && fillSummary?.nextAction?.clicked;
      if (!loading && stableMs >= 350 && (advanced || !waitForAdvance)) {
        return latest;
      }
      await sleep(250);
    }
    return latest;
  } finally {
    await hideRunnerFillProgress(optionsClient, applyUrl).catch(() => null);
  }
}

function parseArgs(argv) {
  const args = {
    mode: "manual",
    cdpPort: 9222,
    jobUrl: DEFAULT_JOB_URL,
    resumePath: path.resolve(process.cwd(), "main.pdf"),
    extensionId: DEFAULT_EXTENSION_ID,
    maxPages: 8,
    fillsPerPage: 1,
    stopAfterFill: false,
    preserveCurrent: false,
    targetStep: "",
    startStep: "",
    requireTarget: false,
    stopAtTarget: false,
    clearRepeatableSections: false,
    verifyClear: false,
    clearBeforeFill: false,
    extensionAutoNext: false,
    noSeedExtension: false,
    fillMessageTimeoutMs: 0,
    llmAnswers: false,
    accountEmail: process.env.HUNT_C3_TEST_ACCOUNT_EMAIL || "",
    accountPassword: process.env.HUNT_C3_TEST_ACCOUNT_PASSWORD || "",
    auditJson: process.env.HUNT_C3_AUDIT_JSON || "",
    noAuditJson: false,
    closeOtherWorkdayTabs: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--mode" && next) {
      args.mode = next;
      i += 1;
    } else if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--job-url" && next) {
      args.jobUrl = next;
      i += 1;
    } else if (arg === "--resume" && next) {
      args.resumePath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--extension-id" && next) {
      args.extensionId = next;
      i += 1;
    } else if (arg === "--max-pages" && next) {
      args.maxPages = Number(next);
      i += 1;
    } else if (arg === "--fills-per-page" && next) {
      args.fillsPerPage = Math.max(1, Number(next) || 1);
      i += 1;
    } else if (arg === "--stop-after-fill") {
      args.stopAfterFill = true;
    } else if (arg === "--preserve-current") {
      throw new Error(
        "--preserve-current is disabled because it can target stale Workday tabs. Use --job-url with --close-other-workday-tabs.",
      );
    } else if (arg === "--target-step" && next) {
      args.targetStep = next;
      i += 1;
    } else if (arg === "--start-step" && next) {
      args.startStep = next;
      i += 1;
    } else if (arg === "--require-target") {
      args.requireTarget = true;
    } else if (arg === "--stop-at-target") {
      args.stopAtTarget = true;
    } else if (arg === "--clear-repeatable-sections") {
      args.clearRepeatableSections = true;
    } else if (arg === "--verify-clear") {
      args.verifyClear = true;
    } else if (arg === "--clear-before-fill") {
      args.clearBeforeFill = true;
    } else if (arg === "--extension-auto-next") {
      args.extensionAutoNext = true;
    } else if (arg === "--no-seed-extension") {
      args.noSeedExtension = true;
    } else if (arg === "--fill-message-timeout-ms" && next) {
      args.fillMessageTimeoutMs = Number(next);
      i += 1;
    } else if (arg === "--llm-answers") {
      args.llmAnswers = true;
    } else if (arg === "--no-llm-answers") {
      args.llmAnswers = false;
    } else if (arg === "--account-email" && next) {
      args.accountEmail = next;
      i += 1;
    } else if (arg === "--account-password" && next) {
      args.accountPassword = next;
      i += 1;
    } else if (arg === "--audit-json" && next) {
      args.auditJson = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--no-audit-json") {
      args.noAuditJson = true;
    } else if (arg === "--close-other-workday-tabs") {
      args.closeOtherWorkdayTabs = true;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["resume", "manual"].includes(args.mode)) {
    throw new Error("--mode must be resume or manual");
  }
  if (!args.noAuditJson && !args.auditJson) {
    args.auditJson = path.resolve(
      process.cwd(),
      "logs",
      `c3_workday_audit_${auditTimestamp()}.json`,
    );
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/c3_workday_live_smoke.js --mode resume|manual [options]",
    "",
    "Options:",
    "  --job-url <url>    Workday job URL",
    "  --resume <path>    PDF to seed into the C3 extension",
    "  --extension-id <id> Unpacked C3 extension ID",
    "  --cdp-port <port>  Chrome DevTools port, default 9222",
    "  --max-pages <n>    Safety cap for Next clicks, default 8",
    "  --fills-per-page <n> Fill the same page n times before Next",
    "  --stop-after-fill  Do not click Next after the fill step",
    "  --close-other-workday-tabs Close other Workday apply tabs before filling this site",
    "  --target-step <name> Stop logic can target a Workday step title",
    "  --start-step <name> Click a Workday step before filling, if visible",
    "  --require-target Fail before fill unless current step matches target",
    "  --stop-at-target   Stop before filling when current step matches target",
    "  --clear-repeatable-sections Delete Workday repeatable rows before fill",
    "  --clear-before-fill Clear the current Workday page before each fill",
    "  --verify-clear     Fill, clear, verify empty, then refill before Next",
    "  --extension-auto-next Enable C3's own safe Next-after-fill setting",
    "  --no-seed-extension Skip Chrome storage seeding for repeat p chrome runs",
    "  --fill-message-timeout-ms <ms> Override extension fill message timeout",
    "  --llm-answers Allow backend answer-router decisions during fill",
    "  --no-llm-answers Do not auto-apply backend answer-router decisions during fill (default)",
    "  --account-email <email> Optional account/profile email override",
    "  --audit-json <path> Write full page/retry/value audit JSON, default logs/c3_workday_audit_<timestamp>.json",
    "  --no-audit-json Disable audit JSON file writing",
  ].join("\n");
}

function logWorkflowPhase(phase, status, summary, details = {}) {
  const detailText = Object.keys(details).length
    ? ` ${JSON.stringify(details)}`
    : "";
  console.error(`[c3][${phase}][${status}] ${summary}${detailText}`);
}

function deriveApplyUrl(jobUrl, mode) {
  const url = new URL(jobUrl);
  const source = url.searchParams.get("source") || "LinkedIn";
  url.search = "";
  const basePath = url.pathname.replace(/\/apply(?:\/[^/]+)?\/?$/, "");
  const applySegment =
    mode === "resume" ? "autofillWithResume" : "applyManually";
  url.pathname = `${basePath.replace(/\/$/, "")}/apply/${applySegment}`;
  url.searchParams.set("source", source);
  return url.toString();
}

function workdaySlugToText(slug) {
  return String(slug || "")
    .replace(/_[A-Z]{1,4}\d[\w-]*$/i, "")
    .replace(/---/g, " - ")
    .replace(/--/g, ", ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferWorkdayContext(applyUrl) {
  const url = new URL(applyUrl);
  const parts = url.pathname
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch (_error) {
        return part;
      }
    })
    .filter(Boolean);
  const jobIndex = parts.indexOf("job");
  const detailsIndex = parts.indexOf("details");
  const titleSlug =
    (jobIndex >= 0 && parts[jobIndex + 2]) ||
    (detailsIndex >= 0 && parts[detailsIndex + 1]) ||
    "";
  const locationSlug = jobIndex >= 0 ? parts[jobIndex + 1] || "" : "";
  const tenant = url.hostname.split(".")[0] || "";
  const company =
    tenant.toLowerCase() === "bdo"
      ? "BDO"
      : tenant.toLowerCase() === "sunlife"
        ? "Sun Life"
        : workdaySlugToText(tenant) || "Workday employer";
  return {
    title: workdaySlugToText(titleSlug) || "Workday application",
    company,
    location: workdaySlugToText(locationSlug),
  };
}

function makeSeedPayload(resumePath, applyUrl, args = {}) {
  const pdf = fs.readFileSync(resumePath);
  const pdfFileName = path.basename(resumePath);
  const pdfDataUrl = `data:application/pdf;base64,${pdf.toString("base64")}`;
  const profile = withWorkdayProfileAliases(
    makeWorkdayProfileDefaults({
      accountEmail: args.accountEmail,
      accountPassword: args.accountPassword,
    }),
  );
  const inferredContext = inferWorkdayContext(applyUrl);
  const defaultResume = {
    label: pdfFileName,
    sourceType: "local_pdf",
    pdfFileName,
    pdfMimeType: "application/pdf",
    pdfDataUrl,
    pdfPath: resumePath,
    versionId: "workday-live-smoke",
    texPath: "",
    jobId: "",
  };
  const activeApplyContext = {
    jobId: "",
    title: inferredContext.title,
    company: inferredContext.company,
    location: inferredContext.location,
    source: "LinkedIn",
    sourceMode: "manual",
    atsType: "workday",
    applyUrl,
    jobUrl: applyUrl,
    selectedResumeName: pdfFileName,
    selectedResumePath: resumePath,
    selectedResumeDataUrl: pdfDataUrl,
    selectedResumeReadyForC3: true,
  };
  return { profile, defaultResume, activeApplyContext };
}

async function getTargets(port) {
  return httpJson(port, "/json/list");
}

function findExtensionId(targets) {
  const c3Target = targets.find((target) =>
    String(target.url || "").includes("/src/background/index.js"),
  );
  if (c3Target) {
    const match = String(c3Target.url || "").match(
      /^chrome-extension:\/\/([^/]+)/,
    );
    if (match) {
      return match[1];
    }
  }
  for (const target of targets) {
    const match = String(target.url || "").match(
      /^chrome-extension:\/\/([^/]+)/,
    );
    if (match) {
      return match[1];
    }
  }
  return "";
}

async function ensureOptionsTarget(port, fallbackExtensionId) {
  let targets = await getTargets(port);
  const extensionId = findExtensionId(targets) || fallbackExtensionId;
  const blockedExtensionTabs = targets.filter((item) => {
    const url = String(item.url || "");
    const title = String(item.title || "");
    return (
      item.type === "page" &&
      (url === `chrome-extension://${extensionId}` ||
        url === `chrome-extension://${extensionId}/` ||
        (url.startsWith("chrome-error://") &&
          (title.includes(`${extensionId} is blocked`) ||
            title.includes("ERR_BLOCKED_BY_CLIENT"))))
    );
  });
  for (const item of blockedExtensionTabs) {
    await httpText(port, `/json/close/${item.id}`).catch(() => "");
  }
  if (blockedExtensionTabs.length) {
    targets = await getTargets(port);
  }
  let target = targets.find((item) =>
    String(item.url || "").includes("/src/options/options.html"),
  );
  if (target) {
    return target;
  }
  if (!extensionId) {
    throw new Error("Could not find loaded C3 extension in CDP targets");
  }
  await httpText(
    port,
    `/json/new?${encodeURIComponent(
      `chrome-extension://${extensionId}/src/options/options.html`,
    )}`,
    "PUT",
  );
  await sleep(500);
  targets = await getTargets(port);
  target = targets.find((item) =>
    String(item.url || "").includes("/src/options/options.html"),
  );
  if (!target) {
    throw new Error("Could not open C3 options page");
  }
  return target;
}

async function ensurePageTarget(port, applyUrl) {
  const applyHost = new URL(applyUrl).host;
  const applyBase = applyUrl.split("?")[0];
  const applyPath = normalizeWorkdayPathname(new URL(applyBase).pathname);
  const isUsableApplyTarget = (item) => {
    const url = String(item.url || "");
    const title = String(item.title || "");
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch (_e) {
      parsed = null;
    }
    return (
      parsed &&
      parsed.host === applyHost &&
      (url.startsWith(applyBase) ||
        normalizeWorkdayPathname(parsed.pathname) === applyPath ||
        normalizeWorkdayPathname(parsed.pathname).includes(`${applyPath}/`)) &&
      !/error|ok/i.test(title)
    );
  };
  let targets = await getTargets(port);
  let target =
    [...targets].reverse().find(isUsableApplyTarget) ||
    [...targets]
      .reverse()
      .find(
        (item) =>
          String(item.url || "").includes(applyHost) &&
          /\/apply(?:\/|\?|$)/.test(String(item.url || "")) &&
          !/error|ok/i.test(String(item.title || "")),
      );
  if (!target) {
    await httpText(port, `/json/new?${encodeURIComponent(applyUrl)}`, "PUT");
    await sleep(1000);
    targets = await getTargets(port);
    target =
      [...targets].reverse().find(isUsableApplyTarget) ||
      [...targets]
        .reverse()
        .find((item) => String(item.url || "").includes(applyHost));
  }
  if (!target) {
    throw new Error("Could not open Workday page target");
  }
  return target;
}

function normalizeWorkdayPathname(pathname) {
  return String(pathname || "")
    .replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, "")
    .replace(/\/$/, "");
}

function isWorkdayApplyTarget(target) {
  try {
    const url = new URL(String(target?.url || ""));
    return (
      /\.wd\d+\.myworkdayjobs\.com$/i.test(url.hostname) &&
      /\/apply(?:\/|$)/i.test(normalizeWorkdayPathname(url.pathname))
    );
  } catch (_error) {
    return false;
  }
}

async function closeOtherWorkdayTabs(port, keepTarget) {
  const targets = await getTargets(port);
  const keepId = String(keepTarget?.id || "");
  const closed = [];
  for (const target of targets) {
    if (String(target.id || "") === keepId || !isWorkdayApplyTarget(target)) {
      continue;
    }
    await httpText(port, `/json/close/${encodeURIComponent(target.id)}`);
    closed.push({
      id: target.id,
      title: target.title || "",
      url: target.url || "",
    });
  }
  return closed;
}

async function connectTarget(target) {
  return new CdpClient(target.webSocketDebuggerUrl).connect();
}

async function waitForWorkdayPageReady(pageClient, timeoutMs = 45000) {
  const identifier = new WorkdayWorkflowIdentifier({
    pageClient,
    sleep,
    authVerificationPattern: AUTH_VERIFICATION_RE,
  });
  return identifier.waitForReady(timeoutMs);
}

async function seedExtension(optionsClient, seedPayload, args = {}) {
  return optionsClient.evaluate(
    `(async () => {
      const payload = ${js(seedPayload)};
      const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
      const storedRuntime = await chrome.storage.local.get("hunt.apply.runtimeConfig");
      const currentRuntime = storedRuntime["hunt.apply.runtimeConfig"] || {};
      const nextRuntime = {
        ...currentRuntime,
        autoClickNextAfterFill: ${Boolean(args.extensionAutoNext)},
        autoAccountSignupLoginEnabled: true,
        autoEmailVerificationEnabled: true,
        configuredBy: "scripts/c3_workday_live_smoke.js",
        configuredAt: new Date().toISOString()
      };
      if (!sameJson(currentRuntime, nextRuntime)) {
        await chrome.storage.local.set({ "hunt.apply.runtimeConfig": nextRuntime });
      }
      const storedLocal = await chrome.storage.local.get([
        "hunt.apply.profile",
        "hunt.apply.defaultResume",
        "hunt.apply.activeApplyContext"
      ]);
      const localPatch = {};
      if (!sameJson(storedLocal["hunt.apply.profile"], payload.profile)) {
        localPatch["hunt.apply.profile"] = payload.profile;
      }
      if (!sameJson(storedLocal["hunt.apply.defaultResume"], payload.defaultResume)) {
        localPatch["hunt.apply.defaultResume"] = payload.defaultResume;
      }
      if (!sameJson(storedLocal["hunt.apply.activeApplyContext"], payload.activeApplyContext)) {
        localPatch["hunt.apply.activeApplyContext"] = payload.activeApplyContext;
      }
      if (Object.keys(localPatch).length) {
        await chrome.storage.local.set(localPatch);
      }
      return await chrome.storage.local.get([
        "hunt.apply.profile",
        "hunt.apply.defaultResume",
        "hunt.apply.activeApplyContext"
      ]);
    })()`,
  );
}

async function setExtensionAutoNext(optionsClient, enabled) {
  return optionsClient.evaluate(
    `(async () => {
      const storedRuntime = await chrome.storage.local.get("hunt.apply.runtimeConfig");
      const current = storedRuntime["hunt.apply.runtimeConfig"] || {};
      if (Boolean(current.autoClickNextAfterFill) !== ${Boolean(enabled)}) {
        await chrome.storage.local.set({
          "hunt.apply.runtimeConfig": {
            ...current,
            autoClickNextAfterFill: ${Boolean(enabled)},
            configuredBy: "scripts/c3_workday_live_smoke.js",
            configuredAt: new Date().toISOString()
          }
        });
      }
      return { ok: true, autoClickNextAfterFill: ${Boolean(enabled)} };
    })()`,
  );
}

async function navigate(
  pageClient,
  applyUrl,
  waitForReady = () => waitForWorkdayPageReady(pageClient),
) {
  await pageClient.send("Page.enable");
  await pageClient.send("Page.navigate", { url: applyUrl });
  const readyState = await waitForReady();
  logWorkflowPhase(
    "site",
    readyState.timedOut ? "blocked" : "ok",
    "Workday page reached a classified state after navigation.",
    {
      pageKind: readyState.pageKind,
      stillLoading: Boolean(readyState.stillLoading),
      waitedMs: readyState.waitedMs || 0,
      href: readyState.href || "",
    },
  );
}

function authVerificationErrors(errors = []) {
  return (errors || []).filter((error) =>
    AUTH_VERIFICATION_RE.test(String(error || "")),
  );
}

function looksLikeAuthPage(summary = {}) {
  const title = String(summary.currentStep?.title || "");
  const href = String(summary.href || "");
  const fields = summary.fields || [];
  const hasEmail = fields.some((field) =>
    /email|username|user/i.test(
      [field.id, field.name, field.automationId, field.ariaLabel, field.text]
        .filter(Boolean)
        .join(" "),
    ),
  );
  const hasPassword = fields.some(
    (field) =>
      String(field.type || "").toLowerCase() === "password" ||
      /password/i.test(
        [field.id, field.name, field.automationId, field.ariaLabel, field.text]
          .filter(Boolean)
          .join(" "),
      ),
  );
  return (
    /create account|sign in|log in|login|register|sign up/i.test(title) ||
    (/\/login\b|\/apply\/applyManually/i.test(href) && hasEmail && hasPassword)
  );
}

function expectedVerificationDomains(...urls) {
  const hosts = new Set();
  for (const value of urls) {
    try {
      const host = new URL(value).hostname;
      if (host) hosts.add(host);
    } catch (_error) {
      // Ignore non-URL values; generic Workday hosts are only a no-context fallback.
    }
  }
  if (!hosts.size) {
    ["workday.com", "myworkday.com", "myworkdayjobs.com"].forEach((host) =>
      hosts.add(host),
    );
  }
  return [...hosts].filter(Boolean);
}

function authReturnUrl(afterHref, fallbackApplyUrl) {
  try {
    const current = new URL(afterHref || "");
    if (/\/userHome\b/i.test(current.pathname)) {
      return fallbackApplyUrl;
    }
  } catch (_error) {
    // Invalid URLs fall through to the normal workflow loop.
  }
  return "";
}

function workdayAppScope(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .filter((segment) => !/^[a-z]{2}-[A-Z]{2}$/i.test(segment));
    return {
      host: url.hostname.toLowerCase(),
      appSegment: String(segments[0] || "").toLowerCase(),
    };
  } catch (_error) {
    return { host: "", appSegment: "" };
  }
}

async function resolveAuthVerificationViaMail(pageClient, args, context = {}) {
  const before = await inspectPage(pageClient);
  const errors = authVerificationErrors(before.errors || []);
  const bodyText = String(before.bodyHead || "");
  if (!errors.length && !AUTH_VERIFICATION_RE.test(bodyText)) {
    return {
      ok: false,
      skipped: true,
      reason: "auth_verification_not_present",
      before,
    };
  }
  const resend = await pageClient.evaluate(
    `(async () => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
      };
      const controls = [...document.querySelectorAll('button, [role="button"], a')]
        .filter(visible)
        .map((el) => ({
          el,
          text: normalize([el.innerText, el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" ")),
          automationId: el.getAttribute("data-automation-id") || "",
        }))
        .filter((entry) => /resend.*(verification|email)|request.*verification/i.test(entry.text + " " + entry.automationId));
      if (!controls.length) return { clicked: false, reason: "resend_not_found" };
      const target = controls[0].el;
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return {
        clicked: true,
        reason: "resend_clicked",
        label: controls[0].text,
        automationId: controls[0].automationId,
        clickedAt: new Date().toISOString(),
      };
    })()`,
    30000,
  ).catch((error) => ({
    clicked: false,
    reason: "resend_probe_failed",
    message: error instanceof Error ? error.message : String(error),
  }));
  if (resend.clicked) {
    await sleep(2500);
  }
  const provider = process.env.HUNT_C3_MAIL_PROVIDER || "imap";
  const since =
    context.since ||
    (resend.clicked
      ? resend.clickedAt
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const request = {
    email: args.accountEmail,
    expectedDomains: expectedVerificationDomains(
      before.href,
      args.jobUrl,
      context.applyUrl,
    ),
    since,
    timeoutSeconds: Number(
      process.env.HUNT_C3_MAIL_MAX_WAIT_SECONDS ||
        process.env.HUNT_C3_EMAIL_VERIFICATION_TIMEOUT_SECONDS ||
        90,
    ),
    jobUrl: before.href || context.applyUrl || args.jobUrl,
    expectedApplyUrl: context.applyUrl || args.jobUrl || before.href,
    expectedJobUrl: args.jobUrl || context.applyUrl || before.href,
  };
  const bridge = await verifyEmail(request, { provider });
  if (!bridge.ok || !bridge.link) {
    return {
      ok: false,
      reason: bridge.reason || "auth_verification_required",
      message:
        bridge.message ||
        "Workday requires account verification, but the mail bridge did not return an activation link.",
      provider,
      request: {
        email: request.email,
        expectedDomains: request.expectedDomains,
        since: request.since,
        timeoutSeconds: request.timeoutSeconds,
        jobUrl: request.jobUrl,
        expectedApplyUrl: request.expectedApplyUrl,
        expectedJobUrl: request.expectedJobUrl,
      },
      bridge,
      resend,
      before,
    };
  }
  await navigate(pageClient, bridge.link);
  await sleep(2500);
  let after = await inspectPage(pageClient);
  let postVerifyRedirect = null;
  try {
    const currentUrl = new URL(after.href || "");
    const redirect = currentUrl.searchParams.get("redirect");
    if (/\/login\/ok\b/i.test(currentUrl.pathname) && redirect) {
      postVerifyRedirect = new URL(redirect, currentUrl.origin).href;
      await navigate(pageClient, postVerifyRedirect);
      await sleep(2500);
      after = await inspectPage(pageClient);
    }
  } catch (_error) {
    // If the verification URL is unusual, keep the verified page state and let
    // the main loop decide whether a sign-in/application page is available.
  }
  const expectedScope = workdayAppScope(
    request.expectedApplyUrl || request.expectedJobUrl,
  );
  const afterScope = workdayAppScope(after.href || "");
  if (
    expectedScope.host &&
    afterScope.host &&
    (afterScope.host !== expectedScope.host ||
      (expectedScope.appSegment &&
        afterScope.appSegment &&
        afterScope.appSegment !== expectedScope.appSegment))
  ) {
    return {
      ok: false,
      reason: "verification_link_tenant_mismatch",
      message:
        "Verification link opened a different Workday tenant than the current run.",
      provider,
      request: {
        email: request.email,
        expectedDomains: request.expectedDomains,
        since: request.since,
        timeoutSeconds: request.timeoutSeconds,
        jobUrl: request.jobUrl,
        expectedApplyUrl: request.expectedApplyUrl,
        expectedJobUrl: request.expectedJobUrl,
      },
      bridge,
      resend,
      postVerifyRedirect,
      before,
      after,
    };
  }
  return {
    ok: true,
    reason: "auth_verification_link_opened",
    provider,
    request: {
      email: request.email,
      expectedDomains: request.expectedDomains,
      since: request.since,
      timeoutSeconds: request.timeoutSeconds,
      jobUrl: request.jobUrl,
    },
    bridge,
    resend,
    postVerifyRedirect,
    before,
    after,
  };
}

function stepMatches(summary, targetStep) {
  if (!targetStep) {
    return false;
  }
  const current = String(summary?.currentStep?.title || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const target = String(targetStep || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return Boolean(current && target && current === target);
}

function pageSummaryExpression() {
  return `(() => {
    const isSafeNextText = (value) => /^(next|next step|go next|continue|save and continue|save & continue)$/i.test(String(value || "").replace(/\\s+/g, " ").trim());
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = document.body ? document.body.innerText : "";
    const normalizedText = text.replace(/\s+/g, " ").trim().toLowerCase();
    const workdayRuntimeError = normalizedText.includes("something went wrong")
      && (normalizedText.includes("please refresh the page and then try again")
        || normalizedText.includes("plea e refre h the page and then try again")
        || (normalizedText.includes("refre") && normalizedText.includes("try again")));
    const readCurrentStep = () => {
      const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"]');
      if (activeStep) {
        const steps = [...document.querySelectorAll('[data-automation-id^="progressBar"]')];
        const labels = [...activeStep.querySelectorAll("label")]
          .map((label) => normalize(label.innerText || label.textContent || ""))
          .filter(Boolean);
        const title = labels.at(-1)
          || normalize(activeStep.innerText || activeStep.textContent || "").split(/\\n/).map(normalize).filter(Boolean).at(-1)
          || "";
        if (title) {
          return {
            current: Math.max(steps.indexOf(activeStep) + 1, 1),
            total: steps.length || 1,
            title
          };
        }
      }
      const stepMatch = text.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i)
        || normalize(text).match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s+(.+?)(?:\\s+s?tep\\s+\\d+\\s+of\\s+\\d+|$)/i);
      return stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: normalize(stepMatch[3]) } : null;
    };
    const currentStep = readCurrentStep();
    const actionText = (value) => {
      const parts = normalize(value).split(" ").filter(Boolean);
      return parts.filter((part, index) => index === 0 || part.toLowerCase() !== parts[index - 1].toLowerCase()).join(" ");
    };
    const buttons = [...document.querySelectorAll("button")].filter(visible).map((button) => ({
      text: (button.innerText || button.textContent || "").replace(/\\s+/g, " ").trim(),
      automationId: button.getAttribute("data-automation-id") || "",
      disabled: button.disabled || button.getAttribute("aria-disabled") === "true"
    })).filter((button) => button.text);
    const fields = [...document.querySelectorAll('input, textarea, select, button[aria-haspopup="listbox"]')]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName,
        type: el.type || "",
        id: el.id || "",
        name: el.name || "",
        automationId: el.getAttribute("data-automation-id") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 140),
        value: "value" in el ? String(el.value || "").slice(0, 140) : "",
        required: el.required || el.getAttribute("aria-required") === "true",
        invalid: el.getAttribute("aria-invalid") || ""
      }));
    const placeholder = (value) => {
      const normalized = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      return !normalized || normalized === "select one" || normalized === "select..." || normalized === "select" || normalized === "none";
    };
    const workdayButtons = [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
      .filter(visible)
      .map((button) => (button.innerText || button.textContent || "").replace(/\s+/g, " ").trim())
      .filter((value) => !placeholder(value));
    const selectedPills = [...document.querySelectorAll('[data-automation-id="selectedItem"], [id^="pill-"], [aria-label*="press delete to clear value"]')]
      .filter(visible)
      .map((el) => (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const filledNative = [...document.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea, select')]
      .filter(visible)
      .filter((el) => {
        if (el.matches("select")) return Boolean(el.value);
        if (el.type === "checkbox" || el.type === "radio") return el.checked;
        return Boolean(el.value);
      })
      .map((el) => ({
        tag: el.tagName,
        id: el.id || "",
        name: el.name || "",
        value: el.type === "checkbox" || el.type === "radio" ? String(el.checked) : String(el.value || "")
      }));
    const errors = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [id*="error"], .css-1iucqxd')]
      .filter(visible)
      .map((el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .filter((text) => !/successfully uploaded/i.test(text))
      .slice(0, 30);
    const loadingNodes = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-automation-id*="loading" i], [class*="loading" i], [class*="spinner" i]')]
      .filter(visible);
    const fieldText = (field) => [field.id, field.name, field.type, field.automationId, field.ariaLabel, field.text].join(" ");
    const hasEmailField = fields.some((field) => /email|username|user/i.test(fieldText(field)));
    const passwordCount = fields.filter((field) => field.type === "password").length;
    const hasAuthText = /create account|sign in|log in|login|register|sign up/i.test(text)
      || /create account|sign in|log in|login|register|sign up/i.test(currentStep?.title || "");
    const authPageVisible = hasEmailField && passwordCount > 0 && hasAuthText;
    const pageKind = /community\\.workday\\.com\\/maintenance-page/i.test(location.href)
      || /workday is currently unavailable|service interruption/i.test(text)
      ? "maintenance"
      : authPageVisible
        ? "auth"
        : buttons.some((button) => /^submit$/i.test(actionText(button.text))) || /review/i.test(currentStep?.title || "")
        ? "review"
        : "";
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      currentStep,
      pageKind,
      hasSubmit: buttons.some((button) => /^submit$/i.test(actionText(button.text))),
      hasNext: buttons.some((button) => isSafeNextText(button.text) && !button.disabled),
      buttons,
      fields,
      remainingValues: {
        workdayButtons,
        selectedPills,
        filledNative
      },
      errors,
      loadingNodeCount: loadingNodes.length,
      workdayRuntimeError,
      bodyHead: text.replace(/\\s+/g, " ").trim().slice(0, 1200)
    };
  })()`;
}

async function inspectPage(pageClient) {
  return pageClient.evaluate(pageSummaryExpression());
}

async function recoverWorkdayRuntimeError(
  pageClient,
  reason = "workday_runtime_error",
) {
  const before = await inspectPage(pageClient);
  if (!before.workdayRuntimeError) {
    return {
      attempted: false,
      ok: true,
      reason: "not_present",
      before,
    };
  }
  await pageClient.send("Page.reload", { ignoreCache: false });
  await sleep(7000);
  const after = await inspectPage(pageClient);
  return {
    attempted: true,
    ok: !after.workdayRuntimeError,
    reason,
    before,
    after,
  };
}

async function clickWorkdayStep(pageClient, stepName) {
  if (!stepName) {
    return { ok: true, skipped: true };
  }
  const attempts = [];
  for (let index = 0; index < 8; index += 1) {
    const result = await pageClient.evaluate(
      `(async () => {
      const target = ${JSON.stringify(stepName)};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const targetLower = normalize(target).toLowerCase();
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const clickReal = (targetEl) => {
        targetEl.scrollIntoView({ block: "center", inline: "center" });
        const rect = targetEl.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 1,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2)
        };
        ["mouseover", "mousemove", "pointerdown", "mousedown"].forEach((type) => targetEl.dispatchEvent(new PointerEvent(type, init)));
        targetEl.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
        targetEl.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
        targetEl.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
      };
      const bodyText = document.body ? document.body.innerText : "";
      const normalizedBodyText = bodyText.toLowerCase();
      const workdayRuntimeError = normalizedBodyText.includes("something went wrong")
        && (normalizedBodyText.includes("please refresh the page and then try again")
          || normalizedBodyText.includes("plea e refre h the page and then try again")
          || (normalizedBodyText.includes("refre") && normalizedBodyText.includes("try again")));
      const readCurrentStep = () => {
        const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"]');
        if (activeStep) {
          const steps = [...document.querySelectorAll('[data-automation-id^="progressBar"]')];
          const labels = [...activeStep.querySelectorAll("label")]
            .map((label) => normalize(label.innerText || label.textContent || ""))
            .filter(Boolean);
          const title = labels.at(-1)
            || normalize(activeStep.innerText || activeStep.textContent || "").split(/\\n/).map(normalize).filter(Boolean).at(-1)
            || "";
          if (title) {
            return {
              current: Math.max(steps.indexOf(activeStep) + 1, 1),
              total: steps.length || 1,
              title
            };
          }
        }
        const stepMatch = bodyText.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i)
          || normalize(bodyText).match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s+(.+?)(?:\\s+s?tep\\s+\\d+\\s+of\\s+\\d+|$)/i);
        return stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: normalize(stepMatch[3]) } : null;
      };
      const currentStep = readCurrentStep();
      if (currentStep && currentStep.title.toLowerCase() === targetLower) {
        return {
          ok: true,
          reached: true,
          target,
          currentStep,
          href: location.href,
          workdayRuntimeError
        };
      }
      const candidates = [...document.querySelectorAll("button, a, [role='button'], [role='link']")]
        .filter(visible)
        .map((el) => ({
          el,
          text: normalize([el.getAttribute("aria-label"), el.innerText, el.textContent].filter(Boolean).join(" ")),
          disabled: el.disabled || el.getAttribute("aria-disabled") === "true"
        }))
        .filter((item) => item.text && !item.disabled);
      const candidate = candidates.find((item) => item.text.toLowerCase() === targetLower)
        || candidates.find((item) => item.text.toLowerCase().includes(targetLower));
      if (candidate) {
        clickReal(candidate.el);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const afterText = document.body ? document.body.innerText : "";
        return {
          ok: true,
          clicked: true,
          target,
          label: candidate.text,
          href: location.href,
          workdayRuntimeError: afterText.toLowerCase().includes("something went wrong")
            && (afterText.toLowerCase().includes("please refresh the page and then try again")
              || afterText.toLowerCase().includes("plea e refre h the page and then try again")
              || (afterText.toLowerCase().includes("refre") && afterText.toLowerCase().includes("try again")))
        };
      }
      const back = candidates.find((item) => /^back(\\s+back)?$/i.test(item.text));
      if (back) {
        clickReal(back.el);
        await new Promise((resolve) => setTimeout(resolve, 8000));
        const afterText = document.body ? document.body.innerText : "";
        return {
          ok: false,
          clickedBack: true,
          reason: "rewind_with_back",
          target,
          currentStep,
          label: back.text,
          href: location.href,
          workdayRuntimeError: afterText.toLowerCase().includes("something went wrong")
            && (afterText.toLowerCase().includes("please refresh the page and then try again")
              || afterText.toLowerCase().includes("plea e refre h the page and then try again")
              || (afterText.toLowerCase().includes("refre") && afterText.toLowerCase().includes("try again"))),
          candidates: candidates.map((item) => item.text).slice(0, 30)
        };
      }
      if (currentStep && currentStep.current > 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return {
          ok: false,
          retry: true,
          reason: "waiting_for_step_controls",
          target,
          currentStep,
          candidates: candidates.map((item) => item.text).slice(0, 30)
        };
      }
      return {
        ok: false,
        reason: "step_link_not_found",
        target,
        currentStep,
        candidates: candidates.map((item) => item.text).slice(0, 30)
      };
    })()`,
      30000,
    );
    attempts.push(result);
    if (result.workdayRuntimeError) {
      const runtimeRecovery = await recoverWorkdayRuntimeError(
        pageClient,
        "start_step_workday_runtime_error",
      );
      attempts[attempts.length - 1].runtimeRecovery = runtimeRecovery;
      if (runtimeRecovery.ok) {
        await sleep(800);
        continue;
      }
      return { ...result, attempts };
    }
    if (result.ok) {
      return { ...result, attempts };
    }
    if (result.retry) {
      await sleep(1200);
      continue;
    }
    if (!result.clickedBack) {
      return { ...result, attempts };
    }
    await sleep(800);
  }
  return {
    ok: false,
    reason: "start_step_rewind_limit",
    target: stepName,
    attempts,
  };
}

async function cdpClick(client, x, y) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await new Promise((r) => setTimeout(r, 40));
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, 60));
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function suppressStaleWorkdayDateErrors(summary) {
  const errors = Array.isArray(summary?.errors) ? summary.errors : [];
  if (
    !errors.some((error) =>
      /desired start date|required and must have a value/i.test(error),
    )
  ) {
    return summary;
  }
  const fields = Array.isArray(summary?.fields) ? summary.fields : [];
  const dateValues = fields
    .filter((field) => /dateSection(Month|Day|Year)/i.test(field.id || ""))
    .map((field) => ({
      id: field.id || "",
      value: String(field.value || "").trim(),
      invalid: field.invalid || "",
    }));
  const hasMonth = dateValues.some(
    (field) => /dateSectionMonth/i.test(field.id) && field.value,
  );
  const hasDay = dateValues.some(
    (field) => /dateSectionDay/i.test(field.id) && field.value,
  );
  const hasYear = dateValues.some(
    (field) => /dateSectionYear/i.test(field.id) && field.value,
  );
  const anyInvalid = dateValues.some((field) => field.invalid === "true");
  if (!hasMonth || !hasDay || !hasYear || anyInvalid) {
    return summary;
  }
  return {
    ...summary,
    errors: errors.filter(
      (error) =>
        !/desired start date|required and must have a value/i.test(error),
    ),
    suppressedErrors: [
      ...(summary.suppressedErrors || []),
      {
        reason: "stale_date_section_validation_error",
        errors: errors.filter((error) =>
          /desired start date|required and must have a value/i.test(error),
        ),
        dateValues,
      },
    ],
  };
}

function fillMessageTimeoutMs(args) {
  if (
    Number.isFinite(args.fillMessageTimeoutMs) &&
    args.fillMessageTimeoutMs > 0
  ) {
    return args.fillMessageTimeoutMs;
  }
  if (args.extensionAutoNext) {
    return 600000;
  }
  return PAGE_FILL_AND_NEXT_TIMEOUT_MS;
}

async function fillCurrentPage(optionsClient, applyUrl, args, pageContext = {}) {
  const messageTimeoutMs = fillMessageTimeoutMs(args);
  const evaluateTimeoutMs = messageTimeoutMs + 10000;
  const allowLoginRedirectFill = looksLikeAuthPage(pageContext);
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const applyUrl = ${JSON.stringify(applyUrl)};
      const allowLoginRedirectFill = ${JSON.stringify(allowLoginRedirectFill)};
      const parsedApplyUrl = new URL(applyUrl);
      const applyHost = parsedApplyUrl.host;
      const applyBase = applyUrl.split("?")[0];
      const normalizeWorkdayPathname = (pathname) => String(pathname || "")
        .replace(/^\\/[a-z]{2}-[A-Z]{2}(?=\\/)/, "")
        .replace(/\\/$/, "");
      const jobPathBase = normalizeWorkdayPathname(parsedApplyUrl.pathname)
        .replace(/\\/apply\\/applyManually\\/?$/i, "")
        .replace(/\\/apply\\/.*$/i, "")
        .replace(/\\/apply\\/?$/i, "");
      const exactApplyManually = (item) => String(item.url || "").startsWith(applyBase)
        && !/error|ok/i.test(String(item.title || ""));
      const sameWorkdayApply = (item) => {
        try {
          const url = new URL(item.url || "");
          const itemPath = normalizeWorkdayPathname(url.pathname);
          return url.host === applyHost
            && itemPath.startsWith(jobPathBase)
            && /\\/apply(?:\\/|$)/i.test(itemPath)
            && !/create account|sign in|error|ok/i.test(String(item.title || ""));
        } catch (_error) {
          return false;
        }
      };
      const sameWorkdayLoginRedirect = (item) => {
        try {
          const url = new URL(item.url || "");
          if (url.host !== applyHost || !/\\/login\\/?$/i.test(url.pathname)) {
            return false;
          }
          const redirect = url.searchParams.get("redirect") || "";
          if (!redirect) {
            return false;
          }
          const redirectUrl = new URL(redirect, parsedApplyUrl.origin);
          const redirectPath = normalizeWorkdayPathname(redirectUrl.pathname);
          return redirectPath.startsWith(jobPathBase)
            && /\\/apply(?:\\/|$)/i.test(redirectPath)
            && !/error|ok/i.test(String(item.title || ""));
        } catch (_error) {
          return false;
        }
      };
      const exactCandidates = tabs.filter(exactApplyManually);
      const broadCandidates = tabs.filter(sameWorkdayApply);
      const loginRedirectCandidates = tabs.filter(sameWorkdayLoginRedirect);
      const candidates = exactCandidates.concat(
        broadCandidates,
        allowLoginRedirectFill ? loginRedirectCandidates : []
      );
      const deduped = [...new Map(candidates.map((item) => [item.id, item])).values()];
      const sortedExact = exactCandidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const sortedLoginRedirect = loginRedirectCandidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const sortedBroad = deduped.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      let tab = sortedExact.find((item) => item.active)
        || sortedExact[0]
        || (allowLoginRedirectFill ? sortedLoginRedirect.find((item) => item.active) : null)
        || (allowLoginRedirectFill ? sortedLoginRedirect[0] : null)
        || sortedBroad.find((item) => item.active)
        || sortedBroad[0];
      if (!tab) {
        // Auth-gate fallback: tab title is "Create Account/Sign In" (excluded above).
        // Accept any tab on the same host + apply path regardless of title.
        const authCandidates = tabs.filter((item) => {
          try {
            const url = new URL(item.url || "");
            const itemPath = normalizeWorkdayPathname(url.pathname);
            return url.host === applyHost
              && itemPath.startsWith(jobPathBase)
              && /\\/apply(?:\\/|$)/i.test(itemPath);
          } catch (_error) {
            return false;
          }
        });
        const dedupedAuth = [...new Map(authCandidates.map((item) => [item.id, item])).values()];
        tab = dedupedAuth.find((item) => item.active)
          || dedupedAuth.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
      }
      if (!tab) {
        return { ok: false, error: "workday_tab_not_found" };
      }
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
      }
      const messageTimeoutMs = ${JSON.stringify(messageTimeoutMs)};
      const wrapped = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };
        const timer = setTimeout(() => {
          finish({
            messageResponse: {
              ok: false,
              error: "fill_message_timeout",
              message: "Fill message timed out before the extension responded.",
              attempt: {
                status: "timeout",
                summary: "Fill message timed out.",
                filledFieldCount: 0,
                manualReviewReasons: ["fill_timeout"],
                bestEffortWarnings: ["fill_message_timeout"]
              },
              result: {
                pendingLlmFieldCount: 0,
                manualReviewReasons: ["fill_timeout"],
                fieldInventory: []
              }
            },
            lastError: ""
          });
        }, messageTimeoutMs);
        chrome.runtime.sendMessage(
          { type: "hunt.apply.fill_current_page", payload: { tabId: tab.id, allowLlmAnswers: ${JSON.stringify(args.llmAnswers)}, triggeredBy: "c3_workday_live_smoke:fill_current_page" } },
          (messageResponse) => {
            clearTimeout(timer);
            finish({
              messageResponse,
              lastError: chrome.runtime.lastError && chrome.runtime.lastError.message
            });
          }
        );
      });
      const response = wrapped.messageResponse || {};
      const attempt = response.attempt || {};
      const result = response.result || {};
      return {
        ok: response.ok === true,
          error: wrapped.lastError || response.error || "",
          message: response.message || "",
          nextAction: response.nextAction || null,
          status: attempt.status || "",
        summary: attempt.summary || "",
        filledFieldCount: attempt.filledFieldCount || result.filledFieldCount || 0,
        manualReviewReasons: attempt.manualReviewReasons || result.manualReviewReasons || [],
        bestEffortWarnings: attempt.bestEffortWarnings || result.bestEffortWarnings || [],
        pendingLlmFieldCount: result.pendingLlmFieldCount || 0,
        generatedAnswers: result.generatedAnswers || [],
        filledFields: result.filledFields || [],
        interactionTrace: result.interactionTrace || [],
        v2Audit: result.v2Audit || attempt.v2Audit || null,
        siteActions: result.siteActions || attempt.siteActions || response.siteActions || [],
        fieldInventory: (result.fieldInventory || []).map((field) => ({
          kind: field.kind || "",
          tagName: field.tagName || "",
          type: field.type || "",
          id: field.id || "",
          name: field.name || "",
          descriptor: String(field.descriptor || "").slice(0, 180),
          required: Boolean(field.required),
          filled: Boolean(field.filled),
          skippedReason: field.skippedReason || "",
          valueSource: field.valueSource || "",
          bestEffortWarning: field.bestEffortWarning || "",
          options: Array.isArray(field.options) ? field.options : []
        }))
      };
    })()`,
    evaluateTimeoutMs,
  );
}

async function clearCurrentPage(optionsClient, applyUrl, pageContext = {}) {
  const allowLoginRedirectFill = looksLikeAuthPage(pageContext);
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const applyUrl = ${JSON.stringify(applyUrl)};
      const allowLoginRedirectFill = ${JSON.stringify(allowLoginRedirectFill)};
      const parsedApplyUrl = new URL(applyUrl);
      const applyHost = parsedApplyUrl.host;
      const applyBase = applyUrl.split("?")[0];
      const normalizeWorkdayPathname = (pathname) => String(pathname || "")
        .replace(/^\\/[a-z]{2}-[A-Z]{2}(?=\\/)/, "")
        .replace(/\\/$/, "");
      const jobPathBase = normalizeWorkdayPathname(parsedApplyUrl.pathname)
        .replace(/\\/apply\\/applyManually\\/?$/i, "")
        .replace(/\\/apply\\/.*$/i, "")
        .replace(/\\/apply\\/?$/i, "");
      const exactApplyManually = (item) => String(item.url || "").startsWith(applyBase)
        && !/error|ok/i.test(String(item.title || ""));
      const sameWorkdayApply = (item) => {
        try {
          const url = new URL(item.url || "");
          const itemPath = normalizeWorkdayPathname(url.pathname);
          return url.host === applyHost
            && itemPath.startsWith(jobPathBase)
            && /\\/apply(?:\\/|$)/i.test(itemPath)
            && !/create account|sign in|error|ok/i.test(String(item.title || ""));
        } catch (_error) {
          return false;
        }
      };
      const sameWorkdayLoginRedirect = (item) => {
        try {
          const url = new URL(item.url || "");
          if (url.host !== applyHost || !/\\/login\\/?$/i.test(url.pathname)) {
            return false;
          }
          const redirect = url.searchParams.get("redirect") || "";
          if (!redirect) {
            return false;
          }
          const redirectUrl = new URL(redirect, parsedApplyUrl.origin);
          const redirectPath = normalizeWorkdayPathname(redirectUrl.pathname);
          return redirectPath.startsWith(jobPathBase)
            && /\\/apply(?:\\/|$)/i.test(redirectPath)
            && !/error|ok/i.test(String(item.title || ""));
        } catch (_error) {
          return false;
        }
      };
      const exactCandidates = tabs.filter(exactApplyManually);
      const broadCandidates = tabs.filter(sameWorkdayApply);
      const loginRedirectCandidates = tabs.filter(sameWorkdayLoginRedirect);
      const candidates = exactCandidates.concat(
        broadCandidates,
        allowLoginRedirectFill ? loginRedirectCandidates : []
      );
      const deduped = [...new Map(candidates.map((item) => [item.id, item])).values()];
      const sortedExact = exactCandidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const sortedLoginRedirect = loginRedirectCandidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const sortedBroad = deduped.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      let tab = sortedExact.find((item) => item.active)
        || sortedExact[0]
        || (allowLoginRedirectFill ? sortedLoginRedirect.find((item) => item.active) : null)
        || (allowLoginRedirectFill ? sortedLoginRedirect[0] : null)
        || sortedBroad.find((item) => item.active)
        || sortedBroad[0];
      if (!tab) {
        // Auth-gate fallback: tab title is "Create Account/Sign In" (excluded above).
        // Accept any tab on the same host + apply path regardless of title.
        const authCandidates = tabs.filter((item) => {
          try {
            const url = new URL(item.url || "");
            const itemPath = normalizeWorkdayPathname(url.pathname);
            return url.host === applyHost
              && itemPath.startsWith(jobPathBase)
              && /\\/apply(?:\\/|$)/i.test(itemPath);
          } catch (_error) {
            return false;
          }
        });
        const dedupedAuth = [...new Map(authCandidates.map((item) => [item.id, item])).values()];
        tab = dedupedAuth.find((item) => item.active)
          || dedupedAuth.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
      }
      if (!tab) {
        return { ok: false, error: "workday_tab_not_found" };
      }
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
      }
      const wrapped = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "hunt.apply.clear_current_page", payload: { tabId: tab.id } },
          (messageResponse) => resolve({
            messageResponse,
            lastError: chrome.runtime.lastError && chrome.runtime.lastError.message
          })
        );
      });
      return {
        ...(wrapped.messageResponse || {}),
        error: wrapped.lastError || (wrapped.messageResponse || {}).error || ""
      };
    })()`,
    120000,
  );
}

function summarizeClear(clear) {
  return {
    ok: Boolean(clear?.ok),
    status: clear?.attempt?.status || clear?.status || "",
    message: clear?.message || "",
    clearedFieldCount: clear?.clearedFieldCount || clear?.cleared || 0,
    reviewIssueCount: clear?.reviewIssueCount || 0,
    reviewIssues: clear?.reviewIssues || [],
    v2AuditEvents: (clear?.v2Audit?.events || []).slice(0, 80),
  };
}

async function clearPageUntilStable(optionsClient, pageClient, applyUrl, pageContext = {}) {
  const attempts = [];
  let previousRemaining = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 3; index += 1) {
    const clear = await clearCurrentPage(optionsClient, applyUrl, pageContext);
    await sleep(2200);
    const afterClear = await inspectPage(pageClient);
    const remaining = Number(clear?.reviewIssueCount || 0);
    attempts.push({
      index: index + 1,
      clear: summarizeClear(clear),
      afterClear: {
        href: afterClear.href,
        currentStep: afterClear.currentStep,
        hasNext: afterClear.hasNext,
        hasSubmit: afterClear.hasSubmit,
        errors: afterClear.errors,
        remainingValues: afterClear.remainingValues,
      },
    });
    if (remaining === 0 || remaining >= previousRemaining) {
      break;
    }
    previousRemaining = remaining;
  }
  return {
    ok: attempts.some((attempt) => attempt.clear.ok),
    attempts,
    final: attempts.at(-1) || null,
  };
}

async function clickNext(pageClient) {
  return pageClient.evaluate(
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const clickReal = (target) => {
        target.scrollIntoView({ block: "center", inline: "center" });
        const rect = target.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 1,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2)
        };
        ["mouseover", "mousemove", "pointerdown", "mousedown"].forEach((type) => target.dispatchEvent(new PointerEvent(type, init)));
        target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
        target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
      };
      const safeNextText = (value) => /^(next|next step|go next|continue|save and continue|save & continue)$/i.test(String(value || "").replace(/\\s+/g, " ").trim());
      const visibleValidationErrors = () => [...document.querySelectorAll([
        '[role="alert"]',
        '[data-automation-id*="error" i]',
        '[id*="error" i]',
        '.css-1iucqxd'
      ].join(","))]
        .filter(visible)
        .map((node) => (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim())
        .filter(Boolean)
        .filter((text) => !/successfully uploaded/i.test(text))
        .filter((text, index, all) => all.indexOf(text) === index);
      const dateSectionLooksFilled = () => {
        const values = [...document.querySelectorAll('input[id*="dateSectionMonth"], input[id*="dateSectionDay"], input[id*="dateSectionYear"]')]
          .filter(visible)
          .map((input) => ({
            id: input.id || "",
            value: String(input.value || "").trim(),
            invalid: input.getAttribute("aria-invalid") || ""
          }));
        return values.some((field) => /dateSectionMonth/i.test(field.id) && field.value)
          && values.some((field) => /dateSectionDay/i.test(field.id) && field.value)
          && values.some((field) => /dateSectionYear/i.test(field.id) && field.value)
          && !values.some((field) => field.invalid === "true");
      };
      const beforeHref = location.href;
      let errors = visibleValidationErrors();
      const suppressedErrors = [];
      if (dateSectionLooksFilled()) {
        const staleDateErrors = errors.filter((error) => /desired start date|required and must have a value/i.test(error));
        if (staleDateErrors.length) {
          suppressedErrors.push({
            reason: "stale_date_section_validation_error",
            errors: staleDateErrors
          });
          errors = errors.filter((error) => !/desired start date|required and must have a value/i.test(error));
        }
      }
      if (errors.length) {
        return {
          clicked: false,
          reason: "visible_validation_errors",
          href: beforeHref,
          errors: errors.slice(0, 10),
          suppressedErrors
        };
      }
      const button = [...document.querySelectorAll("button")]
        .filter(visible)
        .find((candidate) => safeNextText(candidate.innerText || candidate.textContent || "") && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true");
      if (!button) {
        return { clicked: false, reason: "next_not_found", href: beforeHref };
      }
      clickReal(button);
      await sleep(6500);
      const body = document.body ? document.body.innerText : "";
      const normalizedBody = body.toLowerCase();
      const workdayRuntimeError = normalizedBody.includes("something went wrong")
        && (normalizedBody.includes("please refresh the page and then try again")
          || normalizedBody.includes("plea e refre h the page and then try again")
          || (normalizedBody.includes("refre") && normalizedBody.includes("try again")));
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const readCurrentStep = () => {
        const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"]');
        if (activeStep) {
          const steps = [...document.querySelectorAll('[data-automation-id^="progressBar"]')];
          const labels = [...activeStep.querySelectorAll("label")]
            .map((label) => normalize(label.innerText || label.textContent || ""))
            .filter(Boolean);
          const title = labels.at(-1)
            || normalize(activeStep.innerText || activeStep.textContent || "").split(/\\n/).map(normalize).filter(Boolean).at(-1)
            || "";
          if (title) {
            return {
              current: Math.max(steps.indexOf(activeStep) + 1, 1),
              total: steps.length || 1,
              title
            };
          }
        }
        const stepMatch = body.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i)
          || normalize(body).match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s+(.+?)(?:\\s+s?tep\\s+\\d+\\s+of\\s+\\d+|$)/i);
        return stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: normalize(stepMatch[3]) } : null;
      };
      return {
        clicked: true,
        beforeHref,
        href: location.href,
        currentStep: readCurrentStep(),
        workdayRuntimeError,
        suppressedErrors,
        bodyHead: body.replace(/\\s+/g, " ").trim().slice(0, 600)
      };
    })()`,
    30000,
  );
}

async function clearRepeatableWorkdaySections(pageClient) {
  return pageClient.evaluate(
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
      const clickReal = (target) => {
        target.scrollIntoView({ block: "center", inline: "center" });
        const rect = target.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: 1,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2)
        };
        ["mouseover", "mousemove", "pointerdown", "mousedown"].forEach((type) => target.dispatchEvent(new PointerEvent(type, init)));
        target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
        target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
      };
      const deleted = [];
      for (let pass = 0; pass < 20; pass += 1) {
        const buttons = [...document.querySelectorAll("button")]
          .filter(visible)
          .filter((button) => /^delete$/i.test(textOf(button)))
          .filter((button) => !/\\.pdf/i.test(button.getAttribute("aria-label") || ""));
        if (!buttons.length) {
          break;
        }
        const button = buttons[buttons.length - 1];
        deleted.push({
          pass,
          text: textOf(button),
          ariaLabel: button.getAttribute("aria-label") || "",
          top: Math.round(button.getBoundingClientRect().top)
        });
        clickReal(button);
        await sleep(500);
      }
      return {
        deleted,
        remainingDeleteButtons: [...document.querySelectorAll("button")]
          .filter(visible)
          .filter((button) => /^delete$/i.test(textOf(button)))
          .filter((button) => !/\\.pdf/i.test(button.getAttribute("aria-label") || "")).length
      };
    })()`,
    30000,
  );
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!fs.existsSync(args.resumePath)) {
    throw new Error(`Resume not found: ${args.resumePath}`);
  }

  const applyUrl = deriveApplyUrl(args.jobUrl, args.mode);
  const optionsTarget = await ensureOptionsTarget(
    args.cdpPort,
    args.extensionId,
  );
  const pageTarget = await ensurePageTarget(args.cdpPort, applyUrl);
  const closedWorkdayTabs = args.closeOtherWorkdayTabs
    ? await closeOtherWorkdayTabs(args.cdpPort, pageTarget)
    : [];
  const optionsClient = await connectTarget(optionsTarget);
  const pageClient = await connectTarget(pageTarget);
    const workflowIdentifier = new WorkdayWorkflowIdentifier({
      pageClient,
      sleep,
      authVerificationPattern: AUTH_VERIFICATION_RE,
    });
  const authWorkflow = new WorkdayAuthWorkflow({
    pageClient,
    cdpClick,
    inspectPage,
    js,
    sleep,
    authVerificationPattern: AUTH_VERIFICATION_RE,
    accountEmail: args.accountEmail,
    accountPassword: args.accountPassword,
  });
  const applyEntryWorkflow = new WorkdayApplyEntryWorkflow({
    pageClient,
    waitForReady: () => workflowIdentifier.waitForReady(APPLY_ENTRY_TIMEOUT_MS),
    navigate: (url) =>
      navigate(pageClient, url, () =>
        workflowIdentifier.waitForReady(APPLY_ENTRY_TIMEOUT_MS),
      ),
    cdpClick,
  });
    const signupAttemptsByScope = new Map();
    const fullApplicationStartedAt = Date.now();
    const remainingFullApplicationMs = () =>
      Math.max(
        0,
        FULL_APPLICATION_TIMEOUT_MS - (Date.now() - fullApplicationStartedAt),
      );
    const withApplicationPhaseTimeout = (phase, timeoutMs, work) => {
      const remaining = remainingFullApplicationMs();
      if (remaining <= 0) {
        throw new PhaseTimeoutError(
          "full_application",
          FULL_APPLICATION_TIMEOUT_MS,
        );
      }
      return withPhaseTimeout(phase, Math.min(timeoutMs, remaining), work);
    };
    const authScopeKey = (href) => {
    const scope = workdayAppScope(href || applyUrl);
    return `${scope.host}|${scope.appSegment}`;
  };
  const routeAfterSignupAttempt = (route) => {
    const key = authScopeKey(route?.state?.href);
    if (
      route?.authState === "signup" &&
      (signupAttemptsByScope.get(key) || 0) > 0
    ) {
      return {
        ...route,
        authState: "login",
        authUiState: "credential_form",
        signupRetryAsLogin: true,
      };
    }
    return route;
  };
  const noteSignupAttempt = (route) => {
    if (route?.authState !== "signup") return;
    const key = authScopeKey(route?.state?.href);
    signupAttemptsByScope.set(key, (signupAttemptsByScope.get(key) || 0) + 1);
  };

  try {
    if (args.noSeedExtension) {
      logWorkflowPhase(
        "extension_seed",
        "skipped",
        "Skipped extension seed by request; continuing with persisted settings.",
      );
    } else {
      const seedPayload = makeSeedPayload(args.resumePath, applyUrl, args);
      try {
        await seedExtension(optionsClient, seedPayload, args);
      } catch (error) {
        const message = String(error?.message || error || "");
        if (
          /MAX_WRITE_OPERATIONS_PER_HOUR|MAX_WRITE_OPERATIONS_PER_MINUTE|quota/i.test(
            message,
          )
        ) {
          logWorkflowPhase(
            "extension_seed",
            "warn",
            "Skipped extension seed because Chrome storage write quota was exhausted; continuing with persisted settings.",
            {
              error: message,
            },
          );
        } else {
          throw error;
        }
      }
    }
    await pageClient.send("Page.bringToFront");
    if (!args.preserveCurrent) {
      await withApplicationPhaseTimeout("identifier", IDENTIFIER_TIMEOUT_MS, () =>
        navigate(pageClient, applyUrl, () =>
          workflowIdentifier.waitForReady(IDENTIFIER_TIMEOUT_MS),
        ),
      );
      await pageClient.send("Page.bringToFront");
    } else {
      const readyState = await withApplicationPhaseTimeout(
        "identifier",
        IDENTIFIER_TIMEOUT_MS,
        () => workflowIdentifier.waitForReady(IDENTIFIER_TIMEOUT_MS),
      );
      logWorkflowPhase(
        "site",
        readyState.timedOut ? "blocked" : "ok",
        "Workday page reached a classified state before apply-entry detection.",
        {
          pageKind: readyState.pageKind,
          stillLoading: Boolean(readyState.stillLoading),
          waitedMs: readyState.waitedMs || 0,
          href: readyState.href || "",
        },
      );
    }
    const initialRoute = await withApplicationPhaseTimeout(
      "identifier",
      IDENTIFIER_TIMEOUT_MS,
      () => workflowIdentifier.identify(IDENTIFIER_TIMEOUT_MS),
    );
    logWorkflowPhase(
      "identifier",
      initialRoute.ok ? "ok" : "blocked",
      "Classified initial Workday page before choosing a workflow.",
      {
        phase: initialRoute.phase,
        pageKind: initialRoute.pageKind,
        authState: initialRoute.authState,
        authUiState: initialRoute.authUiState,
        href: initialRoute.state?.href || "",
      },
    );
    const applyEntry =
      initialRoute.phase === "apply_entry"
        ? await withApplicationPhaseTimeout("apply_entry", APPLY_ENTRY_TIMEOUT_MS, () =>
            applyEntryWorkflow.clickApplyManuallyEntry(),
          )
        : {
            ok: true,
            skipped: true,
            phase: "apply_entry",
            reason:
              initialRoute.phase === "job_fill"
                ? "already_on_application_step"
                : initialRoute.phase === "auth"
                  ? "auth_workflow_first"
                  : "no_apply_entry_gate",
            readyState: initialRoute.state,
          };
    logWorkflowPhase(
      "apply_entry",
      applyEntry.ok ? "ok" : "failed",
      applyEntry.skipped
        ? `Apply entry skipped: ${applyEntry.reason || "not needed"}.`
        : applyEntry.clicked
          ? "Detected start-application page and clicked Apply Manually."
          : "Apply entry detection did not reach the application form.",
      {
        reason: applyEntry.reason || "",
        href: applyEntry.href || "",
        currentStep: applyEntry.currentStep?.title || "",
      },
    );
    const startStep = await clickWorkdayStep(pageClient, args.startStep);

    const timeline = [];
    const audit = {
      ok: false,
      mode: args.mode,
      workflow: {
        cleanup: {
          phase: "cleanup",
          closedWorkdayTabCount: closedWorkdayTabs.length,
          closedWorkdayTabs,
        },
        auth: {
          phase: "auth",
          skipped: true,
          reason: "handled_outside_live_smoke",
        },
        applyEntry,
        identifier: {
          phase: "identifier",
          initial: initialRoute,
        },
        jobFill: {
          phase: "job_fill",
          started: true,
          notification: "Starting actual Workday job form fill.",
        },
      },
      jobUrl: args.jobUrl,
      applyUrl,
      resumePath: args.resumePath,
      startedAt: new Date().toISOString(),
      pages: [],
    };
    if (applyEntry.reason === "posting_not_found") {
      audit.workflow.applyEntry = applyEntry;
      audit.ok = false;
      audit.finishedAt = new Date().toISOString();
      audit.final = {
        href: applyEntry.readyState?.href || applyEntry.href || applyUrl,
        currentStep: null,
        hasSubmit: false,
        hasNext: false,
        errors: [],
      };
      const auditPath = writeAuditJson(args.auditJson, audit);
      const issueRegistry = recordAuditIssues({
        audit,
        auditPath: auditPath || args.auditJson || "",
      });
      console.log(
        JSON.stringify(
          {
            ok: false,
            mode: args.mode,
            applyUrl,
            auditJson: auditPath,
            issueRegistry,
            reason: "posting_not_found",
            message: "Workday says this job posting page does not exist.",
            final: audit.final,
            timeline,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (!applyEntry.ok) {
      throw new Error(
        `Apply entry phase failed: ${JSON.stringify(applyEntry)}`,
      );
    }
    pageLoop: for (let i = 0; i < args.maxPages; i += 1) {
      const pagePhaseStartedAt = Date.now();
      if (Date.now() - fullApplicationStartedAt > FULL_APPLICATION_TIMEOUT_MS) {
        audit.reason = "full_application_timeout";
        audit.message =
          "Full Workday application flow exceeded the 5 minute timeout.";
        break;
      }
      let before = await inspectPage(pageClient);
      if (before.workdayRuntimeError) {
        const runtimeRecovery = await recoverWorkdayRuntimeError(
          pageClient,
          "prefill_workday_runtime_error",
        );
        before.runtimeRecovery = runtimeRecovery;
        if (!runtimeRecovery.ok) {
          throw new Error("Workday runtime error did not recover after reload");
        }
        before = await inspectPage(pageClient);
      }
      const route = await withApplicationPhaseTimeout(
        "identifier",
        IDENTIFIER_TIMEOUT_MS,
        () => workflowIdentifier.identify(IDENTIFIER_TIMEOUT_MS),
      );
      if (route.phase === "terminal") {
        if (route.pageKind === "maintenance") {
          audit.reason = "site_or_posting_state";
          audit.message = "Workday maintenance page reached.";
        }
        timeline.push({
          pageIndex: i + 1,
          workflowPhase: "identifier",
          route,
          before: {
            href: before.href,
            currentStep: before.currentStep,
            pageKind: before.pageKind,
            hasNext: before.hasNext,
            hasSubmit: before.hasSubmit,
            errors: before.errors,
          },
        });
        break;
      }
      if (route.phase === "apply_entry") {
        const routedApplyEntry = await withApplicationPhaseTimeout(
          "apply_entry",
          APPLY_ENTRY_TIMEOUT_MS,
          () => applyEntryWorkflow.clickApplyManuallyEntry(),
        );
        timeline.push({
          pageIndex: i + 1,
          workflowPhase: "apply_entry",
          route,
          applyEntry: routedApplyEntry,
        });
        if (!routedApplyEntry.ok) {
          break;
        }
        await sleep(1200);
        continue;
      }
      if (route.phase === "auth") {
        const authRoute = routeAfterSignupAttempt(route);
        const authNext = await withApplicationPhaseTimeout(
          "auth",
          AUTH_WORKFLOW_TIMEOUT_MS,
          () => authWorkflow.clickPrimary(authRoute),
        );
        noteSignupAttempt(authRoute);
        timeline.push({
          pageIndex: i + 1,
          workflowPhase: "auth",
          route: authRoute,
          authNext,
          before: {
            href: before.href,
            currentStep: before.currentStep,
            hasNext: before.hasNext,
            hasSubmit: before.hasSubmit,
            errors: before.errors,
          },
        });
        if (
          route.authState === "verify_email" ||
          authNext.reason === "auth_verification_required" ||
          authVerificationErrors(authNext.after?.errors || []).length
        ) {
          const authVerification = await withApplicationPhaseTimeout(
            "auth",
            AUTH_WORKFLOW_TIMEOUT_MS,
            () =>
              resolveAuthVerificationViaMail(pageClient, args, { applyUrl }),
          );
          timeline[timeline.length - 1].authVerification = authVerification;
          if (!authVerification.ok) {
            break;
          }
          await sleep(1800);
          continue;
        }
        if (!authNext.clicked) {
          break;
        }
        const returnUrl = authReturnUrl(authNext.after?.href, applyUrl);
        if (returnUrl) {
          timeline[timeline.length - 1].authReturnUrl = returnUrl;
          await navigate(pageClient, returnUrl, () =>
            workflowIdentifier.waitForReady(AUTH_WORKFLOW_TIMEOUT_MS),
          );
          await sleep(1200);
          continue;
        }
        await sleep(1800);
        continue;
      }
      if (args.requireTarget && !stepMatches(before, args.targetStep)) {
        throw new Error(
          `Current Workday step ${
            before.currentStep?.title || "<unknown>"
          } does not match required target ${args.targetStep || "<empty>"}`,
        );
      }
      if (args.stopAtTarget && stepMatches(before, args.targetStep)) {
        timeline.push({
          pageIndex: i + 1,
          stoppedAtTarget: true,
          before: {
            href: before.href,
            currentStep: before.currentStep,
            hasNext: before.hasNext,
            hasSubmit: before.hasSubmit,
            errors: before.errors,
            fields: before.fields,
            remainingValues: before.remainingValues,
          },
        });
        if (startStep && !startStep.skipped) {
          timeline[timeline.length - 1].startStep = startStep;
        }
        break;
      }
      const prefillClear = args.clearRepeatableSections
        ? await clearRepeatableWorkdaySections(pageClient)
        : null;
      const pageClear = args.clearBeforeFill
        ? await clearPageUntilStable(optionsClient, pageClient, applyUrl, before)
        : null;
      const fills = [];
      let afterFill = before;
      for (let fillIndex = 0; fillIndex < args.fillsPerPage; fillIndex += 1) {
        const remainingPageMs =
          PAGE_FILL_AND_NEXT_TIMEOUT_MS - (Date.now() - pagePhaseStartedAt);
        if (remainingPageMs <= 0) {
          audit.reason = "page_fill_and_next_timeout";
          audit.message =
            "Current Workday page did not finish filling and advance within the 1 minute timeout.";
          break pageLoop;
        }
        if (args.extensionAutoNext) {
          await setExtensionAutoNext(
            optionsClient,
            fillIndex === args.fillsPerPage - 1,
          );
        }
        let fill = null;
        try {
          fill = await withApplicationPhaseTimeout(
            "page_fill_and_next",
            remainingPageMs,
            () => fillCurrentPage(optionsClient, applyUrl, args, before),
          );
        } catch (error) {
          if (!(error instanceof PhaseTimeoutError)) {
            throw error;
          }
          const reconciliation = await reconcilePageFillTimeoutToReview(
            pageClient,
          );
          afterFill = reconciliation.page;
          if (reconciliation.reachedReview) {
            timeline.push({
              pageIndex: i + 1,
              workflowPhase: "job_fill",
              reason: "timeout_reconciled_to_review",
              before: {
                href: before.href,
                currentStep: before.currentStep,
                pageKind: before.pageKind,
                hasNext: before.hasNext,
                hasSubmit: before.hasSubmit,
                errors: before.errors,
              },
              afterFill: {
                href: afterFill.href,
                currentStep: afterFill.currentStep,
                pageKind: afterFill.pageKind,
                hasNext: afterFill.hasNext,
                hasSubmit: afterFill.hasSubmit,
                errors: afterFill.errors,
              },
            });
            break pageLoop;
          }
          const fillSummary = {
            ok: false,
            error: "page_fill_and_next_timeout",
            status: "timeout",
            summary:
              "Current Workday page did not finish filling and advance within the 1 minute timeout.",
            filledFieldCount: 0,
            pendingLlmFieldCount: 0,
            manualReviewReasons: ["page_fill_and_next_timeout"],
            bestEffortWarnings: ["page_fill_and_next_timeout"],
            filledFields: [],
            generatedAnswers: [],
            fieldInventory: [],
            nextAction: null,
            siteActions: [],
            v2AuditSummary: null,
            unfilledRequired: [],
            phoneCountryCodeTrace: [],
            interactionTrace: [],
          };
          audit.pages.push(
            buildFillAudit({
              pageIndex: i + 1,
              fillIndex: fillIndex + 1,
              before,
              afterFill,
              fillSummary,
            }),
          );
          audit.reason = "page_fill_and_next_timeout";
          audit.message = fillSummary.summary;
          break pageLoop;
        }
        const fillSummary = summarizeFill(fill);
        if (fillSummary.manualReviewReasons.includes("fill_timeout")) {
          afterFill = await inspectPage(pageClient);
          fills.push({
            fillIndex: fillIndex + 1,
            fill: fillSummary,
            afterFill: {
              href: afterFill.href,
              currentStep: afterFill.currentStep,
              hasNext: afterFill.hasNext,
              hasSubmit: afterFill.hasSubmit,
              errors: afterFill.errors,
              suppressedErrors: afterFill.suppressedErrors || [],
              fields: afterFill.fields,
              remainingValues: afterFill.remainingValues,
            },
          });
          audit.pages.push(
            buildFillAudit({
              pageIndex: i + 1,
              fillIndex: fillIndex + 1,
              before,
              afterFill,
              fillSummary,
            }),
          );
          break;
        }
        afterFill = await waitForPostFillSettle(pageClient, before, {
          args,
          fillSummary,
          optionsClient,
          applyUrl,
        });
        if (afterFill.workdayRuntimeError) {
          fillSummary.runtimeRecovery = await recoverWorkdayRuntimeError(
            pageClient,
            "after_fill_workday_runtime_error",
          );
          if (fillSummary.runtimeRecovery.ok) {
            afterFill = await inspectPage(pageClient);
          }
        }
        afterFill = await suppressStaleWorkdayDateErrors(afterFill);
        fills.push({
          fillIndex: fillIndex + 1,
          fill: fillSummary,
          afterFill: {
            href: afterFill.href,
            currentStep: afterFill.currentStep,
            hasNext: afterFill.hasNext,
            hasSubmit: afterFill.hasSubmit,
            errors: afterFill.errors,
            suppressedErrors: afterFill.suppressedErrors || [],
            fields: afterFill.fields,
            remainingValues: afterFill.remainingValues,
          },
        });
        audit.pages.push(
          buildFillAudit({
            pageIndex: i + 1,
            fillIndex: fillIndex + 1,
            before,
            afterFill,
            fillSummary,
          }),
        );
        if (args.verifyClear) {
          const clear = await clearCurrentPage(optionsClient, applyUrl, afterFill);
          await sleep(1800);
          const afterClear = await inspectPage(pageClient);
          const refill = await fillCurrentPage(
            optionsClient,
            applyUrl,
            args,
            afterClear,
          );
          await sleep(1800);
          afterFill = await inspectPage(pageClient);
          fills[fills.length - 1].clear = clear;
          fills[fills.length - 1].afterClear = {
            href: afterClear.href,
            currentStep: afterClear.currentStep,
            errors: afterClear.errors,
            remainingValues: afterClear.remainingValues,
          };
          fills[fills.length - 1].refill = summarizeFill(refill);
          fills[fills.length - 1].afterRefill = {
            href: afterFill.href,
            currentStep: afterFill.currentStep,
            hasNext: afterFill.hasNext,
            hasSubmit: afterFill.hasSubmit,
            errors: afterFill.errors,
            fields: afterFill.fields,
            remainingValues: afterFill.remainingValues,
          };
          audit.pages.push(
            buildFillAudit({
              pageIndex: i + 1,
              fillIndex: `${fillIndex + 1}.refill`,
              before: afterClear,
              afterFill,
              fillSummary: fills[fills.length - 1].refill,
            }),
          );
        }
      }
      timeline.push({
        pageIndex: i + 1,
        workflowPhase: "job_fill",
        startStep: i === 0 && !startStep.skipped ? startStep : null,
        applyEntry: i === 0 && !applyEntry.skipped ? applyEntry : null,
        before: {
          href: before.href,
          currentStep: before.currentStep,
          hasNext: before.hasNext,
          hasSubmit: before.hasSubmit,
          errors: before.errors,
        },
        fill: fills[0]?.fill || null,
        prefillClear,
        pageClear,
        fills,
        afterFill: {
          href: afterFill.href,
          currentStep: afterFill.currentStep,
          hasNext: afterFill.hasNext,
          hasSubmit: afterFill.hasSubmit,
          pageKind: afterFill.pageKind,
          errors: afterFill.errors,
          suppressedErrors: afterFill.suppressedErrors || [],
          fields: afterFill.fields,
          remainingValues: afterFill.remainingValues,
        },
      });

      if (args.stopAfterFill) {
        break;
      }
      if (args.targetStep && stepMatches(afterFill, args.targetStep)) {
        break;
      }
      if (authVerificationErrors(afterFill.errors || []).length) {
        const authVerification = await resolveAuthVerificationViaMail(
          pageClient,
          args,
          { applyUrl },
        );
        timeline[timeline.length - 1].authVerification = authVerification;
        if (!authVerification.ok) {
          break;
        }
        await sleep(1800);
        continue;
      }
      if (
        afterFill.hasSubmit ||
        pageReachedReview(afterFill)
      ) {
        break;
      }
      if (looksLikeAuthPage(afterFill)) {
        const authRoute = routeAfterSignupAttempt(
          await withApplicationPhaseTimeout("identifier", IDENTIFIER_TIMEOUT_MS, () =>
            workflowIdentifier.identify(IDENTIFIER_TIMEOUT_MS),
          ),
        );
          const authNext = await withApplicationPhaseTimeout(
            "auth",
            AUTH_WORKFLOW_TIMEOUT_MS,
            () => authWorkflow.clickPrimary(authRoute),
          );
        noteSignupAttempt(authRoute);
        timeline[timeline.length - 1].authNext = authNext;
        if (
          authNext.reason === "auth_verification_required" ||
          authVerificationErrors(authNext.after?.errors || []).length
        ) {
            const authVerification = await withApplicationPhaseTimeout(
              "auth",
              AUTH_WORKFLOW_TIMEOUT_MS,
              () =>
                resolveAuthVerificationViaMail(pageClient, args, { applyUrl }),
            );
          timeline[timeline.length - 1].authVerification = authVerification;
          if (!authVerification.ok) {
            break;
          }
          await sleep(1800);
          continue;
        }
        if (!authNext.clicked) {
          break;
        }
        const returnUrl = authReturnUrl(authNext.after?.href, applyUrl);
        if (returnUrl) {
          timeline[timeline.length - 1].authReturnUrl = returnUrl;
          await navigate(pageClient, returnUrl, () =>
            workflowIdentifier.waitForReady(AUTH_WORKFLOW_TIMEOUT_MS),
          );
          await sleep(1200);
          continue;
        }
        await sleep(1800);
        continue;
      }
      if (args.extensionAutoNext) {
        const fillAdvancedPage =
          (afterFill.currentStep?.current ?? 0) >
          (before.currentStep?.current ?? 0);
        if (fillAdvancedPage) {
          timeline[timeline.length - 1].next = {
            clicked: Boolean(fills.at(-1)?.fill?.nextAction?.clicked),
            auto: true,
            reason: "fill_already_advanced_page",
            message: `Fill advanced from step ${before.currentStep?.current} to step ${afterFill.currentStep?.current}; continuing so the new Workday step can be filled.`,
            errors: afterFill.errors?.slice(0, 10) || [],
          };
          await sleep(250);
          continue;
        }
        if (afterFill.errors?.length) {
          timeline[timeline.length - 1].next = {
            clicked: false,
            auto: true,
            reason: "visible_validation_errors",
            message: "Workday is showing validation errors after fill.",
            errors: afterFill.errors.slice(0, 10),
          };
          break;
        }
        timeline[timeline.length - 1].next = {
          clicked: Boolean(fills.at(-1)?.fill?.nextAction?.clicked),
          auto: true,
          reason:
            fills.at(-1)?.fill?.nextAction?.reason ||
            "extension_auto_next_enabled",
          message:
            fills.at(-1)?.fill?.nextAction?.message ||
            "C3 extension safe auto-next handled this page.",
        };
        if (!fills.at(-1)?.fill?.nextAction?.clicked && afterFill.hasNext) {
          const latestFill = fills.at(-1)?.fill || {};
          const fillNeedsReview =
            latestFill.manualReviewReasons?.length > 0;
          if (!fillNeedsReview || afterFill.errors?.length) {
            break;
          }
          if (!fillDidUsefulWork(latestFill) || fillHasNoProgressReason(latestFill)) {
            timeline[timeline.length - 1].next = {
              clicked: false,
              auto: true,
              reason: "fill_not_ready_for_next_no_progress",
              message:
                "Next skipped because fill reported manual-review/no-progress without filled fields.",
              manualReviewReasons: latestFill.manualReviewReasons || [],
              filledFieldCount: latestFill.filledFieldCount || 0,
            };
            break;
          }
          const remainingNextMs =
            PAGE_FILL_AND_NEXT_TIMEOUT_MS - (Date.now() - pagePhaseStartedAt);
          if (remainingNextMs <= 0) {
            audit.reason = "page_fill_and_next_timeout";
            audit.message =
              "Current Workday page did not finish filling and advance within the 1 minute timeout.";
            break pageLoop;
          }
          const next = await withApplicationPhaseTimeout(
            "page_fill_and_next",
            remainingNextMs,
            () => clickNext(pageClient),
          );
          if (next.workdayRuntimeError) {
            next.runtimeRecovery = await recoverWorkdayRuntimeError(
              pageClient,
              "forced_next_workday_runtime_error",
            );
          }
          timeline[timeline.length - 1].next = {
            ...next,
            auto: true,
            reason: next.clicked
              ? "forced_next_after_no_visible_errors"
              : next.reason || "fill_not_ready_for_next",
            message: next.clicked
              ? "Clicked Next despite fill manual-review status because Workday showed no visible validation errors. Review JSON warnings for correctness."
              : next.message || "Next remained unavailable.",
          };
          if (!next.clicked) {
            break;
          }
        }
        await sleep(1200);
        continue;
      }
      if (!afterFill.hasNext) {
        break;
      }
      // If the fill's own nextAction already advanced the page (e.g. Autofill with Resume
      // clicks Next internally, landing on My Information), skip the outer Next click so
      // the next loop iteration fills the intermediate page instead of skipping it.
      const fillAdvancedPage =
        (afterFill.currentStep?.current ?? 0) >
        (before.currentStep?.current ?? 0);
      if (fillAdvancedPage) {
        timeline[timeline.length - 1].next = {
          clicked: false,
          auto: false,
          reason: "fill_already_advanced_page",
          message: `Fill already advanced from step ${before.currentStep?.current} to step ${afterFill.currentStep?.current}; skipping outer Next click.`,
        };
        await sleep(1200);
        continue;
      }
      const remainingNextMs =
        PAGE_FILL_AND_NEXT_TIMEOUT_MS - (Date.now() - pagePhaseStartedAt);
      if (remainingNextMs <= 0) {
        audit.reason = "page_fill_and_next_timeout";
        audit.message =
          "Current Workday page did not finish filling and advance within the 1 minute timeout.";
        break;
      }
      const next = await withApplicationPhaseTimeout(
        "page_fill_and_next",
        remainingNextMs,
        () => clickNext(pageClient),
      );
      if (next.workdayRuntimeError) {
        next.runtimeRecovery = await recoverWorkdayRuntimeError(
          pageClient,
          "next_workday_runtime_error",
        );
      }
      timeline[timeline.length - 1].next = next;
      if (!next.clicked) {
        break;
      }
      await sleep(1200);
    }

    const finalPage = await inspectPage(pageClient);
    const finalAuthVerificationErrors = authVerificationErrors(
      finalPage.errors || [],
    );
    const finalReachedReview =
      pageReachedReview(finalPage) && !pageHasBlockingValidation(finalPage);
    const finalMaintenance =
      finalPage.pageKind === "maintenance" ||
      /community\.workday\.com\/maintenance-page/i.test(finalPage.href || "");
    const terminalReason = finalReachedReview
      ? ""
      : finalMaintenance
      ? "site_or_posting_state"
      : audit.reason
      ? audit.reason
      : finalAuthVerificationErrors.length
      ? "auth_verification_required"
      : !args.stopAfterFill && !args.targetStep && !finalReachedReview
        ? finalPage.hasNext
          ? "max_pages_before_terminal"
          : "stuck_before_review"
        : "";
    if (finalReachedReview) {
      delete audit.reason;
      delete audit.message;
    } else if (finalMaintenance) {
      audit.message = "Workday maintenance page reached.";
    }
    audit.ok = !terminalReason;
    if (terminalReason) {
      audit.reason = terminalReason;
      audit.message = audit.message ||
        finalAuthVerificationErrors[0] ||
        (finalPage.hasNext
          ? "Smoke ended before reaching Review or Submit while a Next button was still available."
          : "Smoke ended before reaching Review or Submit and no safe Next button was available.");
    }
    audit.finishedAt = new Date().toISOString();
    audit.final = {
      href: finalPage.href,
      currentStep: finalPage.currentStep,
      pageKind: finalPage.pageKind,
      hasSubmit: finalPage.hasSubmit,
      hasNext: finalPage.hasNext,
      errors: finalPage.errors,
    };
    const auditPath = writeAuditJson(args.auditJson, audit);
    const issueRegistry = recordAuditIssues({
      audit,
      auditPath: auditPath || args.auditJson || "",
    });
    console.log(
      JSON.stringify(
        {
          ok: audit.ok,
          mode: args.mode,
          applyUrl,
          auditJson: auditPath,
          issueRegistry,
          ...(terminalReason
            ? { reason: terminalReason, message: audit.message }
            : {}),
          final: {
            href: finalPage.href,
            currentStep: finalPage.currentStep,
            pageKind: finalPage.pageKind,
            hasSubmit: finalPage.hasSubmit,
            hasNext: finalPage.hasNext,
            errors: finalPage.errors,
          },
          timeline,
        },
        null,
        2,
      ),
    );
  } finally {
    optionsClient.close();
    pageClient.close();
  }
}

run().catch((error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(message);
  if (error instanceof PhaseTimeoutError) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: error.reason,
          message: error.message,
          phase: error.phase,
          timeoutMs: error.timeoutMs,
        },
        null,
        2,
      ),
    );
  }
  if (/MAX_WRITE_OPERATIONS_PER_MINUTE/i.test(message)) {
    console.error(
      [
        "[c3][storage_quota][blocked] Chrome extension storage write quota was hit.",
        "Run one site at a time, avoid repeated setup writes, wait about a minute, and use --close-other-workday-tabs to remove stale Workday apply tabs before retrying.",
      ].join(" "),
    );
  }
  process.exit(1);
});
