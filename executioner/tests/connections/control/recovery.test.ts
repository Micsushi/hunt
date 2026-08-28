import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { createWorkdayPageUnderstanding } from "../../../src/ats/workday/page-understanding.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import {
  bindAdmissionRequest,
  boundedText,
  browserTargetToken,
  createGeneratedIdAllocator,
  eventId,
  fixtureRunId,
  generatedEvidenceId,
  generatedOperationId,
  generatedReportId,
  guardRevision,
  journeyId,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  type ApplicantProfile,
  type BrowserSession,
  type BrowserSessionResult,
  type FieldDriver,
  type FieldVerifier,
  type PortResult,
} from "../../../src/contracts/index.ts";
import { createJourneyOrchestrator } from "../../../src/control/orchestrator/terminal/index.ts";
import { createEvidenceStore } from "../../../src/evidence/store.ts";
import { createAnswerResolver } from "../../../src/form/answers/resolver.ts";
import { createJourneyIntake } from "../../../src/intake/intake.ts";
import { createFieldDriver } from "../../../src/interaction/drivers/registry.ts";
import { createCompletionNavigation } from "../../../src/interaction/navigation/completion-navigation.ts";
import { createFieldVerifier } from "../../../src/interaction/verification/field-verifier.ts";
import { FileJourneyStateStore } from "../../../src/journey/state-store.ts";
import { FactualFailureReporter } from "../../../src/observability/errors/reporter.ts";
import { JsonlEventStore } from "../../../src/observability/events/store.ts";
import { createProfileQuery } from "../../../src/profile/profile.ts";
import { createPrivacyGuard, createSafetyGuard } from "../../../src/safety/guards.ts";
import { FixtureServer } from "../../../src/testing/fixture-server.ts";

const fixtureRoot = resolve("fixtures/workday/s1");
const revision = guardRevision("policy-s1");
const recoveryJourneyId = journeyId("journey_7777777777777777");
const marker = "hunt-t5-country-effect-started";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function value<T, E>(result: PortResult<T, E>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected provider success");
  return result.value;
}

function generatedOperations() {
  let next = 0;
  return () => ({
    ok: true as const,
    value: generatedOperationId(
      `operation_${String(next += 1).padStart(16, "0")}`,
    ),
  });
}

