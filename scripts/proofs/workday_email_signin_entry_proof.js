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
    "Usage: node scripts/proofs/workday_email_signin_entry_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove the visible Sign in with email entry action works on a Workday auth gate.",
  ].join("\n");
}

async function proof(client) {
  const step = await clickStep(
    client,
    "click sign in with email",
    visibleText("Sign\\s+in\\s+with\\s+email"),
    1500,
  );
  return {
    behavior: "email_signin_entry",
    steps: [step],
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_email_signin_entry", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
