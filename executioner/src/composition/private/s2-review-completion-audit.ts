import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import {
  captureStage2Config,
  readStage2AcceptanceManifest,
  readStage2ReviewAcceptance,
} from "../../acceptance/s2-local.ts";
import { admitStage2TerminalArtifact } from "../../acceptance/s2-terminal-artifact.ts";
import type { Stage2ConfigCapture } from "../../acceptance/s2-gate.ts";
import {
  readAccountVerifiedEvidence,
} from "../../live/evidence/account-verified-evidence.ts";
import {
  admitApplicationWalkAcceptance,
  type ApplicationWalkAcceptanceV1,
} from "../../live/evidence/application-walk-evidence.ts";
import {
  admitProfileFieldLearningEvidence,
  type ProfileFieldLearningEvidenceV2,
} from
  "../../live/evidence/profile-field-learning.ts";
import {
  admitPendingProfileQuestionsEvidence,
  admitQuestionAnswerLearningEvidence,
  type PendingProfileQuestionsEvidenceV1,
  type QuestionAnswerLearningEvidenceV2,
} from
  "../../live/evidence/question-answer-learning.ts";
import { testingQuestionSemanticType } from "../../form/answers/testing-policy.ts";
import { readValueFreeRunTrace } from
  "../../live/evidence/value-free-run-trace.ts";
import { writeAtomicJsonEvidence } from "../../live/evidence/private/atomic-json-evidence.ts";
import { readWindowsProcessAudit } from "../../live/evidence/windows-process-audit.ts";
import {
  readStage2AuthMonitorChain,
  readStage2ReviewMonitorChain,
  type Stage2MonitorOperationV1,
} from "../../live/evidence/review-monitor-chain.ts";

const RUN_KEY = /^run_\d{8}_[a-z0-9]{16}$/u;
const REAL_EVIDENCE_FILES = [
  "real-evidence/browser-truth.json",
  "real-evidence/manifest.json",
  "real-evidence/summary.json",
] as const;

export interface Stage2ReviewCompletionAuditV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-review-completion-v1";
  readonly status: "pass";
  readonly sourceRevision: string;
  readonly journeyId: string;
  readonly runStatus: "passed";
  readonly acceptance: "present";
  readonly applicationWalk: "present";
  readonly acceptanceGate: "present";
  readonly realEvidence: "validated";
  readonly accountVerification: "present";
  readonly processBinding: "production_bound";
  readonly processAuditSha256: string;
  readonly terminalArtifactSha256: string;
  readonly profileFieldLearningSha256: string | null;
  readonly questionAnswerLearningSha256: string | null;
  readonly pendingProfileQuestionsSha256: string | null;
  readonly authMonitor: "external_chain_acknowledged";
  readonly monitor: "external_chain_acknowledged";
  readonly monitorClassification: "review_verified";
  readonly processCleanup: "pass";
  readonly privacyScan: "pass";
  readonly submitPresent: true;
  readonly submitActivated: false;
}

export interface Stage2ReviewCompletionInspection {
  readonly audit: Stage2ReviewCompletionAuditV1;
  readonly realEvidenceFiles: typeof REAL_EVIDENCE_FILES;
  readonly monitorFiles: readonly string[];
}

export async function auditStage2ReviewCompletion(
  rootValue: string,
): Promise<Stage2ReviewCompletionAuditV1> {
  try {
    const inspection = inspectStage2ReviewCompletion(rootValue);
    writeAtomicJsonEvidence({
      root: admittedRoot(rootValue),
      value: inspection.audit,
      sensitiveValues: [],
      label: "review completion audit",
      fileName: "completion-audit.json",
    });
    return inspection.audit;
  } catch {
    return denied();
  }
}

