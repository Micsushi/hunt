import {
  listMissingProfileFields,
  mergeProfileFromResume,
  parseResumeTex,
} from "./resume-parser.js";
import { saveDefaultResume as saveDefaultResumeDirect } from "../shared/storage.js";

let currentDefaultResume = {};

function showToast(message, tone = "info") {
  let container = document.getElementById("hunt-options-toasts");
  if (!container) {
    container = document.createElement("div");
    container.id = "hunt-options-toasts";
    container.style.position = "fixed";
    container.style.right = "18px";
    container.style.top = "18px";
    container.style.zIndex = "2147483647";
    container.style.display = "grid";
    container.style.gap = "8px";
    container.style.maxWidth = "380px";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.background = tone === "warn" ? "#2d2410" : "#172212";
  toast.style.border =
    tone === "warn" ? "1px solid #f0b429" : "1px solid #3a5a3a";
  toast.style.borderLeft =
    tone === "warn" ? "4px solid #f0b429" : "4px solid #59a96a";
  toast.style.borderRadius = "8px";
  toast.style.boxShadow = "0 8px 28px rgba(0, 0, 0, 0.35)";
  toast.style.color = tone === "warn" ? "#f0b429" : "#d4f0dc";
  toast.style.font = "600 13px Segoe UI, system-ui, sans-serif";
  toast.style.lineHeight = "1.35";
  toast.style.padding = "10px 12px";
  container.appendChild(toast);
  setTimeout(() => toast.remove(), tone === "warn" ? 7000 : 4200);
}

function setStatus(message, tone = "info") {
  const element = document.getElementById("options-status");
  if (!element) {
    return;
  }

  element.className = `status ${tone}`;
  element.textContent = message;
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

let currentActivityLog = [];

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
    phone: document.getElementById("profile-phone")?.value,
    location: document.getElementById("profile-location")?.value,
    linkedinUrl: document.getElementById("profile-linkedin-url")?.value,
    githubUrl: document.getElementById("profile-github-url")?.value,
    websiteUrl: document.getElementById("profile-website-url")?.value,
    coOpTermsCompleted: document.getElementById("profile-coop-terms-completed")
      ?.value,
    expectedGraduationYear: document.getElementById(
      "profile-expected-graduation-year",
    )?.value,
    availableSummer2026: document.getElementById(
      "profile-available-summer-2026",
    )?.value,
    availableInterviewWindow: document.getElementById(
      "profile-available-interview-window",
    )?.value,
    previousEmployers: document.getElementById("profile-previous-employers")
      ?.value,
  };
}

function writeProfileFields(profile) {
  setInputValue("profile-full-name", profile.fullName);
  setInputValue("profile-email", profile.email);
  setInputValue("profile-phone", profile.phone);
  setInputValue("profile-location", profile.location);
  setInputValue("profile-linkedin-url", profile.linkedinUrl);
  setInputValue("profile-github-url", profile.githubUrl);
  setInputValue("profile-website-url", profile.websiteUrl);
  setInputValue("profile-coop-terms-completed", profile.coOpTermsCompleted);
  setInputValue(
    "profile-expected-graduation-year",
    profile.expectedGraduationYear,
  );
  setInputValue("profile-available-summer-2026", profile.availableSummer2026);
  setInputValue(
    "profile-available-interview-window",
    profile.availableInterviewWindow,
  );
  setInputValue("profile-previous-employers", profile.previousEmployers);
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

    row.append(time, action, summary);
    container.appendChild(row);
  }
}

function readFullProfileForm() {
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
    notes: document.getElementById("profile-notes")?.value,
  };
}

