#!/usr/bin/env node
"use strict";

const {
  inputByField,
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  trustedClick,
  trustedKey,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_source_active_listbox_proof.js --cdp-port <port> --option-regex <regex> --out <file>",
    "",
    "Purpose: prove Workday Source category expansion and child selection inside the active listbox only.",
  ].join("\n");
}

async function sourceState(client, optionRegex) {
  return client.evaluate(`(() => {
    const wanted = new RegExp(${JSON.stringify(optionRegex)}, "i");
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
        && rect.top < innerHeight && rect.left < innerWidth
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const label = (el) => norm([
      el?.innerText,
      el?.textContent,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("data-automation-label"),
      el?.value,
    ].filter(Boolean).join(" "));
    const rect = (el) => {
      const r = el?.getBoundingClientRect?.();
      return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const sourceInput = document.querySelector("#source--source, input[id*='source'], input[aria-label*='Source' i]");
    const sourceField = sourceInput?.closest?.("[data-automation-id^='formField'], [role='group'], [data-fkit-id]") || sourceInput?.parentElement || null;
    const boxes = Array.from(document.querySelectorAll(
      "[data-automation-id='activeListContainer'], [data-automation-id='promptSearchResultList'], [data-uxi-widget-type='multiselectlist'], [role='listbox']",
    ))
      .filter(visible)
      .filter((box) => !box.closest("[data-automation-id='selectedItemList']"))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const aDistance = sourceInput ? Math.abs(ar.top - sourceInput.getBoundingClientRect().bottom) : 0;
        const bDistance = sourceInput ? Math.abs(br.top - sourceInput.getBoundingClientRect().bottom) : 0;
        return aDistance - bDistance || br.height - ar.height;
      });
    const listbox = boxes[0] || null;
    const rows = Array.from((listbox || document).querySelectorAll(
      "[role='option'], [data-automation-id='menuItem'], [data-automation-id='promptLeafNode'], [data-automation-id='promptOption']",
    ))
      .filter(visible)
      .map((el) => {
        const promptLeaf = el.matches?.("[data-automation-id='promptLeafNode']")
          ? el
          : el.querySelector?.("[data-automation-id='promptLeafNode']");
        const promptOption = el.matches?.("[data-automation-id='promptOption']")
          ? el
          : el.querySelector?.("[data-automation-id='promptOption']");
        const checkbox = el.querySelector?.("input[type='checkbox'], input[type='radio'], [role='checkbox'], [role='radio']");
        const r = rect(el);
        const leafRect = rect(promptLeaf);
        const optionRect = rect(promptOption);
        const checkboxRect = rect(checkbox);
        return {
          text: label(el),
          auto: el.getAttribute("data-automation-id") || "",
          role: el.getAttribute("role") || "",
          type: promptLeaf?.getAttribute?.("data-uxi-multiselectlistitem-type") || el.getAttribute("data-uxi-multiselectlistitem-type") || "",
          sideCharm: promptLeaf?.getAttribute?.("data-uxi-multiselectlistitem-hassidecharm") || el.getAttribute("data-uxi-multiselectlistitem-hassidecharm") || "",
          checked: promptLeaf?.getAttribute?.("data-automation-checked") || el.getAttribute("aria-checked") || "",
          rect: r,
          points: {
            side: r ? { x: Math.round(r.x + r.w - 18), y: Math.round(r.y + r.h / 2), text: label(el) } : null,
            left: r ? { x: Math.round(r.x + 18), y: Math.round(r.y + r.h / 2), text: label(el) } : null,
            leaf: leafRect ? { x: Math.round(leafRect.x + 18), y: Math.round(leafRect.y + leafRect.h / 2), text: label(promptLeaf) } : null,
            prompt: optionRect ? { x: Math.round(optionRect.x + Math.min(60, optionRect.w / 2)), y: Math.round(optionRect.y + optionRect.h / 2), text: label(promptOption) } : null,
            checkbox: checkboxRect ? { x: Math.round(checkboxRect.x + checkboxRect.w / 2), y: Math.round(checkboxRect.y + checkboxRect.h / 2), text: label(checkbox) } : null,
          },
        };
      });
    const selectedItems = Array.from((sourceField || document).querySelectorAll(
      "[data-automation-id='selectedItem'], [id^='pill-'], [aria-label*='press delete to clear value']",
    ))
      .filter(visible)
      .map(label)
      .filter(Boolean);
    const sourceErrors = Array.from((sourceField || document).querySelectorAll(
      "[data-automation-id='inputAlert'], [data-automation-id='errorMessage'], [role='alert'], [aria-invalid='true']",
    ))
      .filter(visible)
      .map(label)
      .filter(Boolean);
    return {
      sourceValue: sourceInput?.value || "",
      sourceInvalid: sourceInput?.getAttribute("aria-invalid") || "",
      listbox: listbox ? {
        text: label(listbox).slice(0, 500),
        rect: rect(listbox),
        scrollTop: listbox.scrollTop,
        scrollHeight: listbox.scrollHeight,
        clientHeight: listbox.clientHeight,
      } : null,
      selectedItems,
      sourceErrors,
      rows,
      category: rows
        .filter((row) => /Job Sites?|Job Boards?|Career Websites?/i.test(row.text) && (row.type === "2" || row.sideCharm === "true"))
        .sort((a, b) => a.text.length - b.text.length)[0] || null,
      child: rows
        .filter((row) => wanted.test(row.text) && (row.type === "1" || /menuItem|promptLeafNode/.test(row.auto)))
        .sort((a, b) => {
          const aLeaf = /promptLeafNode/.test(a.auto) ? 0 : 1;
          const bLeaf = /promptLeafNode/.test(b.auto) ? 0 : 1;
          return aLeaf - bLeaf || a.text.length - b.text.length;
        })[0] || null,
      committed: selectedItems.some((item) => wanted.test(item)) || wanted.test(sourceInput?.value || ""),
    };
  })()`);
}

