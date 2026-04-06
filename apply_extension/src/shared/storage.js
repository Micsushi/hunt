import {
  createEmptyApplyContext,
  DEFAULT_PROFILE,
  DEFAULT_RESUME,
  DEFAULT_SETTINGS,
  STORAGE_KEYS
} from "./settings.js";
import {
  sanitizeBoolean,
  sanitizeStringArray,
  sanitizeText,
  sanitizeUrl
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
  return {
    autofillOnLoad: sanitizeBoolean(settings.autofillOnLoad),
    manualFillEnabled: sanitizeBoolean(settings.manualFillEnabled ?? true),
    allowGeneratedAnswers: sanitizeBoolean(settings.allowGeneratedAnswers ?? true),
    flagLowConfidenceAnswers: sanitizeBoolean(settings.flagLowConfidenceAnswers ?? true),
    stripLongDash: sanitizeBoolean(settings.stripLongDash ?? true)
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
    notes: sanitizeText(profile.notes)
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
    updatedAt: sanitizeText(resume.updatedAt || new Date().toISOString())
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
    selectedResumeName: sanitizeText(context.selectedResumeName),
    selectedResumeMimeType: sanitizeText(context.selectedResumeMimeType || "application/pdf"),
    selectedResumeDataUrl: sanitizeText(context.selectedResumeDataUrl),
    selectedResumeReadyForC3: sanitizeBoolean(context.selectedResumeReadyForC3),
    jdSnapshotPath: sanitizeText(context.jdSnapshotPath),
    concernFlags: sanitizeStringArray(context.concernFlags),
    primedAt: sanitizeText(context.primedAt || new Date().toISOString())
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
    htmlSnapshot: sanitizeText(attempt.htmlSnapshot),
    screenshotDataUrl: sanitizeText(attempt.screenshotDataUrl),
    resultSummary: sanitizeText(attempt.resultSummary)
  };
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
    createdAt: sanitizeText(entry.createdAt || new Date().toISOString())
  };
}

export async function ensureStageOneState() {
  const syncState = await getFromSyncStorage([STORAGE_KEYS.settings]);
  const localState = await getFromLocalStorage([
    STORAGE_KEYS.profile,
    STORAGE_KEYS.defaultResume,
    STORAGE_KEYS.activeApplyContext,
    STORAGE_KEYS.attempts,
    STORAGE_KEYS.questionAnswers
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
  const questionAnswers = Array.isArray(localState[STORAGE_KEYS.questionAnswers])
    ? localState[STORAGE_KEYS.questionAnswers].map(sanitizeQuestionAnswer)
    : [];

  await setInSyncStorage({ [STORAGE_KEYS.settings]: settings });
  await setInLocalStorage({
    [STORAGE_KEYS.profile]: profile,
    [STORAGE_KEYS.defaultResume]: defaultResume,
    [STORAGE_KEYS.activeApplyContext]: activeApplyContext,
    [STORAGE_KEYS.attempts]: attempts,
    [STORAGE_KEYS.questionAnswers]: questionAnswers
  });

  return { settings, profile, defaultResume, activeApplyContext, attempts, questionAnswers };
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
  const questionAnswers = clampList([...state.questionAnswers, ...sanitizedEntries], 200);
  await setInLocalStorage({ [STORAGE_KEYS.questionAnswers]: questionAnswers });
  return sanitizedEntries;
}