test("real F9 replaces an uncertain F3 session, observes fresh truth, and terminally stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-f12-t5-recovery-"));
  const fixture = new FixtureServer(fixtureRoot);
  const engine = await chromium.launch({ headless: true });
  const context = await engine.newContext();
  const effectStarted = deferred<void>();
  const freshObserved = deferred<{
    readonly request: Parameters<BrowserSession["observe"]>[0];
    readonly session: BrowserSessionResult;
  }>();
  const releaseFreshObserve = deferred<void>();
  let cancelPromise: ReturnType<ReturnType<typeof createJourneyOrchestrator>["cancel"]> | undefined;
  let control: ReturnType<typeof createJourneyOrchestrator> | undefined;
  let startedJourney = false;

  await context.addInitScript({
    content: `document.addEventListener("click",event=>{const target=event.target;if(!(target instanceof Element)||target.getAttribute("data-option-id")!=="s1-option-country-ca")return;console.log(${JSON.stringify(marker)});const until=performance.now()+500;while(performance.now()<until){}},true);`,
  });
  context.on("page", (page) => {
    page.on("console", (message) => {
      if (message.text() === marker) effectStarted.resolve(undefined);
    });
  });

  const realBrowser = new PlaywrightBrowserSession({
    context,
    ids: createGeneratedIdAllocator({
      next: (() => {
        let next = 0;
        return () => String(next += 1).padStart(16, "0");
      })(),
    }),
    timeoutMs: 2_000,
  });
  const browserCalls: Array<{
    readonly operation: "start" | "observe" | "mutate" | "navigate" | "close";
    readonly sessionId?: string;
    readonly pageId?: string;
    readonly target?: string;
    readonly resultSessionId?: string;
    readonly resultPageId?: string;
    readonly errorCode?: string;
  }> = [];
  const starts: BrowserSessionResult[] = [];
  let observeCount = 0;
  const browser: BrowserSession = {
    async start(request, signal) {
      const result = await realBrowser.start(request, signal);
      browserCalls.push({
        operation: "start",
        target: request.target,
        ...(result.ok
          ? {
              resultSessionId: result.value.sessionId,
              resultPageId: result.value.pageId,
            }
          : { errorCode: result.error.code }),
      });
      if (result.ok) starts.push(result.value);
      return result;
    },
    async observe(request, signal) {
      const result = await realBrowser.observe(request, signal);
      observeCount += 1;
      browserCalls.push({
        operation: "observe",
        sessionId: request.sessionId,
        pageId: request.pageId,
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
      if (observeCount === 2 && result.ok) {
        freshObserved.resolve({ request, session: starts[1]! });
        await releaseFreshObserve.promise;
      }
      return result;
    },
    async mutate(request, signal) {
      const result = await realBrowser.mutate(request, signal);
      browserCalls.push({
        operation: "mutate",
        sessionId: request.snapshot.effect.sessionId,
        pageId: request.snapshot.effect.pageId,
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
      return result;
    },
    async navigate(request, signal) {
      const result = await realBrowser.navigate(request, signal);
      browserCalls.push({
        operation: "navigate",
        sessionId: request.snapshot.effect.sessionId,
        pageId: request.snapshot.effect.pageId,
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
      return result;
    },
    async close(request, signal) {
      const result = await realBrowser.close(request, signal);
      browserCalls.push({
        operation: "close",
        sessionId: request.sessionId,
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
      return result;
    },
  };

  try {
    const signal = new AbortController().signal;
    const fixtureStarted = value(await fixture.start({
      fixtureRunId: fixtureRunId("t5-real-recovery"),
    }, signal));
    const applyUrl = `${fixtureStarted.origin}/profile`;
    const resumeBytes = new TextEncoder().encode("synthetic recovery resume");
    const resume = {
      resumeId: upstreamResumeId("resume-t5-recovery"),
      sha256: createHash("sha256").update(resumeBytes).digest("hex"),
    } as const;
    const profile = {
      profileId: upstreamProfileId("profile-t5-recovery"),
      revision: 1,
      facts: [
        { factId: "country", value: "Canada", provenance: "owner_provided" },
      ],
    } as const satisfies ApplicantProfile;
    const job = {
      jobId: upstreamJobId("job-t5-recovery"),
      title: "Synthetic recovery role",
      company: "Synthetic recovery company",
      applyUrl,
    } as const;
    const stateDirectory = join(root, "state");
    const state = new FileJourneyStateStore(stateDirectory);
    const intake = createJourneyIntake(
      { job, resume, profile },
      resumeBytes,
      recoveryJourneyId,
      state.initialize.bind(state),
    );
    const safety = createSafetyGuard();
    const realDriver = createFieldDriver(browser, safety);
    const driverCalls: Array<{
      readonly fieldId: string;
      readonly behavior: string;
      errorCode?: string;
    }> = [];
    const driver: FieldDriver = {
      async drive(request, activeSignal) {
        const call: {
          fieldId: string;
          behavior: string;
          errorCode?: string;
        } = {
          fieldId: request.intent.fieldId as string,
          behavior: request.intent.behavior,
        };
        driverCalls.push(call);
        const result = await realDriver.drive(request, activeSignal);
        if (!result.ok) call.errorCode = result.error.code;
        return result;
      },
    };
    const realVerifier = createFieldVerifier(browser, { maxAttempts: 1 });
    let verifierCalls = 0;
    const verifier: FieldVerifier = {
      async verify(request, activeSignal) {
        verifierCalls += 1;
        return realVerifier.verify(request, activeSignal);
      },
    };
    const eventPath = join(root, "events", "events.jsonl");
    const events = new JsonlEventStore(eventPath);
    let notifications = 0;
    const failures = new FactualFailureReporter(async () => {
      notifications += 1;
    });
    const nextOperationId = generatedOperations();
    let nextEvent = 0;
    let nextReport = 0;
    let nextEvidence = 0;
    control = createJourneyOrchestrator({
      intake,
      state,
      browser,
      understanding: createWorkdayPageUnderstanding(),
      answers: createAnswerResolver(
        createProfileQuery(profile),
        "Exact configured recovery narrative.",
      ),
      driver,
      verifier,
      completion: createCompletionNavigation(),
      safety,
      events,
      failures,
      privacy: createPrivacyGuard(),
      evidence: createEvidenceStore(join(root, "evidence")),
      nextOperationId,
      nextEventId: () => eventId(
        `event-t5-${String(nextEvent += 1).padStart(16, "0")}`,
      ),
      nextReportId: () => ({
        ok: true,
        value: generatedReportId(
          `report_${String(nextReport += 1).padStart(16, "0")}`,
        ),
      }),
      nextEvidenceId: () => generatedEvidenceId(
        `evidence_${String(nextEvidence += 1).padStart(16, "0")}`,
      ),
      guardRevision: revision,
      clock: () => "2026-07-31T12:00:00.000Z",
    }, {
      mutationRetryLimit: 0,
      providerRetryLimit: 0,
      stateRetryLimit: 1,
    });

    const startOperation = generatedOperationId("operation_start777777777777");
    const start = await control.start({
      operationId: startOperation,
      jobId: job.jobId,
      resumeId: resume.resumeId,
      profileId: profile.profileId,
    }, signal);
    assert.equal(start.ok, true, JSON.stringify(start));
    if (!start.ok) return;
    startedJourney = true;

    await bounded(effectStarted.promise, "real F3 effect marker");
    const cancelOperation = generatedOperationId("operation_cancel77777777777");
    cancelPromise = control.cancel({
      operationId: cancelOperation,
      journeyId: recoveryJourneyId,
    }, signal);

    const fresh = await bounded(
      freshObserved.promise,
      "fresh-session observation",
    );
    assert.equal(starts.length, 2);
    const old = starts[0]!;
    assert.notEqual(old.sessionId, fresh.session.sessionId);
    assert.deepEqual(fresh.request, fresh.session);
    assert.deepEqual(
      browserCalls.map(({ operation }) => operation),
      ["start", "observe", "mutate", "close", "start", "observe"],
    );
    assert.deepEqual(
      browserCalls.filter(({ operation }) => operation === "start")
        .map(({ target }) => target),
      [applyUrl, applyUrl],
    );
    assert.deepEqual(driverCalls, [{
      fieldId: "s1-field-country",
      behavior: "listbox",
    }]);
    assert.equal(verifierCalls, 1);

    assert.deepEqual(
      await realBrowser.observe(old, signal),
      {
        ok: false,
        error: { code: "browser_session_missing", retryable: false },
      },
    );
    const countryTarget = browserTargetToken("target-s1-field-country");
    const oldMutationOperation = generatedOperationId("operation_probe_mutate1111");
    const oldMutationInput = {
      policyRevision: revision,
      capability: "field_mutation",
      effect: {
        kind: "browser_mutation",
        sessionId: old.sessionId,
        pageId: old.pageId,
        operationId: oldMutationOperation,
        mutation: {
          kind: "select",
          target: countryTarget,
          option: boundedText("Canada"),
        },
      },
    } as const;
    const oldMutationAdmission = value(await safety.admit({
      binding: {
        journeyId: recoveryJourneyId,
        attemptId: oldMutationOperation,
        guardRevision: revision,
      },
      policyRevision: revision,
      capability: "field_mutation",
      input: oldMutationInput,
    }, signal));
    assert.deepEqual(
      await realBrowser.mutate(
        bindAdmissionRequest(oldMutationAdmission),
        signal,
      ),
      {
        ok: false,
        error: { code: "browser_session_missing", retryable: false },
      },
    );
    const oldNavigationOperation = generatedOperationId("operation_probe_navigate11");
    const oldNavigationInput = {
      policyRevision: revision,
      capability: "navigate_next",
      effect: {
        kind: "browser_navigation",
        sessionId: old.sessionId,
        pageId: old.pageId,
        operationId: oldNavigationOperation,
        action: "next",
      },
    } as const;
    const oldNavigationAdmission = value(await safety.admit({
      binding: {
        journeyId: recoveryJourneyId,
        attemptId: oldNavigationOperation,
        guardRevision: revision,
      },
      policyRevision: revision,
      capability: "navigate_next",
      input: oldNavigationInput,
    }, signal));
    assert.deepEqual(
      await realBrowser.navigate(
        bindAdmissionRequest(oldNavigationAdmission),
        signal,
      ),
      {
        ok: false,
        error: { code: "browser_session_missing", retryable: false },
      },
    );

    releaseFreshObserve.resolve(undefined);
    const cancelled = await bounded(cancelPromise, "cancel completion");
    assert.deepEqual(cancelled, {
      ok: true,
      value: {
        operationId: cancelOperation,
        journeyId: recoveryJourneyId,
        accepted: true,
      },
    });
    const terminal = value(await control.result({
      journeyId: recoveryJourneyId,
    }, signal));
    assert.deepEqual(terminal, {
      schemaVersion: 3,
      journeyId: recoveryJourneyId,
      status: "cancelled",
      completedPages: 0,
    });
    assert.deepEqual(
      value(await control.result({ journeyId: recoveryJourneyId }, signal)),
      terminal,
    );
    assert.equal(
      value(await control.status({ journeyId: recoveryJourneyId }, signal)),
      "cancelled",
    );
    assert.deepEqual(
      browserCalls.map(({ operation }) => operation),
      ["start", "observe", "mutate", "close", "start", "observe", "close"],
    );
    assert.equal(
      browserCalls.filter(({ operation }) => operation === "mutate").length,
      1,
    );
    assert.equal(
      browserCalls.filter(({ operation }) => operation === "navigate").length,
      0,
    );
    assert.equal(driverCalls.length, 1);
    assert.equal(verifierCalls, 1);
    assert.equal(notifications, 0);

    const reopened = new FileJourneyStateStore(stateDirectory);
    const reloaded = value(await reopened.load({
      journeyId: recoveryJourneyId,
    }, signal));
    assert.equal(reloaded.state?.status, "cancelled");
    const envelopes = (await readFile(eventPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        readonly kind: string;
        readonly component: string;
        readonly phase: string;
        readonly step: string;
      });
    assert.deepEqual(
      envelopes.filter(({ kind }) => kind === "journey_terminal"),
      [{
        ...envelopes.find(({ kind }) => kind === "journey_terminal")!,
        kind: "journey_terminal",
        component: "F9",
        phase: "orchestration",
        step: "cancel",
      }],
    );
    assert.equal(context.pages().length, 0);
  } finally {
    releaseFreshObserve.resolve(undefined);
    if (cancelPromise !== undefined) await cancelPromise.catch(() => undefined);
    if (startedJourney && control !== undefined) {
      await control.cancel({
        operationId: generatedOperationId("operation_cleanup777777777"),
        journeyId: recoveryJourneyId,
      }, new AbortController().signal).catch(() => undefined);
    }
    for (const session of [...starts].reverse()) {
      await realBrowser.close(
        { sessionId: session.sessionId },
        new AbortController().signal,
      ).catch(() => undefined);
    }
    await fixture.close();
    await context.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});
