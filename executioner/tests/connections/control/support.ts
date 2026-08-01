import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

import { createWorkdayPageUnderstanding } from "../../../src/ats/workday/page-understanding.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import {
  createGeneratedIdAllocator,
  eventId,
  fixtureRunId,
  generatedEvidenceId,
  generatedOperationId,
  generatedReportId,
  guardRevision,
  journeyId,
  mcpRequestId,
  providerError,
  upstreamProfileId,
  type BrowserSession,
  type BrowserSessionResult,
  type FieldDriver,
  type McpRequest,
  type PortResult,
} from "../../../src/contracts/index.ts";
import { createMcpFacade } from "../../../src/control/mcp/facade.ts";
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
import { contractFixtures } from "../../../src/testing/contracts/index.ts";

const fixtureRoot = resolve("fixtures/workday/s1");
const liveSignal = new AbortController().signal;
function value<T>(result: PortResult<T, unknown>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected provider success");
  return result.value;
}

function sequence(prefix: "operation" | "evidence" | "report") {
  let next = 0;
  return () => `${prefix}_${(++next).toString(16).padStart(16, "0")}`;
}

export interface ControlFixture {
  readonly api: ReturnType<typeof createMcpFacade>;
  readonly control: ReturnType<typeof createJourneyOrchestrator>;
  readonly journeyId: ReturnType<typeof journeyId>;
  readonly state: FileJourneyStateStore;
  readonly eventsPath: string;
  readonly safety: ReturnType<typeof createSafetyGuard>;
  readonly browser: PlaywrightBrowserSession;
  readonly browserCalls: {
    startAttempts: number;
    readonly starts: BrowserSessionResult[];
    readonly observes: string[];
    readonly mutations: string[];
    readonly navigations: string[];
    readonly closes: string[];
  };
  readonly driverCalls: { count: number };
  startRequest(requestId: string): McpRequest;
  close(): Promise<void>;
}

