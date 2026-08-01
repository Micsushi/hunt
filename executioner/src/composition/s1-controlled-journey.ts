import { join } from "node:path";

import { chromium, type Browser, type BrowserContext } from "playwright";

import { createWorkdayPageUnderstanding } from "../ats/workday/page-understanding.ts";
import { PlaywrightBrowserSession } from "../browser/session.ts";
import {
  disposeResumeArtifact,
  generatedJourneyId,
  type ApplicantProfile,
  type BrowserSession,
  type BrowserSessionId,
  type CancellationError,
  type EventId,
  type EvidenceId,
  type FixtureRunId,
  type FixtureRuntime,
  type FixtureRuntimeError,
  type GeneratedIdAllocator,
  type GuardRevision,
  type JobIntake,
  type JourneyId,
  type JourneyIdentityError,
  type JourneyIntake,
  type McpJourneyApi,
  type PortResult,
  type ResolvedResumeArtifact,
  type ResumeSelection,
} from "../contracts/index.ts";
import { createMcpFacade } from "../control/mcp/facade.ts";
import { createJourneyOrchestrator } from "../control/orchestrator/terminal/index.ts";
import { createEvidenceStore } from "../evidence/store.ts";
import { createAnswerResolver } from "../form/answers/resolver.ts";
import { createJourneyIntake } from "../intake/intake.ts";
import { createFieldDriver } from "../interaction/drivers/registry.ts";
import { createCompletionNavigation } from "../interaction/navigation/completion-navigation.ts";
import { createFieldVerifier } from "../interaction/verification/field-verifier.ts";
import { FileJourneyStateStore } from "../journey/state-store.ts";
import { FactualFailureReporter } from "../observability/errors/reporter.ts";
import { JsonlEventStore } from "../observability/events/store.ts";
import { createProfileQuery } from "../profile/profile.ts";
import { createPrivacyGuard, createSafetyGuard } from "../safety/guards.ts";
import { FixtureServer } from "../testing/fixture-server.ts";

export interface S1ControlledJourneyConfig {
  readonly fixtureRoot: string;
  readonly storageRoot: string;
  readonly fixtureRunId: FixtureRunId;
  readonly source: {
    readonly job: Omit<JobIntake, "applyUrl">;
    readonly resume: ResumeSelection;
    readonly profile: ApplicantProfile;
  };
  readonly resumeBytes: Uint8Array;
  readonly narrativeTemplate: string;
  readonly ids: GeneratedIdAllocator;
  readonly nextEventId: () => EventId;
  readonly nextEvidenceId: () => EvidenceId;
  readonly guardRevision: GuardRevision;
  readonly clock: () => string;
  readonly wrapBrowser?: (browser: BrowserSession) => BrowserSession;
}

export interface S1ControlledJourney {
  readonly api: McpJourneyApi;
  readonly journeyId: JourneyId;
  readonly fixture: FixtureRuntime;
  close(): Promise<void>;
}

type CreateResult = PortResult<
  S1ControlledJourney,
  FixtureRuntimeError | CancellationError | JourneyIdentityError
>;

