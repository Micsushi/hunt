#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson } = require("../lib/c3_cdp");

function parseArgs(argv) {
  const args = { cdpPort: 0, out: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = path.resolve(process.cwd(), next);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.cdpPort) throw new Error("--cdp-port is required");
  if (!args.out) throw new Error("--out is required");
  return args;
}

async function connectWorkday(port) {
  const targets = await httpJson(port, "/json/list");
  const target =
    targets.find((item) => item.type === "page" && /myworkdayjobs\.com|workday/i.test(item.url || "")) ||
    targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No Workday page target for ${port}`);
  }
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  return { target, client };
}

async function inspect(client) {
  return client.evaluate(`(() => {
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
      return r ? {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      } : null;
    };
    const stepMatch = (document.body?.innerText || "").match(/(?:current|completed)\\s+step\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
    const controlSummary = (el) => ({
      tag: el.tagName,
      type: el.getAttribute("type") || "",
      id: el.id || "",
      name: el.getAttribute("name") || "",
      role: el.getAttribute("role") || "",
      automationId: el.getAttribute("data-automation-id") || "",
      uxi: el.getAttribute("data-uxi-widget-type") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      ariaExpanded: el.getAttribute("aria-expanded") || "",
      ariaInvalid: el.getAttribute("aria-invalid") || "",
      ariaRequired: el.getAttribute("aria-required") || "",
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      value: "value" in el ? el.value : "",
      text: norm(el.innerText || el.textContent || "").slice(0, 300),
      rect: rect(el),
    });
    const fieldContainers = Array.from(document.querySelectorAll(
      "[data-automation-id^='formField'], [data-fkit-id], fieldset, section",
    ))
      .filter((el) => /skill|type to add skills|job title|company|from|to|school|degree|resume|experience/i.test(label(el)))
      .slice(0, 80)
      .map((container) => ({
        automationId: container.getAttribute("data-automation-id") || "",
        fkitId: container.getAttribute("data-fkit-id") || "",
        text: label(container).slice(0, 1000),
        rect: rect(container),
        visible: visible(container),
        controls: Array.from(container.querySelectorAll("input:not([type='hidden']), textarea, button, [role='combobox']"))
          .filter((el) => el.tagName !== "SCRIPT")
          .map(controlSummary),
        selectedItems: Array.from(container.querySelectorAll(
          "[data-automation-id='selectedItem'], [id^='pill-'], [aria-label*='press delete to clear value']",
        ))
          .filter(visible)
          .map(label)
          .filter(Boolean),
        alerts: Array.from(container.querySelectorAll(
          "[data-automation-id='inputAlert'], [data-automation-id='errorMessage'], [role='alert'], [aria-invalid='true']",
        ))
          .filter(visible)
          .map(label)
          .filter(Boolean),
      }));
    const skillsInput = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, [role='combobox']"))
      .find((el) => /skill|type to add skills/i.test([
        el.id,
        el.name,
        el.getAttribute("aria-label"),
        el.getAttribute("placeholder"),
        label(el.closest("[data-automation-id^='formField'], [data-fkit-id], section, fieldset") || el.parentElement),
      ].filter(Boolean).join(" ")));
    const skillsContainer =
      skillsInput?.closest?.("[data-automation-id^='formField'], [data-fkit-id], section, fieldset") ||
      null;
    const listboxes = Array.from(document.querySelectorAll(
      "[data-automation-id='activeListContainer'], [data-automation-id='promptSearchResultList'], [data-uxi-widget-type='multiselectlist'], [role='listbox']",
    ))
      .filter(visible)
      .filter((box) => !box.closest("[data-automation-id='selectedItemList']"))
      .map((box) => ({
        automationId: box.getAttribute("data-automation-id") || "",
        role: box.getAttribute("role") || "",
        ariaActive: box.getAttribute("aria-activedescendant") || "",
        scrollTop: box.scrollTop,
        scrollHeight: box.scrollHeight,
        clientHeight: box.clientHeight,
        rect: rect(box),
        text: label(box).slice(0, 1200),
        rows: Array.from(box.querySelectorAll(
          "[role='option'], [data-automation-id='menuItem'], [data-automation-id='promptLeafNode'], [data-automation-id='promptOption'], li",
        ))
          .filter(visible)
          .slice(0, 60)
          .map((row) => ({
            text: label(row).slice(0, 240),
            automationId: row.getAttribute("data-automation-id") || "",
            role: row.getAttribute("role") || "",
            ariaSelected: row.getAttribute("aria-selected") || "",
            checked: row.getAttribute("data-automation-checked") || row.getAttribute("aria-checked") || "",
            rect: rect(row),
          })),
      }));
    const footerButton = document.querySelector("[data-automation-id='pageFooterNextButton']");
    return {
      href: location.href,
      title: document.title,
      scroll: { x: scrollX, y: scrollY, innerHeight, documentHeight: document.documentElement.scrollHeight },
      step: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: norm(stepMatch[3]) } : null,
      activeElement: document.activeElement ? controlSummary(document.activeElement) : null,
      errors: Array.from(document.querySelectorAll("[role='alert'], [data-automation-id*='error'], [id*='error']"))
        .filter(visible)
        .map(label)
        .filter(Boolean)
        .filter((text) => !/successfully uploaded/i.test(text))
        .slice(0, 50),
      footer: footerButton ? controlSummary(footerButton) : null,
      skills: {
        input: skillsInput ? controlSummary(skillsInput) : null,
        containerText: skillsContainer ? label(skillsContainer).slice(0, 1500) : "",
        selectedItems: skillsContainer ? Array.from(skillsContainer.querySelectorAll(
          "[data-automation-id='selectedItem'], [id^='pill-'], [aria-label*='press delete to clear value']",
        )).filter(visible).map(label).filter(Boolean) : [],
        alerts: skillsContainer ? Array.from(skillsContainer.querySelectorAll(
          "[data-automation-id='inputAlert'], [data-automation-id='errorMessage'], [role='alert'], [aria-invalid='true']",
        )).filter(visible).map(label).filter(Boolean) : [],
      },
      listboxes,
      fieldContainers,
      bodyTail: norm(document.body?.innerText || "").slice(-2500),
    };
  })()`);
}

async function main() {
  const args = parseArgs(process.argv);
  const { target, client } = await connectWorkday(args.cdpPort);
  try {
    const payload = {
      ok: true,
      port: args.cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
      capturedAt: new Date().toISOString(),
      state: await inspect(client),
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, out: args.out }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
