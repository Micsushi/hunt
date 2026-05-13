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
let pendingNextAfterFill = null;

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

function showNextConfirm({ tabId, nextAction }) {
  const panel = document.getElementById("next-confirm");
  const copy = document.getElementById("next-confirm-copy");
  if (!panel || !copy) {
    return;
  }

  pendingNextAfterFill = {
    tabId,
  };
  const label = nextAction?.candidate?.label || "Next";
  copy.textContent = `Hunt found a safe ${label} control after filling this page. Go next now, or remember this choice for future filled pages. Final submit and apply buttons stay blocked.`;
  panel.classList.remove("hidden");
}

function hideNextConfirm() {
  document.getElementById("next-confirm")?.classList.add("hidden");
  pendingNextAfterFill = null;
}

function showPostFillPrompts(response, tabId) {
  const pendingCount = Number(response?.result?.pendingLlmFieldCount || 0);
  if (response?.ok && pendingCount > 0) {
    hideNextConfirm();
    showLlmConfirm({
      tabId,
      fieldCount: pendingCount,
      filledFieldCount: Number(response?.result?.filledFieldCount || 0),
    });
    return;
  }
  if (response?.ok && response?.nextAction?.promptAvailable) {
    hideLlmConfirm();
    showNextConfirm({
      tabId,
      nextAction: response.nextAction,
    });
    return;
  }
  hideNextConfirm();
}

function fillStatusMessage(response, fallback) {
  const message = response?.message || fallback;
  if (response?.nextAction?.clicked) {
    return `${message} ${response.nextAction.message || "Clicked Next."}`;
  }
  return message;
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
    "auto-next-after-fill",
    response.settings.autoClickNextAfterFill ? "Enabled" : "Disabled",
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
  hideNextConfirm();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setStatus("Filling page...", "info");
  const responsePromise = chrome.runtime.sendMessage({
    type: "hunt.apply.fill_current_page",
    payload: {
      tabId: tab?.id || null,
      triggeredBy: "popup_fill_current_page",
    },
  });
  setTimeout(() => {
    window.close();
  }, 120);
  const response = await responsePromise;

  setStatus(
    fillStatusMessage(response, "Fill action is not implemented yet."),
    response?.ok ? "info" : "warn",
  );

  showPostFillPrompts(response, tab?.id || null);
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
    fillStatusMessage(llmResponse, "LLM fill finished."),
    llmResponse?.ok ? "info" : "warn",
  );
  showPostFillPrompts(llmResponse, pending.tabId);
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

async function clickNextAfterFill(remember) {
  const pending = pendingNextAfterFill;
  hideNextConfirm();
  if (!pending) {
    setStatus("No pending Next action is available for this tab.", "warn");
    return;
  }

  setStatus("Clicking safe Next...", "info");
  const response = await chrome.runtime.sendMessage({
    type: "hunt.apply.click_next_after_fill",
    payload: {
      tabId: pending.tabId,
      remember,
      triggeredBy: remember ? "popup_next_remember" : "popup_next",
    },
  });
  if (remember) {
    setText("auto-next-after-fill", "Enabled");
  }
  setStatus(
    response?.message || "No safe Next button was clicked.",
    response?.clicked ? "info" : "warn",
  );
}

document.getElementById("next-go")?.addEventListener("click", () => {
  clickNextAfterFill(false);
});

document.getElementById("next-always")?.addEventListener("click", () => {
  clickNextAfterFill(true);
});

document.getElementById("next-skip")?.addEventListener("click", () => {
  hideNextConfirm();
  setStatus("Stayed on the current page.", "info");
});

document.getElementById("open-options")?.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

document.getElementById("clear-page")?.addEventListener("click", async () => {
  hideLlmConfirm();
  hideNextConfirm();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setStatus("Clearing page...", "info");
  const responsePromise = chrome.runtime.sendMessage({
    type: "hunt.apply.clear_current_page",
    payload: {
      tabId: tab?.id || null,
      triggeredBy: "popup_clear_current_page",
    },
  });
  setTimeout(() => {
    window.close();
  }, 120);
  const response = await responsePromise;

  setStatus(
    response?.message || "Failed to clear the current page.",
    response?.ok ? "info" : "warn",
  );
});

loadState().catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), "warn");
});