export function inspectStage2ReviewCompletion(
  rootValue: string,
): Stage2ReviewCompletionInspection {
  try {
    const root = admittedRoot(rootValue);
    const config = captureStage2Config(ownerConfigPath(root));
    const account = readAccountVerifiedEvidence(root);
    const review = readStage2ReviewAcceptance(root);
    const gate = readStage2AcceptanceManifest(root);
    const application = readApplicationWalk(root);
    const tracePath = join(root, "value-free-trace.ndjson");
    if (!existsSync(tracePath)) denied();
    validateValueFreeTrace(tracePath, application);
    const packet = readRealEvidence(root);
    const terminalArtifactBytes = readStableFile(
      join(root, "terminal-artifact.json"),
      16 * 1024,
    );
    const terminalArtifact = admitStage2TerminalArtifact(
      JSON.parse(terminalArtifactBytes.toString("utf8")),
    );
    const processAudit = readWindowsProcessAudit(root);
    const processBytes = readStableFile(join(root, "process-audit.json"), 16 * 1024);
    const runKey = basename(dirname(root));
    if (
      processAudit.evidenceRevision !== "s2-windows-process-audit-v2" ||
      processAudit.runKey !== runKey || processAudit.journeyId !== config.journeyId ||
      processAudit.targetHandleId !== config.targetHandleId ||
      processAudit.configSha256 !== config.configSha256
    ) denied();
    const targetDigests = ownerTargetDigests(ownerConfigPath(root));
    const monitorExpected = {
      journeyId: config.journeyId,
      targetHandleId: config.targetHandleId,
      sourceRevision: review.sourceRevision,
      configSha256: config.configSha256,
      ...targetDigests,
      processLiveNonceSha256: processAudit.processLiveNonceSha256,
      processIssuedAt: processAudit.processIssuedAt,
      processCheckedAt: processAudit.checkedAt,
      processExitObservedAt: processAudit.processExitObservedAt,
      processInstanceSha256: createHash("sha256").update(
        `s2-process-instance-v1\0${processAudit.processOwnerPid}\0${processAudit.processOwnerStartedAt}`,
        "utf8",
      ).digest("hex"),
    } as const;
    const authMonitor = readStage2AuthMonitorChain(join(root, "auth-monitor"), monitorExpected);
    const monitor = readStage2ReviewMonitorChain(join(root, "monitor"), monitorExpected);
    const profileFieldLearningSha256 = profileLearningDigest(
      application,
      root,
      monitor.operations,
    );
    const questionLearning = questionLearningDigest(
      application,
      root,
      monitor.operations,
    );
    const monitorFiles = [...authMonitor.files, ...monitor.files].sort();
    validateMonitorLedger(
      root,
      monitorFiles,
      processAudit.monitorFileCount,
      processAudit.monitorChainSha256,
    );
    if (
      !sameConfig(review, config) || !sameConfig(gate, config) ||
      account.sourceRevision !== review.sourceRevision || account.revisionId !== config.revisionId ||
      account.approvalId !== config.approvalId || account.journeyId !== config.journeyId ||
      account.targetHandleId !== config.targetHandleId ||
      review.sourceRevision !== gate.sourceRevision ||
      review.sourceRevision !== application.sourceRevision ||
      review.sourceRevision !== packet.sourceRevision ||
      application.revisionId !== config.revisionId ||
      application.approvalId !== config.approvalId ||
      application.journeyId !== config.journeyId ||
      application.targetHandleId !== config.targetHandleId ||
      packet.revisionId !== config.revisionId ||
      packet.approvalId !== config.approvalId ||
      packet.journeyId !== config.journeyId ||
      packet.requiredFieldCount !== application.pageChecks.reduce(
        (total, item) => total + item.verifiedFields,
        0,
      ) ||
      terminalArtifact.resultCode !== "review_reached" ||
      terminalArtifact.terminal.journeyId !== config.journeyId ||
      terminalArtifact.terminal.status !== "review_reached" ||
      terminalArtifact.terminal.completedPages !== application.completedPages ||
      terminalArtifact.cleanupErrorCode !== undefined
    ) denied();
    const audit: Stage2ReviewCompletionAuditV1 = Object.freeze({
      schemaVersion: 1,
      evidenceRevision: "s2-review-completion-v1",
      status: "pass",
      sourceRevision: review.sourceRevision,
      journeyId: review.journeyId,
      runStatus: "passed",
      acceptance: "present",
      applicationWalk: "present",
      acceptanceGate: "present",
      realEvidence: "validated",
      accountVerification: "present",
      processBinding: "production_bound",
      processAuditSha256: digest(processBytes),
      terminalArtifactSha256: digest(terminalArtifactBytes),
      profileFieldLearningSha256,
      questionAnswerLearningSha256: questionLearning.answerLearningSha256,
      pendingProfileQuestionsSha256: questionLearning.pendingProfileSha256,
      authMonitor: "external_chain_acknowledged",
      monitor: "external_chain_acknowledged",
      monitorClassification: "review_verified",
      processCleanup: "pass",
      privacyScan: "pass",
      submitPresent: true,
      submitActivated: false,
    });
    return Object.freeze({
      audit,
      realEvidenceFiles: REAL_EVIDENCE_FILES,
      monitorFiles: Object.freeze(monitorFiles),
    });
  } catch {
    return denied();
  }
}

