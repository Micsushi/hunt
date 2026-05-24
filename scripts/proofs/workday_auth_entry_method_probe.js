"use strict";

const http = require("http");
const fs = require("fs");

const {
  DEFAULT_ACCOUNT_EMAIL,
  DEFAULT_ACCOUNT_PASSWORD,
} = require("../c3_p_chrome_defaults");

function parseArgs(argv) {
  const args = {
    cdpPort: 9222,
    out: "",
    applyUrl: "",
    mode: "signin",
    email: process.env.HUNT_C3_TEST_ACCOUNT_EMAIL || DEFAULT_ACCOUNT_EMAIL,
    password: process.env.HUNT_C3_TEST_ACCOUNT_PASSWORD || DEFAULT_ACCOUNT_PASSWORD,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = next;
      i += 1;
    } else if (arg === "--apply-url" && next) {
      args.applyUrl = next;
      i += 1;
    } else if (arg === "--mode" && next) {
      args.mode = next;
      i += 1;
    } else if (arg === "--email" && next) {
      args.email = next;
      i += 1;
    } else if (arg === "--password" && next) {
      args.password = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`CDP HTTP timeout: ${path}`)));
  });
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (event) => reject(event.error || event);
      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (!message.id || !this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id);
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      };
    });
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 10000) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch (_error) {}
  }
}

const SNAPSHOT_EXPRESSION = `(() => {
  const norm = (v) => String(v || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const step = document.querySelector('[data-automation-id="progressBarActiveStep"]');
  const buttons = [...document.querySelectorAll('button, [role="button"], a, [data-automation-id="click_filter"]')]
    .filter(visible)
    .map((el) => ({
      text: norm(el.innerText || el.textContent || el.getAttribute("aria-label") || el.value),
      automationId: el.getAttribute("data-automation-id") || "",
      id: el.id || "",
      tag: el.tagName,
    }))
    .slice(0, 40);
  const fields = [...document.querySelectorAll('input:not([type="hidden"])')]
    .filter((el) => el.name !== "website" && visible(el))
    .map((el) => ({
      type: el.type || "",
      automationId: el.getAttribute("data-automation-id") || "",
      id: el.id || "",
      valuePresent: Boolean(el.value),
      checked: el.type === "checkbox" ? Boolean(el.checked) : undefined,
      ariaChecked: el.getAttribute("aria-checked") || "",
    }));
  const errors = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error" i]')]
    .map((el) => norm(el.innerText || el.textContent))
    .filter(Boolean)
    .slice(0, 12);
  return {
    href: location.href,
    title: document.title,
    step: norm(step?.innerText || step?.textContent),
    fields,
    buttons,
    errors,
    bodyHead: norm(document.body?.innerText || "").slice(0, 1000),
  };
})()`;

function setupExpression(mode) {
  return `(() => {
    const mode = ${JSON.stringify(mode)};
    const norm = (v) => String(v || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      if (String(el.getAttribute("aria-hidden") || "").toLowerCase() === "true") return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
    };
    const label = (el) => norm([
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.value,
      el?.innerText,
      el?.textContent,
    ].filter(Boolean).join(" "));
    const meta = (el) => norm([
      el?.id,
      el?.getAttribute?.("data-automation-id"),
      el?.className,
    ].filter(Boolean).join(" "));
    if (mode === "signin") {
      const link = [...document.querySelectorAll('button, [role="button"], a')]
        .filter(visible)
        .sort((a, b) => {
          const score = (el) => {
            const text = label(el);
            const data = meta(el);
            let value = 0;
            if (/SignInWithEmailButton|signInLink/i.test(data)) value += 100;
            if (/^sign in with email$/i.test(text)) value += 90;
            if (/^sign in$/i.test(text)) value += 60;
            if (/google|linkedin|facebook|create account|forgot/i.test(text + " " + data)) value -= 120;
            return value;
          };
          return score(b) - score(a);
        })
        .find((el) => {
          const text = label(el);
          const data = meta(el);
          return /SignInWithEmailButton|signInLink/i.test(data) || /^sign in( with email)?$/i.test(text);
        });
      if (link) {
        link.scrollIntoView({ block: "center", inline: "center" });
        link.click();
      }
    }
    return { mode };
  })()`;
}

