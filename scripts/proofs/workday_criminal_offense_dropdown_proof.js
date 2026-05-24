#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("../lib/c3_cdp");

function parseArgs(argv) {
  const args = { cdpPort: 0, out: "", option: "No" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--option" && next) {
      args.option = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function connectPage(port) {
  const targets = await httpJson(port, "/json/list");
  const target =
    targets.find((item) => item.type === "page" && /myworkdayjobs\.com/i.test(String(item.url || ""))) ||
    targets.find((item) => item.type === "page" && /workday/i.test(String(item.url || "")));
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No Workday page target for ${port}`);
  }
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  return { target, client };
}

async function trustedClick(client, rect) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function snapshot(client, label) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const bodyText = document.body?.innerText || "";
    const stepMatch = bodyText.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      title: document.title,
      step: stepMatch ? {
        current: Number(stepMatch[1]),
        total: Number(stepMatch[2]),
        title: norm(stepMatch[3]),
      } : null,
      errors: Array.from(document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [id*="error"]'))
        .filter(visible)
        .map((el) => norm(el.innerText || el.textContent))
        .filter(Boolean)
        .slice(0, 20),
      buttons: Array.from(document.querySelectorAll("button"))
        .filter(visible)
        .map((button) => ({
          id: button.id || "",
          name: button.getAttribute("name") || "",
          ariaLabel: button.getAttribute("aria-label") || "",
          text: norm(button.innerText || button.textContent),
        }))
        .filter((item) => /criminal offense|Select One|^No$|^Yes$|Save and Continue/i.test(
          [item.text, item.ariaLabel].join(" ")
        ))
        .slice(0, 30),
      bodyTail: bodyText.slice(-2500),
    };
  })()`);
}

async function findSelectOne(client) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const buttons = Array.from(document.querySelectorAll("button"))
      .filter(visible)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          button,
          rect,
          text: norm(button.innerText || button.textContent || button.getAttribute("aria-label")),
          id: button.id || "",
          name: button.getAttribute("name") || "",
          ariaLabel: button.getAttribute("aria-label") || "",
        };
      });
    const found = buttons.find((item) => /Select One/i.test(item.text) && /Required/i.test(item.ariaLabel || item.text));
    if (!found) {
      return { ok: false, reason: "select_one_not_found", buttons: buttons.map(({ button, rect, ...item }) => item).slice(0, 40) };
    }
    found.button.scrollIntoView({ block: "center", inline: "center" });
    const rect = found.button.getBoundingClientRect();
    return {
      ok: true,
      id: found.id,
      name: found.name,
      ariaLabel: found.ariaLabel,
      text: found.text,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`);
}

async function findOption(client, optionText) {
  return client.evaluate(`(() => {
    const wanted = ${JSON.stringify(optionText)};
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], button, div, span'))
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: norm(el.innerText || el.textContent || el.getAttribute("aria-label")) }))
      .filter((item) => item.text === wanted)
      .sort((a, b) => a.text.length - b.text.length);
    const found = candidates[0];
    if (!found) {
      return {
        ok: false,
        reason: "option_not_found",
        option: wanted,
        visibleOptions: Array.from(document.querySelectorAll('[role="option"], [data-automation-id="menuItem"], button, div, span'))
          .filter(visible)
          .map((el) => norm(el.innerText || el.textContent || el.getAttribute("aria-label")))
          .filter(Boolean)
          .slice(0, 80),
      };
    }
    return {
      ok: true,
      option: wanted,
      text: found.text,
      x: Math.round(found.rect.left + found.rect.width / 2),
      y: Math.round(found.rect.top + found.rect.height / 2),
    };
  })()`);
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.cdpPort || !args.out) {
    throw new Error("--cdp-port and --out are required");
  }
  const { target, client } = await connectPage(args.cdpPort);
  try {
    const startedAt = new Date().toISOString();
    const before = await snapshot(client, "before");
    const selectOne = await findSelectOne(client);
    if (selectOne.ok) {
      await trustedClick(client, selectOne);
      await sleep(500);
    }
    const option = selectOne.ok ? await findOption(client, args.option) : null;
    if (option?.ok) {
      await trustedClick(client, option);
      await sleep(700);
    }
    const after = await snapshot(client, "after");
    const payload = {
      ok: Boolean(selectOne.ok && option?.ok),
      proof: "workday_criminal_offense_dropdown",
      port: args.cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
      startedAt,
      finishedAt: new Date().toISOString(),
      selectedOption: args.option,
      selectOne,
      option,
      before,
      after,
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: payload.ok, out: args.out }, null, 2));
    process.exitCode = payload.ok ? 0 : 1;
  } finally {
    client.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
