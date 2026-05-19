#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { checkMailAuth, verifyEmail } = require("./c3_mail_verify_bridge.js");
const { CdpClient, httpJson, httpText, js, sleep } = require("./lib/c3_cdp");
const { GoogleSignInManager } = require("./lib/c3_google_signin");

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
    accountMethod: process.env.HUNT_C3_ACCOUNT_METHOD || "email",
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
    } else if (arg === "--account-method" && next) {
      args.accountMethod = next;
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
    "  --account-method <method>  email or google, default env or email",
    "  --timeout-seconds <n>      Mail wait timeout",
    "  --reset-site-data          Clear browser cookies and target origin storage first",
  ].join("\n");
}

const workflowEvents = [];

function recordWorkflowEvent(phase, action, status, summary, details = {}) {
  const event = {
    phase,
    action,
    status,
    summary,
    details,
    at: new Date().toISOString(),
  };
  workflowEvents.push(event);
  const detailText = Object.keys(details).length
    ? ` ${JSON.stringify(details)}`
    : "";
  console.error(`[c3][${phase}][${status}] ${summary}${detailText}`);
  return event;
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

async function connectLatestGoogleTarget(port) {
  const targets = await getTargets(port);
  const googleTargets = targets.filter((target) =>
    /accounts\.google\.com|\/signin\/oauth/i.test(String(target.url || "")),
  );
  const preferred = googleTargets[0];
  if (!preferred) {
    return null;
  }
  return connectTarget(preferred);
}

async function seedExtension(optionsClient, args, applyUrl) {
  return optionsClient.evaluate(
    `(async () => {
      const profile = {
        fullName: "Michael Shi",
        firstName: "Michael",
        lastName: "Shi",
        email: ${js(args.accountEmail)},
        accountEmail: ${js(args.accountEmail)},
        accountPassword: ${js(args.accountPassword)},
        phone: "7809876543",
        location: "Edmonton, Alberta, Canada",
        city: "Edmonton",
        province: "Alberta",
        country: "Canada",
        addressLine1: "123 Main Street NW",
        postalCode: "T6G 2R3",
        applicationSource: "Job Board",
        yearsOfExperience: "5",
        linkedinUrl: "https://www.linkedin.com/in/michaelshi"
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
      const storedRuntime = await chrome.storage.local.get("hunt.apply.runtimeConfig");
      await chrome.storage.local.set({
        "hunt.apply.runtimeConfig": {
          ...(storedRuntime["hunt.apply.runtimeConfig"] || {}),
          autoAccountSignupLoginEnabled: true,
          autoEmailVerificationEnabled: true,
          autoClickNextAfterFill: false,
          emailVerificationTimeoutSeconds: ${Number(args.timeoutSeconds || 90)},
          configuredBy: "scripts/c3_email_verification_smoke.js",
          configuredAt: new Date().toISOString()
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

async function dismissCookieConsent(pageClient) {
  await bringToFront(pageClient);
  return pageClient.evaluate(
    `(async () => {
      const acceptBtn = [...document.querySelectorAll("button, a, [role='button']")].find((el) => {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        return /^accept cookies?$/i.test(t) || /^accept all$/i.test(t);
      });
      if (!acceptBtn) return { ok: false, reason: "no_cookie_consent_button" };
      acceptBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { ok: true };
    })()`,
  );
}

async function fillWorkdayAccountForm(pageClient, args) {
  await dismissCookieConsent(pageClient).catch(() => {});
  const readyState = await waitForWorkdayPageReady(pageClient);
  if (readyState.stillLoading || readyState.pageKind === "loading") {
    return {
      ok: false,
      reason: "workday_page_still_loading",
      readyState,
    };
  }
  if (readyState.pageKind === "signin_choice") {
    await clickSafeAccountAction(pageClient, "email");
    await waitForWorkdayPageReady(pageClient);
  }
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
      const confirmRequired = passwordInputs.length > 1;
      return {
        ok: Boolean(textInputs[0]?.value && passwordInputs[0]?.value && (!confirmRequired || passwordInputs[1]?.value) && (!checkbox || checkbox.checked)),
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
  await dismissCookieConsent(pageClient).catch(() => {});
  const readyState = await waitForWorkdayPageReady(pageClient);
  if (readyState.stillLoading || readyState.pageKind === "loading") {
    return {
      ok: false,
      reason: "workday_page_still_loading",
      readyState,
    };
  }
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

async function enterVerificationCode(pageClient, code) {
  await bringToFront(pageClient);
  return pageClient.evaluate(
    `(async () => {
      const verificationCode = ${js(String(code || "").replace(/\D/g, ""))};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        if (!el || el.disabled || el.getAttribute?.("aria-disabled") === "true") return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => normalize([
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("title"),
        el?.getAttribute?.("placeholder"),
        el?.innerText,
        el?.textContent,
        el?.value
      ].filter(Boolean).join(" "));
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const inputs = [...document.querySelectorAll("input")]
        .filter(visible)
        .filter((input) => {
          const type = String(input.type || "text").toLowerCase();
          const text = textOf(input);
          return !["hidden", "checkbox", "radio", "password", "file", "submit"].includes(type) &&
            (["text", "tel", "number", "search", ""].includes(type) || /code|otp|verification|passcode|one-time|security/i.test(text));
        });
      if (!verificationCode || !inputs.length) {
        return { ok: false, reason: "verification_code_inputs_not_found", fieldCount: inputs.length, href: location.href };
      }
      const digitBoxes = inputs.filter((input) => Number(input.maxLength || input.getAttribute("maxlength") || 0) === 1 || input.getBoundingClientRect().width <= 80);
      if (digitBoxes.length >= verificationCode.length) {
        digitBoxes.slice(0, verificationCode.length).forEach((input, index) => {
          input.focus();
          setValue(input, verificationCode[index]);
        });
      } else {
        const input = inputs
          .map((candidate, index) => ({
            candidate,
            score: (/code|otp|verification|passcode|one-time|security/i.test(textOf(candidate)) ? 10 : 0) - index
          }))
          .sort((a, b) => b.score - a.score)[0].candidate;
        input.focus();
        setValue(input, verificationCode);
      }
      await sleep(300);
      const submit = [...document.querySelectorAll("button, [role='button'], input[type='submit']")]
        .filter(visible)
        .map((el) => ({ el, text: textOf(el) }))
        .find((item) => !/(submit application|final submit|submit my application|withdraw|delete)/i.test(item.text) && /^(verify|continue|next|submit|confirm)\\b/i.test(item.text));
      if (submit) {
        submit.el.scrollIntoView({ block: "center", inline: "nearest" });
        submit.el.click();
      }
      await sleep(800);
      return {
        ok: true,
        method: digitBoxes.length >= verificationCode.length ? "digit_boxes" : "single_input",
        clickedSubmit: Boolean(submit),
        href: location.href
      };
    })()`,
  );
}

async function ensureWorkdayLoginPage(pageClient) {
  const readyState = await waitForWorkdayPageReady(pageClient);
  if (
    readyState.pageKind === "signin_choice" ||
    readyState.pageKind === "apply_choice" ||
    readyState.pageKind === "job_posting"
  ) {
    return {
      ok: false,
      href: readyState.href,
      reason: `${readyState.pageKind}_not_login_form`,
      pageKind: readyState.pageKind,
    };
  }
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
      const passwordCount = fields.filter((type) => type === "password").length;
      const href = location.href;
      const text = document.body ? document.body.innerText.replace(/\\s+/g, " ").trim() : "";
      return {
        href,
        pageKind: ${js(readyState.pageKind)},
        hasLoginFields: passwordCount === 1 && fields.some((type) => type === "text" || type === "email"),
        passwordCount,
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
  const readyState = await waitForWorkdayPageReady(pageClient);
  await bringToFront(pageClient);
  const accountState = await pageClient.evaluate(
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
      const passwordCount = fields.filter((field) => field.type === "password").length;
      const hasEmailField = fields.some((field) => /email|username|user/i.test([field.id, field.name, field.type, field.autocomplete, field.placeholder, field.label].join(" ")));
      const buttonRecords = [...document.querySelectorAll("button, [role='button'], a")]
        .filter((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        })
        .map((el) => ({
          text: [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.innerText,
            el.textContent
          ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim(),
          automation: el.getAttribute("data-automation-id") || "",
        }))
        .filter((button) => button.text || button.automation);
      const buttons = buttonRecords
        .map((button) => button.text || button.automation)
        .filter(Boolean);
      const isEmailSignInAction = (button) => {
        const combined = [button.automation, button.text].filter(Boolean).join(" ");
        if (/\\b(google|apple|linkedin|facebook|sso|oauth)\\b/i.test(combined)) {
          return false;
        }
        return /\\bsign\\b/i.test(combined) && /\\bemail\\b/i.test(combined);
      };
      return {
        ok: accountFieldCount > 0,
        fieldCount: fields.length,
        accountFieldCount,
        isSignupForm: hasEmailField && passwordCount > 1,
        isLoginForm: hasEmailField && passwordCount === 1,
        hasCreateAccountAction: buttons.some((label) => /^(create account|sign up|signup|register)\\b/i.test(label)),
        hasSignInWithEmailAction: buttonRecords.some(isEmailSignInAction),
        hasGoogleAction: buttons.some((label) => /sign\\s*in\\s*with\\s*google|continue\\s*with\\s*google|google/i.test(label)),
        buttons: buttons.slice(0, 20),
        fields: fields.slice(0, 20),
        verificationNeeded: /verify|verification|check your email|confirm your email/i.test(text),
        signedInOrAdvanced: /Settings\\s+\\S+@\\S+|Candidate Home|current step\\s+\\d+\\s+of\\s+\\d+\\s+(?!Create Account\\/Sign In)(My Information|My Experience|Application Questions|Voluntary Disclosures|Review)|Resume\\/CV/i.test(text),
        signedInEmail: (text.match(/Settings\\s+(\\S+@\\S+)/i) || [])[1] || "",
        bodyHead: text.replace(/\\s+/g, " ").trim().slice(0, 800),
        href: location.href
      };
    })()`,
  );
  return {
    ...accountState,
    pageKind: readyState.pageKind,
    stillLoading: readyState.stillLoading,
    pageReadyTimedOut: Boolean(readyState.timedOut),
    pageReadyWaitedMs: readyState.waitedMs || 0,
    loadingNodeCount: readyState.loadingNodeCount || 0,
  };
}

async function clickSafeAccountAction(pageClient, intent = "auto") {
  await bringToFront(pageClient);
  const clickResult = await pageClient.evaluate(
    `(async () => {
      const intent = ${js(intent)};
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
      const clickTarget = (target) => {
        target.scrollIntoView({ block: "center", inline: "center" });
        const rect = target.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      };
      const forbidden = /(submit application|final submit|submit my application|send application|withdraw|delete)/i;
      const unsafeNavigation = /^(skip to main content|search for jobs|back to job posting|read more|forgot your password\\?|linkedin)\\b/i;
      const allowed = (button) => !forbidden.test(button.text) && !unsafeNavigation.test(button.text);
      const verificationActionPatterns = [
        /^(resend account verification)\\b/i,
        /^(resend verification|resend verification email)\\b/i,
        /^(send verification|send verification email)\\b/i,
        /^(verify email|verify account)\\b/i
      ];
      const emailSignInPattern = /^(?=.*\\bsign\\b)(?=.*\\bemail\\b)(?!.*\\b(google|apple|linkedin|facebook|sso|oauth)\\b).*$/i;
      const preferredByIntent = {
        "apply": [/^(apply manually)$/i, /^(apply now)$/i, /^apply for this job$/i, /^apply\\b/i],
        "email": [emailSignInPattern],
        "create": [/^(create account|sign up|signup|register)\\b/i],
        "verify": verificationActionPatterns,
        "submit": [/^(continue|next)\\b/i, ...verificationActionPatterns, /^(sign in|log in|login)\\b/i],
        "auto": [
          /^(apply manually)$/i,
          emailSignInPattern,
          /^(create account|sign up|signup|register)\\b/i,
          /^(continue|next)\\b/i,
          ...verificationActionPatterns,
          /^(sign in|log in|login)\\b/i,
          /^apply\\b/i,
          /^(apply now)$/i,
          /^apply for this job$/i
        ]
      };
      const automationByIntent = {
        "apply": ["adventureButton"],
        "email": ["SignInWithEmailButton"],
        "create": ["createAccountSubmitButton"],
        "verify": ["informationalBlurbButton"],
        "submit": ["signInSubmitButton", "createAccountSubmitButton", "informationalBlurbButton"],
        "auto": ["adventureButton", "SignInWithEmailButton", "createAccountSubmitButton", "signInSubmitButton", "informationalBlurbButton"]
      };
      const preferred = preferredByIntent[intent] || preferredByIntent.auto;
      const preferredAutomation =
        automationByIntent[intent] || automationByIntent.auto;
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
        const preferredButtons = buttons
          .map((button, index) => ({
            button,
            index,
            automationIndex: preferredAutomation.indexOf(button.automation),
            preferredIndex: preferred.findIndex((pattern) =>
              pattern.test(button.automation + " " + button.text),
            ),
          }))
          .filter(
            (item) =>
              allowed(item.button) &&
              (item.automationIndex >= 0 || item.preferredIndex >= 0),
          )
          .sort(
            (a, b) =>
              (a.automationIndex >= 0 ? a.automationIndex : 999) -
                (b.automationIndex >= 0 ? b.automationIndex : 999) ||
              (a.preferredIndex >= 0 ? a.preferredIndex : 999) -
                (b.preferredIndex >= 0 ? b.preferredIndex : 999) ||
              a.index - b.index,
          );
        const candidate = preferredButtons[0]?.button
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
        if (attempt > 0 && attempt % 4 === 0) {
          window.scrollTo({
            top: Math.round(document.body.scrollHeight * Math.min(0.8, attempt / 30)),
            behavior: "instant"
          });
          await sleep(250);
        }
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
          intent,
          href: beforeHref,
          buttons: buttons.map((button) => button.text).slice(0, 20)
        };
      }
      if (candidate.href && /\\/apply(\\?|$|\\/)/i.test(candidate.href)) {
        return {
          ok: true,
          clicked: true,
          label: candidate.text,
          intent,
          beforeHref,
          href: beforeHref,
          navigateTo: candidate.href,
          verificationNeeded: false,
          loginNeeded: false,
          bodyHead: ""
        };
      }
      const target = clickTarget(candidate.el);
      // Workday auth buttons can ignore synthetic DOM pointer/mouse events.
      // Return coordinates and click with CDP Input.dispatchMouseEvent outside the page.
      return {
        ok: true,
        clicked: true,
        label: candidate.text,
        automation: candidate.automation || "",
        intent,
        beforeHref,
        href: beforeHref,
        clickTarget: target,
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
  if (clickResult?.clickTarget?.x != null && clickResult?.clickTarget?.y != null) {
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: clickResult.clickTarget.x,
      y: clickResult.clickTarget.y,
      button: "none",
    });
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clickResult.clickTarget.x,
      y: clickResult.clickTarget.y,
      button: "left",
      clickCount: 1,
    });
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clickResult.clickTarget.x,
      y: clickResult.clickTarget.y,
      button: "left",
      clickCount: 1,
    });
    clickResult.trustedCdpClick = true;
    delete clickResult.clickTarget;
  }
  await sleep(5500);
  return clickResult;
}

async function clickSignInAction(pageClient) {
  await bringToFront(pageClient);
  const pos = await pageClient.evaluate(
    `(() => {
      const textOf = (el) => [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.innerText,
        el.textContent
      ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      const normalizedTextOf = (el) => {
        const parts = textOf(el)
          .split(/\\s+/)
          .filter(Boolean);
        if (parts.length === 4 && parts[0].toLowerCase() === parts[2].toLowerCase() && parts[1].toLowerCase() === parts[3].toLowerCase()) {
          return parts[0] + " " + parts[1];
        }
        return parts.join(" ");
      };
      const allEls = [...document.querySelectorAll("button, [role='button'], a")];
      const candidates = allEls
        .filter((el) => {
          const text = normalizedTextOf(el);
          const rect = el.getBoundingClientRect();
          return (
            /^(sign in|log in|login)$/i.test(text) ||
            /already have an account|sign in|log in|login/i.test(text)
          ) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && rect.width <= 420 && rect.height <= 120;
        })
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            el,
            text: normalizedTextOf(el),
            href: el.href || "",
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            visible: rect.width > 0 && rect.height > 0
          };
        });
      const asClickTarget = (candidate) => {
        candidate.el.scrollIntoView({ block: "center", inline: "center" });
        const rect = candidate.el.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          label: candidate.text,
        };
      };
      const exact = candidates.find((c) => c.visible && /^(sign in|log in|login)$/i.test(c.text) && c.x > 0 && c.y > 0);
      if (exact) return asClickTarget(exact);
      const visible = candidates.find((c) => c.visible && c.href);
      if (visible) return { navigateTo: visible.href, label: visible.text };
      const clickable = candidates.find((c) => c.visible && c.x > 0 && c.y > 0);
      if (clickable) return asClickTarget(clickable);
      return { ok: false, reason: "sign_in_action_not_found", buttons: candidates.map((c) => c.text) };
    })()`,
  );
  if (pos?.navigateTo) {
    await navigate(pageClient, pos.navigateTo);
    return { ok: true, clicked: true, label: pos.label, href: pos.navigateTo, navigatedByCdp: true };
  }
  if (pos?.x != null) {
    await pageClient.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await pageClient.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await sleep(2500);
    return { ok: true, clicked: true, label: pos.label, href: "" };
  }
  return { ok: false, clicked: false, reason: pos?.reason || "sign_in_action_not_found", buttons: pos?.buttons || [] };
}

async function clickWorkdayLoginSubmit(pageClient) {
  await bringToFront(pageClient);
  const pos = await pageClient.evaluate(
    `(() => {
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
      const normalizedTextOf = (el) => {
        const parts = textOf(el)
          .split(/\\s+/)
          .filter(Boolean);
        if (parts.length % 2 === 0) {
          const half = parts.length / 2;
          const left = parts.slice(0, half).join(" ").toLowerCase();
          const right = parts.slice(half).join(" ").toLowerCase();
          if (left === right) {
            return parts.slice(0, half).join(" ");
          }
        }
        return parts.join(" ");
      };
      const password = [...document.querySelectorAll("input[type='password']")]
        .filter(visible)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      if (!password) {
        return { ok: false, reason: "password_field_not_found" };
      }
      const passwordRect = password.getBoundingClientRect();
      const buttons = [...document.querySelectorAll("button, [role='button']")]
        .filter(visible)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            text: normalizedTextOf(el),
            disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter((button) => /^sign in$/i.test(button.text) && !button.disabled);
      const belowPassword = buttons
        .filter((button) => button.top > passwordRect.top)
        .sort((a, b) => a.top - b.top)[0];
      const candidate = belowPassword || buttons[buttons.length - 1];
      if (!candidate) {
        return { ok: false, reason: "login_submit_not_found", buttons: buttons.map((button) => button.text) };
      }
      return {
        ok: true,
        label: candidate.text,
        x: Math.round(candidate.x),
        y: Math.round(candidate.y),
      };
    })()`,
  );
  if (!pos?.ok || pos.x == null || pos.y == null) {
    return {
      ok: false,
      clicked: false,
      reason: pos?.reason || "login_submit_not_found",
      buttons: pos?.buttons || [],
    };
  }
  await pageClient.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: pos.x,
    y: pos.y,
    button: "left",
  });
  await pageClient.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: pos.x,
    y: pos.y,
    button: "left",
    clickCount: 1,
  });
  await pageClient.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: pos.x,
    y: pos.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(5500);
  return { ok: true, clicked: true, label: pos.label || "Sign In" };
}

async function signInFromCurrentAccountState(pageClient, args, referenceUrl) {
  let signInClick = { ok: true, skipped: true, reason: "already_on_login_page" };
  let loginPage = await ensureWorkdayLoginPage(pageClient);
  if (!loginPage.ok) {
    signInClick = await clickSignInAction(pageClient);
    loginPage = signInClick.ok
      ? await ensureWorkdayLoginPage(pageClient)
      : { ok: false, reason: signInClick.reason || "sign_in_action_failed" };
  }
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
    ? await clickWorkdayLoginSubmit(pageClient)
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
  let spaWaitAttempts = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    await dismissCookieConsent(pageClient).catch(() => {});
    const state = await pageHasAccountFields(pageClient);
    if (state.fieldCount === 0 && !state.hasCreateAccountAction && !state.signedInOrAdvanced && !state.verificationNeeded && spaWaitAttempts < 6) {
      spaWaitAttempts += 1;
      i -= 1;
      await sleep(1500);
      continue;
    }
    steps.push({
      step: i,
      href: state.href,
      pageKind: state.pageKind || "unknown",
      pageReadyTimedOut: Boolean(state.pageReadyTimedOut),
      fieldCount: state.fieldCount,
      hasAccountFields: state.ok,
      isSignupForm: state.isSignupForm,
      isLoginForm: state.isLoginForm,
      hasCreateAccountAction: state.hasCreateAccountAction,
      hasSignInWithEmailAction: state.hasSignInWithEmailAction,
      hasGoogleAction: state.hasGoogleAction,
      verificationNeeded: state.verificationNeeded,
      signedInOrAdvanced: state.signedInOrAdvanced,
    });
    if (state.stillLoading || state.pageKind === "loading") {
      return {
        ok: false,
        reason: "workday_page_still_loading",
        steps,
        state,
      };
    }
    if (state.ok && state.isLoginForm) {
      return {
        ok: true,
        reason: "account_login_fields_found",
        steps,
        state,
      };
    }
    if (
      (state.ok && !state.isLoginForm) ||
      state.verificationNeeded ||
      state.signedInOrAdvanced
    ) {
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
    const clickIntent =
      state.pageKind === "signin_choice" || state.hasSignInWithEmailAction
        ? "email"
        : state.pageKind === "job_posting" ||
            state.pageKind === "apply_choice" ||
            (i === 0 && !state.ok && !state.hasSignInWithEmailAction)
        ? "apply"
        : "auto";
    const click = await clickSafeAccountAction(pageClient, clickIntent);
    steps.push({
      step: i,
      clicked: click.clicked,
      label: click.label || "",
      reason: click.reason || "",
      intent: click.intent || clickIntent,
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

async function startGoogleAccountFlow(pageClient, args, referenceUrl) {
  const steps = [];
  for (let i = 0; i < 4; i += 1) {
    const state = await pageHasAccountFields(pageClient);
    steps.push({
      step: i,
      href: state.href,
      hasGoogleAction: state.hasGoogleAction,
      hasSignInWithEmailAction: state.hasSignInWithEmailAction,
      signedInOrAdvanced: state.signedInOrAdvanced,
      buttons: state.buttons || [],
    });
    if (state.signedInOrAdvanced) {
      return { ok: true, reason: "already_signed_in_or_advanced", steps };
    }
    if (state.hasGoogleAction) {
      break;
    }
    const intent =
      i === 0 && !state.hasSignInWithEmailAction ? "apply" : "auto";
    const click = await clickSafeAccountAction(pageClient, intent);
    steps.push({
      step: i,
      clicked: click.clicked,
      label: click.label || "",
      reason: click.reason || "",
      intent: click.intent || intent,
      href: click.href || "",
    });
    if (!click.ok || !click.clicked) {
      return {
        ok: false,
        reason: click.reason || "google_gateway_not_reached",
        steps,
      };
    }
  }

  const google = new GoogleSignInManager({
    cdpPort: args.cdpPort,
    email: args.accountEmail,
    password: args.accountPassword,
  });
  const entry = await google.clickGoogleEntry(pageClient);
  if (!entry.ok) {
    return { ok: false, reason: entry.reason || "google_entry_failed", entry, steps };
  }
  const googleClient =
    (await connectLatestGoogleTarget(args.cdpPort)) || pageClient;
  const fills = [];
  let postGoogleClient = pageClient;
  let state = { signedInOrAdvanced: false };
  try {
    for (let i = 0; i < 3 && !state.signedInOrAdvanced; i += 1) {
      const fill = await google.fillGoogleAccountPage(googleClient);
      fills.push(fill);
      await sleep(2000);
      postGoogleClient =
        (await connectLatestWorkdayApplicationTarget(
          args.cdpPort,
          referenceUrl,
        )) || pageClient;
      state = await inspectApplicationStateFast(postGoogleClient);
      if (fill.manualRequired || !fill.ok) {
        break;
      }
    }
  } finally {
    if (googleClient !== pageClient && googleClient !== postGoogleClient) {
      googleClient.close();
    }
  }
  return {
    ok: Boolean(state.signedInOrAdvanced),
    reason: state.signedInOrAdvanced
      ? "google_signin_advanced"
      : "google_signin_needs_manual_or_more_steps",
    entry,
    fills,
    state,
    steps,
    client: postGoogleClient,
    switchedClient: postGoogleClient !== pageClient,
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
    const lowerText = normalizedText.toLowerCase();
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
    if (stillLoading) {
      pageKind = "loading";
    } else if (/workday is currently unavailable|service interruption/i.test(normalizedText)) {
      pageKind = "maintenance";
    } else if (/something went wrong/i.test(normalizedText) && /please refresh/i.test(normalizedText)) {
      pageKind = "runtime_error";
    } else if (hasEmailField && passwordCount > 1) {
      pageKind = "signup_form";
    } else if (hasEmailField && passwordCount === 1) {
      pageKind = "signin_form";
    } else if (hasButton(/^sign in with email\\b/i) || hasButton(/sign\\s*in\\s*with\\s*(google|apple)/i)) {
      pageKind = "signin_choice";
    } else if (/start your application/i.test(normalizedText) || hasButton(/^apply manually$/i) || hasButton(/^autofill with resume$/i)) {
      pageKind = "apply_choice";
    } else if (currentStepText && !/create account|sign in/i.test(currentStepText)) {
      pageKind = "application_step";
    } else if (/resume\\/cv|my information|my experience|application questions|voluntary disclosures|self identify|review/i.test(normalizedText)) {
      pageKind = "application_step";
    } else if (hasButton(/^apply\\b/i) || /job requisition id|posted on/i.test(normalizedText)) {
      pageKind = "job_posting";
    }
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
      buttons: buttons.slice(0, 20),
      currentStepText,
      loadingNodeCount: loadingNodes.length,
      bodyHead: normalizedText.slice(0, 800)
    };
  })()`;
}