export async function createControlFixture(
  suffix: "lifecycle",
  options: { readonly retryFirstStart?: boolean } = {},
): Promise<ControlFixture> {
  const root = await mkdtemp(join(tmpdir(), `hunt-f12-${suffix}-`));
  const fixture = new FixtureServer(fixtureRoot);
  const engine = await chromium.launch();
  const context = await engine.newContext();
  const startedFixture = value(await fixture.start({
    fixtureRunId: fixtureRunId(`f12-${suffix}`),
  }, liveSignal));
  let browserId = 0;
  const realBrowser = new PlaywrightBrowserSession({
    context,
    ids: createGeneratedIdAllocator({
      next: () => String(browserId += 1).padStart(16, "0"),
    }),
    timeoutMs: 3_000,
  });
  const browserCalls = {
    startAttempts: 0,
    starts: [] as BrowserSessionResult[],
    observes: [] as string[],
    mutations: [] as string[],
    navigations: [] as string[],
    closes: [] as string[],
  };
  const recordingBrowser: BrowserSession = {
    async start(request, signal) {
      browserCalls.startAttempts += 1;
      if (options.retryFirstStart === true && browserCalls.startAttempts === 1) {
        return { ok: false, error: providerError("browser_timeout") };
      }
      const result = await realBrowser.start(request, signal);
      if (result.ok) browserCalls.starts.push(result.value);
      return result;
    },
    async observe(request, signal) {
      const result = await realBrowser.observe(request, signal);
      if (result.ok) {
        browserCalls.observes.push(request.sessionId);
      }
      return result;
    },
    async mutate(request, signal) {
      browserCalls.mutations.push(request.snapshot.effect.sessionId);
      return realBrowser.mutate(request, signal);
    },
    async navigate(request, signal) {
      browserCalls.navigations.push(request.snapshot.effect.sessionId);
      return realBrowser.navigate(request, signal);
    },
    async close(request, signal) {
      browserCalls.closes.push(request.sessionId);
      return realBrowser.close(request, signal);
    },
  };

  const bytes = new TextEncoder().encode("synthetic resume");
  const resumeId = contractFixtures.resume.resumeId;
  const profileId = upstreamProfileId(`profile-f12-${suffix}`);
  const jobId = contractFixtures.job.jobId;
  const generatedJourneyId = journeyId(`journey_f12_${suffix}_00000001`);
  const source = {
    job: {
      jobId,
      title: "Software Engineer",
      company: "Example",
      applyUrl: `${startedFixture.origin}/profile`,
    },
    resume: contractFixtures.resume,
    profile: {
      profileId,
      revision: 1,
      facts: [
        { factId: "given_name", value: "Ada", provenance: "owner_provided" },
        { factId: "family_name", value: "Lovelace", provenance: "owner_provided" },
        { factId: "phone_number", value: "555-0100", provenance: "owner_provided" },
        { factId: "country", value: "Canada", provenance: "owner_provided" },
        { factId: "earliest_start_date", value: "2026-09-01", provenance: "owner_provided" },
        { factId: "work_authorization", value: true, provenance: "owner_provided" },
        { factId: "age_requirement_met", value: true, provenance: "owner_provided" },
        { factId: "sponsorship_required", value: false, provenance: "owner_provided" },
      ],
    },
  } as const;

  const state = new FileJourneyStateStore(join(root, "state"));
  const eventsPath = join(root, "events", "events.jsonl");
  const events = new JsonlEventStore(eventsPath);
  const privacy = createPrivacyGuard();
  const safety = createSafetyGuard();
  const realDriver = createFieldDriver(recordingBrowser, safety);
  const driverCalls = { count: 0 };
  const driver: FieldDriver = {
    async drive(request, signal) {
      driverCalls.count += 1;
      return realDriver.drive(request, signal);
    },
  };
  const rawOperation = sequence("operation");
  const nextOperationId = () => generatedOperationId(rawOperation());
  const rawEvidence = sequence("evidence");
  const rawReport = sequence("report");
  let nextEvent = 0;
  let nextTick = 0;
  const control = createJourneyOrchestrator({
    intake: createJourneyIntake(
      source,
      bytes,
      generatedJourneyId,
      state.initialize.bind(state),
    ),
    state,
    browser: recordingBrowser,
    understanding: createWorkdayPageUnderstanding(),
    answers: createAnswerResolver(
      createProfileQuery(source.profile),
      "Exact configured interest statement.",
    ),
    driver,
    verifier: createFieldVerifier(recordingBrowser, { maxAttempts: 1 }),
    completion: createCompletionNavigation(),
    safety,
    events,
    failures: new FactualFailureReporter(),
    privacy,
    evidence: createEvidenceStore(join(root, "evidence")),
    nextOperationId: () => ({ ok: true, value: nextOperationId() }),
    nextEventId: () => eventId(`event-${(++nextEvent).toString(16).padStart(16, "0")}`),
    nextReportId: () => ({
      ok: true,
      value: generatedReportId(rawReport()),
    }),
    nextEvidenceId: () => generatedEvidenceId(rawEvidence()),
    guardRevision: guardRevision("policy-s1"),
    clock: () => new Date(Date.UTC(2026, 6, 31, 12, 0, 0, nextTick++)).toISOString(),
  }, { providerRetryLimit: 1, mutationRetryLimit: 0 });
  const api = createMcpFacade({
    control,
    progress: events,
    privacy,
    nextOperationId: () => ({ ok: true, value: nextOperationId() }),
    guardRevision: guardRevision("policy-s1"),
    startJourneyId: generatedJourneyId,
  });

  return {
    api,
    control,
    journeyId: generatedJourneyId,
    state,
    eventsPath,
    safety,
    browser: realBrowser,
    browserCalls,
    driverCalls,
    startRequest(requestId) {
      return {
        schemaVersion: 2,
        requestId: mcpRequestId(requestId),
        method: "start_journey",
        params: { jobId, resumeId, profileId },
      };
    },
    async close() {
      await Promise.all(
        browserCalls.starts.map(({ sessionId }) =>
          realBrowser.close({ sessionId }, liveSignal).catch(() => undefined),
        ),
      );
      await fixture.close();
      await context.close();
      await engine.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function terminalResult(fixture: ControlFixture) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await fixture.control.result(
      { journeyId: fixture.journeyId },
      liveSignal,
    );
    if (result.ok) return result.value;
    await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 10));
  }
  throw new Error("real journey did not reach a terminal result");
}

export function request(
  requestId: string,
  method: "cancel_journey" | "journey_status" | "journey_result",
  id: ReturnType<typeof journeyId>,
): McpRequest {
  return {
    schemaVersion: 2,
    requestId: mcpRequestId(requestId),
    method,
    params: { journeyId: id },
  };
}
