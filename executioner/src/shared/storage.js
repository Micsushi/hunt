import {
  createEmptyApplyContext,
  DEFAULT_BROWSER_CONTEXT,
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

function sameJson(left, right) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

function sanitizeBackendUrl(value) {
  const backendUrl = sanitizeUrl(value || DEFAULT_SETTINGS.backendUrl);
  if (
    backendUrl === "http://127.0.0.1:8000" ||
    backendUrl === "http://localhost:8000"
  ) {
    return DEFAULT_SETTINGS.backendUrl;
  }
  return backendUrl;
}

export async function getFromSyncStorage(keys) {
  return chrome.storage.sync.get(keys);
}

export async function setInSyncStorage(values) {
  try {
    return await chrome.storage.sync.set(values);
  } catch (error) {
    if (/MAX_WRITE_OPERATIONS_PER_(MINUTE|HOUR)|quota/i.test(String(error))) {
      console.warn("C3 sync storage write skipped:", error);
      return false;
    }
    throw error;
  }
}

export async function getFromLocalStorage(keys) {
  return chrome.storage.local.get(keys);
}

export async function setInLocalStorage(values) {
  try {
    return await chrome.storage.local.set(values);
  } catch (error) {
    if (/MAX_WRITE_OPERATIONS_PER_(MINUTE|HOUR)|quota/i.test(String(error))) {
      console.warn("C3 local storage write skipped:", error);
      return false;
    }
    throw error;
  }
}

export function sanitizeSettings(settings = {}) {
  const pollIntervalSeconds = Number(settings.pollIntervalSeconds);
  const heartbeatIntervalSeconds = Number(settings.heartbeatIntervalSeconds);
  const emailVerificationTimeoutSeconds = Number(
    settings.emailVerificationTimeoutSeconds,
  );
  const settingsVersion = Number(settings.settingsVersion);
  const hasCurrentSettingsVersion =
    settingsVersion >= DEFAULT_SETTINGS.settingsVersion;
  return {
    settingsVersion: DEFAULT_SETTINGS.settingsVersion,
    autofillOnLoad: sanitizeBoolean(settings.autofillOnLoad),
    manualFillEnabled: sanitizeBoolean(settings.manualFillEnabled ?? true),
    autoPromptEnabled: sanitizeBoolean(settings.autoPromptEnabled ?? true),
    autoAccountSignupLoginEnabled: sanitizeBoolean(
      settings.autoAccountSignupLoginEnabled ?? true,
    ),
    autoEmailVerificationEnabled: sanitizeBoolean(
      settings.autoEmailVerificationEnabled,
    ),
    emailVerificationBridgeUrl:
      sanitizeUrl(settings.emailVerificationBridgeUrl) ||
      DEFAULT_SETTINGS.emailVerificationBridgeUrl,
    emailVerificationTimeoutSeconds: Number.isFinite(
      emailVerificationTimeoutSeconds,
    )
      ? Math.min(Math.max(Math.round(emailVerificationTimeoutSeconds), 15), 600)
      : DEFAULT_SETTINGS.emailVerificationTimeoutSeconds,
    autoClickNextAfterFill: hasCurrentSettingsVersion
      ? sanitizeBoolean(settings.autoClickNextAfterFill ?? true)
      : DEFAULT_SETTINGS.autoClickNextAfterFill,
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
    backendUrl: sanitizeBackendUrl(settings.backendUrl),
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
    useFieldPipelineV2: true,
    stripLongDash: sanitizeBoolean(settings.stripLongDash ?? true),
  };
}

export function sanitizeBrowserContext(context = {}) {
  const name = sanitizeText(context.name) || DEFAULT_BROWSER_CONTEXT.name;
  return {
    name,
    configuredBy:
      sanitizeText(context.configuredBy) ||
      DEFAULT_BROWSER_CONTEXT.configuredBy,
    configuredAt: sanitizeText(context.configuredAt),
    devtoolsPort: sanitizeText(String(context.devtoolsPort || "")),
  };
}

export function sanitizeProfile(profile = {}) {
  return {
    fullName: sanitizeText(profile.fullName),
    email: sanitizeText(profile.email),
    accountEmail: sanitizeText(profile.accountEmail),
    accountPassword: sanitizeText(profile.accountPassword),
    phone: sanitizeText(profile.phone),
    phoneDeviceType: sanitizeText(profile.phoneDeviceType),
    phoneCountryCode: sanitizeText(profile.phoneCountryCode),
    location: sanitizeText(profile.location),
    city: sanitizeText(profile.city),
    province: sanitizeText(profile.province),
    country: sanitizeText(profile.country),
    middleName: sanitizeText(profile.middleName),
    addressLine1: sanitizeText(profile.addressLine1),
    addressLine2: sanitizeText(profile.addressLine2),
    postalCode: sanitizeText(profile.postalCode),
    linkedinUrl: sanitizeUrl(profile.linkedinUrl),
    githubUrl: sanitizeUrl(profile.githubUrl),
    websiteUrl: sanitizeUrl(profile.websiteUrl),
    applicationSource: sanitizeText(profile.applicationSource),
    applicationSourceCategory: sanitizeText(profile.applicationSourceCategory),
    applicationSourceDetail: sanitizeText(profile.applicationSourceDetail),
    workAuthorized: sanitizeBoolean(profile.workAuthorized ?? true),
    canadianCitizenOrPermanentResident: sanitizeText(
      profile.canadianCitizenOrPermanentResident,
    ),
    sinStartsWithNine: sanitizeText(profile.sinStartsWithNine),
    sinExpiryDate: sanitizeText(profile.sinExpiryDate),
    interestedTemporaryShortContract: sanitizeText(
      profile.interestedTemporaryShortContract || "yes",
    ),
    disclosureGender: sanitizeText(profile.disclosureGender),
    disclosureTransExperience: sanitizeText(profile.disclosureTransExperience),
    disclosureLgbqIdentity: sanitizeText(profile.disclosureLgbqIdentity),
    disclosureDisability: sanitizeText(profile.disclosureDisability),
    disclosureIndigenousIdentity: sanitizeText(
      profile.disclosureIndigenousIdentity,
    ),
    disclosureVisibleMinority: sanitizeText(profile.disclosureVisibleMinority),
    disclosureVeteranStatus: sanitizeText(profile.disclosureVeteranStatus),
    sponsorshipRequired: sanitizeBoolean(profile.sponsorshipRequired),
    willingToRelocate: sanitizeBoolean(profile.willingToRelocate ?? true),
    openToAnyLocation: sanitizeBoolean(profile.openToAnyLocation ?? true),
    salaryFlexible: sanitizeBoolean(profile.salaryFlexible ?? true),
    familyMemberAtCompany: sanitizeText(profile.familyMemberAtCompany),
    reliabilityStatusClearance: sanitizeText(
      profile.reliabilityStatusClearance,
    ),
    previousDeloitteErnstYoung: sanitizeText(
      profile.previousDeloitteErnstYoung,
    ),
    languageSkillsStatement: sanitizeText(profile.languageSkillsStatement),
    salaryExpectationRange: sanitizeText(profile.salaryExpectationRange),
    coOpTermsCompleted: sanitizeText(profile.coOpTermsCompleted),
    availableSummer2026: sanitizeText(profile.availableSummer2026),
    availableInterviewWindow: sanitizeText(profile.availableInterviewWindow),
    expectedGraduationYear: sanitizeText(profile.expectedGraduationYear),
    degreeLevel: sanitizeText(profile.degreeLevel),
    highestEducation: sanitizeText(profile.highestEducation),
    preferredEducationIndex: sanitizeText(profile.preferredEducationIndex),
    previousEmployers: sanitizeText(profile.previousEmployers),
    skills: sanitizeTextList(profile.skills, 80),
    languages: sanitizeLanguages(profile.languages),
    workExperience: sanitizeWorkExperience(profile.workExperience),
    education: sanitizeEducation(profile.education),
    notes: sanitizeText(profile.notes),
  };
}

function sanitizeTextList(value, maxItems = 50) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n,;]+/)
        .map((item) => item.trim());
  const seen = new Set();
  const items = [];
  for (const item of rawItems) {
    const text = sanitizeText(item);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(text);
    if (items.length >= maxItems) {
      break;
    }
  }
  return items;
}

