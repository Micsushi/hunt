import {
  clearActiveApplyContext,
  ensureStageOneState,
  getExtensionState,
  saveActiveApplyContext,
  saveDefaultResume,
  saveProfile,
  saveSettings
} from "../shared/storage.js";
import { detectAtsFromUrl } from "../ats/registry.js";
import { runFillForTab } from "./fill-runner.js";

async function handleMessage(message) {
  switch (message?.type) {
    case "hunt.apply.ping":
      return { ok: true, source: "background" };

    case "hunt.apply.get_state":
      return { ok: true, ...(await getExtensionState()) };

    case "hunt.apply.save_settings":
      return { ok: true, settings: await saveSettings(message.payload || {}) };

    case "hunt.apply.save_profile":
      return { ok: true, profile: await saveProfile(message.payload || {}) };

    case "hunt.apply.save_default_resume":
      return { ok: true, defaultResume: await saveDefaultResume(message.payload || {}) };

    case "hunt.apply.set_apply_context":
      return { ok: true, activeApplyContext: await saveActiveApplyContext(message.payload || {}) };

    case "hunt.apply.clear_apply_context":
      return { ok: true, activeApplyContext: await clearActiveApplyContext() };

    case "hunt.apply.fill_current_page": {
      const state = await getExtensionState();
      if (!state.settings.manualFillEnabled) {
        return {
          ok: false,
          reason: "manual_fill_disabled",
          message: "Manual fill is currently disabled in extension settings."
        };
      }
      return runFillForTab(message.payload?.tabId, state);
    }

    default:
      return {
        ok: false,
        reason: "unknown_message",
        message: `Unknown message type: ${message?.type || "undefined"}`
      };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureStageOneState();
  console.log("Hunt Apply extension installed.");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureStageOneState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }
  // Skip pages we have no adapter for to avoid unnecessary state reads.
  if (detectAtsFromUrl(tab?.url || "") === "unknown") {
    return;
  }
  (async () => {
    const state = await getExtensionState();
    if (
      !state.settings.autofillOnLoad ||
      !(state.activeApplyContext.selectedResumeDataUrl || state.defaultResume.pdfDataUrl)
    ) {
      return;
    }
    await runFillForTab(tabId, state);
  })().catch((error) => {
    console.error("Autofill on load failed:", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) =>
      sendResponse({
        ok: false,
        reason: "background_error",
        message: error instanceof Error ? error.message : String(error)
      })
    );
  return true;
});
