import {
  boundedText,
  browserPageId,
  browserTargetToken,
  fieldId,
  mcpRequestId,
  optionId,
  sha256Digest,
  type BrowserControl,
  type BrowserObservation,
  type BrowserReadback,
  type FieldIntent,
  type FieldObservation,
  type McpRequest,
} from "../../contracts/index.ts";
import { isDeepStrictEqual } from "node:util";
import { assertProviderConformance, contractPortOperations } from "./conformance.ts";
import { requiredFieldFlowCases } from "./field-flow-cases.ts";
import { contractFixtures } from "./fixtures.ts";
import {
  createAnswerResolverFake,
  createBrowserSessionFake,
  createCompletionNavigationFake,
  createFieldDriverFake,
  createFieldVerifierFake,
  createPageUnderstandingFake,
} from "./fakes.ts";
import {
  contractProviderFactories,
  createContractProviderFactory,
  type ContractProviderFactory,
} from "./provider-factories.ts";
import { statefulScenarioProviderFactories } from "./scenarios.ts";
import type { ContractPortMap, ContractPortName } from "./types.ts";

export type CompatibilityProbeReport =
  | {
      readonly root: "F2-F8-field-slice";
      readonly edges: readonly string[];
      readonly controls: readonly string[];
      readonly controlEvidence: readonly {
        readonly fieldId: string;
        readonly questionId: string;
        readonly behavior: string;
      }[];
      readonly ports: readonly string[];
      readonly evidence: "canonical-fake-kit-only";
    }
  | {
      readonly root: "MCP-F9-F4-F10-F11-control-slice";
      readonly edges: readonly string[];
      readonly ports: readonly string[];
      readonly evidence: "canonical-fake-kit-only";
    };

interface FieldProbeFactories {
  readonly FixtureRuntime: ContractProviderFactory<"FixtureRuntime">;
  readonly BrowserSession: ContractProviderFactory<"BrowserSession">;
  readonly PageUnderstanding: ContractProviderFactory<"PageUnderstanding">;
  readonly AnswerResolver: ContractProviderFactory<"AnswerResolver">;
  readonly FieldDriver: ContractProviderFactory<"FieldDriver">;
  readonly FieldVerifier: ContractProviderFactory<"FieldVerifier">;
  readonly CompletionNavigation: ContractProviderFactory<"CompletionNavigation">;
}

interface FieldControlFactories {
  readonly BrowserSession: ContractProviderFactory<"BrowserSession">;
  readonly PageUnderstanding: ContractProviderFactory<"PageUnderstanding">;
  readonly AnswerResolver: ContractProviderFactory<"AnswerResolver">;
  readonly FieldDriver: ContractProviderFactory<"FieldDriver">;
  readonly FieldVerifier: ContractProviderFactory<"FieldVerifier">;
  readonly CompletionNavigation: ContractProviderFactory<"CompletionNavigation">;
}

type FieldProbeOverrides = Partial<FieldProbeFactories> & {
  readonly control?: Partial<FieldControlFactories>;
};

interface ControlProbeFactories {
  readonly McpJourneyApi: ContractProviderFactory<"McpJourneyApi">;
  readonly JourneyControl: ContractProviderFactory<"JourneyControl">;
  readonly JourneyIntake: ContractProviderFactory<"JourneyIntake">;
  readonly JourneyStateStore: ContractProviderFactory<"JourneyStateStore">;
  readonly ProfileQuery: ContractProviderFactory<"ProfileQuery">;
  readonly EventSink: ContractProviderFactory<"EventSink">;
  readonly ProgressReader: ContractProviderFactory<"ProgressReader">;
  readonly FailureReporter: ContractProviderFactory<"FailureReporter">;
  readonly PrivacyGuard: ContractProviderFactory<"PrivacyGuard">;
  readonly SafetyGuard: ContractProviderFactory<"SafetyGuard">;
  readonly EvidenceStore: ContractProviderFactory<"EvidenceStore">;
}

const fieldDefaults: FieldProbeFactories = {
  FixtureRuntime: contractProviderFactories.FixtureRuntime,
  BrowserSession: contractProviderFactories.BrowserSession,
  PageUnderstanding: contractProviderFactories.PageUnderstanding,
  AnswerResolver: contractProviderFactories.AnswerResolver,
  FieldDriver: contractProviderFactories.FieldDriver,
  FieldVerifier: contractProviderFactories.FieldVerifier,
  CompletionNavigation: contractProviderFactories.CompletionNavigation,
};

