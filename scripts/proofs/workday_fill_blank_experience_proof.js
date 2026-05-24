#!/usr/bin/env node
"use strict";

const {
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  snapshot,
  trustedClick,
  trustedSelectAllBackspace,
  trustedText,
} = require("./lib/workday_proof_common");

const SECOND_EXPERIENCE = {
  jobTitle: "Research Assistant",
  company: "University of Alberta",
  location: "Edmonton, Alberta, Canada",
  startMonth: "09",
  startYear: "2024",
  endMonth: "02",
  endYear: "2026",
  description:
    "Built data analysis tooling and supported research workflows with Python.",
};

function usage() {
  return [
    "Usage: node scripts/proofs/workday_fill_blank_experience_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove that a blank Workday experience repeat can be filled and committed with user-like input.",
  ].join("\n");
}

function fieldById(id) {
  return `() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (el) el.scrollIntoView({ block: "center", inline: "center" });
    return el;
  }`;
}

function saveButton() {
  return `({ norm, visible }) => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => /Save\\s+and\\s+Continue|Next/i.test(norm(el.innerText || el.textContent || el.getAttribute("aria-label"))));
    return candidates.find(visible) || candidates[0] || null;
  }`;
}

async function fillField(client, id, value) {
  const rect = await rectFor(client, fieldById(id));
  await trustedClick(client, rect);
  await trustedSelectAllBackspace(client);
  await trustedText(client, value);
  await sleep(250);
  return { id, value, rect, after: await snapshot(client, `after:${id}`) };
}

async function proof(client) {
  const steps = [];
  steps.push(await fillField(client, "workExperience-19--jobTitle", SECOND_EXPERIENCE.jobTitle));
  steps.push(await fillField(client, "workExperience-19--companyName", SECOND_EXPERIENCE.company));
  steps.push(await fillField(client, "workExperience-19--location", SECOND_EXPERIENCE.location));
  steps.push(
    await fillField(
      client,
      "workExperience-19--startDate-dateSectionMonth-input",
      SECOND_EXPERIENCE.startMonth,
    ),
  );
  steps.push(
    await fillField(
      client,
      "workExperience-19--startDate-dateSectionYear-input",
      SECOND_EXPERIENCE.startYear,
    ),
  );
  steps.push(
    await fillField(
      client,
      "workExperience-19--endDate-dateSectionMonth-input",
      SECOND_EXPERIENCE.endMonth,
    ),
  );
  steps.push(
    await fillField(
      client,
      "workExperience-19--endDate-dateSectionYear-input",
      SECOND_EXPERIENCE.endYear,
    ),
  );
  return { steps };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_fill_blank_experience", async (client) => {
    const result = await proof(client);
    const roleRect = await rectFor(client, fieldById("workExperience-19--roleDescription"));
    await trustedClick(client, roleRect);
    await trustedSelectAllBackspace(client);
    await trustedText(client, SECOND_EXPERIENCE.description);
    await sleep(500);
    const saveRect = await rectFor(client, saveButton());
    await trustedClick(client, saveRect);
    await sleep(3500);
    return {
      behavior: "fill_blank_experience_repeat_then_continue",
      steps: [
        ...result.steps.filter(Boolean),
        { id: "workExperience-19--roleDescription", value: SECOND_EXPERIENCE.description, rect: roleRect },
        { label: "click Save and Continue", rect: saveRect, after: await snapshot(client, "after:save") },
      ],
    };
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
