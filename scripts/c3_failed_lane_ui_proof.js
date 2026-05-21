#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCENARIOS = {
  "bms-veteran": {
    script: "workday_disclosure_dropdown_proof.js",
    args: ["--question-regex", "What is your veteran status", "--option-regex", "I DON'?T WISH TO ANSWER"],
  },
  "amgen-disclosures": {
    script: "workday_disclosure_dropdown_proof.js",
    args: ["--question-regex", "ethnicity which most accurately", "--option-regex", "Not Specified"],
  },
  "amgen-ethnicity-keyboard": {
    script: "workday_disclosure_dropdown_proof.js",
    args: ["--question-regex", "ethnicity which most accurately", "--option-regex", "Not Specified"],
  },
  "thermo-citizenship": {
    script: "workday_checkbox_label_proof.js",
    args: ["--label-regex", "None of these"],
  },
  "thermo-degree": {
    script: "workday_disclosure_dropdown_proof.js",
    args: ["--question-regex", "Degree", "--option-regex", "Bachelor\\s*/\\s*Undergraduate"],
  },
  "thermo-gender": {
    script: "workday_disclosure_dropdown_proof.js",
    args: ["--question-regex", "Gender", "--option-regex", "Undisclosed\\s*\\(United States of America\\)"],
  },
  "nrf-email-signin": {
    script: "workday_email_signin_entry_proof.js",
    args: [],
  },
  "phone-country": {
    script: "workday_phone_country_commit_proof.js",
    args: [],
  },
  "source-select": {
    script: "workday_source_select_proof.js",
    args: [],
  },
};

function parseArgs(argv) {
  const args = { cdpPort: 0, out: "", scenario: "", target: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cdp-port" && next) {
      args.cdpPort = Number(next);
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = next;
      i += 1;
    } else if (arg === "--scenario" && next) {
      args.scenario = next;
      i += 1;
    } else if (arg === "--target" && next) {
      args.target = next;
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
    "Usage: node scripts/c3_failed_lane_ui_proof.js --cdp-port <port> --scenario <name> --out <file>",
    "",
    "Compatibility dispatcher for old scenario names. Prefer the narrow scripts in scripts/proofs.",
    "",
    "Scenarios:",
    ...Object.keys(SCENARIOS).map((name) => `  ${name}`),
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.cdpPort) throw new Error("--cdp-port is required");
  if (!args.out) throw new Error("--out is required");
  if (!args.scenario) throw new Error("--scenario is required");
  const scenario = SCENARIOS[args.scenario];
  if (!scenario) {
    throw new Error(`Unknown scenario: ${args.scenario}. Run --help for names.`);
  }
  const script = path.join(__dirname, "proofs", scenario.script);
  const forwarded = [
    script,
    "--cdp-port",
    String(args.cdpPort),
    "--out",
    args.out,
    ...scenario.args,
  ];
  if (args.target) {
    forwarded.push("--target", args.target);
  }
  const result = spawnSync(process.execPath, forwarded, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  process.exit(result.status || 0);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
