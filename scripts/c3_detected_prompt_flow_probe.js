#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, httpText, js, sleep } = require("./lib/c3_cdp");

const DEFAULT_JOB_URL =
  "https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn";
const DEFAULT_EXTENSION_ID = "cbdmkibihimaedoihjhpidclolglnncc";
const RUNTIME_CONFIG_KEY = "hunt.apply.runtimeConfig";
const PROMPT_ID = "hunt-apply-detected-page-prompt";
const FILL_PROGRESS_ID = "hunt-apply-fill-progress";
const TOAST_CONTAINER_ID = "hunt-apply-page-toasts";

function parseArgs(argv) {
  const args = {
    cdpPort: 9222,
    jobUrl: DEFAULT_JOB_URL,
    timeoutMs: 420000,
    closeOtherWorkdayTabs: false,
    extensionId: DEFAULT_EXTENSION_ID,
    extensionAutoNext: true,
    resumePath: "main.pdf",
    seedResume: true,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      index += 1;
    } else if (arg === "--job-url" && next) {
      args.jobUrl = next;
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      args.timeoutMs = Number(next);
      index += 1;
    } else if (arg === "--close-other-workday-tabs") {
      args.closeOtherWorkdayTabs = true;
    } else if (arg === "--extension-id" && next) {
      args.extensionId = next;
      index += 1;
    } else if (arg === "--no-extension-auto-next") {
      args.extensionAutoNext = false;
    } else if (arg === "--resume" && next) {
      args.resumePath = next;
      index += 1;
    } else if (arg === "--no-seed-resume") {
      args.seedResume = false;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/c3_detected_prompt_flow_probe.js [options]",
    "",
    "Options:",
    "  --job-url <url>       Public job URL to open",
    "  --cdp-port <port>     Chrome DevTools port, default 9222",
    "  --timeout-ms <ms>     Hard monitor timeout, default 420000",
    "  --extension-id <id>   Hunt Apply extension id",
    "  --resume <path>       PDF resume to seed, default main.pdf",
    "  --close-other-workday-tabs",
    "  --no-extension-auto-next",
    "  --no-seed-resume",
  ].join("\n");
}

async function getTargets(port) {
  return httpJson(port, "/json/list");
}

function isWorkdayPage(target) {
  return (
    target.type === "page" &&
    /myworkdayjobs\.com/i.test(String(target.url || ""))
  );
}

async function closeOtherWorkdayTabs(port, keepId = "") {
  const targets = await getTargets(port);
  const closed = [];
  for (const target of targets) {
    if (!isWorkdayPage(target) || String(target.id || "") === String(keepId)) {
      continue;
    }
    await httpText(port, `/json/close/${target.id}`).catch(() => "");
    closed.push({
      id: target.id,
      title: target.title || "",
      url: target.url || "",
    });
  }
  return closed;
}

async function openJobTab(port, jobUrl) {
  const body = await httpText(
    port,
    `/json/new?${encodeURIComponent(jobUrl)}`,
    "PUT",
  );
  const target = JSON.parse(body);
  if (!target.webSocketDebuggerUrl) {
    throw new Error("New Chrome target did not include a websocket URL.");
  }
  return target;
}

function findExtensionId(targets, fallbackExtensionId) {
  const worker = targets.find((target) =>
    String(target.url || "").includes("/src/background/index.js"),
  );
  const workerMatch = String(worker?.url || "").match(
    /^chrome-extension:\/\/([^/]+)/,
  );
  if (workerMatch) {
    return workerMatch[1];
  }
  for (const target of targets) {
    const match = String(target.url || "").match(
      /^chrome-extension:\/\/([^/]+)/,
    );
    if (match) {
      return match[1];
    }
  }
  return fallbackExtensionId;
}

function findOptionsTarget(targets, extensionId) {
  return targets.find(
    (target) =>
      target.type === "page" &&
      String(target.url || "").startsWith(
        `chrome-extension://${extensionId}/src/options/options.html`,
      ),
  );
}

