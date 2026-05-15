#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function loadDotEnv(filePath = ".env") {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {
    provider: process.env.HUNT_C3_MAIL_PROVIDER || "imap",
    cdpPort: 9222,
    workdayUrl: process.env.HUNT_C3_TEST_WORKDAY_URL || "",
    accountEmail: process.env.HUNT_C3_TEST_ACCOUNT_EMAIL || "",
    accountPassword: process.env.HUNT_C3_TEST_ACCOUNT_PASSWORD || "",
    accountMethod: process.env.HUNT_C3_ACCOUNT_METHOD || "email",
    resumePath: path.resolve(process.cwd(), "main.pdf"),
    maxPages: 8,
    fillsPerPage: 2,
    startStep: "My Information",
    resetSiteData: false,
    closeExistingWorkdayTabs: true,
    clearBeforeFill: true,
    skipAccountBootstrap: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--provider" && next) {
      args.provider = next;
      i += 1;
    } else if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--workday-url" && next) {
      args.workdayUrl = next;
      i += 1;
    } else if (arg === "--account-email" && next) {
      args.accountEmail = next;
      i += 1;
    } else if (arg === "--account-password" && next) {
      args.accountPassword = next;
      i += 1;
    } else if (arg === "--account-method" && next) {
      args.accountMethod = next;
      i += 1;
    } else if (arg === "--resume" && next) {
      args.resumePath = path.resolve(process.cwd(), next);
      i += 1;
    } else if (arg === "--max-pages" && next) {
      args.maxPages = Number(next);
      i += 1;
    } else if (arg === "--fills-per-page" && next) {
      args.fillsPerPage = Math.max(1, Number(next) || 1);
      i += 1;
    } else if (arg === "--start-step" && next) {
      args.startStep = next;
      i += 1;
    } else if (arg === "--reset-site-data") {
      args.resetSiteData = true;
    } else if (arg === "--keep-existing-workday-tabs") {
      args.closeExistingWorkdayTabs = false;
    } else if (arg === "--no-clear-before-fill") {
      args.clearBeforeFill = false;
    } else if (arg === "--skip-account-bootstrap") {
      args.skipAccountBootstrap = true;
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
    "Usage: node scripts/c3_workday_fresh_apply_smoke.js [options]",
    "",
    "Runs account bootstrap, then fills Workday pages with C3 safe auto-next.",
    "The final application Submit button is never clicked.",
    "",
    "Options:",
    "  --provider fake|imap|gmail    Mail provider, default env or imap",
    "  --cdp-port <port>             Chrome DevTools port, default 9222",
    "  --workday-url <url>           Workday job/apply URL",
    "  --account-email <email>       Optional test account email override",
    "  --account-password <pass>     Optional test account password override",
    "  --account-method <method>     email or google, default env or email",
    "  --resume <path>               PDF resume, default main.pdf",
    "  --max-pages <n>               Page cap for application walk, default 8",
    "  --fills-per-page <n>          Fill passes per page, default 2",
    "  --start-step <name>           Workday step to click before fill, default My Information",
    "  --reset-site-data             Clear cookies/site data before bootstrap",
    "  --keep-existing-workday-tabs  Do not close old Workday tabs before bootstrap",
    "  --no-clear-before-fill        Do not clear each application page before fill",
    "  --skip-account-bootstrap      Only run application fill/auto-next",
  ].join("\n");
}

function httpJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(
              new Error(`Invalid JSON from ${requestPath}: ${error.message}`),
            );
          }
        });
      })
      .on("error", reject);
  });
}

function httpText(port, requestPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function closeExistingWorkdayTabs(args) {
  const host = new URL(args.workdayUrl).host;
  const targets = await httpJson(args.cdpPort, "/json/list");
  const closed = [];
  for (const target of targets) {
    const url = String(target.url || "");
    if (!url.includes(host) || url.startsWith("devtools://")) {
      continue;
    }
    await httpText(args.cdpPort, `/json/close/${target.id}`, "PUT").catch(
      () => "",
    );
    closed.push({
      id: target.id,
      title: target.title || "",
      url,
    });
  }
  return closed;
}

function runNode(args, label) {
  console.error(`\n[c3] ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return result.stdout || "";
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.workdayUrl) {
    throw new Error(
      "--workday-url is required, or set HUNT_C3_TEST_WORKDAY_URL in .env",
    );
  }
  if (!fs.existsSync(args.resumePath)) {
    throw new Error(`Resume not found: ${args.resumePath}`);
  }

  if (args.closeExistingWorkdayTabs) {
    try {
      const closed = await closeExistingWorkdayTabs(args);
      if (closed.length) {
        console.error(`[c3] Closed ${closed.length} existing Workday tab(s).`);
      }
    } catch (error) {
      console.error(`[c3] Could not close existing Workday tabs: ${error}`);
    }
  }

  if (!args.skipAccountBootstrap) {
    const bootstrapArgs = [
      "scripts/c3_email_verification_smoke.js",
      "--provider",
      args.provider,
      "--cdp-port",
      String(args.cdpPort),
      "--workday-url",
      args.workdayUrl,
      "--account-method",
      args.accountMethod,
    ];
    if (args.accountEmail) {
      bootstrapArgs.push("--account-email", args.accountEmail);
    }
    if (args.accountPassword) {
      bootstrapArgs.push("--account-password", args.accountPassword);
    }
    if (args.resetSiteData) {
      bootstrapArgs.push("--reset-site-data");
    }
    runNode(
      bootstrapArgs,
      args.resetSiteData
        ? "Fresh account bootstrap with site-data reset"
        : "Account bootstrap",
    );
  }

  runNode(
    [
      "scripts/c3_workday_live_smoke.js",
      "--mode",
      "manual",
      "--cdp-port",
      String(args.cdpPort),
      "--job-url",
      args.workdayUrl,
      "--resume",
      args.resumePath,
      "--max-pages",
      String(args.maxPages),
      "--fills-per-page",
      String(args.fillsPerPage),
      "--preserve-current",
      "--extension-auto-next",
      "--start-step",
      args.startStep,
      ...(args.accountEmail ? ["--account-email", args.accountEmail] : []),
      ...(args.clearBeforeFill ? ["--clear-before-fill"] : []),
    ],
    "Application fill with C3 safe auto-next",
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
