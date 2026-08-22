import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import { bindQuestionnaireTargets } from
  "../../../src/browser/playwright-live/private/workday-application-runtime.ts";
import {
  browserPageId,
  createGeneratedIdAllocator,
  generatedOperationId,
  guardRevision,
  journeyId,
  type BrowserSessionId,
  type FieldIntent,
  type FieldObservation,
} from "../../../src/contracts/index.ts";
import { discoverFields } from "../../../src/form/discovery/discover-fields.ts";
import { retainedIntakeControlGuide } from "../../../src/form/questions/catalog.ts";
import { normalizeCatalogText } from "../../../src/form/questions/normalize.ts";
import { createSemanticSnapshot } from "../../../src/form/semantic-snapshot.ts";
import { createFieldDriver } from "../../../src/interaction/drivers/registry.ts";
import { createFieldVerifier } from
  "../../../src/interaction/verification/field-verifier.ts";
import {
  createRetainedFixtureControlCapture,
  type RetainedFixtureControlEvidenceV1,
  type RetainedFixtureControlMetadata,
} from "../../../src/testing/evidence/retained-fixture-control-learning.ts";
import { createSafetyGuard } from "../../../src/safety/guards.ts";

const syntheticAnswers = new Map<string, string | boolean>([
  ["Select Veteran Status", "I do not want to answer"],
  ["Yes, I have read and consent to the terms and conditions", true],
  ["Language", "English"],
  ["Name", "Fixture Candidate"],
  ["Date", "2026-08-22"],
  ["Please check one of the boxes below", "I do not want to answer"],
]);