function questionLearningDigest(
  application: ApplicationWalkAcceptanceV1,
  root: string,
  monitorOperations: readonly Stage2MonitorOperationV1[],
): {
  readonly answerLearningSha256: string | null;
  readonly pendingProfileSha256: string | null;
} {
  const questionnaires = application.laneAcceptances.filter(
    (value) => value.checkpoint === "questionnaire_verified",
  );
  const path = join(root, "question-answer-learning.json");
  const pendingPath = join(root, "pending-profile-questions.json");
  const expectedAnswers = questionnaires.flatMap(({ answers }) => answers);
  if (questionnaires.length === 0) {
    if (existsSync(path) || existsSync(pendingPath)) denied();
    return Object.freeze({ answerLearningSha256: null, pendingProfileSha256: null });
  }
  const bytes = readStableFile(path, 128 * 1024);
  const learning = admitQuestionAnswerLearningEvidence(JSON.parse(bytes.toString("utf8")));
  const pendingBytes = readStableFile(pendingPath, 128 * 1024);
  const pending = admitPendingProfileQuestionsEvidence(
    JSON.parse(pendingBytes.toString("utf8")),
  );
  validatePendingProfileQuestions(learning, pending);
  if (expectedAnswers.length === 0) {
    const questionnaireChecks = application.pageChecks.filter(({ page }) =>
      page === "questionnaire"
    );
    const requiredQuestions = questionnaireChecks.reduce(
      (count, { requiredFields }) => count + requiredFields,
      0,
    );
    if (
      questionnaires.length !== 1 ||
      questionnaireChecks.length === 0 ||
      learning.executionMode !== "synthetic_test_non_submittable" ||
      !learning.testOnly ||
      learning.liveAcceptanceEligible ||
      !learning.questions.some(({ lane }) => lane === "synthetic_test_default") ||
      learning.questions.filter(({ required }) => required).length !== requiredQuestions ||
      learning.questions.some(({ answerState, lane, verificationResult, monitorBinding }) =>
        answerState !== "answered" || lane === null ||
        verificationResult !== "verified" || monitorBinding === null
      )
    ) denied();
    validateControlMonitorBindings(
      learning.questions.flatMap(({ monitorBinding }) =>
        monitorBinding === null ? [] : [monitorBinding]
      ),
      monitorOperations,
      "questionnaire",
      false,
    );
    return Object.freeze({
      answerLearningSha256: digest(bytes),
      pendingProfileSha256: digest(pendingBytes),
    });
  }
  const synthetic = expectedAnswers.some(({ lane }) => lane === "synthetic_test_default");
  if (
    learning.executionMode !== (synthetic ? "synthetic_test_non_submittable" : "live") ||
    learning.testOnly !== synthetic ||
    learning.liveAcceptanceEligible !== !synthetic ||
    learning.questions.length !== expectedAnswers.length ||
    expectedAnswers.some((answer) => {
      const matches = learning.questions.filter((question) =>
        question.fieldId === answer.fieldId &&
        question.questionId === answer.questionId &&
        question.provenance === answer.provenance &&
        question.answerState === "answered" &&
        question.lane === answer.lane &&
        question.lane === answer.lane
      );
      return matches.length !== 1;
    })
  ) denied();
  validateControlMonitorBindings(
    learning.questions.flatMap(({ monitorBinding }) =>
      monitorBinding === null ? [] : [monitorBinding]
    ),
    monitorOperations,
    "questionnaire",
  );
  return Object.freeze({
    answerLearningSha256: digest(bytes),
    pendingProfileSha256: digest(pendingBytes),
  });
}

