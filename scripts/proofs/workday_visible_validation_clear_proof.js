#!/usr/bin/env node
"use strict";

const {
  clickStep,
  parseCommonArgs,
  runProof,
  visibleText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_visible_validation_clear_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove whether visible validation remains after a user-like Save and Continue or Next click.",
  ].join("\n");
}

async function proof(client) {
  const step = await clickStep(
    client,
    "click safe next or save and continue",
    visibleText("Save\\s+and\\s+Continue|Next"),
    1500,
  );
  return {
    behavior: "visible_validation_after_next",
    steps: [step],
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_visible_validation_clear", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
