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

function auditTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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
    cdpRepairPhoneCountry: false,
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
    } else if (arg === "--cdp-repair-phone-country") {
      args.cdpRepairPhoneCountry = true;
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
    "  --cdp-repair-phone-country Diagnostic only: patch phone country via CDP if extension fill fails",
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
  let target = targets.find((item) =>
    String(item.url || "").includes("/src/options/options.html"),
  );
  if (target) {
    return target;
  }
  const extensionId = findExtensionId(targets) || fallbackExtensionId;
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

function workdayPageKindExpression() {
  return `(() => {
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => normalize([
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.innerText,
      el?.textContent
    ].filter(Boolean).join(" "));
    const text = document.body ? document.body.innerText : "";
    const normalizedText = normalize(text);
    const buttons = [...document.querySelectorAll("button, [role='button'], a")]
      .filter(visible)
      .map((el) => textOf(el))
      .filter(Boolean);
    const fields = [...document.querySelectorAll("input:not([type='hidden']), textarea, select")]
      .filter((el) => el.name !== "website" && visible(el))
      .map((el) => ({
        id: el.id || "",
        name: el.name || "",
        type: el.type || "",
        autocomplete: el.autocomplete || "",
        placeholder: el.placeholder || "",
        label: el.getAttribute("aria-label") || ""
      }));
    const fieldText = (field) => [field.id, field.name, field.type, field.autocomplete, field.placeholder, field.label].join(" ");
    const hasEmailField = fields.some((field) => /email|username|user/i.test(fieldText(field)));
    const passwordCount = fields.filter((field) => field.type === "password").length;
    const currentStepNode = document.querySelector('[data-automation-id="progressBarActiveStep"]');
    const currentStepText = normalize(currentStepNode?.innerText || currentStepNode?.textContent || "");
    const hasButton = (pattern) => buttons.some((label) => pattern.test(label));
    const loadingNodes = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-automation-id*="loading" i], [class*="loading" i], [class*="spinner" i]')]
      .filter(visible);
    const hasClassificationSignal =
      buttons.length > 0 || fields.length > 0 || Boolean(currentStepText) || normalizedText.length > 80;
    const stillLoading =
      document.readyState !== "complete" ||
      (!hasClassificationSignal && normalizedText.length < 20) ||
      (loadingNodes.length > 0 && fields.length === 0 && !currentStepText);
    let pageKind = "unknown";
    if (stillLoading) pageKind = "loading";
    else if (/the page you are looking for (doesn't|does not) exist|page not found|job posting is no longer available|job is no longer available/i.test(normalizedText)) pageKind = "posting_not_found";
    else if (/workday is currently unavailable|service interruption/i.test(normalizedText)) pageKind = "maintenance";
    else if (/something went wrong/i.test(normalizedText) && /please refresh/i.test(normalizedText)) pageKind = "runtime_error";
    else if (hasEmailField && passwordCount > 1) pageKind = "signup_form";
    else if (hasEmailField && passwordCount === 1) pageKind = "signin_form";
    else if (hasButton(/^sign in with email\\b/i) || hasButton(/sign\\s*in\\s*with\\s*(google|apple)/i)) pageKind = "signin_choice";
    else if (/start your application/i.test(normalizedText) || hasButton(/^apply manually$/i) || hasButton(/^autofill with resume$/i)) pageKind = "apply_choice";
    else if (currentStepText && !/create account|sign in/i.test(currentStepText)) pageKind = "application_step";
    else if (/resume\\/cv|my information|my experience|application questions|voluntary disclosures|self identify|review/i.test(normalizedText)) pageKind = "application_step";
    else if (hasButton(/^apply\\b/i) || /job requisition id|posted on/i.test(normalizedText)) pageKind = "job_posting";
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      pageKind,
      stillLoading,
      fieldCount: fields.length,
      passwordCount,
      hasEmailField,
      buttonCount: buttons.length,
      currentStepText,
      loadingNodeCount: loadingNodes.length,
      bodyHead: normalizedText.slice(0, 800)
    };
  })()`;
}

async function inspectWorkdayPageKind(pageClient) {
  return pageClient.evaluate(workdayPageKindExpression(), 30000);
}

async function waitForWorkdayPageReady(pageClient, timeoutMs = 45000) {
  const started = Date.now();
  let last = null;
  let stableSince = 0;
  while (Date.now() - started < timeoutMs) {
    const state = await inspectWorkdayPageKind(pageClient);
    const key = `${state.href}|${state.pageKind}|${state.fieldCount}|${state.buttonCount}`;
    if (!state.stillLoading && state.pageKind !== "loading") {
      if (key === last?.key) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 700) {
          return { ...state, waitedMs: Date.now() - started };
        }
      } else {
        stableSince = Date.now();
      }
    }
    last = { key, state };
    await sleep(500);
  }
  return {
    ...(last?.state || { pageKind: "unknown", stillLoading: true }),
    timedOut: true,
    waitedMs: Date.now() - started,
  };
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