function validatePendingProfileQuestions(
  learning: QuestionAnswerLearningEvidenceV2,
  pending: PendingProfileQuestionsEvidenceV1,
): void {
  const expected = learning.questions.filter(({ replaceWithOwnerAnswer, provenance }) =>
    replaceWithOwnerAnswer && provenance !== "resume_verified"
  );
  const profilePending = pending.pendingProfileQuestions.filter(({ fieldId }) =>
    fieldId.startsWith("profile.unknown.")
  );
  const questionnairePending = pending.pendingProfileQuestions.filter(({ fieldId }) =>
    !fieldId.startsWith("profile.unknown.")
  );
  if (
    questionnairePending.length !== expected.length ||
    profilePending.some((candidate) =>
      !/^profile\.unknown\.(?:required|optional)\.\d+$/u.test(candidate.fieldId) ||
      candidate.questionId !== `question.${candidate.fieldId}` ||
      candidate.semanticQuestionType !== "unknown" ||
      candidate.actualOwnerValue !== null || !candidate.needsUserValue ||
      candidate.provenance !== "visible_option" || candidate.validation !== "verified" ||
      candidate.testDefault === null || candidate.committedReadback !== candidate.testDefault
    ) ||
    expected.some((question) => {
      const matches = questionnairePending.filter((candidate) =>
        candidate.questionId === question.questionId &&
        candidate.fieldId === question.fieldId &&
        candidate.exactQuestion === question.label &&
        candidate.required === question.required &&
        candidate.semanticQuestionType === testingQuestionSemanticType(question.label) &&
        candidate.answerType === question.answerType &&
        candidate.controlType === question.uiType &&
        candidate.options.length === question.possibleAnswers.length &&
        candidate.options.every((option, index) => option === question.possibleAnswers[index])
      );
      if (matches.length !== 1) return true;
      const candidate = matches[0]!;
      const testDefault = question.answerState === "answered" ? question.chosenAnswer : null;
      return candidate.testDefault !== testDefault ||
        candidate.actualOwnerValue !== null || !candidate.needsUserValue ||
        candidate.provenance !== question.provenance ||
        candidate.validation !== question.verificationResult ||
        candidate.committedReadback !==
          (question.verificationResult === "verified" ? testDefault : null) ||
        (question.answerType === "date"
          ? candidate.constraints === null || !("displayFormat" in candidate.constraints) ||
            candidate.constraints.displayFormat !== "YYYY-MM-DD"
          : candidate.constraints !== null &&
            !(question.answerType === "text" &&
              (question.uiType === "text" || question.uiType === "textarea") &&
              "inputType" in candidate.constraints));
    })
  ) denied();
}

