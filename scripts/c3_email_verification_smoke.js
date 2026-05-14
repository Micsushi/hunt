#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { checkMailAuth, verifyEmail } = require("./c3_mail_verify_bridge.js");

const DEFAULT_EXTENSION_ID = "cbdmkibihimaedoihjhpidclolglnncc";

function loadDotEnv(filePath = ".env") {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {
    provider: process.env.HUNT_C3_MAIL_PROVIDER || "fake",
    cdpPort: 9222,
    fixturePort: 8766,
    extensionId: DEFAULT_EXTENSION_ID,
    workdayUrl: process.env.HUNT_C3_TEST_WORKDAY_URL || "",
    accountEmail:
      process.env.HUNT_C3_TEST_ACCOUNT_EMAIL ||
      process.env.HUNT_C3_MAIL_EMAIL ||
      "c3-test@example.com",
    accountPassword:
      process.env.HUNT_C3_TEST_ACCOUNT_PASSWORD ||
      process.env.HUNT_C3_MAIL_PASSWORD ||
      "C3TestPassword!23",
    timeoutSeconds: Number(process.env.HUNT_C3_MAIL_MAX_WAIT_SECONDS || 90),
    resetSiteData: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--provider" && next) {
      args.provider = next;
      i += 1;
    } else if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--fixture-port" && next) {
      args.fixturePort = Number(next);
      i += 1;
    } else if (arg === "--extension-id" && next) {
      args.extensionId = next;
      i += 1;
    } else if (arg === "--workday-url" && next) {
      args.workdayUrl = next;
      i += 1;
    } else if (arg === "--account-email" && next) {
      args.accountEmail = next;
      i += 1;
    } else if (arg === "--account-password" && next) {
      args.accountPassword = next;
      i += 1;
    } else if (arg === "--timeout-seconds" && next) {
      args.timeoutSeconds = Number(next);
      i += 1;
    } else if (arg === "--reset-site-data") {
      args.resetSiteData = true;
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
    "Usage: node scripts/c3_email_verification_smoke.js [options]",
    "",
    "Options:",
    "  --provider fake|imap|gmail Verification provider, default fake",
    "  --cdp-port <port>          Chrome DevTools port, default 9222",
    "  --fixture-port <port>      Local fake fixture port, default 8766",
    "  --workday-url <url>        Real Workday URL for provider imap or gmail",
    "  --account-email <email>    Signup/login email",
    "  --account-password <pass>  Signup/login password",
    "  --timeout-seconds <n>      Mail wait timeout",
    "  --reset-site-data          Clear browser cookies and target origin storage first",
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function js(value) {
  return JSON.stringify(value);
}

function startFixtureServer(port) {
  const fixtureDir = path.resolve(
    process.cwd(),
    "executioner",
    "fixtures",
    "generic",
  );
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname =
      url.pathname === "/" ? "/signup_email_verification.html" : url.pathname;
    const filePath = path.resolve(fixtureDir, `.${pathname}`);
    if (!filePath.startsWith(fixtureDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": filePath.endsWith(".html")
        ? "text/html; charset=utf-8"
        : "application/octet-stream",
    });
    res.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
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

async function ensurePageTarget(port, pageUrl) {
  await httpText(port, `/json/new?${encodeURIComponent(pageUrl)}`, "PUT");
  await sleep(1200);
  const targets = await getTargets(port);
  const target = targets.find((item) => String(item.url || "") === pageUrl);
  if (!target) {
    throw new Error(`Could not open page target: ${pageUrl}`);
  }
  return target;
}

async function connectTarget(target) {
  return new CdpClient(target.webSocketDebuggerUrl).connect();
}

async function connectLatestWorkdayTarget(port, referenceUrl) {
  const referenceHost = new URL(referenceUrl).host;
  const targets = await getTargets(port);
  const workdayTargets = targets.filter((target) => {
    const url = String(target.url || "");
    return url.includes(referenceHost) && !url.startsWith("devtools://");
  });
  const preferred =
    workdayTargets.find((target) =>
      /\/login\b/i.test(String(target.url || "")),
    ) ||
    workdayTargets.find((target) =>
      /\/apply\/applyManually\b/i.test(String(target.url || "")),
    ) ||
    workdayTargets.at(-1);
  if (!preferred) {
    return null;
  }
  return connectTarget(preferred);
}

async function connectLatestWorkdayApplicationTarget(port, referenceUrl) {
  const referenceHost = new URL(referenceUrl).host;
  const targets = await getTargets(port);
  const workdayTargets = targets.filter((target) => {
    const url = String(target.url || "");
    return url.includes(referenceHost) && !url.startsWith("devtools://");
  });
  const preferred =
    [...workdayTargets]
      .reverse()
      .find(
        (target) =>
          /\/apply\/applyManually\b/i.test(String(target.url || "")) &&
          !/create account/i.test(String(target.title || "")),
      ) ||
    [...workdayTargets]
      .reverse()
      .find(
        (target) =>
          !/\/login\b/i.test(String(target.url || "")) &&
          !/create account/i.test(String(target.title || "")),
      ) ||
    [...workdayTargets]
      .reverse()
      .find((target) =>
        /\/apply\/applyManually\b/i.test(String(target.url || "")),
      );
  if (!preferred) {
    return null;
  }
  return connectTarget(preferred);
}

async function connectLatestWorkdayLoginTarget(port, referenceUrl) {
  const referenceHost = new URL(referenceUrl).host;
  const targets = await getTargets(port);
  const workdayTargets = targets.filter((target) => {
    const url = String(target.url || "");
    return url.includes(referenceHost) && !url.startsWith("devtools://");
  });
  const preferred =
    [...workdayTargets]
      .reverse()
      .find(
        (target) =>
          /\/login\b/i.test(String(target.url || "")) &&
          !/\/login\/(error|ok)\b/i.test(String(target.url || "")),
      ) ||
    [...workdayTargets]
      .reverse()
      .find((target) => /\/login\b/i.test(String(target.url || "")));
  if (!preferred) {
    return null;
  }
  return connectTarget(preferred);
}

async function seedExtension(optionsClient, args, applyUrl) {
  return optionsClient.evaluate(
    `(async () => {
      const profile = {
        fullName: "C3 Smoke Tester",
        email: ${js(args.accountEmail)},
        accountEmail: ${js(args.accountEmail)},
        accountPassword: ${js(args.accountPassword)},
        phone: "7800000000",
        location: "Edmonton, Alberta, Canada"
      };
      const activeApplyContext = {
        jobId: "c3-email-verification-smoke",
        title: "Email Verification Smoke",
        company: "Hunt",
        sourceMode: "manual",
        atsType: "generic",
        applyUrl: ${js(applyUrl)},
        jobUrl: ${js(applyUrl)}
      };
      const storedSettings = await chrome.storage.sync.get("hunt.apply.settings");
      await chrome.storage.sync.set({
        "hunt.apply.settings": {
          ...(storedSettings["hunt.apply.settings"] || {}),
          settingsVersion: 4,
          autoAccountSignupLoginEnabled: true,
          autoEmailVerificationEnabled: true,
          autoClickNextAfterFill: false,
          emailVerificationTimeoutSeconds: ${Number(args.timeoutSeconds || 90)}
        }
      });
      await chrome.storage.local.set({
        "hunt.apply.profile": profile,
        "hunt.apply.activeApplyContext": activeApplyContext
      });
      return await chrome.storage.local.get([
        "hunt.apply.profile",
        "hunt.apply.activeApplyContext"
      ]);
    })()`,
  );
}

async function fillCurrentPage(optionsClient, targetUrl) {
  return optionsClient.evaluate(
    `(async () => {
      const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
      const targetUrl = ${js(targetUrl)};
      const tab = tabs.find((item) => String(item.url || "") === targetUrl)
        || tabs.find((item) => String(item.url || "").startsWith(targetUrl.split("?")[0]))
        || tabs.find((item) => /^https:\\/\\/[^/]+\\.wd\\d+\\.myworkdayjobs\\.com\\//.test(String(item.url || "")));
      if (!tab) {
        return { ok: false, error: "target_tab_not_found" };
      }
      const wrapped = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "hunt.apply.fill_current_page", payload: { tabId: tab.id, triggeredBy: "email_verification_smoke" } },
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

async function submitSignup(pageClient) {
  return pageClient.evaluate(
    `(async () => {
      const form = document.getElementById("signup-form");
      if (!form) return { ok: false, reason: "signup_form_not_found" };
      form.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        ok: !document.getElementById("verification-needed")?.hidden,
        email: document.getElementById("email")?.value || "",
        passwordFilled: Boolean(document.getElementById("password")?.value),
        confirmMatches: document.getElementById("password")?.value === document.getElementById("confirm-password")?.value,
        signupStartedAt: document.body.dataset.signupSubmittedAt || ""
      };
    })()`,
  );
}

async function fillWorkdayAccountForm(pageClient, args) {
  await bringToFront(pageClient);
  return pageClient.evaluate(
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) {
          setter.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      };
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && (rect.width > 0 || rect.height > 0 || el.offsetParent !== null);
      };
      const inputs = [...document.querySelectorAll("input")]
        .filter((input) => input.type !== "hidden" && input.name !== "website" && visible(input));
      const textInputs = inputs.filter((input) => input.type === "text" || input.type === "email");
      const passwordInputs = inputs.filter((input) => input.type === "password");
      const checkbox = inputs.find((input) => input.type === "checkbox");
      if (textInputs[0]) {
        textInputs[0].focus();
        setValue(textInputs[0], ${js(args.accountEmail)});
      }
      if (passwordInputs[0]) {
        passwordInputs[0].focus();
        setValue(passwordInputs[0], ${js(args.accountPassword)});
      }
      if (passwordInputs[1]) {
        passwordInputs[1].focus();
        setValue(passwordInputs[1], ${js(args.accountPassword)});
      }
      if (checkbox && !checkbox.checked) {
        checkbox.scrollIntoView({ block: "center", inline: "center" });
        checkbox.click();
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await sleep(500);
      return {
        ok: Boolean(textInputs[0]?.value && passwordInputs[0]?.value && passwordInputs[1]?.value && (!checkbox || checkbox.checked)),
        emailFilled: Boolean(textInputs[0]?.value),
        passwordFilled: Boolean(passwordInputs[0]?.value),
        confirmFilled: Boolean(passwordInputs[1]?.value),
        consentChecked: Boolean(!checkbox || checkbox.checked),
        fieldCount: inputs.length
      };
    })()`,
  );
}

async function fillWorkdayLoginForm(pageClient, args) {
  await bringToFront(pageClient);
  return pageClient.evaluate(
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) {
          setter.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      };
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && (rect.width > 0 || rect.height > 0 || el.offsetParent !== null);
      };
      const inputs = [...document.querySelectorAll("input")]
        .filter((input) => input.type !== "hidden" && input.name !== "website" && visible(input));
      const emailInput = inputs.find((input) => input.type === "email") || inputs.find((input) => input.type === "text");
      const passwordInput = inputs.find((input) => input.type === "password");
      if (emailInput) {
        emailInput.focus();
        setValue(emailInput, ${js(args.accountEmail)});
      }
      if (passwordInput) {
        passwordInput.focus();
        setValue(passwordInput, ${js(args.accountPassword)});
      }
      await sleep(500);
      return {
        ok: Boolean(emailInput?.value && passwordInput?.value),
        emailFilled: Boolean(emailInput?.value),
        passwordFilled: Boolean(passwordInput?.value),
        fieldCount: inputs.length
      };
    })()`,
  );
}

async function ensureWorkdayLoginPage(pageClient) {
  await bringToFront(pageClient);
  const state = await pageClient.evaluate(
    `(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && (rect.width > 0 || rect.height > 0 || el.offsetParent !== null);
      };
      const fields = [...document.querySelectorAll("input")]
        .filter((input) => input.type !== "hidden" && input.name !== "website" && visible(input))
        .map((input) => input.type);
      const href = location.href;
      const text = document.body ? document.body.innerText.replace(/\\s+/g, " ").trim() : "";
      return {
        href,
        hasLoginFields: fields.some((type) => type === "password") && fields.some((type) => type === "text" || type === "email"),
        invalidToken: /invalid token|login\\/error/i.test([href, text].join(" "))
      };
    })()`,
  );
  if (state.hasLoginFields) {
    return { ok: true, href: state.href, reason: "login_fields_present" };
  }
  if (/\/login\/(error|ok)\b/i.test(state.href) || state.invalidToken) {
    const loginUrl = state.href.replace(/\/login\/(error|ok)\b/i, "/login");
    await navigate(pageClient, loginUrl);
    return { ok: true, href: loginUrl, reason: "normalized_login_url" };
  }
  return { ok: false, href: state.href, reason: "login_fields_not_found" };
}

async function pageHasAccountFields(pageClient) {
  await bringToFront(pageClient);
  return pageClient.evaluate(
    `(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && (rect.width > 0 || rect.height > 0 || el.offsetParent !== null);
      };
      const fields = [...document.querySelectorAll("input:not([type='hidden']), textarea")]
        .map((el) => ({
          id: el.id || "",
          name: el.name || "",
          type: el.type || "",
          autocomplete: el.autocomplete || "",
          placeholder: el.placeholder || "",
          label: el.getAttribute("aria-label") || "",
          value: el.type === "password" ? "" : String(el.value || "").slice(0, 80)
      }));
      const text = document.body ? document.body.innerText : "";
      const accountFieldCount = fields.filter((field) => /email|username|user|password/i.test([field.id, field.name, field.type, field.autocomplete, field.placeholder, field.label].join(" "))).length;
      return {
        ok: accountFieldCount > 0,
        fieldCount: fields.length,
        accountFieldCount,
        fields: fields.slice(0, 20),
        verificationNeeded: /verify|verification|check your email|confirm your email/i.test(text),
        signedInOrAdvanced: /Settings\\s+\\S+@\\S+|Candidate Home|current step\\s+\\d+\\s+of\\s+\\d+\\s+(?!Create Account\\/Sign In)(My Information|My Experience|Application Questions|Voluntary Disclosures|Review)|Resume\\/CV/i.test(text),
        bodyHead: text.replace(/\\s+/g, " ").trim().slice(0, 800),
        href: location.href
      };
    })()`,
  );
}

async function clickSafeAccountAction(pageClient) {
  await bringToFront(pageClient);
  const clickResult = await pageClient.evaluate(
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.innerText,
        el.textContent
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
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
      const forbidden = /(submit application|final submit|submit my application|send application|withdraw|delete)/i;
      const unsafeNavigation = /^(skip to main content|search for jobs|back to job posting|read more|forgot your password\\?|linkedin)\\b/i;
      const allowed = (button) => !forbidden.test(button.text) && !unsafeNavigation.test(button.text);
      const preferred = [
        /^(create account|sign up|signup|register)$/i,
        /^(sign in|log in|login)$/i,
        /^(continue|next)$/i,
        /^(verify email|send verification|resend verification)$/i,
        /^(apply manually)$/i,
        /^apply\\b/i,
        /^(apply now)$/i,
        /^apply for this job$/i
      ];
      const readButtons = () => [...document.querySelectorAll("button, [role='button'], a")]
        .filter(visible)
        .map((el) => ({
          el,
          text: textOf(el),
          disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
          href: el.href || "",
          automation: el.getAttribute("data-automation-id") || "",
          tag: el.tagName || ""
        }))
        .filter((item) => item.text && !item.disabled);
      const findCandidate = () => {
        const buttons = readButtons();
        const candidate = buttons.find((button) => allowed(button) && preferred.some((pattern) => pattern.test(button.text)))
          || [...document.querySelectorAll('a[role="button"], a[data-automation-id], a[href*="/apply"]')]
            .filter(visible)
            .map((el) => ({ el, text: textOf(el), href: el.href || "", automation: el.getAttribute("data-automation-id") || "" }))
            .find((item) => {
              const text = item.text || item.automation || item.href;
              return allowed({ text }) && (
                item.automation === "adventureButton" ||
                /^apply\\b/i.test(text) ||
                /\\/apply(\\?|$|\\/)/i.test(item.href)
              );
            });
        return { candidate, buttons };
      };
      const beforeHref = location.href;
      let candidate = null;
      let buttons = [];
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const found = findCandidate();
        candidate = found.candidate;
        buttons = found.buttons;
        if (candidate) {
          break;
        }
        await sleep(500);
      }
      if (!candidate) {
        return {
          ok: false,
          clicked: false,
          reason: "safe_account_action_not_found",
          href: beforeHref,
          buttons: buttons.map((button) => button.text).slice(0, 20)
        };
      }
      if (candidate.href && /\\/apply(\\?|$|\\/)/i.test(candidate.href)) {
        return {
          ok: true,
          clicked: true,
          label: candidate.text,
          beforeHref,
          href: beforeHref,
          navigateTo: candidate.href,
          verificationNeeded: false,
          loginNeeded: false,
          bodyHead: ""
        };
      }
      clickReal(candidate.el);
      return {
        ok: true,
        clicked: true,
        label: candidate.text,
        beforeHref,
        href: beforeHref,
        verificationNeeded: false,
        loginNeeded: false,
        bodyHead: ""
      };
    })()`,
    30000,
  );
  if (clickResult?.navigateTo) {
    await navigate(pageClient, clickResult.navigateTo);
    return {
      ...clickResult,
      href: clickResult.navigateTo,
      navigatedByCdp: true,
    };
  }
  await sleep(5500);
  return clickResult;
}

