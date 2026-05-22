import {
  listMissingProfileFields,
  mergeProfileFromResume,
  parseResumeFile,
  parseResumeTex,
} from "./resume-parser.js";
import { saveDefaultResume as saveDefaultResumeDirect } from "../shared/storage.js";

let currentDefaultResume = {};
const AUTOSAVE_DELAY_MS = 650;
const HOURS_PER_YEAR = 2080;
let statusHideTimer = null;

function showToast(message, tone = "info") {
  let container = document.getElementById("hunt-options-toasts");
  if (!container) {
    container = document.createElement("div");
    container.id = "hunt-options-toasts";
    container.style.position = "fixed";
    container.style.left = "50%";
    container.style.top = "20px";
    container.style.transform = "translateX(-50%)";
    container.style.zIndex = "2147483647";
    container.style.display = "grid";
    container.style.gap = "10px";
    container.style.maxWidth = "720px";
    container.style.width = "min(720px, calc(100vw - 32px))";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.background = tone === "warn" ? "#3a2508" : "#d7f8df";
  toast.style.border =
    tone === "warn" ? "1px solid #f0b429" : "1px solid #7bd28d";
  toast.style.borderLeft =
    tone === "warn" ? "8px solid #f0b429" : "8px solid #35b45a";
  toast.style.borderRadius = "10px";
  toast.style.boxShadow = "0 18px 48px rgba(0, 0, 0, 0.55)";
  toast.style.color = tone === "warn" ? "#f8d98a" : "#07100a";
  toast.style.font = "750 15px Segoe UI, system-ui, sans-serif";
  toast.style.lineHeight = "1.35";
  toast.style.padding = "14px 16px";
  container.appendChild(toast);
  setTimeout(() => toast.remove(), tone === "warn" ? 9000 : 6000);
}

function setStatus(message, tone = "info") {
  const element = document.getElementById("options-status");
  if (!element) {
    return;
  }

  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
  }
  element.className = `status ${tone}`;
  element.textContent = message;
  statusHideTimer = setTimeout(
    () => {
      element.classList.add("status-hidden");
    },
    tone === "warn" ? 9000 : 6000,
  );
}

function setInputValue(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.value = value ?? "";
  }
}

function setCheckboxValue(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.checked = Boolean(value);
  }
}

function calculateHourlyPayExpectation(annualSalary) {
  const match = String(annualSalary || "").match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) {
    return "";
  }
  const annual = Number(match[0].replace(/,/g, ""));
  if (!Number.isFinite(annual) || annual <= 0) {
    return "";
  }
  return (annual / HOURS_PER_YEAR).toFixed(2);
}

function updateCalculatedHourlyPay() {
  const annual = document.getElementById("profile-salary-expectation")?.value;
  setInputValue(
    "profile-hourly-pay-expectation",
    calculateHourlyPayExpectation(annual),
  );
}

let currentActivityLog = [];
let workExperienceEntries = [];
let educationEntries = [];
let languageEntries = [];

const WORK_EXPERIENCE_FIELDS = [
  ["jobTitle", "Job title", "text"],
  ["company", "Company", "text"],
  ["location", "Location", "text"],
  ["startMonth", "Start month", "text"],
  ["startYear", "Start year", "number"],
  ["endMonth", "End month", "text"],
  ["endYear", "End year", "number"],
];

const EDUCATION_FIELDS = [
  ["school", "School or university", "text"],
  ["educationTitle", "Education title", "text"],
  ["degree", "Degree", "text"],
  ["degreeLevel", "Degree level", "select"],
  ["fieldOfStudy", "Field of study", "text"],
  ["startMonth", "Start month", "text"],
  ["startYear", "Start year", "number"],
  ["endMonth", "End month", "text"],
  ["endYear", "End year", "number"],
  ["overallResult", "GPA", "text"],
];

const LANGUAGE_FIELDS = [
  ["language", "Language", "text"],
  ["proficiency", "Proficiency", "text"],
];

const DEGREE_LEVEL_OPTIONS = [
  "",
  "High School Diploma",
  "Associates",
  "Diploma",
  "Bachelors",
  "Masters",
  "Doctorate",
];

