#!/usr/bin/env node
"use strict";

const {
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  trustedClick,
  trustedKey,
  trustedSelectAllBackspace,
  trustedText,
  visibleText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_self_identify_date_commit_probe.js --cdp-port <port> --month <mm> --day <dd> --year <yyyy> --out <file>",
    "",
    "Purpose: prove whether trusted keyboard entry into Workday Self Identify date fields clears wrapper validation.",
  ].join("\n");
}

function selfIdentifyDateInput(part) {
  return `() => document.querySelector('#selfIdentifiedDisabilityData--dateSignedOn-dateSection${part}-input')`;
}

async function refill(client, label, part, value) {
  const rect = await rectFor(client, selfIdentifyDateInput(part));
  await trustedClick(client, rect);
  await sleep(100);
  await trustedSelectAllBackspace(client);
  await sleep(100);
  await trustedText(client, value);
  await trustedKey(client, "Tab");
  await sleep(250);
  return { label, idPart: part, value, rect };
}

async function proof(client, args) {
  if (!args.month || !args.day || !args.year) {
    throw new Error("--month, --day, and --year are required");
  }
  const fields = [];
  fields.push(await refill(client, "month", "Month", args.month));
  fields.push(await refill(client, "day", "Day", args.day));
  fields.push(await refill(client, "year", "Year", args.year));

  const saveRect = await rectFor(client, visibleText("Save\\s+and\\s+Continue|Next"));
  await trustedClick(client, saveRect);
  await sleep(1500);

  return {
    behavior: "self_identify_date_commit",
    date: `${args.year}-${args.month}-${args.day}`,
    fields,
    saveRect,
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_self_identify_date_commit", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