async function clickSignInAction(pageClient) {
  await bringToFront(pageClient);
  const result = await pageClient.evaluate(
    `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.innerText,
        el.textContent
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
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
      const candidates = [...document.querySelectorAll("button, [role='button'], a")]
        .filter(visible)
        .map((el) => ({
          el,
          text: textOf(el),
          href: el.href || "",
          disabled: el.disabled || el.getAttribute("aria-disabled") === "true"
        }))
        .filter((item) => item.text && !item.disabled);
      const candidate = candidates.find((item) => /^(sign in|log in|login)$/i.test(item.text))
        || candidates.find((item) => /already have an account|sign in|log in|login/i.test(item.text));
      if (!candidate) {
        return {
          ok: false,
          clicked: false,
          reason: "sign_in_action_not_found",
          buttons: candidates.map((item) => item.text).slice(0, 20),
          href: location.href
        };
      }
      if (candidate.href) {
        return {
          ok: true,
          clicked: true,
          label: candidate.text,
          navigateTo: candidate.href,
          href: location.href
        };
      }
      clickReal(candidate.el);
      await sleep(800);
      return {
        ok: true,
        clicked: true,
        label: candidate.text,
        href: location.href
      };
    })()`,
    30000,
  );
  if (result?.navigateTo) {
    await navigate(pageClient, result.navigateTo);
    return { ...result, href: result.navigateTo, navigatedByCdp: true };
  }
  await sleep(2500);
  return result;
}

