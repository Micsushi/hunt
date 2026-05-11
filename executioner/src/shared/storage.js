import {
  createEmptyApplyContext,
  DEFAULT_PROFILE,
  DEFAULT_RESUME,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
} from "./settings.js";
import {
  sanitizeBoolean,
  sanitizeStringArray,
  sanitizeText,
  sanitizeUrl,
} from "./sanitization.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampList(items, maxItems) {
  return items.slice(Math.max(0, items.length - maxItems));
}

export async function getFromSyncStorage(keys) {
  return chrome.storage.sync.get(keys);
}

export async function setInSyncStorage(values) {
  return chrome.storage.sync.set(values);
}

export async function getFromLocalStorage(keys) {
  return chrome.storage.local.get(keys);
}

export async function setInLocalStorage(values) {
  return chrome.storage.local.set(values);
}

export function sanitizeSettings(settings = {}) {
  const pollIntervalSeconds = Number(settings.pollIntervalSeconds);
  const heartbeatIntervalSeconds = Number(settings.heartbeatIntervalSeconds);
  const settingsVersion = Number(settings.settingsVersion);
  const hasCurrentSettingsVersion =
    settingsVersion >= DEFAULT_SETTINGS.settingsVersion;
  return {
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    autofillOnLoad: sanitizeBoolean(settings.autofillOnLoad),
    manualFillEnabled: sanitizeBoolean(settings.manualFillEnabled ?? true),
    autoPromptEnabled: sanitizeBoolean(settings.autoPromptEnabled ?? true),
    fillRequiredOnly: sanitizeBoolean(settings.fillRequiredOnly ?? true),
    autoExportLogs: hasCurrentSettingsVersion
      ? sanitizeBoolean(settings.autoExportLogs)
      : DEFAULT_SETTINGS.autoExportLogs,
    autoExportLogPrefix:
      sanitizeText(settings.autoExportLogPrefix) ||
      DEFAULT_SETTINGS.autoExportLogPrefix,
    debugLogSinkEnabled: hasCurrentSettingsVersion
      ? sanitizeBoolean(settings.debugLogSinkEnabled ?? true)
      : true,
    c4PollingEnabled: sanitizeBoolean(settings.c4PollingEnabled),
    backendUrl: sanitizeUrl(settings.backendUrl || DEFAULT_SETTINGS.backendUrl),
    serviceToken: sanitizeText(settings.serviceToken),
    pollIntervalSeconds: Number.isFinite(pollIntervalSeconds)
      ? Math.min(Math.max(Math.round(pollIntervalSeconds), 30), 3600)
      : DEFAULT_SETTINGS.pollIntervalSeconds,
    heartbeatIntervalSeconds: Number.isFinite(heartbeatIntervalSeconds)
      ? Math.min(Math.max(Math.round(heartbeatIntervalSeconds), 30), 3600)
      : DEFAULT_SETTINGS.heartbeatIntervalSeconds,
    oneActiveRunLock: sanitizeBoolean(settings.oneActiveRunLock ?? true),
    allowGeneratedAnswers: sanitizeBoolean(
      settings.allowGeneratedAnswers ?? true,
    ),
    flagLowConfidenceAnswers: sanitizeBoolean(
      settings.flagLowConfidenceAnswers ?? true,
    ),
    llmAnswerFallbackEnabled: sanitizeBoolean(
      settings.llmAnswerFallbackEnabled ?? true,
    ),
    stripLongDash: sanitizeBoolean(settings.stripLongDash ?? true),
  };
}

