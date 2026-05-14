#!/usr/bin/env node
"use strict";

const { CdpClient, httpJson, sleep } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = {
    cdpPort: 9222,
    target: "",
    list: false,
    action: "inspect",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--target" && next) {
      args.target = next;
      i += 1;
    } else if (arg === "--list") {
      args.list = true;
    } else if (arg === "--action" && next) {
      args.action = next;
      i += 1;
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
    "Usage: node scripts/c3_workday_widget_probe.js [options]",
    "",
    "Options:",
    "  --cdp-port <port>  Chrome DevTools port, default 9222",
    "  --target <regex>   Filter target by URL or title",
    "  --list             List Workday page targets only",
    "  --action <name>    inspect, inspect-phone-popup, clear-phone-cdp, phone-cdp, phone-scroll-cdp, phone-click-canada-radio-cdp, phone-keyboard-canada-cdp, phone-wheel-cdp, open-source-cdp",
  ].join("\n");
}

async function cdpClick(client, x, y) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
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
  for (const char of String(text || "")) {
    await client.send("Input.dispatchKeyEvent", {
      type: "char",
      text: char,
      unmodifiedText: char,
    });
  }
}

async function cdpWheel(client, x, y, deltaY) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY,
  });
}

function visibleExpression() {
  return `(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
    const attrs = (el) => el ? {
      tag: el.tagName,
      id: el.id || "",
      name: el.name || "",
      type: el.type || "",
      role: el.getAttribute("role") || "",
      automationId: el.getAttribute("data-automation-id") || "",
      fkitId: el.getAttribute("data-fkit-id") || "",
      uxiWidgetType: el.getAttribute("data-uxi-widget-type") || "",
      uxiElementId: el.getAttribute("data-uxi-element-id") || "",
      uxiMultiselectId: el.getAttribute("data-uxi-multiselect-id") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      ariaRequired: el.getAttribute("aria-required") || "",
      ariaInvalid: el.getAttribute("aria-invalid") || "",
      ariaExpanded: el.getAttribute("aria-expanded") || "",
      ariaActiveDescendant: el.getAttribute("aria-activedescendant") || "",
      placeholder: el.getAttribute("placeholder") || "",
      value: "value" in el ? String(el.value || "") : "",
      text: textOf(el).slice(0, 500),
      reactKeys: Object.keys(el).filter((key) => /^__react/.test(key)).slice(0, 8),
      rect: (() => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      })()
    } : null;
    const fieldContainer = (el) => el?.closest?.([
      "[data-automation-id^='formField']",
      "[data-fkit-id]",
      "[role='group']",
      "[data-uxi-widget-type='multiselect']"
    ].join(",")) || el?.parentElement || null;
    const selectedFor = (el) => {
      const container = fieldContainer(el);
      return [...(container?.querySelectorAll?.([
        "[data-automation-id='selectedItem']",
        "[data-automation-id='promptSelectionLabel']",
        "[data-automation-id='promptAriaInstruction']",
        "[id^='pill-']",
        "[aria-label*='press delete']"
      ].join(",")) || [])].map((item) => ({
        ...attrs(item),
        visible: visible(item),
        title: item.getAttribute("title") || "",
        ariaSelected: item.getAttribute("aria-selected") || "",
        ariaChecked: item.getAttribute("aria-checked") || ""
      }));
    };
    const optionRows = () => [...document.querySelectorAll([
      "[role='option']",
      "[data-automation-id='promptLeafNode']",
      "[data-automation-id='promptOption']"
    ].join(","))]
      .filter(visible)
      .slice(0, 80)
      .map((option) => ({
        ...attrs(option),
        title: option.getAttribute("title") || "",
        ariaSelected: option.getAttribute("aria-selected") || "",
        ariaChecked: option.getAttribute("aria-checked") || "",
        dataLabel: option.getAttribute("data-automation-label") || "",
        dataValue: option.getAttribute("data-value") || ""
      }));
    const describe = (el) => ({
      element: attrs(el),
      container: attrs(fieldContainer(el)),
      selected: selectedFor(el)
    });
    const allInputs = [...document.querySelectorAll("input, button[aria-haspopup='listbox']")].filter(visible);
    const phoneCountry = document.getElementById("phoneNumber--countryPhoneCode")
      || allInputs.find((el) => /country\\s*phone\\s*code|countryphonecode/i.test([el.id, el.name, el.getAttribute("aria-label"), textOf(fieldContainer(el))].filter(Boolean).join(" ")));
    const source = document.getElementById("source--source")
      || allInputs.find((el) => /how did you hear about us|source/i.test([el.id, el.name, el.getAttribute("aria-label"), textOf(fieldContainer(el))].filter(Boolean).join(" ")));
    const citizenship = document.getElementById("personalInfoPerson--citizenshipStatus")
      || allInputs.find((el) => /citizenship|citizen/i.test([el.id, el.name, el.getAttribute("aria-label"), textOf(fieldContainer(el))].filter(Boolean).join(" ")));
    const stepMatch = (document.body?.innerText || "").match(/current step\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
    const errors = [...document.querySelectorAll("[role='alert'], [data-automation-id*='error'], [id*='error']")]
      .filter(visible)
      .map((el) => textOf(el))
      .filter(Boolean)
      .filter((text) => !/successfully uploaded/i.test(text))
      .slice(0, 20);
    return {
      href: location.href,
      title: document.title,
      step: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: stepMatch[3].trim() } : null,
      fields: {
        phoneCountry: phoneCountry ? describe(phoneCountry) : null,
        source: source ? describe(source) : null,
        citizenship: citizenship ? describe(citizenship) : null
      },
      visibleOptions: optionRows(),
      errors
    };
  })()`;
}

