import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { createPlaywrightWorkdayResumePage } from
  "../../../src/ats/workday/application/resume/playwright-page.ts";
import { createWorkdayResumeFileIntent } from
  "../../../src/ats/workday/application/resume/intent.ts";
import { createWorkdayResumeUploadDriver } from
  "../../../src/ats/workday/application/resume/upload.ts";
import {
  captureResumeArtifact,
  disposeResumeArtifact,
  upstreamResumeId,
} from "../../../src/contracts/index.ts";
import {
  createRetainedFixtureControlCapture,
  type RetainedFixtureControlEvidenceV1,
} from "../../../src/testing/evidence/retained-fixture-control-learning.ts";
import {
  assertNonSubmittable,
  retained,
  retainedMetadata,
} from "./integer-retained-fixture-support.ts";

const fixture = readFileSync(new URL("./fixtures/integer-resume.html", import.meta.url), "utf8");

test("exact Integer Resume fixture proves five distinct non-submittable control operations", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const artifactBytes = Buffer.from("%PDF-1.7\nsynthetic fixture resume\n%%EOF\n");
  const captured = captureResumeArtifact({
    resumeId: upstreamResumeId("resume-integer-fixture"),
    sha256: createHash("sha256").update(artifactBytes).digest("hex"),
  }, artifactBytes);
  if (!captured.ok) throw new Error("resume fixture capture denied");
  const evidenceRoot = mkdtempSync(join(tmpdir(), "integer-resume-controls-"));
  try {
    await page.setContent(fixture);
    const guide = new Map(retained("resume").map((entry) => [entry.identity, entry]));
    const capture = createRetainedFixtureControlCapture({
      root: evidenceRoot,
      page: "resume",
      sensitiveValues: ["resume-private-sentinel"],
    });
    let operation = 0;
    const attempt = async (
      identity: "experience" | "education" | "skills" | "resume" | "websites",
      interaction: string,
      allowedOptions: readonly string[] | "explicit_unknown",
      readbackKind: "row_added" | "option_selected" | "file_verified",
      mutate: () => Promise<void>,
      readback: () => Promise<string>,
    ) => {
      const metadata = guide.get(identity);
      assert.ok(metadata !== undefined);
      operation += 1;
      const operationId = `operation_fixture_resume_${identity}_${operation}`;
      const controlId = `retained-resume-${identity}`;
      capture.recordAttempt({
        metadata: retainedMetadata(
          metadata,
          controlId,
          allowedOptions === "explicit_unknown" ? null : allowedOptions,
        ),
        operationId,
        attempt: operation,
        interaction,
      });
      capture.monitorAck({ controlId, operationId, attempt: operation, moment: "before_mutation" });
      await mutate();
      assert.notEqual(await readback(), "");
      capture.monitorAck({ controlId, operationId, attempt: operation, moment: "after_readback" });
      assert.equal(await page.locator(
        '[aria-invalid="true"], [role="alert"], [data-automation-id*="error" i]',
      ).count(), 0);
      await assertNonSubmittable(page);
      capture.recordVerified({ controlId, operationId, readback: readbackKind });
    };

    await attempt("experience", "click Work Experience Add", "explicit_unknown", "row_added",
      async () => page.locator("#work-experience-add").click(),
      async () => String(await page.locator('[data-synthetic-row="experience"]').count()));
    await attempt("education", "click Education Add", "explicit_unknown", "row_added",
      async () => page.locator("#education-add").click(),
      async () => String(await page.locator('[data-synthetic-row="education"]').count()));
    await attempt(
      "skills",
      "search and select one exact skill",
      "explicit_unknown",
      "option_selected",
      async () => {
        await page.locator("#skills-search").fill("Systems");
        await page.getByRole("option", { name: "Systems Integration" }).click();
      },
      async () => {
        const selected = await page.locator("#skills-search").getAttribute("data-selected-value");
        assert.equal(selected, await page.locator("#skills-readback").textContent());
        return selected ?? "";
      },
    );
    const intent = createWorkdayResumeFileIntent({
      artifactId: captured.value.resumeId,
      artifact: captured.value,
      fileType: "pdf",
    });
    if (!intent.ok) throw new Error("resume fixture intent denied");
    const upload = createWorkdayResumeUploadDriver(createPlaywrightWorkdayResumePage(page), {
      timeoutMs: 2_000,
    });
    await attempt("resume", "set exact synthetic PDF input", "explicit_unknown", "file_verified",
      async () => {
        const driven = await upload.upload(intent.value, false, new AbortController().signal);
        assert.equal(driven.ok, true);
      }, async () => {
        const readback = await page.locator("#resume-upload").evaluate(async (element) => {
          if (!(element instanceof HTMLInputElement) || element.files?.length !== 1) return null;
          const file = element.files[0]!;
          return {
            name: file.name,
            size: file.size,
            type: file.type,
            bytes: [...new Uint8Array(await file.arrayBuffer())],
          };
        });
        assert.ok(readback !== null);
        assert.equal(readback.size, intent.value.sizeBytes);
        assert.equal(readback.type, "application/pdf");
        assert.equal(
          createHash("sha256").update(Uint8Array.from(readback.bytes)).digest("hex"),
          intent.value.artifact.sha256,
        );
        assert.equal(await page.locator(
          '[data-automation-id="file-upload-item"][data-upload-state="success"]',
        ).count(), 1);
        return JSON.stringify({ name: readback.name, size: readback.size, type: readback.type });
      });
    await attempt("websites", "click Websites Add", "explicit_unknown", "row_added",
      async () => page.locator("#websites-add").click(),
      async () => String(await page.locator('[data-synthetic-row="website"]').count()));

    const sha256 = capture.write({ submitPresent: false, submitActivated: false });
    assert.match(sha256, /^[a-f0-9]{64}$/u);
    const evidence = JSON.parse(readFileSync(
      join(evidenceRoot, "retained-fixture-control-learning.json"),
      "utf8",
    )) as RetainedFixtureControlEvidenceV1;
    assert.equal(evidence.controls.length, 5);
    assert.equal(new Set(evidence.controls.map(({ controlId }) => controlId)).size, 5);
    const operationIds = evidence.controls.map(({ monitorBinding }) => {
      assert.ok(monitorBinding !== null);
      return monitorBinding.operationId;
    });
    assert.equal(new Set(operationIds).size, 5);
    assert.equal(evidence.controls.every(({ lane }) => lane === "synthetic_test_default"), true);
    assert.equal(evidence.controls.every(({ validation }) => validation === "pass"), true);
    assert.equal(evidence.controls.every(({ terminalDisposition }) =>
      terminalDisposition === "verified"
    ), true);
    assert.equal(evidence.privacyScan, "pass");
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.equal(evidence.reviewExpectationEligible, false);
    assert.equal(evidence.reviewCompletionEligible, false);
    assert.equal(evidence.submitPresent, false);
    assert.equal(evidence.submitActivated, false);
    assert.doesNotMatch(JSON.stringify(evidence), /resume-private-sentinel/u);
    assert.equal(guide.get("resume")?.constraints.maxBytes, 5 * 1024 * 1024);
    assert.equal(await page.locator('[data-hunt-review-field-id]').count(), 0);
  } finally {
    disposeResumeArtifact(captured.value);
    rmSync(evidenceRoot, { recursive: true, force: true });
    await browser.close();
  }
});