async function reactClickSourceRow(client, rowRegex, preferType) {
  return client.evaluate(`(() => {
    const wanted = new RegExp(${JSON.stringify(rowRegex)}, "i");
    const preferType = ${JSON.stringify(preferType || "")};
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
        && rect.top < innerHeight && rect.left < innerWidth
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const label = (el) => norm([
      el?.innerText,
      el?.textContent,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("data-automation-label"),
    ].filter(Boolean).join(" "));
    const rows = Array.from(document.querySelectorAll(
      "[data-automation-id='activeListContainer'] [data-automation-id='promptLeafNode'], [data-automation-id='activeListContainer'] [data-automation-id='menuItem'], [data-automation-id='activeListContainer'] [data-automation-id='promptOption']",
    ))
      .filter(visible)
      .filter((el) => wanted.test(label(el)))
      .sort((a, b) => {
        const aType = a.getAttribute("data-uxi-multiselectlistitem-type") || a.querySelector?.("[data-uxi-multiselectlistitem-type]")?.getAttribute("data-uxi-multiselectlistitem-type") || "";
        const bType = b.getAttribute("data-uxi-multiselectlistitem-type") || b.querySelector?.("[data-uxi-multiselectlistitem-type]")?.getAttribute("data-uxi-multiselectlistitem-type") || "";
        const aPreferred = preferType && aType === preferType ? 0 : 1;
        const bPreferred = preferType && bType === preferType ? 0 : 1;
        const aLeaf = a.getAttribute("data-automation-id") === "promptLeafNode" ? 0 : 1;
        const bLeaf = b.getAttribute("data-automation-id") === "promptLeafNode" ? 0 : 1;
        return aPreferred - bPreferred || aLeaf - bLeaf || label(a).length - label(b).length;
      });
    const row = rows[0] || null;
    if (!row) return { ok: false, reason: "row_not_found" };
    const path = [];
    const fire = (el) => {
      const fiberKey = Object.keys(el || {}).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
      let node = fiberKey ? el[fiberKey] : null;
      for (let depth = 0; node && depth < 10; depth += 1) {
        const props = node.memoizedProps || node.pendingProps || {};
        path.push({ depth, elementType: String(node.elementType || node.type || ""), keys: Object.keys(props).filter((key) => /^on[A-Z]/.test(key)) });
        const handler = props.onClick || props.onSelect || props.onMouseDown;
        if (typeof handler === "function") {
          const event = {
            type: props.onMouseDown ? "mousedown" : "click",
            target: el,
            currentTarget: el,
            bubbles: true,
            cancelable: true,
            preventDefault() {},
            stopPropagation() {},
            persist() {},
            isPropagationStopped() { return false; },
            isDefaultPrevented() { return false; },
            nativeEvent: new MouseEvent("click", { bubbles: true, cancelable: true }),
          };
          handler(event);
          return true;
        }
        node = node.return;
      }
      return false;
    };
    return {
      ok: fire(row),
      reason: "",
      row: {
        text: label(row),
        auto: row.getAttribute("data-automation-id") || "",
        type: row.getAttribute("data-uxi-multiselectlistitem-type") || "",
      },
      path,
    };
  })()`);
}