function phonePopupInspectExpression() {
  return `(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
    const brief = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id || "",
        className: String(el.className || "").slice(0, 180),
        role: el.getAttribute("role") || "",
        automationId: el.getAttribute("data-automation-id") || "",
        uxiWidgetType: el.getAttribute("data-uxi-widget-type") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        ariaExpanded: el.getAttribute("aria-expanded") || "",
        text: textOf(el).slice(0, 240),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        scrollTop: Math.round(el.scrollTop || 0),
        scrollHeight: Math.round(el.scrollHeight || 0),
        clientHeight: Math.round(el.clientHeight || 0),
        overflowY: style.overflowY,
        transform: style.transform === "none" ? "" : style.transform,
      };
    };
    const optionsWithElements = [...document.querySelectorAll("[role='option'], [data-automation-id='promptLeafNode'], [data-automation-id='promptOption']")]
      .filter(visible)
      .map((el) => ({ el, text: textOf(el) }));
    const listbox = [...document.querySelectorAll("[role='listbox'], [data-automation-id='activeListContainer'], [data-automation-id='promptSearchResultList']")]
      .filter(visible)
      .sort((a, b) => Math.max(0, b.scrollHeight - b.clientHeight) - Math.max(0, a.scrollHeight - a.clientHeight))[0] || null;
    const listRect = listbox?.getBoundingClientRect?.() || null;
    const inListViewport = (el) => {
      if (!el || !listRect) return false;
      const rect = el.getBoundingClientRect();
      return rect.bottom > listRect.top && rect.top < listRect.bottom && rect.right > listRect.left && rect.left < listRect.right;
    };
    const optionAncestors = [];
    for (let el = optionsWithElements[0]?.el || null; el && optionAncestors.length < 22; el = el.parentElement) {
      optionAncestors.push(brief(el));
    }
    const scrollableAncestors = optionAncestors.filter((item) => item && item.scrollHeight > item.clientHeight + 2);
    const pageScrollables = [...document.querySelectorAll("body *")]
      .filter(visible)
      .filter((el) => el.scrollHeight > el.clientHeight + 4)
      .map(brief)
      .filter((item) => item.rect.h > 20)
      .slice(0, 30);
    const input = document.getElementById("phoneNumber--countryPhoneCode");
    return {
      input: brief(input),
      activeListbox: brief(listbox),
      bodyScroll: { scrollTop: Math.round(document.scrollingElement?.scrollTop || 0), scrollHeight: Math.round(document.scrollingElement?.scrollHeight || 0), clientHeight: Math.round(document.scrollingElement?.clientHeight || 0) },
      options: optionsWithElements.slice(0, 20).map((item) => ({ text: item.text, node: brief(item.el) })),
      canadaNodes: optionsWithElements
        .filter((item) => /canada/i.test(item.text) && /(\\+1|\\(\\+1\\))/.test(item.text))
        .map((item) => ({
          text: item.text,
          inListViewport: inListViewport(item.el),
          node: brief(item.el),
          html: String(item.el.outerHTML || "").slice(0, 1400),
        })),
      optionAncestors,
      scrollableAncestors,
      pageScrollables,
    };
  })()`;
}

