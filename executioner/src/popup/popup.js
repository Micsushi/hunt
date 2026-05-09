function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function setStatus(message, tone = "info") {
  const element = document.getElementById("popup-status");
  if (!element) {
    return;
  }

  element.className = `status ${tone}`;
  element.textContent = message;
}

function summarizeResume(resume = {}) {
  return (
    resume.label ||
    resume.pdfFileName ||
    resume.pdfPath ||
    (resume.pdfDataUrl ? "Cached PDF" : "")
  );
}

function summarizeMode(activeApplyContext = {}) {
  return activeApplyContext.jobId ? "Job Context" : "Standalone";
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.get_state",
  });
  if (!response?.ok) {
    setStatus(response?.message || "Failed to load extension state.", "warn");
    return;
  }

  setText("active-job-id", response.activeApplyContext.jobId || "None");
  setText("active-apply-url", response.activeApplyContext.applyUrl || "None");
  setText(
    "active-resume-path",
    response.activeApplyContext.selectedResumePath ||
      response.activeApplyContext.selectedResumeName ||
      "None",
  );
  setText("fill-mode", summarizeMode(response.activeApplyContext));
  setText("profile-name", response.profile.fullName || "Not set");
  setText(
    "default-resume-path",
    summarizeResume(response.defaultResume) || "Not set",
  );
  setText(
    "autofill-on-load",
    response.settings.autofillOnLoad ? "Enabled" : "Disabled",
  );
  const latestAttempt = response.attempts?.[response.attempts.length - 1];
  setText("latest-attempt-status", latestAttempt?.status || "None");
  setText(
    "latest-attempt-summary",
    latestAttempt?.resultSummary || "No attempts logged.",
  );

  setStatus(
    response.activeApplyContext.jobId
      ? "Job context mode loaded."
      : "Standalone mode loaded.",
    "info",
  );
}

document.getElementById("fill-now")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.fill_current_page",
    payload: { tabId: tab?.id || null },
  });

  setStatus(
    response?.message || "Fill action is not implemented yet.",
    response?.ok ? "info" : "warn",
  );
});

document.getElementById("open-options")?.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

document
  .getElementById("clear-context")
  ?.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "hunt.apply.clear_apply_context",
    });

    if (!response?.ok) {
      setStatus(response?.message || "Failed to clear active context.", "warn");
      return;
    }

    await loadState();
    setStatus("Active apply context cleared.", "info");
  });

loadState().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), "warn");
});