export async function runQuestionnaireFixture(html: string, fixtureId: string) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const evidenceRoot = mkdtempSync(join(tmpdir(), `${fixtureId}-`));
  try {
    await page.setContent(html);
    const pageId = browserPageId(fixtureId);
    await bindQuestionnaireTargets(page, pageId);
    const sessionId = `browser_session_${fixtureId.replaceAll("-", "_")}_fixture_01` as BrowserSessionId;
    let generatedId = 0;
    const semantic = new PlaywrightBrowserSession({
      attached: { page, sessionId, pageId },
      ids: createGeneratedIdAllocator({ next: () => `${fixtureId}-${++generatedId}` }),
      timeoutMs: 2_000,
    });
    const observed = await semantic.observe({ sessionId, pageId }, new AbortController().signal);
    if (!observed.ok) throw new Error(`fixture observation denied: ${observed.error.code}`);
    const snapshot = createSemanticSnapshot(
      { kind: "workday", page: "questionnaire" },
      discoverFields(observed.value.targets),
    );
    const fixturePage = fixtureId === "integer-shape-b"
      ? "voluntary_disclosures" as const
      : "self_identify" as const;
    const guide = retained(fixturePage);
    const capture = createRetainedFixtureControlCapture({
      root: evidenceRoot,
      page: fixturePage,
      sensitiveValues: ["fixture-secret-sentinel"],
    });
    const semanticDriver = createFieldDriver(semantic, createSafetyGuard());
    const semanticVerifier = createFieldVerifier(semantic);
    let operation = 0;
    let unresolvedFieldId: string | undefined;
    for (const field of snapshot.fields) {
      const value = syntheticValueFor(String(field.label));
      const intent = value === undefined ? undefined : fixtureIntent(field, value);
      const retainedEntry = value === undefined
        ? guide.find(({ identity }) => identity === "unresolved")
        : guide.find(({ sanitizedLabel }) =>
          sanitizedLabel !== null &&
          normalizeCatalogText(sanitizedLabel) === normalizeCatalogText(String(field.label))
        );
      if (retainedEntry === undefined) {
        throw new Error(`retained fixture metadata unavailable: ${String(field.label)}`);
      }
      const controlId = String(field.fieldId);
      const metadata = retainedMetadata(
        retainedEntry,
        controlId,
        retainedEntry.allowedOptions.length === 0 ? null : retainedEntry.allowedOptions,
      );
      if (intent === undefined) {
        unresolvedFieldId = field.fieldId;
        if (field.state !== "empty") throw new Error("unresolved fixture control was not observed unset");
        operation += 1;
        capture.recordObserved({
          metadata,
          operationId: `operation_${fixtureId.replaceAll("-", "_")}_state_observed_${operation}`,
          attempt: operation,
        });
        continue;
      }
      operation += 1;
      const operationId = generatedOperationId(
        `operation_${fixtureId.replaceAll("-", "_")}_${String(operation).padStart(8, "0")}`,
      );
      capture.recordAttempt({ metadata, operationId, attempt: operation, interaction: interactionFor(intent) });
      capture.monitorAck({
        controlId,
        operationId,
        attempt: operation,
        moment: "before_mutation",
      });
      const driven = await semanticDriver.drive({
        journeyId: journeyId(`journey_${fixtureId.replaceAll("-", "_")}_fixture`),
        sessionId,
        pageId,
        guardRevision: guardRevision(`guard_${fixtureId.replaceAll("-", "_")}_fixture`),
        operationId,
        intent,
      }, new AbortController().signal);
      if (!driven.ok) throw new Error(`fixture drive denied: ${driven.error.code}`);
      const verified = await semanticVerifier.verify({
        sessionId,
        pageId,
        intent,
        receipt: driven.value,
      }, new AbortController().signal);
      capture.monitorAck({
        controlId,
        operationId,
        attempt: operation,
        moment: "after_readback",
      });
      if (!verified.ok || verified.value.kind !== "verified") {
        throw new Error(`fixture verification denied: ${verified.ok ? verified.value.kind : verified.error.code}`);
      }
      capture.recordVerified({ controlId, operationId, readback: readbackFor(intent) });
    }
    if (fixturePage === "self_identify" && unresolvedFieldId === undefined) {
      const unresolved = guide.find(({ identity }) => identity === "unresolved");
      if (unresolved === undefined) throw new Error("retained unresolved metadata unavailable");
      const control = page.locator('[data-hunt-unresolved="true"] input');
      if (await control.count() !== 1 || await control.inputValue() !== "") {
        throw new Error("unresolved fixture control was not observed unset");
      }
      operation += 1;
      capture.recordObserved({
        metadata: retainedMetadata(unresolved, "retained-self-identify-unresolved", null),
        operationId: `operation_${fixtureId.replaceAll("-", "_")}_state_observed_${operation}`,
        attempt: operation,
      });
      unresolvedFieldId = "retained-self-identify-unresolved";
    }
    const completed = {
      ok: true as const,
      value: unresolvedFieldId === undefined
        ? {
            kind: "blocked" as const,
            code: "synthetic_test_non_submittable" as const,
            fieldId: snapshot.fields[0]?.fieldId,
            protectedCategory: null,
          }
        : {
            kind: "blocked" as const,
            code: "profile_answer_missing" as const,
            fieldId: unresolvedFieldId,
            protectedCategory: null,
          },
    };
    const submitPresent = await page.getByRole("button", { name: /submit/i }).count() > 0 ||
      await page.locator('input[type="submit"]').count() > 0;
    const submitActivated = await page.locator("html").getAttribute("data-hunt-submit-activated") ===
      "true";
    const sha256 = capture.write({ submitPresent, submitActivated });
    assert.match(sha256, /^[a-f0-9]{64}$/u);
    const evidence = JSON.parse(readFileSync(
      join(evidenceRoot, "retained-fixture-control-learning.json"),
      "utf8",
    )) as RetainedFixtureControlEvidenceV1;
    assert.equal(evidence.executionMode, "synthetic_test_non_submittable");
    assert.equal(evidence.testOnly, true);
    assert.equal(evidence.liveAcceptanceEligible, false);
    assert.equal(evidence.reviewExpectationEligible, false);
    assert.equal(evidence.reviewCompletionEligible, false);
    assert.equal(evidence.submitPresent, false);
    assert.equal(evidence.submitActivated, false);
    assert.equal(evidence.privacyScan, "pass");
    assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret-sentinel/u);
    return {
      page,
      snapshot,
      completed,
      evidence,
      close: async () => {
        rmSync(evidenceRoot, { recursive: true, force: true });
        await browser.close();
      },
    };
  } catch (error) {
    rmSync(evidenceRoot, { recursive: true, force: true });
    await browser.close();
    throw error;
  }
}