async function navigate(pageClient, applyUrl) {
  await pageClient.send("Page.enable");
  await pageClient.send("Page.navigate", { url: applyUrl });
  const readyState = await waitForWorkdayPageReady(pageClient);
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
    return {
      href: location.href,
      title: document.title,
      currentStep,
      hasSubmit: buttons.some((button) => /^submit$/i.test(button.text)),
      hasNext: buttons.some((button) => isSafeNextText(button.text) && !button.disabled),
      buttons,
      fields,
      remainingValues: {
        workdayButtons,
        selectedPills,
        filledNative
      },
      errors,
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

async function clickApplyManuallyEntry(pageClient) {
  const readyState = await waitForWorkdayPageReady(pageClient);
  if (readyState.stillLoading || readyState.pageKind === "loading") {
    return {
      ok: false,
      phase: "apply_entry",
      reason: "workday_page_still_loading",
      readyState,
    };
  }
  if (readyState.pageKind === "posting_not_found") {
    return {
      ok: false,
      phase: "apply_entry",
      reason: "posting_not_found",
      message: "Workday says this job posting page does not exist.",
      readyState,
    };
  }
  const result = await pageClient.evaluate(
    `(async () => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const bodyText = document.body ? document.body.innerText : "";
      const currentStep = document.querySelector('[data-automation-id="progressBarActiveStep"]')
        || bodyText.match(/current\\s+s?tep\\s+\\d+\\s+of\\s+\\d+[^\\n]*/i);
      const currentStepText = normalize(currentStep?.innerText || currentStep?.textContent || currentStep?.[0] || "");
      if (currentStep && !/create account|sign in|log in|login|register|sign up/i.test(currentStepText)) {
        return {
          ok: true,
          skipped: true,
          phase: "apply_entry",
          reason: "already_on_application_step",
          href: location.href,
        };
      }
      if (currentStep) {
        return {
          ok: true,
          skipped: true,
          phase: "apply_entry",
          reason: "already_on_auth_step",
          href: location.href,
          currentStep: currentStepText,
        };
      }
      if (!/Start Your Application/i.test(bodyText)) {
        return {
          ok: true,
          skipped: true,
          phase: "apply_entry",
          reason: "not_on_start_application_page",
          href: location.href,
        };
      }
      const candidates = [...document.querySelectorAll("a, button, [role='button']")]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            el,
            text: normalize([el.getAttribute("aria-label"), el.innerText, el.textContent].filter(Boolean).join(" ")),
            href: el.href || "",
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        });
      const candidate = candidates.find((item) => /^Apply Manually$/i.test(item.text))
        || candidates.find((item) => /\\/apply\\/applyManually/i.test(item.href));
      if (!candidate) {
        return {
          ok: false,
          phase: "apply_entry",
          reason: "apply_manually_not_found",
          href: location.href,
          candidates: candidates.map((item) => item.text || item.href).filter(Boolean).slice(0, 30),
        };
      }
      return {
        ok: true,
        phase: "apply_entry",
        clicked: true,
        label: candidate.text || "Apply Manually",
        href: candidate.href || "",
        x: candidate.x,
        y: candidate.y,
        reason: candidate.href ? "apply_manually_href_found" : "apply_manually_button_found",
      };
    })()`,
    30000,
  );
  if (result?.ok) {
    if (!result.skipped && result.href) {
      await navigate(pageClient, result.href);
    } else if (!result.skipped && result.x != null && result.y != null) {
      await cdpClick(pageClient, result.x, result.y);
      await waitForWorkdayPageReady(pageClient);
    }
    if (result.skipped) {
      return result;
    }
    const after = await pageClient.evaluate(
      `(() => {
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const text = document.body ? document.body.innerText : "";
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
        return {
          href: location.href,
          currentStep,
        };
      })()`,
      10000,
    );
    return {
      ...result,
      ok: Boolean(after?.currentStep),
      href: after?.href || result.href || "",
      currentStep: after?.currentStep || null,
      reason: after?.currentStep
        ? "apply_manually_clicked"
        : "application_step_not_reached",
    };
  }
  return (
    result || {
      ok: false,
      phase: "apply_entry",
      reason: "apply_entry_detection_failed",
    }
  );
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

async function cdpArrowDownEnter(client, presses) {
  for (let i = 0; i < presses; i++) {
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 200));
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
}

async function cdpKey(client, key, code, virtualKeyCode, modifiers = 0) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    modifiers,
  });
}

async function cdpTypeText(client, text) {
  await client.send("Input.insertText", { text: String(text || "") });
}

async function checkPhoneCountryCommitted(pageClient) {
  return pageClient.evaluate(
    `(() => {
      function hasCanada(el) {
        var t = ((el && (el.innerText || el.textContent)) || "").toLowerCase().replace(/\\s+/g, " ");
        return t.includes("canada") && (t.includes("+1") || t.includes("(+1)"));
      }
      var input = document.getElementById("phoneNumber--countryPhoneCode");
      if (input) {
        var node = input;
        for (var i = 0; i < 10 && node; i++) {
          node = node.parentElement;
          if (node && hasCanada(node)) return true;
        }
      }
      var checked = document.querySelector('[aria-label*="Canada"][aria-checked="true"], [aria-label*="Canada"][aria-selected="true"]');
      if (checked) return true;
      var chips = Array.from(document.querySelectorAll('[data-automation-id*="country"], [class*="chip"], [class*="tag"], [class*="pill"]'));
      if (chips.some(hasCanada)) return true;
      return false;
    })()`,
    5000,
  );
}

async function tryFixPhoneCountryCodeViaCdp(pageClient) {
  try {
    await pageClient.send("Page.bringToFront", {});
    // Get the country code input's viewport coords to open the dropdown.
    const inputCoords = await pageClient.evaluate(
      `(() => {
        var input = document.getElementById("phoneNumber--countryPhoneCode");
        if (!input) return null;
        var rect = input.getBoundingClientRect();
        if (!rect || rect.width === 0) return null;
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`,
      3000,
    );
    if (!inputCoords || !inputCoords.x) {
      process.stderr.write("[phoneCountryFix] input not found\n");
      return false;
    }

    // Attempt 1: CDP click to open, scroll to exact Canada, then click
    // the row radio. Plain ArrowDown/Enter can commit the wrong country.
    await cdpClick(pageClient, inputCoords.x, inputCoords.y);
    await sleep(500);
    const canadaTarget = await pageClient.evaluate(
      `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
        const input = document.getElementById("phoneNumber--countryPhoneCode");
        if (!input) return { ok: false, reason: "phone_input_not_found" };
        input.focus();
        const listboxForOptions = () => [...document.querySelectorAll('[data-automation-id="activeListContainer"], [data-automation-id="promptSearchResultList"], [role="listbox"]')]
          .filter(visible)
          .sort((a, b) => Math.max(0, b.scrollHeight - b.clientHeight) - Math.max(0, a.scrollHeight - a.clientHeight))[0] || null;
        const inListViewport = (option, listbox) => {
          if (!option || !listbox) return true;
          const rect = option.getBoundingClientRect();
          const listRect = listbox.getBoundingClientRect();
          return rect.bottom > listRect.top && rect.top < listRect.bottom && rect.right > listRect.left && rect.left < listRect.right;
        };
        const canadaOption = () => {
          const listbox = listboxForOptions();
          const options = [...document.querySelectorAll('[role="option"]')]
            .filter(visible)
            .filter((option) => inListViewport(option, listbox))
            .map((option) => ({ option, text: textOf(option) }));
          const match = options.find((item) => /canada/i.test(item.text) && /(\\+1|\\(\\+1\\))/.test(item.text));
          return { match, listbox, options: options.slice(0, 12).map((item) => item.text) };
        };
        let state = canadaOption();
        let attempts = 0;
        while (!state.match && state.listbox && attempts < 80 && state.listbox.scrollHeight > state.listbox.clientHeight + 2) {
          attempts += 1;
          state.listbox.scrollTop += 260;
          state.listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
          await sleep(70);
          state = canadaOption();
        }
        if (!state.match) {
          return { ok: false, reason: "canada_option_not_found", attempts, options: state.options || [] };
        }
        const option = state.match.option;
        const radio = option.querySelector('input[data-automation-id="radioBtn"], input[type="radio"], [role="radio"]');
        const target = radio && visible(radio) ? radio : option;
        const rect = target.getBoundingClientRect();
        return {
          ok: true,
          reason: "canada_radio_target_found",
          attempts,
          text: state.match.text,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          targetAutomationId: target.getAttribute("data-automation-id") || "",
          options: state.options || []
        };
      })()`,
      15000,
    );
    if (canadaTarget?.ok) {
      await cdpClick(pageClient, canadaTarget.x, canadaTarget.y);
      await sleep(900);
      if (await checkPhoneCountryCommitted(pageClient)) {
        process.stderr.write(
          "[phoneCountryFix] committed via exact Canada radio click\n",
        );
        return true;
      }
    }
    // Attempt 2: reload the page. Workday often pre-fills the country code on reload.
    process.stderr.write(
      "[phoneCountryFix] exact Canada radio attempt failed; reloading page\n",
    );
    await pageClient.send("Page.reload", { ignoreCache: false });
    await new Promise((r) => setTimeout(r, 4000));
    if (await checkPhoneCountryCommitted(pageClient)) {
      process.stderr.write("[phoneCountryFix] committed after page reload\n");
      return true;
    }

    process.stderr.write("[phoneCountryFix] all attempts failed\n");
    return false;
  } catch (_e) {
    process.stderr.write("[phoneCountryFix] error: " + String(_e) + "\n");
    return false;
  }
}