async function signInFromCurrentAccountState(pageClient, args, referenceUrl) {
  const signInClick = await clickSignInAction(pageClient);
  const loginPage = signInClick.ok
    ? await ensureWorkdayLoginPage(pageClient)
    : { ok: false, reason: signInClick.reason || "sign_in_action_failed" };
  if (!loginPage.ok) {
    return {
      ok: false,
      signInClick,
      loginPage,
      reason: loginPage.reason || "login_page_not_reached",
    };
  }
  const loginFill = await fillWorkdayLoginForm(pageClient, args);
  const loginSubmit = loginFill.ok
    ? await clickSafeAccountAction(pageClient)
    : { ok: false, reason: "login_fill_failed" };
  const postLoginClient =
    (await connectLatestWorkdayApplicationTarget(args.cdpPort, referenceUrl)) ||
    pageClient;
  const loginState = await inspectApplicationState(postLoginClient);
  return {
    ok: Boolean(
      loginFill.ok && loginSubmit.ok && loginState.signedInOrAdvanced,
    ),
    signInClick,
    loginPage,
    loginFill,
    loginSubmit,
    loginState,
    client: postLoginClient,
    switchedClient: postLoginClient !== pageClient,
  };
}

async function reachAccountForm(pageClient, maxSteps = 6) {
  const steps = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const state = await pageHasAccountFields(pageClient);
    steps.push({
      step: i,
      href: state.href,
      fieldCount: state.fieldCount,
      hasAccountFields: state.ok,
      verificationNeeded: state.verificationNeeded,
      signedInOrAdvanced: state.signedInOrAdvanced,
    });
    if (state.ok || state.verificationNeeded || state.signedInOrAdvanced) {
      return {
        ok: true,
        reason: state.signedInOrAdvanced
          ? "already_signed_in_or_advanced"
          : state.ok
            ? "account_fields_found"
            : "verification_needed",
        steps,
        state,
      };
    }
    const click = await clickSafeAccountAction(pageClient);
    steps.push({
      step: i,
      clicked: click.clicked,
      label: click.label || "",
      reason: click.reason || "",
      href: click.href || "",
    });
    if (!click.ok || !click.clicked) {
      return {
        ok: false,
        reason: click.reason || "account_action_not_found",
        steps,
        state,
      };
    }
  }
  const state = await pageHasAccountFields(pageClient);
  return {
    ok: Boolean(
      state.ok || state.verificationNeeded || state.signedInOrAdvanced,
    ),
    reason: state.signedInOrAdvanced
      ? "already_signed_in_or_advanced"
      : state.ok
        ? "account_fields_found"
        : "max_steps_reached",
    steps,
    state,
  };
}

