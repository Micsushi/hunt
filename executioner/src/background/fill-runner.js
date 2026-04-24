// fill-runner.js
// Resolves the correct ATS adapter for a tab, injects shared utilities and
// the adapter fill function, then logs the attempt.
// Adding a new ATS: import its createXxxFillFunction, add it to FILL_ADAPTERS.
import { detectAtsFromUrl } from "../ats/registry.js";
import { createWorkdayFillFunction } from "../ats/workday/fill.js";
import { appendAttempt, appendQuestionAnswers } from "../shared/storage.js";

// Map of ATS name → fill-function factory.
// Each factory must return a self-contained async function (no outer references)
// because Chrome serialises it via Function.prototype.toString() for injection.
const FILL_ADAPTERS = {
  workday: createWorkdayFillFunction
  // greenhouse: createGreenhouseFillFunction,
  // lever:      createLeverFillFunction,
  // ashby:      createAshbyFillFunction,
};

async function captureScreenshot() {
  try {
    return await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
  } catch (_error) {
    return "";
  }
}

export async function runFillForTab(tabId, extensionState) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = tabId || tab?.id;
  if (!activeTabId) {
    return { ok: false, reason: "missing_tab", message: "No active tab is available for fill." };
  }

  const tabInfo = await chrome.tabs.get(activeTabId);
  const pageUrl = tabInfo.url || "";

  // Prefer atsType already resolved by C1 enrichment; fall back to URL detection.
  const atsType =
    extensionState.activeApplyContext.atsType ||
    detectAtsFromUrl(pageUrl);

  const adapterFactory = FILL_ADAPTERS[atsType];
  if (!adapterFactory) {
    const supported = Object.keys(FILL_ADAPTERS).join(", ");
    return {
      ok: false,
      reason: "unsupported_ats",
      atsType,
      message: `ATS "${atsType}" is not yet supported. Supported: ${supported}.`
    };
  }

  // Step 1: inject shared utilities into the page.
  await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    files: ["src/shared/injected.js"]
  });

  // Step 2: inject and run the ATS-specific fill function.
  const [injectionResult] = await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    func: adapterFactory(),
    args: [
      {
        profile: extensionState.profile,
        settings: extensionState.settings,
        activeApplyContext: extensionState.activeApplyContext,
        defaultResume: extensionState.defaultResume
      }
    ]
  });

  const result = injectionResult?.result || {
    ok: false,
    reason: "missing_result",
    message: "No fill result was returned."
  };

  const screenshotDataUrl = await captureScreenshot();
  const attemptId = crypto.randomUUID();

  const attempt = await appendAttempt({
    id: attemptId,
    sourceMode: extensionState.activeApplyContext.jobId ? "c4_or_queue" : "manual",
    jobId: extensionState.activeApplyContext.jobId,
    applyUrl: extensionState.activeApplyContext.applyUrl || pageUrl,
    atsType: result.atsType || atsType,
    status: result.ok ? "filled" : "failed",
    authState: result.authState || "unknown",
    selectedResumeVersionId:
      extensionState.activeApplyContext.selectedResumeVersionId ||
      extensionState.defaultResume.versionId,
    selectedResumePath:
      extensionState.activeApplyContext.selectedResumePath ||
      extensionState.defaultResume.pdfPath,
    filledFieldCount: result.filledFieldCount || 0,
    generatedAnswerCount: result.generatedAnswerCount || 0,
    manualReviewRequired: Boolean(result.manualReviewRequired),
    manualReviewReasons: result.manualReviewReasons || [],
    htmlSnapshot: result.htmlSnapshot || "",
    screenshotDataUrl,
    resultSummary: result.ok
      ? `Filled ${result.filledFieldCount || 0} fields on a ${atsType} page.`
      : result.message || result.reason || "Fill failed."
  });

  const answerEntries = (result.generatedAnswers || []).map((entry) => ({
    id: crypto.randomUUID(),
    applicationAttemptId: attempt.id,
    jobId: extensionState.activeApplyContext.jobId,
    questionHash: entry.questionHash,
    questionText: entry.questionText,
    answerText: entry.answerText,
    answerSource: entry.answerSource,
    confidence: entry.confidence,
    manualReviewRequired: entry.manualReviewRequired
  }));
  await appendQuestionAnswers(answerEntries);

  return {
    ok: result.ok,
    message: result.ok
      ? `Filled ${result.filledFieldCount || 0} fields and logged ${result.generatedAnswerCount || 0} generated answers.`
      : result.message || "Fill failed.",
    attempt,
    generatedAnswers: answerEntries,
    result
  };
}