function splitListText(value) {
  const seen = new Set();
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function formatListText(items) {
  return Array.isArray(items) ? items.join("\n") : "";
}

function emptyWorkExperienceEntry() {
  return {
    jobTitle: "",
    company: "",
    location: "",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    current: false,
    description: "",
  };
}

function emptyEducationEntry() {
  return {
    school: "",
    educationTitle: "",
    degree: "",
    degreeLevel: "",
    fieldOfStudy: "",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    overallResult: "",
  };
}

function emptyLanguageEntry() {
  return {
    language: "",
    proficiency: "",
  };
}

function entryTitle(entry, fallback) {
  return (
    entry.jobTitle ||
    entry.school ||
    entry.language ||
    entry.company ||
    entry.degree ||
    fallback
  );
}

function entryMeta(entry) {
  return [
    entry.company,
    entry.location,
    entry.degree,
    entry.fieldOfStudy,
    entry.proficiency,
  ]
    .filter(Boolean)
    .join(" : ");
}

function createEntryInput(kind, index, field, label, type, value) {
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  const input = document.createElement(type === "select" ? "select" : "input");
  input.dataset.entryKind = kind;
  input.dataset.entryIndex = String(index);
  input.dataset.entryField = field;
  input.name = `${kind}-${index}-${field}`;
  if (type === "select") {
    DEGREE_LEVEL_OPTIONS.forEach((optionValue) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue || "Select degree level";
      input.appendChild(option);
    });
  } else {
    input.type = type;
  }
  input.value = value || "";
  wrapper.appendChild(input);
  return wrapper;
}

function renderEntryList(kind, entries, fieldDefs, emptyFactory) {
  const container = document.getElementById(`${kind}-list`);
  if (!container) {
    return;
  }
  container.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-log";
    empty.textContent =
      kind === "work-experience"
        ? "No work experience saved yet."
        : kind === "education"
          ? "No education saved yet."
          : "No languages saved yet.";
    container.appendChild(empty);
    return;
  }

  entries.forEach((entry, index) => {
    const card = document.createElement("div");
    card.className = "entry-card";
    card.dataset.entryKind = kind;
    card.dataset.entryIndex = String(index);

    const header = document.createElement("div");
    header.className = "entry-card-header";
    const titleBox = document.createElement("div");
    const title = document.createElement("div");
    title.className = "entry-title";
    title.textContent = entryTitle(entry, `Entry ${index + 1}`);
    const meta = document.createElement("div");
    meta.className = "entry-meta";
    meta.textContent = entryMeta(entry) || "Ready for Workday Add";
    titleBox.append(title, meta);

    const remove = document.createElement("button");
    remove.className = "remove-entry";
    remove.type = "button";
    remove.dataset.removeEntryKind = kind;
    remove.dataset.removeEntryIndex = String(index);
    remove.textContent = "Remove";
    header.append(titleBox, remove);

    const grid = document.createElement("div");
    grid.className = "grid";
    fieldDefs.forEach(([field, label, type]) => {
      grid.appendChild(
        createEntryInput(kind, index, field, label, type, entry[field]),
      );
    });

    if (kind === "work-experience") {
      const current = document.createElement("label");
      current.className = "checkbox";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.entryKind = kind;
      checkbox.dataset.entryIndex = String(index);
      checkbox.dataset.entryField = "current";
      checkbox.checked = Boolean(entry.current);
      const span = document.createElement("span");
      span.textContent = "Currently work here";
      current.append(checkbox, span);
      grid.appendChild(current);

      const description = document.createElement("label");
      description.className = "wide";
      description.textContent = "Role description";
      const textarea = document.createElement("textarea");
      textarea.dataset.entryKind = kind;
      textarea.dataset.entryIndex = String(index);
      textarea.dataset.entryField = "description";
      textarea.name = `${kind}-${index}-description`;
      textarea.value = entry.description || "";
      description.appendChild(textarea);
      grid.appendChild(description);
    }

    card.append(header, grid);
    container.appendChild(card);
  });

  if (!entries.length && emptyFactory) {
    entries.push(emptyFactory());
  }
}

function readEntryCollection(kind, emptyFactory) {
  const cards = Array.from(
    document.querySelectorAll(`[data-entry-kind="${kind}"]`),
  ).filter((element) => element.classList.contains("entry-card"));
  return cards.map((card) => {
    const entry = emptyFactory();
    card.querySelectorAll("[data-entry-field]").forEach((fieldElement) => {
      const field = fieldElement.dataset.entryField;
      entry[field] =
        fieldElement.type === "checkbox"
          ? fieldElement.checked
          : fieldElement.value;
    });
    return entry;
  });
}

function refreshEntryTitles() {
  workExperienceEntries = readEntryCollection(
    "work-experience",
    emptyWorkExperienceEntry,
  );
  educationEntries = readEntryCollection("education", emptyEducationEntry);
  languageEntries = readEntryCollection("language", emptyLanguageEntry);
}