async function inspectTarget(target) {
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  try {
    return await client.evaluate(visibleExpression(), 30000);
  } finally {
    client.close();
  }
}

async function actionTarget(target, action) {
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  try {
    if (action === "inspect") {
      return await client.evaluate(visibleExpression(), 30000);
    }
    if (action === "inspect-phone-popup") {
      return {
        action,
        popup: await client.evaluate(phonePopupInspectExpression(), 30000),
        page: await client.evaluate(visibleExpression(), 30000),
      };
    }
    await client.send("Page.bringToFront", {});
    if (action === "open-source-cdp") {
      const targetInfo = await client.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\\s+/g, " ").trim();
        const button = document.getElementById("source--source")
          || [...document.querySelectorAll("button[aria-haspopup='listbox']")]
            .find((item) => /how did you hear about us|source/i.test([item.id, item.name, item.getAttribute("aria-label"), textOf(item.closest("[data-automation-id^='formField']") || item.parentElement)].filter(Boolean).join(" ")));
        if (!button || !visible(button)) return { ok: false, reason: "source_button_not_found" };
        button.scrollIntoView({ block: "center", inline: "center" });
        const rect = button.getBoundingClientRect();
        return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (targetInfo.ok) {
        await cdpClick(client, targetInfo.x, targetInfo.y);
        await sleep(350);
      }
      return {
        action,
        targetInfo,
        page: await client.evaluate(visibleExpression(), 30000),
      };
    }
    if (action === "clear-phone-cdp") {
      const targetInfo = await client.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const input = document.getElementById("phoneNumber--countryPhoneCode");
        if (!input) return { ok: false, reason: "phone_input_not_found" };
        input.scrollIntoView({ block: "center", inline: "center" });
        const container = input.closest("[data-uxi-widget-type='multiselect'], [data-automation-id='multiSelectContainer']") || input.parentElement;
        const clear = [...(container?.querySelectorAll?.("[data-automation-id='DELETE_charm'], [aria-label*='delete'], [aria-label*='clear'], [aria-label*='remove']") || [])]
          .find((item) => {
            const rect = item.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        if (clear && visible(clear)) {
          const rect = clear.getBoundingClientRect();
          return { ok: true, method: "delete_charm", x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        }
        const inputRect = input.getBoundingClientRect();
        return { ok: true, method: "keyboard_backspace", x: Math.round(inputRect.left + inputRect.width / 2), y: Math.round(inputRect.top + inputRect.height / 2) };
      })()`);
      if (targetInfo.ok) {
        await cdpClick(client, targetInfo.x, targetInfo.y);
        await sleep(100);
        if (targetInfo.method === "keyboard_backspace") {
          await cdpKey(client, "Backspace", "Backspace", 8);
          await cdpKey(client, "Delete", "Delete", 46);
        }
        await sleep(500);
      }
      return {
        action,
        targetInfo,
        page: await client.evaluate(visibleExpression(), 30000),
      };
    }
    if (action === "phone-cdp") {
      const targetInfo = await client.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const input = document.getElementById("phoneNumber--countryPhoneCode");
        if (!input || !visible(input)) return { ok: false, reason: "phone_input_not_found" };
        input.scrollIntoView({ block: "center", inline: "center" });
        const rect = input.getBoundingClientRect();
        return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (targetInfo.ok) {
        await cdpClick(client, targetInfo.x, targetInfo.y);
        await sleep(150);
        await cdpKey(client, "a", "KeyA", 65, 2);
        await cdpKey(client, "Backspace", "Backspace", 8);
        await sleep(100);
        await cdpTypeText(client, "Canada");
        await sleep(700);
        const option = await client.evaluate(`(() => {
          const visible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
          const match = [...document.querySelectorAll("[role='option'], [data-automation-id='promptLeafNode'], [data-automation-id='promptOption']")]
            .filter(visible)
            .map((el) => ({ el, text: textOf(el) }))
            .find((item) => /canada/i.test(item.text) && /(\\+1|\\(\\+1\\))/.test(item.text));
          if (!match) return { ok: false, reason: "canada_option_not_found" };
          match.el.scrollIntoView({ block: "center", inline: "center" });
          const rect = match.el.getBoundingClientRect();
          return { ok: true, text: match.text, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        })()`);
        if (option.ok) {
          await cdpClick(client, option.x, option.y);
          await sleep(700);
        }
        return {
          action,
          targetInfo,
          option,
          page: await client.evaluate(visibleExpression(), 30000),
        };
      }
      return {
        action,
        targetInfo,
        page: await client.evaluate(visibleExpression(), 30000),
      };
    }
    if (action === "phone-scroll-cdp") {
      const openInfo = await client.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const input = document.getElementById("phoneNumber--countryPhoneCode");
        if (!input || !visible(input)) return { ok: false, reason: "phone_input_not_found" };
        input.scrollIntoView({ block: "center", inline: "center" });
        const rect = input.getBoundingClientRect();
        return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (openInfo.ok) {
        await cdpClick(client, openInfo.x, openInfo.y);
        await sleep(200);
        await cdpKey(client, "ArrowDown", "ArrowDown", 40);
        await sleep(250);
      }
      const attempts = [];
      let canada = null;
      for (let index = 0; index < 80; index += 1) {
        canada = await client.evaluate(`(() => {
          const visible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
          const options = [...document.querySelectorAll("[role='option'], [data-automation-id='promptLeafNode'], [data-automation-id='promptOption']")]
            .filter(visible)
            .map((el) => ({ el, text: textOf(el) }));
          const match = options.find((item) => /canada/i.test(item.text) && /(\\+1|\\(\\+1\\))/.test(item.text));
          if (match) {
            match.el.scrollIntoView({ block: "center", inline: "center" });
            const rect = match.el.getBoundingClientRect();
            return { ok: true, text: match.text, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), visibleTexts: options.slice(0, 12).map((item) => item.text) };
          }
          const listboxes = [...document.querySelectorAll("[role='listbox'], [data-automation-id='promptSearchResultList'], [data-automation-id='activeListContainer'], [data-uxi-widget-type='multiselectlist']")]
            .filter(visible)
            .sort((a, b) => {
              const ar = a.getBoundingClientRect();
              const br = b.getBoundingClientRect();
              const aScrollable = Math.max(0, a.scrollHeight - a.clientHeight);
              const bScrollable = Math.max(0, b.scrollHeight - b.clientHeight);
              return bScrollable - aScrollable || (br.height * br.width) - (ar.height * ar.width);
            });
          const listbox = listboxes[0] || null;
          if (listbox) {
            listbox.scrollTop += 260;
            listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
          }
          return {
            ok: false,
            reason: "canada_not_visible",
            listboxCount: listboxes.length,
            scrollTop: listbox ? listbox.scrollTop : null,
            scrollHeight: listbox ? listbox.scrollHeight : null,
            visibleTexts: options.slice(0, 12).map((item) => item.text)
          };
        })()`);
        attempts.push({ index: index + 1, ...canada });
        if (canada.ok) {
          break;
        }
        await sleep(80);
      }
      if (canada?.ok) {
        await cdpClick(client, canada.x, canada.y);
        await sleep(800);
      }
      return {
        action,
        openInfo,
        canada,
        attempts: attempts.slice(0, 20),
        attemptCount: attempts.length,
        page: await client.evaluate(visibleExpression(), 30000),
      };
    }
    if (action === "phone-click-canada-radio-cdp") {
      const targetInfo = await client.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
        const options = [...document.querySelectorAll("[role='option']")].filter((el) => /canada/i.test(textOf(el)) && /(\\+1|\\(\\+1\\))/.test(textOf(el)));
        const option = options.find(visible);
        if (!option) return { ok: false, reason: "canada_option_not_found" };
        const radio = option.querySelector("input[data-automation-id='radioBtn'], [role='radio'], input[type='radio']");
        const rect = (radio && visible(radio) ? radio : option).getBoundingClientRect();
        const optionRect = option.getBoundingClientRect();
        return {
          ok: true,
          text: textOf(option),
          x: Math.round((radio && visible(radio) ? rect.left + rect.width / 2 : optionRect.left + 22)),
          y: Math.round((radio && visible(radio) ? rect.top + rect.height / 2 : optionRect.top + optionRect.height / 2)),
          radioVisible: Boolean(radio && visible(radio)),
          radioRect: radio ? { x: Math.round(radio.getBoundingClientRect().x), y: Math.round(radio.getBoundingClientRect().y), w: Math.round(radio.getBoundingClientRect().width), h: Math.round(radio.getBoundingClientRect().height) } : null,
          optionRect: { x: Math.round(optionRect.x), y: Math.round(optionRect.y), w: Math.round(optionRect.width), h: Math.round(optionRect.height) }
        };
      })()`);
      if (targetInfo.ok) {
        await cdpClick(client, targetInfo.x, targetInfo.y);
        await sleep(500);
      }
      return {
        action,
        targetInfo,
        popup: await client.evaluate(phonePopupInspectExpression(), 30000),
        page: await client.evaluate(visibleExpression(), 30000),
      };
    }
    if (action === "phone-keyboard-canada-cdp") {
      const openInfo = await client.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const input = document.getElementById("phoneNumber--countryPhoneCode");
        if (!input || !visible(input)) return { ok: false, reason: "phone_input_not_found" };
        input.scrollIntoView({ block: "center", inline: "center" });
        const rect = input.getBoundingClientRect();
        return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (openInfo.ok) {
        await cdpClick(client, openInfo.x, openInfo.y);
        await sleep(200);
      }
      const attempts = [];
      let active = null;
      for (let index = 0; index < 90; index += 1) {
        active = await client.evaluate(`(() => {
          const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
          const listbox = [...document.querySelectorAll("[role='listbox'], [data-automation-id='activeListContainer']")]
            .sort((a, b) => Math.max(0, b.scrollHeight - b.clientHeight) - Math.max(0, a.scrollHeight - a.clientHeight))[0] || null;
          const activeOption = [...(listbox?.querySelectorAll?.("[role='option']") || [])]
            .find((el) => el.getAttribute("aria-selected") === "true" || el.getAttribute("data-automation-selected") === "true");
          return {
            text: textOf(activeOption),
            ariaLabel: activeOption?.getAttribute("aria-label") || "",
            scrollTop: Math.round(listbox?.scrollTop || 0),
          };
        })()`);
        attempts.push({ index: index + 1, ...active });
        if (/^canada\\s*\\(\\+1\\)$/i.test(active.text) || /^canada\\s*\\(\\+1\\)/i.test(active.ariaLabel)) {
          await cdpKey(client, "Enter", "Enter", 13);
          await sleep(800);
          break;
        }
        await cdpKey(client, "ArrowDown", "ArrowDown", 40);
        await sleep(90);
      }
      return {
        action,
        openInfo,
        attempts,
        lastActive: active,
        popup: await client.evaluate(phonePopupInspectExpression(), 30000),
        page: await client.evaluate(visibleExpression(), 30000),
      };
    }
    if (action === "phone-wheel-cdp") {
      const openInfo = await client.evaluate(`(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const input = document.getElementById("phoneNumber--countryPhoneCode");
        if (!input || !visible(input)) return { ok: false, reason: "phone_input_not_found" };
        input.scrollIntoView({ block: "center", inline: "center" });
        const rect = input.getBoundingClientRect();
        return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (openInfo.ok) {
        await cdpClick(client, openInfo.x, openInfo.y);
        await sleep(200);
        await cdpKey(client, "ArrowDown", "ArrowDown", 40);
        await sleep(250);
      }
      const attempts = [];
      let canada = null;
      for (let index = 0; index < 90; index += 1) {
        canada = await client.evaluate(`(() => {
          const visible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
          const options = [...document.querySelectorAll("[role='option'], [data-automation-id='promptLeafNode'], [data-automation-id='promptOption']")]
            .filter(visible)
            .map((el) => ({ el, text: textOf(el) }));
          const match = options.find((item) => /canada/i.test(item.text) && /(\\+1|\\(\\+1\\))/.test(item.text));
          if (match) {
            match.el.scrollIntoView({ block: "center", inline: "center" });
            const rect = match.el.getBoundingClientRect();
            return {
              ok: true,
              text: match.text,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              visibleTexts: options.slice(0, 14).map((item) => item.text)
            };
          }
          const pick = options[0]?.el
            || [...document.querySelectorAll("[role='listbox'], [data-automation-id='promptSearchResultList'], [data-automation-id='activeListContainer']")]
              .find(visible);
          const rect = pick?.getBoundingClientRect?.();
          return {
            ok: false,
            reason: "canada_not_visible",
            wheelPoint: rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(rect.height / 2, 220)) } : null,
            visibleTexts: options.slice(0, 14).map((item) => item.text)
          };
        })()`);
        attempts.push({ index: index + 1, ...canada });
        if (canada.ok) {
          break;
        }
        if (!canada.wheelPoint) {
          break;
        }
        await cdpWheel(client, canada.wheelPoint.x, canada.wheelPoint.y, 420);
        await sleep(120);
      }
      if (canada?.ok) {
        await cdpClick(client, canada.x, canada.y);
        await sleep(800);
      }
      return {
        action,
        openInfo,
        canada,
        attempts: attempts.slice(0, 25),
        attemptCount: attempts.length,
        popup: await client.evaluate(phonePopupInspectExpression(), 30000),
        page: await client.evaluate(visibleExpression(), 30000),
      };
    }
    throw new Error(`Unknown action: ${action}`);
  } finally {
    client.close();
  }
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const targets = (await httpJson(args.cdpPort, "/json/list")).filter(
    (target) =>
      target.type === "page" &&
      /myworkdayjobs\.com/i.test(String(target.url || "")),
  );
  if (args.list) {
    console.log(
      JSON.stringify(
        targets.map((target) => ({
          id: target.id,
          title: target.title,
          url: target.url,
        })),
        null,
        2,
      ),
    );
    return;
  }
  const pattern = args.target ? new RegExp(args.target, "i") : null;
  const selected = pattern
    ? targets.filter(
        (target) => pattern.test(target.url || "") || pattern.test(target.title || ""),
      )
    : targets;
  const results = [];
  for (const target of selected) {
    results.push({
      target: {
        id: target.id,
        title: target.title,
        url: target.url,
      },
      page: await actionTarget(target, args.action),
    });
  }
  console.log(JSON.stringify(results, null, 2));
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