function compactFillResult(fillResult) {
  return {
    ok: Boolean(fillResult?.ok),
    message: fillResult?.message || "",
    error: fillResult?.error || "",
    filledFieldCount:
      fillResult?.attempt?.filledFieldCount ||
      fillResult?.result?.filledFieldCount ||
      0,
    manualReviewReasons:
      fillResult?.attempt?.manualReviewReasons ||
      fillResult?.result?.manualReviewReasons ||
      [],
    fields: (fillResult?.result?.fieldInventory || [])
      .map((field) => ({
        id: field.id || "",
        name: field.name || "",
        type: field.type || "",
        descriptor: String(field.descriptor || "").slice(0, 120),
        filled: Boolean(field.filled),
        skippedReason: field.skippedReason || "",
        valueSource: field.valueSource || "",
      }))
      .slice(0, 20),
  };
}

async function navigate(pageClient, url) {
  await pageClient.send("Page.enable");
  await pageClient.send("Page.navigate", { url });
  await bringToFront(pageClient);
  await sleep(1200);
}

async function resetBrowserSiteData(pageClient, targetUrl) {
  const origin = new URL(targetUrl).origin;
  await pageClient.send("Network.enable").catch(() => null);
  await pageClient.send("Network.clearBrowserCookies").catch(() => null);
  await pageClient
    .send("Storage.clearDataForOrigin", {
      origin,
      storageTypes: "all",
    })
    .catch(() => null);
  return { ok: true, origin, cookiesCleared: true };
}

