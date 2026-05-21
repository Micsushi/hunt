#!/usr/bin/env node
"use strict";

const {
  inputByField,
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  trustedClick,
  trustedText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_date_section_commit_proof.js --cdp-port <port> --month <mm> --day <dd> --year <yyyy> --out <file>",
    "",
    "Purpose: prove split Workday date section inputs commit typed month, day, and year values.",
  ].join("\n");
}

async function fillField(client, label, fieldRegex, value) {
  const rect = await rectFor(client, inputByField(fieldRegex));
  await trustedClick(client, rect);
  await sleep(100);
  await trustedText(client, value);
  await sleep(250);
  return { label, rect, value };
}

async function proof(client, args) {
  if (!args.month || !args.day || !args.year) {
    throw new Error("--month, --day, and --year are required");
  }
  const fields = [];
  fields.push(await fillField(client, "month", "dateSectionMonth|month", args.month));
  fields.push(await fillField(client, "day", "dateSectionDay|day", args.day));
  fields.push(await fillField(client, "year", "dateSectionYear|year", args.year));
  return {
    behavior: "date_section_commit",
    date: `${args.year}-${args.month}-${args.day}`,
    fields,
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_date_section_commit", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
