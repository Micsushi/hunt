#!/usr/bin/env node
"use strict";

const {
  inputByField,
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  trustedClick,
  visibleText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_source_select_proof.js --cdp-port <port> --option-regex <regex> --out <file>",
    "",
    "Purpose: prove the Workday Source prompt can commit a safe source option.",
    "Default option regex: Job Sites?|Job Boards?|Career Websites?|LinkedIn",
  ].join("\n");
}

async function proof(client, args) {
  const optionRegex = args.optionRegex || "Job\\s+Sites?|Job\\s+Boards?|Career\\s+Websites?|LinkedIn";
  const sourceInput = await rectFor(
    client,
    inputByField("how\\s+did\\s+you\\s+hear\\s+about\\s+us|source"),
  );
  await trustedClick(client, sourceInput);
  await sleep(900);
  const option = await rectFor(client, visibleText(optionRegex));
  await trustedClick(client, option);
  await sleep(1200);
  return {
    behavior: "source_select_commit",
    optionRegex,
    sourceInput,
    option,
  };
}

const args = parseCommonArgs(process.argv, {
  optionRegex: "Job\\s+Sites?|Job\\s+Boards?|Career\\s+Websites?|LinkedIn",
});
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_source_select", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
