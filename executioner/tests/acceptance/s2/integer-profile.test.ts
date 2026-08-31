import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { OwnedWorkdayApplicationRuntime } from
  "../../../src/browser/playwright-live/private/workday-application-runtime.ts";
import { PlaywrightWorkdayProfilePage } from
  "../../../src/ats/workday/application/profile/playwright-page.ts";
import type { ProfileFieldPlan } from
  "../../../src/ats/workday/application/profile/index.ts";
import {
  generatedOperationId,
  journeyId,
  type LiveSessionId,
  type ProfileLeaseId,
} from "../../../src/contracts/index.ts";
import { liveApplicationExecutionPolicy } from
  "../../../src/contracts/application-execution-policy.ts";
import {
  retainedIntakeControlGuide,
  retainedIntakeTextSha256,
} from "../../../src/form/questions/catalog.ts";
import { admitProfileFieldLearningEvidence } from
  "../../../src/live/evidence/profile-field-learning.ts";

const fixture = readFileSync(new URL("./fixtures/integer-profile.html", import.meta.url), "utf8");
const identities = [
  "identity.given_name",
  "identity.family_name",
  "address.line1",
  "address.city",
  "address.country",
  "address.region",
  "address.postal_code",
  "contact.email",
  "phone.device_type",
  "phone.country_code",
  "phone.number",
  "phone.extension",
  "source.how_did_you_hear",
  "employment.previously_worked_for_organization",
] as const;