async function readFileAsDataUrl(file) {
  if (!file) {
    return "";
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () =>
      reject(reader.error || new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

async function readFileAsText(file) {
  if (!file) {
    return "";
  }

  return file.text();
}

function readProfileForm() {
  return {
    fullName: document.getElementById("profile-full-name")?.value,
    email: document.getElementById("profile-email")?.value,
    accountEmail: document.getElementById("profile-account-email")?.value,
    accountPassword: document.getElementById("profile-account-password")?.value,
    phone: document.getElementById("profile-phone")?.value,
    phoneDeviceType: document.getElementById("profile-phone-device-type")
      ?.value,
    phoneCountryCode: document.getElementById("profile-phone-country-code")
      ?.value,
    location: document.getElementById("profile-location")?.value,
    city: document.getElementById("profile-city")?.value,
    province: document.getElementById("profile-province")?.value,
    country: document.getElementById("profile-country")?.value,
    namePrefix: document.getElementById("profile-name-prefix")?.value,
    nameSuffix: document.getElementById("profile-name-suffix")?.value,
    addressLine1: document.getElementById("profile-address-line-1")?.value,
    addressLine2: document.getElementById("profile-address-line-2")?.value,
    postalCode: document.getElementById("profile-postal-code")?.value,
    linkedinUrl: document.getElementById("profile-linkedin-url")?.value,
    githubUrl: document.getElementById("profile-github-url")?.value,
    websiteUrl: document.getElementById("profile-website-url")?.value,
    applicationSource: document.getElementById("profile-application-source")
      ?.value,
    applicationSourceCategory: document.getElementById(
      "profile-application-source-category",
    )?.value,
    applicationSourceDetail: document.getElementById(
      "profile-application-source-detail",
    )?.value,
    familyMemberAtCompany: document.getElementById(
      "profile-family-member-at-company",
    )?.value,
    reliabilityStatusClearance: document.getElementById(
      "profile-reliability-status-clearance",
    )?.value,
    previousDeloitteErnstYoung: document.getElementById(
      "profile-previous-deloitte-ernst-young",
    )?.value,
    languageSkillsStatement: document.getElementById(
      "profile-language-skills-statement",
    )?.value,
    salaryExpectation: document.getElementById("profile-salary-expectation")
      ?.value,
    salaryExpectationRange: document.getElementById(
      "profile-salary-expectation-range",
    )?.value,
    hourlyPayExpectation: calculateHourlyPayExpectation(
      document.getElementById("profile-salary-expectation")?.value,
    ),
    coOpTermsCompleted: document.getElementById("profile-coop-terms-completed")
      ?.value,
    expectedGraduationYear: document.getElementById(
      "profile-expected-graduation-year",
    )?.value,
    degreeLevel: document.getElementById("profile-degree-level")?.value,
    highestEducation: document.getElementById("profile-highest-education")
      ?.value,
    preferredEducationIndex: document.getElementById(
      "profile-preferred-education-index",
    )?.value,
    availableSummer2026: document.getElementById(
      "profile-available-summer-2026",
    )?.value,
    availableInterviewWindow: document.getElementById(
      "profile-available-interview-window",
    )?.value,
    canadianCitizenOrPermanentResident: document.getElementById(
      "profile-canadian-citizen-pr",
    )?.value,
    sinStartsWithNine: document.getElementById("profile-sin-starts-with-nine")
      ?.value,
    sinExpiryDate: document.getElementById("profile-sin-expiry-date")?.value,
    interestedTemporaryShortContract: document.getElementById(
      "profile-temporary-short-contract",
    )?.value,
    disclosureGender: document.getElementById("profile-disclosure-gender")
      ?.value,
    disclosureTransExperience: document.getElementById(
      "profile-disclosure-trans-experience",
    )?.value,
    disclosureLgbqIdentity: document.getElementById("profile-disclosure-lgbq")
      ?.value,
    disclosureDisability: document.getElementById(
      "profile-disclosure-disability",
    )?.value,
    disclosureIndigenousIdentity: document.getElementById(
      "profile-disclosure-indigenous",
    )?.value,
    disclosureVisibleMinority: document.getElementById(
      "profile-disclosure-visible-minority",
    )?.value,
    disclosureVeteranStatus: document.getElementById(
      "profile-disclosure-veteran",
    )?.value,
    accommodationRequest: document.getElementById(
      "profile-accommodation-request",
    )?.value,
    previousEmployers: document.getElementById("profile-previous-employers")
      ?.value,
    skills: splitListText(document.getElementById("profile-skills")?.value),
  };
}

function writeProfileFields(profile) {
  setInputValue("profile-full-name", profile.fullName);
  setInputValue("profile-email", profile.email);
  setInputValue("profile-account-email", profile.accountEmail);
  setInputValue("profile-account-password", profile.accountPassword);
  setInputValue("profile-phone", profile.phone);
  setInputValue("profile-phone-device-type", profile.phoneDeviceType);
  setInputValue("profile-phone-country-code", profile.phoneCountryCode);
  setInputValue("profile-location", profile.location);
  setInputValue("profile-city", profile.city);
  setInputValue("profile-province", profile.province);
  setInputValue("profile-country", profile.country);
  setInputValue("profile-name-prefix", profile.namePrefix);
  setInputValue("profile-name-suffix", profile.nameSuffix);
  setInputValue("profile-address-line-1", profile.addressLine1);
  setInputValue("profile-address-line-2", profile.addressLine2);
  setInputValue("profile-postal-code", profile.postalCode);
  setInputValue("profile-linkedin-url", profile.linkedinUrl);
  setInputValue("profile-github-url", profile.githubUrl);
  setInputValue("profile-website-url", profile.websiteUrl);
  setInputValue("profile-application-source", profile.applicationSource);
  setInputValue(
    "profile-application-source-category",
    profile.applicationSourceCategory,
  );
  setInputValue(
    "profile-application-source-detail",
    profile.applicationSourceDetail,
  );
  setInputValue(
    "profile-family-member-at-company",
    profile.familyMemberAtCompany,
  );
  setInputValue(
    "profile-reliability-status-clearance",
    profile.reliabilityStatusClearance,
  );
  setInputValue(
    "profile-previous-deloitte-ernst-young",
    profile.previousDeloitteErnstYoung,
  );
  setInputValue(
    "profile-language-skills-statement",
    profile.languageSkillsStatement,
  );
  setInputValue("profile-salary-expectation", profile.salaryExpectation);
  setInputValue(
    "profile-salary-expectation-range",
    profile.salaryExpectationRange,
  );
  setInputValue(
    "profile-hourly-pay-expectation",
    profile.hourlyPayExpectation ||
      calculateHourlyPayExpectation(profile.salaryExpectation),
  );
  setInputValue("profile-coop-terms-completed", profile.coOpTermsCompleted);
  setInputValue(
    "profile-expected-graduation-year",
    profile.expectedGraduationYear,
  );
  setInputValue("profile-degree-level", profile.degreeLevel);
  setInputValue("profile-highest-education", profile.highestEducation);
  setInputValue(
    "profile-preferred-education-index",
    profile.preferredEducationIndex,
  );
  setInputValue("profile-available-summer-2026", profile.availableSummer2026);
  setInputValue(
    "profile-available-interview-window",
    profile.availableInterviewWindow,
  );
  setInputValue(
    "profile-canadian-citizen-pr",
    profile.canadianCitizenOrPermanentResident,
  );
  setInputValue("profile-sin-starts-with-nine", profile.sinStartsWithNine);
  setInputValue("profile-sin-expiry-date", profile.sinExpiryDate);
  setInputValue(
    "profile-temporary-short-contract",
    profile.interestedTemporaryShortContract || "yes",
  );
  setInputValue("profile-disclosure-gender", profile.disclosureGender);
  setInputValue(
    "profile-disclosure-trans-experience",
    profile.disclosureTransExperience,
  );
  setInputValue("profile-disclosure-lgbq", profile.disclosureLgbqIdentity);
  setInputValue("profile-disclosure-disability", profile.disclosureDisability);
  setInputValue(
    "profile-disclosure-indigenous",
    profile.disclosureIndigenousIdentity,
  );
  setInputValue(
    "profile-disclosure-visible-minority",
    profile.disclosureVisibleMinority,
  );
  setInputValue("profile-disclosure-veteran", profile.disclosureVeteranStatus);
  setInputValue("profile-accommodation-request", profile.accommodationRequest);
  setInputValue("profile-previous-employers", profile.previousEmployers);
  setInputValue("profile-skills", formatListText(profile.skills));
  workExperienceEntries = Array.isArray(profile.workExperience)
    ? profile.workExperience
    : [];
  educationEntries = Array.isArray(profile.education) ? profile.education : [];
  languageEntries = Array.isArray(profile.languages) ? profile.languages : [];
  renderEntryList(
    "work-experience",
    workExperienceEntries,
    WORK_EXPERIENCE_FIELDS,
    emptyWorkExperienceEntry,
  );
  renderEntryList(
    "education",
    educationEntries,
    EDUCATION_FIELDS,
    emptyEducationEntry,
  );
  renderEntryList(
    "language",
    languageEntries,
    LANGUAGE_FIELDS,
    emptyLanguageEntry,
  );
}

function formatLogTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function formatLogDetails(entry) {
  const details =
    entry.details && Object.keys(entry.details).length ? entry.details : {};
  return JSON.stringify(
    {
      id: entry.id,
      status: entry.status,
      details,
    },
    null,
    2,
  );
}

function renderActivityLog(entries = []) {
  currentActivityLog = entries;
  const container = document.getElementById("activity-log");
  if (!container) {
    return;
  }
  const count = document.getElementById("activity-log-count");
  if (count) {
    count.textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
  }
  container.innerHTML = "";
  const recentEntries = [...entries].reverse();
  if (!recentEntries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-log";
    empty.textContent = "No extension activity logged yet.";
    container.appendChild(empty);
    return;
  }

  for (const entry of recentEntries) {
    const row = document.createElement("div");
    row.className = "log-entry";

    const time = document.createElement("div");
    time.className = "log-time";
    time.textContent = formatLogTime(entry.createdAt);

    const action = document.createElement("div");
    action.className = "log-action";
    action.textContent = entry.action || "event";

    const summary = document.createElement("div");
    summary.className = "log-summary";
    summary.textContent = entry.summary || "";

    const toggle = document.createElement("div");
    toggle.className = "log-toggle";
    toggle.textContent = "details";

    const details = document.createElement("pre");
    details.className = "log-details";
    details.textContent = formatLogDetails(entry);

    row.addEventListener("click", () => {
      row.classList.toggle("expanded");
    });

    row.append(time, action, summary, toggle, details);
    container.appendChild(row);
  }
}

function readFullProfileForm() {
  refreshEntryTitles();
  return {
    ...readProfileForm(),
    workAuthorized: document.getElementById("profile-work-authorized")?.checked,
    sponsorshipRequired: document.getElementById("profile-sponsorship-required")
      ?.checked,
    willingToRelocate: document.getElementById("profile-willing-to-relocate")
      ?.checked,
    openToAnyLocation: document.getElementById("profile-open-to-any-location")
      ?.checked,
    salaryFlexible: document.getElementById("profile-salary-flexible")?.checked,
    compensationOfferFactors: document.getElementById(
      "profile-compensation-offer-factors",
    )?.checked,
    conflictOfInterestRelationship: document.getElementById(
      "profile-conflict-of-interest-relationship",
    )?.checked,
    hhsOigExcluded: document.getElementById("profile-hhs-oig-excluded")
      ?.checked,
    gsaFederalProgramExcluded: document.getElementById(
      "profile-gsa-federal-program-excluded",
    )?.checked,
    genericDrugDebarred: document.getElementById(
      "profile-generic-drug-debarred",
    )?.checked,
    debarmentProceedingsPending: document.getElementById(
      "profile-debarment-proceedings-pending",
    )?.checked,
    usLicensedPhysician: document.getElementById(
      "profile-us-licensed-physician",
    )?.checked,
    fdaHhsInvestigationalDrugRestricted: document.getElementById(
      "profile-fda-hhs-investigational-drug-restricted",
    )?.checked,
    governmentalLicensingInquiry: document.getElementById(
      "profile-governmental-licensing-inquiry",
    )?.checked,
    workExperience: workExperienceEntries,
    education: educationEntries,
    languages: languageEntries,
    notes: document.getElementById("profile-notes")?.value,
  };
}

function readSettingsForm() {
  return {
    autofillOnLoad: document.getElementById("autofill-on-load")?.checked,
    manualFillEnabled: document.getElementById("manual-fill-enabled")?.checked,
    autoPromptEnabled: document.getElementById("auto-prompt-enabled")?.checked,
    autoAccountSignupLoginEnabled: document.getElementById(
      "auto-account-signup-login-enabled",
    )?.checked,
    autoEmailVerificationEnabled: document.getElementById(
      "auto-email-verification-enabled",
    )?.checked,
    autoClickNextAfterFill: document.getElementById(
      "auto-click-next-after-fill",
    )?.checked,
    fillRequiredOnly: document.getElementById("fill-required-only")?.checked,
    autoExportLogs: document.getElementById("auto-export-logs")?.checked,
    debugLogSinkEnabled: document.getElementById("debug-log-sink-enabled")
      ?.checked,
    autoExportLogPrefix: document.getElementById("auto-export-log-prefix")
      ?.value,
    c4PollingEnabled: document.getElementById("c4-polling-enabled")?.checked,
    oneActiveRunLock: document.getElementById("one-active-run-lock")?.checked,
    backendUrl: document.getElementById("backend-url")?.value,
    serviceToken: document.getElementById("service-token")?.value,
    pollIntervalSeconds: document.getElementById("poll-interval-seconds")
      ?.value,
    heartbeatIntervalSeconds: document.getElementById(
      "heartbeat-interval-seconds",
    )?.value,
    emailVerificationTimeoutSeconds: document.getElementById(
      "email-verification-timeout-seconds",
    )?.value,
    emailVerificationBridgeUrl: document.getElementById(
      "email-verification-bridge-url",
    )?.value,
    allowGeneratedAnswers: document.getElementById("allow-generated-answers")
      ?.checked,
    flagLowConfidenceAnswers: document.getElementById(
      "flag-low-confidence-answers",
    )?.checked,
    useFieldPipelineV2: true,
    stripLongDash: document.getElementById("strip-long-dash")?.checked,
  };
}

async function saveSettings(payload) {
  return chrome.runtime.sendMessage({
    type: "hunt.apply.save_settings",
    payload,
  });
}

async function saveProfile(payload) {
  return chrome.runtime.sendMessage({
    type: "hunt.apply.save_profile",
    payload,
  });
}

function installAutosave(formId, saveCurrentForm, savedMessage, failedMessage) {
  const form = document.getElementById(formId);
  if (!form) {
    return;
  }

  let timeoutId = 0;
  let saving = false;
  let saveAgain = false;

  const runSave = async () => {
    if (saving) {
      saveAgain = true;
      return;
    }

    saving = true;
    let response;
    try {
      response = await saveCurrentForm();
    } catch (error) {
      response = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      saving = false;
    }

    if (saveAgain) {
      saveAgain = false;
      timeoutId = setTimeout(runSave, AUTOSAVE_DELAY_MS);
      return;
    }

    setStatus(
      response?.ok ? savedMessage : response?.message || failedMessage,
      response?.ok ? "info" : "warn",
    );
  };

  const scheduleSave = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(runSave, AUTOSAVE_DELAY_MS);
  };

  form.addEventListener("input", scheduleSave);
  form.addEventListener("change", scheduleSave);
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.get_state",
  });
  if (!response?.ok) {
    setStatus(response?.message || "Failed to load extension state.", "warn");
    return;
  }

  setCheckboxValue("autofill-on-load", response.settings.autofillOnLoad);
  setCheckboxValue("manual-fill-enabled", response.settings.manualFillEnabled);
  setCheckboxValue("auto-prompt-enabled", response.settings.autoPromptEnabled);
  setCheckboxValue(
    "auto-account-signup-login-enabled",
    response.settings.autoAccountSignupLoginEnabled,
  );
  setCheckboxValue(
    "auto-email-verification-enabled",
    response.settings.autoEmailVerificationEnabled,
  );
  setCheckboxValue(
    "auto-click-next-after-fill",
    response.settings.autoClickNextAfterFill,
  );
  setCheckboxValue("fill-required-only", response.settings.fillRequiredOnly);
  setCheckboxValue("auto-export-logs", response.settings.autoExportLogs);
  setCheckboxValue(
    "debug-log-sink-enabled",
    response.settings.debugLogSinkEnabled,
  );
  setInputValue(
    "auto-export-log-prefix",
    response.settings.autoExportLogPrefix,
  );
  setCheckboxValue("c4-polling-enabled", response.settings.c4PollingEnabled);
  setCheckboxValue("one-active-run-lock", response.settings.oneActiveRunLock);
  setInputValue("backend-url", response.settings.backendUrl);
  setInputValue("service-token", response.settings.serviceToken);
  setInputValue("poll-interval-seconds", response.settings.pollIntervalSeconds);
  setInputValue(
    "heartbeat-interval-seconds",
    response.settings.heartbeatIntervalSeconds,
  );
  setInputValue(
    "email-verification-timeout-seconds",
    response.settings.emailVerificationTimeoutSeconds,
  );
  setInputValue(
    "email-verification-bridge-url",
    response.settings.emailVerificationBridgeUrl,
  );
  setCheckboxValue(
    "allow-generated-answers",
    response.settings.allowGeneratedAnswers,
  );
  setCheckboxValue(
    "flag-low-confidence-answers",
    response.settings.flagLowConfidenceAnswers,
  );
  setCheckboxValue("strip-long-dash", response.settings.stripLongDash);

  writeProfileFields(response.profile);
  setCheckboxValue("profile-work-authorized", response.profile.workAuthorized);
  setCheckboxValue(
    "profile-sponsorship-required",
    response.profile.sponsorshipRequired,
  );
  setCheckboxValue(
    "profile-willing-to-relocate",
    response.profile.willingToRelocate,
  );
  setCheckboxValue(
    "profile-open-to-any-location",
    response.profile.openToAnyLocation,
  );
  setCheckboxValue("profile-salary-flexible", response.profile.salaryFlexible);
  setCheckboxValue(
    "profile-compensation-offer-factors",
    response.profile.compensationOfferFactors,
  );
  setCheckboxValue(
    "profile-conflict-of-interest-relationship",
    response.profile.conflictOfInterestRelationship,
  );
  setCheckboxValue("profile-hhs-oig-excluded", response.profile.hhsOigExcluded);
  setCheckboxValue(
    "profile-gsa-federal-program-excluded",
    response.profile.gsaFederalProgramExcluded,
  );
  setCheckboxValue(
    "profile-generic-drug-debarred",
    response.profile.genericDrugDebarred,
  );
  setCheckboxValue(
    "profile-debarment-proceedings-pending",
    response.profile.debarmentProceedingsPending,
  );
  setCheckboxValue(
    "profile-us-licensed-physician",
    response.profile.usLicensedPhysician,
  );
  setCheckboxValue(
    "profile-fda-hhs-investigational-drug-restricted",
    response.profile.fdaHhsInvestigationalDrugRestricted,
  );
  setCheckboxValue(
    "profile-governmental-licensing-inquiry",
    response.profile.governmentalLicensingInquiry,
  );
  setInputValue("profile-notes", response.profile.notes);

  setInputValue("resume-label", response.defaultResume.label);
  setInputValue("resume-source-type", response.defaultResume.sourceType);
  setInputValue("resume-pdf-path", response.defaultResume.pdfPath);
  setInputValue("resume-tex-path", response.defaultResume.texPath);
  setInputValue("resume-version-id", response.defaultResume.versionId);
  setInputValue("resume-job-id", response.defaultResume.jobId);
  currentDefaultResume = response.defaultResume || {};

  setInputValue(
    "apply-context-json",
    response.activeApplyContext?.jobId
      ? JSON.stringify(response.activeApplyContext, null, 2)
      : "",
  );
  renderActivityLog(response.activityLog || []);

  setStatus("Stage 1 through Stage 4 extension state loaded.", "info");
}