const controlDefaults: ControlProbeFactories = {
  McpJourneyApi: statefulScenarioProviderFactories.McpJourneyApi,
  JourneyControl: contractProviderFactories.JourneyControl,
  JourneyIntake: contractProviderFactories.JourneyIntake,
  JourneyStateStore: contractProviderFactories.JourneyStateStore,
  ProfileQuery: contractProviderFactories.ProfileQuery,
  EventSink: contractProviderFactories.EventSink,
  ProgressReader: contractProviderFactories.ProgressReader,
  FailureReporter: contractProviderFactories.FailureReporter,
  PrivacyGuard: contractProviderFactories.PrivacyGuard,
  SafetyGuard: contractProviderFactories.SafetyGuard,
  EvidenceStore: contractProviderFactories.EvidenceStore,
};

const edgeByPort = {
  FixtureRuntime: {
    start: "F2.fixture.start",
    reset: "F2.fixture.reset",
    setFault: "F2.fixture.setFault",
  },
  BrowserSession: {
    start: "F3.browser.start",
    observe: "F3.browser.observe",
    mutate: "F3.browser.mutate",
    navigate: "F3.browser.navigate",
    close: "F3.browser.close",
  },
  PageUnderstanding: { understand: "F5.understanding.understand" },
  AnswerResolver: { resolve: "F6.answers.resolve" },
  FieldDriver: { drive: "F7.driver.drive" },
  FieldVerifier: { verify: "F8.verifier.verify" },
  CompletionNavigation: {
    complete: "F8.navigation.complete",
    reconcile: "F8.navigation.reconcile",
  },
  JourneyControl: {
    start: "F9.journey.start",
    cancel: "F9.journey.cancel",
    status: "F9.journey.status",
    result: "F9.journey.result",
  },
  JourneyIntake: { bootstrap: "F4.intake.bootstrap" },
  JourneyStateStore: {
    load: "F4.state.load",
    transition: "F4.state.transition",
  },
  ProfileQuery: { query: "F4.profile.query" },
  EventSink: { append: "F10.events.append" },
  ProgressReader: { read: "F10.progress.read" },
  FailureReporter: { report: "F10.failure.report" },
  PrivacyGuard: { admit: "F11.privacy.admit" },
  SafetyGuard: { admit: "F11.safety.admit" },
  EvidenceStore: {
    write: "F11.evidence.write",
    read: "F11.evidence.read",
  },
} as const;

async function proveProvider<N extends keyof typeof edgeByPort & ContractPortName>(
  name: N,
  factory: ContractProviderFactory<N>,
): Promise<string[]> {
  const lease = factory.create();
  let edges: string[] = [];
  try {
    await assertProviderConformance(name, lease.provider);
    const operations = contractPortOperations[name] as readonly string[];
    const calls = lease.calls.map(({ operation }) => operation);
    for (const operation of operations) {
      if (calls.filter((called) => called === operation).length !== 2) {
        throw new TypeError(`${name}.${operation} call log mismatch`);
      }
    }
    edges = operations.map((operation) => {
      const edge = (edgeByPort[name] as Record<string, string>)[operation];
      if (edge === undefined) throw new TypeError(`${name}.${operation} has no probe edge`);
      return edge;
    });
  } finally {
    await lease.cleanup();
  }
  if (!lease.cleaned) throw new TypeError(`${name} cleanup was not confirmed`);
  return edges;
}

type FieldFlowCase = (typeof requiredFieldFlowCases)[number];

