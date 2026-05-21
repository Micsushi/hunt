#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = { ports: [], outDir: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--ports" && next) {
      args.ports = next.split(",").map((port) => Number(port.trim())).filter(Boolean);
      i += 1;
    } else if (arg === "--out-dir" && next) {
      args.outDir = path.resolve(process.cwd(), next);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.ports.length) throw new Error("--ports is required");
  if (!args.outDir) throw new Error("--out-dir is required");
  return args;
}

function slugForTarget(target, port) {
  const text = `${target.title || ""} ${target.url || ""}`.toLowerCase();
  if (text.includes("bristolmyerssquibb")) return "bristol_myers_squibb";
  if (text.includes("amgen")) return "amgen";
  if (text.includes("thermofisher")) return "thermo_fisher";
  if (text.includes("cox_")) return "cox";
  if (text.includes("nrf") || text.includes("national retail")) return "nrf";
  return `port_${port}`;
}

async function capturePort(port, outDir) {
  const targets = await httpJson(port, "/json/list");
  const target =
    targets.find((item) => item.type === "page" && /myworkdayjobs\.com/i.test(item.url || "")) ||
    targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No page target found for port ${port}`);
  }

  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  try {
    const snapshot = await client.evaluate(`(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const normalizeSubmitText = (value) => {
        const parts = normalize(value).split(" ").filter(Boolean);
        return parts.filter((part, index) => index === 0 || part.toLowerCase() !== parts[index - 1].toLowerCase()).join(" ");
      };
      const stepNode = document.querySelector('[data-automation-id="progressBarActiveStep"]');
      const bodyText = document.body?.innerText || "";
      const stepMatch = bodyText.match(/current\\s+step\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
      const errors = Array.from(document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [id*="error"]'))
        .map((node) => normalize(node.innerText || node.textContent))
        .filter(Boolean);
      const buttons = Array.from(document.querySelectorAll('button'))
        .map((button) => normalize([button.innerText, button.textContent, button.getAttribute('aria-label')].filter(Boolean).join(' ')))
        .filter(Boolean)
        .slice(0, 80);
      const labels = Array.from(document.querySelectorAll('label, [data-automation-id="formLabel"], [data-automation-id="promptOption"], [data-automation-id="selectedItem"]'))
        .map((node) => normalize([node.innerText, node.textContent, node.getAttribute('aria-label')].filter(Boolean).join(' ')))
        .filter(Boolean)
        .slice(0, 220);
      return {
        href: location.href,
        title: document.title,
        step: stepMatch ? {
          current: Number(stepMatch[1]),
          total: Number(stepMatch[2]),
          title: normalize(stepMatch[3])
        } : {
          text: normalize(stepNode?.innerText || stepNode?.textContent || "")
        },
        hasSubmit: buttons.some((text) => /^submit$/i.test(normalizeSubmitText(text))),
        hasNext: buttons.some((text) => /^next$/i.test(text)),
        errors,
        buttons,
        labels,
        bodyText
      };
    })()`);
    const slug = slugForTarget(target, port);
    fs.writeFileSync(
      path.join(outDir, `${slug}.final_ui.json`),
      `${JSON.stringify({ port, target, snapshot }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(outDir, `${slug}.final_ui.txt`), snapshot.bodyText || "", "utf8");
    return {
      slug,
      port,
      href: snapshot.href,
      title: snapshot.title,
      step: snapshot.step,
      hasSubmit: snapshot.hasSubmit,
      hasNext: snapshot.hasNext,
      errorCount: snapshot.errors.length,
    };
  } finally {
    client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outDir, { recursive: true });
  const results = [];
  for (const port of args.ports) {
    results.push(await capturePort(port, args.outDir));
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