document
  .getElementById("settings-form")
  ?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const response = await saveSettings(readSettingsForm());

    setStatus(
      response?.ok
        ? "Settings saved."
        : response?.message || "Failed to save settings.",
      response?.ok ? "info" : "warn",
    );
  });

document.getElementById("poll-c4-once")?.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.poll_c4_once",
  });
  await loadState();
  setStatus(
    response?.ok
      ? response.claimed === false
        ? "C4 poll completed: no pending fills."
        : "C4 poll completed."
      : response?.message || response?.reason || "C4 poll failed.",
    response?.ok ? "info" : "warn",
  );
});

document
  .getElementById("export-logs-now")
  ?.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.export_logs",
      payload: { reason: "options-button" },
    });
    setStatus(
      response?.exported
        ? `Logs exported to ${response.filename}.`
        : response?.message || response?.reason || "Log export skipped.",
      response?.exported ? "info" : "warn",
    );
    showToast(
      response?.exported
        ? `Logs exported to ${response.filename}.`
        : response?.message || response?.reason || "Log export skipped.",
      response?.exported ? "info" : "warn",
    );
  });

document
  .getElementById("test-debug-log-sink")
  ?.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.test_debug_log_sink",
      payload: { reason: "options-button" },
    });
    const message = response?.ok
      ? `Log sink wrote to ${response.path || "local backend"}.`
      : response?.message || response?.reason || "Log sink test failed.";
    setStatus(message, response?.ok ? "info" : "warn");
    showToast(message, response?.ok ? "info" : "warn");
  });