function profileLearningDigest(
  application: ApplicationWalkAcceptanceV1,
  root: string,
  monitorOperations: readonly Stage2MonitorOperationV1[],
): string | null {
  const profiles = application.laneAcceptances.filter(
    (value) => value.checkpoint === "profile_verified",
  );
  const paths = [
    join(root, "profile-field-learning.json"),
    join(root, "profile-field-learning-02.json"),
  ];
  if (profiles.length === 0) {
    if (paths.some(existsSync)) denied();
    return null;
  }
  if (profiles.length > paths.length) denied();
  const profileMonitoredStates = monitorOperations.filter(({ page, moment }) =>
    page === "profile" && moment === "before_navigation"
  );
  const resumeMonitoredStates = monitorOperations.filter(({ page, moment }) =>
    page === "resume" && moment === "before_navigation"
  );
  let latest: string | null = null;
  let profileMonitorIndex = 0;
  let resumeProfileMonitorIndex = 0;
  const monitorGroups = new Map<"profile" | "resume", {
    observations: NonNullable<ProfileFieldLearningEvidenceV2["fields"][number]["observationBinding"]>[];
    mutations: NonNullable<ProfileFieldLearningEvidenceV2["fields"][number]["monitorBinding"]>[];
  }>();
  for (const [index, profile] of profiles.entries()) {
    if (profile.checkpoint !== "profile_verified") denied();
    const sha256 = profile.profileFieldLearningSha256;
    if (sha256 === undefined) {
      if (existsSync(paths[index]!)) denied();
      continue;
    }
    if (!/^[0-9a-f]{64}$/u.test(sha256)) denied();
    const learningBytes = readStableFile(paths[index]!, 256 * 1024);
    const learning = admitProfileFieldLearningEvidence(
      JSON.parse(learningBytes.toString("utf8")),
    );
    const laneIndex = application.laneAcceptances.indexOf(profile);
    const pageCheck = application.pageChecks[laneIndex];
    const precedingLane = laneIndex > 0 ? application.laneAcceptances[laneIndex - 1] : undefined;
    const precedingPageCheck = laneIndex > 0 ? application.pageChecks[laneIndex - 1] : undefined;
    const combinedResumeProfile = precedingLane?.checkpoint === "resume_verified" &&
      precedingPageCheck?.page === "resume";
    const monitoredState = combinedResumeProfile
      ? resumeMonitoredStates[resumeProfileMonitorIndex++]
      : profileMonitoredStates[profileMonitorIndex++];
    const answeredFields = learning.fields.filter(({ answerState }) =>
      answerState === "answered"
    );
    const synthetic = profile.verifiedFields.some(({ lane }) => lane === "synthetic_test_default") ||
      application.laneAcceptances.some((acceptance) =>
        acceptance.checkpoint === "profile_verified" &&
        acceptance.verifiedFields.some(({ lane }) => lane === "synthetic_test_default")
      );
    const matchesVerified = (field: ProfileFieldLearningEvidenceV2["fields"][number]) =>
      profile.verifiedFields.filter((verified) =>
        field.fieldIdentity === `profile.${verified.fieldId}` &&
        field.lane === verified.lane
      ).length === 1;
    if (
      learning.executionMode !== (synthetic ? "synthetic_test_non_submittable" : "live") ||
      learning.testOnly !== synthetic ||
      learning.liveAcceptanceEligible !== !synthetic ||
      pageCheck === undefined || monitoredState === undefined ||
      (learning.visibleControlCount !== monitoredState.fieldCount &&
        (!combinedResumeProfile || learning.visibleControlCount + 1 !== monitoredState.fieldCount)) ||
      learning.fields.filter(({ required }) => required).length !== pageCheck.requiredFields ||
      (combinedResumeProfile
        ? pageCheck.requiredFields + precedingPageCheck.requiredFields !== monitoredState.requiredFieldCount
        : pageCheck.requiredFields !== monitoredState.requiredFieldCount) ||
      answeredFields.filter(matchesVerified).length !== profile.verifiedFields.length ||
      answeredFields.some((field) =>
        !matchesVerified(field) &&
        field.terminalDisposition !== "driver_failed" &&
        field.terminalDisposition !== "verification_failed" &&
        field.terminalDisposition !== "pending"
      ) ||
      profile.verifiedFields.some((verified) =>
        learning.fields.filter((field) =>
          field.fieldIdentity === `profile.${verified.fieldId}` &&
          field.answerState === "answered" &&
          field.lane === verified.lane
        ).length !== 1
      ) || learning.fields.some((field) =>
        field.observationBinding === null ||
        (field.metadataReconciliation !== "matched" && !(
          field.fieldIdentity.startsWith("profile.unknown.optional.") &&
          field.uiVariant === "workday_unknown_required_v1" &&
          field.questionCategory === "unknown" &&
          field.answerCategory === "unknown" &&
          !field.required && field.answerState === "unset" && field.lane === null &&
          field.binderStrategy === "opaque_machine_key" &&
          field.sanitizedLabelSha256 === null &&
          field.metadataReconciliation === "unresolved" &&
          field.backingState === "set" && field.validationState === "clear" &&
          field.optionCatalogState === "unknown" && field.visibleOptionIds.length === 0 &&
          field.selectedOptionId === null &&
          field.optionMapping === "unresolved" &&
          field.prefillDisposition === "needs_owner_input" &&
          field.driverAttempt === "none" && field.monitorBinding === null &&
          field.terminalDisposition === "optional_unset" &&
          field.mechanics.popupBound === "not_applicable" &&
          field.mechanics.optionFocused === "not_applicable" &&
          field.mechanics.optionActivated === "not_applicable" &&
          field.mechanics.popupClosed === "not_applicable" &&
          field.mechanics.backingValueCommitted === "not_observed" &&
          field.mechanics.validationCleared === "not_observed" &&
          field.mechanics.persistentReadback === "not_attempted"
        ))
      )
    ) denied();
    const monitorPage = monitoredState.page;
    if (monitorPage !== "profile" && monitorPage !== "resume") denied();
    const monitorGroup = monitorGroups.get(monitorPage) ?? { observations: [], mutations: [] };
    monitorGroup.observations.push(...learning.fields.flatMap(({ observationBinding }) =>
      observationBinding === null ? [] : [observationBinding]
    ));
    monitorGroup.mutations.push(...learning.fields.flatMap(({ monitorBinding }) =>
      monitorBinding === null ? [] : [monitorBinding]
    ));
    monitorGroups.set(monitorPage, monitorGroup);
    if (digest(learningBytes) !== sha256) denied();
    latest = sha256;
  }
  if (paths.slice(profiles.length).some(existsSync)) denied();
  if (profileMonitorIndex !== profileMonitoredStates.length ||
      resumeProfileMonitorIndex > resumeMonitoredStates.length) denied();
  for (const [page, { observations, mutations }] of monitorGroups) {
    validateProfileMonitorBindings(observations, mutations, monitorOperations, page);
  }
  return latest;
}

function validateProfileMonitorBindings(
  observations: readonly NonNullable<ProfileFieldLearningEvidenceV2["fields"][number]["observationBinding"]>[],
  mutations: readonly NonNullable<ProfileFieldLearningEvidenceV2["fields"][number]["monitorBinding"]>[],
  operations: readonly Stage2MonitorOperationV1[],
  page: "profile" | "resume",
): void {
  validateControlMonitorBindings(mutations, operations, page, page === "profile");
  const uniqueObservations = uniqueMonitorBindings(observations);
  for (const binding of uniqueObservations) {
    const matches = operations.filter(({ operationId, attempt, page: operationPage, moment }) =>
      operationId === binding.operationId && attempt === binding.attempt &&
      operationPage === page && moment === "state_observed"
    );
    if (matches.length !== 1) denied();
  }
  const observedKeys = new Set(uniqueObservations.map(({ operationId, attempt }) =>
    `${operationId}\u0000${attempt}`
  ));
  const stateOperations = operations.filter(({ page: operationPage, moment }) =>
    operationPage === page && moment === "state_observed"
  );
  if (stateOperations.length !== uniqueObservations.length ||
      stateOperations.some(({ operationId, attempt }) =>
        !observedKeys.has(`${operationId}\u0000${attempt}`)
      )) denied();
}

