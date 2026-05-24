"use strict";

const http = require("http");
const fs = require("fs");

function parseArgs(argv) {
  const args = {
    cdpPort: 9222,
    out: "",
    email: process.env.HUNT_C3_TEST_ACCOUNT_EMAIL || "",
    password: process.env.HUNT_C3_TEST_ACCOUNT_PASSWORD || "",
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

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path, timeout: 5000 },
      (res) => {
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
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`CDP HTTP timeout on ${path}`));
    });
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
        const { resolve: done, reject: fail, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) fail(new Error(JSON.stringify(message.error)));
        else done(message.result);
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
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
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
  const fields = [...document.querySelectorAll('input:not([type="hidden"])')]
    .filter((el) => el.name !== "website" && visible(el))
    .map((el) => ({
      type: el.type || "",
      automationId: el.getAttribute("data-automation-id") || "",
      valuePresent: Boolean(el.value),
      checked: el.type === "checkbox" ? Boolean(el.checked) : undefined,
      ariaChecked: el.getAttribute("aria-checked") || "",
    }));
  const buttons = [...document.querySelectorAll('button, [role="button"], a, [data-automation-id="click_filter"]')]
    .filter(visible)
    .map((el) => ({
      text: norm(el.innerText || el.textContent || el.getAttribute("aria-label") || el.value),
      automationId: el.getAttribute("data-automation-id") || "",
      role: el.getAttribute("role") || "",
      tag: el.tagName,
    }))
    .slice(0, 30);
  const errors = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error" i]')]
    .map((el) => norm(el.innerText || el.textContent))
    .filter(Boolean)
    .slice(0, 10);
  return {
    href: location.href,
    title: document.title,
    step: norm(step?.innerText || step?.textContent),
    hasReview: /\\bReview\\b/i.test(document.body?.innerText || ""),
    finalSubmitVisible: buttons.some((button) => /^submit$/i.test(button.text)),
    fields,
    buttons,
    errors,
    bodyHead: norm(document.body?.innerText || "").slice(0, 900),
  };
})()`;

function findTargetsExpression(email, password) {
  return `(() => {
    const email = ${JSON.stringify(email || "")};
    const password = ${JSON.stringify(password || "")};
    const norm = (v) => String(v || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      if (String(el.getAttribute("aria-hidden") || "").toLowerCase() === "true") return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
    };
    const labelFor = (el) => norm([
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.value,
      el.innerText,
      el.textContent,
    ].filter(Boolean).join(" "));
    const metaFor = (el) => norm([
      el.id,
      el.name,
      el.type,
      el.getAttribute("data-automation-id"),
      el.getAttribute("data-testid"),
      el.className,
    ].filter(Boolean).join(" "));
    const setValue = (el, value) => {
      if (!el || !value) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor?.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    };
    const inputs = [...document.querySelectorAll('input:not([type="hidden"])')].filter((el) => el.name !== "website" && visible(el));
    const inputText = (el) => norm([
      el.getAttribute("data-automation-id"),
      el.id,
      el.name,
      el.type,
      el.autocomplete,
      el.placeholder,
      el.getAttribute("aria-label"),
    ].filter(Boolean).join(" "));
    const emailInput = inputs.find((el) => /email|username|user/i.test(inputText(el)) && el.type !== "password");
    const passwords = inputs.filter((el) => el.type === "password");
    const filled = [];
    if (emailInput && email && !emailInput.value) {
      setValue(emailInput, email);
      filled.push("email");
    }
    for (const [index, input] of passwords.entries()) {
      if (password && !input.value) {
        setValue(input, password);
        filled.push(index === 1 ? "verifyPassword" : "password");
      }
    }
    const checkbox = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
      .filter(visible)
      .find((el) => /privacy|terms|notice|agree|consent|acknowledge|boeing|applicant/i.test(norm([
        labelFor(el),
        metaFor(el),
        el.closest("label")?.innerText,
        el.closest("[data-automation-id], section, div")?.innerText,
      ].filter(Boolean).join(" "))));
    if (checkbox && !(checkbox.checked || checkbox.getAttribute("aria-checked") === "true")) {
      if (checkbox instanceof HTMLInputElement) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
        if (descriptor?.set) descriptor.set.call(checkbox, true);
        else checkbox.checked = true;
      }
      checkbox.setAttribute("aria-checked", "true");
      checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      checkbox.dispatchEvent(new Event("input", { bubbles: true }));
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      filled.push("checkbox");
    }
    const controls = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href], [data-automation-id="click_filter"]')]
      .filter(visible)
      .map((el) => {
        const label = labelFor(el);
        const meta = metaFor(el);
        let score = 0;
        if (/signinsubmitbutton|createaccountsubmitbutton|click_filter/i.test(meta)) score += 80;
        if (/^(sign in|create account|submit)$/i.test(label)) score += 70;
        if (/forgot|back|google|linkedin|search/i.test(label + " " + meta)) score -= 100;
        return { el, label, meta, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const target = controls[0]?.el || null;
    const wrapper = target?.closest?.('[data-automation-id="click_filter"], [role="button"], button, a') || target;
    const form = target?.closest?.("form") || null;
    const noCaptcha = document.querySelector('[data-automation-id="noCaptchaWrapper"]');
    const rectFor = (el) => {
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };
    window.__huntAuthProbe = { target, wrapper, form, noCaptcha };
    return {
      filled,
      target: target ? { label: labelFor(target), meta: metaFor(target), rect: rectFor(target) } : null,
      wrapper: wrapper ? { label: labelFor(wrapper), meta: metaFor(wrapper), rect: rectFor(wrapper) } : null,
      noCaptcha: noCaptcha ? { label: labelFor(noCaptcha), meta: metaFor(noCaptcha), rect: rectFor(noCaptcha) } : null,
    };
  })()`;
}

const VARIANTS = [
  {
    name: "cdp_click_visible_wrapper_center",
    run: async (cdp, targets) => {
      const rect = targets.wrapper?.rect || targets.target?.rect;
      if (!rect) return { skipped: "no_wrapper_rect" };
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      return { clicked: true, x: rect.x, y: rect.y };
    },
  },
  {
    name: "cdp_click_visible_wrapper_offset",
    run: async (cdp, targets) => {
      const rect = targets.wrapper?.rect || targets.target?.rect;
      if (!rect) return { skipped: "no_wrapper_rect" };
      const x = rect.left + Math.max(8, Math.floor(rect.width * 0.25));
      const y = rect.top + Math.max(8, Math.floor(rect.height * 0.5));
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return { clicked: true, x, y };
    },
  },
  {
    name: "focus_wrapper_space",
    run: async (cdp) => {
      const focused = await cdp.eval(`(() => {
        const el = window.__huntAuthProbe?.wrapper || window.__huntAuthProbe?.target;
        if (!el) return false;
        el.focus?.({ preventScroll: false });
        return document.activeElement === el || Boolean(el);
      })()`);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      return { focused };
    },
  },
  {
    name: "focus_wrapper_enter",
    run: async (cdp) => {
      const focused = await cdp.eval(`(() => {
        const el = window.__huntAuthProbe?.wrapper || window.__huntAuthProbe?.target;
        if (!el) return false;
        el.focus?.({ preventScroll: false });
        return document.activeElement === el || Boolean(el);
      })()`);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      return { focused };
    },
  },
  {
    name: "dom_pointer_mouse_sequence_wrapper",
    run: async (cdp) => cdp.eval(`(() => {
      const el = window.__huntAuthProbe?.wrapper || window.__huntAuthProbe?.target;
      if (!el) return { skipped: "no_wrapper" };
      el.scrollIntoView({ block: "center", inline: "center" });
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const event = type.startsWith("pointer")
          ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(event);
      }
      return { dispatched: true };
    })()`),
  },
  {
    name: "form_request_submit",
    run: async (cdp) => cdp.eval(`(() => {
      const form = window.__huntAuthProbe?.form;
      const target = window.__huntAuthProbe?.target;
      if (!form || typeof form.requestSubmit !== "function") return { skipped: "no_form_request_submit" };
      form.requestSubmit(target?.matches?.("button,input") ? target : undefined);
      return { requested: true };
    })()`),
  },
  {
    name: "dom_target_click",
    run: async (cdp) => cdp.eval(`(() => {
      const target = window.__huntAuthProbe?.target;
      if (!target || typeof target.click !== "function") return { skipped: "no_target_click" };
      target.click();
      return { clicked: true };
    })()`),
  },
  {
    name: "cdp_click_nocaptcha_wrapper",
    run: async (cdp, targets) => {
      const rect = targets.noCaptcha?.rect;
      if (!rect) return { skipped: "no_nocaptcha_rect" };
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      return { clicked: true, x: rect.x, y: rect.y };
    },
  },
  {
    name: "tab_until_submit_enter",
    run: async (cdp) => {
      await cdp.eval(`document.body?.focus?.()`);
      for (let i = 0; i < 12; i += 1) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      }
      const active = await cdp.eval(`(() => {
        const el = document.activeElement;
        return {
          tag: el?.tagName || "",
          text: String(el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || el?.value || "").replace(/\\s+/g, " ").trim(),
          automationId: el?.getAttribute?.("data-automation-id") || "",
        };
      })()`);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      return { activeBeforeEnter: active };
    },
  },
];

function changed(before, after) {
  return (
    before.href !== after.href ||
    before.step !== after.step ||
    before.title !== after.title ||
    before.finalSubmitVisible !== after.finalSubmitVisible ||
    JSON.stringify(before.errors || []) !== JSON.stringify(after.errors || [])
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const tabs = await getJson(args.cdpPort, "/json");
  const page = tabs.find(
    (tab) => tab.type === "page" && /myworkdayjobs\.com/i.test(tab.url || ""),
  );
  if (!page) throw new Error(`No Workday page found on ${args.cdpPort}`);
  const cdp = new CdpSession(page.webSocketDebuggerUrl);
  await cdp.connect();
  const report = {
    port: args.cdpPort,
    page: { title: page.title, url: page.url },
    startedAt: new Date().toISOString(),
    variants: [],
  };
  try {
    for (const variant of VARIANTS) {
      const before = await cdp.eval(SNAPSHOT_EXPRESSION);
      const targets = await cdp.eval(findTargetsExpression(args.email, args.password));
      const action = await variant.run(cdp, targets);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const after = await cdp.eval(SNAPSHOT_EXPRESSION);
      const entry = {
        name: variant.name,
        targets,
        action,
        before: {
          href: before.href,
          title: before.title,
          step: before.step,
          errors: before.errors,
          fields: before.fields,
        },
        after: {
          href: after.href,
          title: after.title,
          step: after.step,
          errors: after.errors,
          fields: after.fields,
          bodyHead: after.bodyHead,
        },
        changed: changed(before, after),
      };
      report.variants.push(entry);
      if (entry.changed && !/create account\/sign in|sign in/i.test(after.step || after.title || "")) {
        break;
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    cdp.close();
  }
  const output = JSON.stringify(report, null, 2);
  if (args.out) {
    fs.writeFileSync(args.out, output);
  }
  console.log(output);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
