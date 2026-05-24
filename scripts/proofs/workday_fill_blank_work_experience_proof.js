#!/usr/bin/env node
"use strict";

const {
  clickStep,
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
    "Usage: node scripts/proofs/workday_fill_blank_work_experience_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove whether a blank required Workday work-experience row can be filled and advanced by user-like input.",
  ].join("\n");
}

async function fillInput(client, label, finder, value) {
  const rect = await rectFor(client, finder);
  await trustedClick(client, rect);
  await trustedSelectAllBackspace(client);
  await trustedText(client, value);
  await sleep(300);
  return { label, clicked: rect, value };
}

function blankWorkInput(fieldName) {
  return `({ visible }) => Array.from(document.querySelectorAll('input:not([type="hidden"])'))
    .filter(visible)
    .find((input) => /workExperience-\\d+--${fieldName}$/i.test(input.id || "") && !input.value) || null`;
}

async function proof(client) {
  const steps = [];
  steps.push(await fillInput(client, "job title", blankWorkInput("jobTitle"), "Software Developer Intern"));
  steps.push(await fillInput(client, "company", blankWorkInput("companyName"), "INVIDI Technologies"));
  steps.push(await fillInput(client, "from month", inputByField("From.*Month|startDate.*Month|dateSectionMonth"), "05"));
  steps.push(await fillInput(client, "from year", inputByField("From.*Year|startDate.*Year|dateSectionYear"), "2025"));
  steps.push(await fillInput(client, "to month", inputByField("To.*Month|endDate.*Month|dateSectionMonth"), "08"));
  steps.push(await fillInput(client, "to year", inputByField("To.*Year|endDate.*Year|dateSectionYear"), "2025"));
  const next = await clickStep(
    client,
    "click save and continue after filling blank work experience",
    visibleText("Save\\s+and\\s+Continue|Next"),
    2500,
  );
  steps.push(next);
  return {
    behavior: "fill_blank_work_experience_then_continue",
    steps,
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_fill_blank_work_experience", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
