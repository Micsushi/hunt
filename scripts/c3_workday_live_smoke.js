#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const DEFAULT_JOB_URL =
  "https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn";
const DEFAULT_EXTENSION_ID = "cbdmkibihimaedoihjhpidclolglnncc";

function parseArgs(argv) {
  const args = {
    mode: "resume",
    cdpPort: 9222,
    jobUrl: DEFAULT_JOB_URL,
    resumePath: path.resolve(process.cwd(), "main.pdf"),
    extensionId: DEFAULT_EXTENSION_ID,
    maxPages: 8,
    fillsPerPage: 1,
    stopAfterFill: false,
    verifyClear: false,
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
    } else if (arg === "--verify-clear") {
      args.verifyClear = true;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["resume", "manual"].includes(args.mode)) {
    throw new Error("--mode must be resume or manual");
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
    "  --verify-clear     Fill, clear, verify empty, then refill before Next",
  ].join("\n");
}

function httpJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(
              new Error(`Invalid JSON from ${requestPath}: ${error.message}`),
            );
          }
        });
      })
      .on("error", reject);
  });
}

function httpText(port, requestPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CDP connect timeout")),
        10000,
      );
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(event.error || new Error("CDP websocket error"));
      });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) {
          reject(
            new Error(message.error.message || JSON.stringify(message.error)),
          );
        } else {
          resolve(message.result);
        }
      }
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  async evaluate(expression, timeoutMs = 60000) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ||
          result.exceptionDetails.exception?.description ||
          "Runtime.evaluate failed",
      );
    }
    return result.result?.value;
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

function js(value) {
  return JSON.stringify(value);
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

function makeSeedPayload(resumePath, applyUrl) {
  const pdf = fs.readFileSync(resumePath);
  const pdfFileName = path.basename(resumePath);
  const pdfDataUrl = `data:application/pdf;base64,${pdf.toString("base64")}`;
  const profile = {
    fullName: "Michael Shi",
    email: "wenjian2@ualberta.ca",
    phone: "7800000000",
    location: "Edmonton, Alberta, Canada",
    linkedinUrl: "https://linkedin.com/in/wjshi",
    githubUrl: "https://github.com/micsushi",
    websiteUrl: "https://mshi.ca",
    workAuthorized: true,
    sponsorshipRequired: false,
    willingToRelocate: true,
    openToAnyLocation: true,
    salaryFlexible: true,
    coOpTermsCompleted: "2",
    availableSummer2026: "Yes",
    availableInterviewWindow: "Yes",
    expectedGraduationYear: "2026",
    previousEmployers: "",
    skills: ["Python", "JavaScript", "React", "PostgreSQL"],
    workExperience: [
      {
        jobTitle: "Software Developer Intern",
        company: "Hunt Test Company",
        location: "Edmonton, Alberta, Canada",
        startMonth: "May",
        startYear: "2025",
        endMonth: "August",
        endYear: "2025",
        current: false,
        description: "Built browser automation and data tooling.",
      },
    ],
    education: [
      {
        school: "University of Alberta",
        degree: "Bachelor of Science",
        fieldOfStudy: "Computer Science",
        startMonth: "September",
        startYear: "2021",
        endMonth: "April",
        endYear: "2026",
        overallResult: "",
      },
    ],
    notes: "",
  };
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
    title: "Junior AI Software Engineer",
    company: "Jonas Software Canada",
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
  let targets = await getTargets(port);
  let target = targets.find((item) =>
    String(item.url || "").includes(
      "talentmanagementsolution.wd3.myworkdayjobs.com",
    ),
  );
  if (!target) {
    await httpText(port, `/json/new?${encodeURIComponent(applyUrl)}`, "PUT");
    await sleep(1000);
    targets = await getTargets(port);
    target = targets.find((item) =>
      String(item.url || "").includes(
        "talentmanagementsolution.wd3.myworkdayjobs.com",
      ),
    );
  }
  if (!target) {
    throw new Error("Could not open Workday page target");
  }
  return target;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connectTarget(target) {
  return new CdpClient(target.webSocketDebuggerUrl).connect();
}

async function seedExtension(optionsClient, seedPayload) {
  return optionsClient.evaluate(
    `(async () => {
      const payload = ${js(seedPayload)};
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chrome.storage.local.set({
        "hunt.apply.profile": payload.profile,
        "hunt.apply.defaultResume": payload.defaultResume,
        "hunt.apply.activeApplyContext": payload.activeApplyContext
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chrome.storage.local.set({
        "hunt.apply.profile": payload.profile,
        "hunt.apply.defaultResume": payload.defaultResume,
        "hunt.apply.activeApplyContext": payload.activeApplyContext
      });
      return await chrome.storage.local.get([
        "hunt.apply.profile",
        "hunt.apply.defaultResume",
        "hunt.apply.activeApplyContext"
      ]);
    })()`,
  );
}

async function navigate(pageClient, applyUrl) {
  await pageClient.send("Page.enable");
  await pageClient.send("Page.navigate", { url: applyUrl });
  await sleep(4500);
}

function pageSummaryExpression() {
  return `(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = document.body ? document.body.innerText : "";
    const stepMatch = text.match(/current step\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
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
      .slice(0, 30);
    return {
      href: location.href,
      title: document.title,
      currentStep: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: stepMatch[3].trim() } : null,
      hasSubmit: buttons.some((button) => /^submit$/i.test(button.text)),
      hasNext: buttons.some((button) => /^next$/i.test(button.text) && !button.disabled),
      buttons,
      fields,
      remainingValues: {
        workdayButtons,
        selectedPills,
        filledNative
      },
      errors,
      bodyHead: text.replace(/\\s+/g, " ").trim().slice(0, 1200)
    };
  })()`;
}

async function inspectPage(pageClient) {
  return pageClient.evaluate(pageSummaryExpression());
}

async function fillCurrentPage(optionsClient) {
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const tab = tabs.find((item) => String(item.url || "").includes("talentmanagementsolution.wd3.myworkdayjobs.com"));
      if (!tab) {
        return { ok: false, error: "workday_tab_not_found" };
      }
      const wrapped = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "hunt.apply.fill_current_page", payload: { tabId: tab.id } },
          (messageResponse) => resolve({
            messageResponse,
            lastError: chrome.runtime.lastError && chrome.runtime.lastError.message
          })
        );
      });
      const response = wrapped.messageResponse || {};
      const attempt = response.attempt || {};
      const result = response.result || {};
      return {
        ok: response.ok === true,
        error: wrapped.lastError || response.error || "",
        message: response.message || "",
        status: attempt.status || "",
        summary: attempt.summary || "",
        filledFieldCount: attempt.filledFieldCount || result.filledFieldCount || 0,
        manualReviewReasons: attempt.manualReviewReasons || result.manualReviewReasons || [],
        pendingLlmFieldCount: result.pendingLlmFieldCount || 0,
        interactionTrace: (result.interactionTrace || []).slice(0, 120),
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
          valueSource: field.valueSource || ""
        })).slice(0, 120)
      };
    })()`,
    120000,
  );
}

async function clearCurrentPage(optionsClient) {
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const tab = tabs.find((item) => String(item.url || "").includes("talentmanagementsolution.wd3.myworkdayjobs.com"));
      if (!tab) {
        return { ok: false, error: "workday_tab_not_found" };
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
      const beforeHref = location.href;
      const button = [...document.querySelectorAll("button")]
        .filter(visible)
        .find((candidate) => /^next$/i.test((candidate.innerText || candidate.textContent || "").trim()) && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true");
      if (!button) {
        return { clicked: false, reason: "next_not_found", href: beforeHref };
      }
      clickReal(button);
      await sleep(6500);
      const body = document.body ? document.body.innerText : "";
      const stepMatch = body.match(/current step\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
      return {
        clicked: true,
        beforeHref,
        href: location.href,
        currentStep: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: stepMatch[3].trim() } : null,
        bodyHead: body.replace(/\\s+/g, " ").trim().slice(0, 600)
      };
    })()`,
    30000,
  );
}

