#!/usr/bin/env node
"use strict";

const {
  inputByField,
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  snapshot,
  trustedClick,
  trustedKey,
} = require("./lib/workday_proof_common");

async function optionState(client, optionRegex) {
  return client.evaluate(`(() => {
    const wanted = new RegExp(${JSON.stringify(optionRegex)}, "i");
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const sourceInput = document.querySelector('input[id*="source"], input[aria-label*="Source" i]');
    const leaves = Array.from(document.querySelectorAll('[data-automation-id="promptLeafNode"], [role="treeitem"], [role="option"], label, div, span'))
      .map((el) => ({ el, text: norm([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" ")) }))
      .filter((item) => item.text && wanted.test(item.text) && visible(item.el))
      .sort((a, b) => a.text.length - b.text.length);
    const item = leaves[0] || null;
    const root = item?.el.closest('[data-automation-id="promptLeafNode"], [role="treeitem"], [role="option"], label') || item?.el || null;
    const input = root?.querySelector?.('input[type="checkbox"], input[type="radio"]') || null;
    const ariaControl = root?.querySelector?.('[role="checkbox"], [role="radio"]') || null;
    const selectedItems = Array.from(document.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="selectedToken"], [aria-selected="true"]'))
      .map((el) => norm([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" ")))
      .filter(Boolean);
    const rect = root?.getBoundingClientRect?.();
    const inputRect = input?.getBoundingClientRect?.();
    const ariaRect = ariaControl?.getBoundingClientRect?.();
    return {
      sourceValue: sourceInput?.value || "",
      sourceAriaExpanded: sourceInput?.getAttribute("aria-expanded") || "",
      selectedItems,
      optionText: item?.text || "",
      rootTag: root?.tagName || "",
      rootAutomationId: root?.getAttribute?.("data-automation-id") || "",
      rootRole: root?.getAttribute?.("role") || "",
      rootAriaChecked: root?.getAttribute?.("aria-checked") || "",
      inputChecked: input?.checked ?? null,
      inputAriaChecked: input?.getAttribute?.("aria-checked") || "",
      ariaChecked: ariaControl?.getAttribute?.("aria-checked") || "",
      rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
      inputRect: inputRect ? { x: Math.round(inputRect.left), y: Math.round(inputRect.top), width: Math.round(inputRect.width), height: Math.round(inputRect.height) } : null,
      ariaRect: ariaRect ? { x: Math.round(ariaRect.left), y: Math.round(ariaRect.top), width: Math.round(ariaRect.width), height: Math.round(ariaRect.height) } : null,
      outerHtml: root?.outerHTML?.slice(0, 1600) || "",
    };
  })()`);
}

function committed(state, optionRegex) {
  const rx = new RegExp(optionRegex, "i");
  return Boolean(
    state.inputChecked ||
      state.inputAriaChecked === "true" ||
      state.ariaChecked === "true" ||
      state.rootAriaChecked === "true" ||
      state.selectedItems.some((item) => rx.test(item)) ||
      rx.test(state.sourceValue),
  );
}

async function ensureOpen(client) {
  await client.evaluate(`(() => {
    const input = Array.from(document.querySelectorAll('input:not([type="hidden"]), [role="combobox"]'))
      .find((el) => /source|how\\s+did\\s+you\\s+hear\\s+about\\s+us/i.test([
        el.id,
        el.name,
        el.getAttribute("aria-label"),
        el.closest('[data-automation-id^="formField"], [role="group"], [data-fkit-id]')?.innerText,
      ].filter(Boolean).join(" ")));
    input?.scrollIntoView({ block: "center", inline: "center" });
  })()`);
  await sleep(300);
  const sourceInput = await rectFor(client, inputByField("how\\s+did\\s+you\\s+hear\\s+about\\s+us|source"));
  await trustedClick(client, sourceInput);
  await sleep(600);
  return sourceInput;
}

async function proof(client, args) {
  const optionRegex = args.optionRegex || "Job\\s+Boards?|Job\\s+Board|Job\\s+Sites?|LinkedIn|Website";
  const sourceInput = await ensureOpen(client);
  const attempts = [];
  let state = await optionState(client, optionRegex);
  attempts.push({ label: "initial", state });

  const clickPoints = [];
  if (state.inputRect) {
    clickPoints.push({
      label: "native input center",
      x: state.inputRect.x + Math.max(4, Math.round(state.inputRect.width / 2)),
      y: state.inputRect.y + Math.max(4, Math.round(state.inputRect.height / 2)),
    });
  }
  if (state.ariaRect) {
    clickPoints.push({
      label: "aria checkbox/radio center",
      x: state.ariaRect.x + Math.max(4, Math.round(state.ariaRect.width / 2)),
      y: state.ariaRect.y + Math.max(4, Math.round(state.ariaRect.height / 2)),
    });
  }
  if (state.rect) {
    clickPoints.push({ label: "leaf left control zone", x: state.rect.x + 18, y: state.rect.y + Math.round(state.rect.height / 2) });
    clickPoints.push({ label: "leaf text center", x: state.rect.x + Math.round(state.rect.width / 2), y: state.rect.y + Math.round(state.rect.height / 2) });
  }

  for (const point of clickPoints) {
    await trustedClick(client, { ...point, text: point.label });
    await sleep(700);
    state = await optionState(client, optionRegex);
    attempts.push({ label: point.label, point, state, committed: committed(state, optionRegex) });
    if (committed(state, optionRegex)) break;
    await ensureOpen(client);
    state = await optionState(client, optionRegex);
  }

  if (!committed(state, optionRegex)) {
    await trustedKey(client, "Enter");
    await sleep(700);
    state = await optionState(client, optionRegex);
    attempts.push({ label: "keyboard Enter", state, committed: committed(state, optionRegex) });
  }
  if (committed(state, optionRegex)) {
    await trustedKey(client, "Escape");
    await sleep(400);
  }

  return {
    behavior: "source_leaf_click_variants",
    sourceInput,
    optionRegex,
    attempts,
    finalCommitted: committed(state, optionRegex),
    final: state,
    finalSnapshot: await snapshot(client, "final"),
  };
}

const args = parseCommonArgs(process.argv, {
  optionRegex: "Job\\s+Boards?|Job\\s+Board|Job\\s+Sites?|LinkedIn|Website",
});

runProof(args, "workday_source_leaf_variants", proof).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
