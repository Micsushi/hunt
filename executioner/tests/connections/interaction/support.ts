import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { chromium, type BrowserContext, type Browser } from "playwright";

import { createWorkdayPageUnderstanding } from "../../../src/ats/workday/page-understanding.ts";
import { PlaywrightBrowserSession } from "../../../src/browser/session.ts";
import {
  admitContractSnapshot,
  bindAdmissionRequest,
  captureResumeArtifact,
  createGeneratedIdAllocator,
  fixtureRunId,
  generatedOperationId,
  guardRevision,
  journeyId,
  upstreamProfileId,
  upstreamResumeId,
  type ApplicantProfile,
  type BrowserNavigationRequest,
  type BrowserSessionResult,
  type FieldObservation,
  type PageUnderstandingResult,
  type PortResult,
} from "../../../src/contracts/index.ts";
import { createAnswerResolver } from "../../../src/form/answers/resolver.ts";
import { createProfileQuery } from "../../../src/profile/profile.ts";
import { FixtureServer } from "../../../src/testing/fixture-server.ts";
import { createSafetyGuardFake } from "../../../src/testing/contracts/index.ts";

const fixtureRoot = resolve("fixtures/workday/s1");

export const signal = new AbortController().signal;
export const interactionJourneyId = journeyId("journey_5555555555555555");
export const interactionRevision = guardRevision("policy-s1");

export function value<T>(result: PortResult<T, unknown>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected provider success");
  return result.value;
}

export function operationId(index: number) {
  return generatedOperationId(`operation_${String(index).padStart(16, "0")}`);
}

export function admittingSafety() {
  return createSafetyGuardFake({
    admit: (request) => admitContractSnapshot(
      request.input,
      "safety",
      request.binding,
    ) as never,
  });
}

export function navigationRequest(
  session: BrowserSessionResult,
  index: number,
): BrowserNavigationRequest {
  const operation = operationId(index);
  const snapshot = {
    policyRevision: interactionRevision,
    capability: "navigate_next",
    effect: {
      kind: "browser_navigation",
      sessionId: session.sessionId,
      pageId: session.pageId,
      operationId: operation,
      action: "next",
    },
  } as const;
  return bindAdmissionRequest(value(admitContractSnapshot(
    snapshot,
    "safety",
    {
      journeyId: interactionJourneyId,
      attemptId: operation,
      guardRevision: interactionRevision,
    },
  )));
}

export function answerContext(suffix: string) {
  const profileId = upstreamProfileId(`profile-interaction-${suffix}`);
  const profile = {
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
  } as const satisfies ApplicantProfile;
  const bytes = new TextEncoder().encode(`synthetic resume ${suffix}`);
  const selection = {
    resumeId: upstreamResumeId(`resume-interaction-${suffix}`),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const artifact = value(captureResumeArtifact(selection, bytes));
  return {
    profile,
    selection,
    artifact,
    resolver: createAnswerResolver(
      createProfileQuery(profile),
      "Exact configured interest statement.",
    ),
  };
}

export async function resolveField(
  context: ReturnType<typeof answerContext>,
  field: FieldObservation,
) {
  const result = value(await context.resolver.resolve({
    field,
    profileId: context.profile.profileId,
    profileRevision: context.profile.revision,
    resume: context.selection,
    resumeArtifact: context.artifact,
  }, signal));
  assert.equal(result.kind, "resolved", JSON.stringify(result));
  if (result.kind !== "resolved") throw new Error("field did not resolve");
  return result.intent;
}

export async function understand(
  browser: PlaywrightBrowserSession,
  session: BrowserSessionResult,
): Promise<Extract<PageUnderstandingResult, { readonly kind: "understood" }>> {
  const observation = value(await browser.observe(session, signal));
  const result = value(await createWorkdayPageUnderstanding().understand({ observation }, signal));
  assert.equal(result.kind, "understood", JSON.stringify(result));
  if (result.kind !== "understood") throw new Error("page was not understood");
  return result;
}

export interface OpenInteractionFixture {
  readonly fixture: FixtureServer;
  readonly engine: Browser;
  readonly context: BrowserContext;
  readonly browser: PlaywrightBrowserSession;
  readonly origin: string;
  readonly session: BrowserSessionResult;
  close(): Promise<void>;
}

export async function openInteractionFixture(
  suffix: string,
  path = "/profile",
  timeoutMs = 5_000,
): Promise<OpenInteractionFixture> {
  let nextId = 0;
  const fixture = new FixtureServer(fixtureRoot);
  const engine = await chromium.launch();
  const context = await engine.newContext();
  const browser = new PlaywrightBrowserSession({
    context,
    ids: createGeneratedIdAllocator({
      next: () => String(nextId += 1).padStart(16, "0"),
    }),
    timeoutMs,
  });
  const started = value(await fixture.start({
    fixtureRunId: fixtureRunId(`interaction-${suffix}`),
  }, signal));
  const session = value(await browser.start({
    journeyId: interactionJourneyId,
    target: `${started.origin}${path}`,
  }, signal));
  return {
    fixture,
    engine,
    context,
    browser,
    origin: started.origin,
    session,
    async close() {
      await browser.close({ sessionId: session.sessionId }, signal).catch(() => undefined);
      await fixture.close();
      await context.close();
      await engine.close();
    },
  };
}
