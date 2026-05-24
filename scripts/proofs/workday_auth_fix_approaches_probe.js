"use strict";

/**
 * workday_auth_fix_approaches_probe.js
 *
 * Tests all candidate fix approaches for the Workday noCaptcha auth submit problem.
 * For each variant: fill credentials, commit checkbox, run submit method, check page progress.
 * Stops at first variant that produces progress (URL/step/title/errors changed),
 * unless --independent-variants is set.
 *
 * Usage:
 *   node scripts/proofs/workday_auth_fix_approaches_probe.js \
 *     --apply-url "https://wd1.myworkdayjobs.com/.../apply/..." \
 *     --mode signup \
 *     --email you@example.com \
 *     --password yourpassword \
 *     --out results.json
 *
 * --mode:              signup | signin (default: signup)
 * --settle-ms:         ms to wait after each submit attempt (default: 3500)
 * --no-stop-on-success run all variants even after one succeeds on the same page
 * --independent-variants reset to the apply URL and use a fresh plus-alias per variant
 * --cdp-port:          Chrome CDP port (default: 9222)
 */

const fs = require("fs");
const { CdpClient, httpJson, httpText, sleep, js } = require("../lib/c3_cdp");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    cdpPort: 9222,
    out: "",
    applyUrl: "",
    mode: "signup",
    email: process.env.HUNT_C3_TEST_ACCOUNT_EMAIL || "",
    password: process.env.HUNT_C3_TEST_ACCOUNT_PASSWORD || "",
    settleMs: 3500,
    stopOnSuccess: true,
    independentVariants: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) { args.cdpPort = Number(next); i += 1; }
    else if (arg === "--out" && next) { args.out = next; i += 1; }
    else if (arg === "--apply-url" && next) { args.applyUrl = next; i += 1; }
    else if (arg === "--mode" && next) { args.mode = next; i += 1; }
    else if (arg === "--email" && next) { args.email = next; i += 1; }
    else if (arg === "--password" && next) { args.password = next; i += 1; }
    else if (arg === "--settle-ms" && next) { args.settleMs = Number(next); i += 1; }
    else if (arg === "--no-stop-on-success") { args.stopOnSuccess = false; }
    else if (arg === "--independent-variants") { args.independentVariants = true; args.stopOnSuccess = false; }
    else { throw new Error(`Unknown arg: ${arg}`); }
  }
  return args;
}

function variantEmail(baseEmail, variantName, runSeed) {
  const email = String(baseEmail || "").trim();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at >= email.length - 1) return email;
  const local = email.slice(0, at).replace(/\+.*/, "");
  const domain = email.slice(at + 1);
  const slug = String(variantName || "variant")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 14);
  return `${local}+matrix${runSeed}${slug}@${domain}`;
}

// ---------------------------------------------------------------------------
// Shared expressions
// ---------------------------------------------------------------------------

const SNAPSHOT_EX = `(() => {
  const norm = (v) => String(v || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const step = document.querySelector('[data-automation-id="progressBarActiveStep"]');
  const fields = [...document.querySelectorAll('input:not([type="hidden"])')].filter((el) => el.name !== "website" && visible(el)).map((el) => ({
    type: el.type || "",
    automationId: el.getAttribute("data-automation-id") || "",
    id: el.id || "",
    valuePresent: Boolean(el.value),
    checked: el.type === "checkbox" ? Boolean(el.checked) : undefined,
    ariaChecked: el.getAttribute("aria-checked") || "",
  }));
  const buttons = [...document.querySelectorAll('button, [role="button"], a, [data-automation-id="click_filter"]')].filter(visible).map((el) => ({
    text: norm(el.innerText || el.textContent || el.getAttribute("aria-label") || el.value || ""),
    automationId: el.getAttribute("data-automation-id") || "",
    role: el.getAttribute("role") || "",
    tag: el.tagName,
  })).slice(0, 30);
  const errors = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error" i], [data-automation-id="inputAlert"]')]
    .map((el) => norm(el.innerText || el.textContent)).filter(Boolean).slice(0, 12);
  return {
    href: location.href,
    title: document.title,
    step: norm(step?.innerText || step?.textContent || ""),
    fields,
    buttons,
    errors,
    bodyHead: norm(document.body?.innerText || "").slice(0, 900),
  };
})()`;

