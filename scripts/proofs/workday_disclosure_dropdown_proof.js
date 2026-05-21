#!/usr/bin/env node
"use strict";

const {
  buttonByQuestion,
  clickStep,
  parseCommonArgs,
  runProof,
  visibleText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_disclosure_dropdown_proof.js --cdp-port <port> --question-regex <regex> --option-regex <regex> --out <file>",
    "",
    "Purpose: prove a Workday disclosure dropdown opens and commits one visible option.",
  ].join("\n");
}

async function proof(client, args) {
  if (!args.questionRegex || !args.optionRegex) {
    throw new Error("--question-regex and --option-regex are required");
  }
  const steps = [];
  steps.push(
    await clickStep(
      client,
      "open disclosure dropdown",
      buttonByQuestion(args.questionRegex),
      900,
    ),
  );
  steps.push(
    await clickStep(
      client,
      "choose disclosure option",
      visibleText(args.optionRegex),
      900,
    ),
  );
  return {
    behavior: "disclosure_dropdown_commit",
    questionRegex: args.questionRegex,
    optionRegex: args.optionRegex,
    steps,
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_disclosure_dropdown", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