async function scrollActiveListbox(client, amount) {
  return client.evaluate(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const sourceInput = document.querySelector("#source--source, input[id*='source'], input[aria-label*='Source' i]");
    const sourceRect = sourceInput?.getBoundingClientRect?.();
    const listbox = Array.from(document.querySelectorAll(
      "[data-automation-id='activeListContainer'], [data-automation-id='promptSearchResultList'], [data-uxi-widget-type='multiselectlist'], [role='listbox']",
    ))
      .filter(visible)
      .filter((box) => !box.closest("[data-automation-id='selectedItemList']"))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const aDistance = sourceRect ? Math.abs(ar.top - sourceRect.bottom) : 0;
        const bDistance = sourceRect ? Math.abs(br.top - sourceRect.bottom) : 0;
        return aDistance - bDistance || br.height - ar.height;
      })[0] || null;
    if (!listbox) return { ok: false, reason: "missing_listbox" };
    const before = listbox.scrollTop;
    listbox.scrollTop += ${Number(amount || 220)};
    listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { ok: Math.abs(listbox.scrollTop - before) > 0, before, after: listbox.scrollTop };
  })()`);
}

async function proof(client, args) {
  const optionRegex = args.optionRegex || "LinkedIn|Indeed|Glassdoor";
  const sourceInput = await rectFor(
    client,
    inputByField("how\\s+did\\s+you\\s+hear\\s+about\\s+us|source"),
  );
  const attempts = [];
  await trustedClick(client, sourceInput);
  await sleep(700);
  let state = await sourceState(client, optionRegex);
  attempts.push({ action: "opened_source", state });
  if (!state.child && state.category?.points?.side) {
    await trustedClick(client, state.category.points.side);
    await sleep(900);
    state = await sourceState(client, optionRegex);
    attempts.push({ action: "expanded_category_side", state });
  }
  if (!state.child) {
    const reactCategory = await reactClickSourceRow(
      client,
      "Job Sites?|Job Boards?|Career Websites?",
      "2",
    );
    await sleep(900);
    state = await sourceState(client, optionRegex);
    attempts.push({ action: "expanded_category_react", reactCategory, state });
  }
  for (let scroll = 0; !state.child && scroll < 8; scroll += 1) {
    const moved = await scrollActiveListbox(client, 220);
    await sleep(350);
    state = await sourceState(client, optionRegex);
    attempts.push({ action: "scroll_child_list", scroll, moved, state });
    if (!moved.ok) {
      break;
    }
  }
  if (!state.child) {
    return {
      behavior: "source_active_listbox_child_commit",
      optionRegex,
      sourceInput,
      attempts,
      finalCommitted: false,
      final: state,
      reason: "source_child_not_found",
    };
  }
  const childPoint =
    state.child.points.checkbox ||
    state.child.points.leaf ||
    state.child.points.left ||
    state.child.points.prompt;
  const reactChild = await reactClickSourceRow(client, optionRegex, "1");
  await sleep(700);
  state = await sourceState(client, optionRegex);
  attempts.push({ action: "selected_child_react", reactChild, state });
  if (!state.committed) {
    await trustedClick(client, childPoint);
    await sleep(900);
    state = await sourceState(client, optionRegex);
    attempts.push({ action: "selected_child", point: childPoint, state });
  }
  if (!state.committed) {
    await trustedKey(client, "Space");
    await sleep(700);
    state = await sourceState(client, optionRegex);
    attempts.push({ action: "keyboard_space_after_child", state });
  }
  await trustedKey(client, "Escape");
  await sleep(300);
  return {
    behavior: "source_active_listbox_child_commit",
    optionRegex,
    sourceInput,
    attempts,
    finalCommitted: state.committed,
    final: state,
  };
}

const args = parseCommonArgs(process.argv, {
  optionRegex: "LinkedIn|Indeed|Glassdoor",
});
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_source_active_listbox", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