function locateExpression() {
  return `(() => {
    const norm = (v) => String(v || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      if (String(el.getAttribute("aria-hidden") || "").toLowerCase() === "true") return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
    };
    const textOf = (el) => norm([
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.value,
      el?.innerText,
      el?.textContent,
    ].filter(Boolean).join(" "));
    const metaOf = (el) => norm([
      el?.id,
      el?.name,
      el?.type,
      el?.autocomplete,
      el?.placeholder,
      el?.getAttribute?.("data-automation-id"),
      el?.className,
    ].filter(Boolean).join(" "));
    const inputs = [...document.querySelectorAll('input:not([type="hidden"])')]
      .filter((el) => el.name !== "website" && visible(el));
    const emailInput = inputs.find((el) => /email|username|user/i.test(metaOf(el)) && el.type !== "password");
    const passwordInputs = inputs.filter((el) => el.type === "password");
    const checkbox = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
      .filter(visible)
      .find((el) => /privacy|terms|notice|agree|consent|acknowledge|boeing|applicant|createaccountcheckbox/i.test(norm([
        textOf(el),
        metaOf(el),
        el.closest("label")?.innerText,
        el.closest("[data-automation-id], section, div")?.innerText,
      ].filter(Boolean).join(" "))));
    const controls = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href], [data-automation-id="click_filter"]')]
      .filter(visible)
      .map((el) => {
        const label = textOf(el);
        const meta = metaOf(el);
        let score = 0;
        if (/signinsubmitbutton|createaccountsubmitbutton|click_filter/i.test(meta)) score += 80;
        if (/^(sign in|create account|submit|continue)$/i.test(label)) score += 70;
        if (/forgot|back|google|linkedin|search/i.test(label + " " + meta)) score -= 100;
        return { el, label, meta, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const target = controls[0]?.el || null;
    const wrapper = target?.closest?.('[data-automation-id="click_filter"], [role="button"], button, a') || target;
    const noCaptcha = document.querySelector('[data-automation-id="noCaptchaWrapper"]');
    const rectFor = (el) => {
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    window.__huntAuthEntryProbe = { emailInput, passwordInputs, checkbox, target, wrapper, noCaptcha };
    return {
      emailInput: emailInput ? { meta: metaOf(emailInput), rect: rectFor(emailInput) } : null,
      passwordInputs: passwordInputs.map((el) => ({ meta: metaOf(el), rect: rectFor(el) })),
      checkbox: checkbox ? { meta: metaOf(checkbox), label: textOf(checkbox), rect: rectFor(checkbox) } : null,
      target: target ? { meta: metaOf(target), label: textOf(target), rect: rectFor(target) } : null,
      wrapper: wrapper ? { meta: metaOf(wrapper), label: textOf(wrapper), rect: rectFor(wrapper) } : null,
      noCaptcha: noCaptcha ? { meta: metaOf(noCaptcha), label: textOf(noCaptcha), rect: rectFor(noCaptcha) } : null,
    };
  })()`;
}

async function clearKnownInputs(cdp) {
  await cdp.eval(`(() => {
    const probe = window.__huntAuthEntryProbe || {};
    for (const input of [probe.emailInput, ...(probe.passwordInputs || [])].filter(Boolean)) {
      input.focus?.();
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (descriptor?.set) descriptor.set.call(input, "");
      else input.value = "";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  })()`);
}

async function cdpClickRect(cdp, rect) {
  if (!rect) return { skipped: "no_rect" };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  return { clicked: true, x: rect.x, y: rect.y };
}

async function cdpType(cdp, rect, text, mode) {
  if (!rect) return { skipped: "no_rect" };
  await cdpClickRect(cdp, rect);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  if (mode === "insertText") {
    await cdp.send("Input.insertText", { text });
  } else {
    for (const char of text) {
      await cdp.send("Input.dispatchKeyEvent", { type: "char", text: char, unmodifiedText: char });
      await sleep(12);
    }
  }
  return { typed: true, length: text.length, mode };
}

