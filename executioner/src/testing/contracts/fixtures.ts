import {
  boundedText,
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
  type ResumeSelection,
  type SemanticPageSnapshot,
  type TerminalResult,
  type VerificationResult,
} from "../../contracts/index.ts";

const job = {
  jobId: "job-synthetic",
  title: "Synthetic role",
  company: "Synthetic company",
  applyUrl: "https://fixture.invalid/apply",
} as const satisfies JobIntake;

const resume = {
  resumeId: "resume-synthetic",
  sha256: "sha256:synthetic-resume",
} as const satisfies ResumeSelection;

const profile = {
  profileId: "profile-synthetic",
  revision: 1,
  facts: [
    {
      factId: "given_name",
      value: "Synthetic",
      provenance: "owner_provided",
    },
  ],
} as const satisfies ApplicantProfile;

const journeyInputs = {
  job,
  resume,
  profile,
} as const satisfies JourneyInputs;

const journeyState = {
  schemaVersion: 1,
  journeyId: "journey-synthetic",
  status: "running",
  pageId: "page-profile",
  revision: 1,
} as const satisfies DurableJourneyState;

const browserObservation = {
  sessionId: "session-synthetic",
  pageId: "page-profile",
  origin: "https://fixture.invalid",
  path: "/profile",
  targets: [
    {
      token: "target-given-name",
      role: "textbox",
      name: boundedText("Given name"),
      required: true,
      options: [],
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
  fieldId: "field-given-name",
  target: "target-given-name",
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
  operationId: "operation-synthetic",
  fieldId: field.fieldId,
  behavior: "text",
  attempted: true,
} as const satisfies MutationReceipt;

const pageSnapshot = {
  pageIdentity: { kind: "workday", page: "profile" },
  fields: [field],
} as const satisfies SemanticPageSnapshot;

const verification = {
  kind: "verified",
  fieldId: field.fieldId,
} as const satisfies VerificationResult;

const event = {
  schemaVersion: 1,
  eventId: "event-synthetic",
  journeyId: journeyState.journeyId,
  component: "F9",
  phase: "orchestration",
  step: "start",
  kind: "step_started",
  at: "2026-07-30T00:00:00.000Z",
  source: { kind: "operation", id: "operation-synthetic" },
} as const satisfies EventEnvelope;

const progress = {
  journeyId: journeyState.journeyId,
  status: "running",
  completedSteps: 0,
} as const satisfies JourneyProgress;

const evidenceRecord = {
  id: "evidence-synthetic",
  kind: "semantic_snapshot",
  component: "F5",
  phase: "page_understanding",
  step: "classify",
  sha256: "sha256:synthetic-evidence",
} as const satisfies EvidenceRecord;

const evidenceManifest = {
  schemaVersion: 1,
  journeyId: journeyState.journeyId,
  records: [evidenceRecord],
} as const satisfies EvidenceManifest;

const terminalResult = {
  schemaVersion: 1,
  journeyId: journeyState.journeyId,
  status: "review_reached",
  completedPages: 3,
} as const satisfies TerminalResult;

export const contractFixtures = {
  job,
  resume,
  profile,
  journeyInputs,
  journeyState,
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
