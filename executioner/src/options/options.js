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

async function readFileAsDataUrl(file) {
  if (!file) {
    return "";
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "hunt.apply.get_state" });
  if (!response?.ok) {
    setStatus(response?.message || "Failed to load extension state.", "warn");
    return;
  }

  setCheckboxValue("autofill-on-load", response.settings.autofillOnLoad);
  setCheckboxValue("manual-fill-enabled", response.settings.manualFillEnabled);
  setCheckboxValue(
    "allow-generated-answers",
    response.settings.allowGeneratedAnswers
  );
  setCheckboxValue(
    "flag-low-confidence-answers",
    response.settings.flagLowConfidenceAnswers
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
    response.profile.sponsorshipRequired
  );
  setCheckboxValue(
    "profile-willing-to-relocate",
    response.profile.willingToRelocate
  );
  setCheckboxValue(
    "profile-open-to-any-location",
    response.profile.openToAnyLocation
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
      : ""
  );

  setStatus("Stage 1 through Stage 4 extension state loaded.", "info");
}

document.getElementById("settings-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.save_settings",
    payload: {
      autofillOnLoad: document.getElementById("autofill-on-load")?.checked,
      manualFillEnabled: document.getElementById("manual-fill-enabled")?.checked,
      allowGeneratedAnswers: document.getElementById("allow-generated-answers")?.checked,
      flagLowConfidenceAnswers:
        document.getElementById("flag-low-confidence-answers")?.checked,
      stripLongDash: document.getElementById("strip-long-dash")?.checked
    }
  });

  setStatus(
    response?.ok ? "Settings saved." : response?.message || "Failed to save settings.",
    response?.ok ? "info" : "warn"
  );
});

document.getElementById("profile-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.save_profile",
    payload: {
      fullName: document.getElementById("profile-full-name")?.value,
      email: document.getElementById("profile-email")?.value,
      phone: document.getElementById("profile-phone")?.value,
      location: document.getElementById("profile-location")?.value,
      linkedinUrl: document.getElementById("profile-linkedin-url")?.value,
      githubUrl: document.getElementById("profile-github-url")?.value,
      websiteUrl: document.getElementById("profile-website-url")?.value,
      workAuthorized: document.getElementById("profile-work-authorized")?.checked,
      sponsorshipRequired:
        document.getElementById("profile-sponsorship-required")?.checked,
      willingToRelocate:
        document.getElementById("profile-willing-to-relocate")?.checked,
      openToAnyLocation:
        document.getElementById("profile-open-to-any-location")?.checked,
      salaryFlexible: document.getElementById("profile-salary-flexible")?.checked,
      notes: document.getElementById("profile-notes")?.value
    }
  });

  setStatus(
    response?.ok ? "Profile saved." : response?.message || "Failed to save profile.",
    response?.ok ? "info" : "warn"
  );
});

document.getElementById("resume-form")?.addEventListener("submit", async (event) => {
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
      jobId: document.getElementById("resume-job-id")?.value
    }
  });

  setStatus(
    response?.ok
      ? "Default resume metadata and cached file saved."
      : response?.message || "Failed to save default resume metadata.",
    response?.ok ? "info" : "warn"
  );
});

document.getElementById("apply-context-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const rawJson = document.getElementById("apply-context-json")?.value || "";
    const payload = JSON.parse(rawJson);
    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.set_apply_context",
      payload
    });

    setStatus(
      response?.ok
        ? "Active apply context imported."
        : response?.message || "Failed to import apply context.",
      response?.ok ? "info" : "warn"
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "warn");
  }
});

document
  .getElementById("clear-imported-context")
  ?.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.clear_apply_context"
    });

    if (!response?.ok) {
      setStatus(response?.message || "Failed to clear apply context.", "warn");
      return;
    }

    setInputValue("apply-context-json", "");
    setStatus("Active apply context cleared.", "info");
  });

loadState().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), "warn");
});