export function sanitizeProfile(profile = {}) {
  return {
    fullName: sanitizeText(profile.fullName),
    email: sanitizeText(profile.email),
    phone: sanitizeText(profile.phone),
    location: sanitizeText(profile.location),
    linkedinUrl: sanitizeUrl(profile.linkedinUrl),
    githubUrl: sanitizeUrl(profile.githubUrl),
    websiteUrl: sanitizeUrl(profile.websiteUrl),
    workAuthorized: sanitizeBoolean(profile.workAuthorized ?? true),
    sponsorshipRequired: sanitizeBoolean(profile.sponsorshipRequired),
    willingToRelocate: sanitizeBoolean(profile.willingToRelocate ?? true),
    openToAnyLocation: sanitizeBoolean(profile.openToAnyLocation ?? true),
    salaryFlexible: sanitizeBoolean(profile.salaryFlexible ?? true),
    coOpTermsCompleted: sanitizeText(profile.coOpTermsCompleted),
    availableSummer2026: sanitizeText(profile.availableSummer2026),
    availableInterviewWindow: sanitizeText(profile.availableInterviewWindow),
    expectedGraduationYear: sanitizeText(profile.expectedGraduationYear),
    previousEmployers: sanitizeText(profile.previousEmployers),
    notes: sanitizeText(profile.notes),
  };
}

export function sanitizeResume(resume = {}) {
  return {
    label: sanitizeText(resume.label),
    sourceType: sanitizeText(resume.sourceType || DEFAULT_RESUME.sourceType),
    pdfPath: sanitizeText(resume.pdfPath),
    pdfFileName: sanitizeText(resume.pdfFileName),
    pdfMimeType: sanitizeText(resume.pdfMimeType || "application/pdf"),
    pdfDataUrl: sanitizeText(resume.pdfDataUrl),
    texPath: sanitizeText(resume.texPath),
    versionId: sanitizeText(resume.versionId),
    jobId: sanitizeText(String(resume.jobId ?? "")),
    updatedAt: sanitizeText(resume.updatedAt || new Date().toISOString()),
  };
}

export function sanitizeApplyContext(context = {}) {
  return {
    jobId: sanitizeText(String(context.jobId ?? "")),
    title: sanitizeText(context.title),
    company: sanitizeText(context.company),
    applyUrl: sanitizeUrl(context.applyUrl),
    jobUrl: sanitizeUrl(context.jobUrl),
    sourceMode: sanitizeText(context.sourceMode || "manual"),
    source: sanitizeText(context.source),
    atsType: sanitizeText(context.atsType),
    applyType: sanitizeText(context.applyType),
    autoApplyEligible: sanitizeBoolean(context.autoApplyEligible),
    description: sanitizeText(context.description),
    selectedResumeVersionId: sanitizeText(context.selectedResumeVersionId),
    selectedResumePath: sanitizeText(context.selectedResumePath),
    selectedResumeTexPath: sanitizeText(context.selectedResumeTexPath),
    selectedResumeSummary: sanitizeText(context.selectedResumeSummary),
    selectedResumeName: sanitizeText(context.selectedResumeName),
    selectedResumeMimeType: sanitizeText(
      context.selectedResumeMimeType || "application/pdf",
    ),
    selectedResumeDataUrl: sanitizeText(context.selectedResumeDataUrl),
    selectedResumeReadyForC3: sanitizeBoolean(context.selectedResumeReadyForC3),
    jdSnapshotPath: sanitizeText(context.jdSnapshotPath),
    concernFlags: sanitizeStringArray(context.concernFlags),
    primedAt: sanitizeText(context.primedAt || new Date().toISOString()),
  };
}

export function sanitizeAttempt(attempt = {}) {
  return {
    id: sanitizeText(attempt.id || crypto.randomUUID()),
    createdAt: sanitizeText(attempt.createdAt || new Date().toISOString()),
    sourceMode: sanitizeText(attempt.sourceMode || "manual"),
    jobId: sanitizeText(String(attempt.jobId ?? "")),
    applyUrl: sanitizeUrl(attempt.applyUrl),
    atsType: sanitizeText(attempt.atsType || "workday"),
    fillRoute: sanitizeText(attempt.fillRoute),
    status: sanitizeText(attempt.status || "filled"),
    authState: sanitizeText(attempt.authState || "unknown"),
    selectedResumeVersionId: sanitizeText(attempt.selectedResumeVersionId),
    selectedResumePath: sanitizeText(attempt.selectedResumePath),
    filledFieldCount: Number.isFinite(Number(attempt.filledFieldCount))
      ? Number(attempt.filledFieldCount)
      : 0,
    generatedAnswerCount: Number.isFinite(Number(attempt.generatedAnswerCount))
      ? Number(attempt.generatedAnswerCount)
      : 0,
    manualReviewRequired: sanitizeBoolean(attempt.manualReviewRequired),
    manualReviewReasons: sanitizeStringArray(attempt.manualReviewReasons),
    fieldInventory: sanitizeFieldInventory(attempt.fieldInventory),
    htmlSnapshot: sanitizeText(attempt.htmlSnapshot),
    screenshotDataUrl: sanitizeText(attempt.screenshotDataUrl),
    resultSummary: sanitizeText(attempt.resultSummary),
  };
}