function sanitizeWorkExperience(entries = []) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .slice(0, 20)
    .map((entry) => ({
      jobTitle: sanitizeText(entry.jobTitle),
      company: sanitizeText(entry.company),
      location: sanitizeText(entry.location),
      startMonth: sanitizeText(entry.startMonth),
      startYear: sanitizeText(entry.startYear),
      endMonth: sanitizeText(entry.endMonth),
      endYear: sanitizeText(entry.endYear),
      current: sanitizeBoolean(entry.current),
      description: sanitizeText(entry.description),
    }))
    .filter((entry) =>
      Object.entries(entry).some(
        ([key, value]) => key !== "current" && Boolean(value),
      ),
    );
}

function sanitizeEducation(entries = []) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .slice(0, 20)
    .map((entry) => ({
      school: sanitizeText(entry.school),
      degree: sanitizeText(entry.degree),
      degreeLevel: sanitizeText(entry.degreeLevel),
      fieldOfStudy: sanitizeText(entry.fieldOfStudy),
      startMonth: sanitizeText(entry.startMonth),
      startYear: sanitizeText(entry.startYear),
      endMonth: sanitizeText(entry.endMonth),
      endYear: sanitizeText(entry.endYear),
      overallResult: sanitizeText(entry.overallResult),
    }))
    .filter((entry) => Object.values(entry).some(Boolean));
}

