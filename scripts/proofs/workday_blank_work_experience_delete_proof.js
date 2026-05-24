#!/usr/bin/env node
"use strict";

const {
  clickStep,
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  snapshot,
  trustedClick,
  visibleText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_blank_work_experience_delete_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove whether a blank required Workday work-experience row can be removed and Save and Continue can advance.",
  ].join("\n");
}

function blankWorkExperienceDeleteFinder() {
  return `({ norm }) => {
    const blankTitleInputs = Array.from(document.querySelectorAll('input[id^="workExperience-"][id$="--jobTitle"]'))
      .filter((input) => !input.value)
      .sort((a, b) => String(b.id).localeCompare(String(a.id)));
    for (const jobTitle of blankTitleInputs) {
      const prefix = (jobTitle.id.match(/^workExperience-\\d+/) || [])[0];
      if (!prefix) continue;
      const company = document.getElementById(prefix + "--companyName");
      const dates = Array.from(document.querySelectorAll('input[id^="' + prefix + '--"][id*="dateSection"]'));
      if (company?.value || dates.some((input) => input.value)) {
        continue;
      }
      let root = jobTitle;
      for (let depth = 0; root && depth < 12; depth += 1, root = root.parentElement) {
        const samePrefixInputs = root.querySelectorAll?.('input[id^="' + prefix + '--"]') || [];
        if (samePrefixInputs.length < 4) continue;
        const otherWorkInputs = Array.from(root.querySelectorAll('input[id^="workExperience-"]'))
          .filter((input) => !String(input.id || "").startsWith(prefix + "--"));
        if (otherWorkInputs.length) continue;
        const deleteButton = Array.from(root.querySelectorAll('button, [role="button"]'))
          .find((button) => /^Delete$/i.test(norm(button.innerText || button.textContent || button.getAttribute("aria-label"))));
        if (deleteButton) return deleteButton;
      }
    }
    return null;
  }`;
}

async function optionalConfirmDelete(client) {
  await sleep(800);
  const modalDelete = await client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const buttons = Array.from(document.querySelectorAll('[role="dialog"] button, [data-automation-id="confirmDelete"] button, button'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: norm(el.innerText || el.textContent || el.getAttribute("aria-label")),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          id: el.id || "",
          automationId: el.getAttribute("data-automation-id") || "",
        };
      });
    return buttons.find((button) => /^Delete$|^OK$|^Confirm$|^Yes$/i.test(button.text)) || null;
  })()`);
  if (!modalDelete) {
    return { clicked: false, reason: "no_confirmation_visible" };
  }
  await trustedClick(client, modalDelete);
  await sleep(1000);
  return { clicked: true, target: modalDelete };
}

async function proof(client) {
  const blankDelete = await rectFor(client, blankWorkExperienceDeleteFinder());
  await trustedClick(client, blankDelete);
  const confirm = await optionalConfirmDelete(client);
  const afterDelete = await snapshot(client, "after:delete_blank_work_experience");
  const next = await clickStep(
    client,
    "click save and continue after deleting blank work experience",
    visibleText("Save\\s+and\\s+Continue|Next"),
    2000,
  );
  return {
    behavior: "delete_blank_work_experience_then_continue",
    steps: [
      { label: "delete blank work experience", clicked: blankDelete },
      { label: "confirm delete", ...confirm },
      { label: "after delete snapshot", snapshot: afterDelete },
      next,
    ],
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_blank_work_experience_delete", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
