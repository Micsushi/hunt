#!/usr/bin/env node
"use strict";

const {
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
    "Usage: node scripts/proofs/workday_phone_country_commit_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove the Workday phone country code prompt commits Canada (+1) into backing UI state.",
  ].join("\n");
}

async function inspectPhoneState(client, label) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const input = document.getElementById("phoneNumber--countryPhoneCode")
      || Array.from(document.querySelectorAll("input, [role='combobox']")).find((el) => /country\\s*phone\\s*code|countryphonecode/i.test([el.id, el.name, el.getAttribute("aria-label")].filter(Boolean).join(" ")));
    const container = input?.closest?.("[data-automation-id^='formField'], [data-uxi-widget-type='multiselect'], [role='group']") || input?.parentElement || null;
    const selected = Array.from(container?.querySelectorAll?.("[data-automation-id='selectedItem'], [data-automation-id='promptSelectionLabel'], [aria-label*='press delete']") || [])
      .map((el) => norm([el.innerText, el.textContent, el.getAttribute("aria-label")].filter(Boolean).join(" ")))
      .filter(Boolean);
    return {
      label: ${JSON.stringify(label)},
      inputValue: input?.value || "",
      ariaLabel: input?.getAttribute("aria-label") || "",
      selected,
      containerText: norm(container?.innerText || container?.textContent || "").slice(0, 500),
      committed: /canada|\\+1/i.test([input?.value, input?.getAttribute("aria-label"), selected.join(" "), container?.innerText].filter(Boolean).join(" "))
    };
  })()`);
}

async function proof(client) {
  const beforePhone = await inspectPhoneState(client, "before-phone");
  const input = await rectFor(
    client,
    inputByField("country\\s*phone\\s*code|countryphonecode"),
  );
  await trustedClick(client, input);
  await sleep(200);
  await trustedSelectAllBackspace(client);
  await trustedText(client, "Canada");
  await sleep(800);
  const option = await rectFor(client, visibleText("Canada\\s*\\(\\+1\\)|Canada.*\\+1"));
  await trustedClick(client, option);
  await sleep(1000);
  const afterPhone = await inspectPhoneState(client, "after-phone");
  return {
    behavior: "phone_country_commit",
    country: "Canada (+1)",
    input,
    option,
    beforePhone,
    afterPhone,
    committed: Boolean(afterPhone.committed),
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_phone_country_commit", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