function validateControlMonitorBindings(
  bindings: readonly {
    readonly operationId: string;
    readonly attempt: number;
    readonly beforeMutationAck: true;
    readonly afterReadbackAck: true;
  }[],
  operations: readonly Stage2MonitorOperationV1[],
  page: "profile" | "resume" | "questionnaire",
  exhaustive = true,
): void {
  const uniqueBindings = uniqueMonitorBindings(bindings);
  for (const binding of uniqueBindings) {
    const matches = operations.filter(({ operationId, attempt }) =>
      operationId === binding.operationId && attempt === binding.attempt
    );
    if (
      matches.length !== 2 || matches[0]?.moment !== "before_mutation" ||
      matches[1]?.moment !== "after_readback" ||
      matches[1].ordinal !== matches[0].ordinal + 1 ||
      matches[0].page !== page || matches[1].page !== page
    ) denied();
  }
  const attempted = operations.filter((operation) =>
    operation.page === page &&
    (operation.moment === "before_mutation" || operation.moment === "after_readback")
  );
  const boundOperations = new Set(uniqueBindings.map(({ operationId }) => operationId));
  if (exhaustive && (attempted.length !== uniqueBindings.length * 2 ||
      attempted.some(({ operationId }) => !boundOperations.has(operationId)))) denied();
}

function uniqueMonitorBindings<T extends { readonly operationId: string; readonly attempt: number }>(
  bindings: readonly T[],
): readonly T[] {
  const unique = new Map<string, T>();
  for (const binding of bindings) {
    const key = `${binding.operationId}\u0000${binding.attempt}`;
    const prior = unique.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(binding)) denied();
    unique.set(key, binding);
  }
  return [...unique.values()];
}

function validateValueFreeTrace(path: string, application: ApplicationWalkAcceptanceV1): void {
  const records = readValueFreeRunTrace(path);
  const started = records.filter(({ event }) => event === "application_walk_started");
  const terminal = records.filter(({ event }) => event === "application_walk_terminal");
  if (started.length !== 1 || terminal.length !== 1 ||
      started[0]?.details.journeyId !== application.journeyId ||
      terminal[0]?.details.journeyId !== application.journeyId ||
      terminal[0]?.details.status !== "passed" ||
      terminal[0]?.details.submitActivated !== false ||
      records.some(({ details }) => details.submitActivated === true)) denied();
}

function validateMonitorLedger(
  root: string,
  files: readonly string[],
  expectedCount: number,
  expectedSha256: string,
): void {
  const names = [...files].sort();
  if (names.length !== expectedCount || new Set(names).size !== names.length) denied();
  const lines = names.map((name) => `${name}:${digest(readStableFile(
    join(root, name),
    12 * 1024 * 1024,
  ))}\n`).join("");
  if (digest(Buffer.from(lines, "utf8")) !== expectedSha256) denied();
}

function readApplicationWalk(root: string): ApplicationWalkAcceptanceV1 {
  const value = JSON.parse(readStableFile(
    join(root, "application-walk-acceptance.json"),
    64 * 1024,
  ).toString("utf8")) as ApplicationWalkAcceptanceV1;
  return admitApplicationWalkAcceptance(value);
}

