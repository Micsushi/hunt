#!/usr/bin/env node
"use strict";

const { CdpClient, httpJson, sleep } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = {
    cdpPort: 9222,
    target: "cox",
    action: "inspect",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      index += 1;
    } else if (arg === "--target" && next) {
      args.target = next;
      index += 1;
    } else if (arg === "--action" && next) {
      args.action = next;
      index += 1;
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
    "Usage: node scripts/c3_workday_source_probe.js [options]",
    "",
    "Options:",
    "  --cdp-port <port>  Chrome DevTools port, default 9222",
    "  --target <regex>   Filter Workday page by URL or title",
    "  --action <name>    inspect, open, clear, back, category:<text>, leaf:<text>, click-first-leaf",
  ].join("\n");
}

async function cdpClick(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
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

function inspectExpression() {
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
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id || "",
        role: el.getAttribute("role") || "",
        automationId: el.getAttribute("data-automation-id") || "",
        uxiWidgetType: el.getAttribute("data-uxi-widget-type") || "",
        uxiMultiselectId: el.getAttribute("data-uxi-multiselect-id") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        ariaSelected: el.getAttribute("aria-selected") || "",
        ariaChecked: el.getAttribute("aria-checked") || "",
        text: textOf(el).slice(0, 180),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        },
        reactKeys: Object.keys(el).filter((key) => key.startsWith("__react")).slice(0, 4)
      };
    };
    const source = document.getElementById("source--source");
    const sourceContainer = source?.closest?.("[data-automation-id='multiSelectContainer']");
    const optionSelector = [
      "[role='option']",
      "[data-automation-id='menuItem']",
      "[data-automation-id='promptLeafNode']",
      "[data-automation-id='promptOption']"
    ].join(",");
    const options = [...document.querySelectorAll(optionSelector)]
      .filter(visible)
      .map((el) => {
        const row = el.closest("[role='option'], [data-automation-id='menuItem']") || el;
        const radio = row.querySelector("input[data-automation-id='radioBtn'], input[type='radio'], [role='radio']");
        return {
          node: brief(el),
          row: brief(row),
          radio: brief(radio),
          isCategory: Boolean(
            row.querySelector("[data-automation-id='promptIcon'] svg, svg") &&
            !row.querySelector("input[data-automation-id='radioBtn'], input[type='radio'], [role='radio']")
          )
        };
      });
    const buttons = [...document.querySelectorAll("button, [role='button']")]
      .filter(visible)
      .map(brief);
    return {
      href: location.href,
      title: document.title,
      source: brief(source),
      sourceContainer: brief(sourceContainer),
      selectedSourceItems: [...(sourceContainer?.querySelectorAll?.("[data-automation-id='selectedItem'], [aria-label*='press delete']") || [])]
        .filter(visible)
        .map(brief),
      buttons,
      options: options.slice(0, 120),
      errors: [...document.querySelectorAll("[role='alert'], [data-automation-id*='error'], [id*='error']")]
        .filter(visible)
        .map(textOf)
        .filter(Boolean)
        .slice(0, 20)
    };
  })()`;
}

function clickExpression(action) {
  const mode = action.split(":")[0];
  const wanted = action.includes(":")
    ? action.slice(action.indexOf(":") + 1)
    : "";
  return `(() => {
    const wanted = ${JSON.stringify(wanted)};
    const mode = ${JSON.stringify(mode)};
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim();
    let target = null;
    if (mode === "clear") {
      target = [...document.querySelectorAll("[data-automation-id='selectedItem'], [aria-label*='press delete']")]
        .filter(visible)
        .find((el) => /billboard|linkedin|social|job|website|source/i.test(textOf(el) || el.getAttribute("aria-label") || ""));
    } else if (mode === "open") {
      target = document.getElementById("source--source")
        || [...document.querySelectorAll("input, button")].find((el) => /how did you hear about us|source/i.test([el.id, el.name, el.getAttribute("aria-label"), textOf(el.closest("[data-automation-id^='formField']") || el.parentElement)].filter(Boolean).join(" ")));
    } else if (mode === "back") {
      target = [...document.querySelectorAll("button, [role='button']")]
        .filter(visible)
        .find((el) => /back/i.test([textOf(el), el.getAttribute("aria-label")].join(" ")));
    } else {
      const rows = [...document.querySelectorAll("[role='option'], [data-automation-id='menuItem']")]
        .filter(visible);
      if (mode === "click-first-leaf") {
        target = rows.find((row) => row.querySelector("input[data-automation-id='radioBtn'], input[type='radio'], [role='radio']"));
      } else if (mode === "category") {
        target = rows.find((row) => norm(textOf(row)).includes(norm(wanted)));
      } else if (mode === "leaf") {
        const row = rows.find((candidate) => norm(textOf(candidate)).includes(norm(wanted)));
        target = row?.querySelector?.("input[data-automation-id='radioBtn'], input[type='radio'], [role='radio']")
          || row?.querySelector?.("[data-automation-id='promptOption']")
          || row;
      }
    }
    if (!target || !visible(target)) {
      return { ok: false, reason: "target_not_found", mode, wanted };
    }
    if (mode === "clear") {
      target.focus({ preventScroll: true });
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", keyCode: 46, which: 46, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: "Delete", code: "Delete", keyCode: 46, which: 46, bubbles: true, cancelable: true }));
    }
    target.scrollIntoView({ block: "center", inline: "center" });
    const rect = target.getBoundingClientRect();
    return {
      ok: true,
      mode,
      wanted,
      text: textOf(target),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  })()`;
}

async function runAction(client, action) {
  if (action !== "inspect") {
    const target = await client.evaluate(clickExpression(action), 30000);
    if (target.ok) {
      await cdpClick(client, target.x, target.y);
      await sleep(action.startsWith("category:") ? 900 : 500);
    }
    return {
      action,
      target,
      page: await client.evaluate(inspectExpression(), 30000),
    };
  }
  return {
    action,
    page: await client.evaluate(inspectExpression(), 30000),
  };
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const pattern = new RegExp(args.target, "i");
  const targets = (await httpJson(args.cdpPort, "/json/list")).filter(
    (target) =>
      target.type === "page" &&
      /myworkdayjobs\.com/i.test(String(target.url || "")) &&
      (pattern.test(target.url || "") || pattern.test(target.title || "")),
  );
  if (!targets.length) {
    throw new Error(`No matching Workday page target for ${args.target}`);
  }
  const client = await new CdpClient(targets[0].webSocketDebuggerUrl).connect();
  try {
    await client.send("Page.bringToFront", {});
    const result = await runAction(client, args.action);
    console.log(
      JSON.stringify(
        {
          target: {
            id: targets[0].id,
            title: targets[0].title,
            url: targets[0].url,
          },
          ...result,
        },
        null,
        2,
      ),
    );
  } finally {
    client.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