async function tryFixWorkdayDateSectionsViaCdp(pageClient) {
  const fields = await pageClient.evaluate(
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
      };
      const controls = [...document.querySelectorAll('input[id*="dateSectionMonth"], input[id*="dateSectionDay"], input[id*="dateSectionYear"]')]
        .filter(visible)
        .map((input) => {
          input.scrollIntoView({ block: "center", inline: "center" });
          const rect = input.getBoundingClientRect();
          const id = input.id || "";
          let value = input.value || "";
          if (/dateSectionMonth/i.test(id)) value = value || "5";
          if (/dateSectionDay/i.test(id)) value = value || "25";
          if (/dateSectionYear/i.test(id)) value = value || "2026";
          return {
            id,
            label: input.getAttribute("aria-label") || "",
            value,
            beforeValue: input.value || "",
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        });
      return controls;
    })()`,
    10000,
  );
  if (!Array.isArray(fields) || fields.length === 0) {
    return { ok: false, reason: "date_section_fields_not_found" };
  }
  const attempts = [];
  for (const field of fields) {
    await cdpClick(pageClient, field.x, field.y);
    await sleep(80);
    await cdpKey(pageClient, "a", "KeyA", 65, 2);
    await sleep(40);
    await pageClient.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await pageClient.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await sleep(80);
    await cdpTypeText(pageClient, field.value);
    await sleep(80);
    await cdpKey(pageClient, "Tab", "Tab", 9);
    await sleep(180);
    const after = await pageClient.evaluate(
      `(() => {
        const input = document.getElementById(${JSON.stringify(field.id)});
        return input ? {
          id: input.id || "",
          value: input.value || "",
          invalid: input.getAttribute("aria-invalid") || ""
        } : null;
      })()`,
      5000,
    );
    attempts.push({ ...field, after });
  }
  await sleep(700);
  const state = await pageClient.evaluate(
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const errors = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [id*="error"], .css-1iucqxd')]
        .filter(visible)
        .map((el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 10);
      const values = [...document.querySelectorAll('input[id*="dateSectionMonth"], input[id*="dateSectionDay"], input[id*="dateSectionYear"]')]
        .filter(visible)
        .map((input) => ({ id: input.id || "", value: input.value || "", invalid: input.getAttribute("aria-invalid") || "" }));
      return { errors, values };
    })()`,
    10000,
  );
  const hasDateError = (state.errors || []).some((error) =>
    /desired start date|required and must have a value/i.test(error),
  );
  return {
    ok: !hasDateError,
    reason: hasDateError
      ? "date_section_still_has_validation_error"
      : "date_section_keyboard_committed",
    attempts,
    state,
  };
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
    return 300000;
  }
  return 120000;
}

