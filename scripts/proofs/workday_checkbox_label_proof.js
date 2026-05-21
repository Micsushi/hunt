#!/usr/bin/env node
"use strict";

const {
  checkboxByLabel,
  clickStep,
  parseCommonArgs,
  runProof,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_checkbox_label_proof.js --cdp-port <port> --label-regex <regex> --out <file>",
    "",
    "Purpose: prove a Workday checkbox or radio can be committed from its visible label.",
  ].join("\n");
}

async function proof(client, args) {
  if (!args.labelRegex) {
    throw new Error("--label-regex is required");
  }
  const step = await clickStep(
    client,
    "click checkbox or radio label",
    checkboxByLabel(args.labelRegex),
    800,
  );
  return {
    behavior: "checkbox_label_commit",
    labelRegex: args.labelRegex,
    steps: [step],
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_checkbox_label", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
