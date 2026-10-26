import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createGeneratedIdAllocator,
  eventId,
  fixtureRunId,
  generatedEvidenceId,
  guardRevision,
  mcpRequestId,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  useResumeArtifactUpload,
  type BrowserObservation,
  type BrowserSession,
  type FixtureRuntime,
  type McpJourneyApi,
  type McpRequest,
  type ResolvedResumeArtifact,
  type TerminalResult,
} from "../../../../src/contracts/index.ts";
import type { S1ControlledJourneyConfig } from "../../../../src/composition/s1-controlled-journey.ts";
import { FixtureServer } from "../../../../src/testing/fixture-server.ts";

export const resumeText = "synthetic F13 resume bytes";
export const privateSentinels = [
  resumeText,
  "Ada",
  "Lovelace",
  "555-0100",
  "Exact configured interest statement.",
] as const;

export interface BrowserTrace {
  readonly starts: string[];
  readonly observations: BrowserObservation[];
  readonly mutations: string[];
  readonly navigations: string[];
  readonly closes: string[];
}

export interface FixtureTrace {
  readonly lifecycle: string[];
}

function sequenceToken() {
  let next = 0;
  return (scope: string) => `${scope}_${String((next += 1)).padStart(16, "0")}`;
}

export function controlledConfig(
  storageRoot: string,
  fixtureRoot: string,
): {
  readonly config: S1ControlledJourneyConfig;
  readonly browser: BrowserTrace;
  readonly fixture: FixtureTrace;
  readonly resumeArtifacts: ResolvedResumeArtifact[];
  readonly resumeSha256: string;
} {
  const bytes = new TextEncoder().encode(resumeText);
  const resumeSha256 = createHash("sha256").update(bytes).digest("hex");
  const browser: BrowserTrace = {
    starts: [],
    observations: [],
    mutations: [],
    navigations: [],
    closes: [],
  };
  const fixture: FixtureTrace = { lifecycle: [] };
  const resumeArtifacts: ResolvedResumeArtifact[] = [];
  let event = 0;
  let evidence = 0;
  let tick = 0;

  return {
    resumeSha256,
    browser,
    fixture,
    resumeArtifacts,
    config: {
      fixtureRoot,
      storageRoot,
      fixtureRunId: fixtureRunId("f13-t1-controlled"),
      source: {
        job: {
          jobId: upstreamJobId("job-f13-controlled"),
          title: "Software Engineer",
          company: "Example",
        },
        resume: {
          resumeId: upstreamResumeId("resume-f13-controlled"),
          sha256: resumeSha256,
        },
        profile: {
          profileId: upstreamProfileId("profile-f13-controlled"),
          revision: 1,
          facts: [
            {
              factId: "given_name",
              value: "Ada",
              provenance: "owner_provided",
            },
            {
              factId: "family_name",
              value: "Lovelace",
              provenance: "owner_provided",
            },
            {
              factId: "phone_number",
              value: "555-0100",
              provenance: "owner_provided",
            },
            {
              factId: "country",
              value: "Canada",
              provenance: "owner_provided",
            },
            {
              factId: "earliest_start_date",
              value: "2026-09-01",
              provenance: "owner_provided",
            },
            {
              factId: "work_authorization",
              value: true,
              provenance: "owner_provided",
            },
            {
              factId: "age_requirement_met",
              value: true,
              provenance: "owner_provided",
            },
            {
              factId: "sponsorship_required",
              value: false,
              provenance: "owner_provided",
            },
          ],
        },
      },
      resumeBytes: bytes,
      narrativeTemplate: "Exact configured interest statement.",
      ids: createGeneratedIdAllocator({ next: sequenceToken() }),
      nextEventId: () =>
        eventId(`event-${String((event += 1)).padStart(16, "0")}`),
      nextEvidenceId: () =>
        generatedEvidenceId(
          `evidence_${String((evidence += 1)).padStart(16, "0")}`,
        ),
      guardRevision: guardRevision("policy-s1"),
      clock: () =>
        new Date(Date.UTC(2026, 6, 31, 12, 0, 0, tick++)).toISOString(),
      createFixtureRuntime(root: string) {
        const real: FixtureRuntime & { close(): Promise<void> } =
          new FixtureServer(root);
        return {
          async start(request, signal) {
            fixture.lifecycle.push("fixture.start");
            return real.start(request, signal);
          },
          async reset(request, signal) {
            fixture.lifecycle.push("fixture.reset");
            return real.reset(request, signal);
          },
          setFault: real.setFault.bind(real),
          async close() {
            fixture.lifecycle.push("fixture.close");
            await real.close();
          },
        };
      },
      onResumeArtifact(artifact: ResolvedResumeArtifact) {
        resumeArtifacts.push(artifact);
      },
      wrapBrowser(real: BrowserSession): BrowserSession {
        return {
          async start(request, signal) {
            fixture.lifecycle.push("browser.start");
            browser.starts.push(request.target);
            return real.start(request, signal);
          },
          async observe(request, signal) {
            const result = await real.observe(request, signal);
            if (result.ok) browser.observations.push(result.value);
            return result;
          },
          async mutate(request, signal) {
            browser.mutations.push(request.snapshot.effect.mutation.kind);
            return real.mutate(request, signal);
          },
          async navigate(request, signal) {
            browser.navigations.push(request.snapshot.effect.action);
            return real.navigate(request, signal);
          },
          async close(request, signal) {
            fixture.lifecycle.push("browser.close");
            browser.closes.push(request.sessionId);
            return real.close(request, signal);
          },
        };
      },
    },
  };
}

export async function assertResumeArtifactDisposed(
  artifact: ResolvedResumeArtifact,
): Promise<void> {
  let effects = 0;
  const replay = await useResumeArtifactUpload(artifact, () => {
    effects += 1;
    return { ok: true, value: "leaked" } as const;
  });
  assert.deepEqual(replay, {
    ok: false,
    error: { code: "artifact_already_consumed", retryable: false },
  });
  assert.equal(effects, 0);
}

export function startRequest(config: S1ControlledJourneyConfig): McpRequest {
  return {
    schemaVersion: 2,
    requestId: mcpRequestId("request-f13-start"),
    method: "start_journey",
    params: {
      jobId: config.source.job.jobId,
      resumeId: config.source.resume.resumeId,
      profileId: config.source.profile.profileId,
    },
  };
}

export async function readTerminal(
  api: McpJourneyApi,
  journeyId: TerminalResult["journeyId"],
  signal: AbortSignal,
): Promise<TerminalResult> {
  const deadline = Date.now() + 30_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    const response = await api.handle(
      {
        schemaVersion: 2,
        requestId: mcpRequestId(
          `request-f13-result-${String((attempt += 1)).padStart(4, "0")}`,
        ),
        method: "journey_result",
        params: { journeyId },
      },
      signal,
    );
    if (!response.ok)
      throw new Error(`MCP transport failed: ${response.error.code}`);
    if (response.value.ok && response.value.result.kind === "terminal") {
      return response.value.result.terminal;
    }
    if (!response.value.ok && response.value.error.code === "journey_busy") {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }
    throw new Error(`unexpected MCP result: ${JSON.stringify(response.value)}`);
  }
  throw new Error("MCP journey did not reach a terminal result");
}
