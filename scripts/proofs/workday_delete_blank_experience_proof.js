#!/usr/bin/env node
"use strict";

const {
  clickStep,
  parseCommonArgs,
  runProof,
  sleep,
  visibleText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_delete_blank_experience_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove that a blank Workday experience repeat can be removed with the visible Delete button, clearing required validation.",
  ].join("\n");
}

async function proof(client) {
  const deleteStep = await clickStep(
    client,
    "click visible Work Experience 2 Delete",
    `({ norm }) => {
      const heading = Array.from(document.querySelectorAll('div, span, h2, h3, p'))
        .find((el) => /Work\\s+Experience\\s+2/i.test(norm(el.innerText || el.textContent)));
      if (!heading) return null;
      let root = heading;
      for (let i = 0; root && i < 8; i += 1, root = root.parentElement) {
        const buttons = Array.from(root.querySelectorAll('button, [role="button"]'));
        const button = buttons.find((el) => /^Delete$/i.test(norm(el.innerText || el.textContent || el.getAttribute("aria-label"))));
        if (button) return button;
      }
      return null;
    }`,
    1200,
  );

  const saveStep = await clickStep(
    client,
    "click Save and Continue after deleting blank repeat",
    visibleText("Save\\s+and\\s+Continue|Next"),
    2500,
  );
  await sleep(1000);

  return {
    behavior: "delete_blank_experience_repeat_then_continue",
    steps: [deleteStep, saveStep],
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_delete_blank_experience", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
