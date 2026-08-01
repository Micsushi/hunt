import { isDeepStrictEqual } from "node:util";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mcpRequestId,
  parseEventEnvelope,
  providerError,
  type BrowserReadback,
  type BrowserSession,
  type ComponentId,
  type EventEnvelope,
  type EvidenceRecord,
  type FailureReport,
  type JourneyProgress,
  type McpJourneyApi,
  type PhaseId,
  type StepId,
  type TerminalResult,
} from "../../../src/contracts/index.ts";
import {
  createS1ControlledJourney,
  type S1ControlledJourney,
} from "../../../src/composition/s1-controlled-journey.ts";
import { createEvidenceStore } from "../../../src/evidence/store.ts";
import { requiredFieldFlowCases } from "../../../src/testing/contracts/field-flow-cases.ts";
import {
  controlledConfig,
  privateSentinels,
  startRequest,
} from "./journey/support.ts";

export const MAX_ACCEPTANCE_REPORT_BYTES = 64 * 1024;

type Scenario = "happy" | "f3_observe_invalid";

interface FieldProjection {
  readonly fieldId: (typeof requiredFieldFlowCases)[number]["fieldId"];
  readonly behavior: (typeof requiredFieldFlowCases)[number]["behavior"];
  readonly verification: "verified";
}

interface EventProjection {
  readonly kind: EventEnvelope["kind"];
  readonly component: ComponentId;
  readonly phase: PhaseId;
  readonly step: StepId;
}

interface EvidenceProjection {
  readonly kind: EvidenceRecord["kind"];
  readonly component: ComponentId;
  readonly phase: PhaseId;
  readonly step: StepId;
  readonly sha256: string;
}

type TerminalProjection =
  | { readonly status: "review_reached" | "cancelled"; readonly completedPages: number }
  | {
      readonly status: "failed";
      readonly completedPages: number;
      readonly errorCode: Extract<TerminalResult, { readonly status: "failed" }>["errorCode"];
    }
  | {
      readonly status: "blocked";
      readonly completedPages: number;
      readonly factualOutcome: Extract<TerminalResult, { readonly status: "blocked" }>["factualOutcome"];
    };

export interface ScenarioProjection {
  readonly scenario: Scenario;
  readonly terminal: TerminalProjection;
  readonly progress: {
    readonly status: JourneyProgress["status"];
    readonly completedSteps: number;
    readonly monotonic: true;
  };
  readonly verifiedFields: readonly FieldProjection[];
  readonly finalPage: "review" | null;
  readonly submitTouched: false;
  readonly failure: null | {
    readonly component: "F3";
    readonly phase: "browser";
    readonly step: "observe";
    readonly code: "browser_target_invalid";
    readonly retryable: false;
  };
  readonly browserEffects: {
    readonly observeCalls: number;
    readonly mutations: number;
    readonly navigations: number;
  };
  readonly terminalCount: 1;
  readonly events: readonly EventProjection[];
  readonly evidence: readonly EvidenceProjection[];
  readonly privacy: {
    readonly sentinelsAbsent: true;
    readonly resumeBytesDisposed: true;
  };
  readonly cleanupVerified: true;
}

export interface S1AcceptanceReport {
  readonly schemaVersion: 1;
  readonly candidate: string;
  readonly repetitions: { readonly happy: 3; readonly fault: 3 };
  readonly scenarios: {
    readonly happy: { readonly runs: 3; readonly projection: ScenarioProjection };
    readonly fault: { readonly runs: 3; readonly projection: ScenarioProjection };
  };
}

export interface S1AcceptanceResult {
  readonly runs: {
    readonly happy: readonly ScenarioProjection[];
    readonly fault: readonly ScenarioProjection[];
  };
  readonly report: S1AcceptanceReport;
}

export async function runDeterministicAcceptance(options: {
  readonly candidate: string;
  readonly fixtureRoot: string;
}): Promise<S1AcceptanceResult> {
  if (!/^[a-f0-9]{40}$/u.test(options.candidate)) {
    throw new TypeError("acceptance candidate must be a full Git SHA");
  }
  const happy: ScenarioProjection[] = [];
  const fault: ScenarioProjection[] = [];
  for (let run = 1; run <= 3; run += 1) {
    happy.push(await runScenario("happy", run, options.fixtureRoot));
  }
  for (let run = 1; run <= 3; run += 1) {
    fault.push(await runScenario("f3_observe_invalid", run, options.fixtureRoot));
  }
  assertSameScenario(happy);
  assertSameScenario(fault);

  const report: S1AcceptanceReport = {
    schemaVersion: 1,
    candidate: options.candidate,
    repetitions: { happy: 3, fault: 3 },
    scenarios: {
      happy: { runs: 3, projection: happy[0]! },
      fault: { runs: 3, projection: fault[0]! },
    },
  };
  assertSanitizedReport(report);
  return { runs: { happy, fault }, report };
}