function controlShape(fieldCase: FieldFlowCase): { control: BrowserControl; readback: BrowserReadback } {
  const behavior = fieldCase.behavior;
  if (behavior === "textarea") return { control: { kind: "text", element: "textarea" }, readback: { kind: "text", value: boundedText("Synthetic answer") } };
  if (behavior === "date") return { control: { kind: "date", element: "input" }, readback: { kind: "text", value: boundedText("2026-08-01") } };
  if (behavior === "radio") {
    return {
      control: { kind: "choice", element: "input", choice: "radio", group: boundedText(fieldCase.questionLabel), checked: true },
      readback: { kind: "selected", option: boundedText(fieldCase.options[0].label) },
    };
  }
  if (behavior === "checkbox") return {
    control: { kind: "choice", element: "input", choice: "checkbox", group: boundedText(fieldCase.questionLabel), checked: true },
    readback: { kind: "checked", checked: true },
  };
  if (behavior === "select" || behavior === "listbox") {
    return {
      control: { kind: "select", element: behavior === "select" ? "select" : "listbox", options: fieldCase.options.map(({ label }) => boundedText(label)) },
      readback: { kind: "selected", option: boundedText(fieldCase.options[0].label) },
    };
  }
  if (behavior === "file_upload") return {
    control: { kind: "file", element: "input" },
    readback: { kind: "upload", resumeId: contractFixtures.resume.resumeId, sha256: sha256Digest(contractFixtures.resume.sha256) },
  };
  return { control: { kind: "text", element: "input" }, readback: { kind: "text", value: boundedText("Synthetic answer") } };
}

function canonicalObservation(fieldCase: FieldFlowCase): BrowserObservation {
  const shape = controlShape(fieldCase);
  return {
    ...contractFixtures.browserObservation,
    pageId: browserPageId("page-profile"),
    targets: [{
      token: browserTargetToken(`target-${fieldCase.fieldId}`),
      name: boundedText(fieldCase.fieldLabel),
      required: true,
      state: { visibility: "visible", enabled: true, actionable: true },
      ...shape,
    }],
  };
}

function semanticField(fieldCase: FieldFlowCase, observation: BrowserObservation): FieldObservation {
  const target = observation.targets[0];
  if (target === undefined) throw new TypeError("canonical observation has no target");
  return {
    fieldId: fieldId(fieldCase.fieldId),
    target: target.token,
    label: boundedText(fieldCase.fieldLabel),
    required: true,
    behavior: fieldCase.behavior,
    options: fieldCase.options.map(({ id, label }) => ({ id: optionId(id), label: boundedText(label) })),
    state: "populated",
  };
}

function fieldIntent(fieldCase: FieldFlowCase, field: FieldObservation): FieldIntent {
  if (fieldCase.behavior === "text" || fieldCase.behavior === "textarea") return {
    kind: "text", behavior: fieldCase.behavior, fieldId: field.fieldId, target: field.target,
    value: "Synthetic answer", provenance: "owner_provided",
  };
  if (fieldCase.behavior === "radio" || fieldCase.behavior === "select" || fieldCase.behavior === "listbox") {
    const option = field.options[0];
    if (option === undefined) throw new TypeError(`${fieldCase.fieldId} option is required`);
    return { kind: "choice", behavior: fieldCase.behavior, fieldId: field.fieldId, target: field.target, optionId: option.id, expectedOption: option.label, provenance: "owner_provided" };
  }
  if (fieldCase.behavior === "checkbox") return { kind: "toggle", behavior: "checkbox", fieldId: field.fieldId, target: field.target, checked: true, provenance: "owner_provided" };
  if (fieldCase.behavior === "date") return { kind: "date", behavior: "date", fieldId: field.fieldId, target: field.target, isoDate: "2026-08-01", provenance: "owner_provided" };
  return { kind: "resume_upload", behavior: "file_upload", fieldId: field.fieldId, target: field.target, artifact: contractFixtures.resumeArtifact, provenance: "resume_verified" };
}

function rowForField(id: string): FieldFlowCase {
  const row = requiredFieldFlowCases.find(({ fieldId: candidate }) => candidate === id);
  if (row === undefined) throw new TypeError(`${id} is not a canonical field`);
  return row;
}