async function ensureOptionsTarget(port, extensionId) {
  let targets = await getTargets(port);
  const resolvedExtensionId = findExtensionId(targets, extensionId);
  const existing = findOptionsTarget(targets, resolvedExtensionId);
  if (existing?.webSocketDebuggerUrl) {
    return existing;
  }
  const url = `chrome-extension://${resolvedExtensionId}/src/options/options.html`;
  await httpText(port, `/json/new?${encodeURIComponent(url)}`, "PUT");
  targets = await getTargets(port);
  const opened = findOptionsTarget(targets, resolvedExtensionId);
  if (!opened?.webSocketDebuggerUrl) {
    throw new Error("Could not open the Hunt Apply Options page in p Chrome.");
  }
  return opened;
}

async function configureExtensionAutoNext(port, extensionId, enabled) {
  const optionsTarget = await ensureOptionsTarget(port, extensionId);
  const client = await new CdpClient(
    optionsTarget.webSocketDebuggerUrl,
  ).connect();
  try {
    return await client.evaluate(
      `(async () => {
        const key = ${js(RUNTIME_CONFIG_KEY)};
        const stored = await chrome.storage.local.get(key);
        const current = stored[key] || {};
        const next = {
          ...current,
          autoClickNextAfterFill: ${Boolean(enabled)},
          configuredBy: "scripts/c3_detected_prompt_flow_probe.js",
          configuredAt: new Date().toISOString()
        };
        await chrome.storage.local.set({ [key]: next });
        const state = await chrome.runtime.sendMessage({
          type: "hunt.apply.get_state",
        });
        return {
          ok: true,
          autoClickNextAfterFill: Boolean(state.settings?.autoClickNextAfterFill)
        };
      })()`,
      30000,
    );
  } finally {
    client.close();
  }
}

