import {
  listMissingProfileFields,
  mergeProfileFromResume,
  parseResumeTex,
} from "./resume-parser.js";

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
  container.innerHTML = "";
  const recentEntries = [...entries].slice(-25).reverse();
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

    const file = document.getElementById("resume-pdf-file")?.files?.[0];
    const pdfDataUrl = await readFileAsDataUrl(file);

    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.save_default_resume",
      payload: {
        label: document.getElementById("resume-label")?.value,
        sourceType: document.getElementById("resume-source-type")?.value,
        pdfPath: document.getElementById("resume-pdf-path")?.value,
        pdfFileName: file?.name || "",
        pdfMimeType: file?.type || "application/pdf",
        pdfDataUrl,
        texPath: document.getElementById("resume-tex-path")?.value,
        versionId: document.getElementById("resume-version-id")?.value,
        jobId: document.getElementById("resume-job-id")?.value,
      },
    });

    setStatus(
      response?.ok
        ? "Default resume metadata and cached file saved."
        : response?.message || "Failed to save default resume metadata.",
      response?.ok ? "info" : "warn",
    );
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
