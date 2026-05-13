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
    preserveCurrent: false,
    targetStep: "",
    startStep: "",
    requireTarget: false,
    stopAtTarget: false,
    clearRepeatableSections: false,
    verifyClear: false,
    clearBeforeFill: false,
    extensionAutoNext: false,
    accountEmail: process.env.HUNT_C3_TEST_ACCOUNT_EMAIL || "",
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
      args.preserveCurrent = true;
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
    } else if (arg === "--account-email" && next) {
      args.accountEmail = next;
      i += 1;
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
    "  --preserve-current Do not navigate the Workday tab before running",
    "  --target-step <name> Stop logic can target a Workday step title",
    "  --start-step <name> Click a Workday step before filling, if visible",
    "  --require-target Fail before fill unless current step matches target",
    "  --stop-at-target   Stop before filling when current step matches target",
    "  --clear-repeatable-sections Delete Workday repeatable rows before fill",
    "  --clear-before-fill Clear the current Workday page before each fill",
    "  --verify-clear     Fill, clear, verify empty, then refill before Next",
    "  --extension-auto-next Enable C3's own safe Next-after-fill setting",
    "  --account-email <email> Optional account/profile email override",
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

function makeSeedPayload(resumePath, applyUrl, args = {}) {
  const pdf = fs.readFileSync(resumePath);
  const pdfFileName = path.basename(resumePath);
  const pdfDataUrl = `data:application/pdf;base64,${pdf.toString("base64")}`;
  const profileEmail = args.accountEmail || "wenjian2@ualberta.ca";
  const profile = {
    fullName: "Michael Shi",
    email: profileEmail,
    accountEmail: profileEmail,
    phone: "7804923111",
    location: "Edmonton, Alberta, Canada",
    addressLine1: "10180 101 Street NW",
    addressLine2: "",
    postalCode: "T5J 3S4",
    linkedinUrl: "https://linkedin.com/in/wjshi",
    githubUrl: "https://github.com/micsushi",
    websiteUrl: "https://mshi.ca",
    workAuthorized: true,
    canadianCitizenOrPermanentResident: "yes",
    sinStartsWithNine: "no",
    sinExpiryDate: "",
    interestedTemporaryShortContract: "yes",
    sponsorshipRequired: false,
    willingToRelocate: true,
    openToAnyLocation: true,
    salaryFlexible: true,
    coOpTermsCompleted: "2",
    availableSummer2026: "Yes",
    availableInterviewWindow: "Yes",
    expectedGraduationYear: "2026",
    previousEmployers: "",
    skills: ["Python", "React"],
    skillList: ["Python", "React"],
    workExperience: [
      {
        jobTitle: "Software Developer Intern",
        company: "INVIDI Technologies",
        location: "Edmonton, Alberta, Canada",
        startMonth: "05",
        startYear: "2025",
        endMonth: "08",
        endYear: "2025",
        current: false,
        description:
          "Built browser automation, data tooling, and production software features.",
      },
    ],
    pastJobs: [
      {
        title: "Software Developer Intern",
        employer: "INVIDI Technologies",
        location: "Edmonton, Alberta, Canada",
        startMonth: "05",
        startYear: "2025",
        endMonth: "08",
        endYear: "2025",
        current: false,
        description:
          "Built browser automation, data tooling, and production software features.",
      },
    ],
    employmentHistory: [
      {
        position: "Software Developer Intern",
        companyName: "INVIDI Technologies",
        location: "Edmonton, Alberta, Canada",
        fromMonth: "05",
        fromYear: "2025",
        toMonth: "08",
        toYear: "2025",
        description:
          "Built browser automation, data tooling, and production software features.",
      },
    ],
    education: [
      {
        school: "University of Alberta",
        degree: "Bachelor's Degree",
        fieldOfStudy: "Computer Science",
        startMonth: "09",
        startYear: "2021",
        endMonth: "04",
        endYear: "2026",
        overallResult: "3.7",
      },
    ],
    educationHistory: [
      {
        university: "University of Alberta",
        credential: "Bachelor's Degree",
        fieldOfStudy: "Computer Science",
        startMonth: "09",
        startYear: "2021",
        endMonth: "04",
        endYear: "2026",
        overallResult: "3.7",
      },
    ],
    websites: [
      "https://mshi.ca",
      "https://linkedin.com/in/wjshi",
      "https://github.com/micsushi",
    ],
    links: [
      "https://mshi.ca",
      "https://linkedin.com/in/wjshi",
      "https://github.com/micsushi",
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
  const applyHost = new URL(applyUrl).host;
  const applyBase = applyUrl.split("?")[0];
  const isUsableApplyTarget = (item) => {
    const url = String(item.url || "");
    const title = String(item.title || "");
    return (
      url.startsWith(applyBase) &&
      !/create account|sign in|error|ok/i.test(title)
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
          String(item.url || "").includes("/apply/") &&
          !/create account|sign in|error|ok/i.test(String(item.title || "")),
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connectTarget(target) {
  return new CdpClient(target.webSocketDebuggerUrl).connect();
}

async function seedExtension(optionsClient, seedPayload, args = {}) {
  return optionsClient.evaluate(
    `(async () => {
      const payload = ${js(seedPayload)};
      const storedSettings = await chrome.storage.sync.get("hunt.apply.settings");
      await chrome.storage.sync.set({
        "hunt.apply.settings": {
          ...(storedSettings["hunt.apply.settings"] || {}),
          settingsVersion: 4,
          autoClickNextAfterFill: ${Boolean(args.extensionAutoNext)},
          autoAccountSignupLoginEnabled: true,
          autoEmailVerificationEnabled: true
        }
      });
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

async function setExtensionAutoNext(optionsClient, enabled) {
  return optionsClient.evaluate(
    `(async () => {
      const storedSettings = await chrome.storage.sync.get("hunt.apply.settings");
      await chrome.storage.sync.set({
        "hunt.apply.settings": {
          ...(storedSettings["hunt.apply.settings"] || {}),
          autoClickNextAfterFill: ${Boolean(enabled)}
        }
      });
      return { ok: true, autoClickNextAfterFill: ${Boolean(enabled)} };
    })()`,
  );
}

async function navigate(pageClient, applyUrl) {
  await pageClient.send("Page.enable");
  await pageClient.send("Page.navigate", { url: applyUrl });
  await sleep(4500);
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
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = document.body ? document.body.innerText : "";
    const normalizedText = text.replace(/\s+/g, " ").trim().toLowerCase();
    const workdayRuntimeError = normalizedText.includes("something went wrong")
      && normalizedText.includes("please refresh the page and then try again");
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
      const stepMatch = bodyText.match(/current step\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
      const currentStep = stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: normalize(stepMatch[3]) } : null;
      if (currentStep && currentStep.title.toLowerCase() === targetLower) {
        return {
          ok: true,
          reached: true,
          target,
          currentStep,
          href: location.href
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
        return {
          ok: true,
          clicked: true,
          target,
          label: candidate.text,
          href: location.href
        };
      }
      const back = candidates.find((item) => /^back(\\s+back)?$/i.test(item.text));
      if (back) {
        clickReal(back.el);
        await new Promise((resolve) => setTimeout(resolve, 8000));
        return {
          ok: false,
          clickedBack: true,
          reason: "rewind_with_back",
          target,
          currentStep,
          label: back.text,
          href: location.href,
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

async function fillCurrentPage(optionsClient, applyUrl) {
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const applyUrl = ${JSON.stringify(applyUrl)};
      const applyHost = new URL(applyUrl).host;
      const applyBase = applyUrl.split("?")[0];
      const usable = (item) => String(item.url || "").startsWith(applyBase)
        && !/create account|sign in|error|ok/i.test(String(item.title || ""));
      const candidates = tabs.filter(usable)
        .concat(tabs.filter((item) => String(item.url || "").includes(applyHost) && String(item.url || "").includes("/apply/") && !/create account|sign in|error|ok/i.test(String(item.title || ""))));
      const deduped = [...new Map(candidates.map((item) => [item.id, item])).values()];
      const tab = deduped.find((item) => item.active)
        || deduped.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
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
          nextAction: response.nextAction || null,
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

async function clearCurrentPage(optionsClient, applyUrl) {
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const applyUrl = ${JSON.stringify(applyUrl)};
      const applyHost = new URL(applyUrl).host;
      const applyBase = applyUrl.split("?")[0];
      const usable = (item) => String(item.url || "").startsWith(applyBase)
        && !/create account|sign in|error|ok/i.test(String(item.title || ""));
      const candidates = tabs.filter(usable)
        .concat(tabs.filter((item) => String(item.url || "").includes(applyHost) && String(item.url || "").includes("/apply/") && !/create account|sign in|error|ok/i.test(String(item.title || ""))));
      const deduped = [...new Map(candidates.map((item) => [item.id, item])).values()];
      const tab = deduped.find((item) => item.active)
        || deduped.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
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

function summarizeClear(clear) {
  return {
    ok: Boolean(clear?.ok),
    status: clear?.attempt?.status || clear?.status || "",
    message: clear?.message || "",
    clearedFieldCount: clear?.clearedFieldCount || clear?.cleared || 0,
    remainingOpenDropdowns: clear?.remainingOpenDropdowns || 0,
    remainingFilledControls: clear?.remainingFilledControls || 0,
    uploadedFileClears: clear?.uploadedFileClears || 0,
    manualReviewRequired: Boolean(clear?.manualReviewRequired),
    manualReviewReasons: clear?.manualReviewReasons || [],
    clearTrace: (clear?.clearTrace || []).slice(0, 80),
  };
}

async function clearPageUntilStable(optionsClient, pageClient, applyUrl) {
  const attempts = [];
  let previousRemaining = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 3; index += 1) {
    const clear = await clearCurrentPage(optionsClient, applyUrl);
    await sleep(2200);
    const afterClear = await inspectPage(pageClient);
    const remaining =
      Number(clear?.remainingFilledControls || 0) +
      Number(clear?.remainingOpenDropdowns || 0);
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
        .filter((text, index, all) => all.indexOf(text) === index);
      const beforeHref = location.href;
      const errors = visibleValidationErrors();
      if (errors.length) {
        return {
          clicked: false,
          reason: "visible_validation_errors",
          href: beforeHref,
          errors: errors.slice(0, 10)
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
    nextAction: fill.nextAction || null,
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
    const seedPayload = makeSeedPayload(args.resumePath, applyUrl, args);
    await seedExtension(optionsClient, seedPayload, args);
    if (!args.preserveCurrent) {
      await navigate(pageClient, applyUrl);
    }
    const startStep = await clickWorkdayStep(pageClient, args.startStep);

    const timeline = [];
    for (let i = 0; i < args.maxPages; i += 1) {
      const before = await inspectPage(pageClient);
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
        const fill = await fillCurrentPage(optionsClient, applyUrl);
        await sleep(
          args.extensionAutoNext
            ? 7500
            : before.currentStep?.current === 1 && args.mode === "resume"
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
          const clear = await clearCurrentPage(optionsClient, applyUrl);
          await sleep(1800);
          const afterClear = await inspectPage(pageClient);
          const refill = await fillCurrentPage(optionsClient, applyUrl);
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
        startStep: i === 0 && !startStep.skipped ? startStep : null,
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
      if (
        afterFill.hasSubmit ||
        /review/i.test(afterFill.currentStep?.title || "")
      ) {
        break;
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
          break;
        }
        await sleep(1200);
        continue;
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