async function fillCurrentPage(optionsClient, applyUrl, args) {
  const messageTimeoutMs = fillMessageTimeoutMs(args);
  const evaluateTimeoutMs = messageTimeoutMs + 10000;
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const applyUrl = ${JSON.stringify(applyUrl)};
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
      const candidates = exactCandidates.concat(broadCandidates, loginRedirectCandidates);
      const deduped = [...new Map(candidates.map((item) => [item.id, item])).values()];
      const sortedExact = exactCandidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const sortedLoginRedirect = loginRedirectCandidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const sortedBroad = deduped.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      let tab = sortedExact.find((item) => item.active)
        || sortedExact[0]
        || sortedLoginRedirect.find((item) => item.active)
        || sortedLoginRedirect[0]
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

async function tryFixWorkdaySourceViaKeyboard(pageClient) {
  function isUnsafeSourceText(text) {
    return /\b(referr?al|referred|refer|connection)\b/i.test(String(text || ""));
  }

  async function dispatchKey(key, code) {
    await pageClient.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
    await pageClient.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    });
  }
  async function sourceKeyboardState() {
    return pageClient.evaluate(
      `(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
        const labelOf = (el) => [el?.getAttribute?.("aria-label"), textOf(el)].filter(Boolean).join(" ");
        const input = document.getElementById("source--source") || document.querySelector('input[data-uxi-widget-type="selectinput"]');
        const container = input?.closest?.('[data-automation-id="formField"], [data-automation-id="formField-source"]') || input?.parentElement;
        const text = textOf(container);
        const selected = [...(container?.querySelectorAll?.('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"], [aria-label*="press delete"]') || [])]
          .filter(visible)
          .map((el) => [el.getAttribute("aria-label"), textOf(el)].filter(Boolean).join(" "))
          .join(" ")
          .replace(/\\s+/g, " ")
          .trim();
        const options = [...document.querySelectorAll('[role="option"], [data-automation-id="menuItem"]')]
          .filter(visible)
          .map((el) => ({
            text: textOf(el),
            aria: el.getAttribute("aria-label") || "",
            label: labelOf(el),
            selected: el.getAttribute("aria-selected") || ""
          }))
          .filter((option) => /campus|career|employee referral|event|job alert|job board|job sites?|social|industry/i.test(option.label))
          .slice(0, 30);
        const highlighted = options.find((option) => option.selected === "true") || null;
        const selectedByCount = /\\b[1-9]\\d*\\s+items?\\s+selected\\b/i.test(text);
        const selectedByLabel = selected && !/^expanded$/i.test(selected) && !/^search$/i.test(selected);
        const unsafe = /\\b(referr?al|referred|refer|connection)\\b/i.test(selected || text);
        return {
          text,
          selected,
          unsafe,
          selectedOk: Boolean((selectedByCount || selectedByLabel) && !unsafe),
          highlighted,
          options
        };
      })()`,
      20000,
    );
  }
  const target = await pageClient.evaluate(
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
      };
      const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
      const isUnsafeSource = (value) => /\\b(referr?al|referred|refer|connection)\\b/i.test(String(value || ""));
      const hasAnySelection = (input) => {
        const container = input.closest('[data-automation-id="formField"], [data-automation-id="formField-source"]') || input.parentElement;
        const text = textOf(container);
        const selected = [...(container?.querySelectorAll?.('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"], [aria-label*="press delete"]') || [])]
          .map((el) => [el.getAttribute("aria-label"), textOf(el)].filter(Boolean).join(" "))
          .join(" ")
          .replace(/\\s+/g, " ")
          .trim();
        if (isUnsafeSource(selected || text)) {
          return false;
        }
        return /\\b[1-9]\\d*\\s+items?\\s+selected\\b/i.test(text) || (selected && !/^expanded$/i.test(selected) && !/^search$/i.test(selected));
      };
      const clearUnsafeSelection = (input) => {
        const container = input.closest('[data-automation-id="formField"], [data-automation-id="formField-source"]') || input.parentElement;
        const selected = [...(container?.querySelectorAll?.('[data-automation-id="selectedItem"], [aria-label*="press delete"]') || [])]
          .find((el) => isUnsafeSource([el.getAttribute("aria-label"), textOf(el)].filter(Boolean).join(" ")));
        if (!selected) {
          return false;
        }
        selected.focus();
        selected.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", keyCode: 46, which: 46, bubbles: true, cancelable: true }));
        selected.dispatchEvent(new KeyboardEvent("keyup", { key: "Delete", code: "Delete", keyCode: 46, which: 46, bubbles: true, cancelable: true }));
        const deleteCharm = selected.querySelector('[data-automation-id="DELETE_charm"]') || selected;
        deleteCharm.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const input = document.getElementById("source--source") || [...document.querySelectorAll('input[data-automation-id="searchBox"], input[data-uxi-widget-type="selectinput"]')]
        .find((candidate) => /how did you hear about us|source/i.test(textOf(candidate.closest('[data-automation-id*="formField"], [role="group"]') || candidate.parentElement)));
      if (!input || !visible(input)) {
        return { ok: false, reason: "source_input_not_found" };
      }
      if (hasAnySelection(input)) {
        return { ok: true, reason: "source_already_selected" };
      }
      clearUnsafeSelection(input);
      input.scrollIntoView({ block: "center", inline: "center" });
      await sleep(250);
      const rect = input.getBoundingClientRect();
      return {
        ok: true,
        reason: "source_keyboard_target",
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };
    })()`,
    20000,
  );
  if (!target?.ok || target.reason === "source_already_selected") {
    return target;
  }
  await pageClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
  });
  await pageClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await pageClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(1200);
  const attempts = [{ step: "opened", ...(await sourceKeyboardState()) }];
  const clickedSafeTopLevel = await pageClient.evaluate(
    `(() => {
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
      const options = [...document.querySelectorAll('[role="option"], [data-automation-id="menuItem"]')].filter(visible);
      const unsafe = /\\b(referr?al|referred|refer|connection)\\b/i;
      const wanted = options.find((el) => /\\b(job sites?|job boards?)\\b/i.test(textOf(el)) && !unsafe.test(textOf(el)))
        || options.find((el) => /\\bcareer websites?\\b/i.test(textOf(el)) && !unsafe.test(textOf(el)));
      if (!wanted) return { ok: false, reason: "safe_source_category_not_found", labels: options.map(textOf).slice(0, 20) };
      wanted.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = wanted.getBoundingClientRect();
      return { ok: true, label: textOf(wanted), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`,
    20000,
  );
  if (clickedSafeTopLevel?.ok) {
    attempts.push({ step: "safe_category_target", ...clickedSafeTopLevel });
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: clickedSafeTopLevel.x,
      y: clickedSafeTopLevel.y,
    });
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clickedSafeTopLevel.x,
      y: clickedSafeTopLevel.y,
      button: "left",
      clickCount: 1,
    });
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clickedSafeTopLevel.x,
      y: clickedSafeTopLevel.y,
      button: "left",
      clickCount: 1,
    });
    await sleep(1600);
    attempts.push({ step: "safe_children_loaded", ...(await sourceKeyboardState()) });
    await dispatchKey("Enter", 13);
    await sleep(900);
    const finalState = await sourceKeyboardState();
    attempts.push({ step: "safe_child_selected", ...finalState });
    if (finalState.selectedOk) {
      return { ok: true, reason: "source_keyboard_selected", attempts };
    }
  }
  // Workday source prompts use native keyboard state: synthetic DOM key events
  // can leave focus on the wrong prompt. In p Chrome, real CDP key events match
  // the manual flow: ArrowDown to Job Board, Enter to load children, Enter to
  // commit the first child such as Industry Job Board.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await sourceKeyboardState();
    attempts.push({ step: "category_scan", attempt: attempt + 1, ...state });
    if (/job sites?|job board/i.test(state.highlighted?.label || "") && !isUnsafeSourceText(state.highlighted?.label || "")) {
      break;
    }
    await dispatchKey("ArrowDown", 40);
    await sleep(160);
  }
  await dispatchKey("Enter", 13);
  await sleep(1600);
  attempts.push({ step: "children_loaded", ...(await sourceKeyboardState()) });
  await dispatchKey("Enter", 13);
  await sleep(900);
  const finalState = await sourceKeyboardState();
  attempts.push({ step: "child_selected", ...finalState });
  if (finalState.selectedOk) {
    return {
      ok: true,
      reason: "source_keyboard_selected",
      attempts,
    };
  }
  return {
    ok: false,
    reason: "source_keyboard_not_selected",
    attempts,
  };
}

async function tryFixWorkdayRequiredSearchInputsViaKeyboard(
  pageClient,
  fields,
) {
  const requestedFields = (fields || [])
    .map((field) => ({
      id: field.id || "",
      name: field.name || "",
      descriptor: field.descriptor || "",
    }))
    .filter((field) => field.id || field.name || field.descriptor);
  if (!requestedFields.length) {
    return { ok: true, skipped: true, reason: "no_required_search_inputs" };
  }
  const repairs = [];
  for (const field of requestedFields) {
    const fieldText = [field.id, field.name, field.descriptor]
      .filter(Boolean)
      .join(" ");
    const isCitizenshipField = /citizenship/i.test(fieldText);
    const isPhoneCountryCodeField =
      /country\s*phone\s*code/i.test(fieldText) ||
      /countryphonecode/i.test(fieldText);
    const desiredSearchText = isPhoneCountryCodeField ? "Canada" : "";
    const target = await pageClient.evaluate(
      `(() => {
        const wanted = ${JSON.stringify(field)};
        const desiredSearchText = ${JSON.stringify(desiredSearchText)};
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
        const isSearchInput = (el) => el?.tagName === "INPUT"
          && (el.getAttribute("data-automation-id") === "searchBox"
            || /selectinput|multiselect/i.test(el.getAttribute("data-uxi-widget-type") || "")
            || el.getAttribute("role") === "combobox"
            || el.getAttribute("aria-autocomplete") === "list");
        const hasAnySelection = (input) => {
          const container = input.closest('[data-automation-id="formField"], [data-automation-id*="formField"], [role="group"]') || input.parentElement;
          const text = textOf(container);
          const selected = [...(container?.querySelectorAll?.('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"], [aria-label*="press delete"]') || [])]
            .map((el) => [el.getAttribute("aria-label"), textOf(el)].filter(Boolean).join(" "))
            .join(" ")
            .replace(/\\s+/g, " ")
            .trim();
          const selectedText = [text, selected, input.value].filter(Boolean).join(" ").toLowerCase();
          if (desiredSearchText && !selectedText.includes(desiredSearchText.toLowerCase())) {
            return false;
          }
          return /\\b[1-9]\\d*\\s+items?\\s+selected\\b/i.test(text)
            || (selected && !/^expanded$/i.test(selected) && !/^search$/i.test(selected))
            || Boolean(String(input.value || "").trim());
        };
        const wantedText = [wanted.id, wanted.name, wanted.descriptor].filter(Boolean).join(" ").toLowerCase();
        const candidates = [...document.querySelectorAll("input")]
          .filter((input) => visible(input) && isSearchInput(input))
          .map((input) => {
            const container = input.closest('[data-automation-id="formField"], [data-automation-id*="formField"], [role="group"]') || input.parentElement;
            const haystack = [
              input.id,
              input.name,
              input.getAttribute("aria-label"),
              input.getAttribute("placeholder"),
              textOf(container)
            ].filter(Boolean).join(" ").toLowerCase();
            let score = 0;
            if (wanted.id && input.id === wanted.id) score += 1000;
            if (wanted.name && input.name === wanted.name) score += 700;
            wantedText.split(/\\s+/).filter((piece) => piece.length > 3).forEach((piece) => {
              if (haystack.includes(piece)) score += 5;
            });
            return { input, score, haystack };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);
        const item = candidates[0];
        if (!item) {
          return { ok: false, reason: "required_search_input_not_found", field: wanted };
        }
        if (hasAnySelection(item.input)) {
          return { ok: true, reason: "required_search_input_already_selected", field: wanted };
        }
        item.input.scrollIntoView({ block: "center", inline: "center" });
        const rect = item.input.getBoundingClientRect();
        return {
          ok: true,
          reason: "required_search_input_keyboard_target",
          field: wanted,
          id: item.input.id || "",
          score: item.score,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      })()`,
      20000,
    );
    if (
      !target?.ok ||
      target.reason === "required_search_input_already_selected"
    ) {
      repairs.push(target);
      continue;
    }
    if (isCitizenshipField || isPhoneCountryCodeField) {
      await pageClient.evaluate(
        `(() => {
          const input = document.getElementById(${JSON.stringify(field.id)});
          if (!input) return false;
          input.focus();
          try {
            input.setSelectionRange(0, String(input.value || "").length);
          } catch (_error) {}
          return true;
        })()`,
        5000,
      );
      await cdpKey(pageClient, "Backspace", "Backspace", 8);
      await sleep(250);
    }
    await cdpClick(pageClient, target.x, target.y);
    await sleep(350);
    if (desiredSearchText) {
      await cdpKey(pageClient, "a", "KeyA", 65, 2);
      await cdpKey(pageClient, "Backspace", "Backspace", 8);
      await sleep(100);
      await cdpTypeText(pageClient, desiredSearchText);
      await sleep(500);
    }
    if (isPhoneCountryCodeField) {
      const canadaOption = await pageClient.evaluate(
        `(() => {
          const input = document.getElementById(${JSON.stringify(target.id)});
          if (input) {
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (setter) setter.call(input, "Canada");
            else input.value = "Canada";
            input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Canada" }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const visible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
          const options = [...document.querySelectorAll('[role="option"], [data-automation-id="promptLeafNode"], [data-automation-id="promptOption"]')]
            .filter(visible)
            .map((el) => ({ el, text: textOf(el) }))
            .filter((item) => /canada/i.test(item.text) && /(\\+1|\\(\\+1\\))/.test(item.text));
          const item = options[0];
          if (!item) {
            return { ok: false, reason: "canada_option_not_found" };
          }
          item.el.scrollIntoView({ block: "center", inline: "center" });
          const rect = item.el.getBoundingClientRect();
          return {
            ok: true,
            reason: "canada_option_found",
            text: item.text,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        })()`,
        10000,
      );
      if (canadaOption?.ok) {
        await cdpClick(pageClient, canadaOption.x, canadaOption.y);
        await sleep(700);
        const committed = await checkPhoneCountryCommitted(pageClient);
        if (committed?.ok) {
          repairs.push({
            ok: true,
            reason: "required_search_input_keyboard_selected",
            target,
            attempts: [
              {
                attempt: 1,
                selectedOk: true,
                desiredOk: true,
                selected: committed.reason,
                options: [canadaOption.text],
              },
            ],
          });
          continue;
        }
      }
    }
    const attempts = [];
    const attemptCount = isCitizenshipField ? 1 : 8;
    for (let attempt = 0; attempt < attemptCount; attempt += 1) {
      if (isCitizenshipField) {
        await cdpArrowDownEnter(pageClient, 43);
      } else {
        await cdpKey(pageClient, "ArrowDown", "ArrowDown", 40);
        await sleep(100);
        await cdpKey(pageClient, "Enter", "Enter", 13);
      }
      await sleep(100);
      await sleep(550);
      const state = await pageClient.evaluate(
        `(() => {
          const input = document.getElementById(${JSON.stringify(target.id)});
          const visible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
          const container = input?.closest?.('[data-automation-id="formField"], [data-automation-id*="formField"], [role="group"]') || input?.parentElement;
          const text = textOf(container);
          const selected = [...(container?.querySelectorAll?.('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"], [aria-label*="press delete"]') || [])]
            .map((el) => [el.getAttribute("aria-label"), textOf(el)].filter(Boolean).join(" "))
            .join(" ")
            .replace(/\\s+/g, " ")
            .trim();
          const options = [...document.querySelectorAll('[role="option"], [data-automation-id="promptLeafNode"]')]
            .filter(visible)
            .map((el) => textOf(el))
            .filter(Boolean)
            .slice(0, 40);
          const selectedOk = /\\b[1-9]\\d*\\s+items?\\s+selected\\b/i.test(text)
            || (selected && !/^expanded$/i.test(selected) && !/^search$/i.test(selected))
            || Boolean(String(input?.value || "").trim());
          const desiredOk = ${JSON.stringify(
            desiredSearchText,
          )} ? [text, selected, input?.value || ""].join(" ").toLowerCase().includes(${JSON.stringify(
            desiredSearchText.toLowerCase(),
          )}) : true;
          return {
            text,
            inputValue: input?.value || "",
            selected,
            selectedOk: Boolean(selectedOk && desiredOk),
            desiredOk: Boolean(desiredOk),
            options
          };
        })()`,
        20000,
      );
      attempts.push({ attempt: attempt + 1, ...state });
      if (state.selectedOk) {
        repairs.push({
          ok: true,
          reason: "required_search_input_keyboard_selected",
          target,
          attempts,
        });
        break;
      }
    }
    if (!repairs.at(-1)?.ok || repairs.at(-1)?.target?.id !== target.id) {
      repairs.push({
        ok: false,
        reason: "required_search_input_keyboard_not_selected",
        target,
        attempts,
      });
    }
  }
  return {
    ok: repairs.some((repair) => repair?.ok),
    reason: repairs.some((repair) => repair?.ok)
      ? "required_search_keyboard_selected"
      : "required_search_keyboard_not_selected",
    repairs,
  };
}

async function clearCurrentPage(optionsClient, applyUrl) {
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const applyUrl = ${JSON.stringify(applyUrl)};
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
      const candidates = exactCandidates.concat(broadCandidates, loginRedirectCandidates);
      const deduped = [...new Map(candidates.map((item) => [item.id, item])).values()];
      const sortedExact = exactCandidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const sortedLoginRedirect = loginRedirectCandidates.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      const sortedBroad = deduped.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      let tab = sortedExact.find((item) => item.active)
        || sortedExact[0]
        || sortedLoginRedirect.find((item) => item.active)
        || sortedLoginRedirect[0]
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

async function clearPageUntilStable(optionsClient, pageClient, applyUrl) {
  const attempts = [];
  let previousRemaining = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 3; index += 1) {
    const clear = await clearCurrentPage(optionsClient, applyUrl);
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

async function clickAuthPrimary(pageClient) {
  const result = await pageClient.evaluate(
    `(async () => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
      };
      const rectFor = (target) => {
        target.scrollIntoView({ block: "center", inline: "center" });
        try { target.focus?.(); } catch (_error) {}
        const rect = target.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const labelFor = (el) => normalize([
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.value,
        el.innerText,
        el.textContent,
      ].filter(Boolean).join(" "));
      const metadataFor = (el) => normalize([
        el.id,
        el.name,
        el.type,
        el.getAttribute("data-automation-id"),
        el.getAttribute("data-testid"),
        el.className,
      ].filter(Boolean).join(" "));
      const bodyText = normalize(document.body?.innerText || "");
      const currentStepNode = document.querySelector('[data-automation-id="progressBarActiveStep"]');
      const currentStepText = normalize(currentStepNode?.innerText || currentStepNode?.textContent || bodyText.match(/current\\s+s?tep\\s+\\d+\\s+of\\s+\\d+[^\\n]*/i)?.[0] || "");
      const isAuthStep = /create account|sign in|log in|login|register|sign up/i.test(currentStepText)
        || /create account|verify new password|already have an account|career privacy notice/i.test(bodyText);
      if (!isAuthStep) {
        return { clicked: false, reason: "not_auth_step", currentStepText };
      }
      const checkboxCandidates = [...document.querySelectorAll('input[type="checkbox"]')]
        .filter(visible)
        .filter((checkbox) => {
          const text = normalize([
            labelFor(checkbox),
            metadataFor(checkbox),
            checkbox.closest("label")?.innerText,
            checkbox.closest('[data-automation-id], section, div')?.innerText,
          ].filter(Boolean).join(" "));
          return /privacy notice|terms|condition|consent|agree|acknowledge|continuing|create account/i.test(text);
        });
      const checked = [];
      for (const checkbox of checkboxCandidates) {
        const rect = rectFor(checkbox);
        checked.push({
          id: checkbox.id || "",
          automationId: checkbox.getAttribute("data-automation-id") || "",
          checked: Boolean(checkbox.checked),
          rect,
        });
      }
      const controls = [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .map((el) => {
          const label = labelFor(el);
          const metadata = metadataFor(el);
          const tag = String(el.tagName || "").toLowerCase();
          const type = String(el.getAttribute("type") || "").toLowerCase();
          let score = 0;
          if (/^create account(?: create account)?$/i.test(label)) score += 140;
          else if (/^sign in(?: sign in)?$/i.test(label)) score += 120;
          else if (/^submit$/i.test(label)) score += 110;
          else if (/create account|sign up|register|sign in|log in|login/i.test(label + " " + metadata)) score += 80;
          if (tag === "button" || type === "submit") score += 30;
          if (/submitbutton/i.test(metadata)) score += 25;
          if (/click_filter/i.test(metadata)) score -= 20;
          if (/utility|navigation|search for jobs|backtojobposting|forgotpassword/i.test(metadata)) score -= 80;
          return { el, label, metadata, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      if (!controls.length) {
        return { clicked: false, reason: "auth_primary_not_found", checked, currentStepText };
      }
      const target = controls[0];
      return {
        clicked: false,
        reason: "auth_primary_target_found",
        label: target.label,
        metadata: target.metadata,
        rect: rectFor(target.el),
        checked,
        href: location.href,
        title: document.title,
        bodyHead: normalize(document.body?.innerText || "").slice(0, 800),
      };
    })()`,
    30000,
  );
  if (result?.rect) {
    for (const checkbox of result.checked || []) {
      if (checkbox?.rect && !checkbox.checked) {
        await cdpClick(pageClient, checkbox.rect.x, checkbox.rect.y);
        await sleep(300);
      }
    }
    await cdpClick(pageClient, result.rect.x, result.rect.y);
    result.clicked = true;
    result.reason = "auth_primary_cdp_clicked";
  }
  await sleep(5500);
  await sleep(1200);
  const after = await inspectPage(pageClient);
  return { ...result, after };
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

function summarizeFill(fill) {
  const interactionTrace = fill.interactionTrace || [];
  const fieldInventory = Array.isArray(fill.fieldInventory)
    ? fill.fieldInventory
    : [];
  const v2Audit = fill.v2Audit || null;
  const v2SiteActions = Array.isArray(v2Audit?.events)
    ? v2Audit.events
        .filter((entry) =>
          [
            "site_state_before_field",
            "site_state_after_field",
            "workday_options_collected",
            "workday_option_click",
            "field_fill_result",
            "permanent_issue",
          ].includes(entry.action),
        )
        .map((entry) => ({
          index: entry.index,
          at: entry.at,
          action: entry.action,
          step: entry.step,
          status: entry.status,
          reason: entry.reason,
          fieldId: entry.fieldId || "",
          questionType: entry.questionType || "",
          uiModel: entry.uiModel || "",
          selectedOption: entry.selectedOption || "",
          detail: entry.detail || {},
        }))
    : [];
  const backgroundSiteActions = Array.isArray(fill.siteActions)
    ? fill.siteActions.map((entry) => ({
        at: entry.at || "",
        action: entry.action || "",
        status: entry.status || "",
        reason: entry.reason || "",
        siteState: entry.siteState || {},
      }))
    : [];
  const siteActions = [...backgroundSiteActions, ...v2SiteActions];
  const componentTrace = interactionTrace.filter((entry) =>
    ["hover", "click", "already_filled", "set_value"].includes(entry.action),
  );
  const phoneCountryCodeTrace = interactionTrace.filter((entry) => {
    const reason = String(entry.reason || "");
    const target = entry.target || {};
    return (
      reason.includes("phone_country_code") ||
      String(target.id || "").includes("countryPhoneCode") ||
      String(target.name || "").includes("countryPhoneCode") ||
      String(target.ariaLabel || "").includes("Country Phone Code")
    );
  });
  return {
    ok: fill.ok,
    error: fill.error,
    status: fill.status,
    summary: fill.summary,
    filledFieldCount: fill.filledFieldCount,
    pendingLlmFieldCount: fill.pendingLlmFieldCount,
    manualReviewReasons: fill.manualReviewReasons || [],
    bestEffortWarnings: fill.bestEffortWarnings || [],
    filledFields: (fill.filledFields || []).map((field) => ({
      field: field.field || "",
      descriptor: field.descriptor || field.field || "",
      id: field.id || "",
      name: field.name || "",
      tagName: field.tagName || "",
      type: field.type || "",
      value: field.value || "",
      selectedOption: field.selectedOption || "",
      valueSource: field.valueSource || "",
      bestEffortWarning: field.bestEffortWarning || "",
    })),
    generatedAnswers: (fill.generatedAnswers || []).map((answer) => ({
      questionHash: answer.questionHash || "",
      questionText: answer.questionText || "",
      answerText: answer.answerText || "",
      answerSource: answer.answerSource || "",
      confidence: answer.confidence || "",
      manualReviewRequired: Boolean(answer.manualReviewRequired),
    })),
    fieldInventory: fieldInventory.map((field) => ({
      kind: field.kind || "",
      tagName: field.tagName || "",
      type: field.type || "",
      id: field.id || "",
      name: field.name || "",
      descriptor: field.descriptor || "",
      required: Boolean(field.required),
      filled: Boolean(field.filled),
      skippedReason: field.skippedReason || "",
      valueSource: field.valueSource || "",
      bestEffortWarning: field.bestEffortWarning || "",
      options: field.options || [],
      questionHash: field.questionHash || "",
      questionType: field.questionType || "",
      uiModel: field.uiModel || "",
    })),
    nextAction: fill.nextAction || null,
    siteActions,
    v2AuditSummary: v2Audit
      ? {
          runId: v2Audit.runId || "",
          page: v2Audit.page || {},
          summary: v2Audit.summary || {},
          permanentIssues: v2Audit.permanentIssues || [],
        }
      : null,
    unfilledRequired: fieldInventory
      .filter((field) => field.required && !field.filled)
      .map((field) => ({
        tagName: field.tagName,
        type: field.type,
        id: field.id,
        name: field.name,
        descriptor: field.descriptor,
        skippedReason: field.skippedReason,
      }))
      .slice(0, 30),
    phoneCountryCodeTrace,
    interactionTrace: componentTrace.slice(0, 120),
  };
}

function buildFieldAudit(fillSummary) {
  const filledByKey = new Map();
  for (const field of fillSummary.filledFields || []) {
    const keys = [
      field.id && `id:${field.id}`,
      field.name && `name:${field.name}`,
      field.descriptor && `descriptor:${field.descriptor}`,
      field.field && `descriptor:${field.field}`,
    ].filter(Boolean);
    for (const key of keys) {
      if (!filledByKey.has(key)) {
        filledByKey.set(key, field);
      }
    }
  }
  return (fillSummary.fieldInventory || []).map((field) => {
    const filled =
      (field.id && filledByKey.get(`id:${field.id}`)) ||
      (field.name && filledByKey.get(`name:${field.name}`)) ||
      (field.descriptor && filledByKey.get(`descriptor:${field.descriptor}`)) ||
      null;
    return {
      id: field.id || "",
      name: field.name || "",
      tagName: field.tagName || "",
      type: field.type || "",
      kind: field.kind || "",
      descriptor: field.descriptor || filled?.descriptor || "",
      required: Boolean(field.required),
      filled: Boolean(field.filled),
      skippedReason: field.skippedReason || "",
      options: field.options || [],
      valuePut: filled?.value || "",
      selectedOption: filled?.selectedOption || filled?.value || "",
      valueSource: filled?.valueSource || field.valueSource || "",
      bestEffortWarning:
        filled?.bestEffortWarning || field.bestEffortWarning || "",
    };
  });
}

function buildFillAudit({
  pageIndex,
  fillIndex,
  before,
  afterFill,
  fillSummary,
}) {
  return {
    pageIndex,
    retryIndex: fillIndex,
    stepBefore: before.currentStep || null,
    stepAfter: afterFill.currentStep || null,
    hrefBefore: before.href || "",
    hrefAfter: afterFill.href || "",
    status: fillSummary.status || "",
    ok: Boolean(fillSummary.ok),
    filledFieldCount: fillSummary.filledFieldCount || 0,
    pendingLlmFieldCount: fillSummary.pendingLlmFieldCount || 0,
    manualReviewReasons: fillSummary.manualReviewReasons || [],
    bestEffortWarnings: fillSummary.bestEffortWarnings || [],
    fields: buildFieldAudit(fillSummary),
    generatedAnswers: fillSummary.generatedAnswers || [],
    filledFields: fillSummary.filledFields || [],
    afterErrors: afterFill.errors || [],
    suppressedErrors: afterFill.suppressedErrors || [],
    remainingValues: afterFill.remainingValues || {},
    nextAction: fillSummary.nextAction || null,
    v2AuditSummary: fillSummary.v2AuditSummary || null,
  };
}

function writeAuditJson(auditPath, audit) {
  if (!auditPath) {
    return null;
  }
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf-8");
  return auditPath;
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
      await navigate(pageClient, applyUrl);
      await pageClient.send("Page.bringToFront");
    } else {
      const readyState = await waitForWorkdayPageReady(pageClient);
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
    const applyEntry = await clickApplyManuallyEntry(pageClient);
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
    for (let i = 0; i < args.maxPages; i += 1) {
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
        ? await clearPageUntilStable(optionsClient, pageClient, applyUrl)
        : null;
      const fills = [];
      let afterFill = before;
      for (let fillIndex = 0; fillIndex < args.fillsPerPage; fillIndex += 1) {
        if (args.extensionAutoNext) {
          await setExtensionAutoNext(
            optionsClient,
            fillIndex === args.fillsPerPage - 1,
          );
        }
        const fill = await fillCurrentPage(optionsClient, applyUrl, args);
        const fillSummary = summarizeFill(fill);
        if (fillSummary.manualReviewReasons.includes("fill_timeout")) {
          fills.push({
            fillIndex: fillIndex + 1,
            fill: fillSummary,
            afterFill: before,
          });
          audit.pages.push(
            buildFillAudit({
              pageIndex: i + 1,
              fillIndex: fillIndex + 1,
              before,
              afterFill: before,
              fillSummary,
            }),
          );
          break;
        }
        const phoneCountryUnfilled = fillSummary.unfilledRequired.some(
          (field) =>
            /phonecountrycode|country\s*phone\s*code/i.test(
              [field.id, field.name, field.descriptor]
                .filter(Boolean)
                .join(" "),
            ),
        );
        if (
          args.cdpRepairPhoneCountry &&
          (fillSummary.manualReviewReasons.includes(
            "required_field_unresolved:phone_country_code_commit_failed",
          ) ||
            (phoneCountryUnfilled &&
              fillSummary.manualReviewReasons.some((reason) =>
                /required_field_unresolved:(no_matching_option|no_known_match|commit_not_verified)/.test(
                  reason,
                ),
              )))
        ) {
          const cdpFixed = await tryFixPhoneCountryCodeViaCdp(pageClient);
          if (cdpFixed) {
            fillSummary.manualReviewReasons =
              fillSummary.manualReviewReasons.filter(
                (r) =>
                  r !==
                    "required_field_unresolved:phone_country_code_commit_failed" &&
                  !(
                    phoneCountryUnfilled &&
                    /required_field_unresolved:(no_matching_option|no_known_match|commit_not_verified)/.test(
                      r,
                    )
                  ),
              );
            fillSummary.unfilledRequired = fillSummary.unfilledRequired.filter(
              (field) =>
                !/phonecountrycode|country\s*phone\s*code/i.test(
                  [field.id, field.name, field.descriptor]
                    .filter(Boolean)
                    .join(" "),
                ),
            );
            fillSummary.status =
              fillSummary.manualReviewReasons.length === 0
                ? "filled"
                : fillSummary.status;
            fillSummary.cdpPhoneCodeFixed = true;
          }
        }
        const sourceNeedsKeyboard =
          fillSummary.unfilledRequired.some((field) =>
            /source--source|how did you hear about us/i.test(
              [field.id, field.name, field.descriptor]
                .filter(Boolean)
                .join(" "),
            ),
          ) &&
          (fillSummary.manualReviewReasons.some((reason) =>
            /required_field_unresolved:(commit_not_verified|field_fill_timeout)/.test(
              reason,
            ),
          ) ||
            fillSummary.bestEffortWarnings.some((warning) =>
              /field_fill_timeout|workday_source_options_unavailable|workday_commit_not_verified/.test(
                warning,
              ),
            ));
        if (sourceNeedsKeyboard) {
          const cdpSourceKeyboard =
            await tryFixWorkdaySourceViaKeyboard(pageClient);
          fillSummary.cdpSourceKeyboard = cdpSourceKeyboard;
          if (cdpSourceKeyboard?.ok) {
            fillSummary.manualReviewReasons =
              fillSummary.manualReviewReasons.filter(
                (reason) =>
                  !/required_field_unresolved:(commit_not_verified|field_fill_timeout)/.test(
                    reason,
                  ),
              );
            fillSummary.unfilledRequired = fillSummary.unfilledRequired.filter(
              (field) =>
                !/source--source|how did you hear about us/i.test(
                  [field.id, field.name, field.descriptor]
                    .filter(Boolean)
                    .join(" "),
                ),
            );
            fillSummary.status =
              fillSummary.manualReviewReasons.length === 0
                ? "filled"
                : fillSummary.status;
          }
        }
        const requiredSearchNeedsKeyboard = fillSummary.unfilledRequired.filter(
          (field) => {
            const fieldKey = [field.id, field.name, field.descriptor]
              .filter(Boolean)
              .join(" ");
            return (
              field.tagName === "INPUT" &&
              /required_field_unresolved:(no_known_match|no_matching_option|commit_not_verified)/.test(
                fillSummary.manualReviewReasons.join(" "),
              ) &&
              !/source--source|how did you hear about us|phonecountrycode|datesection/i.test(
                fieldKey,
              )
            );
          },
        );
        if (requiredSearchNeedsKeyboard.length) {
          fillSummary.cdpRequiredSearchKeyboard =
            await tryFixWorkdayRequiredSearchInputsViaKeyboard(
              pageClient,
              requiredSearchNeedsKeyboard,
            );
          if (fillSummary.cdpRequiredSearchKeyboard?.ok) {
            const repairedIds = new Set(
              (fillSummary.cdpRequiredSearchKeyboard.repairs || [])
                .filter((repair) => repair?.ok)
                .map((repair) => repair?.target?.field?.id || repair?.field?.id)
                .filter(Boolean),
            );
            fillSummary.unfilledRequired = fillSummary.unfilledRequired.filter(
              (field) => !repairedIds.has(field.id),
            );
            if (fillSummary.unfilledRequired.length === 0) {
              fillSummary.manualReviewReasons = [];
              fillSummary.status = "filled";
            }
          }
        }
        await sleep(
          args.extensionAutoNext
            ? 7500
            : before.currentStep?.current === 1 && args.mode === "resume"
              ? 7000
              : 1200,
        );
        afterFill = await inspectPage(pageClient);
        if (afterFill.workdayRuntimeError) {
          fillSummary.runtimeRecovery = await recoverWorkdayRuntimeError(
            pageClient,
            "after_fill_workday_runtime_error",
          );
          if (fillSummary.runtimeRecovery.ok) {
            afterFill = await inspectPage(pageClient);
          }
        }
        const dateSectionNeedsKeyboard =
          afterFill.errors?.some((error) =>
            /desired start date|required and must have a value/i.test(error),
          ) &&
          afterFill.fields?.some((field) =>
            /dateSection(Month|Day|Year)/i.test(field.id || ""),
          );
        if (dateSectionNeedsKeyboard) {
          fillSummary.cdpDateSection =
            await tryFixWorkdayDateSectionsViaCdp(pageClient);
          if (fillSummary.cdpDateSection?.ok) {
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
          const clear = await clearCurrentPage(optionsClient, applyUrl);
          await sleep(1800);
          const afterClear = await inspectPage(pageClient);
          const refill = await fillCurrentPage(optionsClient, applyUrl, args);
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
          errors: afterFill.errors,
          suppressedErrors: afterFill.suppressedErrors || [],
          fields: afterFill.fields,
          remainingValues: afterFill.remainingValues,
        },
      });

      if (
        fills.some((f) => f.fill?.manualReviewReasons?.includes("fill_timeout"))
      ) {
        break;
      }
      if (args.stopAfterFill) {
        break;
      }
      if (args.targetStep && stepMatches(afterFill, args.targetStep)) {
        break;
      }
      if (
        afterFill.hasSubmit ||
        /review/i.test(afterFill.currentStep?.title || "")
      ) {
        break;
      }
      if (
        /create account|sign in|log in|login|register|sign up/i.test(
          afterFill.currentStep?.title || "",
        )
      ) {
        const authNext = await clickAuthPrimary(pageClient);
        timeline[timeline.length - 1].authNext = authNext;
        if (!authNext.clicked) {
          break;
        }
        await sleep(1800);
        continue;
      }
      if (args.extensionAutoNext) {
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
          const fillNeedsReview =
            fills.at(-1)?.fill?.manualReviewReasons?.length > 0;
          if (!fillNeedsReview || afterFill.errors?.length) {
            break;
          }
          const next = await clickNext(pageClient);
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
      const next = await clickNext(pageClient);
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
    audit.ok = true;
    audit.finishedAt = new Date().toISOString();
    audit.final = {
      href: finalPage.href,
      currentStep: finalPage.currentStep,
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
          ok: true,
          mode: args.mode,
          applyUrl,
          auditJson: auditPath,
          issueRegistry,
          final: {
            href: finalPage.href,
            currentStep: finalPage.currentStep,
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
