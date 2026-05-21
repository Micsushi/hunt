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
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_name_input_commit_proof.js --cdp-port <port> --first-name <name> --last-name <name> --out <file>",
    "",
    "Purpose: prove Workday legal name inputs commit text as real user-like input.",
  ].join("\n");
}

async function fillInput(client, label, fieldRegex, value) {
  const rect = await rectFor(client, inputByField(fieldRegex));
  await trustedClick(client, rect);
  await sleep(100);
  await trustedSelectAllBackspace(client);
  await trustedText(client, value);
  await sleep(350);
  return { label, rect, value };
}

async function proof(client, args) {
  if (!args.firstName || !args.lastName) {
    throw new Error("--first-name and --last-name are required");
  }
  const fields = [];
  fields.push(await fillInput(client, "first name", "first\\s*name|legalName.*first", args.firstName));
  fields.push(await fillInput(client, "last name", "last\\s*name|legalName.*last", args.lastName));
  return {
    behavior: "name_input_commit",
    fields,
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_name_input_commit", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
