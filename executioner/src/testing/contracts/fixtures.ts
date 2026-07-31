import {
  admitContractSnapshot,
  bindAdmissionRequest,
  browserPageId,
  browserTargetToken,
  boundedText,
  captureResumeArtifact,
  createGeneratedIdAllocator,
  eventId,
  generatedEvidenceId,
  fieldId,
  generatedJourneyId,
  generatedSessionId,
  guardRevision,
  generatedOperationId,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  type ApplicantProfile,
  type BrowserObservation,
  type DurableJourneyState,
  type EvidenceManifest,
  type EvidenceRecord,
  type EventEnvelope,
  type FieldIntent,
  type FieldObservation,
  type JobIntake,
  type JourneyInputs,
  type JourneyProgress,
  type MutationReceipt,
  type PortResult,
  type ResumeSelection,
  type SemanticPageSnapshot,
  type TerminalResult,
  type VerificationResult,
} from "../../contracts/index.ts";

function fixtureValue<T>(result: PortResult<T, unknown>): T {
  if (!result.ok) throw new Error("invalid deterministic contract fixture id");
  return result.value;
}

const generatedIds = createGeneratedIdAllocator({
  next: () => "0123456789abcdef",
});

const job = {
  jobId: upstreamJobId("job-synthetic"),
  title: "Synthetic role",
  company: "Synthetic company",
  applyUrl: "https://fixture.invalid/apply",
} as const satisfies JobIntake;

const resume = {
  resumeId: upstreamResumeId("resume-synthetic"),
  sha256: "6a5c5b7838b3f7a7bf24b7e9ca49141f10ee68b2e14c9ee43eba3fdecf7173cc",
} as const satisfies ResumeSelection;

export function createResumeArtifactFixture() {
  return fixtureValue(
    captureResumeArtifact(resume, new TextEncoder().encode("synthetic resume")),
  );
}

const profile = {
  profileId: upstreamProfileId("profile-synthetic"),
  revision: 1,
  facts: [
    {
      factId: "given_name",
      value: "Synthetic",
      provenance: "owner_provided",
    },
  ],
} as const satisfies ApplicantProfile;

export function createJourneyInputsFixture(): JourneyInputs {
  return {
    job,
    resume,
    resumeArtifact: createResumeArtifactFixture(),
    profile,
  };
}

const journeyState = {
  schemaVersion: 2,
  journeyId: fixtureValue(generatedJourneyId(generatedIds)),
  status: "running",
  pageId: browserPageId("page-profile"),
  revision: 1,
} as const satisfies DurableJourneyState;

const admissionBinding = {
  journeyId: journeyState.journeyId,
  attemptId: generatedOperationId("operation_0123456789abcdef"),
  guardRevision: guardRevision("policy-s1"),
} as const;
export function createPrivacyAdmissionFixture() {
  return fixtureValue(admitContractSnapshot(
    { policyRevision: "policy-s1", semanticPayload: { fieldId: "field-given-name" } },
    "privacy",
    admissionBinding,
  ));
}
const browserObservation = {
  sessionId: fixtureValue(generatedSessionId(generatedIds)),
  pageId: browserPageId("page-profile"),
  origin: "https://fixture.invalid",
  path: "/profile",
  targets: [
    {
      token: browserTargetToken("target-given-name"),
      name: boundedText("Given name"),
      required: true,
      control: { kind: "text", element: "input" },
      state: {
        visibility: "visible",
        enabled: true,
        actionable: true,
      },
      readback: { kind: "empty" },
    },
  ],
} as const satisfies BrowserObservation;

const field = {
  fieldId: fieldId("field-given-name"),
  target: browserTargetToken("target-given-name"),
  label: boundedText("Given name"),
  required: true,
  behavior: "text",
  options: [],
  state: "empty",
} as const satisfies FieldObservation;

const intent = {
  kind: "text",
  behavior: "text",
  fieldId: field.fieldId,
  target: field.target,
  value: "Synthetic",
  provenance: "owner_provided",
} as const satisfies FieldIntent;

const mutationReceipt = {
  operationId: generatedOperationId("operation_0123456789abcdef"),
  fieldId: field.fieldId,
  behavior: "text",
  attempted: true,
} as const satisfies MutationReceipt;

const mutationSnapshot = {
  policyRevision: admissionBinding.guardRevision,
  capability: "field_mutation",
  effect: {
    kind: "browser_mutation",
    sessionId: browserObservation.sessionId,
    pageId: browserObservation.pageId,
    operationId: mutationReceipt.operationId,
    mutation: {
      kind: "set_text",
      target: field.target,
      text: "Synthetic",
    },
  },
} as const;
export function createSafetyAdmissionFixture() {
  return fixtureValue(
    admitContractSnapshot(mutationSnapshot, "safety", admissionBinding),
  );
}
const pageSnapshot = {
  pageIdentity: { kind: "workday", page: "profile" },
  fields: [field],
} as const satisfies SemanticPageSnapshot;

const verification = {
  kind: "verified",
  fieldId: field.fieldId,
} as const satisfies VerificationResult;

const event = {
  schemaVersion: 2,
  eventId: eventId("event-synthetic"),
  journeyId: journeyState.journeyId,
  component: "F9",
  phase: "orchestration",
  step: "start",
  kind: "step_started",
  at: "2026-07-30T00:00:00.000Z",
  source: { kind: "operation", id: generatedOperationId("operation_0123456789abcdef") },
} as const satisfies EventEnvelope;

const progress = {
  journeyId: journeyState.journeyId,
  status: "running",
  completedSteps: 0,
} as const satisfies JourneyProgress;

const evidenceRecord = {
  id: generatedEvidenceId("evidence_0123456789abcdef"),
  kind: "semantic_snapshot",
  component: "F5",
  phase: "page_understanding",
  step: "classify",
  sha256: "0000000000000000000000000000000000000000000000000000000000000000",
} as const satisfies EvidenceRecord;

const evidenceManifest = {
  schemaVersion: 2,
  journeyId: journeyState.journeyId,
  records: [evidenceRecord],
} as const satisfies EvidenceManifest;
const terminalResult = {
  schemaVersion: 2,
  journeyId: journeyState.journeyId,
  status: "review_reached",
  completedPages: 3,
} as const satisfies TerminalResult;

export const contractFixtures = {
  job,
  resume,
  get resumeArtifact() {
    return createResumeArtifactFixture();
  },
  profile,
  get journeyInputs() {
    return createJourneyInputsFixture();
  },
  journeyState,
  get privacyAdmission() {
    return createPrivacyAdmissionFixture();
  },
  get safetyAdmission() {
    return createSafetyAdmissionFixture();
  },
  browserObservation,
  field,
  intent,
  mutationReceipt,
  pageSnapshot,
  verification,
  event,
  progress,
  evidenceRecord,
  evidenceManifest,
  terminalResult,
} as const;