test("exact Integer Profile fixture observes required live-owner-unset controls without interaction", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const evidenceRoot = mkdtempSync(join(tmpdir(), "integer-profile-learning-"));
  const monitored: { readonly moment: string; readonly operationId: string; readonly attempt: number }[] = [];
  const accepted: string[] = [];
  const trace: { readonly event: string; readonly details?: object }[] = [];
  let nextOperation = 0;
  try {
    await page.setContent(fixture);
    await page.locator("#phoneNumber--countryPhoneCode").evaluate((element) => {
      element.addEventListener("focus", () => element.setAttribute("data-test-focused", "true"));
      element.addEventListener("click", () => element.setAttribute("data-test-clicked", "true"));
    });
    const guide = new Map(retainedIntakeControlGuide.filter(({ page }) => page === "profile")
      .map((entry) => [entry.identity, entry]));
    const fields: ProfileFieldPlan[] = [];
    for (const [index, fieldId] of identities.entries()) {
      const entry = guide.get(fieldId);
      assert.ok(entry !== undefined);
      if (fieldId === "phone.country_code") continue;
      if (fieldId === "employment.previously_worked_for_organization") {
        fields.push({
          fieldId,
          questionType: entry.normalizedQuestionType as "phone" | "prior_employment",
          answerType: entry.answerType as "single_select",
          allowedOptions: entry.allowedOptions,
          answer: { kind: "profile_answer_missing" as const },
        });
        continue;
      }
      const choice = entry.answerType === "single_select";
      const value = choice
        ? entry.allowedOptions[0] ?? `Fixture option ${index + 1}`
        : fieldId === "phone.number" ? "5551234567" : `Fixture value ${index + 1}`;
      fields.push({
        fieldId,
        questionType: entry.normalizedQuestionType as "identity" | "address" | "phone" | "application_source",
        answerType: choice ? "option" as const : fieldId === "phone.number" ? "phone" as const : "text" as const,
        allowedOptions: choice ? [value] : [],
        answer: {
          kind: "answered" as const,
          value,
          provenance: "owner_provided" as const,
          lane: "live_owner_fact" as const,
        },
        ...(choice ? { optionMapping: {
          canonicalValue: value,
          visibleOption: value,
          provenance: "visible_option" as const,
        } } : {}),
      });
    }
    assert.equal(fields.some(({ fieldId }) => fieldId === "phone.country_code"), false);
    const runtime = new OwnedWorkdayApplicationRuntime({
      request: {
        owner: { roots: { evidence: { path: evidenceRoot } } },
        ownerSources: {
          executionPolicy: liveApplicationExecutionPolicy("live"),
          profilePlan: {
            mode: "live",
            pageType: "profile",
            fields,
            repeatables: [],
          },
          sensitiveValues: fields.flatMap(({ answer }) =>
            answer.kind === "answered" ? [answer.value] : []
          ),
        },
      } as never,
      acceptances: { record(value) { accepted.push(value.checkpoint); } },
      nextOperationId: () => generatedOperationId(
        `operation_integer_profile_${String(++nextOperation).padStart(8, "0")}`,
      ),
      timeoutMs: 1_000,
      initialReviewExpected: [],
      externalMonitor: {
        async auth() {},
        async application(_page, pageName, moment, _taxonomy, event) {
          assert.equal(pageName, "profile");
          monitored.push({ moment, ...event });
        },
      },
      authorizationExpiresAt: "2026-08-22T18:30:00.000Z",
      now: () => "2026-08-22T18:00:00.000Z",
      trace: (event, details) => trace.push({ event, details }),
    });
    runtime.bindSession({
      schemaVersion: 1,
      journeyId: journeyId("journey_integer_profile_fixture_01"),
      sessionId: "live_session_integer_profile_fixture_01" as LiveSessionId,
      profileLeaseId: "profile_lease_integer_profile_fixture_01" as ProfileLeaseId,
      target: {} as never,
      leaseExpiresAt: "2026-08-22T19:00:00.000Z",
    });
    try {
      const result = await runtime.run(page as never, {
        schemaVersion: 1,
        journeyId: journeyId("journey_integer_profile_fixture_01"),
        operationId: generatedOperationId("operation_integer_profile_run_0001"),
        sessionId: "live_session_integer_profile_fixture_01" as LiveSessionId,
        target: {} as never,
        now: "2026-08-22T18:00:00.000Z",
      }, {
        kind: "reconcile_profile",
        input: { attempt: 1, pageId: "page-integer-profile" } as never,
      }, new AbortController().signal);
      assert.equal((result as { ok: boolean }).ok, false);
    } finally {
      runtime.dispose();
    }

    assert.deepEqual(accepted, []);
    const blockedTrace = trace.find(({ event }) => event === "profile_reconciliation_blocked");
    assert.deepEqual(blockedTrace?.details, {
      pageId: "page-integer-profile",
      code: "profile_answer_missing",
      fieldId: "phone.country_code",
      mutationAttempted: false,
      retryable: false,
    });
    assert.equal(await page.locator("input:checked").count(), 0);
    assert.equal(await page.locator('input:not([type="radio"])').evaluateAll((items) =>
      items.every((item) => (item as HTMLInputElement).value === "")
    ), true);
    assert.equal(
      await page.locator("#phoneNumber--countryPhoneCode").getAttribute("aria-invalid"),
      null,
    );
    assert.equal(
      await page.locator("#phoneNumber--countryPhoneCode").getAttribute("data-test-focused"),
      null,
    );
    assert.equal(
      await page.locator("#phoneNumber--countryPhoneCode").getAttribute("data-test-clicked"),
      null,
    );
    assert.equal(await page.getByRole("button", { name: /submit/i }).count(), 0);
    assert.equal(await page.locator("html").getAttribute("data-hunt-submit-activated"), "false");

    const observations = monitored.filter(({ moment }) => moment === "state_observed");
    assert.deepEqual(new Set(monitored.map(({ moment }) => moment)), new Set(["state_observed"]));
    assert.equal(observations.length, 1);
    assert.equal(monitored.length * 2_500 < 60_000, true);
    const learning = admitProfileFieldLearningEvidence(JSON.parse(readFileSync(
      join(evidenceRoot, "profile-field-learning.json"), "utf8",
    )));
    assert.equal(learning.schemaVersion, 6);
    assert.equal(learning.browserTransport, "live_browser");
    assert.equal(learning.answerFallbackPolicy, "deterministic_site_valid_editable");
    assert.equal(learning.liveProofEligibility, "eligible");
    assert.equal(learning.fields.length, identities.length);
    assert.equal(new Set(learning.fields.map(({ observationBinding }) =>
      observationBinding?.operationId
    )).size, 1);
    for (const identity of identities) {
      const field = learning.fields.find(({ fieldIdentity }) =>
        fieldIdentity === `profile.${identity}`
      );
      const entry = guide.get(identity);
      assert.ok(field !== undefined && entry !== undefined);
      assert.equal(field.questionCategory, entry.normalizedQuestionType);
      assert.equal(field.answerCategory, entry.answerType);
      assert.equal(field.uiVariant, entry.uiVariant);
      assert.equal(field.required, entry.required);
      assert.equal(field.binderStrategy, "catalog_selector_exact");
      assert.match(field.sanitizedLabelSha256 ?? "", /^[0-9a-f]{64}$/u);
      assert.equal(field.metadataReconciliation, "matched");
      assert.equal(field.validationState, "clear");
      assert.equal(field.observationBinding?.stateObservedAck, true);
    }
    assert.equal(learning.fields.find(({ fieldIdentity }) =>
      fieldIdentity === "profile.employment.previously_worked_for_organization"
    )?.terminalDisposition, "required_unset");
    const countryCode = learning.fields.find(({ fieldIdentity }) =>
      fieldIdentity === "profile.phone.country_code"
    );
    assert.ok(countryCode !== undefined);
    assert.deepEqual({
      backingState: countryCode.backingState,
      validationState: countryCode.validationState,
      optionCatalogState: countryCode.optionCatalogState,
      visibleOptionIds: countryCode.visibleOptionIds,
      prefillDisposition: countryCode.prefillDisposition,
      driverAttempt: countryCode.driverAttempt,
      monitorBinding: countryCode.monitorBinding,
      terminalDisposition: countryCode.terminalDisposition,
      persistentReadback: countryCode.mechanics.persistentReadback,
    }, {
      backingState: "unset",
      validationState: "clear",
      optionCatalogState: "unknown",
      visibleOptionIds: [],
      prefillDisposition: "needs_owner_input",
      driverAttempt: "none",
      monitorBinding: null,
      terminalDisposition: "required_unset",
      persistentReadback: "not_attempted",
    });
    for (const [identity, optionCount] of [
      ["profile.address.country", 1],
      ["profile.address.region", 1],
      ["profile.phone.device_type", 2],
      ["profile.source.how_did_you_hear", 2],
    ] as const) {
      assert.equal(learning.fields.find(({ fieldIdentity }) =>
        fieldIdentity === identity
      )?.visibleOptionIds.length, optionCount);
    }
    const source = learning.fields.find(({ fieldIdentity }) =>
      fieldIdentity === "profile.source.how_did_you_hear"
    );
    assert.equal(source?.visibleOptionIds.length, 2);
    assert.equal(source?.visibleOptionIds.includes(
      `option_sha256_${retainedIntakeTextSha256("Crossed Popup Value")}`,
    ), false);
    assert.equal(learning.fields.some(({ visibleOptionIds }) =>
      visibleOptionIds.includes(
        `option_sha256_${retainedIntakeTextSha256("Crossed Popup Value")}`,
      )
    ), false);
    assert.doesNotMatch(
      JSON.stringify(learning),
      /Fixture value|Fixture option|LinkedIn|Referral|Crossed Popup Value/u,
    );
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
    await browser.close();
  }
});