export async function createS1ControlledJourney(
  config: S1ControlledJourneyConfig,
  signal: AbortSignal,
): Promise<CreateResult> {
  const allocatedJourney = generatedJourneyId(config.ids);
  if (!allocatedJourney.ok) return allocatedJourney;

  const fixture = new FixtureServer(config.fixtureRoot);
  const startedFixture = await fixture.start(
    { fixtureRunId: config.fixtureRunId },
    signal,
  );
  if (!startedFixture.ok) {
    await fixture.close();
    return startedFixture;
  }

  let engine: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const target = fixtureAccountTarget(startedFixture.value.origin);
    engine = await chromium.launch({ headless: true });
    context = await engine.newContext();
    const ownedEngine = engine;
    const ownedContext = context;
    const realBrowser = new PlaywrightBrowserSession({
      context: ownedContext,
      ids: config.ids,
    });
    const openSessions = new Set<BrowserSessionId>();
    const lifecycleBrowser: BrowserSession = {
      async start(request, activeSignal) {
        const result = await realBrowser.start(request, activeSignal);
        if (result.ok) openSessions.add(result.value.sessionId);
        return result;
      },
      observe: realBrowser.observe.bind(realBrowser),
      mutate: realBrowser.mutate.bind(realBrowser),
      navigate: realBrowser.navigate.bind(realBrowser),
      async close(request, activeSignal) {
        const result = await realBrowser.close(request, activeSignal);
        if (result.ok) openSessions.delete(request.sessionId);
        return result;
      },
    };
    const browser = config.wrapBrowser?.(lifecycleBrowser) ?? lifecycleBrowser;
    const state = new FileJourneyStateStore(join(config.storageRoot, "state"));
    const events = new JsonlEventStore(
      join(config.storageRoot, "events", "events.jsonl"),
    );
    const privacy = createPrivacyGuard();
    const safety = createSafetyGuard();
    let resumeArtifact: ResolvedResumeArtifact | undefined;
    const realIntake = createJourneyIntake(
      {
        ...config.source,
        job: { ...config.source.job, applyUrl: target },
      },
      config.resumeBytes,
      allocatedJourney.value,
      state.initialize.bind(state),
    );
    const intake: JourneyIntake = {
      async bootstrap(request, activeSignal) {
        const result = await realIntake.bootstrap(request, activeSignal);
        if (result.ok) resumeArtifact = result.value.inputs.resumeArtifact;
        return result;
      },
    };
    const control = createJourneyOrchestrator({
      intake,
      state,
      browser,
      understanding: createWorkdayPageUnderstanding(),
      answers: createAnswerResolver(
        createProfileQuery(config.source.profile),
        config.narrativeTemplate,
      ),
      driver: createFieldDriver(browser, safety),
      verifier: createFieldVerifier(browser),
      completion: createCompletionNavigation(),
      safety,
      events,
      failures: new FactualFailureReporter(),
      privacy,
      evidence: createEvidenceStore(join(config.storageRoot, "evidence")),
      nextOperationId: config.ids.operationId,
      nextEventId: config.nextEventId,
      nextReportId: config.ids.reportId,
      nextEvidenceId: config.nextEvidenceId,
      guardRevision: config.guardRevision,
      clock: config.clock,
    });
    const api = createMcpFacade({
      control,
      progress: events,
      privacy,
      nextOperationId: config.ids.operationId,
      guardRevision: config.guardRevision,
      startJourneyId: allocatedJourney.value,
    });
    let closed = false;

    return {
      ok: true,
      value: Object.freeze({
        api,
        journeyId: allocatedJourney.value,
        fixture,
        async close() {
          if (closed) return;
          closed = true;
          const cleanupSignal = new AbortController().signal;
          await Promise.allSettled(
            [...openSessions].map((sessionId) =>
              realBrowser.close({ sessionId }, cleanupSignal)
            ),
          );
          openSessions.clear();
          if (resumeArtifact !== undefined) {
            disposeResumeArtifact(resumeArtifact);
            resumeArtifact = undefined;
          }
          const rootCleanup = await Promise.allSettled([
            fixture.close(),
            ownedContext.close(),
          ]);
          const browserCleanup = await Promise.allSettled([
            ownedEngine.close(),
          ]);
          const failure = [...rootCleanup, ...browserCleanup].find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          if (failure !== undefined) throw failure.reason;
        },
      }),
    };
  } catch (error) {
    await fixture.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await engine?.close().catch(() => undefined);
    throw error;
  }
}

function fixtureAccountTarget(origin: string): string {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/"
  ) throw new TypeError("fixture origin must be an exact loopback origin");
  return new URL("/account", parsed).href;
}
