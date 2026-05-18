#!/usr/bin/env node
"use strict";

const { CdpClient, httpJson, sleep } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = {
    cdpPort: 9222,
    urlIncludes: "myworkdayjobs.com",
    click: false,
    targetLabel: "",
    waitMs: 8000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--url-includes" && next) {
      args.urlIncludes = next;
      i += 1;
    } else if (arg === "--click") {
      args.click = true;
    } else if (arg === "--target-label" && next) {
      args.targetLabel = next;
      i += 1;
    } else if (arg === "--wait-ms" && next) {
      args.waitMs = Number(next);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function pageExpression({ click, targetLabel }) {
  return `(() => {
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const labelFor = (el) => normalize([
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.value,
      el.innerText,
      el.textContent,
      el.closest("label")?.innerText,
      el.closest('[data-automation-id], section, div')?.innerText,
    ].filter(Boolean).join(" "));
    const metadataFor = (el) => normalize([
      el.id,
      el.name,
      el.type,
      el.getAttribute("data-automation-id"),
      el.getAttribute("data-testid"),
      el.className,
    ].filter(Boolean).join(" "));
    const controls = [...document.querySelectorAll("button,[role='button'],input")]
      .filter(visible)
      .map((el, index) => {
        const rect = el.getBoundingClientRect();
        const label = labelFor(el);
        const metadata = metadataFor(el);
        let score = 0;
        if (/^create account(?: create account)?$/i.test(label)) score += 140;
        else if (/^sign in(?: sign in)?$/i.test(label)) score += 120;
        else if (/^submit$/i.test(label)) score += 110;
        else if (/create account|sign up|register|sign in|log in|login/i.test(label + " " + metadata)) score += 80;
        if (String(el.tagName || "").toLowerCase() === "button" || String(el.getAttribute("type") || "").toLowerCase() === "submit") score += 30;
        if (/submitbutton/i.test(metadata)) score += 25;
        if (/click_filter/i.test(metadata)) score -= 20;
        if (/utility|navigation|search for jobs|backtojobposting|forgotpassword/i.test(metadata)) score -= 80;
        return {
          index,
          tag: el.tagName,
          type: el.getAttribute("type") || "",
          label,
          metadata,
          score,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          value: el.value || "",
          checked: Boolean(el.checked),
          disabled: Boolean(el.disabled),
        };
      });
    const requestedLabel = ${JSON.stringify(targetLabel || "")};
    const requestedTarget = requestedLabel
      ? controls.find((entry) => new RegExp(requestedLabel, "i").test(entry.label + " " + entry.metadata)) || null
      : null;
    const target = requestedTarget || controls
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0] || null;
    return {
      href: location.href,
      title: document.title,
      bodyHead: normalize(document.body?.innerText || "").slice(0, 1200),
      controls: controls.slice(0, 80),
      target,
      clickRequested: ${click ? "true" : "false"},
    };
  })()`;
}

async function main() {
  const args = parseArgs(process.argv);
  const tabs = await httpJson(args.cdpPort, "/json/list");
  const pages = tabs.filter((tab) => tab.type === "page");
  const tab = pages.find((page) => String(page.url || "").includes(args.urlIncludes));
  if (!tab) {
    throw new Error(`No page matched ${args.urlIncludes}`);
  }

  const client = await new CdpClient(tab.webSocketDebuggerUrl).connect();
  await client.send("Runtime.enable");
  await client.send("Log.enable").catch(() => {});
  await client.send("Page.enable").catch(() => {});
  const before = await client.evaluate(
    pageExpression({ click: args.click, targetLabel: args.targetLabel }),
  );
  let clicked = null;
  if (args.click && before.target) {
    const x = Math.round(before.target.rect.x + before.target.rect.width / 2);
    const y = Math.round(before.target.rect.y + before.target.rect.height / 2);
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
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
    clicked = { x, y, target: before.target };
    await sleep(args.waitMs);
  }
  const after = await client.evaluate(
    pageExpression({ click: false, targetLabel: args.targetLabel }),
  );
  const websiteState = await client
    .evaluate(`(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const rows = [...document.querySelectorAll("input")]
        .filter((input) => {
          const text = [
            input.id,
            input.name,
            input.getAttribute("aria-label"),
            input.closest("div")?.innerText,
          ].join(" ");
          return /url|website/i.test(text);
        })
        .map((input) => {
          const rect = input.getBoundingClientRect();
          const container = input.closest("[data-automation-id], li, div");
          return {
            id: input.id || "",
            name: input.name || "",
            value: input.value || "",
            invalid: input.getAttribute("aria-invalid") || "",
            rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
            nearby: normalize(container?.innerText || "").slice(0, 320),
          };
        });
      const buttons = [...document.querySelectorAll("button,[role='button']")]
        .filter(visible)
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            text: normalize(button.innerText || button.getAttribute("aria-label") || ""),
            automationId: button.getAttribute("data-automation-id") || "",
            rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
          };
        })
        .filter((button) => /delete|remove|add|save|continue/i.test(button.text + " " + button.automationId));
      const options = [...document.querySelectorAll("[role='option'], [role='listitem'], [data-automation-id], li, [id]")]
        .filter(visible)
        .map((option) => {
          const rect = option.getBoundingClientRect();
          return {
            tag: option.tagName,
            role: option.getAttribute("role") || "",
            id: option.id || "",
            automationId: option.getAttribute("data-automation-id") || "",
            ariaLabel: option.getAttribute("aria-label") || "",
            text: normalize(option.innerText || option.textContent || "").slice(0, 180),
            rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
          };
        })
        .filter((option) => /Basico|Básico|Intermedi|Avan|Fluente|Native|Nativo|Select One/i.test([
          option.text,
          option.ariaLabel,
          option.automationId,
        ].join(" ")))
        .slice(0, 80);
      return { rows, buttons, options };
    })()`)
    .catch(() => ({ rows: [], buttons: [] }));
  const consoleErrors = await client
    .send("Runtime.evaluate", {
      expression: `(() => {
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        return [...document.querySelectorAll("[role='alert'],[data-automation-id*='error' i],[id*='error' i]")]
          .map((el) => normalize(el.innerText || el.textContent))
          .filter(Boolean)
          .slice(0, 40);
      })()`,
      returnByValue: true,
    })
    .then((result) => result.result?.value || [])
    .catch(() => []);
  client.close();
  console.log(
    JSON.stringify(
      {
        ok: true,
        tab: { id: tab.id, title: tab.title, url: tab.url },
        clicked,
        before: {
          href: before.href,
          title: before.title,
          bodyHead: before.bodyHead,
          target: before.target,
        },
        after: {
          href: after.href,
          title: after.title,
          bodyHead: after.bodyHead,
          target: after.target,
          alerts: consoleErrors,
          websiteState,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