function sanitizeFieldInventory(entries = []) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.slice(0, 200).map((entry) => ({
    kind: sanitizeText(entry.kind),
    tagName: sanitizeText(entry.tagName),
    type: sanitizeText(entry.type),
    name: sanitizeText(entry.name),
    id: sanitizeText(entry.id),
    descriptor: sanitizeText(entry.descriptor),
    questionHash: sanitizeText(entry.questionHash),
    options: Array.isArray(entry.options)
      ? entry.options.map((option) => sanitizeText(option)).slice(0, 80)
      : [],
    required: sanitizeBoolean(entry.required),
    skippedReason: sanitizeText(entry.skippedReason),
    valueSource: sanitizeText(entry.valueSource),
    filled: sanitizeBoolean(entry.filled),
    rect: {
      top: Number.isFinite(Number(entry.rect?.top))
        ? Number(entry.rect.top)
        : 0,
      left: Number.isFinite(Number(entry.rect?.left))
        ? Number(entry.rect.left)
        : 0,
      width: Number.isFinite(Number(entry.rect?.width))
        ? Number(entry.rect.width)
        : 0,
      height: Number.isFinite(Number(entry.rect?.height))
        ? Number(entry.rect.height)
        : 0,
    },
  }));
}

export function sanitizeQuestionAnswer(entry = {}) {
  return {
    id: sanitizeText(entry.id || crypto.randomUUID()),
    applicationAttemptId: sanitizeText(entry.applicationAttemptId),
    jobId: sanitizeText(String(entry.jobId ?? "")),
    questionHash: sanitizeText(entry.questionHash),
    questionText: sanitizeText(entry.questionText),
    answerText: sanitizeText(entry.answerText),
    answerSource: sanitizeText(entry.answerSource || "generated"),
    confidence: sanitizeText(entry.confidence || "low"),
    manualReviewRequired: sanitizeBoolean(entry.manualReviewRequired),
    createdAt: sanitizeText(entry.createdAt || new Date().toISOString()),
  };
}

export async function ensureStageOneState() {
  const syncState = await getFromSyncStorage([STORAGE_KEYS.settings]);
  const localState = await getFromLocalStorage([
    STORAGE_KEYS.profile,
    STORAGE_KEYS.defaultResume,
    STORAGE_KEYS.activeApplyContext,
    STORAGE_KEYS.attempts,
    STORAGE_KEYS.questionAnswers,
    STORAGE_KEYS.activityLog,
  ]);

  const settings = syncState[STORAGE_KEYS.settings]
    ? sanitizeSettings(syncState[STORAGE_KEYS.settings])
    : clone(DEFAULT_SETTINGS);
  const profile = localState[STORAGE_KEYS.profile]
    ? sanitizeProfile(localState[STORAGE_KEYS.profile])
    : clone(DEFAULT_PROFILE);
  const defaultResume = localState[STORAGE_KEYS.defaultResume]
    ? sanitizeResume(localState[STORAGE_KEYS.defaultResume])
    : clone(DEFAULT_RESUME);
  const activeApplyContext = localState[STORAGE_KEYS.activeApplyContext]
    ? sanitizeApplyContext(localState[STORAGE_KEYS.activeApplyContext])
    : createEmptyApplyContext();
  const attempts = Array.isArray(localState[STORAGE_KEYS.attempts])
    ? localState[STORAGE_KEYS.attempts].map(sanitizeAttempt)
    : [];
  const questionAnswers = Array.isArray(
    localState[STORAGE_KEYS.questionAnswers],
  )
    ? localState[STORAGE_KEYS.questionAnswers].map(sanitizeQuestionAnswer)
    : [];
  const activityLog = Array.isArray(localState[STORAGE_KEYS.activityLog])
    ? localState[STORAGE_KEYS.activityLog].map(sanitizeActivityLogEntry)
    : [];

  await setInSyncStorage({ [STORAGE_KEYS.settings]: settings });
  await setInLocalStorage({
    [STORAGE_KEYS.profile]: profile,
    [STORAGE_KEYS.defaultResume]: defaultResume,
    [STORAGE_KEYS.activeApplyContext]: activeApplyContext,
    [STORAGE_KEYS.attempts]: attempts,
    [STORAGE_KEYS.questionAnswers]: questionAnswers,
    [STORAGE_KEYS.activityLog]: activityLog,
  });

  return {
    settings,
    profile,
    defaultResume,
    activeApplyContext,
    attempts,
    questionAnswers,
    activityLog,
  };
}

