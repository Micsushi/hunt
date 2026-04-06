export const STORAGE_KEYS = {
  settings: "hunt.apply.settings",
  profile: "hunt.apply.profile",
  defaultResume: "hunt.apply.defaultResume",
  activeApplyContext: "hunt.apply.activeApplyContext",
  attempts: "hunt.apply.attempts",
  questionAnswers: "hunt.apply.questionAnswers"
};

export const DEFAULT_SETTINGS = {
  autofillOnLoad: false,
  manualFillEnabled: true,
  allowGeneratedAnswers: true,
  flagLowConfidenceAnswers: true,
  stripLongDash: true
};

export const DEFAULT_PROFILE = {
  fullName: "",
  email: "",
  phone: "",
  location: "",
  linkedinUrl: "",
  githubUrl: "",
  websiteUrl: "",
  workAuthorized: true,
  sponsorshipRequired: false,
  willingToRelocate: true,
  openToAnyLocation: true,
  salaryFlexible: true,
  notes: ""
};

export const DEFAULT_RESUME = {
  label: "",
  sourceType: "manual_default",
  pdfPath: "",
  pdfFileName: "",
  pdfMimeType: "application/pdf",
  pdfDataUrl: "",
  texPath: "",
  versionId: "",
  jobId: "",
  updatedAt: null
};

export function createEmptyApplyContext() {
  return {
    jobId: "",
    title: "",
    company: "",
    applyUrl: "",
    jobUrl: "",
    sourceMode: "manual",
    source: "",
    atsType: "",
    applyType: "",
    autoApplyEligible: false,
    description: "",
    selectedResumeVersionId: "",
    selectedResumePath: "",
    selectedResumeTexPath: "",
    selectedResumeName: "",
    selectedResumeMimeType: "application/pdf",
    selectedResumeDataUrl: "",
    selectedResumeReadyForC3: false,
    jdSnapshotPath: "",
    concernFlags: [],
    primedAt: null
  };
}
