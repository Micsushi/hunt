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

async function run() {
  const args = parseArgs(process.argv);
  const targets = await httpJson(args.cdpPort, "/json/list");
  const target = targets.find(
    (item) => item.type === "page" && /chrome-extension:\/\/.*\/src\/options\/options\.html/i.test(item.url || ""),
  );
  if (!target?.webSocketDebuggerUrl) throw new Error("C3 options target not found");
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  try {
    const storage = await client.evaluate(`(async () => {
      const get = (area) => new Promise((resolve) => chrome.storage[area].get(null, resolve));
      const local = await get("local");
      const sync = await get("sync");
      return {
        localProfile: local["hunt.apply.profile"] || local.huntApplyProfile || local.profile || null,
        syncProfile: sync["hunt.apply.profile"] || sync.huntApplyProfile || sync.profile || null,
        runtimeConfig: local["hunt.apply.runtimeConfig"] || null
      };
    })()`);
    const pick = (profile) =>
      profile
        ? {
            accountEmail: profile.accountEmail,
            phone: profile.phone,
            phoneDeviceType: profile.phoneDeviceType,
            phoneCountryCode: profile.phoneCountryCode,
            desiredStartDate: profile.desiredStartDate,
            salaryExpectation: profile.salaryExpectation,
            salaryExpectationRange: profile.salaryExpectationRange,
          }
        : null;
    const payload = {
      ok: true,
      proof: "c3_extension_profile_probe",
      port: args.cdpPort,
      target: { id: target.id, title: target.title, url: target.url },
      localProfile: pick(storage.localProfile),
      syncProfile: pick(storage.syncProfile),
      runtimeConfig: storage.runtimeConfig,
    };
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, out: args.out, localProfile: payload.localProfile }, null, 2));
  } finally {
    client.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