async function inspectWorkdayPageKind(pageClient) {
  await bringToFront(pageClient);
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

async function signOutWorkday(pageClient) {
  await bringToFront(pageClient);
  const result = await pageClient.evaluate(
    `(async () => {
      const btn = document.querySelector('[data-automation-id="utilityMenuButton"]');
      if (!btn) return { ok: false, reason: "settings_button_not_found" };
      btn.click();
      await new Promise(r => setTimeout(r, 800));
      const items = [...document.querySelectorAll('[data-automation-id="menuItem"], [class*="menuItem"], [role="menuitem"]')];
      const signOut = items.find(el => /sign out|log out/i.test(el.innerText || el.textContent));
      if (!signOut) return { ok: false, reason: "sign_out_item_not_found", items: items.map(e => e.innerText).slice(0,10) };
      signOut.click();
      return { ok: true };
    })()`,
  );
  await sleep(2000);
  return result;
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
        accountError: /already exists|invalid credential|error:|please check/i.test(text) || (/already have an account/i.test(text) && !/already have an account\\?\\s*sign in/i.test(text)),
        bodyHead: text.slice(0, 1000)
      };
    })()`,
  );
}

async function inspectApplicationStateFast(pageClient) {
  await bringToFront(pageClient);
  return pageClient.evaluate(
    `(() => {
      const text = document.body ? document.body.innerText.replace(/\\s+/g, " ").trim() : "";
      return {
        href: location.href,
        title: document.title,
        verificationNeeded: /verify|verification|check your email|confirm your email/i.test(text),
        signedInOrAdvanced: /Settings\\s+\\S+@\\S+|Candidate Home|current step\\s+\\d+\\s+of\\s+\\d+\\s+(?!Create Account\\/Sign In)(My Information|My Experience|Application Questions|Voluntary Disclosures|Review)|Resume\\/CV/i.test(text),
        bodyHead: text.slice(0, 500)
      };
    })()`,
    10000,
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
    if (args.provider !== "fake") {
      await dismissCookieConsent(pageClient).catch(() => {});
      await sleep(3000);
    }

    if (args.provider !== "fake" && args.accountMethod === "google") {
      const googleResult = await startGoogleAccountFlow(
        pageClient,
        args,
        targetUrl,
      );
      if (googleResult.client && googleResult.client !== pageClient) {
        pageClient.close();
        pageClient = googleResult.client;
      }
      console.log(
        JSON.stringify(
          {
            ok: googleResult.ok,
            provider: args.provider,
            accountMethod: args.accountMethod,
            resetSiteData,
            google: {
              reason: googleResult.reason,
              entry: googleResult.entry,
              fills: googleResult.fills,
              state: googleResult.state,
              steps: googleResult.steps,
            },
          },
          null,
          2,
        ),
      );
      if (!googleResult.ok) {
        process.exitCode = 1;
      }
      return;
    }

    const reachResult =
      args.provider === "fake"
        ? { ok: true, reason: "fake_fixture" }
        : await reachAccountForm(pageClient);
    recordWorkflowEvent(
      "auth",
      "detect_account_state",
      reachResult.ok ? "ok" : "failed",
      reachResult.ok
        ? `Detected Workday account state: ${reachResult.reason || "unknown"}.`
        : "Could not reach a Workday account state.",
      {
        reason: reachResult.reason || "",
        signedInOrAdvanced: Boolean(reachResult.state?.signedInOrAdvanced),
        isLoginForm: Boolean(reachResult.state?.isLoginForm),
        isSignupForm: Boolean(reachResult.state?.isSignupForm),
        verificationNeeded: Boolean(reachResult.state?.verificationNeeded),
      },
    );
    if (!reachResult.ok) {
      throw new Error(
        `Could not reach account form: ${JSON.stringify(reachResult)}`,
      );
    }
    const fillTargetUrl = reachResult.state?.href || targetUrl;
    const reachSignedInEmail = (reachResult.state?.signedInEmail || "").toLowerCase();
    const wantEmail = (args.accountEmail || "").toLowerCase();
    const wrongAccount =
      reachSignedInEmail &&
      wantEmail &&
      reachSignedInEmail !== wantEmail;
    if (args.provider !== "fake" && reachResult.state?.signedInOrAdvanced && !wrongAccount) {
      const applicationState = await inspectApplicationState(pageClient);
      recordWorkflowEvent(
        "auth",
        "session_detected",
        "ok",
        "Existing signed-in Workday session detected; skipping login, signup, and email verification.",
        {
          email: reachResult.state?.signedInEmail || args.accountEmail || "",
        },
      );
      console.log(
        JSON.stringify(
          {
            ok: true,
            workflow: {
              auth: {
                phase: "auth",
                status: "ok",
                reason: "already_signed_in_or_advanced",
                events: workflowEvents.filter((event) => event.phase === "auth"),
              },
            },
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
    if (wrongAccount) {
      await signOutWorkday(pageClient);
      await navigate(pageClient, targetUrl);
      await sleep(2000);
      const signInResult = await signInFromCurrentAccountState(
        pageClient,
        args,
        targetUrl,
      );
      const postSignInState = signInResult.client
        ? await inspectApplicationState(signInResult.client)
        : await inspectApplicationState(pageClient);
      if (signInResult.ok) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              provider: args.provider,
              resetSiteData,
              reason: "wrong_account_signout_signin_succeeded",
              fill: { ok: false, skipped: true, reason: "signin_handled" },
              submit: { ok: true, skipped: true, reason: "signed_in_as_correct_account", email: args.accountEmail },
              bridge: { ok: true, skipped: true, reason: "already_verified_or_session_active" },
              verified: postSignInState,
              login: { ok: true, skipped: false, state: postSignInState },
            },
            null,
            2,
          ),
        );
        return;
      }
      throw new Error(
        `Wrong-account sign-out + sign-in failed: ${JSON.stringify(signInResult)}`,
      );
    }
    const loginFirstResult =
      args.provider === "fake"
        ? { ok: false, skipped: true, reason: "fake_fixture_signup_first" }
        : await signInFromCurrentAccountState(pageClient, args, fillTargetUrl);
    recordWorkflowEvent(
      "auth",
      "login_first",
      loginFirstResult.ok ? "ok" : "failed",
      loginFirstResult.ok
        ? "Existing Workday account login succeeded; skipping signup and email verification."
        : "Existing Workday account login did not advance; signup/verification may be needed.",
      {
        reason: loginFirstResult.reason || loginFirstResult.loginPage?.reason || "",
        loginFilled: Boolean(loginFirstResult.loginFill?.ok),
        loginSubmitted: Boolean(loginFirstResult.loginSubmit?.ok),
        signedInOrAdvanced: Boolean(loginFirstResult.loginState?.signedInOrAdvanced),
      },
    );
    if (loginFirstResult.switchedClient && loginFirstResult.client) {
      pageClient.close();
      pageClient = loginFirstResult.client;
    }
    if (loginFirstResult.ok) {
      const applicationState = await inspectApplicationState(pageClient);
      console.log(
        JSON.stringify(
          {
            ok: true,
            workflow: {
              auth: {
                phase: "auth",
                status: "ok",
                reason: "login_first_succeeded",
                events: workflowEvents.filter((event) => event.phase === "auth"),
              },
            },
            provider: args.provider,
            resetSiteData,
            reason: "login_first_succeeded",
            fill: {
              ok: false,
              skipped: true,
              reason: "signup_not_needed",
            },
            submit: {
              ok: true,
              skipped: true,
              reason: "signed_in_before_signup",
              email: args.accountEmail,
            },
            bridge: {
              ok: true,
              skipped: true,
              reason: "login_first_no_verification_needed",
            },
            login: loginFirstResult,
            verified: applicationState,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (loginFirstResult.client && loginFirstResult.client !== pageClient) {
      pageClient.close();
      pageClient = loginFirstResult.client;
    }
    await navigate(pageClient, fillTargetUrl);
    await sleep(1500);
    recordWorkflowEvent(
      "auth",
      "signup_start",
      "info",
      "Login-first did not succeed; trying signup and email verification path.",
      {
        href: fillTargetUrl,
      },
    );
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

    let verificationRequest = {
      ok: true,
      clicked: false,
      skipped: true,
      reason: "verification_request_not_needed",
    };
    let verificationRequestedAt = "";
    const verificationNeededState = Boolean(
      postSubmitState.verificationNeeded ||
        reachResult.state?.verificationNeeded ||
        loginFirstResult.loginState?.verificationNeeded,
    );
    if (args.provider !== "fake" && verificationNeededState) {
      verificationRequestedAt = new Date().toISOString();
      verificationRequest = await clickSafeAccountAction(pageClient, "verify");
      recordWorkflowEvent(
        "auth",
        "request_email_verification",
        verificationRequest.ok ? "ok" : "failed",
        verificationRequest.ok
          ? "Requested account verification email from Workday."
          : "Could not request account verification email from Workday.",
        {
          reason: verificationRequest.reason || "",
          label: verificationRequest.label || "",
          clicked: Boolean(verificationRequest.clicked),
          postSubmitVerificationNeeded: Boolean(
            postSubmitState.verificationNeeded,
          ),
          reachVerificationNeeded: Boolean(reachResult.state?.verificationNeeded),
          loginVerificationNeeded: Boolean(
            loginFirstResult.loginState?.verificationNeeded,
          ),
        },
      );
      if (!verificationRequest.ok || !verificationRequest.clicked) {
        const retrySignIn = await signInFromCurrentAccountState(
          pageClient,
          args,
          fillTargetUrl,
        );
        if (retrySignIn.switchedClient && retrySignIn.client) {
          pageClient.close();
          pageClient = retrySignIn.client;
        }
        recordWorkflowEvent(
          "auth",
          "verification_signin_retry",
          retrySignIn.ok ? "ok" : "failed",
          retrySignIn.ok
            ? "Sign-in succeeded after verification state changed."
            : "Sign-in retry still did not advance after verification request was unavailable.",
          {
            reason: retrySignIn.reason || retrySignIn.loginPage?.reason || "",
            loginFilled: Boolean(retrySignIn.loginFill?.ok),
            loginSubmitted: Boolean(retrySignIn.loginSubmit?.ok),
            signedInOrAdvanced: Boolean(
              retrySignIn.loginState?.signedInOrAdvanced,
            ),
            verificationNeeded: Boolean(retrySignIn.loginState?.verificationNeeded),
          },
        );
        if (retrySignIn.ok) {
          const applicationState = await inspectApplicationState(pageClient);
          console.log(
            JSON.stringify(
              {
                ok: true,
                provider: args.provider,
                resetSiteData,
                reason: "verification_state_changed_signin_succeeded",
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
                  reason: "verification_resend_not_needed_after_retry",
                },
                login: retrySignIn,
                verified: applicationState,
              },
              null,
              2,
            ),
          );
          return;
        }
        if (retrySignIn.loginState?.verificationNeeded) {
          verificationRequestedAt = new Date().toISOString();
          verificationRequest = await clickSafeAccountAction(pageClient, "verify");
        }
        if (!verificationRequest.ok || !verificationRequest.clicked) {
          throw new Error(
            `Verification email request failed: ${JSON.stringify({
              verificationRequest,
              retrySignIn,
            })}`,
          );
        }
      }
    }

    const expectedVerificationHosts =
      args.provider === "fake" ? ["127.0.0.1"] : [new URL(fillTargetUrl).host];
    const verificationSince =
      verificationRequestedAt ||
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
    recordWorkflowEvent(
      "auth",
      "email_verification",
      bridgeResult.ok ? "ok" : "failed",
      bridgeResult.ok
        ? bridgeResult.code
          ? "Email verification code found."
          : "Email verification link found."
        : "Email verification was not found before timeout.",
      {
        reason: bridgeResult.reason || "",
        source: bridgeResult.source || "",
        method: bridgeResult.method || (bridgeResult.code ? "code" : "link"),
      },
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

    let verified = { verified: false, skipped: true };
    let loginPage = { ok: true, skipped: true };
    let loginFill = { ok: true, skipped: true };
    let loginSubmit = { ok: true, skipped: true };
    let loginState = { ok: true, skipped: true };
    let codeEntry = { ok: true, skipped: true };
    if (bridgeResult.code) {
      codeEntry = await enterVerificationCode(pageClient, bridgeResult.code);
      await waitForPageSettled(pageClient, 2500).catch(() => {});
      loginState = await inspectApplicationState(pageClient);
    } else {
      await navigate(pageClient, bridgeResult.link);
      verified = await inspectVerified(pageClient);
      loginPage =
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
      loginFill =
        args.provider === "fake"
          ? { ok: true, skipped: true }
          : await fillWorkdayLoginForm(pageClient, args);
      loginSubmit =
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
      loginState =
        args.provider === "fake"
          ? { ok: true, skipped: true }
          : await inspectApplicationState(pageClient);
    }
    const result = {
      ok: Boolean(
        verified.verified ||
        (bridgeResult.code && codeEntry.ok && loginState.signedInOrAdvanced) ||
        (args.provider !== "fake" &&
          loginFill.ok &&
          loginSubmit.ok &&
          loginState.signedInOrAdvanced),
      ),
      workflow: {
        auth: {
          phase: "auth",
          status:
            verified.verified ||
            (bridgeResult.code &&
              codeEntry.ok &&
              loginState.signedInOrAdvanced) ||
            (args.provider !== "fake" &&
              loginFill.ok &&
              loginSubmit.ok &&
              loginState.signedInOrAdvanced)
              ? "ok"
              : "failed",
          reason: "signup_email_verification",
          events: workflowEvents.filter((event) => event.phase === "auth"),
        },
      },
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
        method: bridgeResult.method || (bridgeResult.code ? "code" : "link"),
        source: bridgeResult.source,
        subject: bridgeResult.subject,
        linkHost: bridgeResult.link ? new URL(bridgeResult.link).host : "",
        codeLength: bridgeResult.code ? String(bridgeResult.code).length : 0,
      },
      codeEntry,
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