function summarizeFill(fill) {
  const interactionTrace = fill.interactionTrace || [];
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
    manualReviewReasons: fill.manualReviewReasons,
    unfilledRequired: fill.fieldInventory
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
  const optionsClient = await connectTarget(optionsTarget);
  const pageClient = await connectTarget(pageTarget);

  try {
    const seedPayload = makeSeedPayload(args.resumePath, applyUrl);
    await seedExtension(optionsClient, seedPayload);
    await navigate(pageClient, applyUrl);

    const timeline = [];
    for (let i = 0; i < args.maxPages; i += 1) {
      const before = await inspectPage(pageClient);
      const fills = [];
      let afterFill = before;
      for (let fillIndex = 0; fillIndex < args.fillsPerPage; fillIndex += 1) {
        const fill = await fillCurrentPage(optionsClient);
        await sleep(
          before.currentStep?.current === 1 && args.mode === "resume"
            ? 7000
            : 1200,
        );
        afterFill = await inspectPage(pageClient);
        fills.push({
          fillIndex: fillIndex + 1,
          fill: summarizeFill(fill),
          afterFill: {
            href: afterFill.href,
            currentStep: afterFill.currentStep,
            hasNext: afterFill.hasNext,
            hasSubmit: afterFill.hasSubmit,
            errors: afterFill.errors,
            fields: afterFill.fields,
            remainingValues: afterFill.remainingValues,
          },
        });
        if (args.verifyClear) {
          const clear = await clearCurrentPage(optionsClient);
          await sleep(1800);
          const afterClear = await inspectPage(pageClient);
          const refill = await fillCurrentPage(optionsClient);
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
        }
      }
      timeline.push({
        pageIndex: i + 1,
        before: {
          href: before.href,
          currentStep: before.currentStep,
          hasNext: before.hasNext,
          hasSubmit: before.hasSubmit,
          errors: before.errors,
        },
        fill: fills[0]?.fill || null,
        fills,
        afterFill: {
          href: afterFill.href,
          currentStep: afterFill.currentStep,
          hasNext: afterFill.hasNext,
          hasSubmit: afterFill.hasSubmit,
          errors: afterFill.errors,
          fields: afterFill.fields,
          remainingValues: afterFill.remainingValues,
        },
      });

      if (args.stopAfterFill) {
        break;
      }
      if (
        afterFill.hasSubmit ||
        /review/i.test(afterFill.currentStep?.title || "")
      ) {
        break;
      }
      if (!afterFill.hasNext) {
        break;
      }
      const next = await clickNext(pageClient);
      timeline[timeline.length - 1].next = next;
      if (!next.clicked) {
        break;
      }
      await sleep(1200);
    }

    const finalPage = await inspectPage(pageClient);
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: args.mode,
          applyUrl,
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
  console.error(error.stack || error.message);
  process.exit(1);
});