function sanitizeLanguages(entries = []) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .slice(0, 20)
    .map((entry) => ({
      language: sanitizeText(entry.language || entry.name),
      proficiency: sanitizeText(entry.proficiency || entry.level),
    }))
    .filter((entry) => Object.values(entry).some(Boolean));
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
    bestEffortWarnings: sanitizeStringArray(attempt.bestEffortWarnings),
    fieldInventory: sanitizeFieldInventory(attempt.fieldInventory),
    interactionTrace: sanitizeInteractionTrace(attempt.interactionTrace),
    v2Audit: sanitizeV2Audit(attempt.v2Audit),
    traceTruncated: sanitizeBoolean(attempt.traceTruncated),
    htmlSnapshot: sanitizeText(attempt.htmlSnapshot),
    screenshotDataUrl: sanitizeText(attempt.screenshotDataUrl),
    resultSummary: sanitizeText(attempt.resultSummary),
  };
}

function sanitizeV2Audit(audit = {}) {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    return {};
  }
  return {
    schemaVersion: sanitizeText(audit.schemaVersion || "c3-v2-audit-1"),
    runId: sanitizeText(audit.runId),
    startedAt: sanitizeText(audit.startedAt),
    completedAt: sanitizeText(audit.completedAt),
    atsType: sanitizeText(audit.atsType),
    pageUrl: sanitizeText(audit.pageUrl),
    mode: sanitizeText(audit.mode),
    summary: sanitizeActivityDetails(audit.summary || {}),
    permanentIssues: Array.isArray(audit.permanentIssues)
      ? audit.permanentIssues.slice(0, 200).map(sanitizeV2Issue)
      : [],
    fields: Array.isArray(audit.fields)
      ? audit.fields.slice(0, 300).map(sanitizeV2FieldAudit)
      : [],
    events: Array.isArray(audit.events)
      ? audit.events.slice(0, 1000).map(sanitizeV2Event)
      : [],
  };
}

