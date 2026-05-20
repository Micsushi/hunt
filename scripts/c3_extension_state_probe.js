#!/usr/bin/env node
"use strict";

const { CdpClient, httpJson } = require("./lib/c3_cdp");

function parseArgs(argv) {
  const args = { cdpPort: 9222 };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
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
    "Usage: node scripts/c3_extension_state_probe.js [--cdp-port 9222]",
    "",
    "Reads Hunt Apply extension settings, active fill progress, and recent activity log from p Chrome.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const targets = await httpJson(args.cdpPort, "/json/list");
  const optionsTarget = targets.find(
    (target) =>
      target.type === "page" &&
      String(target.url || "").includes("/src/options/options.html"),
  );
  if (!optionsTarget) {
    throw new Error("Hunt Apply options target not found.");
  }
  const client = await new CdpClient(optionsTarget.webSocketDebuggerUrl).connect();
  try {
    const state = await client.evaluate(
      `(
        async () => {
          const state = await chrome.runtime.sendMessage({
            type: "hunt.apply.get_state",
          });
          const tabs = await chrome.tabs.query({});
          const active = [];
          for (const tab of tabs) {
            const progress = await chrome.runtime
              .sendMessage({
                type: "hunt.apply.get_active_fill_progress",
                payload: { tabId: tab.id },
              })
              .catch((error) => ({ error: String(error) }));
            if (progress && progress.active) {
              active.push({
                tabId: tab.id,
                url: tab.url,
                title: tab.title,
                progress,
              });
            }
          }
          return {
            active,
            settings: {
              autoClickNextAfterFill: state.settings?.autoClickNextAfterFill,
              debugLogSinkEnabled: state.settings?.debugLogSinkEnabled,
              backendUrl: state.settings?.backendUrl,
              useFieldPipelineV2: state.settings?.useFieldPipelineV2,
            },
            activityLog: (state.activityLog || []).slice(-40),
          };
        }
      )()`,
      30000,
    );
    console.log(JSON.stringify(state, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