async function commitCheckbox(cdp, rect, method) {
  if (method === "native") {
    return cdp.eval(`(() => {
      const checkbox = window.__huntAuthEntryProbe?.checkbox;
      if (!checkbox) return { skipped: "no_checkbox" };
      if (checkbox instanceof HTMLInputElement) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
        if (descriptor?.set) descriptor.set.call(checkbox, true);
        else checkbox.checked = true;
      }
      checkbox.setAttribute("aria-checked", "true");
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const event = type.startsWith("pointer")
          ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        checkbox.dispatchEvent(event);
      }
      checkbox.dispatchEvent(new Event("input", { bubbles: true }));
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      return { nativeCommitted: true, checked: Boolean(checkbox.checked), ariaChecked: checkbox.getAttribute("aria-checked") };
    })()`);
  }
  if (!rect) return { skipped: "no_checkbox" };
  if (method === "space") {
    await cdpClickRect(cdp, rect);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    return { spaced: true };
  }
  return cdpClickRect(cdp, rect);
}

async function submit(cdp, targets, method) {
  const rect = targets.wrapper?.rect || targets.target?.rect;
  if (method === "cdp_click") return cdpClickRect(cdp, rect);
  if (method === "dom_pointer") {
    return cdp.eval(`(() => {
      const el = window.__huntAuthEntryProbe?.wrapper || window.__huntAuthEntryProbe?.target;
      if (!el) return { skipped: "no_submit" };
      el.scrollIntoView({ block: "center", inline: "center" });
      for (const type of ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const event = type.startsWith("pointer")
          ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(event);
      }
      return { dispatched: true };
    })()`);
  }
  if (method === "nocaptcha_then_dom_pointer") {
    if (targets.noCaptcha?.rect) await cdpClickRect(cdp, targets.noCaptcha.rect);
    await sleep(500);
    return submit(cdp, targets, "dom_pointer");
  }
  if (method === "blur_settle_dom_pointer") {
    await cdp.eval(`document.activeElement?.blur?.()`);
    await sleep(1800);
    return submit(cdp, targets, "dom_pointer");
  }
  return { skipped: `unknown_submit_${method}` };
}

function changed(before, after) {
  return (
    before.href !== after.href ||
    before.step !== after.step ||
    before.title !== after.title ||
    JSON.stringify(before.errors || []) !== JSON.stringify(after.errors || [])
  );
}

const CASES = [
  {
    name: "native_setter_checkbox_click_blur_settle_dom_pointer",
    fill: "native",
    checkbox: "click",
    submit: "blur_settle_dom_pointer",
  },
  {
    name: "cdp_insertText_checkbox_click_dom_pointer",
    fill: "insertText",
    checkbox: "click",
    submit: "dom_pointer",
  },
  {
    name: "cdp_key_chars_checkbox_space_dom_pointer",
    fill: "keyChars",
    checkbox: "space",
    submit: "dom_pointer",
  },
  {
    name: "cdp_insertText_checkbox_click_cdp_click",
    fill: "insertText",
    checkbox: "click",
    submit: "cdp_click",
  },
  {
    name: "cdp_insertText_checkbox_click_nocaptcha_then_dom_pointer",
    fill: "insertText",
    checkbox: "click",
    submit: "nocaptcha_then_dom_pointer",
  },
  {
    name: "dom_focus_insertText_checkbox_native_dom_pointer",
    fill: "focusInsertText",
    checkbox: "native",
    submit: "dom_pointer",
  },
  {
    name: "dom_focus_key_chars_checkbox_native_dom_pointer",
    fill: "focusKeyChars",
    checkbox: "native",
    submit: "dom_pointer",
  },
  {
    name: "dom_focus_insertText_checkbox_native_nocaptcha_then_dom_pointer",
    fill: "focusInsertText",
    checkbox: "native",
    submit: "nocaptcha_then_dom_pointer",
  },
];