test("retained fixture evidence rejects missing, crossed, duplicate, and unsafe bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "integer-fixture-evidence-hostile-"));
  const unsafeRoot = mkdtempSync(join(tmpdir(), "integer-fixture-evidence-privacy-"));
  try {
    const experience = retained("resume").find(({ identity }) => identity === "experience");
    const education = retained("resume").find(({ identity }) => identity === "education");
    assert.ok(experience !== undefined && education !== undefined);
    const baseMetadata = retainedMetadata(experience, "retained-resume-metadata", null);
    const metadataCapture = createRetainedFixtureControlCapture({ root, page: "resume" });
    const rejectMetadata = (
      suffix: string,
      metadata: typeof baseMetadata,
    ) => assert.throws(() => metadataCapture.recordAttempt({
      metadata,
      operationId: `operation_fixture_metadata_${suffix}`,
      attempt: 1,
      interaction: "hostile metadata probe",
    }), /retained fixture control evidence denied/u);
    rejectMetadata("question_type", { ...baseMetadata, questionType: "education" });
    rejectMetadata("ui_type", { ...baseMetadata, uiType: "text" });
    rejectMetadata("answer_type", { ...baseMetadata, answerType: "text" });
    rejectMetadata("variant", { ...baseMetadata, uiVariant: "workday_text_v1" });
    rejectMetadata("required", { ...baseMetadata, required: true });
    rejectMetadata("label", { ...baseMetadata, label: "Invented label" });
    rejectMetadata("identity", { ...baseMetadata, identity: "education" });
    rejectMetadata("options", { ...baseMetadata, allowedOptions: ["Invented option"] });

    const terms = retained("voluntary_disclosures").find(({ identity }) =>
      identity === "terms_consent"
    );
    assert.ok(terms !== undefined);
    const termsMetadata = retainedMetadata(
      terms,
      "retained-voluntary-terms-hostile",
      terms.allowedOptions,
    );
    const optionCapture = createRetainedFixtureControlCapture({
      root,
      page: "voluntary_disclosures",
    });
    assert.throws(() => optionCapture.recordAttempt({
      metadata: { ...termsMetadata, allowedOptions: ["Yes", "No", "No"] },
      operationId: "operation_fixture_duplicate_options",
      attempt: 1,
      interaction: "hostile duplicate option probe",
    }), /retained fixture control evidence denied/u);
    assert.throws(() => optionCapture.recordAttempt({
      metadata: { ...termsMetadata, allowedOptions: ["No", "Yes"] },
      operationId: "operation_fixture_wrong_options",
      attempt: 1,
      interaction: "hostile wrong option probe",
    }), /retained fixture control evidence denied/u);

    const capture = createRetainedFixtureControlCapture({ root, page: "resume" });
    const operationId = "operation_fixture_hostile_01";
    const metadata = retainedMetadata(experience, "retained-resume-experience", null);
    capture.recordAttempt({
      metadata, operationId, attempt: 1, interaction: "click Work Experience Add",
    });
    assert.throws(() => capture.recordVerified({
      controlId: metadata.controlId, operationId, readback: "row_added",
    }), /retained fixture control evidence denied/u);
    assert.throws(() => capture.monitorAck({
      controlId: metadata.controlId,
      operationId: "operation_fixture_crossed_02",
      attempt: 1,
      moment: "before_mutation",
    }), /retained fixture control evidence denied/u);
    assert.throws(() => capture.recordAttempt({
      metadata: retainedMetadata(education, "retained-resume-education", null),
      operationId,
      attempt: 2,
      interaction: "click Education Add",
    }), /retained fixture control evidence denied/u);
    capture.monitorAck({
      controlId: metadata.controlId, operationId, attempt: 1, moment: "before_mutation",
    });
    capture.monitorAck({
      controlId: metadata.controlId, operationId, attempt: 1, moment: "after_readback",
    });
    capture.recordVerified({ controlId: metadata.controlId, operationId, readback: "row_added" });
    assert.match(capture.write({ submitPresent: false, submitActivated: false }), /^[a-f0-9]{64}$/u);

    const unsafe = createRetainedFixtureControlCapture({
      root: unsafeRoot,
      page: "resume",
      sensitiveValues: ["private-fixture-value"],
    });
    const unsafeOperation = "operation_fixture_unsafe_01";
    unsafe.recordAttempt({
      metadata, operationId: unsafeOperation, attempt: 1, interaction: "private-fixture-value",
    });
    unsafe.monitorAck({
      controlId: metadata.controlId,
      operationId: unsafeOperation,
      attempt: 1,
      moment: "before_mutation",
    });
    unsafe.monitorAck({
      controlId: metadata.controlId,
      operationId: unsafeOperation,
      attempt: 1,
      moment: "after_readback",
    });
    unsafe.recordVerified({
      controlId: metadata.controlId, operationId: unsafeOperation, readback: "row_added",
    });
    assert.throws(
      () => unsafe.write({ submitPresent: false, submitActivated: false }),
      /evidence denied.*sensitive/u,
    );
    assert.equal(existsSync(join(unsafeRoot, "retained-fixture-control-learning.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(unsafeRoot, { recursive: true, force: true });
  }
});