function sanitizeV2Issue(issue = {}) {
  return {
    kind: sanitizeText(issue.kind),
    severity: sanitizeText(issue.severity || "info"),
    questionHash: sanitizeText(issue.questionHash),
    questionType: sanitizeText(issue.questionType),
    uiModel: sanitizeText(issue.uiModel),
    failedStep: sanitizeText(issue.failedStep),
    reason: sanitizeText(issue.reason),
    selectorPath: sanitizeText(issue.selectorPath),
    fieldName: sanitizeText(issue.fieldName),
    elementType: sanitizeText(issue.elementType),
    descriptor: sanitizeText(issue.descriptor),
    options: Array.isArray(issue.options)
      ? issue.options.map((option) => sanitizeText(option)).slice(0, 80)
      : [],
    rect: sanitizeRect(issue.rect),
    htmlClip: sanitizeText(issue.htmlClip),
  };
}

function sanitizeV2FieldAudit(field = {}) {
  return {
    fieldId: sanitizeText(field.fieldId),
    questionHash: sanitizeText(field.questionHash),
    descriptor: sanitizeText(field.descriptor),
    questionType: sanitizeText(field.questionType),
    uiModel: sanitizeText(field.uiModel),
    element: sanitizeV2Element(field.element),
    required: sanitizeBoolean(field.required),
    filled: sanitizeBoolean(field.filled),
    cleared: sanitizeBoolean(field.cleared),
    valueSource: sanitizeText(field.valueSource),
    selectedOption: sanitizeText(field.selectedOption),
    answerPreview: sanitizeText(field.answerPreview),
    beforeState: sanitizeActivityDetails(field.beforeState || {}),
    afterState: sanitizeActivityDetails(field.afterState || {}),
    steps: Array.isArray(field.steps)
      ? field.steps.slice(0, 80).map(sanitizeV2Event)
      : [],
    issues: Array.isArray(field.issues)
      ? field.issues.slice(0, 20).map(sanitizeV2Issue)
      : [],
  };
}

function sanitizeV2Event(event = {}) {
  return {
    index: Number.isFinite(Number(event.index)) ? Number(event.index) : 0,
    at: sanitizeText(event.at),
    action: sanitizeText(event.action),
    step: sanitizeText(event.step),
    status: sanitizeText(event.status),
    reason: sanitizeText(event.reason),
    fieldId: sanitizeText(event.fieldId),
    questionHash: sanitizeText(event.questionHash),
    questionType: sanitizeText(event.questionType),
    uiModel: sanitizeText(event.uiModel),
    valueSource: sanitizeText(event.valueSource),
    selectedOption: sanitizeText(event.selectedOption),
    detail: sanitizeActivityDetails(event.detail || {}),
    element: sanitizeV2Element(event.element),
  };
}

function sanitizeV2Element(element = {}) {
  return {
    tagName: sanitizeText(element.tagName),
    type: sanitizeText(element.type),
    id: sanitizeText(element.id),
    name: sanitizeText(element.name),
    role: sanitizeText(element.role),
    ariaLabel: sanitizeText(element.ariaLabel),
    text: sanitizeText(element.text),
    selectorPath: sanitizeText(element.selectorPath),
    rect: sanitizeRect(element.rect),
    htmlClip: sanitizeText(element.htmlClip),
  };
}