export async function getExtensionState() {
  return ensureStageOneState();
}

export async function saveSettings(settings) {
  const nextSettings = sanitizeSettings(settings);
  await setInSyncStorage({ [STORAGE_KEYS.settings]: nextSettings });
  return nextSettings;
}

export async function saveProfile(profile) {
  const nextProfile = sanitizeProfile(profile);
  await setInLocalStorage({ [STORAGE_KEYS.profile]: nextProfile });
  return nextProfile;
}

export async function saveDefaultResume(resume) {
  const nextResume = sanitizeResume(resume);
  await setInLocalStorage({ [STORAGE_KEYS.defaultResume]: nextResume });
  return nextResume;
}

export async function saveActiveApplyContext(context) {
  const nextContext = sanitizeApplyContext(context);
  await setInLocalStorage({ [STORAGE_KEYS.activeApplyContext]: nextContext });
  return nextContext;
}

export async function clearActiveApplyContext() {
  const emptyContext = createEmptyApplyContext();
  await setInLocalStorage({ [STORAGE_KEYS.activeApplyContext]: emptyContext });
  return emptyContext;
}

export async function appendAttempt(attempt) {
  const state = await ensureStageOneState();
  const nextAttempt = sanitizeAttempt(attempt);
  const attempts = clampList([...state.attempts, nextAttempt], 20);
  await setInLocalStorage({ [STORAGE_KEYS.attempts]: attempts });
  return nextAttempt;
}

export async function appendQuestionAnswers(entries) {
  const state = await ensureStageOneState();
  const sanitizedEntries = (entries || []).map(sanitizeQuestionAnswer);
  const questionAnswers = clampList(
    [...state.questionAnswers, ...sanitizedEntries],
    200,
  );
  await setInLocalStorage({ [STORAGE_KEYS.questionAnswers]: questionAnswers });
  return sanitizedEntries;
}

export function sanitizeActivityLogEntry(entry = {}) {
  return {
    id: sanitizeText(entry.id || crypto.randomUUID()),
    createdAt: sanitizeText(entry.createdAt || new Date().toISOString()),
    action: sanitizeText(entry.action),
    status: sanitizeText(entry.status || "ok"),
    summary: sanitizeText(entry.summary),
    details: sanitizeActivityDetails(entry.details),
  };
}

function sanitizeActivityDetails(details = {}) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(details)
      .slice(0, 30)
      .map(([key, value]) => [
        sanitizeText(String(key)),
        sanitizeDetailValue(value),
      ])
      .filter(([key]) => key),
  );
}

function sanitizeDetailValue(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (Number.isFinite(Number(value)) && value !== "") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeText(String(item)))
      .filter(Boolean)
      .slice(0, 20);
  }
  return sanitizeText(String(value ?? ""));
}

export async function appendActivityLog(entry) {
  const state = await ensureStageOneState();
  const nextEntry = sanitizeActivityLogEntry(entry);
  const activityLog = clampList([...state.activityLog, nextEntry], 200);
  await setInLocalStorage({ [STORAGE_KEYS.activityLog]: activityLog });
  return nextEntry;
}

export async function clearActivityLog() {
  await setInLocalStorage({ [STORAGE_KEYS.activityLog]: [] });
  return [];
}
