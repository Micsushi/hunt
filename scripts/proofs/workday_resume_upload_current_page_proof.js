#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  clickStep,
  parseCommonArgs,
  rectFor,
  runProof,
  sleep,
  trustedClick,
  visibleText,
} = require("./lib/workday_proof_common");

function usage() {
  return [
    "Usage: node scripts/proofs/workday_resume_upload_current_page_proof.js --cdp-port <port> --out <file>",
    "",
    "Purpose: prove a visible Workday Select files control can commit main.pdf and clear required Resume/CV validation.",
  ].join("\n");
}

async function setResumeFile(client, resumePath) {
  const root = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  const query = await client.send("DOM.querySelector", {
    nodeId: root.root.nodeId,
    selector: 'input[type="file"][data-automation-id="file-upload-input-ref"], input[type="file"]',
  });
  if (!query.nodeId) {
    throw new Error("No Workday file input found on current page");
  }
  await client.send("DOM.setFileInputFiles", {
    nodeId: query.nodeId,
    files: [resumePath],
  });
}

async function uploadState(client, label) {
  return client.evaluate(`(() => {
    const norm = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    };
    const bodyText = document.body?.innerText || "";
    const stepMatch = bodyText.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i);
    const errors = Array.from(document.querySelectorAll('[role="alert"], [data-automation-id*="error"], [id*="error"]'))
      .filter(visible)
      .map((el) => norm(el.innerText || el.textContent))
      .filter(Boolean)
      .filter((text) => !/successfully uploaded/i.test(text))
      .slice(0, 20);
    return {
      label: ${JSON.stringify(label)},
      href: location.href,
      step: stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: norm(stepMatch[3]) } : null,
      hasMainPdf: /main\\.pdf/i.test(bodyText),
      hasRequiredUploadError: /Upload a file \\(5MB max\\).*required|field Upload a file \\(5MB max\\) is required/i.test(bodyText),
      visibleSelectFiles: Array.from(document.querySelectorAll('button, [role="button"], label'))
        .filter(visible)
        .some((el) => /Select files/i.test(norm(el.innerText || el.textContent || el.getAttribute("aria-label")))),
      errors,
      bodyTail: norm(bodyText).slice(-1000),
    };
  })()`);
}

async function proof(client) {
  const resumePath = path.resolve(process.cwd(), "main.pdf");
  const selectFiles = await rectFor(client, visibleText("Select\\s+files"));
  await trustedClick(client, selectFiles);
  await sleep(300);
  await setResumeFile(client, resumePath);

  let afterUpload = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    afterUpload = await uploadState(client, `after-upload-${i + 1}`);
    if (afterUpload.hasMainPdf && !afterUpload.hasRequiredUploadError) {
      break;
    }
  }

  const next = await clickStep(
    client,
    "click save and continue after resume upload",
    visibleText("Save\\s+and\\s+Continue|Next"),
    2500,
  );

  return {
    behavior: "resume_upload_current_page",
    resumePath,
    selectFiles,
    afterUpload,
    next,
    afterNextState: await uploadState(client, "after-next"),
  };
}

const args = parseCommonArgs(process.argv);
if (args.help) {
  console.log(usage());
} else {
  runProof(args, "workday_resume_upload_current_page", proof).catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