const fieldControlDefaults: FieldControlFactories = {
  BrowserSession: createContractProviderFactory("BrowserSession", () =>
    createBrowserSessionFake({ observe: (_request, _signal, callIndex) => ({ ok: true, value: canonicalObservation(requiredFieldFlowCases[callIndex] ?? requiredFieldFlowCases[0]) }) }),
  ),
  PageUnderstanding: createContractProviderFactory("PageUnderstanding", () =>
    createPageUnderstandingFake({
      understand: (request) => {
        const target = request.observation.targets[0];
        if (target === undefined) throw new TypeError("observation target missing");
        const row = requiredFieldFlowCases.find(({ fieldId: candidate }) => target.token === `target-${candidate}`);
        if (row === undefined) throw new TypeError("observation target is not canonical");
        return { ok: true, value: { kind: "understood", snapshot: { pageIdentity: { kind: "workday", page: "profile" }, fields: [semanticField(row, request.observation)] } } };
      },
    }),
  ),
  AnswerResolver: createContractProviderFactory("AnswerResolver", () =>
    createAnswerResolverFake({
      resolve: (request) => {
        const row = rowForField(request.field.fieldId);
        return { ok: true, value: { kind: "resolved", intent: fieldIntent(row, request.field) } };
      },
    }),
  ),
  FieldDriver: createContractProviderFactory("FieldDriver", () =>
    createFieldDriverFake({ drive: (request) => ({ ok: true, value: { operationId: request.operationId, fieldId: request.intent.fieldId, behavior: request.intent.behavior, attempted: true } }) }),
  ),
  FieldVerifier: createContractProviderFactory("FieldVerifier", () =>
    createFieldVerifierFake({ verify: (request) => ({ ok: true, value: { kind: "verified", fieldId: request.intent.fieldId } }) }),
  ),
  CompletionNavigation: createContractProviderFactory("CompletionNavigation", () => createCompletionNavigationFake()),
};

async function proveAllControlShapes(
  factories: FieldControlFactories,
): Promise<{ controls: string[]; evidence: { fieldId: string; questionId: string; behavior: string }[] }> {
  const browser = factories.BrowserSession.create();
  const understanding = factories.PageUnderstanding.create();
  const answers = factories.AnswerResolver.create();
  const driver = factories.FieldDriver.create();
  const verifier = factories.FieldVerifier.create();
  const completion = factories.CompletionNavigation.create();
  const controls: string[] = [];
  const evidence: { fieldId: string; questionId: string; behavior: string }[] = [];
  try {
    for (const fieldCase of requiredFieldFlowCases) {
      const signal = new AbortController().signal;
      const observeRequest = { sessionId: contractFixtures.browserObservation.sessionId, pageId: contractFixtures.browserObservation.pageId };
      const observed = await browser.provider.observe(observeRequest, signal);
      const expectedObservation = canonicalObservation(fieldCase);
      if (!observed.ok || !isDeepStrictEqual(observed.value, expectedObservation)) throw new TypeError(`${fieldCase.fieldId} canonical observation mismatch`);
      if (browser.calls.at(-1)?.request !== observeRequest) throw new TypeError(`${fieldCase.fieldId} browser call log mismatch`);

      const understandRequest = { observation: observed.value };
      const understood = await understanding.provider.understand(understandRequest, signal);
      const expectedField = semanticField(fieldCase, observed.value);
      if (!understood.ok || understood.value.kind !== "understood" || !isDeepStrictEqual(understood.value.snapshot.fields[0], expectedField)) throw new TypeError(`${fieldCase.fieldId} semantic field mismatch`);
      if (understanding.calls.at(-1)?.request !== understandRequest) throw new TypeError(`${fieldCase.fieldId} semantic call log mismatch`);

      const field = understood.value.snapshot.fields[0];
      if (field === undefined) throw new TypeError(`${fieldCase.fieldId} semantic field missing`);
      const answerRequest = { field, profileId: contractFixtures.profile.profileId, profileRevision: contractFixtures.profile.revision, resume: contractFixtures.resume, resumeArtifact: contractFixtures.resumeArtifact };
      const answered = await answers.provider.resolve(answerRequest, signal);
      if (!answered.ok || answered.value.kind !== "resolved" || answered.value.intent.fieldId !== field.fieldId || answered.value.intent.behavior !== fieldCase.behavior) throw new TypeError(`${fieldCase.fieldId} answer intent mismatch`);
      if (answers.calls.at(-1)?.request !== answerRequest) throw new TypeError(`${fieldCase.fieldId} answer call log mismatch`);

      const driveRequest = {
        journeyId: contractFixtures.journeyState.journeyId,
        sessionId: observed.value.sessionId,
        pageId: observed.value.pageId,
        guardRevision: contractFixtures.safetyAdmission.guardRevision,
        operationId: contractFixtures.mutationReceipt.operationId,
        intent: answered.value.intent,
      };
      const driven = await driver.provider.drive(driveRequest, signal);
      if (!driven.ok || driven.value.fieldId !== field.fieldId || driven.value.behavior !== fieldCase.behavior) throw new TypeError(`${fieldCase.fieldId} driver handoff mismatch`);
      if (driver.calls.at(-1)?.request !== driveRequest) throw new TypeError(`${fieldCase.fieldId} driver call log mismatch`);

      const verifyRequest = { sessionId: observed.value.sessionId, pageId: observed.value.pageId, intent: answered.value.intent, receipt: driven.value };
      const verified = await verifier.provider.verify(verifyRequest, signal);
      if (!verified.ok || verified.value.kind !== "verified" || verified.value.fieldId !== field.fieldId) throw new TypeError(`${fieldCase.fieldId} readback verification mismatch`);
      if (verifier.calls.at(-1)?.request !== verifyRequest) throw new TypeError(`${fieldCase.fieldId} verifier call log mismatch`);

      const completeRequest = { page: understood.value.snapshot, verification: [verified.value] };
      const completed = await completion.provider.complete(completeRequest, signal);
      if (!completed.ok || completed.value.kind !== "complete") throw new TypeError(`${fieldCase.fieldId} completion mismatch`);
      if (completion.calls.at(-1)?.request !== completeRequest) throw new TypeError(`${fieldCase.fieldId} completion call log mismatch`);

      controls.push(fieldCase.fieldId);
      evidence.push({ fieldId: fieldCase.fieldId, questionId: fieldCase.questionId, behavior: fieldCase.behavior });
    }
  } finally {
    await browser.cleanup();
    await understanding.cleanup();
    await answers.cleanup();
    await driver.cleanup();
    await verifier.cleanup();
    await completion.cleanup();
  }
  if (controls.length !== 10 || new Set(controls).size !== 10) throw new TypeError("field probe must cover ten unique controls");
  for (const lease of [browser, understanding, answers, driver, verifier, completion]) {
    if (!lease.cleaned || lease.calls.length !== 10) throw new TypeError("canonical control provider cleanup/call count mismatch");
  }
  return { controls, evidence };
}