async function runCase(cdp, args, testCase) {
  if (args.applyUrl) {
    await cdp.send("Page.navigate", { url: args.applyUrl }, 15000);
    await sleep(4500);
  }
  await cdp.eval(setupExpression(args.mode));
  await sleep(1800);
  let targets = await cdp.eval(locateExpression());
  await clearKnownInputs(cdp);
  await sleep(300);
  targets = await cdp.eval(locateExpression());

  const fill = [];
  if (testCase.fill === "native") {
    fill.push(await cdp.eval(`(() => {
      const probe = window.__huntAuthEntryProbe || {};
      const setValue = (el, value) => {
        if (!el) return false;
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (descriptor?.set) descriptor.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;
      };
      return {
        email: setValue(probe.emailInput, ${JSON.stringify(args.email)}),
        passwords: (probe.passwordInputs || []).map((input) => setValue(input, ${JSON.stringify(args.password)})),
      };
    })()`));
  } else if (testCase.fill === "focusInsertText" || testCase.fill === "focusKeyChars") {
    const focusedTargets = await cdp.eval(`(() => {
      const probe = window.__huntAuthEntryProbe || {};
      return [probe.emailInput, ...(probe.passwordInputs || [])].filter(Boolean).map((el, index) => ({
        index,
        automationId: el.getAttribute("data-automation-id") || "",
      }));
    })()`);
    for (const targetInfo of focusedTargets) {
      await cdp.eval(`(() => {
        const probe = window.__huntAuthEntryProbe || {};
        const fields = [probe.emailInput, ...(probe.passwordInputs || [])].filter(Boolean);
        const field = fields[${targetInfo.index}];
        if (!field) return false;
        field.scrollIntoView({ block: "center", inline: "center" });
        field.focus?.();
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (descriptor?.set) descriptor.set.call(field, "");
        else field.value = "";
        field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: "" }));
        return document.activeElement === field;
      })()`);
      const text = targetInfo.index === 0 ? args.email : args.password;
      if (testCase.fill === "focusInsertText") {
        await cdp.send("Input.insertText", { text });
      } else {
        for (const char of text) {
          await cdp.send("Input.dispatchKeyEvent", { type: "char", text: char, unmodifiedText: char });
          await sleep(12);
        }
      }
      await cdp.eval(`document.activeElement?.dispatchEvent(new Event("change", { bubbles: true }))`);
      fill.push({ [targetInfo.automationId || `field${targetInfo.index}`]: { typed: true, length: text.length, mode: testCase.fill } });
    }
  } else {
    fill.push({ email: await cdpType(cdp, targets.emailInput?.rect, args.email, testCase.fill) });
    for (const [index, passwordTarget] of (targets.passwordInputs || []).entries()) {
      fill.push({ [`password${index + 1}`]: await cdpType(cdp, passwordTarget.rect, args.password, testCase.fill) });
    }
  }

  targets = await cdp.eval(locateExpression());
  const checkbox = await commitCheckbox(cdp, targets.checkbox?.rect, testCase.checkbox);
  await sleep(800);
  targets = await cdp.eval(locateExpression());
  const before = await cdp.eval(SNAPSHOT_EXPRESSION);
  const action = await submit(cdp, targets, testCase.submit);
  await sleep(3500);
  const after = await cdp.eval(SNAPSHOT_EXPRESSION);
  return {
    name: testCase.name,
    mode: args.mode,
    targets,
    fill,
    checkbox,
    action,
    before: {
      href: before.href,
      title: before.title,
      step: before.step,
      fields: before.fields,
      errors: before.errors,
    },
    after: {
      href: after.href,
      title: after.title,
      step: after.step,
      fields: after.fields,
      errors: after.errors,
      bodyHead: after.bodyHead,
    },
    changed: changed(before, after),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const tabs = await getJson(args.cdpPort, "/json");
  const page = tabs.find((tab) => tab.type === "page" && /myworkdayjobs\.com/i.test(tab.url || ""));
  if (!page) throw new Error(`No Workday page found on ${args.cdpPort}`);
  const cdp = new CdpSession(page.webSocketDebuggerUrl);
  await cdp.connect();
  const report = {
    port: args.cdpPort,
    mode: args.mode,
    applyUrl: args.applyUrl || page.url,
    startedAt: new Date().toISOString(),
    cases: [],
  };
  try {
    await cdp.send("Page.enable");
    for (const testCase of CASES) {
      const entry = await runCase(cdp, args, testCase);
      report.cases.push(entry);
      if (entry.changed && !/create account\/sign in|sign in|create account/i.test(entry.after.step || entry.after.title || "")) {
        break;
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    cdp.close();
  }
  const output = JSON.stringify(report, null, 2);
  if (args.out) fs.writeFileSync(args.out, output);
  console.log(output);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
