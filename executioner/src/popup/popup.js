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

let pendingLlmFill = null;

function pluralizeQuestion(count) {
  return `question${count === 1 ? "" : "s"}`;
}

function showLlmConfirm({ tabId, fieldCount, filledFieldCount }) {
  const panel = document.getElementById("llm-confirm");
  const copy = document.getElementById("llm-confirm-copy");
  if (!panel || !copy) {
    return;
  }

  pendingLlmFill = {
    tabId,
    fieldCount,
  };
  const filled = Number(filledFieldCount || 0);
  const deterministicPart =
    filled > 0
      ? `Hunt filled ${filled} deterministic field${filled === 1 ? "" : "s"}. `
      : "";
  copy.textContent = `${deterministicPart}${fieldCount} required ${pluralizeQuestion(fieldCount)} still need a decision. Use LLM help to choose from the page options, or leave them blank for manual review.`;
  panel.classList.remove("hidden");
}

function hideLlmConfirm() {
  document.getElementById("llm-confirm")?.classList.add("hidden");
  pendingLlmFill = null;
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
  setText(
    "auto-prompt",
    response.settings.autoPromptEnabled ? "Enabled" : "Disabled",
  );
  setText(
    "required-only",
    response.settings.fillRequiredOnly ? "Enabled" : "Disabled",
  );
  setText(
    "auto-export-logs",
    response.settings.autoExportLogs ? "Enabled" : "Disabled",
  );
  setText(
    "debug-log-sink",
    response.settings.debugLogSinkEnabled ? "Enabled" : "Disabled",
  );
  setText(
    "c4-polling",
    response.settings.c4PollingEnabled ? "Enabled" : "Disabled",
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
  hideLlmConfirm();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.fill_current_page",
    payload: { tabId: tab?.id || null },
  });

  setStatus(
    response?.message || "Fill action is not implemented yet.",
    response?.ok ? "info" : "warn",
  );

  const pendingCount = Number(response?.result?.pendingLlmFieldCount || 0);
  if (response?.ok && pendingCount > 0) {
    showLlmConfirm({
      tabId: tab?.id || null,
      fieldCount: pendingCount,
      filledFieldCount: Number(response?.result?.filledFieldCount || 0),
    });
  }
});

document.getElementById("llm-use")?.addEventListener("click", async () => {
  const pending = pendingLlmFill;
  hideLlmConfirm();
  if (!pending) {
    setStatus("No pending LLM fill is available for this tab.", "warn");
    return;
  }

  setStatus("Using LLM help for remaining questions...", "info");
  const llmResponse = await chrome.runtime.sendMessage({
    type: "hunt.apply.fill_remaining_with_llm",
    payload: { tabId: pending.tabId, triggeredBy: "popup_panel" },
  });
  setStatus(
    llmResponse?.message || "LLM fill finished.",
    llmResponse?.ok ? "info" : "warn",
  );
  const pendingCount = Number(llmResponse?.result?.pendingLlmFieldCount || 0);
  if (llmResponse?.ok && pendingCount > 0) {
    showLlmConfirm({
      tabId: pending.tabId,
      fieldCount: pendingCount,
      filledFieldCount: Number(llmResponse?.result?.filledFieldCount || 0),
    });
  }
});

document.getElementById("llm-skip")?.addEventListener("click", () => {
  const count = pendingLlmFill?.fieldCount || 0;
  hideLlmConfirm();
  setStatus(
    count
      ? `Left ${count} required ${pluralizeQuestion(count)} for manual review.`
      : "LLM fill skipped.",
    "warn",
  );
});

document.getElementById("open-options")?.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

document.getElementById("clear-page")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.clear_current_page",
    payload: { tabId: tab?.id || null },
  });

  setStatus(
    response?.message || "Failed to clear the current page.",
    response?.ok ? "info" : "warn",
  );
});

loadState().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), "warn");
});
