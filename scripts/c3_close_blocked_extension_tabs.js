#!/usr/bin/env node
"use strict";

const { httpJson, httpText } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = { port: 9222, extensionId: "cbdmkibihimaedoihjhpidclolglnncc" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--port" && next) {
      args.port = Number(next);
      i += 1;
    } else if (arg === "--extension-id" && next) {
      args.extensionId = next;
      i += 1;
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
    "Usage: node scripts/c3_close_blocked_extension_tabs.js --port <port>",
    "",
    "Closes Chromium error tabs caused by opening the extension id/root as a page.",
    "It does not close Workday pages, normal Chrome tabs, or the real Options page.",
  ].join("\n");
}

function isBlockedExtensionTab(target, extensionId) {
  if (target.type !== "page") {
    return false;
  }
  const title = String(target.title || "");
  const url = String(target.url || "");
  const blockedTitle =
    title.includes(`${extensionId} is blocked`) ||
    title.includes("ERR_BLOCKED_BY_CLIENT") ||
    /is blocked$/i.test(title);
  const extensionRoot =
    url === `chrome-extension://${extensionId}` ||
    url === `chrome-extension://${extensionId}/`;
  const chromeError = url.startsWith("chrome-error://");
  return extensionRoot || (chromeError && blockedTitle);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const targets = await httpJson(args.port, "/json/list");
  const blocked = targets.filter((target) =>
    isBlockedExtensionTab(target, args.extensionId),
  );
  for (const target of blocked) {
    await httpText(args.port, `/json/close/${target.id}`, "GET");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        port: args.port,
        closedCount: blocked.length,
        closed: blocked.map((target) => ({
          id: target.id,
          title: target.title,
          url: target.url,
        })),
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