function locateFillEx(email, password, mode) {
  return `(async () => {
    const email = ${js(email || "")};
    const password = ${js(password || "")};
    const mode = ${js(mode || "signup")};
    const norm = (v) => String(v || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      if (String(el.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
    };
    const labelOf = (el) => norm([
      el.getAttribute("aria-label"), el.getAttribute("title"),
      el.value, el.innerText, el.textContent,
    ].filter(Boolean).join(" "));
    const metaOf = (el) => norm([
      el.id, el.name, el.type,
      el.getAttribute("data-automation-id"), el.getAttribute("data-testid"), el.className,
    ].filter(Boolean).join(" "));
    const rectOf = (el) => {
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const setVal = (el, value) => {
      if (!el || value == null) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor?.set) descriptor.set.call(el, value); else el.value = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    };

    const inputs = [...document.querySelectorAll('input:not([type="hidden"])')].filter((el) => el.name !== "website" && visible(el));
    const inputText = (el) => norm([el.getAttribute("data-automation-id"), el.id, el.name, el.type, el.autocomplete, el.placeholder, el.getAttribute("aria-label")].filter(Boolean).join(" "));
    const emailInput = inputs.find((el) => /email|username|user/i.test(inputText(el)) && el.type !== "password");
    const passwords = inputs.filter((el) => el.type === "password");

    const filled = [];
    if (emailInput && email) { setVal(emailInput, email); filled.push("email"); }
    if (passwords[0] && password) { setVal(passwords[0], password); filled.push("password"); }
    if (passwords[1] && password && mode === "signup") { setVal(passwords[1], password); filled.push("verifyPassword"); }

    const checkbox = [...document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')]
      .filter(visible)
      .find((el) => /privacy|terms|notice|agree|consent|acknowledge|boeing|applicant|createaccountcheckbox/i.test(norm([
        labelOf(el), metaOf(el),
        el.closest("label")?.innerText,
        el.closest("[data-automation-id], section, div")?.innerText,
      ].filter(Boolean).join(" "))));

    let checkboxCommitted = false;
    if (checkbox) {
      const alreadyChecked = checkbox.checked || checkbox.getAttribute("aria-checked") === "true";
      if (!alreadyChecked) {
        checkbox.click?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!(checkbox.checked || checkbox.getAttribute("aria-checked") === "true") && checkbox instanceof HTMLInputElement) {
          const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
          if (d?.set) d.set.call(checkbox, true); else checkbox.checked = true;
          checkbox.setAttribute("aria-checked", "true");
          checkbox.dispatchEvent(new Event("input", { bubbles: true }));
          checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      checkboxCommitted = true;
    }

    const controls = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href], [data-automation-id="click_filter"]')]
      .filter(visible)
      .map((el) => {
        const label = labelOf(el);
        const meta = metaOf(el);
        let score = 0;
        if (/signinsubmitbutton|createaccountsubmitbutton/i.test(meta)) score += 100;
        if (/click_filter/i.test(meta)) score += 80;
        if (mode === "signup") {
          if (/^create account(?: create account)?$/i.test(label)) score += 90;
          if (/sign in|log in/i.test(label + " " + meta)) score -= 80;
        } else {
          if (/^sign in(?: sign in)?$/i.test(label)) score += 90;
          if (/create account/i.test(label + " " + meta)) score -= 50;
        }
        if (/^submit$/i.test(label)) score += 70;
        if (/forgot|back|google|linkedin|search for jobs|backtojobposting/i.test(label + " " + meta)) score -= 100;
        return { el, label, meta, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const target = controls[0]?.el || null;
    const clickFilter = document.querySelector('[data-automation-id="click_filter"]');
    const noCaptcha = document.querySelector('[data-automation-id="noCaptchaWrapper"]');
    const hiddenSubmit =
      document.querySelector('[data-automation-id="createAccountSubmitButton"]') ||
      document.querySelector('[data-automation-id="signInSubmitButton"]') ||
      null;

    window.__authFixProbe = { target, clickFilter, noCaptcha, hiddenSubmit, passwords };

    return {
      filled,
      checkboxCommitted,
      target: target ? { label: labelOf(target), meta: metaOf(target), rect: rectOf(target) } : null,
      clickFilter: clickFilter ? { meta: metaOf(clickFilter), rect: rectOf(clickFilter) } : null,
      noCaptcha: noCaptcha ? { meta: metaOf(noCaptcha), rect: rectOf(noCaptcha) } : null,
      hiddenSubmit: hiddenSubmit ? {
        automationId: hiddenSubmit.getAttribute("data-automation-id") || "",
        ariaHidden: hiddenSubmit.getAttribute("aria-hidden") || "",
        display: getComputedStyle(hiddenSubmit).display,
        rect: (() => { const r = hiddenSubmit.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
      } : null,
      passwordCount: passwords.length,
      passwordRect: passwords[passwords.length - 1] ? rectOf(passwords[passwords.length - 1]) : null,
      bodyHead: norm(document.body?.innerText || "").slice(0, 500),
      href: location.href,
    };
  })()`;
}

