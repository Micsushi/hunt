import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { runApplicationPageWalk } from
  "../../../src/ats/workday/application/page-walk.ts";
import { PlaywrightWorkdayApplicationPage } from
  "../../../src/ats/workday/application/playwright-page.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import {
  bindQuestionnaireTargets,
  monitorQuestionnaireCoverage,
} from
  "../../../src/browser/playwright-live/private/workday-application-runtime.ts";
import {
  browserPageId,
  createGeneratedIdAllocator,
  fieldId,
  generatedOperationId,
  guardRevision,
  journeyId,
  type BrowserSessionId,
  type FieldIntent,
} from "../../../src/contracts/index.ts";
import { createFieldDriver } from "../../../src/interaction/drivers/registry.ts";
import { createFieldVerifier } from
  "../../../src/interaction/verification/field-verifier.ts";
import { createSafetyGuard } from "../../../src/safety/guards.ts";
import { createPageLocalInspection } from
  "../../../src/live/evidence/page-local-inspection.ts";

test("retained Integer formatted dates agree across every completion observer", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const evidenceRoot = mkdtempSync(join(tmpdir(), "integer-date-inspection-"));
  try {
    await page.setContent(`<!doctype html>
      <html data-hunt-page-id="page-integer-formatted-dates" data-hunt-submit-activated="false">
        <body>
          <main data-automation-id="applyFlowApplicationQuestionsPage">
            <div data-automation-id="formField-available-start">
              <label id="available-start-label">
                When are you available to start?<span data-automation-id="required">*</span>
              </label>
              <div role="group" aria-labelledby="available-start-label"
                data-automation-id="dateInputWrapper">
                <input type="text" placeholder="MM/DD/YYYY" aria-required="true">
              </div>
            </div>
            <div data-automation-id="formField-final-niv">
              <label id="final-niv-label">
                What is your final NIV date?<span data-automation-id="required">*</span>
              </label>
              <div role="group" aria-labelledby="final-niv-label"
                data-automation-id="dateInputWrapper">
                <input type="tel" placeholder="MM/DD/YYYY" aria-required="true">
              </div>
            </div>
          </main>
        </body>
      </html>`);
    const inspection = createPageLocalInspection(evidenceRoot);
    await inspection.prepare(page);

    const pageId = browserPageId("page-integer-formatted-dates");
    const sessionId = "browser_session_integer_formatted_dates_01" as BrowserSessionId;
    await bindQuestionnaireTargets(page, pageId);
    let generatedId = 0;
    const semantic = new PlaywrightBrowserSession({
      attached: { page, pageId, sessionId },
      ids: createGeneratedIdAllocator({
        next: () => `integer-formatted-date-${++generatedId}`,
      }),
      timeoutMs: 2_000,
    });
    const signal = new AbortController().signal;
    const discovered = await semantic.observe({ sessionId, pageId }, signal);
    assert.equal(discovered.ok, true, JSON.stringify(discovered));
    if (!discovered.ok) throw new Error("semantic date observation failed");
    assert.deepEqual(
      discovered.value.targets.map(({ name, control, required }) => ({
        name,
        kind: control.kind,
        required,
      })),
      [
        { name: "When are you available to start?*", kind: "date", required: true },
        { name: "What is your final NIV date?*", kind: "date", required: true },
      ],
    );

    const driver = createFieldDriver(semantic, createSafetyGuard());
    const verifier = createFieldVerifier(semantic);
    for (const [index, target] of discovered.value.targets.entries()) {
      const intent: FieldIntent = {
        kind: "date",
        behavior: "date",
        fieldId: fieldId(`integer-date-${index + 1}`),
        target: target.token,
        isoDate: "2026-08-25",
        provenance: "owner_provided",
      };
      const request = {
        journeyId: journeyId("journey_integer_formatted_dates"),
        sessionId,
        pageId,
        guardRevision: guardRevision("guard-integer-formatted-dates"),
        operationId: generatedOperationId(
          `operation_integer_formatted_date_${String(index + 1).padStart(2, "0")}`,
        ),
        intent,
      } as const;
      const driven = await driver.drive(request, signal);
      assert.equal(driven.ok, true, JSON.stringify({ driven, request }));
      if (!driven.ok) throw new Error("semantic date mutation failed");
      const verified = await verifier.verify({
        sessionId,
        pageId,
        intent,
        receipt: driven.value,
      }, signal);
      assert.deepEqual(verified, {
        ok: true,
        value: { kind: "verified", fieldId: intent.fieldId },
      });
    }

    const monitor = await monitorQuestionnaireCoverage(page);
    assert.deepEqual(monitor, {
      fieldCount: 2,
      requiredFieldCount: 2,
      typeCounts: { date: 2 },
    });

    const application = new PlaywrightWorkdayApplicationPage(page);
    const snapshot = await application.observe(signal);
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.deepEqual(snapshot.ok && snapshot.value.requiredFields.map((field) => ({
      fieldId: field.fieldId,
      verification: field.verification,
    })), [
      { fieldId: "dateInputWrapper", verification: "verified" },
      { fieldId: "dateInputWrapper", verification: "verified" },
    ]);

    const walked = await runApplicationPageWalk({
      observer: application,
      handlers: {
        questionnaire: {
          async reconcile(request) {
            return {
              ok: true,
              value: {
                page: "questionnaire",
                pageId: request.pageId,
                checkpoint: "questionnaire_verified",
                independentlyVerified: true,
              },
            };
          },
        },
        profile: {
          async reconcile() {
            throw new Error("unexpected profile lane");
          },
        },
        resume: {
          async reconcile() {
            throw new Error("unexpected resume lane");
          },
        },
      },
      navigation: {
        async next() {
          throw new Error("unexpected navigation");
        },
      },
      progress: {
        async record() {
          return { ok: true, value: undefined };
        },
      },
    }, {
      journeyId: journeyId("journey_integer_formatted_dates"),
      stopAfter: "questionnaire_verified",
    }, signal);
    assert.equal(walked.ok, true, JSON.stringify(walked));
    assert.equal(walked.ok && walked.value.completedPages, 1);
    assert.deepEqual(walked.ok && walked.value.pageChecks, [{
      page: "questionnaire",
      checkpoint: "questionnaire_verified",
      independentlyVerified: true,
      requiredFields: 2,
      verifiedFields: 2,
      duplicateRows: 0,
    }]);
    await inspection.capture(page);
    const inspectionText = readFileSync(
      join(evidenceRoot, "page-local-inspection.json"),
      "utf8",
    );
    const inspectionEvidence = JSON.parse(inspectionText) as {
      readonly evidenceRevision?: string;
      readonly dateControls?: readonly unknown[];
      readonly ariaSnapshots?: readonly unknown[];
      readonly mutations?: readonly unknown[];
      readonly consoleTypes?: readonly unknown[];
      readonly pageErrorNames?: readonly unknown[];
      readonly requestFailures?: readonly unknown[];
    };
    assert.equal(inspectionEvidence.evidenceRevision, "s2-page-local-inspection-v1");
    assert.equal(inspectionEvidence.dateControls?.length, 2);
    assert.equal(inspectionEvidence.ariaSnapshots?.length, 2);
    assert.ok(Array.isArray(inspectionEvidence.mutations));
    assert.ok(Array.isArray(inspectionEvidence.consoleTypes));
    assert.ok(Array.isArray(inspectionEvidence.pageErrorNames));
    assert.ok(Array.isArray(inspectionEvidence.requestFailures));
    assert.equal(existsSync(join(evidenceRoot, "monitor-visible.png")), true);
  } finally {
    await browser.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