async function saveProfile(payload) {
  return chrome.runtime.sendMessage({
    type: "hunt.apply.save_profile",
    payload,
  });
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
  setCheckboxValue(
    "allow-generated-answers",
    response.settings.allowGeneratedAnswers,
  );
  setCheckboxValue(
    "flag-low-confidence-answers",
    response.settings.flagLowConfidenceAnswers,
  );
  setCheckboxValue("strip-long-dash", response.settings.stripLongDash);

  setInputValue("profile-full-name", response.profile.fullName);
  setInputValue("profile-email", response.profile.email);
  setInputValue("profile-phone", response.profile.phone);
  setInputValue("profile-location", response.profile.location);
  setInputValue("profile-linkedin-url", response.profile.linkedinUrl);
  setInputValue("profile-github-url", response.profile.githubUrl);
  setInputValue("profile-website-url", response.profile.websiteUrl);
  setInputValue(
    "profile-coop-terms-completed",
    response.profile.coOpTermsCompleted,
  );
  setInputValue(
    "profile-expected-graduation-year",
    response.profile.expectedGraduationYear,
  );
  setInputValue(
    "profile-available-summer-2026",
    response.profile.availableSummer2026,
  );
  setInputValue(
    "profile-available-interview-window",
    response.profile.availableInterviewWindow,
  );
  setInputValue(
    "profile-previous-employers",
    response.profile.previousEmployers,
  );
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

    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.save_settings",
      payload: {
        autofillOnLoad: document.getElementById("autofill-on-load")?.checked,
        manualFillEnabled: document.getElementById("manual-fill-enabled")
          ?.checked,
        autoPromptEnabled: document.getElementById("auto-prompt-enabled")
          ?.checked,
        fillRequiredOnly:
          document.getElementById("fill-required-only")?.checked,
        autoExportLogs: document.getElementById("auto-export-logs")?.checked,
        debugLogSinkEnabled: document.getElementById("debug-log-sink-enabled")
          ?.checked,
        autoExportLogPrefix: document.getElementById("auto-export-log-prefix")
          ?.value,
        c4PollingEnabled:
          document.getElementById("c4-polling-enabled")?.checked,
        oneActiveRunLock: document.getElementById("one-active-run-lock")
          ?.checked,
        backendUrl: document.getElementById("backend-url")?.value,
        serviceToken: document.getElementById("service-token")?.value,
        pollIntervalSeconds: document.getElementById("poll-interval-seconds")
          ?.value,
        heartbeatIntervalSeconds: document.getElementById(
          "heartbeat-interval-seconds",
        )?.value,
        allowGeneratedAnswers: document.getElementById(
          "allow-generated-answers",
        )?.checked,
        flagLowConfidenceAnswers: document.getElementById(
          "flag-low-confidence-answers",
        )?.checked,
        stripLongDash: document.getElementById("strip-long-dash")?.checked,
      },
    });

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
  .getElementById("import-profile-tex")
  ?.addEventListener("click", async () => {
    try {
      const file = document.getElementById("profile-tex-file")?.files?.[0];
      if (!file) {
        setStatus("Choose a TeX resume first.", "warn");
        return;
      }

      const tex = await readFileAsText(file);
      const parsedProfile = parseResumeTex(tex);
      const nextProfile = {
        ...readFullProfileForm(),
        ...mergeProfileFromResume(readProfileForm(), parsedProfile),
      };

      writeProfileFields(nextProfile);
      const response = await saveProfile(nextProfile);
      const missingFields = listMissingProfileFields(nextProfile);
      if (response?.ok) {
        await chrome.runtime.sendMessage({
          type: "hunt.apply.log_activity",
          payload: {
            action: "profile.import_tex",
            summary: `Imported profile fields from ${file.name}.`,
            details: {
              fileName: file.name,
              missingFields,
            },
          },
        });
        await loadState();
      }

      setStatus(
        response?.ok
          ? missingFields.length
            ? `Imported profile from ${file.name}. Please fill: ${missingFields.join(", ")}.`
            : `Imported and saved profile from ${file.name}.`
          : response?.message || "Failed to save imported profile.",
        response?.ok ? "info" : "warn",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "warn");
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