document
  .getElementById("profile-form")
  ?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const response = await saveProfile(readFullProfileForm());

    setStatus(
      response?.ok
        ? "Profile saved."
        : response?.message || "Failed to save profile.",
      response?.ok ? "info" : "warn",
    );
  });

document
  .getElementById("profile-salary-expectation")
  ?.addEventListener("input", updateCalculatedHourlyPay);

installAutosave(
  "settings-form",
  () => saveSettings(readSettingsForm()),
  "Settings autosaved.",
  "Failed to autosave settings.",
);

installAutosave(
  "profile-form",
  () => saveProfile(readFullProfileForm()),
  "Profile autosaved.",
  "Failed to autosave profile.",
);

installAutosave(
  "experience-form",
  () => saveProfile(readFullProfileForm()),
  "Experience autosaved.",
  "Failed to autosave experience.",
);

function selectTab(tabId) {
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    const active = button.dataset.tabTarget === tabId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === tabId);
  });
}

document.querySelectorAll("[data-tab-target]").forEach((button) => {
  button.addEventListener("click", () => {
    selectTab(button.dataset.tabTarget || "settings");
  });
});

document
  .getElementById("add-work-experience")
  ?.addEventListener("click", () => {
    refreshEntryTitles();
    workExperienceEntries.push(emptyWorkExperienceEntry());
    renderEntryList(
      "work-experience",
      workExperienceEntries,
      WORK_EXPERIENCE_FIELDS,
      emptyWorkExperienceEntry,
    );
  });