export function assertAttemptProof(
  result: Awaited<ReturnType<typeof runQuestionnaireFixture>>,
  expected: number,
): void {
  const attempted = result.evidence.controls.filter(({ terminalDisposition }) =>
    terminalDisposition === "verified"
  );
  assert.equal(attempted.length, expected);
  assert.equal(new Set(attempted.map(({ controlId }) => controlId)).size, expected);
  const operationIds = attempted.map(({ monitorBinding }) => {
    assert.ok(monitorBinding !== null);
    return monitorBinding.operationId;
  });
  assert.equal(new Set(operationIds).size, expected);
  for (const question of attempted) {
    assert.equal(question.lane, "synthetic_test_default");
    assert.ok(question.monitorBinding !== null);
    assert.equal(question.monitorBinding.beforeMutationAck, true);
    assert.equal(question.monitorBinding.afterReadbackAck, true);
    assert.equal(question.validation, "pass");
    assert.equal(question.transition, "fixture_retained");
    assert.equal(question.terminalDisposition, "verified");
  }
}

export function retained(page: "voluntary_disclosures" | "self_identify" | "resume") {
  return retainedIntakeControlGuide.filter((entry) => entry.page === page);
}

export function retainedMetadata(
  entry: (typeof retainedIntakeControlGuide)[number],
  controlId: string,
  allowedOptions: readonly string[] | null,
): RetainedFixtureControlMetadata {
  return {
    controlId,
    identity: entry.identity,
    label: entry.sanitizedLabel,
    questionType: entry.normalizedQuestionType,
    uiType: entry.behavior,
    answerType: entry.answerType,
    uiVariant: entry.uiVariant,
    required: entry.required,
    allowedOptions,
  };
}

export async function assertNonSubmittable(page: Page): Promise<void> {
  assert.equal(await page.getByRole("button", { name: /submit/i }).count(), 0);
  assert.equal(await page.locator('input[type="submit"]').count(), 0);
  assert.equal(await page.locator("html").getAttribute("data-hunt-submit-activated"), "false");
  assert.equal(await page.locator('[data-hunt-review-field-id]').count(), 0);
  assert.equal(await page.locator(
    '[aria-invalid="true"], [role="alert"], [data-automation-id*="error" i]',
  ).count(), 0);
}

function fixtureIntent(field: FieldObservation, value: string | boolean): FieldIntent | undefined {
  if (field.behavior === "checkbox" && typeof value === "boolean") {
    return {
      kind: "toggle", behavior: "checkbox", fieldId: field.fieldId, target: field.target,
      checked: value, provenance: "reviewed_catalog",
    };
  }
  if (field.behavior === "text" && typeof value === "string") {
    return {
      kind: "text", behavior: "text", fieldId: field.fieldId, target: field.target,
      value, provenance: "reviewed_catalog",
    };
  }
  if (field.behavior === "date" && typeof value === "string") {
    return {
      kind: "date", behavior: "date", fieldId: field.fieldId, target: field.target,
      isoDate: value, provenance: "reviewed_catalog",
    };
  }
  if (typeof value === "string" &&
      (field.behavior === "select" || field.behavior === "listbox" || field.behavior === "radio")) {
    const option = field.options.find(({ label }) => String(label) === value);
    if (option === undefined) return undefined;
    return {
      kind: "choice", behavior: field.behavior, fieldId: field.fieldId, target: field.target,
      optionId: option.id, expectedOption: option.label, provenance: "visible_option",
    };
  }
  return undefined;
}

function syntheticValueFor(label: string): string | boolean | undefined {
  const normalized = normalizeCatalogText(label);
  for (const [candidate, value] of syntheticAnswers) {
    if (normalizeCatalogText(candidate) === normalized) return value;
  }
  return undefined;
}

function interactionFor(intent: FieldIntent): string {
  if (intent.kind === "choice") return `select exact ${intent.behavior} option`;
  if (intent.kind === "toggle") return "toggle exact checkbox";
  if (intent.kind === "date") return "fill exact date control";
  return "fill exact text control";
}

function readbackFor(intent: FieldIntent) {
  if (intent.kind === "choice") return "option_selected" as const;
  if (intent.kind === "toggle") return "checked" as const;
  return "value_committed" as const;
}