test("Integer Profile observation fails closed on duplicate popup ownership", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const source = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "source.how_did_you_hear",
    );
    assert.ok(source !== undefined);
    const observed = await adapter.observeControl(source.controlId, AbortSignal.any([]));
    assert.equal(observed.visibleOptionIds.includes(
      `option_sha256_${retainedIntakeTextSha256("Crossed Popup Value")}`,
    ), false);
    assert.deepEqual(
      { backingState: observed.backingState, validationState: observed.validationState },
      { backingState: "unset", validationState: "clear" },
    );

    await page.evaluate(() => {
      const duplicate = document.createElement("div");
      duplicate.id = "source-options";
      duplicate.setAttribute("role", "listbox");
      duplicate.innerHTML = '<div role="option">Duplicate Owner Value</div>';
      document.body.append(duplicate);
    });
    const ambiguous = await adapter.observeControl(source.controlId, AbortSignal.any([]));
    assert.deepEqual(
      {
        optionCatalogState: ambiguous.optionCatalogState,
        visibleOptionIds: ambiguous.visibleOptionIds,
        backingState: ambiguous.backingState,
        validationState: ambiguous.validationState,
      },
      {
        optionCatalogState: "unknown",
        visibleOptionIds: [],
        backingState: "unset",
        validationState: "clear",
      },
    );
  } finally {
    await browser.close();
  }
});

test("Integer Profile observes derived country phone code without opening its selector", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const countryCode = page.locator("#phoneNumber--countryPhoneCode");
    await countryCode.evaluate((element) => {
      element.addEventListener("focus", () => element.setAttribute("data-test-focused", "true"));
      element.addEventListener("click", () => element.setAttribute("data-test-clicked", "true"));
    });
    const adapter = new PlaywrightWorkdayProfilePage(page, { pageType: "profile" });
    const control = (await adapter.inspect(AbortSignal.any([]))).controls.find(
      ({ fieldId }) => fieldId === "phone.country_code",
    );
    assert.ok(control !== undefined);

    const observed = await adapter.observeControl(control.controlId, AbortSignal.any([]), true);

    assert.deepEqual({
      optionCatalogState: observed.optionCatalogState,
      visibleOptionIds: observed.visibleOptionIds,
      focused: await countryCode.getAttribute("data-test-focused"),
      clicked: await countryCode.getAttribute("data-test-clicked"),
    }, {
      optionCatalogState: "unknown",
      visibleOptionIds: [],
      focused: null,
      clicked: null,
    });
  } finally {
    await browser.close();
  }
});