function readRealEvidence(root: string): {
  readonly sourceRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly requiredFieldCount: number;
} {
  const packetRoot = admittedDirectory(join(root, "real-evidence"));
  if (readdirSync(packetRoot).sort().join("\0") !==
    "browser-truth.json\0manifest.json\0summary.json") denied();
  const browserBytes = readStableFile(join(packetRoot, "browser-truth.json"), 4 * 1024);
  const manifestBytes = readStableFile(join(packetRoot, "manifest.json"), 4 * 1024);
  const summaryBytes = readStableFile(join(packetRoot, "summary.json"), 4 * 1024);
  const browser = JSON.parse(browserBytes.toString("utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const summary = JSON.parse(summaryBytes.toString("utf8")) as Record<string, unknown>;
  exactKeys(browser, [
    "schemaVersion", "observer", "page", "reviewSignatureIds", "completionEvidenceIds",
    "submitStructurallyPresent", "submitActivated",
  ]);
  if (
    browser.schemaVersion !== 1 || browser.observer !== "independent_browser" ||
    browser.page !== "review" || !validIds(browser.reviewSignatureIds, "review_signature") ||
    !validIds(browser.completionEvidenceIds, "completion_evidence") ||
    browser.submitStructurallyPresent !== true || browser.submitActivated !== false
  ) denied();
  exactKeys(manifest, [
    "schemaVersion", "manifestRevision", "sourceRevision", "configurationRevisionId",
    "configurationApprovalId", "journeyId", "sealedAt", "privacyScan", "artifactCount",
    "totalArtifactBytes", "retention", "artifacts",
  ]);
  const retention = record(manifest.retention);
  exactKeys(retention, [
    "retentionDays", "deleteAfter", "disposition", "screenshotsRetained", "rawDomRetained",
  ]);
  const sealedAt = timestamp(manifest.sealedAt);
  const expectedDeleteAfter = new Date(Date.parse(sealedAt) + 30 * 86_400_000).toISOString();
  if (
    manifest.schemaVersion !== 1 || manifest.manifestRevision !== "s2-real-evidence-manifest-v1" ||
    !revision(manifest.sourceRevision) || !opaque(manifest.configurationRevisionId, "revision") ||
    !opaque(manifest.configurationApprovalId, "approval") || !opaque(manifest.journeyId, "journey") ||
    manifest.privacyScan !== "pass" || manifest.artifactCount !== 2 ||
    manifest.totalArtifactBytes !== browserBytes.byteLength + summaryBytes.byteLength ||
    retention.retentionDays !== 30 || retention.deleteAfter !== expectedDeleteAfter ||
    retention.disposition !== "delete_after_retention" || retention.screenshotsRetained !== false ||
    retention.rawDomRetained !== false
  ) denied();
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== 2) denied();
  const expectedArtifacts = [
    ["browser-truth.json", browserBytes],
    ["summary.json", summaryBytes],
  ] as const;
  for (const [index, [file, bytes]] of expectedArtifacts.entries()) {
    const artifact = record(artifacts[index]);
    exactKeys(artifact, ["file", "bytes", "sha256"]);
    if (
      artifact.file !== file || artifact.bytes !== bytes.byteLength ||
      artifact.sha256 !== digest(bytes)
    ) denied();
  }
  exactKeys(summary, [
    "schemaVersion", "evidenceRevision", "sourceRevision", "configurationRevisionId",
    "configurationApprovalId", "journeyId", "sealedAt", "milestones",
    "verificationSummaries", "errors", "missingEvidence", "diagnosticComparison",
  ]);
  const milestones = summary.milestones;
  const verifications = summary.verificationSummaries;
  if (
    summary.schemaVersion !== 1 || summary.evidenceRevision !== "s2-real-evidence-packet-v1" ||
    summary.sourceRevision !== manifest.sourceRevision ||
    summary.configurationRevisionId !== manifest.configurationRevisionId ||
    summary.configurationApprovalId !== manifest.configurationApprovalId ||
    summary.journeyId !== manifest.journeyId || summary.sealedAt !== sealedAt ||
    !allVerified(milestones, [
      "account_verified", "application_completed", "review_reached", "submit_guarded",
    ]) || !validVerificationSummaries(verifications) ||
    !Array.isArray(summary.errors) || summary.errors.length !== 0 ||
    !validOptionalResumeEvidence(verifications, summary.missingEvidence)
  ) denied();
  const comparison = record(summary.diagnosticComparison);
  exactKeys(comparison, [
    "browserTruthSha256", "reviewReached", "requiredFieldsComplete", "submitActivated",
    "matchesBrowserTruth",
  ]);
  if (
    comparison.browserTruthSha256 !== digest(browserBytes) || comparison.reviewReached !== true ||
    comparison.requiredFieldsComplete !== true || comparison.submitActivated !== false ||
    comparison.matchesBrowserTruth !== true
  ) denied();
  const required = (verifications as Record<string, unknown>[]).find(
    (item) => item.kind === "required_fields",
  );
  if (required === undefined || !Number.isSafeInteger(required.verifiedCount) ||
    (required.verifiedCount as number) < 0) denied();
  return Object.freeze({
    sourceRevision: manifest.sourceRevision,
    revisionId: manifest.configurationRevisionId,
    approvalId: manifest.configurationApprovalId,
    journeyId: manifest.journeyId,
    requiredFieldCount: required.verifiedCount as number,
  });
}

function allVerified(
  value: unknown,
  kinds: readonly string[],
  counted = false,
): boolean {
  if (!Array.isArray(value) || value.length !== kinds.length) return false;
  return kinds.every((kind, index) => {
    const item = record(value[index]);
    exactKeys(item, counted ? ["kind", "status", "verifiedCount"] : ["kind", "status"]);
    return item.kind === kind && item.status === "verified" &&
      (!counted || Number.isSafeInteger(item.verifiedCount) && (item.verifiedCount as number) > 0);
  });
}

function validVerificationSummaries(value: unknown): boolean {
  const kinds = ["account", "resume", "required_fields", "review", "submit_guard"];
  if (!Array.isArray(value) || value.length !== kinds.length) return false;
  return kinds.every((kind, index) => {
    const item = record(value[index]);
    exactKeys(item, ["kind", "status", "verifiedCount"]);
    if (item.kind !== kind || !Number.isSafeInteger(item.verifiedCount)) return false;
    return kind === "resume"
      ? item.status === "verified" && (item.verifiedCount as number) > 0 ||
        item.status === "missing" && item.verifiedCount === 0
      : kind === "required_fields"
        ? item.status === "verified" && (item.verifiedCount as number) >= 0
      : item.status === "verified" && (item.verifiedCount as number) > 0;
  });
}

function validOptionalResumeEvidence(
  verifications: unknown,
  missingEvidence: unknown,
): boolean {
  if (!Array.isArray(verifications) || !Array.isArray(missingEvidence)) return false;
  const resume = verifications.find((item) =>
    typeof item === "object" && item !== null && "kind" in item && item.kind === "resume"
  ) as Record<string, unknown> | undefined;
  return resume?.status === "missing"
    ? missingEvidence.length === 1 && missingEvidence[0] === "resume_verification"
    : missingEvidence.length === 0;
}

function sameConfig(value: Stage2ConfigCapture, expected: Stage2ConfigCapture): boolean {
  return value.configSha256 === expected.configSha256 &&
    value.contractRevision === expected.contractRevision &&
    value.revisionId === expected.revisionId && value.approvalId === expected.approvalId &&
    value.journeyId === expected.journeyId && value.targetHandleId === expected.targetHandleId;
}

function ownerConfigPath(root: string): string {
  const runRoot = dirname(root);
  const runKey = basename(runRoot);
  const retained = dirname(runRoot);
  const storageRoot = dirname(retained);
  if (basename(root) !== "evidence" || basename(retained) !== "retained" || !RUN_KEY.test(runKey)) {
    denied();
  }
  return join(storageRoot, "transient", runKey, "owner-input.json");
}

function ownerTargetDigests(path: string): {
  readonly hostSha256: string;
  readonly tenantSha256: string;
  readonly postingSha256: string;
} {
  const owner = record(JSON.parse(readStableFile(path, 1024 * 1024).toString("utf8")));
  const target = record(owner.target);
  if (
    typeof target.host !== "string" || !/^[a-z0-9.-]{4,253}$/u.test(target.host) ||
    typeof target.tenant !== "string" || !/^[a-z0-9-]{2,64}$/u.test(target.tenant) ||
    typeof target.posting !== "string" || !/^[A-Za-z0-9-]{2,64}$/u.test(target.posting) ||
    target.host.split(".")[0] !== target.tenant
  ) denied();
  return Object.freeze({
    hostSha256: digest(Buffer.from(target.host, "utf8")),
    tenantSha256: digest(Buffer.from(target.tenant, "utf8")),
    postingSha256: digest(Buffer.from(target.posting, "utf8")),
  });
}

function readStableFile(path: string, maximumBytes: number): Buffer {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 ||
    before.size < 2 || before.size > maximumBytes ||
    comparable(realpathSync.native(path)) !== comparable(resolve(path))
  ) denied();
  const bytes = readFileSync(path);
  const after = statSync(path);
  if (
    !after.isFile() || after.nlink !== 1 || after.size !== bytes.byteLength ||
    after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
  ) denied();
  return bytes;
}

function admittedRoot(value: string): string {
  const root = admittedDirectory(value);
  if (basename(root) !== "evidence") denied();
  return root;
}

function admittedDirectory(value: string): string {
  if (
    !isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
    !statSync(value).isDirectory() ||
    comparable(realpathSync.native(value)) !== comparable(resolve(value))
  ) denied();
  return realpathSync.native(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key, index) => keys[index] !== key)) denied();
}

function validIds(value: unknown, prefix: string): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 16 &&
    new Set(value).size === value.length && value.every((item) => opaque(item, prefix));
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}

function revision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function opaque(value: unknown, prefix: string): value is string {
  return typeof value === "string" &&
    new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`, "u").test(value);
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value
  ) denied();
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("review completion audit denied");
}