// Navigate to landing choice and click "Sign in with email" if signin mode
function landingChoiceEx(mode) {
  return `(() => {
    const mode = ${js(mode || "signup")};
    const norm = (v) => String(v || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      if (String(el.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
    };
    const labelOf = (el) => norm([el.getAttribute("aria-label"), el.getAttribute("title"), el.value, el.innerText, el.textContent].filter(Boolean).join(" "));
    const metaOf = (el) => norm([el.id, el.getAttribute("data-automation-id"), el.className].filter(Boolean).join(" "));
    const bodyText = norm(document.body?.innerText || "").toLowerCase();
    const isLandingChoice = /create account.*sign in|sign in.*create account/i.test(bodyText.slice(0, 1000)) ||
      /create a new account|already have an account/i.test(bodyText.slice(0, 1000));
    if (!isLandingChoice) return { handled: false, reason: "not_landing_choice_page" };
    const link = [...document.querySelectorAll('button, [role="button"], a')].filter(visible).sort((a, b) => {
      const score = (el) => {
        const t = labelOf(el), d = metaOf(el);
        let v = 0;
        if (mode === "signin" && /SignInWithEmailButton|signInLink/i.test(d)) v += 100;
        if (mode === "signin" && /^sign in with email$/i.test(t)) v += 90;
        if (mode === "signin" && /^sign in$/i.test(t)) v += 60;
        if (mode === "signup" && /createAccountLink|createAccount/i.test(d)) v += 100;
        if (mode === "signup" && /^create account$/i.test(t)) v += 90;
        if (/google|linkedin|facebook|forgot/i.test(t + " " + d)) v -= 120;
        return v;
      };
      return score(b) - score(a);
    }).find((el) => {
      const t = labelOf(el), d = metaOf(el);
      return (mode === "signin" && /SignInWithEmailButton|signInLink/i.test(d)) ||
        (mode === "signup" && /createAccountLink|createAccount/i.test(d)) ||
        (mode === "signin" && /^sign in( with email)?$/i.test(t)) ||
        (mode === "signup" && /create account/i.test(t));
    });
    if (!link) return { handled: false, reason: "no_entry_link_found" };
    link.scrollIntoView({ block: "center", inline: "center" });
    link.click();
    return { handled: true, clicked: labelOf(link) };
  })()`;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

const VARIANTS = [
  // ---- Baseline: Current C3 methods ----
  {
    name: "A1_cdp_click_primary_button",
    approach: "baseline",
    desc: "CDP mouse click on highest-scored visible button (click_filter or submit). This is current C3 behavior.",
    run: async (cdp, targets) => {
      const rect = targets.target?.rect || targets.clickFilter?.rect;
      if (!rect) return { skipped: "no_target_rect" };
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      return { clicked: true, x: rect.x, y: rect.y };
    },
  },
  {
    name: "A2_form_request_submit",
    approach: "baseline",
    desc: "form.requestSubmit(target). C3 calls this after CDP click — known to fail on Boeing noCaptchaWrapper.",
    run: async (cdp) => cdp.evaluate(`(() => {
      const target = window.__authFixProbe?.target;
      const form = target?.closest?.("form");
      if (!form || typeof form.requestSubmit !== "function") return { skipped: "no_form" };
      try { form.requestSubmit(target.matches?.("button,input") ? target : undefined); return { ok: true }; }
      catch (e) { return { ok: false, err: String(e) }; }
    })()`),
  },
  {
    name: "A3_dom_target_click",
    approach: "baseline",
    desc: "target.click() on highest-scored visible button.",
    run: async (cdp) => cdp.evaluate(`(() => {
      const el = window.__authFixProbe?.target;
      if (!el) return { skipped: "no_target" };
      el.click();
      return { clicked: true };
    })()`),
  },

  // ---- Approach 3: click_filter DOM methods ----
  {
    name: "B1_cdp_click_click_filter",
    approach: "click_filter_methods",
    desc: "CDP click directly on click_filter overlay div (not just whatever scores highest).",
    run: async (cdp, targets) => {
      const rect = targets.clickFilter?.rect;
      if (!rect) return { skipped: "no_click_filter_rect" };
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      return { clicked: true, x: rect.x, y: rect.y };
    },
  },
  {
    name: "B2_dom_pointer_click_filter",
    approach: "click_filter_methods",
    desc: "Full DOM pointer event chain (pointerover→mouseover→...→click) on click_filter. More complete than bare .click().",
    run: async (cdp) => cdp.evaluate(`(() => {
      const el = window.__authFixProbe?.clickFilter || window.__authFixProbe?.target;
      if (!el) return { skipped: "no_click_filter" };
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2), cy = Math.round(rect.top + rect.height / 2);
      for (const type of ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: cx, clientY: cy }));
      }
      return { dispatched: true };
    })()`),
  },
  {
    name: "B3_react_fiber_click_filter",
    approach: "click_filter_methods",
    desc: "Walk __reactFiber$ on click_filter to find and call onClick directly. Bypasses DOM event system.",
    run: async (cdp) => cdp.evaluate(`(() => {
      const el = window.__authFixProbe?.clickFilter || window.__authFixProbe?.target;
      if (!el) return { skipped: "no_click_filter" };
      const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      if (!fiberKey) return { skipped: "no_react_fiber" };
      let node = el[fiberKey];
      while (node) {
        const props = node.memoizedProps || node.pendingProps;
        if (props?.onClick) {
          const evt = { type: "click", target: el, currentTarget: el, bubbles: true,
            nativeEvent: new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }),
            preventDefault: () => {}, stopPropagation: () => {},
            isPropagationStopped: () => false, isDefaultPrevented: () => false };
          props.onClick(evt);
          return { fired: true, fiberKey };
        }
        if (props?.onMouseDown) {
          const evt = { type: "mousedown", target: el, currentTarget: el, bubbles: true,
            nativeEvent: new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
            preventDefault: () => {}, stopPropagation: () => {},
            isPropagationStopped: () => false, isDefaultPrevented: () => false };
          props.onMouseDown(evt);
          return { fired: true, via: "onMouseDown", fiberKey };
        }
        node = node.return;
      }
      return { skipped: "no_onClick_in_fiber" };
    })()`),
  },

  // ---- Approach 1: Hidden submit button ----
  {
    name: "C1_hidden_submit_button_click",
    approach: "hidden_submit_button",
    desc: "Direct .click() on createAccountSubmitButton / signInSubmitButton. Bypasses visibility. Boeing proof confirmed this works.",
    run: async (cdp) => cdp.evaluate(`(() => {
      const el = window.__authFixProbe?.hiddenSubmit ||
        document.querySelector('[data-automation-id="createAccountSubmitButton"]') ||
        document.querySelector('[data-automation-id="signInSubmitButton"]');
      if (!el) return { skipped: "no_hidden_submit_found" };
      el.click();
      return { clicked: true, automationId: el.getAttribute("data-automation-id") || "", ariaHidden: el.getAttribute("aria-hidden") || "" };
    })()`),
  },
  {
    name: "C2_hidden_submit_form_request_submit",
    approach: "hidden_submit_button",
    desc: "form.requestSubmit() passing the hidden submit button as the submitter argument.",
    run: async (cdp) => cdp.evaluate(`(() => {
      const btn = window.__authFixProbe?.hiddenSubmit ||
        document.querySelector('[data-automation-id="createAccountSubmitButton"]') ||
        document.querySelector('[data-automation-id="signInSubmitButton"]');
      if (!btn) return { skipped: "no_hidden_submit_found" };
      const form = btn.closest("form");
      if (!form || typeof form.requestSubmit !== "function") return { skipped: "no_form" };
      try { form.requestSubmit(btn); return { ok: true }; }
      catch (e) { return { ok: false, err: String(e) }; }
    })()`),
  },
  {
    name: "C3_hidden_submit_pointer_events",
    approach: "hidden_submit_button",
    desc: "Full DOM pointer event chain on the hidden submit button. In case .click() alone is not enough.",
    run: async (cdp) => cdp.evaluate(`(() => {
      const el = window.__authFixProbe?.hiddenSubmit ||
        document.querySelector('[data-automation-id="createAccountSubmitButton"]') ||
        document.querySelector('[data-automation-id="signInSubmitButton"]');
      if (!el) return { skipped: "no_hidden_submit_found" };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
      }
      return { dispatched: true, automationId: el.getAttribute("data-automation-id") || "" };
    })()`),
  },

  // ---- Approach 4: Blur-settle ----
  {
    name: "D1_blur_settle_cdp_click",
    approach: "blur_settle",
    desc: "Blur active element + 1800ms settle, then CDP click primary button. Lets Workday run its validation before submit.",
    run: async (cdp, targets) => {
      await cdp.evaluate(`document.activeElement?.blur?.()`);
      await sleep(1800);
      const rect = targets.target?.rect || targets.clickFilter?.rect;
      if (!rect) return { skipped: "no_rect" };
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      return { blurred: true, clicked: true };
    },
  },
  {
    name: "D2_blur_settle_dom_pointer_click_filter",
    approach: "blur_settle",
    desc: "Blur + 1800ms settle, then full DOM pointer sequence on click_filter.",
    run: async (cdp) => {
      await cdp.evaluate(`document.activeElement?.blur?.()`);
      await sleep(1800);
      return cdp.evaluate(`(() => {
        const el = window.__authFixProbe?.clickFilter || window.__authFixProbe?.target;
        if (!el) return { skipped: "no_click_filter" };
        el.scrollIntoView({ block: "center", inline: "center" });
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
        }
        return { dispatched: true };
      })()`);
    },
  },
  {
    name: "D3_blur_settle_hidden_submit",
    approach: "blur_settle",
    desc: "Blur + 1800ms settle, then hidden submit button click. Combines approaches 1 + 4.",
    run: async (cdp) => {
      await cdp.evaluate(`document.activeElement?.blur?.()`);
      await sleep(1800);
      return cdp.evaluate(`(() => {
        const el = window.__authFixProbe?.hiddenSubmit ||
          document.querySelector('[data-automation-id="createAccountSubmitButton"]') ||
          document.querySelector('[data-automation-id="signInSubmitButton"]');
        if (!el) return { skipped: "no_hidden_submit_found" };
        el.click();
        return { clicked: true, automationId: el.getAttribute("data-automation-id") || "" };
      })()`);
    },
  },

  // ---- noCaptchaWrapper sequences ----
  {
    name: "E1_cdp_click_nocaptcha_wrapper",
    approach: "nocaptcha_wrapper_sequences",
    desc: "CDP click on noCaptchaWrapper outer div center.",
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
    name: "E2_nocaptcha_wrapper_then_click_filter",
    approach: "nocaptcha_wrapper_sequences",
    desc: "CDP click noCaptchaWrapper first, 500ms settle for Workday internal state, then DOM pointer on click_filter.",
    run: async (cdp, targets) => {
      const rect = targets.noCaptcha?.rect;
      if (rect) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
        await sleep(500);
      }
      return cdp.evaluate(`(() => {
        const el = window.__authFixProbe?.clickFilter || window.__authFixProbe?.target;
        if (!el) return { skipped: "no_click_filter" };
        el.scrollIntoView({ block: "center", inline: "center" });
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
        }
        return { dispatched: true };
      })()`);
    },
  },
  {
    name: "E3_nocaptcha_wrapper_then_hidden_submit",
    approach: "nocaptcha_wrapper_sequences",
    desc: "CDP click noCaptchaWrapper, 500ms settle, then hidden submit button click. Most complete wrapper path.",
    run: async (cdp, targets) => {
      const rect = targets.noCaptcha?.rect;
      if (rect) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
        await sleep(500);
      }
      return cdp.evaluate(`(() => {
        const el = window.__authFixProbe?.hiddenSubmit ||
          document.querySelector('[data-automation-id="createAccountSubmitButton"]') ||
          document.querySelector('[data-automation-id="signInSubmitButton"]');
        if (!el) return { skipped: "no_hidden_submit_found" };
        el.click();
        return { clicked: true, automationId: el.getAttribute("data-automation-id") || "" };
      })()`);
    },
  },

  // ---- Keyboard-based submit ----
  {
    name: "F1_cdp_enter_from_password_field",
    approach: "keyboard_submit",
    desc: "Focus last password field, CDP Enter key. Bypasses all button/wrapper logic entirely.",
    run: async (cdp) => {
      await cdp.evaluate(`(() => {
        const passwords = window.__authFixProbe?.passwords ||
          [...document.querySelectorAll('input[type="password"]')].filter((el) => {
            const s = getComputedStyle(el), r = el.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
          });
        const last = passwords[passwords.length - 1];
        if (!last) return false;
        last.scrollIntoView({ block: "center", inline: "center" });
        last.focus?.({ preventScroll: true });
        return document.activeElement === last;
      })()`);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      return { entered: true };
    },
  },
  {
    name: "F2_focus_wrapper_space",
    approach: "keyboard_submit",
    desc: "Focus click_filter wrapper, press Space. Activates role=button via keyboard semantics.",
    run: async (cdp) => {
      const focused = await cdp.evaluate(`(() => {
        const el = window.__authFixProbe?.clickFilter || window.__authFixProbe?.target;
        if (!el) return false;
        el.focus?.({ preventScroll: false });
        return Boolean(el);
      })()`);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      return { focused };
    },
  },
  {
    name: "F3_tab_until_submit_enter",
    approach: "keyboard_submit",
    desc: "Tab through the form up to 14 times until a submit button is focused, then Enter.",
    run: async (cdp) => {
      await cdp.evaluate(`document.body?.focus?.()`);
      for (let i = 0; i < 14; i += 1) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await sleep(80);
      }
      const active = await cdp.evaluate(`(() => {
        const el = document.activeElement;
        return {
          tag: el?.tagName || "",
          automationId: el?.getAttribute?.("data-automation-id") || "",
          label: String(el?.innerText || el?.value || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim(),
        };
      })()`);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      return { activeBeforeEnter: active };
    },
  },
];