document.getElementById("add-education")?.addEventListener("click", () => {
  refreshEntryTitles();
  educationEntries.push(emptyEducationEntry());
  renderEntryList(
    "education",
    educationEntries,
    EDUCATION_FIELDS,
    emptyEducationEntry,
  );
});

document.getElementById("add-language")?.addEventListener("click", () => {
  refreshEntryTitles();
  languageEntries.push(emptyLanguageEntry());
  renderEntryList(
    "language",
    languageEntries,
    LANGUAGE_FIELDS,
    emptyLanguageEntry,
  );
});

document
  .getElementById("experience-form")
  ?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const kind = target.dataset.removeEntryKind;
    const index = Number(target.dataset.removeEntryIndex);
    if (!kind || !Number.isFinite(index)) {
      return;
    }
    refreshEntryTitles();
    if (kind === "work-experience") {
      workExperienceEntries.splice(index, 1);
      renderEntryList(
        "work-experience",
        workExperienceEntries,
        WORK_EXPERIENCE_FIELDS,
        emptyWorkExperienceEntry,
      );
    } else if (kind === "education") {
      educationEntries.splice(index, 1);
      renderEntryList(
        "education",
        educationEntries,
        EDUCATION_FIELDS,
        emptyEducationEntry,
      );
    } else if (kind === "language") {
      languageEntries.splice(index, 1);
      renderEntryList(
        "language",
        languageEntries,
        LANGUAGE_FIELDS,
        emptyLanguageEntry,
      );
    }
    const response = await saveProfile(readFullProfileForm());
    setStatus(
      response?.ok
        ? "Experience updated."
        : response?.message || "Failed to update experience.",
      response?.ok ? "info" : "warn",
    );
  });