function workdaySlugToText(value = "") {
  return decodeURIComponent(String(value || ""))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferWorkdayContext(jobUrl) {
  try {
    const url = new URL(jobUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const jobIndex = parts.findIndex((part) => part.toLowerCase() === "job");
    const locationSlug = jobIndex >= 0 ? parts[jobIndex + 1] || "" : "";
    const titleSlug = jobIndex >= 0 ? parts[jobIndex + 2] || "" : "";
    const hostParts = url.hostname.split(".");
    return {
      title: workdaySlugToText(titleSlug) || "Workday application",
      company: hostParts[0] || "workday",
      location: workdaySlugToText(locationSlug),
    };
  } catch (_error) {
    return {
      title: "Workday application",
      company: "workday",
      location: "",
    };
  }
}

function makeResumeSeedPayload(resumePath, jobUrl) {
  const absoluteResumePath = path.resolve(resumePath);
  const pdf = fs.readFileSync(absoluteResumePath);
  const pdfFileName = path.basename(absoluteResumePath);
  const pdfDataUrl = `data:application/pdf;base64,${pdf.toString("base64")}`;
  const inferred = inferWorkdayContext(jobUrl);
  return {
    defaultResume: {
      label: pdfFileName,
      sourceType: "local_pdf",
      pdfFileName,
      pdfMimeType: "application/pdf",
      pdfDataUrl,
      pdfPath: absoluteResumePath,
      versionId: "detected-prompt-flow",
      texPath: "",
      jobId: "",
    },
    activeApplyContext: {
      jobId: "",
      title: inferred.title,
      company: inferred.company,
      location: inferred.location,
      source: "LinkedIn",
      sourceMode: "manual",
      atsType: "workday",
      applyUrl: jobUrl,
      jobUrl,
      selectedResumeName: pdfFileName,
      selectedResumePath: absoluteResumePath,
      selectedResumeDataUrl: pdfDataUrl,
      selectedResumeReadyForC3: true,
    },
  };
}

async function seedResumeContext(port, extensionId, resumePath, jobUrl) {
  const payload = makeResumeSeedPayload(resumePath, jobUrl);
  const optionsTarget = await ensureOptionsTarget(port, extensionId);
  const client = await new CdpClient(
    optionsTarget.webSocketDebuggerUrl,
  ).connect();
  try {
    return await client.evaluate(
      `(async () => {
        const payload = ${js(payload)};
        await chrome.storage.local.set({
          "hunt.apply.defaultResume": payload.defaultResume,
          "hunt.apply.activeApplyContext": payload.activeApplyContext
        });
        const state = await chrome.runtime.sendMessage({
          type: "hunt.apply.get_state",
        });
        return {
          ok: true,
          selectedResumeReadyForC3: Boolean(
            state.activeApplyContext?.selectedResumeReadyForC3
          ),
          selectedResumeName:
            state.activeApplyContext?.selectedResumeName ||
            state.defaultResume?.pdfFileName ||
            ""
        };
      })()`,
      30000,
    );
  } finally {
    client.close();
  }
}

async function waitForPrompt(client, timeoutMs = 60000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await client.evaluate(
      `(() => {
        const host = document.getElementById(${JSON.stringify(PROMPT_ID)});
        const fill = host?.shadowRoot?.getElementById("fill");
        const title = host?.shadowRoot?.querySelector(".title")?.textContent || "";
        return {
          href: location.href,
          title: document.title,
          found: Boolean(host && fill),
          promptTitle: title,
          buttonText: fill?.textContent || "",
          bodyHead: String(document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 300),
        };
      })()`,
      10000,
    );
    if (last?.found) {
      return { ok: true, waitMs: Date.now() - startedAt, prompt: last };
    }
    await sleep(800);
  }
  return {
    ok: false,
    reason: "detected_prompt_not_found",
    waitMs: Date.now() - startedAt,
    last,
  };
}

async function clickPromptFill(client) {
  return client.evaluate(
    `(() => {
      const host = document.getElementById(${JSON.stringify(PROMPT_ID)});
      const fill = host?.shadowRoot?.getElementById("fill");
      if (!host || !fill) {
        return { ok: false, reason: "prompt_fill_button_not_found" };
      }
      const buttonText = fill.textContent || "";
      fill.click();
      return {
        ok: true,
        buttonText,
        href: location.href,
        title: document.title,
      };
    })()`,
    10000,
  );
}

async function inspectFlowState(client) {
  return client.evaluate(
    `(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"]');
      const progress = document.getElementById(${JSON.stringify(FILL_PROGRESS_ID)});
      const progressPanel = progress?.shadowRoot?.querySelector(".panel");
      const progressMessage = progress?.shadowRoot?.getElementById("hunt-apply-fill-progress-message")?.textContent || "";
      const toastContainer = document.getElementById(${JSON.stringify(TOAST_CONTAINER_ID)});
      const toastRect = toastContainer?.getBoundingClientRect?.();
      const progressRect = progressPanel?.getBoundingClientRect?.() || progress?.getBoundingClientRect?.();
      const buttons = [...document.querySelectorAll("button, [role='button']")]
        .filter(visible)
        .map((button) => normalize([
          button.getAttribute("data-automation-id"),
          button.getAttribute("aria-label"),
          button.innerText,
          button.textContent,
        ].filter(Boolean).join(" ")))
        .filter(Boolean)
        .slice(0, 40);
      const errors = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error" i], [id*="error" i]')]
        .filter(visible)
        .map((error) => normalize(error.innerText || error.textContent || ""))
        .filter(Boolean)
        .slice(0, 20);
      return {
        href: location.href,
        title: document.title,
        currentStepText: normalize(activeStep?.innerText || activeStep?.textContent || ""),
        hasSubmit: buttons.some((text) => /^Submit\\b/i.test(text) || / Submit$/i.test(text)),
        hasNext: buttons.some((text) => /^pageFooterNextButton\\b/i.test(text) || /^Next\\b/i.test(text) || / Next$/i.test(text)),
        progressMessage,
        progressRect: progressRect ? {
          top: Math.round(progressRect.top),
          bottom: Math.round(progressRect.bottom),
          height: Math.round(progressRect.height),
        } : null,
        toastRect: toastRect ? {
          top: Math.round(toastRect.top),
          bottom: Math.round(toastRect.bottom),
          height: Math.round(toastRect.height),
        } : null,
        toastCount: toastContainer?.children?.length || 0,
        toastOverlapsProgress: Boolean(
          toastRect &&
          progressRect &&
          toastRect.top < progressRect.bottom &&
          toastRect.bottom > progressRect.top
        ),
        promptVisible: Boolean(document.getElementById(${JSON.stringify(PROMPT_ID)})),
        errors,
        buttons,
      };
    })()`,
    10000,
  );
}

async function monitorFlow(client, timeoutMs) {
  const startedAt = Date.now();
  const samples = [];
  let lastStep = "";
  while (Date.now() - startedAt < timeoutMs) {
    const state = await inspectFlowState(client);
    samples.push({
      atMs: Date.now() - startedAt,
      href: state.href,
      currentStepText: state.currentStepText,
      hasSubmit: state.hasSubmit,
      hasNext: state.hasNext,
      progressMessage: state.progressMessage,
      toastCount: state.toastCount,
      toastOverlapsProgress: state.toastOverlapsProgress,
      errors: state.errors,
    });
    const stepKey = [
      state.currentStepText,
      state.progressMessage,
      state.hasSubmit ? "submit" : "",
      state.errors.join("|"),
    ].join(" :: ");
    if (stepKey !== lastStep) {
      lastStep = stepKey;
      console.error(
        `[c3-prompt-flow] ${Math.round((Date.now() - startedAt) / 1000)}s ${stepKey}`,
      );
    }
    if (state.toastOverlapsProgress) {
      return {
        ok: false,
        reason: "toast_overlaps_fill_progress",
        elapsedMs: Date.now() - startedAt,
        state,
        samples,
      };
    }
    if (state.hasSubmit || /review/i.test(state.currentStepText)) {
      return {
        ok: true,
        reason: "review_reached",
        elapsedMs: Date.now() - startedAt,
        state,
        samples,
      };
    }
    await sleep(2000);
  }
  return {
    ok: false,
    reason: "flow_timeout",
    elapsedMs: Date.now() - startedAt,
    state: samples.at(-1) || null,
    samples,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const config = await configureExtensionAutoNext(
    args.cdpPort,
    args.extensionId,
    args.extensionAutoNext,
  );
  const resumeSeed = args.seedResume
    ? await seedResumeContext(
        args.cdpPort,
        args.extensionId,
        args.resumePath,
        args.jobUrl,
      )
    : { ok: true, skipped: true };
  if (args.closeOtherWorkdayTabs) {
    await closeOtherWorkdayTabs(args.cdpPort);
  }
  const target = await openJobTab(args.cdpPort, args.jobUrl);
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  try {
    await client.send("Page.enable");
    await client.send("Page.bringToFront");
    const prompt = await waitForPrompt(client, 70000);
    if (!prompt.ok) {
      console.log(JSON.stringify({ ok: false, prompt }, null, 2));
      process.exitCode = 1;
      return;
    }
    const click = await clickPromptFill(client);
    if (!click.ok) {
      console.log(JSON.stringify({ ok: false, prompt, click }, null, 2));
      process.exitCode = 1;
      return;
    }
    const monitor = await monitorFlow(client, args.timeoutMs);
    console.log(
      JSON.stringify(
        {
          ok: Boolean(monitor.ok),
          config,
          resumeSeed,
          prompt,
          click,
          monitor,
        },
        null,
        2,
      ),
    );
    if (!monitor.ok) {
      process.exitCode = 1;
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