// ---------------------------------------------------------------------------
// Progress detection
// ---------------------------------------------------------------------------

function pageChanged(before, after) {
  return (
    before.href !== after.href ||
    before.step !== after.step ||
    before.title !== after.title ||
    JSON.stringify(before.errors || []) !== JSON.stringify(after.errors || [])
  );
}

function classifyProgress(before, after) {
  if (before.href !== after.href) return "url_changed";
  if (before.step !== after.step) return "step_changed";
  if (
    before.title !== after.title &&
    /^(sign in|create account)$/i.test(before.title || "") &&
    /^(sign in|create account)$/i.test(after.title || "") &&
    !((after.errors || []).length)
  ) {
    return "auth_form_toggle";
  }
  if (before.title !== after.title) return "title_changed";
  if ((after.errors || []).length && !((before.errors || []).length)) return "errors_appeared";
  if ((after.errors || []).length !== (before.errors || []).length) return "errors_changed";
  return "no_change";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  let tabs = await httpJson(args.cdpPort, "/json/list");
  let page = tabs.find((tab) => tab.type === "page" && /myworkdayjobs\.com/i.test(tab.url || ""));
  if (!page && args.applyUrl) {
    await httpText(args.cdpPort, `/json/new?${encodeURIComponent(args.applyUrl)}`, "PUT");
    await sleep(2500);
    tabs = await httpJson(args.cdpPort, "/json/list");
    page = tabs.find((tab) => tab.type === "page" && /myworkdayjobs\.com/i.test(tab.url || ""));
  }
  if (!page) throw new Error(`No Workday page found on port ${args.cdpPort}`);

  const cdp = await new CdpClient(page.webSocketDebuggerUrl).connect();
  await cdp.send("Page.enable").catch(() => {});

  const report = {
    port: args.cdpPort,
    mode: args.mode,
    applyUrl: args.applyUrl || page.url,
    page: { title: page.title, url: page.url },
    startedAt: new Date().toISOString(),
    independentVariants: Boolean(args.independentVariants),
    variants: [],
    winner: null,
  };
  const runSeed = Date.now().toString(36).slice(-5);

  try {
    // Navigate to apply URL if provided
    if (args.applyUrl && !args.independentVariants) {
      console.error(`[probe] Navigating to ${args.applyUrl}`);
      await cdp.send("Page.navigate", { url: args.applyUrl });
      await sleep(5000);
    }

    // Handle landing choice page (Sign in / Create Account)
    const landingResult = await cdp.evaluate(landingChoiceEx(args.mode));
    if (landingResult?.handled) {
      console.error(`[probe] Landing choice handled: clicked "${landingResult.clicked}"`);
      await sleep(2500);
    }

    // Run variants
    for (const variant of VARIANTS) {
      console.error(`[probe] Running variant: ${variant.name}`);
      const variantRunEmail = args.independentVariants
        ? variantEmail(args.email, variant.name, runSeed)
        : args.email;

      if (args.independentVariants) {
        await cdp.send("Network.enable").catch(() => {});
        await cdp.send("Network.clearBrowserCookies").catch(() => {});
        try {
          const origin = new URL(args.applyUrl || page.url).origin;
          await cdp.send("Storage.clearDataForOrigin", {
            origin,
            storageTypes: "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers",
          }).catch(() => {});
        } catch (_error) {}
        console.error(`[probe]   reset+navigate for ${variant.name}`);
        await cdp.send("Page.navigate", { url: args.applyUrl || page.url });
        await sleep(5000);
        const perVariantLanding = await cdp.evaluate(landingChoiceEx(args.mode));
        if (perVariantLanding?.handled) {
          console.error(`[probe]   landing clicked "${perVariantLanding.clicked}"`);
          await sleep(2500);
        }
      }

      // Re-fill fields and re-commit checkbox before each attempt
      const targets = await cdp.evaluate(locateFillEx(variantRunEmail, args.password, args.mode));
      await sleep(600);

      const before = await cdp.evaluate(SNAPSHOT_EX);
      let action = null;
      let actionError = null;

      try {
        action = await variant.run(cdp, targets);
      } catch (err) {
        actionError = err instanceof Error ? err.message : String(err);
      }

      await sleep(args.settleMs);
      const after = await cdp.evaluate(SNAPSHOT_EX);
      const changed = pageChanged(before, after);
      const progressKind = classifyProgress(before, after);

      const entry = {
        name: variant.name,
        approach: variant.approach,
        desc: variant.desc,
        independentVariant: Boolean(args.independentVariants),
        emailVariant: args.independentVariants ? variant.name : "",
        targets: {
          filled: targets.filled,
          checkboxCommitted: targets.checkboxCommitted,
          hasTarget: Boolean(targets.target),
          hasClickFilter: Boolean(targets.clickFilter),
          hasNoCaptcha: Boolean(targets.noCaptcha),
          hiddenSubmit: targets.hiddenSubmit || null,
          targetLabel: targets.target?.label || "",
          targetMeta: targets.target?.meta || "",
        },
        action,
        actionError,
        before: { href: before.href, title: before.title, step: before.step, errors: before.errors },
        after: { href: after.href, title: after.title, step: after.step, errors: after.errors, bodyHead: after.bodyHead },
        changed,
        progressKind,
      };

      report.variants.push(entry);

      const winnerEligible = changed && progressKind !== "auth_form_toggle";
      const symbol = winnerEligible ? "CHANGED" : changed ? "toggle" : "no_change";
      console.error(`[probe]   ${symbol} — ${progressKind} — ${variant.name}`);

      if (winnerEligible && !report.winner) {
        report.winner = { name: variant.name, approach: variant.approach, progressKind };
      }

      if (winnerEligible && args.stopOnSuccess) {
        console.error(`[probe] Success on ${variant.name}, stopping.`);
        break;
      }

      // If page moved, we can't test further variants on this run
      if (winnerEligible && before.href !== after.href && args.stopOnSuccess) {
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
    console.error(`[probe] Report saved to ${args.out}`);
  }
  console.log(output);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