document
  .getElementById("import-profile-tex")
  ?.addEventListener("click", async () => {
    try {
      const file = document.getElementById("profile-tex-file")?.files?.[0];
      if (!file) {
        setStatus("Choose a TeX or PDF resume first.", "warn");
        return;
      }

      const parsedProfile = await parseResumeFile(file);
      const currentProfile = readFullProfileForm();
      const nextProfile = {
        ...currentProfile,
        ...mergeProfileFromResume(currentProfile, parsedProfile),
      };

      writeProfileFields(nextProfile);
      const response = await saveProfile(nextProfile);
      const missingFields = listMissingProfileFields(nextProfile);
      if (response?.ok) {
        await chrome.runtime.sendMessage({
          type: "hunt.apply.log_activity",
          payload: {
            action: "profile.import_tex",
            summary: `Imported profile, experience, education, and skills from ${file.name}.`,
            details: {
              fileName: file.name,
              workExperienceCount: nextProfile.workExperience?.length || 0,
              educationCount: nextProfile.education?.length || 0,
              skillsCount: nextProfile.skills?.length || 0,
              missingFields,
            },
          },
        });
        await loadState();
      }

      const message = response?.ok
        ? missingFields.length
          ? `Imported profile, experience, education, and skills from ${file.name}. Please fill: ${missingFields.join(", ")}.`
          : `Imported and saved profile, experience, education, and skills from ${file.name}.`
        : response?.message || "Failed to save imported profile.";
      const tone = response?.ok ? "info" : "warn";
      setStatus(message, tone);
      showToast(message, tone);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, "warn");
      showToast(message, "warn");
    }
  });

