#!/usr/bin/env node
"use strict";

const {
  inputByField,
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  trustedClick,
  trustedSelectAllBackspace,
  trustedText,
  visibleText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_required_search_select_proof.js --cdp-port <port> --field-regex <regex> --search-text <text> --option-regex <regex> --out <file>",
    "",
    "Purpose: prove a required Workday search or prompt input commits a selected option.",
  ].join("\n");
}

async function proof(client, args) {
  if (!args.fieldRegex || !args.optionRegex) {
    throw new Error("--field-regex and --option-regex are required");
  }
  const input = await rectFor(client, inputByField(args.fieldRegex));
  await trustedClick(client, input);
  await sleep(200);
  if (args.searchText) {
    await trustedSelectAllBackspace(client);
    await trustedText(client, args.searchText);
    await sleep(700);
  }
  const option = await rectFor(client, visibleText(args.optionRegex));
  await trustedClick(client, option);
  await sleep(900);
  return {
    behavior: "required_search_select_commit",
    fieldRegex: args.fieldRegex,
    searchText: args.searchText || "",
    optionRegex: args.optionRegex,
    input,
    option,
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_required_search_select", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
