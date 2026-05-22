#!/usr/bin/env node
"use strict";

const {
  clickStep,
  parseCommonArgs,
  runProof,
  sleep,
} = require("./lib/workday_proof_common");
const { httpJson } = require("../lib/c3_cdp");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_assessment_button_probe.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove where a Workday Take Assessment button sends the applicant.",
  ].join("\n");
}

async function proof(client, args) {
  const step = await clickStep(
    client,
    "click take assessment",
    `({ norm }) => {
      const button = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .find((el) => /Take\\s+Assessment/i.test(norm([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" "))));
      if (button) button.scrollIntoView({ block: "center", inline: "center" });
      return button || null;
    }`,
    5000,
  );
  await sleep(3000);
  const targets = await httpJson(args.cdpPort, "/json/list");
  return {
    behavior: "workday_assessment_entry",
    steps: [step],
    targets: targets
      .filter((item) => item.type === "page")
      .map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
      })),
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_assessment_button", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
