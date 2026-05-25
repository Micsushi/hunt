#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("../lib/c3_cdp");

function parseArgs(argv) {
  const args = { cdpPort: 0, mode: "", out: "", searchText: "Customer Service" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--mode" && next) {
      args.mode = next;
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--search-text" && next) {
      args.searchText = next;
      args.searchTextProvided = true;
      i += 1;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.help) {
    console.log("Usage: node scripts/proofs/workday_failed_lane_deep_probe.js --cdp-port 9694 --mode skills|degree|disclosure|source|inspect|sync-events --out logs/x.json");
    process.exit(0);
  }
  if (!args.cdpPort || !args.mode || !args.out) {
    throw new Error("--cdp-port, --mode, and --out are required");
  }
  return args;
}

async function connectPage(port) {
  const targets = await httpJson(port, "/json/list");
  const target =
    targets.find((item) => item.type === "page" && /myworkdayjobs\.com/i.test(String(item.url || ""))) ||
    targets.find((item) => item.type === "page" && /workday/i.test(String(item.url || item.title || ""))) ||
    targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No usable page target on ${port}`);
  }
  return { target, client: await new CdpClient(target.webSocketDebuggerUrl).connect() };
}

function js(value) {
  return JSON.stringify(value);
}

async function evalPage(client, fn, arg = null, timeoutMs = 60000) {
  return client.evaluate(
    `(() => { const pageSnapshot = ${pageSnapshot.toString()}; return (${fn.toString()})(${js(arg)}); })()`,
    timeoutMs,
  );
}

async function clickPoint(client, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`Bad click point: ${JSON.stringify(point)}`);
  }
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function key(client, keyName) {
  const codes = {
    Enter: ["Enter", 13],
    Escape: ["Escape", 27],
    Tab: ["Tab", 9],
    Space: ["Space", 32],
    Home: ["Home", 36],
    ArrowDown: ["ArrowDown", 40],
    ArrowRight: ["ArrowRight", 39],
    Backspace: ["Backspace", 8],
  };
  const [code, windowsVirtualKeyCode] = codes[keyName] || [keyName, 0];
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyName,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyName,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
}

async function keySequence(client, keys) {
  for (const item of keys) {
    await key(client, item);
    await sleep(80);
  }
}

async function text(client, value) {
  for (const char of String(value || "")) {
    await client.send("Input.dispatchKeyEvent", {
      type: "char",
      text: char,
      unmodifiedText: char,
    });
    await sleep(18);
  }
}

async function ctrlABackspace(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    modifiers: 2,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
  });
  await key(client, "Backspace");
}

function pageSnapshot(arg) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const label = (el) =>
    norm([el?.innerText, el?.textContent, el?.getAttribute?.("aria-label"), el?.value].filter(Boolean).join(" "));
  const rect = (el) => {
    const r = el?.getBoundingClientRect?.();
    return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  const body = document.body?.innerText || "";
  const stepMatch = body.match(/current\s+s?tep\s+(\d+)\s+of\s+(\d+)\s*\n([^\n]+)/i);
  const fields = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, button[aria-haspopup], [role='combobox']"))
    .filter(visible)
    .map((el) => ({
      tag: el.tagName,
      id: el.id || "",
      name: el.getAttribute("name") || "",
      role: el.getAttribute("role") || "",
      auto: el.getAttribute("data-automation-id") || "",
      uxi: el.getAttribute("data-uxi-widget-type") || "",
      aria: el.getAttribute("aria-label") || "",
      expanded: el.getAttribute("aria-expanded") || "",
      invalid: el.getAttribute("aria-invalid") || "",
      checked: el.checked ?? null,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
      value: "value" in el ? el.value : "",
      text: label(el).slice(0, 240),
      rect: rect(el),
    }));
  const selected = Array.from(
    document.querySelectorAll(
      "[data-automation-id='selectedItem'], [data-automation-id='selectedItemList'] [role='listitem'], [id^='pill-'], [aria-label*='press delete to clear value']",
    ),
  )
    .filter(visible)
    .map(label)
    .filter(Boolean);
  const errors = Array.from(
    document.querySelectorAll("[role='alert'], [data-automation-id='inputAlert'], [data-automation-id='errorMessage'], [id*='error']"),
  )
    .filter(visible)
    .map(label)
    .filter(Boolean)
    .filter((item) => !/successfully uploaded/i.test(item));
  const buttons = Array.from(document.querySelectorAll("button"))
    .filter(visible)
    .map((el) => ({
      text: label(el).slice(0, 160),
      id: el.id || "",
      auto: el.getAttribute("data-automation-id") || "",
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
      rect: rect(el),
    }));
  return {
    label: arg?.label || "",
    href: location.href,
    title: document.title,
    y: Math.round(scrollY),
    step: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: norm(stepMatch[3]) } : null,
    errors: errors.slice(0, 30),
    selected: selected.slice(0, 40),
    fields,
    buttons,
    bodyTail: norm(body).slice(-1200),
  };
}

function relevantState(arg) {
  const snap = pageSnapshot(arg);
  const rx = new RegExp(arg?.filter || ".", "i");
  return {
    ...snap,
    fields: snap.fields.filter((item) => rx.test([item.id, item.name, item.aria, item.text, item.value].join(" "))),
    buttons: snap.buttons.filter((item) => /back|save|continue|submit/i.test(item.text)),
  };
}

function activeRows(arg) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const label = (el) =>
    norm([el?.innerText, el?.textContent, el?.getAttribute?.("aria-label"), el?.getAttribute?.("data-automation-label")].filter(Boolean).join(" "));
  const rect = (el) => {
    const r = el?.getBoundingClientRect?.();
    return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  const boxes = Array.from(
    document.querySelectorAll(
      "[data-automation-id='activeListContainer'], [data-automation-id='promptSearchResultList'], [data-uxi-widget-type='multiselectlist'], [role='listbox']",
    ),
  )
    .filter(visible)
    .filter((box) => !box.closest("[data-automation-id='selectedItemList']"))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.height - ar.height || br.width - ar.width;
    });
  const listbox = boxes[0] || null;
  const scope = listbox || document;
  const rows = Array.from(
    scope.querySelectorAll(
      "[role='option'], [data-automation-id='menuItem'], [data-automation-id='promptLeafNode'], [data-automation-id='promptOption'], li",
    ),
  )
    .filter(visible)
    .map((el) => {
      const promptLeaf =
        el.matches?.("[data-automation-id='promptLeafNode']")
          ? el
          : el.querySelector?.("[data-automation-id='promptLeafNode']");
      const promptOption =
        el.matches?.("[data-automation-id='promptOption']")
          ? el
          : el.querySelector?.("[data-automation-id='promptOption']");
      const checkbox = el.querySelector?.("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio']");
      const r = rect(el);
      const leafRect = rect(promptLeaf);
      const optionRect = rect(promptOption);
      const checkboxRect = rect(checkbox);
      return {
        tag: el.tagName,
        id: el.id || "",
        role: el.getAttribute("role") || "",
        auto: el.getAttribute("data-automation-id") || "",
        uxi: el.getAttribute("data-uxi-widget-type") || "",
        type: promptLeaf?.getAttribute?.("data-uxi-multiselectlistitem-type") || el.getAttribute("data-uxi-multiselectlistitem-type") || "",
        hasSideCharm:
          promptLeaf?.getAttribute?.("data-uxi-multiselectlistitem-hassidecharm") ||
          el.getAttribute("data-uxi-multiselectlistitem-hassidecharm") ||
          "",
        aria: el.getAttribute("aria-label") || "",
        selected: el.getAttribute("aria-selected") || el.getAttribute("data-automation-selected") || "",
        checked: el.getAttribute("data-automation-checked") || el.getAttribute("aria-checked") || "",
        text: label(el),
        rect: r,
        points: {
          center: r ? { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) } : null,
          left: r ? { x: Math.round(r.x + 18), y: Math.round(r.y + r.h / 2) } : null,
          side: r ? { x: Math.round(r.x + r.w - 18), y: Math.round(r.y + r.h / 2) } : null,
          leaf: leafRect ? { x: Math.round(leafRect.x + Math.min(40, leafRect.w / 2)), y: Math.round(leafRect.y + leafRect.h / 2) } : null,
          prompt: optionRect ? { x: Math.round(optionRect.x + Math.min(60, optionRect.w / 2)), y: Math.round(optionRect.y + optionRect.h / 2) } : null,
          checkbox: checkboxRect ? { x: Math.round(checkboxRect.x + checkboxRect.w / 2), y: Math.round(checkboxRect.y + checkboxRect.h / 2) } : null,
        },
      };
    });
  return {
    listbox: listbox
      ? {
          tag: listbox.tagName,
          id: listbox.id || "",
          auto: listbox.getAttribute("data-automation-id") || "",
          role: listbox.getAttribute("role") || "",
          ariaActive: listbox.getAttribute("aria-activedescendant") || "",
          scrollTop: listbox.scrollTop,
          scrollHeight: listbox.scrollHeight,
          clientHeight: listbox.clientHeight,
          rect: rect(listbox),
          text: label(listbox).slice(0, 500),
        }
      : null,
    rows,
  };
}

function reactClickVisibleRow(arg) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const label = (el) =>
    norm([el?.innerText, el?.textContent, el?.getAttribute?.("aria-label"), el?.getAttribute?.("data-automation-label")].filter(Boolean).join(" "));
  const rect = (el) => {
    const r = el?.getBoundingClientRect?.();
    return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  const infoFor = (el) => {
    const r = rect(el);
    const fiberKey = Object.keys(el || {}).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
    const propChain = [];
    let node = fiberKey ? el[fiberKey] : null;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const props = node.memoizedProps || node.pendingProps || {};
      const keys = Object.keys(props).filter((key) => /^on[A-Z]/.test(key));
      if (keys.length) {
        propChain.push({
          depth,
          elementType: typeof node.elementType === "string" ? node.elementType : node.elementType?.displayName || node.type?.displayName || node.tag || "",
          keys,
        });
      }
      node = node.return;
    }
    return {
      tag: el?.tagName || "",
      id: el?.id || "",
      auto: el?.getAttribute?.("data-automation-id") || "",
      role: el?.getAttribute?.("role") || "",
      aria: el?.getAttribute?.("aria-label") || "",
      text: label(el).slice(0, 240),
      rect: r,
      fiberKey: fiberKey || "",
      propChain,
    };
  };
  const fireReactHandler = (el) => {
    try {
      const fiberKey = Object.keys(el || {}).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
      let node = fiberKey ? el[fiberKey] : null;
      while (node) {
        const props = node.memoizedProps || node.pendingProps || {};
        const mockEvt = {
          type: "click",
          target: el,
          currentTarget: el,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          detail: 1,
          stopPropagation() {},
          preventDefault() {},
          persist() {},
          isPropagationStopped() {
            return false;
          },
          isDefaultPrevented() {
            return false;
          },
          nativeEvent: new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            detail: 1,
          }),
        };
        if (typeof props.onClick === "function") {
          props.onClick(mockEvt);
          return { fired: true, event: "onClick", at: infoFor(el), propOwner: infoFor(node.stateNode || el) };
        }
        if (typeof props.onMouseDown === "function") {
          mockEvt.type = "mousedown";
          props.onMouseDown(mockEvt);
          return { fired: true, event: "onMouseDown", at: infoFor(el), propOwner: infoFor(node.stateNode || el) };
        }
        if (typeof props.onChange === "function") {
          mockEvt.type = "change";
          mockEvt.nativeEvent = new Event("change", { bubbles: true, cancelable: true });
          props.onChange(mockEvt);
          return { fired: true, event: "onChange", at: infoFor(el), propOwner: infoFor(node.stateNode || el) };
        }
        node = node.return;
      }
    } catch (error) {
      return { fired: false, error: String(error && error.message ? error.message : error) };
    }
    return { fired: false };
  };
  const wanted = new RegExp(arg?.regex || ".", "i");
  const boxes = Array.from(
    document.querySelectorAll(
      "[data-automation-id='activeListContainer'], [data-automation-id='promptSearchResultList'], [data-uxi-widget-type='multiselectlist'], [role='listbox']",
    ),
  ).filter(visible);
  const scope = boxes[0] || document;
  const rows = Array.from(
    scope.querySelectorAll(
      "[data-automation-id='menuItem'], [data-automation-id='promptLeafNode'], [data-automation-id='promptOption'], [role='option'], [role='treeitem'], li",
    ),
  )
    .filter(visible)
    .filter((el) => !el.closest("[data-automation-id='selectedItemList']"))
    .map((el) => ({ el, text: label(el), rect: rect(el), auto: el.getAttribute("data-automation-id") || "", role: el.getAttribute("role") || "" }))
    .filter((item) => wanted.test(item.text))
    .sort((a, b) => {
      const prefer = String(arg?.prefer || "");
      const aScore =
        prefer === "menuItem" && a.auto === "menuItem"
          ? 0
          : prefer === "promptLeaf" && a.auto === "promptLeafNode"
            ? 0
            : prefer === "option" && /option|treeitem/.test(a.role)
              ? 0
              : 1;
      const bScore =
        prefer === "menuItem" && b.auto === "menuItem"
          ? 0
          : prefer === "promptLeaf" && b.auto === "promptLeafNode"
            ? 0
            : prefer === "option" && /option|treeitem/.test(b.role)
              ? 0
              : 1;
      return aScore - bScore || a.text.length - b.text.length || (a.rect?.y || 0) - (b.rect?.y || 0);
    });
  const row = rows[0]?.el || null;
  if (!row) {
    return {
      ok: false,
      reason: "row_not_found",
      visibleRows: rows.slice(0, 20).map((item) => ({ text: item.text, auto: item.auto, role: item.role, rect: item.rect })),
    };
  }
  const sideTarget =
    row.getBoundingClientRect &&
    (() => {
      const r = row.getBoundingClientRect();
      return document.elementFromPoint(Math.max(r.left + 1, r.right - 24), r.top + r.height / 2);
    })();
  const candidates = [
    arg?.prefer === "side" && sideTarget && row.contains(sideTarget) ? sideTarget : null,
    row,
    row.querySelector?.("[data-automation-id='checkboxPanel'], [role='checkbox'], [role='radio'], input[type='checkbox'], input[type='radio']"),
    row.querySelector?.("[data-automation-id='promptLeafNode']"),
    row.querySelector?.("[data-automation-id='promptOption']"),
    ...Array.from(row.querySelectorAll?.("[data-uxi-widget-type], input, label, span, div") || []).slice(0, 10),
  ].filter(Boolean);
  const seen = new Set();
  const uniqueCandidates = candidates.filter((el) => {
    if (seen.has(el)) return false;
    seen.add(el);
    return true;
  });
  const inspected = uniqueCandidates.map(infoFor);
  const fired = [];
  for (const candidate of uniqueCandidates) {
    const result = fireReactHandler(candidate);
    fired.push(result);
    if (result.fired && !arg?.fireAll) {
      break;
    }
  }
  return {
    ok: fired.some((item) => item.fired),
    reason: fired.some((item) => item.fired) ? "" : "no_react_handler_fired",
    row: infoFor(row),
    inspected,
    fired,
  };
}

function findFieldPoint(arg) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const wanted = new RegExp(arg.regex, "i");
  const controls = Array.from(document.querySelectorAll(arg.selector || "input:not([type='hidden']), textarea, button, [role='combobox']"))
    .map((el) => {
      const container = el.closest("[data-automation-id^='formField'], [role='group'], [data-fkit-id], section, fieldset") || el.parentElement;
      const text = norm([el.id, el.name, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.innerText, el.textContent, container?.innerText].filter(Boolean).join(" "));
      return { el, text };
    })
    .filter((item) => wanted.test(item.text))
    .filter((item) => visible(item.el))
    .sort((a, b) => a.text.length - b.text.length);
  const el = controls[0]?.el || null;
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    tag: el.tagName,
    id: el.id || "",
    name: el.name || "",
    aria: el.getAttribute("aria-label") || "",
    text: norm([el.innerText, el.textContent, el.value].filter(Boolean).join(" ")).slice(0, 180),
  };
}

function selectRow(rows, regex, preferLeaf = false) {
  const wanted = new RegExp(regex, "i");
  return rows
    .filter((row) => wanted.test([row.text, row.aria].join(" ")))
    .filter((row) => !/selectedItem/.test(row.auto))
    .sort((a, b) => {
      const aLeaf = preferLeaf && (a.type === "1" || /promptLeafNode|menuItem/.test(a.auto)) ? 0 : 1;
      const bLeaf = preferLeaf && (b.type === "1" || /promptLeafNode|menuItem/.test(b.auto)) ? 0 : 1;
      return aLeaf - bLeaf || a.text.length - b.text.length || a.rect.y - b.rect.y;
    })[0];
}

function commitState(arg) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const fieldRegex = new RegExp(arg.fieldRegex || ".", "i");
  const optionRegex = new RegExp(arg.optionRegex || ".", "i");
  const isSkills = /skill/i.test(arg.fieldRegex || "");
  const control = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, button[aria-haspopup], [role='combobox']"))
    .filter(visible)
    .find((el) => {
      const container = el.closest("[data-automation-id^='formField'], [role='group'], [data-fkit-id], section, fieldset") || el.parentElement;
      const text = norm([el.id, el.name, el.getAttribute("aria-label"), el.innerText, el.textContent, container?.innerText].filter(Boolean).join(" "));
      return fieldRegex.test(text);
    });
  const container = control?.closest("[data-automation-id^='formField'], [role='group'], [data-fkit-id], section, fieldset") || control?.parentElement || document;
  const selected = Array.from(
    container.querySelectorAll("[data-automation-id='selectedItem'], [data-automation-id='promptSelectionLabel'], [id^='pill-'], [aria-label*='press delete to clear value']"),
  )
    .filter(visible)
    .map((el) => norm([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" ")))
    .filter(Boolean);
  const errors = Array.from(container.querySelectorAll("[role='alert'], [data-automation-id='inputAlert'], [data-automation-id='errorMessage']"))
    .filter(visible)
    .map((el) => norm(el.innerText || el.textContent))
    .filter(Boolean);
  const raw = norm([control?.value, control?.innerText, control?.textContent, control?.getAttribute?.("aria-label")].filter(Boolean).join(" "));
  const checked = Array.from(container.querySelectorAll("input[type='checkbox'], input[type='radio']"))
    .filter(visible)
    .map((el) => ({
      id: el.id || "",
      name: el.name || "",
      checked: el.checked,
      aria: el.getAttribute("aria-label") || "",
      value: el.value || "",
    }));
  return {
    raw,
    selected,
    errors,
    checked,
    invalid: control?.getAttribute?.("aria-invalid") || "",
    committed: isSkills
      ? selected.some((item) => optionRegex.test(item))
      : optionRegex.test(raw) || selected.some((item) => optionRegex.test(item)) || (!errors.length && control?.getAttribute?.("aria-invalid") !== "true" && selected.length > 0),
  };
}

function saveButtonPoint() {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.visibility !== "hidden" && style.display !== "none";
  };
  const button = Array.from(document.querySelectorAll("button"))
    .filter(visible)
    .filter((el) => /save and continue|next|continue/i.test(norm(el.innerText || el.textContent)))
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    text: norm(button.innerText || button.textContent),
    disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
  };
}

function formDiagnostics(arg) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const rect = (el) => {
    const r = el?.getBoundingClientRect?.();
    return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const textOf = (el) => norm([el?.innerText, el?.textContent, el?.getAttribute?.("aria-label"), el?.value].filter(Boolean).join(" "));
  const descriptor = (el) => {
    const container =
      el.closest?.("[data-automation-id^='formField'], [role='group'], fieldset, section, [data-fkit-id], label") ||
      el.parentElement;
    return norm(
      [
        el.id,
        el.name,
        el.getAttribute?.("data-automation-id"),
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("placeholder"),
        container?.innerText,
        container?.textContent,
      ]
        .filter(Boolean)
        .join(" "),
    );
  };
  const controls = Array.from(
    document.querySelectorAll(
      "input:not([type='hidden']), textarea, select, button[aria-haspopup], [role='combobox'], [aria-invalid='true'], [aria-required='true'], [required]",
    ),
  )
    .map((el) => {
      const desc = descriptor(el);
      return {
        tag: el.tagName,
        id: el.id || "",
        name: el.getAttribute("name") || "",
        type: el.getAttribute("type") || "",
        role: el.getAttribute("role") || "",
        auto: el.getAttribute("data-automation-id") || "",
        uxi: el.getAttribute("data-uxi-widget-type") || "",
        aria: el.getAttribute("aria-label") || "",
        ariaInvalid: el.getAttribute("aria-invalid") || "",
        ariaRequired: el.getAttribute("aria-required") || "",
        required: Boolean(el.required || el.getAttribute("required") != null || el.getAttribute("aria-required") === "true" || /\bRequired\b/i.test(desc)),
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        checked: el.checked ?? null,
        value: "value" in el ? el.value : "",
        text: textOf(el).slice(0, 260),
        descriptor: desc.slice(0, 500),
        visible: visible(el),
        rect: rect(el),
      };
    })
    .filter((item) => {
      const filter = arg?.filter ? new RegExp(arg.filter, "i") : null;
      if (!filter) return true;
      return filter.test([item.id, item.name, item.aria, item.text, item.descriptor].join(" "));
    })
    .sort((a, b) => {
      const ar = a.rect || { y: 99999, x: 99999 };
      const br = b.rect || { y: 99999, x: 99999 };
      return ar.y - br.y || ar.x - br.x;
    });
  const invalidControls = controls.filter((item) => item.ariaInvalid === "true");
  const requiredEmpty = controls.filter((item) => {
    if (!item.required || item.disabled) return false;
    if (/checkbox|radio/i.test(item.type) || /checkbox|radio/i.test(item.role)) return !item.checked;
    return !norm([item.value, item.text].filter(Boolean).join(" "));
  });
  const alerts = Array.from(
    document.querySelectorAll("[role='alert'], [data-automation-id='inputAlert'], [data-automation-id='errorMessage'], [id*='error']"),
  )
    .filter((el) => visible(el))
    .map((el) => ({ text: textOf(el), rect: rect(el) }))
    .filter((item) => item.text && !/successfully uploaded/i.test(item.text));
  const footerButtons = Array.from(document.querySelectorAll("button"))
    .filter((el) => visible(el))
    .filter((el) => /back|next|save|continue|submit/i.test(textOf(el)))
    .map((el) => ({
      text: textOf(el).slice(0, 180),
      id: el.id || "",
      auto: el.getAttribute("data-automation-id") || "",
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      ariaDisabled: el.getAttribute("aria-disabled") || "",
      rect: rect(el),
      className: String(el.className || "").slice(0, 180),
    }));
  return {
    label: arg?.label || "",
    href: location.href,
    step: pageSnapshot(arg).step,
    scrollY: Math.round(scrollY),
    controls,
    invalidControls,
    requiredEmpty,
    alerts,
    footerButtons,
    bodyTail: norm(document.body?.innerText || "").slice(-1600),
  };
}

function syncFormEvents(arg) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const rect = (el) => {
    const r = el?.getBoundingClientRect?.();
    return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const textOf = (el) => norm([el?.innerText, el?.textContent, el?.getAttribute?.("aria-label"), el?.value].filter(Boolean).join(" "));
  const footer = () =>
    Array.from(document.querySelectorAll("button"))
      .filter((el) => visible(el))
      .filter((el) => /next|save and continue|continue/i.test(textOf(el)) && !/submit/i.test(textOf(el)))
      .map((el) => ({
        text: textOf(el),
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        ariaDisabled: el.getAttribute("aria-disabled") || "",
        rect: rect(el),
      }))[0] || null;
  const descriptor = (el) => {
    const container =
      el.closest?.("[data-automation-id^='formField'], [role='group'], fieldset, section, [data-fkit-id], label") ||
      el.parentElement;
    return norm(
      [
        el.id,
        el.name,
        el.getAttribute?.("data-automation-id"),
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("placeholder"),
        container?.innerText,
        container?.textContent,
      ]
        .filter(Boolean)
        .join(" "),
    );
  };
  const reactFire = (el, names) => {
    const fired = [];
    try {
      const fiberKey = Object.keys(el || {}).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
      let node = fiberKey ? el[fiberKey] : null;
      while (node) {
        const props = node.memoizedProps || node.pendingProps || {};
        for (const name of names) {
          if (typeof props[name] === "function") {
            const type = name.replace(/^on/, "").toLowerCase() || "change";
            const evt = {
              type,
              target: el,
              currentTarget: el,
              bubbles: true,
              cancelable: true,
              stopPropagation() {},
              preventDefault() {},
              persist() {},
              isPropagationStopped() {
                return false;
              },
              isDefaultPrevented() {
                return false;
              },
              nativeEvent: type === "blur" ? new FocusEvent("blur", { bubbles: false }) : new Event(type, { bubbles: true, cancelable: true }),
            };
            props[name](evt);
            fired.push({ name, owner: node.elementType?.displayName || node.type?.displayName || node.tag || "" });
            if (!arg?.fireAllReactEvents) {
              return fired;
            }
          }
        }
        node = node.return;
      }
    } catch (error) {
      fired.push({ error: String(error && error.message ? error.message : error) });
    }
    return fired;
  };
  const filter = arg?.filter ? new RegExp(arg.filter, "i") : /./;
  const controls = Array.from(
    document.querySelectorAll("input:not([type='hidden']), textarea, select, button[aria-haspopup], [role='combobox']"),
  )
    .map((el) => ({ el, desc: descriptor(el) }))
    .filter((item) => filter.test(item.desc))
    .filter((item) => /Required|\*|gender|ethnic|veteran|terms|skill|source|country|phone|name|email/i.test(item.desc));
  const before = footer();
  const changed = [];
  for (const item of controls) {
    const el = item.el;
    const beforeValue = "value" in el ? el.value : "";
    const beforeChecked = el.checked ?? null;
    if (/termsAndConditions--acceptTermsAndAgreements|acceptTermsAndAgreements/i.test(item.desc) && "checked" in el) {
      el.checked = true;
    }
    const domEvents = [];
    for (const eventName of ["input", "change", "blur", "focusout"]) {
      try {
        const event = eventName === "blur" || eventName === "focusout" ? new FocusEvent(eventName, { bubbles: eventName !== "blur" }) : new Event(eventName, { bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        domEvents.push(eventName);
      } catch (error) {
        domEvents.push(`${eventName}: ${String(error && error.message ? error.message : error)}`);
      }
    }
    const reactEvents = reactFire(el, ["onChange", "onInput", "onBlur"]);
    changed.push({
      id: el.id || "",
      name: el.getAttribute("name") || "",
      role: el.getAttribute("role") || "",
      desc: item.desc.slice(0, 220),
      beforeValue,
      afterValue: "value" in el ? el.value : "",
      beforeChecked,
      afterChecked: el.checked ?? null,
      domEvents,
      reactEvents,
    });
  }
  return {
    label: arg?.label || "",
    before,
    changed,
    after: footer(),
  };
}

function backButtonPoint() {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.visibility !== "hidden" && style.display !== "none";
  };
  const button = Array.from(document.querySelectorAll("button"))
    .filter(visible)
    .filter((el) => /^back$/i.test(norm(el.innerText || el.textContent)))
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
  if (!button) return null;
  const rect = button.getBoundingClientRect();
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    text: norm(button.innerText || button.textContent),
    disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
  };
}

function termsCheckboxPoint() {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const wanted = /acknowledge receipt|terms and conditions|acceptTermsAndAgreements/i;
  const controls = Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']"))
    .map((el) => {
      const container = el.closest("[data-automation-id^='formField'], label, [role='group'], div") || el.parentElement;
      return {
        el,
        text: norm([el.id, el.name, el.getAttribute("aria-label"), container?.innerText, container?.textContent].filter(Boolean).join(" ")),
      };
    })
    .filter((item) => wanted.test(item.text))
    .filter((item) => visible(item.el) || item.el.id);
  const el = controls[0]?.el || null;
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + Math.max(6, rect.width / 2)),
    y: Math.round(rect.top + Math.max(6, rect.height / 2)),
    checked: el.checked || el.getAttribute("aria-checked") === "true",
    id: el.id || "",
    text: controls[0].text.slice(0, 240),
  };
}

function scrollListboxToTop() {
  const boxes = Array.from(
    document.querySelectorAll("[data-automation-id='activeListContainer'], [data-automation-id='promptSearchResultList'], [data-uxi-widget-type='multiselectlist'], [role='listbox']"),
  ).filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  });
  const box = boxes[0];
  if (box) {
    box.scrollTop = 0;
    box.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
  return Boolean(box);
}

function scrollListboxDown() {
  const boxes = Array.from(
    document.querySelectorAll("[data-automation-id='activeListContainer'], [data-automation-id='promptSearchResultList'], [data-uxi-widget-type='multiselectlist'], [role='listbox']"),
  ).filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  });
  const box = boxes[0];
  if (!box) return false;
  const before = box.scrollTop;
  box.scrollTop += Math.max(120, Math.round(box.clientHeight * 0.75));
  box.dispatchEvent(new Event("scroll", { bubbles: true }));
  return Math.abs(box.scrollTop - before) > 1;
}

async function clickSaveIfEnabled(client, attempts) {
  await key(client, "Escape");
  await sleep(500);
  const save = await evalPage(client, saveButtonPoint);
  attempts.push({ action: "save_button_state", save });
  if (save && save.disabled) {
    await key(client, "Tab");
    await sleep(800);
    const settledSave = await evalPage(client, saveButtonPoint);
    attempts.push({ action: "save_button_state_after_tab_settle", save: settledSave });
    if (settledSave && !settledSave.disabled && !/submit/i.test(settledSave.text)) {
      await clickPoint(client, settledSave);
      await sleep(1800);
      attempts.push({ action: "clicked_save_after_tab_settle", after: await evalPage(client, pageSnapshot, { label: "after_save" }) });
      return true;
    }
  }
  if (save && !save.disabled && !/submit/i.test(save.text)) {
    await clickPoint(client, save);
    await sleep(1800);
    attempts.push({ action: "clicked_save", after: await evalPage(client, pageSnapshot, { label: "after_save" }) });
    return true;
  }
  return false;
}

async function settleSkillsInput(client, attempts) {
  const input = await evalPage(client, findFieldPoint, {
    regex: "skills|type\\s+to\\s+add\\s+skills",
    selector: "input:not([type='hidden']), [role='combobox']",
  });
  attempts.push({ action: "settle_skills_input_find", input });
  if (!input) {
    return false;
  }
  await clickPoint(client, input);
  await sleep(200);
  await ctrlABackspace(client);
  await sleep(300);
  await key(client, "Escape");
  await sleep(300);
  await key(client, "Tab");
  await sleep(800);
  const state = await evalPage(client, commitState, {
    fieldRegex: "skills|type\\s+to\\s+add\\s+skills",
    optionRegex: "Customer Service|Client Service|Service",
  });
  attempts.push({ action: "settle_skills_input_after_clear_blur", state });
  return state.committed;
}

async function findRowsUntil(client, regex, attempts, maxScrolls = 12) {
  await evalPage(client, scrollListboxToTop);
  await sleep(180);
  for (let i = 0; i <= maxScrolls; i += 1) {
    const rows = await evalPage(client, activeRows);
    const match = selectRow(rows.rows, regex, true);
    attempts.push({
      action: "scan_active_rows",
      scroll: i,
      listbox: rows.listbox,
      rows: rows.rows.slice(0, 30).map((row) => ({
        text: row.text,
        auto: row.auto,
        type: row.type,
        aria: row.aria,
        selected: row.selected,
        checked: row.checked,
        rect: row.rect,
      })),
      match: match ? { text: match.text, auto: match.auto, type: match.type, aria: match.aria, rect: match.rect } : null,
    });
    if (match) {
      return match;
    }
    const moved = await evalPage(client, scrollListboxDown);
    if (!moved) {
      break;
    }
    await sleep(180);
  }
  return null;
}

async function probeSkills(client, args) {
  const attempts = [];
  attempts.push({ action: "initial", state: await evalPage(client, relevantState, { label: "skills_initial", filter: "skill|save|continue|error" }) });
  const input = await evalPage(client, findFieldPoint, {
    regex: "skills|type\\s+to\\s+add\\s+skills",
    selector: "input:not([type='hidden']), [role='combobox']",
  });
  attempts.push({ action: "find_skills_input", input });
  if (!input) {
    return { mode: "skills", ok: false, reason: "skills_input_not_found", attempts };
  }
  const initialCommitted = await evalPage(client, commitState, {
    fieldRegex: "skills|type\\s+to\\s+add\\s+skills",
    optionRegex: "Customer Service|Client Service|Service",
  });
  attempts.push({ action: "initial_skill_commit_state", state: initialCommitted });
  if (initialCommitted.committed) {
    const saved = await clickSaveIfEnabled(client, attempts);
    return {
      mode: "skills",
      ok: true,
      committedBy: "already_selected",
      saved,
      state: initialCommitted,
      attempts,
    };
  }
  await clickPoint(client, input);
  await sleep(200);
  await ctrlABackspace(client);
  await text(client, args.searchText);
  await sleep(1400);
  attempts.push({ action: "typed_search", searchText: args.searchText, rows: await evalPage(client, activeRows) });
  const skillRows = (await evalPage(client, activeRows)).rows;
  const exactSkill = new RegExp(`^${args.searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const row =
    skillRows
      .filter((candidate) => exactSkill.test([candidate.text, candidate.aria].join(" ")))
      .sort((a, b) => {
        const aMenu = a.auto === "menuItem" ? 0 : 1;
        const bMenu = b.auto === "menuItem" ? 0 : 1;
        return aMenu - bMenu || a.text.length - b.text.length || a.rect.y - b.rect.y;
      })[0] ||
    skillRows
      .filter((candidate) => /Customer Service|Client Service|Service/i.test([candidate.text, candidate.aria].join(" ")))
      .sort((a, b) => {
        const aMenu = a.auto === "menuItem" ? 0 : 1;
        const bMenu = b.auto === "menuItem" ? 0 : 1;
        return aMenu - bMenu || a.text.length - b.text.length || a.rect.y - b.rect.y;
      })[0];
  attempts.push({ action: "chosen_skill_row", row });
  if (!row) {
    return { mode: "skills", ok: false, reason: "skill_option_not_found", attempts };
  }
  const reactSkill = await evalPage(client, reactClickVisibleRow, {
    regex: `^${args.searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b|Customer Service|Client Service|Service`,
    prefer: "menuItem",
    fireAll: true,
  });
  await sleep(900);
  const reactSkillState = await evalPage(client, commitState, {
    fieldRegex: "skills|type\\s+to\\s+add\\s+skills",
    optionRegex: "Customer Service|Client Service|Service",
  });
  attempts.push({ action: "skill_react_click_visible_row", react: reactSkill, state: reactSkillState });
  if (reactSkillState.committed) {
    await clickSaveIfEnabled(client, attempts);
    return { mode: "skills", ok: true, committedBy: "react_click_visible_row", state: reactSkillState, attempts };
  }
  const points = [
    ["left", row.points.left],
    ["center", row.points.center],
    ["checkbox", row.points.checkbox],
    ["leaf", row.points.leaf],
    ["prompt", row.points.prompt],
  ].filter(([, point]) => point);
  for (const [label, point] of points) {
    await clickPoint(client, point);
    await sleep(900);
    const state = await evalPage(client, commitState, {
      fieldRegex: "skills|type\\s+to\\s+add\\s+skills",
      optionRegex: "Customer Service|Client Service|Service",
    });
    attempts.push({ action: "skill_click_variant", label, point, state });
    if (state.committed) {
      await clickSaveIfEnabled(client, attempts);
      return { mode: "skills", ok: true, committedBy: label, state, attempts };
    }
  }
  await key(client, "ArrowDown");
  await sleep(120);
  await key(client, "Enter");
  await sleep(900);
  const keyboardState = await evalPage(client, commitState, {
    fieldRegex: "skills|type\\s+to\\s+add\\s+skills",
    optionRegex: "Customer Service|Client Service|Service",
  });
  attempts.push({ action: "skill_keyboard_arrow_enter", state: keyboardState });
  if (keyboardState.committed) {
    await clickSaveIfEnabled(client, attempts);
    return { mode: "skills", ok: true, committedBy: "keyboard_arrow_enter", state: keyboardState, attempts };
  }
  return { mode: "skills", ok: false, reason: "skill_not_committed", attempts };
}

async function probeDegree(client) {
  const attempts = [];
  let state = await evalPage(client, pageSnapshot, { label: "degree_start" });
  attempts.push({ action: "initial", state });
  for (let i = 0; i < 6 && !/my experience/i.test(state.step?.title || state.bodyTail); i += 1) {
    const back = await evalPage(client, backButtonPoint);
    attempts.push({ action: "back_button_state", index: i, back });
    if (!back || back.disabled) break;
    await clickPoint(client, back);
    await sleep(1600);
    state = await evalPage(client, pageSnapshot, { label: `after_back_${i}` });
    attempts.push({ action: "after_back", index: i, state });
  }
  const button = await evalPage(client, findFieldPoint, {
    regex: "\\bdegree\\b|education level",
    selector: "button[aria-haspopup], [role='combobox']",
  });
  attempts.push({ action: "find_degree_button", button });
  if (!button) {
    return { mode: "degree", ok: false, reason: "degree_button_not_found", attempts };
  }
  await clickPoint(client, button);
  await sleep(600);
  let target = await findRowsUntil(client, "^Bachelor Degree$|Bachelor / Undergraduate Degree|Bachelor'?s Degree|Bachelors Degree", attempts, 16);
  if (!target) {
    return { mode: "degree", ok: false, reason: "bachelor_option_not_found", attempts };
  }
  const reactDegree = await evalPage(client, reactClickVisibleRow, {
    regex: "^Bachelor Degree$|Bachelor / Undergraduate Degree|Bachelor'?s Degree|Bachelors Degree",
    prefer: "option",
    fireAll: true,
  });
  await sleep(900);
  let reactCommitted = await evalPage(client, commitState, {
    fieldRegex: "\\bdegree\\b|education level",
    optionRegex: "^Bachelor Degree$|Bachelor / Undergraduate Degree|Bachelor'?s Degree|Bachelors Degree|Bachelor of Science",
  });
  attempts.push({ action: "degree_react_click_visible_row", react: reactDegree, committed: reactCommitted });
  if (reactCommitted.committed && /bachelor/i.test(reactCommitted.raw + " " + reactCommitted.selected.join(" "))) {
    await clickSaveIfEnabled(client, attempts);
    return { mode: "degree", ok: true, committedBy: "react_click_visible_row", state: reactCommitted, attempts };
  }
  const clickOrder = [
    ["center", target.points.center],
    ["left", target.points.left],
    ["prompt", target.points.prompt],
    ["leaf", target.points.leaf],
  ].filter(([, point]) => point);
  for (const [label, point] of clickOrder) {
    await clickPoint(client, point);
    await sleep(900);
    let committed = await evalPage(client, commitState, {
      fieldRegex: "\\bdegree\\b|education level",
      optionRegex: "^Bachelor Degree$|Bachelor / Undergraduate Degree|Bachelor'?s Degree|Bachelors Degree|Bachelor of Science",
    });
    attempts.push({ action: "degree_click_variant", label, point, committed });
    if (committed.committed && /bachelor/i.test(committed.raw + " " + committed.selected.join(" "))) {
      await clickSaveIfEnabled(client, attempts);
      return { mode: "degree", ok: true, committedBy: label, state: committed, attempts };
    }
    const reopened = await evalPage(client, findFieldPoint, {
      regex: "\\bdegree\\b|education level",
      selector: "button[aria-haspopup], [role='combobox']",
    });
    if (reopened) {
      await clickPoint(client, reopened);
      await sleep(500);
      target = await findRowsUntil(client, "^Bachelor Degree$|Bachelor / Undergraduate Degree|Bachelor'?s Degree|Bachelors Degree", attempts, 16);
      if (!target) break;
    }
  }
  const rows = await evalPage(client, activeRows);
  const index = rows.rows.findIndex((row) => /Bachelor Degree|Bachelor \/ Undergraduate Degree|Bachelor'?s Degree|Bachelors Degree/i.test(row.text));
  attempts.push({ action: "degree_keyboard_index", index, rows: rows.rows.map((row) => row.text).slice(0, 30) });
  if (index >= 0) {
    const keys = ["Home"].concat(Array.from({ length: index }, () => "ArrowDown"), ["Enter"]);
    await keySequence(client, keys);
    await sleep(900);
    const committed = await evalPage(client, commitState, {
      fieldRegex: "\\bdegree\\b|education level",
      optionRegex: "^Bachelor Degree$|Bachelor / Undergraduate Degree|Bachelor'?s Degree|Bachelors Degree|Bachelor of Science",
    });
    attempts.push({ action: "degree_keyboard_commit", keys, committed });
    if (committed.committed && /bachelor/i.test(committed.raw + " " + committed.selected.join(" "))) {
      await clickSaveIfEnabled(client, attempts);
      return { mode: "degree", ok: true, committedBy: "keyboard_index", state: committed, attempts };
    }
  }
  return { mode: "degree", ok: false, reason: "degree_not_committed_to_bachelor", attempts };
}

async function chooseDropdown(client, fieldRegex, optionRegex, attempts, label) {
  await key(client, "Escape");
  await sleep(200);
  const field = await evalPage(client, findFieldPoint, {
    regex: fieldRegex,
    selector: "button[aria-haspopup], [role='combobox'], input[role='combobox']",
  });
  attempts.push({ action: `${label}_field`, field });
  if (!field) return { ok: false, reason: "field_not_found" };
  await clickPoint(client, field);
  await sleep(500);
  const target = await findRowsUntil(client, optionRegex, attempts, 24);
  attempts.push({ action: `${label}_target`, target });
  if (!target) return { ok: false, reason: "option_not_found" };
  const react = await evalPage(client, reactClickVisibleRow, {
    regex: optionRegex,
    prefer: "option",
    fireAll: true,
  });
  await sleep(800);
  let committed = await evalPage(client, commitState, { fieldRegex, optionRegex });
  attempts.push({ action: `${label}_react_click_visible_row`, react, committed });
  if (committed.committed && new RegExp(optionRegex, "i").test(committed.raw + " " + committed.selected.join(" "))) {
    await key(client, "Escape");
    await sleep(240);
    return { ok: true, pointLabel: "react_click_visible_row", committed };
  }
  const points = [
    ["center", target.points.center],
    ["left", target.points.left],
    ["prompt", target.points.prompt],
    ["leaf", target.points.leaf],
  ].filter(([, point]) => point);
  for (const [pointLabel, point] of points) {
    await clickPoint(client, point);
    await sleep(800);
    committed = await evalPage(client, commitState, {
      fieldRegex,
      optionRegex,
    });
    attempts.push({ action: `${label}_click_variant`, pointLabel, point, committed });
    if (committed.committed && new RegExp(optionRegex, "i").test(committed.raw + " " + committed.selected.join(" "))) {
      await key(client, "Escape");
      await sleep(240);
      return { ok: true, pointLabel, committed };
    }
  }
  await key(client, "Enter");
  await sleep(800);
  committed = await evalPage(client, commitState, { fieldRegex, optionRegex });
  attempts.push({ action: `${label}_keyboard_enter`, committed });
  if (!committed.committed) {
    const reopened = await evalPage(client, findFieldPoint, {
      regex: fieldRegex,
      selector: "button[aria-haspopup], [role='combobox'], input[role='combobox']",
    });
    attempts.push({ action: `${label}_keyboard_reopen_field`, reopened });
    if (reopened) {
      await clickPoint(client, reopened);
      await sleep(500);
    }
    const rows = await evalPage(client, activeRows);
    const targetIndex = rows.rows.findIndex((row) => new RegExp(optionRegex, "i").test([row.text, row.aria].join(" ")));
    attempts.push({
      action: `${label}_keyboard_index`,
      targetIndex,
      rows: rows.rows.slice(0, 30).map((row) => ({ text: row.text, auto: row.auto, aria: row.aria, rect: row.rect })),
    });
    if (targetIndex >= 0) {
      await keySequence(client, ["Home"].concat(Array.from({ length: targetIndex }, () => "ArrowDown"), ["Enter"]));
      await sleep(900);
      committed = await evalPage(client, commitState, { fieldRegex, optionRegex });
      attempts.push({ action: `${label}_keyboard_index_commit`, committed });
    }
  }
  await key(client, "Escape");
  await sleep(240);
  return { ok: committed.committed, pointLabel: "keyboard_enter", committed };
}

async function probeDisclosure(client) {
  const attempts = [];
  attempts.push({ action: "initial", state: await evalPage(client, relevantState, { label: "disclosure_initial", filter: "gender|ethnic|veteran|terms|save|continue|error" }) });
  const ethnicity = await chooseDropdown(
    client,
    "ethnicity|race|accurately describes how you identify",
    "decline to disclose|prefer not|do not wish|choose not|not disclose",
    attempts,
    "ethnicity",
  );
  const veteran = await chooseDropdown(
    client,
    "veteran",
    "CHOOSE NOT TO SELF-IDENTIFY|not a veteran|not protected veteran|do not wish|prefer not",
    attempts,
    "veteran",
  );
  await key(client, "Escape");
  await sleep(300);
  const terms = await evalPage(client, termsCheckboxPoint);
  attempts.push({ action: "terms_checkbox", terms });
  if (terms && !terms.checked) {
    await clickPoint(client, terms);
    await sleep(600);
  }
  const finalState = await evalPage(client, relevantState, { label: "disclosure_after_terms", filter: "gender|ethnic|veteran|terms|save|continue|error" });
  attempts.push({ action: "after_terms", state: finalState });
  const saved = await clickSaveIfEnabled(client, attempts);
  return {
    mode: "disclosure",
    ok: Boolean(ethnicity.ok && veteran.ok && (saved || finalState.buttons.some((button) => /save and continue/i.test(button.text) && !button.disabled))),
    ethnicity,
    veteran,
    saved,
    attempts,
  };
}

async function probeSource(client) {
  const attempts = [];
  attempts.push({ action: "initial", state: await evalPage(client, relevantState, { label: "source_initial", filter: "source|hear|save|continue|error" }) });
  const source = await evalPage(client, findFieldPoint, {
    regex: "source|how\\s+did\\s+you\\s+hear",
    selector: "input:not([type='hidden']), button[aria-haspopup], [role='combobox']",
  });
  attempts.push({ action: "find_source", source });
  if (!source) {
    return { mode: "source", ok: false, reason: "source_field_not_found", attempts };
  }
  await clickPoint(client, source);
  await sleep(700);
  let parent = await findRowsUntil(client, "\\bJob Board\\b|Job Boards|Job Sites", attempts, 8);
  if (parent && parent.auto !== "menuItem") {
    const rootRows = await evalPage(client, activeRows);
    parent =
      rootRows.rows
        .filter((row) => row.auto === "menuItem" && /\bJob Board\b|Job Boards|Job Sites/i.test([row.text, row.aria].join(" ")))
        .sort((a, b) => a.text.length - b.text.length || a.rect.y - b.rect.y)[0] || parent;
    attempts.push({ action: "source_parent_outer_menu_row", parent });
  }
  let child = null;
  if (!parent) {
    const alreadyRows = await evalPage(client, activeRows);
    child = selectRow(alreadyRows.rows, "^LinkedIn$|^Indeed$|^Built In$|Glassdoor", true);
    attempts.push({
      action: "source_already_in_child_list",
      rows: alreadyRows,
      child,
    });
    if (!child) {
      return { mode: "source", ok: false, reason: "job_board_parent_not_found", attempts };
    }
  } else {
    for (const prefer of ["side", "promptLeaf", "menuItem"]) {
      const reactParent = await evalPage(client, reactClickVisibleRow, {
        regex: "\\bJob Board\\b|Job Boards|Job Sites",
        prefer,
        fireAll: true,
      });
      await sleep(800);
      const rows = await evalPage(client, activeRows);
      attempts.push({ action: "source_parent_react_expand_variant", prefer, react: reactParent, rows });
      if (selectRow(rows.rows, "LinkedIn|Indeed", true)) {
        break;
      }
    }
    for (const [label, point] of [
      ["side", parent.points.side],
      ["leaf", parent.points.leaf],
      ["center", parent.points.center],
    ].filter(([, point]) => point)) {
      await clickPoint(client, point);
      await sleep(800);
      const rows = await evalPage(client, activeRows);
      attempts.push({ action: "source_parent_expand_variant", label, point, rows });
      if (selectRow(rows.rows, "LinkedIn|Indeed", true)) {
        break;
      }
    }
    if (!selectRow((await evalPage(client, activeRows)).rows, "LinkedIn|Indeed", true) && parent?.points?.center) {
      await clickPoint(client, parent.points.center);
      await sleep(250);
      await key(client, "ArrowRight");
      await sleep(900);
      attempts.push({ action: "source_parent_expand_keyboard_arrow_right", rows: await evalPage(client, activeRows) });
      if (!selectRow((await evalPage(client, activeRows)).rows, "LinkedIn|Indeed", true)) {
        await key(client, "Enter");
        await sleep(900);
        attempts.push({ action: "source_parent_expand_keyboard_enter", rows: await evalPage(client, activeRows) });
      }
    }
  }
  if (!child) {
    child = await findRowsUntil(client, "^LinkedIn$|^Indeed$|^Built In$|Glassdoor", attempts, 14);
  }
  if (!child) {
    const sourceInput = await evalPage(client, findFieldPoint, {
      regex: "source|how\\s+did\\s+you\\s+hear",
      selector: "input:not([type='hidden']), [role='combobox']",
    });
    attempts.push({ action: "source_search_fallback_input", sourceInput });
    if (sourceInput) {
      await clickPoint(client, sourceInput);
      await sleep(200);
      await ctrlABackspace(client);
      await text(client, "LinkedIn");
      await sleep(1600);
      attempts.push({ action: "source_search_fallback_rows", rows: await evalPage(client, activeRows) });
      child = await findRowsUntil(client, "^LinkedIn$|LinkedIn", attempts, 8);
      if (!child) {
        await clickPoint(client, sourceInput);
        await sleep(200);
        await ctrlABackspace(client);
        await text(client, "Indeed");
        await sleep(1600);
        attempts.push({ action: "source_search_fallback_rows_indeed", rows: await evalPage(client, activeRows) });
        child = await findRowsUntil(client, "^Indeed$|Indeed", attempts, 8);
      }
    }
  }
  attempts.push({ action: "source_child_candidate", child });
  if (!child) {
    return { mode: "source", ok: false, reason: "source_child_not_found", attempts };
  }
  const childRegex =
    child.text && /linkedin/i.test(child.text)
      ? "LinkedIn"
      : child.text && /indeed/i.test(child.text)
        ? "Indeed"
        : child.text && /built\s+in/i.test(child.text)
          ? "Built In"
          : child.text && /glassdoor/i.test(child.text)
            ? "Glassdoor"
            : "LinkedIn|Indeed|Built In|Glassdoor";
  for (const prefer of ["promptLeaf", "option", "menuItem"]) {
    const reactChild = await evalPage(client, reactClickVisibleRow, {
      regex: childRegex,
      prefer,
      fireAll: true,
    });
    await sleep(900);
    const committed = await evalPage(client, commitState, {
      fieldRegex: "source|how\\s+did\\s+you\\s+hear",
      optionRegex: childRegex,
    });
    attempts.push({ action: "source_child_react_click_variant", prefer, react: reactChild, committed });
    if (committed.committed) {
      await key(client, "Escape");
      await sleep(300);
      await clickSaveIfEnabled(client, attempts);
      return { mode: "source", ok: true, committedBy: `react_click_${prefer}`, option: child.text, state: committed, attempts };
    }
  }
  for (const [label, point] of [
    ["left", child.points.left],
    ["leaf", child.points.leaf],
    ["prompt", child.points.prompt],
    ["center", child.points.center],
  ].filter(([, point]) => point)) {
    await clickPoint(client, point);
    await sleep(900);
    const committed = await evalPage(client, commitState, {
      fieldRegex: "source|how\\s+did\\s+you\\s+hear",
      optionRegex: childRegex,
    });
    attempts.push({ action: "source_child_click_variant", label, point, committed });
    if (committed.committed) {
      await key(client, "Escape");
      await sleep(300);
      await clickSaveIfEnabled(client, attempts);
      return { mode: "source", ok: true, committedBy: label, option: child.text, state: committed, attempts };
    }
    const reopened = await evalPage(client, findFieldPoint, {
      regex: "source|how\\s+did\\s+you\\s+hear",
      selector: "input:not([type='hidden']), button[aria-haspopup], [role='combobox']",
    });
    if (reopened) {
      await clickPoint(client, reopened);
      await sleep(500);
      parent = await findRowsUntil(client, "\\bJob Board\\b|Job Boards|Job Sites", attempts, 8);
      if (parent && parent.auto !== "menuItem") {
        const rootRows = await evalPage(client, activeRows);
        parent =
          rootRows.rows
            .filter((row) => row.auto === "menuItem" && /\bJob Board\b|Job Boards|Job Sites/i.test([row.text, row.aria].join(" ")))
            .sort((a, b) => a.text.length - b.text.length || a.rect.y - b.rect.y)[0] || parent;
        attempts.push({ action: "source_parent_outer_menu_row_retry", parent });
      }
      if (parent?.points?.side) {
        await clickPoint(client, parent.points.side);
        await sleep(700);
      }
      child = await findRowsUntil(client, childRegex, attempts, 14);
      if (!child) break;
    }
  }
  await key(client, "Space");
  await sleep(800);
  const committed = await evalPage(client, commitState, {
    fieldRegex: "source|how\\s+did\\s+you\\s+hear",
    optionRegex: childRegex,
  });
  attempts.push({ action: "source_keyboard_space", committed });
  if (committed.committed) {
    await clickSaveIfEnabled(client, attempts);
    return { mode: "source", ok: true, committedBy: "keyboard_space", option: child.text, state: committed, attempts };
  }
  return { mode: "source", ok: false, reason: "source_child_not_committed", option: child?.text || "", attempts };
}

async function run() {
  const args = parseArgs(process.argv);
  const { target, client } = await connectPage(args.cdpPort);
  try {
    const startedAt = new Date().toISOString();
    let result;
    if (args.mode === "skills") {
      result = await probeSkills(client, args);
    } else if (args.mode === "degree") {
      result = await probeDegree(client);
    } else if (args.mode === "disclosure") {
      result = await probeDisclosure(client);
    } else if (args.mode === "source") {
      result = await probeSource(client);
    } else if (args.mode === "inspect") {
      result = {
        mode: "inspect",
        ok: true,
        diagnostics: await evalPage(client, formDiagnostics, { label: "inspect", filter: args.searchTextProvided ? args.searchText : "" }),
      };
    } else if (args.mode === "sync-events") {
      result = {
        mode: "sync-events",
        ok: true,
        sync: await evalPage(client, syncFormEvents, { label: "sync-events", filter: args.searchTextProvided ? args.searchText : "" }),
        diagnostics: await evalPage(client, formDiagnostics, { label: "after-sync-events", filter: args.searchTextProvided ? args.searchText : "" }),
      };
    } else {
      throw new Error(`Unknown mode: ${args.mode}`);
    }
    const payload = {
      ok: Boolean(result.ok),
      proof: "workday_failed_lane_deep_probe",
      mode: args.mode,
      port: args.cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
      startedAt,
      finishedAt: new Date().toISOString(),
      result,
      final: await evalPage(client, pageSnapshot, { label: "final" }),
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: payload.ok, mode: args.mode, out: args.out, reason: result.reason || "" }, null, 2));
  } finally {
    client.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