export async function runFieldSliceCompatibilityProbe(
  overrides: FieldProbeOverrides = {},
): Promise<Extract<CompatibilityProbeReport, { readonly root: "F2-F8-field-slice" }>> {
  const factories = { ...fieldDefaults, ...overrides };
  const edges = [
    ...await proveProvider("FixtureRuntime", factories.FixtureRuntime),
    "F2.fixture.cleanup-as-fixture-close",
    ...await proveProvider("BrowserSession", factories.BrowserSession),
    ...await proveProvider("PageUnderstanding", factories.PageUnderstanding),
    ...await proveProvider("AnswerResolver", factories.AnswerResolver),
    ...await proveProvider("FieldDriver", factories.FieldDriver),
    ...await proveProvider("FieldVerifier", factories.FieldVerifier),
    ...await proveProvider("CompletionNavigation", factories.CompletionNavigation),
  ];
  const controlFactories = { ...fieldControlDefaults, ...overrides.control };
  const controlProof = await proveAllControlShapes(controlFactories);
  return {
    root: "F2-F8-field-slice",
    edges,
    controls: controlProof.controls,
    controlEvidence: controlProof.evidence,
    ports: ["FixtureRuntime", "BrowserSession", "PageUnderstanding", "AnswerResolver", "FieldDriver", "FieldVerifier", "CompletionNavigation", "F2-F8-field-slice"],
    evidence: "canonical-fake-kit-only",
  };
}

async function proveMcpMethods(factory: ContractProviderFactory<"McpJourneyApi">): Promise<string[]> {
  const lease = factory.create();
  const signal = new AbortController().signal;
  const journeyId = contractFixtures.journeyState.journeyId;
  const requests: readonly McpRequest[] = [
    { schemaVersion: 2, requestId: mcpRequestId("probe-start"), method: "start_journey", params: { jobId: contractFixtures.job.jobId, resumeId: contractFixtures.resume.resumeId, profileId: contractFixtures.profile.profileId } },
    { schemaVersion: 2, requestId: mcpRequestId("probe-cancel"), method: "cancel_journey", params: { journeyId } },
    { schemaVersion: 2, requestId: mcpRequestId("probe-status"), method: "journey_status", params: { journeyId } },
    { schemaVersion: 2, requestId: mcpRequestId("probe-result"), method: "journey_result", params: { journeyId } },
  ];
  const edges: string[] = [];
  try {
    for (const request of requests) {
      const result = await lease.provider.handle(request, signal);
      if (!result.ok || !result.value.ok) throw new TypeError(`MCP ${request.method} failed`);
      const expectedKind = request.method === "journey_status" ? "status" : request.method === "journey_result" ? "terminal" : "accepted";
      if (result.value.result.kind !== expectedKind) throw new TypeError(`MCP ${request.method} handoff mismatch`);
      edges.push(`MCP.handle.${request.method}`);
    }
    if (
      lease.calls.length !== requests.length ||
      lease.calls.some(({ operation, request }, index) =>
        operation !== "handle" || request !== requests[index]
      )
    ) throw new TypeError("MCP handle call log mismatch");
  } finally {
    await lease.cleanup();
  }
  if (!lease.cleaned) throw new TypeError("McpJourneyApi cleanup was not confirmed");
  return edges;
}