document
  .getElementById("resume-form")
  ?.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const file = document.getElementById("resume-pdf-file")?.files?.[0];
      const existingDataUrl = currentDefaultResume.pdfDataUrl || "";
      if (!file && !existingDataUrl) {
        setStatus("Choose a PDF resume before saving.", "warn");
        showToast("Choose a PDF resume before saving.", "warn");
        return;
      }

      const pdfDataUrl = file ? await readFileAsDataUrl(file) : existingDataUrl;
      const saved = await saveDefaultResumeDirect({
        ...currentDefaultResume,
        label:
          document.getElementById("resume-label")?.value ||
          currentDefaultResume.label ||
          file?.name ||
          "",
        sourceType: document.getElementById("resume-source-type")?.value,
        pdfPath: document.getElementById("resume-pdf-path")?.value,
        pdfFileName: file?.name || currentDefaultResume.pdfFileName || "",
        pdfMimeType:
          file?.type || currentDefaultResume.pdfMimeType || "application/pdf",
        pdfDataUrl,
        texPath: document.getElementById("resume-tex-path")?.value,
        versionId: document.getElementById("resume-version-id")?.value,
        jobId: document.getElementById("resume-job-id")?.value,
      });

      await chrome.runtime.sendMessage({
        type: "hunt.apply.log_activity",
        payload: {
          action: "resume.save",
          summary: "Default resume saved.",
          details: {
            label: saved.label,
            pdfFileName: saved.pdfFileName,
            hasPdfData: Boolean(saved.pdfDataUrl),
          },
        },
      });
      await loadState();
      setStatus("Default resume cached and saved.", "info");
      showToast(`Default resume saved: ${saved.pdfFileName || saved.label}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message, "warn");
      showToast(`Default resume save failed: ${message}`, "warn");
    }
  });

document
  .getElementById("apply-context-form")
  ?.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const rawJson =
        document.getElementById("apply-context-json")?.value || "";
      const payload = JSON.parse(rawJson);
      const response = await chrome.runtime.sendMessage({
        type: "hunt.apply.set_apply_context",
        payload,
      });

      setStatus(
        response?.ok
          ? "Active apply context imported."
          : response?.message || "Failed to import apply context.",
        response?.ok ? "info" : "warn",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "warn");
    }
  });

document
  .getElementById("clear-imported-context")
  ?.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.clear_apply_context",
    });

    if (!response?.ok) {
      setStatus(response?.message || "Failed to clear apply context.", "warn");
      return;
    }

    setInputValue("apply-context-json", "");
    await loadState();
    setStatus("Active apply context cleared.", "info");
  });

document
  .getElementById("reload-extension")
  ?.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "hunt.apply.log_activity",
      payload: {
        action: "extension.reload",
        summary: "Extension reload requested from Options.",
      },
    });
    chrome.runtime.reload();
  });

document
  .getElementById("export-activity-log")
  ?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(currentActivityLog, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hunt-c3-activity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

document
  .getElementById("clear-activity-log")
  ?.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.clear_activity_log",
    });
    if (!response?.ok) {
      setStatus(response?.message || "Failed to clear activity log.", "warn");
      return;
    }
    renderActivityLog([]);
    setStatus("Activity log cleared.", "info");
  });

loadState().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), "warn");
});
