#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("../lib/c3_cdp");

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
  const target = targets.find(
    (item) => item.type === "page" && /myworkdayjobs|workday/i.test(String(item.url || "")),
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
        const text = norm([el.id, el.name, el.getAttribute("aria-label"), el.innerText, el.textContent, el.value, container?.innerText, container?.textContent].filter(Boolean).join(" "));
        return {
          tag: el.tagName,
          id: el.id || "",
          name: el.getAttribute("name") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          text: norm([el.innerText, el.textContent, el.value].filter(Boolean).join(" ")).slice(0, 200),
          value: el.value || "",
          containerText: norm(container?.innerText || container?.textContent || "").slice(0, 700),
          matchesDate: /desired\\s+start\\s+date|available\\s+to\\s+start|dateSection|startdate/i.test(text),
        };
      });
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      title: document.title,
      step: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: norm(stepMatch[3]) } : null,
      hasSubmit: Array.from(document.querySelectorAll("button")).some((el) => visible(el) && /^Submit$/i.test(norm(el.innerText || el.textContent))),
      dateFields: fields.filter((field) => field.matchesDate),
      bodyHead: norm(bodyText).slice(0, 1800),
    };
  })()`);
}

async function clickSaveContinue(client) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((el) => visible(el) && /^(Save and Continue|Next|Continue)$/i.test(norm(el.innerText || el.textContent || el.getAttribute("aria-label"))));
    const button = buttons[buttons.length - 1];
    if (!button) return { clicked: false, reason: "next_button_not_found" };
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return { clicked: true, text: norm(button.innerText || button.textContent || button.getAttribute("aria-label")) };
  })()`);
}

async function run() {
  const args = parseArgs(process.argv);
  const { target, client } = await connectWorkday(args.cdpPort);
  const snapshots = [await snapshot(client, "start")];
  const clicks = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const latest = snapshots[snapshots.length - 1];
      if (/Application Questions/i.test(latest.step?.title || "") && latest.dateFields.length) break;
      if (latest.hasSubmit) break;
      const clicked = await clickSaveContinue(client);
      clicks.push(clicked);
      if (!clicked.clicked) break;
      await sleep(2200);
      snapshots.push(await snapshot(client, `after-next-${index + 1}`));
    }
    const payload = {
      ok: true,
      proof: "workday_forward_to_application_questions_probe",
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
