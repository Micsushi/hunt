#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CdpClient, httpJson, sleep } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = { ports: [], outDir: "", waitMs: 2000 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--ports" && next) {
      args.ports = next.split(",").map((port) => Number(port.trim())).filter(Boolean);
      i += 1;
    } else if (arg === "--out-dir" && next) {
      args.outDir = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--wait-ms" && next) {
      args.waitMs = Number(next);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.ports.length) throw new Error("--ports is required");
  if (!args.outDir) throw new Error("--out-dir is required");
  return args;
}

function slugForUrl(url, port) {
  const text = String(url || "").toLowerCase();
  if (text.includes("bristolmyerssquibb")) return "bristol_myers_squibb";
  if (text.includes("amgen")) return "amgen";
  if (text.includes("thermofisher")) return "thermo_fisher";
  if (text.includes("cox_")) return "cox";
  if (text.includes("nrf")) return "nrf";
  return `port_${port}`;
}

async function collect(port, waitMs) {
  const targets = await httpJson(port, "/json/list");
  const target =
    targets.find((item) => item.type === "page" && /myworkdayjobs\.com/i.test(item.url || "")) ||
    targets.find((item) => item.type === "page");
  if (!target?.webSocketDebuggerUrl) {
    return { port, target: null, entries: [], error: "no_page_target" };
  }
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  const entries = [];
  const listener = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.method === "Log.entryAdded") {
        entries.push({ source: "Log", entry: message.params?.entry || {} });
      } else if (message.method === "Runtime.consoleAPICalled") {
        entries.push({ source: "Runtime", entry: message.params || {} });
      }
    } catch (_error) {
      entries.push({ source: "collector", entry: { text: String(event.data || "") } });
    }
  };
  client.ws.addEventListener("message", listener);
  try {
    await client.send("Log.enable");
    await client.send("Runtime.enable");
    await sleep(waitMs);
    return { port, target, entries };
  } finally {
    client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(args.outDir, { recursive: true });
  const summaries = [];
  for (const port of args.ports) {
    const result = await collect(port, args.waitMs);
    const slug = slugForUrl(result.target?.url, port);
    const outPath = path.join(args.outDir, `${slug}.console.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    summaries.push({ slug, port, count: result.entries.length, outPath });
  }
  console.log(JSON.stringify(summaries, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