export async function runControlSliceCompatibilityProbe(
  overrides: Partial<ControlProbeFactories> = {},
): Promise<Extract<CompatibilityProbeReport, { readonly root: "MCP-F9-F4-F10-F11-control-slice" }>> {
  const factories = { ...controlDefaults, ...overrides };
  const journeyEdges = await proveProvider("JourneyControl", factories.JourneyControl);
  const journeyOrder = [
    "F9.journey.start",
    "F9.journey.cancel",
    "F9.journey.status",
    "F9.journey.result",
  ];
  journeyEdges.sort((left, right) => journeyOrder.indexOf(left) - journeyOrder.indexOf(right));
  const edges = [
    ...await proveMcpMethods(factories.McpJourneyApi),
    ...journeyEdges,
    ...await proveProvider("JourneyIntake", factories.JourneyIntake),
    ...await proveProvider("JourneyStateStore", factories.JourneyStateStore),
    ...await proveProvider("ProfileQuery", factories.ProfileQuery),
    ...await proveProvider("EventSink", factories.EventSink),
    ...await proveProvider("ProgressReader", factories.ProgressReader),
    ...await proveProvider("FailureReporter", factories.FailureReporter),
    ...await proveProvider("PrivacyGuard", factories.PrivacyGuard),
    ...await proveProvider("SafetyGuard", factories.SafetyGuard),
    ...await proveProvider("EvidenceStore", factories.EvidenceStore),
  ];
  return {
    root: "MCP-F9-F4-F10-F11-control-slice",
    edges,
    ports: ["McpJourneyApi", "JourneyControl", "JourneyIntake", "JourneyStateStore", "ProfileQuery", "EventSink", "ProgressReader", "FailureReporter", "PrivacyGuard", "SafetyGuard", "EvidenceStore", "MCP-F9-F4-F10-F11-control-slice"],
    evidence: "canonical-fake-kit-only",
  };
}

export const canonicalProbeRegistry = [
  {
    root: "F2-F8-field-slice",
    edges: [
      ...Object.values(edgeByPort.FixtureRuntime),
      "F2.fixture.cleanup-as-fixture-close",
      ...Object.values(edgeByPort.BrowserSession),
      ...Object.values(edgeByPort.PageUnderstanding),
      ...Object.values(edgeByPort.AnswerResolver),
      ...Object.values(edgeByPort.FieldDriver),
      ...Object.values(edgeByPort.FieldVerifier),
      ...Object.values(edgeByPort.CompletionNavigation),
    ],
    skip: false,
    evidence: "canonical-fake-kit-only",
  },
  {
    root: "MCP-F9-F4-F10-F11-control-slice",
    edges: [
      "MCP.handle.start_journey",
      "MCP.handle.cancel_journey",
      "MCP.handle.journey_status",
      "MCP.handle.journey_result",
      ...Object.values(edgeByPort.JourneyControl),
      ...Object.values(edgeByPort.JourneyIntake),
      ...Object.values(edgeByPort.JourneyStateStore),
      ...Object.values(edgeByPort.ProfileQuery),
      ...Object.values(edgeByPort.EventSink),
      ...Object.values(edgeByPort.ProgressReader),
      ...Object.values(edgeByPort.FailureReporter),
      ...Object.values(edgeByPort.PrivacyGuard),
      ...Object.values(edgeByPort.SafetyGuard),
      ...Object.values(edgeByPort.EvidenceStore),
    ],
    skip: false,
    evidence: "canonical-fake-kit-only",
  },
] as const;
