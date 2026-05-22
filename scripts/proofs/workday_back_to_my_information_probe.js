#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("../lib/c3_cdp");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_back_to_my_information_probe.js --cdp-port <port> --out <file>",
    "",
    "Purpose: click Workday Back controls from Review to My Information and record visible phone/date state.",
  ].join("\n");
}

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
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.help && !args.cdpPort) throw new Error("--cdp-port is required");
  if (!args.help && !args.out) throw new Error("--out is required");
  return args;
}

async function connectWorkday(port) {
  const targets = await httpJson(port, "/json/list");
  const target = targets.find(
    (item) =>
      item.type === "page" &&
      /albertamotorassociation|myworkdayjobs|workday/i.test(String(item.url || "")),
  );
  if (!target?.webSocketDebuggerUrl) throw new Error("Workday page not found");
  return { target, client: await new CdpClient(target.webSocketDebuggerUrl).connect() };
}

async function snapshot(client, label) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const bodyText = document.body?.innerText || "";
    const stepMatch = bodyText.match(/current\\s+step\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
    const fields = Array.from(document.querySelectorAll("input:not([type='hidden']), textarea, button, [role='combobox']"))
      .filter(visible)
      .map((el) => {
        const container = el.closest("[data-automation-id^='formField'], [role='group'], section") || el.parentElement;
        return {
          tag: el.tagName,
          id: el.id || "",
          name: el.getAttribute("name") || "",
          automationId: el.getAttribute("data-automation-id") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          text: norm([el.innerText, el.textContent, el.value].filter(Boolean).join(" ")).slice(0, 200),
          value: el.value || "",
          containerText: norm(container?.innerText || container?.textContent || "").slice(0, 500),
        };
      });
    const phoneFields = fields.filter((field) => /phone|countryphonecode|phonetype/i.test([
      field.id,
      field.name,
      field.automationId,
      field.ariaLabel,
      field.containerText,
    ].join(" ")));
    const desiredStartText = (bodyText.match(/What is your desired start date\\?[\\s\\S]{0,120}/i) || [""])[0];
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      title: document.title,
      step: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: norm(stepMatch[3]) } : null,
      hasSubmit: Array.from(document.querySelectorAll("button")).some((el) => visible(el) && /^Submit$/i.test(norm(el.innerText || el.textContent))),
      phoneFields,
      desiredStartText: norm(desiredStartText),
      bodyHead: norm(bodyText).slice(0, 1500),
    };
  })()`);
}

async function clickBack(client) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((el) => visible(el) && /^Back$/i.test(norm(el.innerText || el.textContent || el.getAttribute("aria-label"))));
    const button = buttons[buttons.length - 1];
    if (!button) return { clicked: false, reason: "back_button_not_found" };
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return { clicked: true, text: norm(button.innerText || button.textContent || button.getAttribute("aria-label")) };
  })()`);
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const { target, client } = await connectWorkday(args.cdpPort);
  const snapshots = [await snapshot(client, "start")];
  const clicks = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      const latest = snapshots[snapshots.length - 1];
      if (/My Information/i.test(latest.step?.title || "") && latest.phoneFields.length) break;
      const clicked = await clickBack(client);
      clicks.push(clicked);
      if (!clicked.clicked) break;
      await sleep(1800);
      snapshots.push(await snapshot(client, `after-back-${index + 1}`));
    }
    const payload = {
      ok: true,
      proof: "workday_back_to_my_information_probe",
      port: args.cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
      clicks,
      snapshots,
      final: snapshots[snapshots.length - 1],
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, out: args.out, finalStep: payload.final.step }, null, 2));
  } finally {
    client.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