function sanitizeRect(rect = {}) {
  return {
    top: Number.isFinite(Number(rect?.top)) ? Number(rect.top) : 0,
    left: Number.isFinite(Number(rect?.left)) ? Number(rect.left) : 0,
    width: Number.isFinite(Number(rect?.width)) ? Number(rect.width) : 0,
    height: Number.isFinite(Number(rect?.height)) ? Number(rect.height) : 0,
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
    bestEffortWarning: sanitizeText(entry.bestEffortWarning),
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

function sanitizeInteractionTrace(entries = []) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.slice(0, 250).map((entry) => ({
    index: Number.isFinite(Number(entry.index)) ? Number(entry.index) : 0,
    action: sanitizeText(entry.action),
    reason: sanitizeText(entry.reason),
    key: sanitizeText(entry.key),
    currentValue: sanitizeText(entry.currentValue),
    intendedValue: sanitizeText(entry.intendedValue),
    target: {
      tagName: sanitizeText(entry.target?.tagName),
      type: sanitizeText(entry.target?.type),
      name: sanitizeText(entry.target?.name),
      id: sanitizeText(entry.target?.id),
      text: sanitizeText(entry.target?.text),
      ariaLabel: sanitizeText(entry.target?.ariaLabel),
      rect: {
        top: Number.isFinite(Number(entry.target?.rect?.top))
          ? Number(entry.target.rect.top)
          : 0,
        left: Number.isFinite(Number(entry.target?.rect?.left))
          ? Number(entry.target.rect.left)
          : 0,
        width: Number.isFinite(Number(entry.target?.rect?.width))
          ? Number(entry.target.rect.width)
          : 0,
        height: Number.isFinite(Number(entry.target?.rect?.height))
          ? Number(entry.target.rect.height)
          : 0,
      },
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
    STORAGE_KEYS.browserContext,
  ]);

  const rawSettings = syncState[STORAGE_KEYS.settings];
  const rawProfile = localState[STORAGE_KEYS.profile];
  const rawDefaultResume = localState[STORAGE_KEYS.defaultResume];
  const rawActiveApplyContext = localState[STORAGE_KEYS.activeApplyContext];
  const rawAttempts = localState[STORAGE_KEYS.attempts];
  const rawQuestionAnswers = localState[STORAGE_KEYS.questionAnswers];
  const rawActivityLog = localState[STORAGE_KEYS.activityLog];
  const rawBrowserContext = localState[STORAGE_KEYS.browserContext];

  const settings = rawSettings
    ? sanitizeSettings(rawSettings)
    : clone(DEFAULT_SETTINGS);
  const profile = rawProfile
    ? sanitizeProfile(rawProfile)
    : clone(DEFAULT_PROFILE);
  const defaultResume = rawDefaultResume
    ? sanitizeResume(rawDefaultResume)
    : clone(DEFAULT_RESUME);
  const activeApplyContext = rawActiveApplyContext
    ? sanitizeApplyContext(rawActiveApplyContext)
    : createEmptyApplyContext();
  const attempts = Array.isArray(rawAttempts)
    ? rawAttempts.map(sanitizeAttempt)
    : [];
  const questionAnswers = Array.isArray(rawQuestionAnswers)
    ? rawQuestionAnswers.map(sanitizeQuestionAnswer)
    : [];
  const activityLog = Array.isArray(rawActivityLog)
    ? rawActivityLog.map(sanitizeActivityLogEntry)
    : [];
  const browserContext = rawBrowserContext
    ? sanitizeBrowserContext(rawBrowserContext)
    : clone(DEFAULT_BROWSER_CONTEXT);

  if (!sameJson(rawSettings, settings)) {
    await setInSyncStorage({ [STORAGE_KEYS.settings]: settings });
  }
  const localPatch = {};
  if (!sameJson(rawProfile, profile)) {
    localPatch[STORAGE_KEYS.profile] = profile;
  }
  if (!sameJson(rawDefaultResume, defaultResume)) {
    localPatch[STORAGE_KEYS.defaultResume] = defaultResume;
  }
  if (!sameJson(rawActiveApplyContext, activeApplyContext)) {
    localPatch[STORAGE_KEYS.activeApplyContext] = activeApplyContext;
  }
  if (!sameJson(rawAttempts, attempts)) {
    localPatch[STORAGE_KEYS.attempts] = attempts;
  }
  if (!sameJson(rawQuestionAnswers, questionAnswers)) {
    localPatch[STORAGE_KEYS.questionAnswers] = questionAnswers;
  }
  if (!sameJson(rawActivityLog, activityLog)) {
    localPatch[STORAGE_KEYS.activityLog] = activityLog;
  }
  if (!sameJson(rawBrowserContext, browserContext)) {
    localPatch[STORAGE_KEYS.browserContext] = browserContext;
  }
  if (Object.keys(localPatch).length) {
    await setInLocalStorage(localPatch);
  }

  return {
    settings,
    profile,
    defaultResume,
    activeApplyContext,
    attempts,
    questionAnswers,
    activityLog,
    browserContext,
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
