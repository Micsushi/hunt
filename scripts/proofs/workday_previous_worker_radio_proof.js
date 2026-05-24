#!/usr/bin/env node
"use strict";

const {
  parseCommonArgs,
  runProof,
  sleep,
  snapshot,
  trustedClick,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_previous_worker_radio_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove Workday candidateIsPreviousWorker radio can commit No.",
  ].join("\n");
}

async function proof(client) {
  const target = await client.evaluate(`(() => {
    const input = document.querySelector('input[name="candidateIsPreviousWorker"][value="false"]');
    if (!input) return null;
    input.scrollIntoView({ block: "center", inline: "center" });
    const rect = input.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      id: input.id || "",
      name: input.name || "",
      value: input.value || "",
      beforeChecked: Boolean(input.checked) || input.getAttribute("aria-checked") === "true",
    };
  })()`);
  if (!target) {
    throw new Error("candidateIsPreviousWorker No radio not found");
  }
  await trustedClick(client, target);
  await sleep(800);
  const afterClick = await snapshot(client, "after:click candidateIsPreviousWorker No");
  const checked = await client.evaluate(`(() => {
    const yes = document.querySelector('input[name="candidateIsPreviousWorker"][value="true"]');
    const no = document.querySelector('input[name="candidateIsPreviousWorker"][value="false"]');
    return {
      yesChecked: Boolean(yes?.checked) || yes?.getAttribute("aria-checked") === "true",
      noChecked: Boolean(no?.checked) || no?.getAttribute("aria-checked") === "true",
      yesAria: yes?.getAttribute("aria-checked") || "",
      noAria: no?.getAttribute("aria-checked") || "",
    };
  })()`);
  return {
    behavior: "candidate_previous_worker_radio_commit",
    expected: "No",
    checked,
    steps: [{ label: "click candidateIsPreviousWorker No", clicked: target, after: afterClick }],
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_previous_worker_radio", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