async function runScenario(
  scenario: Scenario,
  run: number,
  fixtureRoot: string,
): Promise<ScenarioProjection> {
  const root = await mkdtemp(join(tmpdir(), `hunt-f13-t2-${scenario}-`));
  const { config, browser, resumeSha256 } = controlledConfig(root, fixtureRoot);
  const sourceBytes = config.resumeBytes;
  const reports: FailureReport[] = [];
  let observeCalls = 0;
  const traceBrowser = config.wrapBrowser;
  const faultBrowser = (real: BrowserSession): BrowserSession => {
    const traced = traceBrowser?.(real) ?? real;
    return {
      start: traced.start.bind(traced),
      async observe(_request, activeSignal) {
        observeCalls += 1;
        return {
          ok: false,
          error: providerError(
            activeSignal.aborted
              ? "operation_cancelled"
              : "browser_target_invalid",
          ),
        };
      },
      mutate: traced.mutate.bind(traced),
      navigate: traced.navigate.bind(traced),
      close: traced.close.bind(traced),
    };
  };
  const scenarioConfig = {
    ...config,
    notifyFailure: async (report: FailureReport) => {
      reports.push(report);
    },
    ...(scenario === "f3_observe_invalid" ? { wrapBrowser: faultBrowser } : {}),
  };
  let runtime: S1ControlledJourney | undefined;
  let fixtureTarget: string | undefined;
  let core: Omit<ScenarioProjection, "privacy" | "cleanupVerified"> | undefined;
  let cleanupFailure: unknown;
  try {
    const created = await createS1ControlledJourney(scenarioConfig, new AbortController().signal);
    if (!created.ok) throw new Error(`S1 composition failed: ${created.error.code}`);
    runtime = created.value;
    const accepted = await runtime.api.handle(
      startRequest(scenarioConfig),
      new AbortController().signal,
    );
    if (!accepted.ok || !accepted.value.ok || accepted.value.result.kind !== "accepted") {
      throw new Error(`journey was not accepted: ${JSON.stringify(accepted)}`);
    }
    const polled = await pollTerminal(
      runtime.api,
      runtime.journeyId,
      `${scenario}-${run}`,
    );
    fixtureTarget = browser.starts[0];
    const events = await readEvents(join(root, "events", "events.jsonl"));
    const terminalEvents = events.filter(({ kind }) => kind === "journey_terminal");
    if (terminalEvents.length !== 1) {
      throw new Error(`expected one terminal event, received ${terminalEvents.length}`);
    }
    const persisted = await readPersistedText(root);
    assertNoSentinels(persisted);
    const evidenceResult = await createEvidenceStore(join(root, "evidence")).read(
      { journeyId: runtime.journeyId },
      new AbortController().signal,
    );
    if (!evidenceResult.ok) {
      throw new Error(`evidence read failed: ${evidenceResult.error.code}`);
    }
    const finalPage = browser.observations.at(-1)?.path === "/review"
      ? "review" as const
      : null;
    assertScenarioOutcome(scenario, polled.terminal, finalPage);
    const verifiedFields = scenario === "happy"
      ? projectVerifiedFields(browser.observations, resumeSha256)
      : [];
    const failure = projectFailure(scenario, reports, runtime.journeyId);
    if (scenario === "f3_observe_invalid") {
      if (observeCalls !== 1 || browser.mutations.length !== 0 || browser.navigations.length !== 0) {
        throw new Error("nonretryable F3 observation fault reached a later browser effect");
      }
    }
    if (browser.closes.length !== 1) {
      throw new Error(`expected one owned session close, received ${browser.closes.length}`);
    }
    if (browser.mutations.some((kind) => kind.toLowerCase().includes("submit"))) {
      throw new Error("Submit was touched");
    }
    core = {
      scenario,
      terminal: projectTerminal(polled.terminal),
      progress: {
        status: polled.progress.status,
        completedSteps: polled.progress.completedSteps,
        monotonic: true,
      },
      verifiedFields,
      finalPage,
      submitTouched: false,
      failure,
      browserEffects: {
        observeCalls: scenario === "happy" ? browser.observations.length : observeCalls,
        mutations: browser.mutations.length,
        navigations: browser.navigations.length,
      },
      terminalCount: 1,
      events: events.map(({ kind, component, phase, step }) => ({
        kind,
        component,
        phase,
        step,
      })),
      evidence: evidenceResult.value.records.map(projectEvidence).sort(compareProjection),
    };
  } finally {
    try {
      await runtime?.close();
      if (fixtureTarget !== undefined) await assertFixtureClosed(fixtureTarget);
    } catch (error) {
      cleanupFailure = error;
    }
    sourceBytes.fill(0);
    await rm(root, { recursive: true, force: true });
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (sourceBytes.some((byte) => byte !== 0)) {
    throw new Error("acceptance-owned resume bytes were not disposed");
  }
  await access(root).then(
    () => { throw new Error("acceptance temporary root was not removed"); },
    () => undefined,
  );
  if (core === undefined) throw new Error("scenario did not produce a projection");
  return {
    ...core,
    privacy: { sentinelsAbsent: true, resumeBytesDisposed: true },
    cleanupVerified: true,
  };
}

async function pollTerminal(
  api: McpJourneyApi,
  journeyId: TerminalResult["journeyId"],
  scope: string,
): Promise<{ readonly terminal: TerminalResult; readonly progress: JourneyProgress }> {
  const deadline = Date.now() + 30_000;
  const progress: JourneyProgress[] = [];
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const status = await api.handle({
      schemaVersion: 2,
      requestId: mcpRequestId(`request-t2-${scope}-status-${String(attempt).padStart(4, "0")}`),
      method: "journey_status",
      params: { journeyId },
    }, new AbortController().signal);
    if (status.ok && status.value.ok && status.value.result.kind === "status") {
      progress.push(status.value.result.progress);
      assertMonotonic(progress);
    } else if (
      !status.ok ||
      status.value.ok ||
      !["progress_not_found", "journey_busy"].includes(status.value.error.code)
    ) {
      throw new Error(`unexpected MCP status: ${JSON.stringify(status)}`);
    }

    const result = await api.handle({
      schemaVersion: 2,
      requestId: mcpRequestId(`request-t2-${scope}-result-${String(attempt).padStart(4, "0")}`),
      method: "journey_result",
      params: { journeyId },
    }, new AbortController().signal);
    if (result.ok && result.value.ok && result.value.result.kind === "terminal") {
      const finalStatus = await api.handle({
        schemaVersion: 2,
        requestId: mcpRequestId(`request-t2-${scope}-status-final`),
        method: "journey_status",
        params: { journeyId },
      }, new AbortController().signal);
      if (!finalStatus.ok || !finalStatus.value.ok || finalStatus.value.result.kind !== "status") {
        throw new Error(`final MCP status failed: ${JSON.stringify(finalStatus)}`);
      }
      progress.push(finalStatus.value.result.progress);
      assertMonotonic(progress);
      return {
        terminal: result.value.result.terminal,
        progress: finalStatus.value.result.progress,
      };
    }
    if (!result.ok || result.value.ok || result.value.error.code !== "journey_busy") {
      throw new Error(`unexpected MCP result: ${JSON.stringify(result)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("MCP journey did not reach a terminal result");
}

function assertMonotonic(progress: readonly JourneyProgress[]): void {
  for (let index = 1; index < progress.length; index += 1) {
    if (progress[index]!.completedSteps < progress[index - 1]!.completedSteps) {
      throw new Error("journey progress regressed");
    }
  }
}

function projectVerifiedFields(
  observations: readonly import("../../../src/contracts/index.ts").BrowserObservation[],
  resumeSha256: string,
): FieldProjection[] {
  return requiredFieldFlowCases.map((field) => {
    const readbacks = observations.flatMap(({ targets }) =>
      targets.filter(({ name, required }) => required && name === field.fieldLabel)
        .map(({ readback }) => readback)
    );
    if (!readbacks.some((readback) => verifiedReadback(field.behavior, readback, resumeSha256))) {
      throw new Error(`required field was not independently verified: ${field.fieldId}`);
    }
    return { fieldId: field.fieldId, behavior: field.behavior, verification: "verified" };
  });
}

function verifiedReadback(
  behavior: FieldProjection["behavior"],
  readback: BrowserReadback,
  resumeSha256: string,
): boolean {
  if (behavior === "checkbox") return readback.kind === "checked" && readback.checked;
  if (["radio", "select", "listbox"].includes(behavior)) {
    return readback.kind === "selected" && readback.option !== null;
  }
  if (behavior === "file_upload") {
    return readback.kind === "upload" && readback.sha256 === resumeSha256;
  }
  return readback.kind === "text" && readback.value.length > 0;
}

function projectFailure(
  scenario: Scenario,
  reports: readonly FailureReport[],
  journeyId: TerminalResult["journeyId"],
): ScenarioProjection["failure"] {
  if (scenario === "happy") {
    if (reports.length !== 0) throw new Error("happy journey emitted a failure report");
    return null;
  }
  if (reports.length !== 1) {
    throw new Error(`expected one factual failure report, received ${reports.length}`);
  }
  const context = reports[0]!.context;
  const expected = {
    journeyId,
    component: "F3",
    phase: "browser",
    step: "observe",
    code: "browser_target_invalid",
    retryable: false,
    source: context.source,
  } as const;
  if (!isDeepStrictEqual(context, expected) || context.source.kind !== "operation") {
    throw new Error(`unexpected factual failure report: ${JSON.stringify(context)}`);
  }
  return {
    component: "F3",
    phase: "browser",
    step: "observe",
    code: "browser_target_invalid",
    retryable: false,
  };
}

function assertScenarioOutcome(
  scenario: Scenario,
  terminal: TerminalResult,
  finalPage: "review" | null,
): void {
  const expected = scenario === "happy"
    ? { status: "review_reached", completedPages: 3, finalPage: "review" }
    : {
        status: "failed",
        completedPages: 0,
        errorCode: "browser_target_invalid",
        finalPage: null,
      };
  const projected = {
    status: terminal.status,
    completedPages: terminal.completedPages,
    ...(terminal.status === "failed" ? { errorCode: terminal.errorCode } : {}),
    finalPage,
  };
  if (!isDeepStrictEqual(projected, expected)) {
    throw new Error(`unexpected ${scenario} terminal: ${JSON.stringify(projected)}`);
  }
}

function projectTerminal(terminal: TerminalResult): TerminalProjection {
  const { status, completedPages } = terminal;
  if (status === "failed") return { status, completedPages, errorCode: terminal.errorCode };
  if (status === "blocked") {
    return { status, completedPages, factualOutcome: terminal.factualOutcome };
  }
  return { status, completedPages };
}

function projectEvidence(record: EvidenceRecord): EvidenceProjection {
  return {
    kind: record.kind,
    component: record.component,
    phase: record.phase,
    step: record.step,
    sha256: record.sha256,
  };
}

function compareProjection(left: EvidenceProjection, right: EvidenceProjection): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

async function readEvents(path: string): Promise<EventEnvelope[]> {
  const serialized = await readFile(path, "utf8");
  return serialized.trim().split("\n").filter(Boolean)
    .map((line) => parseEventEnvelope(JSON.parse(line) as unknown));
}

async function readPersistedText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(await readPersistedText(path));
    else if (entry.isFile()) values.push(await readFile(path, "utf8"));
  }
  return values.join("\n");
}

function assertNoSentinels(serialized: string): void {
  for (const sentinel of privateSentinels) {
    if (serialized.includes(sentinel)) throw new Error(`private sentinel persisted: ${sentinel}`);
  }
}

async function assertFixtureClosed(target: string): Promise<void> {
  try {
    await fetch(target, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return;
  }
  throw new Error("fixture remained reachable after cleanup");
}

function assertSameScenario(runs: readonly ScenarioProjection[]): void {
  if (runs.length !== 3 || !isDeepStrictEqual(runs[0], runs[1]) || !isDeepStrictEqual(runs[0], runs[2])) {
    throw new Error("three clean scenario projections were not identical");
  }
}

function assertSanitizedReport(report: S1AcceptanceReport): void {
  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized) > MAX_ACCEPTANCE_REPORT_BYTES) {
    throw new Error("acceptance report exceeds 64 KiB");
  }
  assertNoSentinels(serialized);
  for (const forbidden of ["http://", "https://", "base64", "requestId", "journeyId", "operationId", "reportId", "eventId", "evidenceId", '"path"', '"message"']) {
    if (serialized.includes(forbidden)) {
      throw new Error(`volatile or private report field present: ${forbidden}`);
    }
  }
}