async function bringToFront(pageClient) {
  try {
    await pageClient.send("Page.bringToFront", {}, 5000);
    await sleep(300);
  } catch (_error) {
    // Some non-page targets cannot be focused. The caller can still continue.
  }
}

async function inspectVerified(pageClient) {
  return pageClient.evaluate(
    `(() => ({
      href: location.href,
      verified: document.querySelector("[data-email-verified='true']") !== null,
      text: document.body ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 400) : ""
    }))()`,
  );
}

async function inspectApplicationState(pageClient) {
  await bringToFront(pageClient);
  return pageClient.evaluate(
    `(() => {
      const text = document.body ? document.body.innerText.replace(/\\s+/g, " ").trim() : "";
      return {
        href: location.href,
        title: document.title,
        verificationNeeded: /verify|verification|check your email|confirm your email/i.test(text),
        signedInOrAdvanced: /Settings\\s+\\S+@\\S+|Candidate Home|current step\\s+\\d+\\s+of\\s+\\d+\\s+(?!Create Account\\/Sign In)(My Information|My Experience|Application Questions|Voluntary Disclosures|Review)|Resume\\/CV/i.test(text),
        accountError: /already exists|invalid|error:|please check|required/i.test(text) || (/already have an account/i.test(text) && !/already have an account\\?\\s*sign in/i.test(text)),
        bodyHead: text.slice(0, 1000)
      };
    })()`,
  );
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.provider !== "fake" && !args.workdayUrl) {
    throw new Error("--workday-url is required for non-fake providers");
  }
  if (args.provider !== "fake") {
    const auth = await checkMailAuth({ provider: args.provider });
    if (!auth.ok) {
      throw new Error(
        `Mailbox auth preflight failed before opening Workday: ${JSON.stringify(auth)}`,
      );
    }
  }

  let fixtureServer = null;
  let pageClient = null;
  let optionsClient = null;
  try {
    let targetUrl = args.workdayUrl;
    if (args.provider === "fake") {
      fixtureServer = await startFixtureServer(args.fixturePort);
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      targetUrl = `http://127.0.0.1:${args.fixturePort}/signup_email_verification.html?${runId}`;
      process.env.HUNT_C3_FAKE_VERIFY_LINK = `http://127.0.0.1:${args.fixturePort}/email_verified.html`;
    }
    const optionsTarget = await ensureOptionsTarget(
      args.cdpPort,
      args.extensionId,
    );
    optionsClient = await connectTarget(optionsTarget);
    await seedExtension(optionsClient, args, targetUrl);

    const pageTarget = await ensurePageTarget(args.cdpPort, targetUrl);
    pageClient = await connectTarget(pageTarget);
    const resetSiteData = args.resetSiteData
      ? await resetBrowserSiteData(pageClient, targetUrl)
      : null;
    await navigate(pageClient, targetUrl);

    const reachResult =
      args.provider === "fake"
        ? { ok: true, reason: "fake_fixture" }
        : await reachAccountForm(pageClient);
    if (!reachResult.ok) {
      throw new Error(
        `Could not reach account form: ${JSON.stringify(reachResult)}`,
      );
    }
    const fillTargetUrl = reachResult.state?.href || targetUrl;
    if (args.provider !== "fake" && reachResult.state?.signedInOrAdvanced) {
      const applicationState = await inspectApplicationState(pageClient);
      console.log(
        JSON.stringify(
          {
            ok: true,
            provider: args.provider,
            resetSiteData,
            reason: "already_signed_in_or_advanced",
            fill: {
              ok: false,
              skipped: true,
              reason: "account_login_not_needed",
            },
            submit: {
              ok: true,
              skipped: true,
              reason: "already_signed_in_or_advanced",
              email: args.accountEmail,
            },
            bridge: {
              ok: true,
              skipped: true,
              reason: "already_verified_or_session_active",
            },
            verified: applicationState,
            login: {
              ok: true,
              skipped: true,
              state: applicationState,
            },
          },
          null,
          2,
        ),
      );
      return;
    }
    const fillResult =
      args.provider === "fake"
        ? await fillCurrentPage(optionsClient, fillTargetUrl)
        : {
            ok: false,
            skipped: true,
            reason: "workday_account_form_uses_deterministic_fill",
          };
    const workdayAccountFill =
      args.provider === "fake"
        ? { ok: true, skipped: true }
        : await fillWorkdayAccountForm(pageClient, args);
    const submitStartedAt = new Date().toISOString();
    const submitResult =
      args.provider === "fake"
        ? await submitSignup(pageClient)
        : {
            ...(await clickSafeAccountAction(pageClient)),
            email: args.accountEmail,
            signupStartedAt: submitStartedAt,
          };
    if ((!fillResult.ok && !workdayAccountFill.ok) || !submitResult.ok) {
      throw new Error(
        `Signup setup failed: ${JSON.stringify({
          reachResult,
          fillResult: compactFillResult(fillResult),
          workdayAccountFill,
          submitResult,
        })}`,
      );
    }
    if (args.provider === "fake" && !submitResult.confirmMatches) {
      throw new Error("Confirm password was not filled to match password.");
    }

    const postSubmitClient =
      args.provider === "fake"
        ? pageClient
        : (await connectLatestWorkdayTarget(args.cdpPort, fillTargetUrl)) ||
          pageClient;
    if (postSubmitClient !== pageClient) {
      pageClient.close();
      pageClient = postSubmitClient;
    }
    const postSubmitState = await inspectApplicationState(pageClient);
    if (args.provider !== "fake" && postSubmitState.signedInOrAdvanced) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            provider: args.provider,
            resetSiteData,
            fill: {
              ok: Boolean(fillResult.ok || workdayAccountFill.ok),
              filledFieldCount:
                fillResult.attempt?.filledFieldCount ||
                fillResult.result?.filledFieldCount ||
                0,
              workdayAccountFill,
            },
            submit: submitResult,
            bridge: {
              ok: true,
              skipped: true,
              reason: "workday_advanced_without_email_verification",
            },
            verified: postSubmitState,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (
      args.provider !== "fake" &&
      postSubmitState.accountError &&
      !postSubmitState.verificationNeeded
    ) {
      const signIn = await signInFromCurrentAccountState(
        pageClient,
        args,
        fillTargetUrl,
      );
      if (signIn.switchedClient && signIn.client) {
        pageClient.close();
        pageClient = signIn.client;
      }
      if (signIn.ok) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              provider: args.provider,
              resetSiteData,
              reason: "signup_account_exists_signin_succeeded",
              fill: {
                ok: Boolean(fillResult.ok || workdayAccountFill.ok),
                filledFieldCount:
                  fillResult.attempt?.filledFieldCount ||
                  fillResult.result?.filledFieldCount ||
                  0,
                workdayAccountFill,
              },
              submit: submitResult,
              bridge: {
                ok: true,
                skipped: true,
                reason: "account_existed_no_verification_needed",
              },
              login: {
                page: signIn.loginPage,
                fill: signIn.loginFill,
                submit: signIn.loginSubmit,
                state: signIn.loginState,
              },
            },
            null,
            2,
          ),
        );
        return;
      }
    }

    const expectedVerificationHosts =
      args.provider === "fake" ? ["127.0.0.1"] : [new URL(fillTargetUrl).host];
    const verificationSince =
      submitResult.signupStartedAt ||
      submitStartedAt ||
      new Date().toISOString();
    const bridgeResult = await verifyEmail(
      {
        email: submitResult.email || args.accountEmail,
        expectedDomains: expectedVerificationHosts,
        since: verificationSince,
        timeoutSeconds: args.timeoutSeconds,
      },
      { provider: args.provider },
    );
    if (!bridgeResult.ok) {
      if (args.provider !== "fake") {
        const loginClient =
          (await connectLatestWorkdayLoginTarget(
            args.cdpPort,
            fillTargetUrl,
          )) || pageClient;
        if (loginClient !== pageClient) {
          pageClient.close();
          pageClient = loginClient;
        }
        const loginPage = await ensureWorkdayLoginPage(pageClient);
        const loginFill = loginPage.ok
          ? await fillWorkdayLoginForm(pageClient, args)
          : { ok: false, reason: loginPage.reason || "login_page_not_reached" };
        const loginSubmit = loginFill.ok
          ? await clickSafeAccountAction(pageClient)
          : { ok: false, reason: "login_fill_failed" };
        const postLoginClient =
          (await connectLatestWorkdayApplicationTarget(
            args.cdpPort,
            fillTargetUrl,
          )) || pageClient;
        if (postLoginClient !== pageClient) {
          pageClient.close();
          pageClient = postLoginClient;
        }
        const loginState = await inspectApplicationState(pageClient);
        if (loginFill.ok && loginSubmit.ok && loginState.signedInOrAdvanced) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                provider: args.provider,
                resetSiteData,
                reason: "verification_timeout_signin_succeeded",
                fill: {
                  ok: Boolean(fillResult.ok || workdayAccountFill.ok),
                  filledFieldCount:
                    fillResult.attempt?.filledFieldCount ||
                    fillResult.result?.filledFieldCount ||
                    0,
                  workdayAccountFill,
                },
                submit: submitResult,
                bridge: bridgeResult,
                login: {
                  page: loginPage,
                  fill: loginFill,
                  submit: loginSubmit,
                  state: loginState,
                },
              },
              null,
              2,
            ),
          );
          return;
        }
      }
      throw new Error(
        `Verification bridge failed: ${JSON.stringify(bridgeResult)}`,
      );
    }

    await navigate(pageClient, bridgeResult.link);
    const verified = await inspectVerified(pageClient);
    const loginPage =
      args.provider === "fake"
        ? { ok: true, skipped: true }
        : await ensureWorkdayLoginPage(pageClient);
    if (args.provider !== "fake") {
      const loginClient =
        (await connectLatestWorkdayLoginTarget(args.cdpPort, fillTargetUrl)) ||
        pageClient;
      if (loginClient !== pageClient) {
        pageClient.close();
        pageClient = loginClient;
      }
    }
    const loginFill =
      args.provider === "fake"
        ? { ok: true, skipped: true }
        : await fillWorkdayLoginForm(pageClient, args);
    const loginSubmit =
      args.provider === "fake"
        ? { ok: true, skipped: true }
        : await clickSafeAccountAction(pageClient);
    const postLoginClient =
      args.provider === "fake"
        ? pageClient
        : (await connectLatestWorkdayApplicationTarget(
            args.cdpPort,
            fillTargetUrl,
          )) || pageClient;
    if (postLoginClient !== pageClient) {
      pageClient.close();
      pageClient = postLoginClient;
    }
    const loginState =
      args.provider === "fake"
        ? { ok: true, skipped: true }
        : await inspectApplicationState(pageClient);
    const result = {
      ok: Boolean(
        verified.verified ||
        (args.provider !== "fake" &&
          loginFill.ok &&
          loginSubmit.ok &&
          loginState.signedInOrAdvanced),
      ),
      provider: args.provider,
      resetSiteData,
      fill: {
        ok: Boolean(fillResult.ok || workdayAccountFill.ok),
        filledFieldCount:
          fillResult.attempt?.filledFieldCount ||
          fillResult.result?.filledFieldCount ||
          0,
        workdayAccountFill,
      },
      submit: submitResult,
      bridge: {
        ok: bridgeResult.ok,
        source: bridgeResult.source,
        subject: bridgeResult.subject,
        linkHost: new URL(bridgeResult.link).host,
      },
      verified,
      login: {
        page: loginPage,
        fill: loginFill,
        submit: loginSubmit,
        state: loginState,
      },
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (pageClient) {
      pageClient.close();
    }
    if (optionsClient) {
      optionsClient.close();
    }
    if (fixtureServer) {
      fixtureServer.close();
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
