// fill-runner.js
// Resolves the correct ATS adapter for a tab, injects shared utilities and
// the adapter fill function, then logs the attempt.
// Adding a new ATS: import its createXxxFillFunction, add it to FILL_ADAPTERS.
import { detectAtsFromUrl } from "../ats/registry.js";
import { GENERIC_FIELD_RULES } from "../ats/generic/field-rules.js";
import { createGenericFillFunction } from "../ats/generic/fill.js";
import { createWorkdayFillFunction } from "../ats/workday/fill.js";
import { appendAttempt, appendQuestionAnswers } from "../shared/storage.js";
import { selectFillRoute } from "./fill-routes.js";

// Map of ATS name → fill-function factory.
// Each factory must return a self-contained async function (no outer references)
// because Chrome serialises it via Function.prototype.toString() for injection.
const FILL_ADAPTERS = {
  generic: createGenericFillFunction,
  workday: createWorkdayFillFunction,
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

function chooseBestFrameResult(frameResults = []) {
  const usableResults = frameResults
    .map((entry) => ({
      frameId: entry.frameId,
      result: entry.result || {},
    }))
    .filter((entry) => entry.result && entry.result.ok !== false);
  if (!usableResults.length) {
    return (
      frameResults[0]?.result || {
        ok: false,
        reason: "missing_result",
        message: "No fill result was returned.",
      }
    );
  }
  usableResults.sort((a, b) => {
    const aFilled = Number(a.result.filledFieldCount || 0);
    const bFilled = Number(b.result.filledFieldCount || 0);
    if (aFilled !== bFilled) {
      return bFilled - aFilled;
    }
    const aInventory = Array.isArray(a.result.fieldInventory)
      ? a.result.fieldInventory.length
      : 0;
    const bInventory = Array.isArray(b.result.fieldInventory)
      ? b.result.fieldInventory.length
      : 0;
    if (aInventory !== bInventory) {
      return bInventory - aInventory;
    }
    return Number(a.frameId || 0) - Number(b.frameId || 0);
  });
  return {
    ...usableResults[0].result,
    frameId: usableResults[0].frameId,
    frameResults: usableResults.map((entry) => ({
      frameId: entry.frameId,
      atsType: entry.result.atsType || "unknown",
      filledFieldCount: entry.result.filledFieldCount || 0,
      fieldInventoryCount: Array.isArray(entry.result.fieldInventory)
        ? entry.result.fieldInventory.length
        : 0,
      manualReviewRequired: Boolean(entry.result.manualReviewRequired),
      manualReviewReasons: entry.result.manualReviewReasons || [],
    })),
  };
}

export async function runFillForTab(tabId, extensionState) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = tabId || tab?.id;
  if (!activeTabId) {
    return {
      ok: false,
      reason: "missing_tab",
      message: "No active tab is available for fill.",
    };
  }

  const tabInfo = await chrome.tabs.get(activeTabId);
  const pageUrl = tabInfo.url || "";

  const detectedAtsType = detectAtsFromUrl(pageUrl);
  const route = selectFillRoute({
    activeApplyContext: extensionState.activeApplyContext,
    detectedAtsType,
    availableAdapters: Object.keys(FILL_ADAPTERS),
  });
  const atsType = route.adapterName;

  const adapterFactory = FILL_ADAPTERS[atsType];
  if (!adapterFactory) {
    const supported = Object.keys(FILL_ADAPTERS).join(", ");
    return {
      ok: false,
      reason: "unsupported_ats",
      atsType,
      message: `ATS "${atsType}" is not yet supported. Supported: ${supported}.`,
    };
  }

  // Step 1: inject shared utilities into the page.
  await chrome.scripting.executeScript({
    target: { tabId: activeTabId, allFrames: true },
    files: ["src/shared/injected.js"],
  });

  // Step 2: inject and run the ATS-specific fill function.
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId: activeTabId, allFrames: true },
    func: adapterFactory(),
    args: [
      {
        profile: extensionState.profile,
        settings: extensionState.settings,
        activeApplyContext: extensionState.activeApplyContext,
        defaultResume: extensionState.defaultResume,
        fieldRules: GENERIC_FIELD_RULES,
        fillRoute: route,
      },
    ],
  });

  const result = chooseBestFrameResult(injectionResults);

  const screenshotDataUrl = await captureScreenshot();
  const attemptId = crypto.randomUUID();
  const manualReviewRequired = Boolean(result.manualReviewRequired);

  const attempt = await appendAttempt({
    id: attemptId,
    sourceMode: extensionState.activeApplyContext.jobId
      ? "c4_or_queue"
      : "manual",
    jobId: extensionState.activeApplyContext.jobId,
    applyUrl: extensionState.activeApplyContext.applyUrl || pageUrl,
    atsType: result.atsType || atsType,
    fillRoute: route.routeName,
    status: result.ok
      ? manualReviewRequired
        ? "manual_review"
        : "filled"
      : "failed",
    authState: result.authState || "unknown",
    selectedResumeVersionId:
      extensionState.activeApplyContext.selectedResumeVersionId ||
      extensionState.defaultResume.versionId,
    selectedResumePath:
      extensionState.activeApplyContext.selectedResumePath ||
      extensionState.defaultResume.pdfPath ||
      extensionState.defaultResume.pdfFileName,
    filledFieldCount: result.filledFieldCount || 0,
    generatedAnswerCount: result.generatedAnswerCount || 0,
    manualReviewRequired,
    manualReviewReasons: result.manualReviewReasons || [],
    fieldInventory: result.fieldInventory || [],
    htmlSnapshot: result.htmlSnapshot || "",
    screenshotDataUrl,
    resultSummary: result.ok
      ? manualReviewRequired
        ? `Filled ${result.filledFieldCount || 0} fields via ${route.routeName}; manual review needed.`
        : `Filled ${result.filledFieldCount || 0} fields via ${route.routeName}.`
      : result.message || result.reason || "Fill failed.",
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
    manualReviewRequired: entry.manualReviewRequired,
  }));
  await appendQuestionAnswers(answerEntries);

  return {
    ok: result.ok,
    message: result.ok
      ? manualReviewRequired
        ? `Filled ${result.filledFieldCount || 0} fields; manual review needed.`
        : `Filled ${result.filledFieldCount || 0} fields and logged ${result.generatedAnswerCount || 0} generated answers.`
      : result.message || "Fill failed.",
    attempt,
    generatedAnswers: answerEntries,
    route,
    result,
  };
}
