import {
  appendActivityLog,
  clearActiveApplyContext,
  clearActivityLog,
  ensureStageOneState,
  getExtensionState,
  saveActiveApplyContext,
  saveDefaultResume,
  saveProfile,
  saveSettings,
} from "../shared/storage.js";
import {
  fetchPendingFills,
  postDebugLog,
  postExtensionStatus,
  postFillResult,
} from "../shared/api.js";
import { runFillForTab, runPendingLlmFillForTab } from "./fill-runner.js";
import {
  canOfferSafeNextAfterFill,
  chooseBestSafeNextFrame,
  createSafeNextFunction,
  summarizeSafeNextResult,
} from "./safe-next.js";
import {
  WORKDAY_RUNTIME_ERROR_REASON,
  detectWorkdayRuntimeErrorForTab,
  recoverWorkdayRuntimeErrorForTab,
} from "./workday-runtime.js";

const C4_POLL_ALARM = "hunt.apply.c4.poll";
const C4_HEARTBEAT_ALARM = "hunt.apply.c4.heartbeat";
const FILL_TIMEOUT_MS = 120000;
const FILL_NO_PROGRESS_TIMEOUT_MS = 30000;
const FILL_ACTIVE_WIDGET_PROGRESS_TIMEOUT_MS = 20000;
const FILL_UPLOAD_PROGRESS_TIMEOUT_MS = 30000;
const ACTIVE_FILL_PREPARING_MESSAGE = "Preparing application workflow";
const V2_PAGE_WALK_MAX_PAGES = 12;
const V2_AUTH_FLOW_MAX_STEPS = 24;
const V2_AUTH_SAME_PAGE_MAX_ATTEMPTS = 3;
const V2_SHARED_SCRIPT_FILES = [
  "src/shared/injected.js",
  "src/shared/v2/audit.js",
  "src/shared/v2/field-catalog.js",
  "src/shared/v2/ui-inspector.js",
  "src/shared/v2/field-state.js",
  "src/shared/v2/option-collector.js",
  "src/shared/v2/option-matcher.js",
  "src/shared/v2/question-identifier.js",
  "src/shared/v2/answer-resolver.js",
  "src/shared/v2/field-drivers.js",
  "src/shared/v2/field-pipeline.js",
  "src/shared/v2/clear-pipeline.js",
];
let activeRunId = "";
const activeFillRuns = new Map();
const activeFillRunByTab = new Map();
const activeFillProgressByTab = new Map();

async function dispatchTrustedInput(payload = {}, sender = {}) {
  const tabId = payload.tabId || sender.tab?.id;
  const x = Number(payload.x);
  const y = Number(payload.y);
  const action = payload.action || "mouse_click";
  if (
    !tabId ||
    (action === "mouse_click" && (!Number.isFinite(x) || !Number.isFinite(y)))
  ) {
    return { ok: false, reason: "trusted_input_missing_target" };
  }
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
    return { ok: false, reason: "debugger_api_unavailable" };
  }
  const target = { tabId };
  let attached = false;
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach(target, "1.3", () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        attached = true;
        resolve();
      });
    });
    const events =
      action === "key_sequence"
        ? (payload.keys || []).flatMap((entry) => {
            const key = entry.key || "";
            const code = entry.code || key;
            const vk = Number(entry.windowsVirtualKeyCode || entry.vk || 0);
            return [
              {
                type: "keyDown",
                key,
                code,
                windowsVirtualKeyCode: vk,
                nativeVirtualKeyCode: vk,
              },
              {
                type: "keyUp",
                key,
                code,
                windowsVirtualKeyCode: vk,
                nativeVirtualKeyCode: vk,
              },
            ];
          })
        : [
            { type: "mouseMoved", x, y, button: "none" },
            {
              type: "mousePressed",
              x,
              y,
              button: "left",
              buttons: 1,
              clickCount: 1,
            },
            {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              buttons: 0,
              clickCount: 1,
            },
          ];
    const method =
      action === "key_sequence"
        ? "Input.dispatchKeyEvent"
        : "Input.dispatchMouseEvent";
    for (const event of events) {
      await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(target, method, event, () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve();
        });
      });
    }
    return {
      ok: true,
      reason:
        action === "key_sequence"
          ? "trusted_key_sequence_dispatched"
          : "trusted_mouse_click_dispatched",
    };
  } catch (error) {
    return {
      ok: false,
      reason: "debugger_command_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (attached) {
      try {
        await new Promise((resolve) => {
          chrome.debugger.detach(target, () => resolve());
        });
      } catch (_error) {}
    }
  }
}

async function ensurePasswordSavingDisabled(reason = "c3_fill") {
  const setting = chrome.privacy?.services?.passwordSavingEnabled;
  if (!setting?.get || !setting?.set) {
    return {
      ok: false,
      reason: "privacy_password_saving_api_unavailable",
    };
  }
  const details = await new Promise((resolve) => {
    setting.get({}, (value) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(value || {});
    });
  });
  if (details.error) {
    return {
      ok: false,
      reason: "password_saving_get_failed",
      message: details.error,
    };
  }
  if (
    details.levelOfControl &&
    !["controllable_by_this_extension", "controlled_by_this_extension"].includes(
      details.levelOfControl,
    )
  ) {
    return {
      ok: false,
      reason: "password_saving_not_controllable",
      levelOfControl: details.levelOfControl,
      value: details.value,
    };
  }
  if (details.value === false) {
    return {
      ok: true,
      changed: false,
      reason,
      levelOfControl: details.levelOfControl,
    };
  }
  return new Promise((resolve) => {
    setting.set({ value: false }, () => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          reason: "password_saving_set_failed",
          message: chrome.runtime.lastError.message,
        });
        return;
      }
      resolve({
        ok: true,
        changed: true,
        reason,
        levelOfControl: details.levelOfControl,
      });
    });
  });
}

function createFillRunId() {
  return `fill_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isFillRunCancelled(fillRunId) {
  return Boolean(fillRunId && activeFillRuns.get(fillRunId)?.cancelled);
}

function fillRunCancelReason(fillRunId) {
  return (
    activeFillRuns.get(fillRunId)?.cancelReason ||
    activeFillRuns.get(fillRunId)?.reason ||
    "user_cancelled"
  );
}

function cancelFillRun(fillRunId) {
  if (!fillRunId) {
    return false;
  }
  const run = activeFillRuns.get(fillRunId);
  if (!run) {
    return false;
  }
  run.cancelled = true;
  run.cancelledAt = new Date().toISOString();
  run.cancelReason = "user_cancelled";
  try {
    run.abortController?.abort("user_cancelled");
  } catch (_error) {
    // AbortController abort is best-effort; the page-side cancel flag is still set.
  }
  return true;
}

function cancelActiveFillRunsForTab(tabId, reason = "superseded_by_new_fill") {
  if (!tabId) {
    return [];
  }
  const cancelled = [];
  for (const [fillRunId, run] of activeFillRuns.entries()) {
    if (run.tabId !== tabId || run.cancelled) {
      continue;
    }
    run.cancelled = true;
    run.cancelledAt = new Date().toISOString();
    run.cancelReason = reason;
    try {
      run.abortController?.abort(reason);
    } catch (_error) {
      // Best-effort abort for any in-flight backend request.
    }
    cancelled.push(fillRunId);
  }
  return cancelled;
}

function normalizeComparableUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    return url.href;
  } catch (_error) {
    return String(value || "").split("#")[0];
  }
}

function markFillRunExpectedReload(fillRunId, count = 1) {
  const run = fillRunId ? activeFillRuns.get(fillRunId) : null;
  if (!run) {
    return;
  }
  const increment = Math.max(1, Number(count || 1));
  run.expectedReloads = Number(run.expectedReloads || 0) + increment;
}

function allowFillRunExpectedReloadWindow(fillRunId, durationMs) {
  const run = fillRunId ? activeFillRuns.get(fillRunId) : null;
  if (!run) {
    return;
  }
  const until = Date.now() + Math.max(0, Number(durationMs || 0));
  run.expectedReloadUntil = Math.max(
    Number(run.expectedReloadUntil || 0),
    until,
  );
}

function clearFillRunExpectedReloads(fillRunId) {
  const run = fillRunId ? activeFillRuns.get(fillRunId) : null;
  if (!run) {
    return;
  }
  run.expectedReloads = 0;
  run.expectedReloadUntil = 0;
}

async function cancelFillRunForUserReload(tabId, changeInfo = {}, tab = {}) {
  if (!tabId || changeInfo.status !== "loading") {
    return;
  }
  const fillRunId = activeFillRunByTab.get(tabId);
  const run = fillRunId ? activeFillRuns.get(fillRunId) : null;
  if (!run || run.cancelled) {
    return;
  }
  const nextUrl = normalizeComparableUrl(changeInfo.url || tab?.url || "");
  const currentUrl = normalizeComparableUrl(run.lastKnownUrl || "");
  if (Number(run.expectedReloadUntil || 0) > Date.now()) {
    run.lastKnownUrl = nextUrl || currentUrl;
    return;
  }
  if (Number(run.expectedReloads || 0) > 0) {
    run.expectedReloads = Number(run.expectedReloads || 0) - 1;
    run.lastKnownUrl = nextUrl || currentUrl;
    return;
  }
  const cancelledFillRunIds = cancelActiveFillRunsForTab(
    tabId,
    "page_reloaded",
  );
  if (!cancelledFillRunIds.length) {
    return;
  }
  await markPageFillCancelled(tabId, fillRunId, true);
  await hideFillProgress(tabId);
  activeFillRunByTab.delete(tabId);
  await logActivity(
    "fill.cancel_page_reload",
    "Canceled active fill because the page started reloading.",
    {
      tabId,
      fillRunId,
      cancelledFillRunIds,
      url: tab?.url || changeInfo.url || "",
    },
    "warn",
  );
  await sendDebugLog("fill_cancelled_page_reload", {
    tabId,
    fillRunId,
    cancelledFillRunIds,
    url: tab?.url || changeInfo.url || "",
  });
}

function compactApplyContextForLog(context = {}) {
  return {
    ...context,
    selectedResumeDataUrl: context.selectedResumeDataUrl
      ? "[omitted:data-url]"
      : "",
  };
}

function debugIdentityForState(state = {}) {
  const settings = state.settings || {};
  const browserContext = state.browserContext || {};
  let manifest = {};
  try {
    manifest = chrome.runtime.getManifest();
  } catch (_error) {
    manifest = {};
  }
  return {
    browserContext: browserContext.name || "normal_chrome",
    browserContextConfiguredBy: browserContext.configuredBy || "",
    browserContextConfiguredAt: browserContext.configuredAt || "",
    browserContextDevtoolsPort: browserContext.devtoolsPort || "",
    pipelineVersion: "v2",
    useFieldPipelineV2: true,
    settingsVersion: Number(settings.settingsVersion || 0),
    extensionVersion: manifest.version || "",
    extensionId: chrome.runtime.id || "",
  };
}

function v2ScriptFilesForAts(atsType = "") {
  const files = [...V2_SHARED_SCRIPT_FILES];
  if (atsType === "workday") {
    files.push(
      "src/ats/workday/workday-ui-v2.js",
      "src/ats/workday/workday-drivers-v2.js",
      "src/ats/workday/workday-repeatables-v2.js",
    );
  }
  return files;
}

async function injectV2ScriptsForTab(tabId, atsType = "") {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: v2ScriptFilesForAts(atsType),
  });
}

function choosePrimarySiteState(results = []) {
  const entries = Array.isArray(results) ? results : [];
  return (
    entries.find((entry) => entry.frameId === 0 && entry.result)?.result ||
    entries.find((entry) => entry.result?.workdayRuntimeError)?.result ||
    entries.find((entry) => entry.result)?.result ||
    null
  );
}

async function collectTabSiteState(tabId, label = "") {
  if (!tabId) {
    return { ok: false, reason: "missing_tab", label };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [label],
      func: (snapshotLabel) => {
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();
        const visible = (element) => {
          if (!element) {
            return false;
          }
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const textOf = (element) =>
          normalize(
            [
              element?.getAttribute?.("aria-label"),
              element?.innerText,
              element?.textContent,
              element?.value,
            ]
              .filter(Boolean)
              .join(" "),
          );
        const bodyText = normalize(document.body?.innerText || "");
        const lowerBody = bodyText.toLowerCase();
        const validationErrors = [
          ...document.querySelectorAll(
            [
              '[role="alert"]',
              '[data-automation-id*="error" i]',
              '[id*="error" i]',
              '[aria-invalid="true"]',
            ].join(", "),
          ),
        ]
          .filter(visible)
          .map(textOf)
          .filter(Boolean);
        const dedupedErrors = [...new Set(validationErrors)].slice(0, 20);
        const buttons = [
          ...document.querySelectorAll("button, [role='button']"),
        ]
          .filter(visible)
          .map(textOf)
          .filter(Boolean)
          .slice(0, 30);
        const controls = [
          ...document.querySelectorAll(
            "input, textarea, select, [role='combobox'], [role='listbox']",
          ),
        ].filter(visible);
        const navEntry =
          performance.getEntriesByType("navigation")?.[0] || null;
        return {
          ok: true,
          label: snapshotLabel || "",
          href: location.href,
          title: document.title || "",
          readyState: document.readyState || "",
          navigationType: navEntry?.type || "",
          navigationStart: Math.round(navEntry?.startTime || 0),
          workdayRuntimeError:
            lowerBody.includes("something went wrong") &&
            (lowerBody.includes("please refresh the page and then try again") ||
              lowerBody.includes(
                "plea e refre h the page and then try again",
              ) ||
              (lowerBody.includes("refre") && lowerBody.includes("try again"))),
          validationErrors: dedupedErrors,
          visibleControlCount: controls.length,
          hasSafeNextButton: buttons.some((text) =>
            /^(next|continue|save and continue)$/i.test(text),
          ),
          hasSubmitButton: buttons.some((text) =>
            /^(submit|submit application)$/i.test(text),
          ),
          visibleButtons: buttons,
          bodyHead: bodyText.slice(0, 500),
        };
      },
    });
    return (
      choosePrimarySiteState(results) || {
        ok: false,
        reason: "empty_snapshot",
        label,
      }
    );
  } catch (error) {
    return {
      ok: false,
      reason: "snapshot_failed",
      label,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function appendSiteActionToFillResult(result, siteAction) {
  if (!result || !siteAction) {
    return result;
  }
  const action = {
    at: new Date().toISOString(),
    ...siteAction,
  };
  result.siteActions = [...(result.siteActions || []), action];
  if (result.result) {
    result.result.siteActions = [...(result.result.siteActions || []), action];
  }
  if (result.attempt) {
    result.attempt.siteActions = [
      ...(result.attempt.siteActions || []),
      action,
    ];
  }
  return result;
}

function appendMonitorSiteActionsToFillResult(result, monitor) {
  for (const event of monitor?.events || []) {
    appendSiteActionToFillResult(result, event);
  }
  return result;
}

function fillManualReviewReasons(result) {
  return [
    ...(result?.attempt?.manualReviewReasons || []),
    ...(result?.result?.manualReviewReasons || []),
  ].map((reason) => String(reason || ""));
}

function fillHasManualReviewReason(result, wantedReason) {
  return fillManualReviewReasons(result).includes(wantedReason);
}

function fillHasWorkdayRuntimeError(result) {
  const siteActions = [
    ...(result?.siteActions || []),
    ...(result?.attempt?.siteActions || []),
    ...(result?.result?.siteActions || []),
  ];
  return siteActions.some((action) =>
    Boolean(action?.siteState?.workdayRuntimeError),
  );
}

function markWorkdayRuntimeErrorFill(result, siteState, reason) {
  if (!result) {
    return result;
  }
  const reviewReason = reason || "workday_runtime_error_after_fill";
  result.ok = false;
  result.reason = reviewReason;
  result.message =
    "Workday showed its refresh-required error page during fill. C3 stopped before clicking Next.";
  result.workdayRuntimeError = true;
  result.workdayRuntimeSiteState = siteState || {};
  if (result.attempt) {
    result.attempt.status = "manual_review";
    result.attempt.manualReviewRequired = true;
    result.attempt.manualReviewReasons = Array.from(
      new Set([...(result.attempt.manualReviewReasons || []), reviewReason]),
    );
  }
  if (result.result) {
    result.result.manualReviewRequired = true;
    result.result.manualReviewReasons = Array.from(
      new Set([...(result.result.manualReviewReasons || []), reviewReason]),
    );
  }
  return result;
}
function startFillSiteActionMonitor(tabId, fillRunId) {
  if (!tabId) {
    return { stop: () => {}, events: [] };
  }
  const events = [];
  const listener = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId) {
      return;
    }
    const status = changeInfo.status || "";
    const url = changeInfo.url || "";
    if (!status && !url) {
      return;
    }
    const action =
      status === "loading" || url ? "site.navigation_started" : "site.loaded";
    const summary =
      action === "site.navigation_started"
        ? "Site navigation started during fill."
        : "Site finished loading during fill.";
    Promise.resolve(
      collectTabSiteState(tabId, action).then((siteState) => {
        const event = {
          action,
          status: siteState.workdayRuntimeError ? "blocked" : "info",
          reason: status || (url ? "url_changed" : ""),
          changeInfo,
          siteState,
        };
        events.push(event);
        return logActivity(
          action,
          summary,
          { tabId, fillRunId, changeInfo, siteState },
          event.status,
        );
      }),
    ).catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(listener);
  return {
    events,
    stop: () => {
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (_error) {
        // Best-effort cleanup only.
      }
    },
  };
}

function withTimeout(promise, timeoutMs, fallbackFactory) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(
        typeof fallbackFactory === "function"
          ? fallbackFactory()
          : fallbackFactory,
      );
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function sendDebugLog(eventType, payload = {}) {
  try {
    const state = await getExtensionState();
    if (!state.settings.debugLogSinkEnabled || !state.settings.backendUrl) {
      return { ok: false, skipped: true, reason: "debug_sink_disabled" };
    }
    return await postDebugLog(state.settings, {
      eventType,
      extensionTime: new Date().toISOString(),
      ...debugIdentityForState(state),
      activeApplyContext: compactApplyContextForLog(state.activeApplyContext),
      payload,
    });
  } catch (error) {
    console.warn("C3 debug log sink failed:", error);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function logActivity(action, summary, details = {}, status = "ok") {
  let activity = null;
  try {
    activity = await appendActivityLog({
      action,
      summary,
      details,
      status,
    });
  } catch (error) {
    activity = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      action,
      summary,
      details: {
        ...details,
        localActivityLogSkipped: true,
        localActivityLogError:
          error instanceof Error ? error.message : String(error),
      },
      status,
    };
    console.warn("C3 activity log storage failed:", error);
  }
  await sendDebugLog("activity", { activity });
  return activity;
}

function chooseBestWorkflowDetection(results = []) {
  const detections = (results || []).map((entry) => ({
    frameId: entry.frameId,
    result: entry.result || {},
  }));
  const mainFrameApplication = detections.find(
    (entry) =>
      entry.frameId === 0 &&
      entry.result?.ok &&
      entry.result?.isJobFillPage &&
      entry.result?.currentStep?.title,
  );
  if (mainFrameApplication) {
    return mainFrameApplication.result;
  }
  const ranked = detections
    .filter((entry) => entry.result?.ok)
    .sort(
      (a, b) => Number(b.result.priority || 0) - Number(a.result.priority || 0),
    );
  return ranked[0]?.result || detections[0]?.result || { ok: false };
}

function chooseBestWorkflowActionResult(results = []) {
  const actionResults = (results || [])
    .map((entry) => entry.result || null)
    .filter((result) => result && Object.keys(result).length);
  return (
    actionResults.find(
      (result) => result.ok && result.clicked && !result.skipped,
    ) ||
    actionResults.find((result) => result.ok && result.navigationStarted) ||
    actionResults.find((result) => result.ok && result.skipped) ||
    actionResults.find((result) => result.ok) ||
    actionResults.find((result) => result.reason) ||
    actionResults[0] || { ok: false, reason: "no_action_result" }
  );
}

function createC3WorkflowDetectionFunction() {
  return function detectC3WorkflowPage() {
    function normalize(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function currentWorkdayStep() {
      var activeStep = document.querySelector(
        '[data-automation-id="progressBarActiveStep"]',
      );
      if (activeStep) {
        var steps = Array.from(
          document.querySelectorAll('[data-automation-id^="progressBar"]'),
        );
        var labels = Array.from(activeStep.querySelectorAll("label"))
          .map(function (label) {
            return normalize(label.innerText || label.textContent || "");
          })
          .filter(Boolean);
        var title =
          labels[labels.length - 1] ||
          normalize(activeStep.innerText || activeStep.textContent || "")
            .split(/\n/)
            .map(normalize)
            .filter(Boolean)
            .pop() ||
          "";
        return title
          ? {
              current: Math.max(steps.indexOf(activeStep) + 1, 1),
              total: steps.length || 1,
              title: title,
            }
          : null;
      }
      var bodyText = document.body ? document.body.innerText || "" : "";
      var stepMatch =
        bodyText.match(/current\s+s?tep\s+(\d+)\s+of\s+(\d+)\s*\n([^\n]+)/i) ||
        normalize(bodyText).match(
          /current\s+s?tep\s+(\d+)\s+of\s+(\d+)\s+(.+?)(?:\s+s?tep\s+\d+\s+of\s+\d+|$)/i,
        );
      return stepMatch
        ? {
            current: Number(stepMatch[1]),
            total: Number(stepMatch[2]),
            title: normalize(stepMatch[3]),
          }
        : null;
    }

    function visible(el) {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    var bodyText = document.body ? document.body.innerText || "" : "";
    var lowerText = bodyText.toLowerCase();
    var path = location.pathname.toLowerCase();
    var inputs = Array.from(
      document.querySelectorAll("input, textarea, select"),
    ).filter(visible);
    var passwordCount = inputs.filter(function (el) {
      return String(el.type || "").toLowerCase() === "password";
    }).length;
    var emailCount = inputs.filter(function (el) {
      return /email/i.test(
        [
          el.type,
          el.name,
          el.id,
          el.placeholder,
          el.autocomplete,
          el.getAttribute("aria-label"),
          el.getAttribute("data-automation-id"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    }).length;
    var buttonItems = Array.from(
      document.querySelectorAll("a, button, [role='button']"),
    )
      .filter(visible)
      .map(function (el) {
        var visibleText = normalize(
          [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.innerText,
            el.textContent,
          ]
            .filter(Boolean)
            .join(" "),
        );
        var metadata = normalize(
          [
            el.getAttribute("data-automation-id"),
            el.getAttribute("data-testid"),
            el.id,
            el.getAttribute("name"),
            el.href,
          ]
            .filter(Boolean)
            .join(" "),
        );
        return {
          label: normalize([visibleText, metadata].filter(Boolean).join(" ")),
          visibleText: visibleText,
          metadata: metadata,
          href: el.href || "",
        };
      })
      .filter(function (item) {
        return item.label || item.visibleText || item.href;
      });
    var buttonLabels = buttonItems.map(function (item) {
      return item.label;
    });
    var buttons = buttonLabels.slice(0, 80);
    var currentStep = currentWorkdayStep();
    var startApplication = /start your application/i.test(bodyText);
    function isWorkdayDetailsApplyItem(item) {
      var text = normalize(item && (item.visibleText || item.label));
      var metadata = normalize(item && item.metadata);
      var href = normalize(item && item.href);
      return (
        /^apply(?:\s+apply)?$/i.test(text) ||
        (/^apply\b/i.test(text) && /\/apply(?:$|[/?#\s])/i.test(href || metadata)) ||
        (/^apply\b/i.test(text) &&
          /apply|jobApply|externalApply/i.test(metadata))
      );
    }
    var applyManually = buttonLabels.some(function (label) {
      return (
        /^apply manually$/i.test(label) ||
        (startApplication && /\/apply\/applyManually/i.test(label))
      );
    });
    var workdayDetailsApply =
      /myworkdayjobs\.com/i.test(location.hostname || "") &&
      (path.includes("/details/") || path.includes("/job/")) &&
      buttonItems.some(function (item) {
        return isWorkdayDetailsApplyItem(item);
      });
    var genericApplyEntry =
      (location.hostname.toLowerCase().includes("career") ||
        location.hostname.toLowerCase().includes("jobs") ||
        path.includes("career") ||
        path.includes("job")) &&
      buttonLabels.some(function (label) {
        return (
          /(^|\s)apply now(\s|$)/i.test(label) ||
          /apply for this job/i.test(label) ||
          /apply to this job/i.test(label) ||
          /start application/i.test(label)
        );
      });
    var hasCreateAccount =
      /create account|join today|verify new password|password requirements/i.test(
        lowerText,
      ) ||
      buttonLabels.some(function (label) {
        return /create account|join today|sign up|register/i.test(label);
      });
    var hasSignIn =
      /already have an account|sign in|log in|login/i.test(lowerText) ||
      buttonLabels.some(function (label) {
        return /sign in|log in|login/i.test(label);
      });
    var hasEmailSigninChoice = buttonLabels.some(function (label) {
      var signal = label.toLowerCase().replace(/[^a-z0-9]+/g, "");
      return (
        /\bsign in with email\b|\bsign in using email\b|\bemail sign in\b/i.test(
          label,
        ) || signal.includes("signinwithemailbutton")
      );
    });
    var isWorkdayLoginPath =
      /myworkdayjobs\.com/i.test(location.hostname || "") &&
      /\/login\/?$/i.test(location.pathname || "");
    var hasLoginFailure =
      /wrong email address or password|account might be locked|invalid email address or password|invalid username or password|incorrect email or password/i.test(
        lowerText,
      );
    var needsEmailLinkVerification =
      /email has been sent|verify your account|verify your email|confirm your email|check your email|activation link|verification link/i.test(
        lowerText,
      );
    var authState = "unknown";
    var authUiState = "unknown";
    var phase = "job_fill";
    var priority = 10;
    var currentStepTitle = currentStep ? normalize(currentStep.title) : "";
    var currentStepIsAuth =
      currentStepTitle &&
      /create account|sign in|log in|login|register|sign up/i.test(
        currentStepTitle,
      ) &&
      (passwordCount || emailCount || hasCreateAccount || hasSignIn);
    if (currentStep && !currentStepIsAuth) {
      phase = "job_fill";
      priority = 40;
    } else if (
      startApplication ||
      applyManually ||
      workdayDetailsApply ||
      genericApplyEntry
    ) {
      phase = "apply_entry";
      priority = 50;
    } else if (
      currentStepIsAuth ||
      hasEmailSigninChoice ||
      (isWorkdayLoginPath && hasSignIn) ||
      passwordCount ||
      (emailCount && (hasCreateAccount || hasSignIn) && !genericApplyEntry)
    ) {
      phase = "auth";
      priority = 60;
      if (needsEmailLinkVerification) {
        authState = "verify_email";
        authUiState = "email_link_verification";
      } else if (hasLoginFailure && hasCreateAccount) {
        authState = "signup";
        authUiState = "landing_choice";
      } else if (
        currentStepIsAuth &&
        hasCreateAccount &&
        /create account|sign up|register/i.test(currentStepTitle)
      ) {
        authState = "signup";
        authUiState = passwordCount >= 2 ? "signup_form" : "landing_choice";
      } else if (hasCreateAccount && passwordCount >= 2) {
        authState = "signup";
        authUiState = "signup_form";
      } else if (
        hasSignIn ||
        passwordCount ||
        currentStepIsAuth ||
        hasEmailSigninChoice
      ) {
        authState = "login";
        authUiState =
          emailCount && passwordCount ? "credential_form" : "landing_choice";
      }
    }
    return {
      ok: true,
      href: location.href,
      title: document.title,
      phase: phase,
      priority: priority,
      authState: authState,
      authUiState: authUiState,
      isAuthPage: phase === "auth",
      isApplyEntryPage: phase === "apply_entry",
      isJobFillPage: phase === "job_fill",
      inputCount: inputs.length,
      passwordCount: passwordCount,
      emailCount: emailCount,
      hasCreateAccount: hasCreateAccount,
      hasSignIn: hasSignIn,
      hasEmailSigninChoice: hasEmailSigninChoice,
      hasLoginFailure: hasLoginFailure,
      needsEmailLinkVerification: needsEmailLinkVerification,
      startApplication: startApplication,
      applyManually: applyManually,
      workdayDetailsApply: workdayDetailsApply,
      genericApplyEntry: genericApplyEntry,
      currentStep: currentStep
        ? {
            current: Number(currentStep.current),
            total: Number(currentStep.total),
            title: currentStepTitle,
          }
        : null,
      buttons: buttons,
    };
  };
}

function createClickAuthPrimaryActionFunction() {
  return function clickAuthPrimaryActionForC3(options) {
    var authState = String((options && options.authState) || "").toLowerCase();
    var authUiState = String(
      (options && options.authUiState) || "",
    ).toLowerCase();
    var accountEmail = normalize((options && options.accountEmail) || "");
    var accountPassword = normalize((options && options.accountPassword) || "");
    var click = Boolean(options && options.click);

    function normalize(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function lower(value) {
      return normalize(value).toLowerCase();
    }

    function visible(el) {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      if (
        el.disabled ||
        el.getAttribute("disabled") !== null ||
        el.getAttribute("aria-disabled") === "true" ||
        el.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function labelFor(el) {
      var tagName = String(el.tagName || "").toLowerCase();
      return normalize(
        [
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          tagName === "input" ? el.value : "",
          el.innerText,
          el.textContent,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    function metadataFor(el) {
      return normalize(
        [
          el.id,
          el.getAttribute("name"),
          el.getAttribute("type"),
          el.getAttribute("data-automation-id"),
          el.getAttribute("data-testid"),
          el.getAttribute("class"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    function describeElement(el) {
      var parts = [String(el.tagName || "").toLowerCase()];
      if (el.id) {
        parts.push("#" + el.id);
      }
      var name = el.getAttribute("name");
      if (name) {
        parts.push("[name='" + name.slice(0, 60) + "']");
      }
      var type = el.getAttribute("type");
      if (type) {
        parts.push("[type='" + type.slice(0, 40) + "']");
      }
      var automationId = el.getAttribute("data-automation-id");
      if (automationId) {
        parts.push("[data-automation-id='" + automationId.slice(0, 60) + "']");
      }
      return parts.join("");
    }

    function authScore(label, metadata, el) {
      var text = lower([label, metadata].filter(Boolean).join(" "));
      var visibleText = lower(label);
      var wantsSignup = authState === "signup";
      var wantsSignin = authState === "login" || authState === "signin";
      var wantsEmailVerification = authState === "verify_email";
      var wantsCredentialSubmit = authUiState === "credential_form";
      var wantsLandingChoice = authUiState === "landing_choice";
      var exactSignup =
        /^(create account|sign up|signup|register|join today)$/.test(
          visibleText,
        );
      var exactSignin = /^(sign in|log in|login)$/.test(visibleText);
      var exactEmailSignin =
        /\bsign in with email\b|\bsign in using email\b|\bemail sign in\b/.test(
          visibleText,
        ) ||
        lower(metadata)
          .replace(/[^a-z0-9]+/g, "")
          .includes("signinwithemailbutton");
      var exactSubmit = visibleText === "submit";
      var looseSignup =
        /(^|\b)(create account|sign up|signup|register|join today)(\b|$)/i.test(
          text,
        );
      var looseSignin = /(^|\b)(sign in|log in|login)(\b|$)/i.test(text);
      var score = 0;

      if (wantsEmailVerification) {
        return 0;
      } else if (exactEmailSignin && (!authState || authState === "unknown")) {
        score = 135;
      } else if (wantsSignup) {
        if (exactSignup) {
          score = 120;
        } else if (exactSubmit) {
          score = 110;
        } else if (looseSignup) {
          score = 95;
        }
      } else if (wantsSignin) {
        if (wantsLandingChoice && exactEmailSignin) {
          score = 135;
        } else if (wantsCredentialSubmit && exactSubmit) {
          score = 125;
        } else if (exactSignin) {
          score = 120;
        } else if (exactSubmit) {
          score = 110;
        } else if (looseSignin) {
          score = 95;
        }
      } else if (exactSignup || exactSignin) {
        score = 80;
      } else if (looseSignup || looseSignin) {
        score = 60;
      }

      if (!score) {
        return 0;
      }
      if (
        wantsCredentialSubmit &&
        /utility|navigation|header|careers page|search for jobs|talent community/i.test(
          metadata + " " + label,
        )
      ) {
        return 0;
      }
      var tagName = String(el.tagName || "").toLowerCase();
      var type = String(el.getAttribute("type") || "").toLowerCase();
      if (tagName === "button" || type === "submit") {
        score += 18;
      }
      if (el.closest("form")) {
        score += 8;
      }
      if (/signinsubmitbutton|createaccountsubmitbutton/i.test(metadata)) {
        score += 70;
      }
      if (
        tagName !== "button" &&
        type !== "submit" &&
        el.getAttribute("role") !== "button"
      ) {
        score -= 35;
      }
      if (/click_filter/i.test(metadata)) {
        score += wantsCredentialSubmit ? 35 : -25;
      }
      if (tagName === "a") {
        score -= 35;
      }
      return score;
    }

    function pointerEvent(target, type, rect) {
      var init = {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: type.includes("down") ? 1 : 0,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      };
      var EventCtor =
        window.PointerEvent && type.startsWith("pointer")
          ? window.PointerEvent
          : MouseEvent;
      target.dispatchEvent(new EventCtor(type, init));
    }

    function realisticClick(el) {
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center", inline: "center" });
      }
      if (typeof el.focus === "function") {
        try {
          el.focus({ preventScroll: true });
        } catch (_error) {
          el.focus();
        }
      }
      var rect = el.getBoundingClientRect();
      [
        "mouseover",
        "mousemove",
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ].forEach(function (type) {
        pointerEvent(el, type, rect);
      });
      if (typeof el.click === "function") {
        el.click();
      }
      var form = el.closest && el.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        var tagName = String(el.tagName || "").toLowerCase();
        var type = String(el.getAttribute("type") || "").toLowerCase();
        var isSubmitter =
          (tagName === "button" && (!type || type === "submit")) ||
          (tagName === "input" && (type === "submit" || type === "image"));
        if (isSubmitter && !el.disabled) {
          try {
            form.requestSubmit(el);
          } catch (_error) {
            // Workday often exposes a visible wrapper over the real submitter.
            // The dispatched click above is the canonical action for those UIs.
          }
        }
      }
    }

    function setNativeValue(input, value) {
      if (!input || !value) {
        return false;
      }
      if (typeof input.scrollIntoView === "function") {
        input.scrollIntoView({ block: "center", inline: "center" });
      }
      if (typeof input.focus === "function") {
        try {
          input.focus({ preventScroll: true });
        } catch (_error) {
          input.focus();
        }
      }
      try {
        var descriptor = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        );
        if (descriptor?.set) {
          descriptor.set.call(input, value);
        } else {
          input.value = value;
        }
      } catch (_error) {
        input.value = value;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      input.blur?.();
      return input.value === value;
    }

    function suppressPasswordManagerForAuthInput(input) {
      if (!input || lower(input.getAttribute("type") || "") !== "password") {
        return;
      }
      input.setAttribute("autocomplete", "new-password");
      input.setAttribute("data-hunt-password-manager-suppressed", "true");
      var form = input.closest("form");
      if (form) {
        form.setAttribute("autocomplete", "off");
        form.setAttribute("data-hunt-password-manager-suppressed", "true");
      }
    }

    function fillVisibleAuthFields() {
      var filled = [];
      Array.from(document.querySelectorAll("input"))
        .filter(visible)
        .forEach(function (input) {
          var type = lower(input.getAttribute("type") || "");
          var signal = lower(
            [
              labelFor(input),
              metadataFor(input),
              input.closest("[data-automation-id], label, div")?.innerText,
            ]
              .filter(Boolean)
              .join(" "),
          );
          var value = "";
          var source = "";
          if (
            accountEmail &&
            (type === "email" ||
              /\bemail\b|e-mail|username|user name|user id|login id/i.test(
                signal,
              ))
          ) {
            value = accountEmail;
            source = "profile:accountEmail";
          } else if (
            accountPassword &&
            type === "password" &&
            !/old password|current password|existing password|temporary password/i.test(
              signal,
            )
          ) {
            value = accountPassword;
            source = "profile:accountPassword";
          }
          if (value && input.value !== value) {
            if (source === "profile:accountPassword") {
              suppressPasswordManagerForAuthInput(input);
            }
            filled.push({
              selector: describeElement(input),
              source: source,
              ok: setNativeValue(input, value),
            });
          }
        });
      return filled;
    }

    function checkboxConsentText(checkbox) {
      return lower(
        [
          labelFor(checkbox),
          metadataFor(checkbox),
          checkbox.closest("label")?.innerText,
          checkbox.closest("[data-automation-id], section, div")?.innerText,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    function checkVisibleAuthConsentBoxes() {
      var checked = [];
      var visibleCheckboxes = Array.from(
        document.querySelectorAll('input[type="checkbox"]'),
      ).filter(visible);
      function checkboxOn(checkbox) {
        return (
          Boolean(checkbox.checked) ||
          checkbox.getAttribute("aria-checked") === "true" ||
          Boolean(checkbox.closest('[aria-checked="true"]'))
        );
      }
      visibleCheckboxes
        .filter(function (checkbox) {
          var text = checkboxConsentText(checkbox);
          return (
            visibleCheckboxes.length === 1 ||
            (/privacy notice|terms|condition|consent|agree|continuing|create account|check the box/i.test(
              text,
            ) &&
              !/do not|decline|unsubscribe|opt out/i.test(text))
          );
        })
        .forEach(function (checkbox) {
          if (!checkboxOn(checkbox)) {
            var labelFor =
              checkbox.id &&
              document.querySelector(`label[for="${CSS.escape(checkbox.id)}"]`);
            var targets = [
              labelFor,
              checkbox.closest("label"),
              checkbox.closest(
                '[role="checkbox"], [data-automation-id*="checkbox" i]',
              ),
              checkbox.parentElement,
              checkbox,
            ].filter(Boolean);
            for (
              var i = 0;
              i < targets.length && !checkboxOn(checkbox);
              i += 1
            ) {
              realisticClick(targets[i]);
            }
          }
          if (!checkboxOn(checkbox)) {
            try {
              var descriptor = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "checked",
              );
              if (descriptor?.set) {
                descriptor.set.call(checkbox, true);
              } else {
                checkbox.checked = true;
              }
            } catch (_error) {
              checkbox.checked = true;
            }
            checkbox.dispatchEvent(new Event("input", { bubbles: true }));
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
          }
          checked.push({
            id: checkbox.id || "",
            automationId: checkbox.getAttribute("data-automation-id") || "",
            checked: Boolean(checkboxOn(checkbox)),
          });
        });
      return checked;
    }

    var candidates = Array.from(
      document.querySelectorAll(
        [
          "button",
          "[role='button']",
          "input[type='button']",
          "input[type='submit']",
          "a[href]",
        ].join(", "),
      ),
    )
      .filter(visible)
      .map(function (el) {
        var label = labelFor(el);
        var metadata = metadataFor(el);
        var rect = el.getBoundingClientRect();
        return {
          element: el,
          label: (label || metadata || "account action").slice(0, 120),
          metadata: metadata.slice(0, 160),
          selector: describeElement(el),
          score: authScore(label, metadata, el),
          rect: {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter(function (candidate) {
        return candidate.score > 0;
      })
      .sort(function (a, b) {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return b.rect.top - a.rect.top;
      });

    var candidate = candidates[0] || null;
    if (!candidate) {
      return {
        ok: false,
        found: false,
        clicked: false,
        reason: "auth_primary_action_not_found",
        message: "No safe account sign-in or create-account button was found.",
        authState: authState || "unknown",
        candidateCount: 0,
      };
    }

    if (click) {
      var filledAuthFields = fillVisibleAuthFields();
      var checkedConsentBoxes = checkVisibleAuthConsentBoxes();
      realisticClick(candidate.element);
    }
    return {
      ok: true,
      found: true,
      clicked: click,
      reason: click
        ? "clicked_auth_primary_action"
        : "auth_primary_action_available",
      message: click
        ? `Clicked ${candidate.label}.`
        : `${candidate.label} is available.`,
      authState: authState || "unknown",
      candidate: {
        label: candidate.label,
        metadata: candidate.metadata,
        selector: candidate.selector,
        score: candidate.score,
        rect: candidate.rect,
      },
      checkedConsentBoxes:
        typeof checkedConsentBoxes === "undefined" ? [] : checkedConsentBoxes,
      filledAuthFields:
        typeof filledAuthFields === "undefined" ? [] : filledAuthFields,
      candidateCount: candidates.length,
    };
  };
}

function createAuthPageProbeFunction() {
  return function probeC3AuthPage() {
    function normalize(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function visible(el) {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    var bodyText = document.body ? document.body.innerText || "" : "";
    var lowerText = bodyText.toLowerCase();
    var inputs = Array.from(
      document.querySelectorAll("input, textarea, select"),
    ).filter(visible);
    var passwordCount = inputs.filter(function (el) {
      return String(el.type || "").toLowerCase() === "password";
    }).length;
    var emailCount = inputs.filter(function (el) {
      return /email/i.test(
        [
          el.type,
          el.name,
          el.id,
          el.placeholder,
          el.autocomplete,
          el.getAttribute("aria-label"),
          el.getAttribute("data-automation-id"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    }).length;
    var buttons = Array.from(
      document.querySelectorAll(
        "button, [role='button'], input[type='submit']",
      ),
    )
      .filter(visible)
      .map(function (el) {
        return normalize(
          [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            String(el.tagName || "").toLowerCase() === "input" ? el.value : "",
            el.innerText,
            el.textContent,
          ]
            .filter(Boolean)
            .join(" "),
        );
      })
      .filter(Boolean);
    var hasCreateAccount =
      /create account|join today|verify new password|password requirements/i.test(
        lowerText,
      ) ||
      buttons.some(function (label) {
        return /create account|join today|sign up|register/i.test(label);
      });
    var hasSignIn =
      /already have an account|sign in|log in|login/i.test(lowerText) ||
      buttons.some(function (label) {
        return /sign in|log in|login/i.test(label);
      });
    var hasEmailSigninChoice = buttons.some(function (label) {
      return /\bsign in with email\b|\bsign in using email\b|\bemail sign in\b/i.test(
        label,
      );
    });
    var isWorkdayLoginPath =
      /myworkdayjobs\.com/i.test(location.hostname || "") &&
      /\/login\/?$/i.test(location.pathname || "");
    var hasLoginFailure =
      /wrong email address or password|account might be locked|invalid email address or password|invalid username or password|incorrect email or password/i.test(
        lowerText,
      );
    var needsEmailLinkVerification =
      /email has been sent|verify your account|verify your email|confirm your email|check your email|activation link|verification link/i.test(
        lowerText,
      );
    var authState = needsEmailLinkVerification
      ? "verify_email"
      : hasLoginFailure && hasCreateAccount
        ? "signup"
        : hasCreateAccount && passwordCount >= 2
          ? "signup"
          : hasSignIn ||
              hasEmailSigninChoice ||
              (isWorkdayLoginPath && hasSignIn) ||
              passwordCount
            ? "login"
            : "unknown";
    var authUiState =
      authState === "verify_email"
        ? "email_link_verification"
        : authState === "signup" && passwordCount >= 2
          ? "signup_form"
          : authState === "login" && emailCount && passwordCount
            ? "credential_form"
            : authState === "login" || authState === "signup"
              ? "landing_choice"
              : "unknown";
    var isAuthPage = Boolean(
      passwordCount ||
      hasEmailSigninChoice ||
      (isWorkdayLoginPath && hasSignIn) ||
      (emailCount && (hasCreateAccount || hasSignIn)) ||
      (/current\s+s?tep\s+\d+\s+of\s+\d+[\s\S]{0,80}(create account|sign in|log in|login|register|sign up)/i.test(
        bodyText,
      ) &&
        (hasCreateAccount || hasSignIn)),
    );
    return {
      ok: true,
      href: location.href,
      title: document.title,
      isAuthPage,
      authState,
      authUiState,
      inputCount: inputs.length,
      passwordCount,
      emailCount,
      hasCreateAccount,
      hasSignIn,
      hasEmailSigninChoice,
      hasLoginFailure,
      needsEmailLinkVerification,
      buttons: buttons.slice(0, 20),
    };
  };
}

function chooseBestAuthPageProbe(results = []) {
  const probes = (results || []).map((entry) => ({
    frameId: entry.frameId,
    result: entry.result || {},
  }));
  const ranked = probes
    .filter((entry) => entry.result?.ok && entry.result?.isAuthPage)
    .sort((a, b) => {
      const passwordDelta =
        Number(b.result.passwordCount || 0) -
        Number(a.result.passwordCount || 0);
      if (passwordDelta) {
        return passwordDelta;
      }
      return (
        Number(b.result.inputCount || 0) - Number(a.result.inputCount || 0)
      );
    });
  return ranked[0] || null;
}

function createClickWorkdayApplyManuallyFunction() {
  return async function clickWorkdayApplyManuallyForC3() {
    function normalize(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function visible(el) {
      if (!el || typeof el.getBoundingClientRect !== "function") {
        return false;
      }
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function currentWorkdayStep() {
      var activeStep = document.querySelector(
        '[data-automation-id="progressBarActiveStep"]',
      );
      if (!activeStep) {
        return null;
      }
      var title = normalize(activeStep.innerText || activeStep.textContent);
      var current = activeStep.getAttribute("aria-posinset") || "";
      var total = activeStep.getAttribute("aria-setsize") || "";
      return {
        title: title,
        current: current,
        total: total,
      };
    }

    function isOracleEmailGate(text) {
      var url = location.href || "";
      var hasEmailInput = Array.from(
        document.querySelectorAll("input[type='email'], input"),
      )
        .filter(visible)
        .some(function (input) {
          var descriptor = normalize(
            [
              input.type,
              input.name,
              input.id,
              input.getAttribute("aria-label"),
              input.getAttribute("placeholder"),
            ]
              .filter(Boolean)
              .join(" "),
          );
          return /email/i.test(descriptor);
        });
      return (
        /\/apply\/email(?:$|[/?#])/i.test(url) ||
        (hasEmailInput &&
          /you don't need to have an account|using your email|email address/i.test(
            text || "",
          ))
      );
    }

    function candidatesForApplyAction() {
      return Array.from(document.querySelectorAll("a, button, [role='button']"))
        .filter(visible)
        .map(function (el) {
          var visibleText = normalize(
            [
              el.getAttribute("aria-label"),
              el.getAttribute("title"),
              el.innerText,
              el.textContent,
            ]
              .filter(Boolean)
              .join(" "),
          );
          var metadata = normalize(
            [
              el.getAttribute("data-automation-id"),
              el.getAttribute("data-testid"),
              el.id,
              el.getAttribute("name"),
              el.href,
            ]
              .filter(Boolean)
              .join(" "),
          );
          return {
            el: el,
            text: visibleText,
            metadata: metadata,
            href: el.href || "",
          };
        });
    }

    function isPlainWorkdayApplyCandidate(item) {
      var text = normalize(item && item.text);
      var metadata = normalize(item && item.metadata);
      var href = normalize(item && item.href);
      return (
        /^Apply(?:\s+Apply)?$/i.test(text) ||
        (/^Apply\b/i.test(text) && /\/apply(?:$|[/?#\s])/i.test(href || metadata)) ||
        (/^Apply\b/i.test(text) &&
          /apply|jobApply|externalApply/i.test(metadata))
      );
    }

    function isApplyManuallyCandidate(item) {
      var text = normalize(item && item.text);
      var href = normalize(item && item.href);
      return (
        /^Apply Manually(?:\s+Apply Manually)?$/i.test(text) ||
        /\/apply\/applyManually(?:$|[/?#\s])/i.test(href || text)
      );
    }

    function chooseApplyCandidate(candidates, options) {
      var allowPlainApply = Boolean(options && options.allowPlainApply);
      return (
        candidates.find(function (item) {
          return isApplyManuallyCandidate(item);
        }) ||
        candidates.find(function (item) {
          return (
            /(^|\s)apply now(\s|$)/i.test(item.text) ||
            /apply for this job/i.test(item.text) ||
            /apply to this job/i.test(item.text) ||
            /start application/i.test(item.text)
          );
        }) ||
        (allowPlainApply
          ? candidates.find(function (item) {
              return isPlainWorkdayApplyCandidate(item);
            })
          : null)
      );
    }

    function activateApplyCandidate(candidate, options) {
      var preferClick = Boolean(options && options.preferClick);
      if (candidate.href && !preferClick) {
        location.href = candidate.href;
        return {
          navigationStarted: true,
          href: candidate.href,
        };
      }
      candidate.el.scrollIntoView({ block: "center", inline: "center" });
      candidate.el.click();
      return {
        navigationStarted: false,
        href: location.href,
      };
    }

    function applyEntryState() {
      var text = document.body ? document.body.innerText || "" : "";
      var followupCandidates = candidatesForApplyAction();
      return {
        href: location.href,
        step: currentWorkdayStep(),
        emailGateReached: isOracleEmailGate(text),
        applyManuallyCandidate: chooseApplyCandidate(followupCandidates, {
          allowPlainApply: false,
        }),
        text: text,
      };
    }

    async function waitForApplyEntryState(predicate, timeoutMs) {
      var startedAt = Date.now();
      var lastState = applyEntryState();
      while (Date.now() - startedAt < timeoutMs) {
        lastState = applyEntryState();
        if (predicate(lastState)) {
          return lastState;
        }
        await new Promise(function (resolve) {
          setTimeout(resolve, 100);
        });
      }
      return lastState;
    }

    var bodyText = document.body ? document.body.innerText || "" : "";
    if (currentWorkdayStep()) {
      return {
        ok: true,
        skipped: true,
        reason: "already_on_application_step",
        href: location.href,
      };
    }
    var hasGenericApplyEntry = Array.from(
      document.querySelectorAll("a, button, [role='button']"),
    )
      .filter(visible)
      .some(function (el) {
        var label = normalize(
          [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.innerText,
            el.textContent,
          ]
            .filter(Boolean)
            .join(" "),
        );
        var metadata = normalize(
          [
            el.getAttribute("data-automation-id"),
            el.getAttribute("data-testid"),
            el.id,
            el.getAttribute("name"),
            el.href,
          ]
            .filter(Boolean)
            .join(" "),
        );
        return (
          isPlainWorkdayApplyCandidate({
            text: label,
            metadata: metadata,
            href: el.href || "",
          }) ||
          /(^|\s)apply now(\s|$)/i.test(label) ||
          /apply for this job/i.test(label) ||
          /apply to this job/i.test(label) ||
          /start application/i.test(label)
        );
      });
    if (!/Start Your Application/i.test(bodyText) && !hasGenericApplyEntry) {
      return {
        ok: true,
        skipped: true,
        reason: "not_on_start_application_page",
        href: location.href,
      };
    }
    var candidates = candidatesForApplyAction();
    var candidate = chooseApplyCandidate(candidates, {
      allowPlainApply:
        /myworkdayjobs\.com/i.test(location.hostname || "") &&
        /\/(?:details|job)\//i.test(location.pathname || ""),
    });
    if (!candidate) {
      return {
        ok: false,
        reason: "apply_manually_not_found",
        href: location.href,
        candidates: candidates
          .map(function (item) {
            return item.text || item.href || "";
          })
          .filter(Boolean)
          .slice(0, 30),
      };
    }
    var isPlainApplyFirstClick = isPlainWorkdayApplyCandidate(candidate);
    var firstAction = activateApplyCandidate(candidate, {
      preferClick: isPlainApplyFirstClick,
    });
    if (firstAction.navigationStarted) {
      return {
        ok: true,
        clicked: true,
        navigationStarted: true,
        label: candidate.text || "Apply",
        reason: /apply manually/i.test(candidate.text || "")
          ? "apply_manually_navigation_started"
          : "generic_apply_navigation_started",
        href: firstAction.href,
      };
    }
    var afterFirstClick = await waitForApplyEntryState(function (state) {
      return (
        Boolean(state.step) ||
        state.emailGateReached ||
        Boolean(state.applyManuallyCandidate)
      );
    }, 2500);
    var followupCandidate = afterFirstClick.applyManuallyCandidate;
    if (
      followupCandidate &&
      followupCandidate !== candidate &&
      isApplyManuallyCandidate(followupCandidate)
    ) {
      var followupAction = activateApplyCandidate(followupCandidate);
      if (followupAction.navigationStarted) {
        return {
          ok: true,
          clicked: true,
          navigationStarted: true,
          label: followupCandidate.text || "Apply Manually",
          reason: "apply_manually_navigation_started",
          href: followupAction.href,
          firstClick: candidate.text || "Apply",
        };
      }
    }
    var finalState = await waitForApplyEntryState(function (state) {
      return Boolean(state.step) || state.emailGateReached;
    }, 3600);
    var step = finalState.step;
    var emailGateReached = finalState.emailGateReached;
    return {
      ok: Boolean(step) || emailGateReached,
      clicked: true,
      label: followupCandidate?.text || candidate.text || "Apply",
      reason: step
        ? "apply_manually_clicked"
        : emailGateReached
          ? "oracle_email_gate_reached"
          : "application_step_not_reached",
      href: location.href,
      currentStep: step,
      firstClick: candidate.text || "",
    };
  };
}

class C3WorkflowSection {
  constructor({ name, tabId, fillRunId, state, triggeredBy }) {
    this.name = name;
    this.tabId = tabId;
    this.fillRunId = fillRunId;
    this.state = state;
    this.triggeredBy = triggeredBy || "fill_current_page";
  }

  async notify(message) {
    await showFillProgress(this.tabId, message, this.fillRunId);
  }

  async log(action, summary, details = {}, status = "ok") {
    const payload = {
      phase: this.name,
      fillRunId: this.fillRunId,
      triggeredBy: this.triggeredBy,
      ...details,
    };
    await logActivity(
      `workflow.${this.name}.${action}`,
      summary,
      payload,
      status,
    );
    await sendDebugLog("c3_workflow_phase", {
      phase: this.name,
      action,
      summary,
      status,
      details: payload,
    });
  }
}

class C3AuthWorkflow extends C3WorkflowSection {
  constructor(input) {
    super({ ...input, name: "auth" });
  }

  async run(detection) {
    if (!detection?.isAuthPage) {
      await this.log(
        "skip",
        "Auth workflow skipped because no account gate was detected.",
        {
          detectedPhase: detection?.phase || "unknown",
          href: detection?.href || "",
        },
      );
      return { ok: true, skipped: true, reason: "no_auth_gate", detection };
    }
    const label =
      detection.authUiState === "landing_choice"
        ? detection.authState === "signup"
          ? "Opening account signup choice"
          : "Opening email sign-in choice"
        : detection.authState === "signup"
          ? "Filling account signup fields"
          : "Filling account sign-in fields";
    await this.notify(label);
    await this.log("detect", "Detected Workday account gate before job fill.", {
      authState: detection.authState || "unknown",
      inputCount: detection.inputCount || 0,
      passwordCount: detection.passwordCount || 0,
      emailCount: detection.emailCount || 0,
      hasCreateAccount: Boolean(detection.hasCreateAccount),
      hasSignIn: Boolean(detection.hasSignIn),
      authUiState: detection.authUiState || "unknown",
      href: detection.href || "",
    });
    return { ok: true, phase: "auth", detection };
  }
}

class C3ApplyEntryWorkflow extends C3WorkflowSection {
  constructor(input) {
    super({ ...input, name: "apply_entry" });
  }

  async run(detection) {
    if (!detection?.isApplyEntryPage) {
      await this.log(
        "skip",
        detection?.currentStep
          ? "Apply-entry workflow skipped because the application form is already open."
          : "Apply-entry workflow skipped because no start-application gate was detected.",
        {
          detectedPhase: detection?.phase || "unknown",
          href: detection?.href || "",
          currentStep: detection?.currentStep || null,
        },
      );
      return {
        ok: true,
        skipped: true,
        reason: "no_apply_entry_gate",
        detection,
      };
    }
    await this.notify("Trying to start application");
    const detectLogPromise = this.log(
      "detect",
      "Detected apply-entry gate before job fill.",
      {
        href: detection.href || "",
        startApplication: Boolean(detection.startApplication),
        applyManually: Boolean(detection.applyManually),
        genericApplyEntry: Boolean(detection.genericApplyEntry),
      },
    ).catch(() => {});
    let result = null;
    let readiness = null;
    markFillRunExpectedReload(this.fillRunId, 2);
    allowFillRunExpectedReloadWindow(this.fillRunId, 20000);
    const results = await chrome.scripting.executeScript({
      target: { tabId: this.tabId, allFrames: true },
      func: createClickWorkdayApplyManuallyFunction(),
    });
    result = chooseBestWorkflowActionResult(results);
    if (result.ok && result.clicked && !result.skipped) {
      if (result.navigationStarted) {
        markFillRunExpectedReload(this.fillRunId, 2);
        allowFillRunExpectedReloadWindow(this.fillRunId, 20000);
      }
      await waitForApplyEntryTransitionForTab(this.tabId, {
        timeoutMs: result.navigationStarted ? 5000 : 2500,
      });
      readiness = await waitForApplicationFieldsReadyAfterAuth(this.tabId, {
        fillRunId: this.fillRunId,
        pageLabel: "application page",
        timeoutMs: 12000,
      });
    }
    await detectLogPromise;
    await this.log(
      result.ok ? "complete" : "failed",
      result.ok
        ? result.skipped
          ? `Apply-entry skipped: ${result.reason || "not needed"}.`
          : "Apply-entry completed before job fill."
        : "Apply-entry failed before job fill.",
      {
        result: { ...result, readiness },
      },
      result.ok ? "ok" : "failed",
    );
    return { ...result, readiness, phase: "apply_entry", detection };
  }
}

async function waitForApplyEntryTransitionForTab(
  tabId,
  { timeoutMs = 2500 } = {},
) {
  const startedAt = Date.now();
  let lastResult = { ok: false, reason: "not_checked" };
  while (Date.now() - startedAt < timeoutMs) {
    const results = await chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          function normalize(value) {
            return String(value || "")
              .replace(/\s+/g, " ")
              .trim();
          }
          const activeStep = document.querySelector(
            '[data-automation-id="progressBarActiveStep"]',
          );
          const text = document.body ? document.body.innerText || "" : "";
          const hasApplyManually = Array.from(
            document.querySelectorAll("a, button, [role='button']"),
          ).some((el) =>
            /^Apply Manually(?:\s+Apply Manually)?$/i.test(
              normalize(
                [
                  el.getAttribute("aria-label"),
                  el.innerText,
                  el.textContent,
                  el.href,
                ]
                  .filter(Boolean)
                  .join(" "),
              ),
            ),
          );
          return {
            step: activeStep
              ? normalize(activeStep.innerText || activeStep.textContent)
              : "",
            hasApplyManually,
            hasAuthOrEmailGate:
              /create account|sign in|log in|verify your email|check your email|email address/i.test(
                text,
              ),
          };
        },
      })
      .catch(() => []);
    const ready = results.some((entry) => {
      const result = entry?.result || {};
      lastResult = result;
      return (
        Boolean(result.step) ||
        Boolean(result.hasApplyManually) ||
        Boolean(result.hasAuthOrEmailGate)
      );
    });
    if (ready) {
      return { ok: true, waitedMs: Date.now() - startedAt, lastResult };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ok: false, reason: "timeout", waitedMs: timeoutMs, lastResult };
}

function pageSnapshotChangedAfterAction(
  beforeSnapshot = {},
  afterSnapshot = {},
) {
  const beforeStep = beforeSnapshot.currentStep || {};
  const afterStep = afterSnapshot.currentStep || {};
  const beforeStepNumber = Number(beforeStep.current || 0);
  const afterStepNumber = Number(afterStep.current || 0);
  if (
    beforeStepNumber &&
    afterStepNumber &&
    afterStepNumber !== beforeStepNumber
  ) {
    return true;
  }
  if (
    String(beforeStep.title || "").trim() &&
    String(afterStep.title || "").trim() &&
    String(beforeStep.title || "").trim() !==
      String(afterStep.title || "").trim()
  ) {
    return true;
  }
  if (
    String(beforeSnapshot.href || "").trim() &&
    String(afterSnapshot.href || "").trim() &&
    String(beforeSnapshot.href || "").trim() !==
      String(afterSnapshot.href || "").trim()
  ) {
    return true;
  }
  return Boolean((afterSnapshot.visibleValidationErrors || []).length);
}

function postNextSignalHasPageChange(signal = {}, beforeSnapshot = {}) {
  if (!signal?.ok || !signal.snapshot) {
    return false;
  }
  return pageSnapshotChangedAfterAction(beforeSnapshot, signal.snapshot);
}

async function waitForPostNextSignalForTab(
  tabId,
  beforeSnapshot = {},
  { timeoutMs = 1800, intervalMs = 100 } = {},
) {
  const startedAt = Date.now();
  let lastSnapshot = beforeSnapshot || {};
  let lastRuntime = { found: false, reason: "not_checked" };
  while (Date.now() - startedAt < timeoutMs) {
    lastRuntime = await detectWorkdayRuntimeErrorForTab(tabId);
    if (lastRuntime.found) {
      return {
        ok: true,
        reason: lastRuntime.reason || "workday_runtime_error",
        waitedMs: Date.now() - startedAt,
        runtime: lastRuntime,
        snapshot: lastSnapshot,
      };
    }
    lastSnapshot = await getPageSnapshot(tabId);
    if (pageSnapshotChangedAfterAction(beforeSnapshot, lastSnapshot)) {
      return {
        ok: true,
        reason: "page_state_changed",
        waitedMs: Date.now() - startedAt,
        runtime: lastRuntime,
        snapshot: lastSnapshot,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    ok: false,
    reason: "timeout",
    waitedMs: timeoutMs,
    runtime: lastRuntime,
    snapshot: lastSnapshot,
  };
}

function authDetectionChangedAfterAction(
  beforeDetection = {},
  afterDetection = {},
) {
  if (!afterDetection || !afterDetection.ok) {
    return false;
  }
  if (
    String(beforeDetection.href || "") !== String(afterDetection.href || "")
  ) {
    return true;
  }
  if (
    Boolean(beforeDetection.isAuthPage) !== Boolean(afterDetection.isAuthPage)
  ) {
    return true;
  }
  if (
    String(beforeDetection.authState || "") !==
    String(afterDetection.authState || "")
  ) {
    return true;
  }
  if (
    String(beforeDetection.authUiState || "") !==
    String(afterDetection.authUiState || "")
  ) {
    return true;
  }
  return false;
}

async function waitForAuthActionTransitionForTab(
  tabId,
  {
    beforeDetection = {},
    beforeSnapshot = {},
    timeoutMs = 2500,
    intervalMs = 100,
  } = {},
) {
  const startedAt = Date.now();
  let lastDetection = beforeDetection || {};
  let lastSnapshot = beforeSnapshot || {};
  let lastReadiness = null;
  let lastVerificationGate = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastVerificationGate = await detectEmailVerificationCodePage(tabId);
    if (lastVerificationGate.ok) {
      return {
        ok: true,
        reason: "email_verification_gate",
        waitedMs: Date.now() - startedAt,
        detection: lastDetection,
        snapshot: lastSnapshot,
        verificationGate: lastVerificationGate,
      };
    }
    lastDetection = await detectWorkflowForTab(tabId);
    if (authDetectionChangedAfterAction(beforeDetection, lastDetection)) {
      return {
        ok: true,
        reason: "auth_detection_changed",
        waitedMs: Date.now() - startedAt,
        detection: lastDetection,
        snapshot: lastSnapshot,
      };
    }
    lastSnapshot = await getPageSnapshot(tabId);
    if (pageSnapshotChangedAfterAction(beforeSnapshot, lastSnapshot)) {
      return {
        ok: true,
        reason: "page_state_changed",
        waitedMs: Date.now() - startedAt,
        detection: lastDetection,
        snapshot: lastSnapshot,
      };
    }
    lastReadiness = await inspectApplicationFieldReadiness(tabId);
    if (
      !lastDetection?.isAuthPage &&
      (lastReadiness.finalSubmitVisible ||
        lastReadiness.applicationFieldCount > 0 ||
        Boolean(lastReadiness.currentStep?.title) ||
        lastReadiness.meaningfulControlCount >= 2)
    ) {
      return {
        ok: true,
        reason: "application_fields_ready",
        waitedMs: Date.now() - startedAt,
        detection: lastDetection,
        snapshot: lastSnapshot,
        readiness: lastReadiness,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    ok: false,
    reason: "timeout",
    waitedMs: timeoutMs,
    detection: lastDetection,
    snapshot: lastSnapshot,
    readiness: lastReadiness,
    verificationGate: lastVerificationGate,
  };
}

class C3JobFillWorkflow extends C3WorkflowSection {
  constructor(input) {
    super({ ...input, name: "job_fill" });
  }

  async run(detection) {
    const hasJobFillSignal =
      Boolean(detection?.currentStep?.title) ||
      Boolean(detection?.isAuthPage) ||
      (detection?.phase === "job_fill" &&
        Number(detection?.inputCount || 0) > 0);
    if (!hasJobFillSignal) {
      await this.notify("Waiting for an application, account, or apply page");
      await this.log(
        "blocked",
        "Job-fill workflow blocked because no application surface was detected.",
        {
          detectedPhase: detection?.phase || "unknown",
          currentStep: detection?.currentStep || null,
          inputCount: detection?.inputCount || 0,
          href: detection?.href || "",
          buttons: detection?.buttons || [],
        },
        "blocked",
      );
      return {
        ok: false,
        skipped: true,
        phase: "job_fill",
        reason: "no_job_fill_surface",
        detection,
      };
    }
    const message = detection?.isAuthPage
      ? detection.authState === "signup"
        ? "Filling account signup fields"
        : "Filling account sign-in fields"
      : hasJobFillSignal
        ? `Filling ${detection?.currentStep?.title || "job application page"}`
        : "Filling page";
    await this.notify(message);
    await this.log("start", "Starting actual C3 job-fill section.", {
      detectedPhase: detection?.phase || "unknown",
      currentStep: detection?.currentStep || null,
      href: detection?.href || "",
    });
    return { ok: true, phase: "job_fill", detection };
  }
}

class C3CombinedFillWorkflow {
  constructor({ tabId, fillRunId, state, triggeredBy, initialDetection }) {
    this.tabId = tabId;
    this.fillRunId = fillRunId;
    this.state = state;
    this.triggeredBy = triggeredBy || "fill_current_page";
    this.initialDetection = initialDetection || null;
  }

  async detect() {
    const results = await chrome.scripting.executeScript({
      target: { tabId: this.tabId, allFrames: true },
      func: createC3WorkflowDetectionFunction(),
    });
    return chooseBestWorkflowDetection(results);
  }

  async prepare() {
    const initialDetection = this.initialDetection || (await this.detect());
    let auth = await new C3AuthWorkflow(this).run(initialDetection);
    let detection = initialDetection;
    if (
      auth?.ok &&
      !auth.skipped &&
      initialDetection?.isAuthPage &&
      initialDetection?.authUiState === "landing_choice"
    ) {
      const authAction = await clickAuthPrimaryActionForTab(
        this.tabId,
        initialDetection,
        {
          auto: true,
          triggeredBy: `${this.triggeredBy}:auth_landing_choice`,
        },
      );
      auth = {
        ...auth,
        ok: Boolean(authAction.clicked),
        clicked: Boolean(authAction.clicked),
        reason: authAction.clicked
          ? "auth_landing_choice_clicked"
          : authAction.reason || "auth_landing_choice_not_clicked",
        message: authAction.message || auth.message || "",
        landingChoiceAction: authAction,
      };
      if (!authAction.clicked) {
        return {
          auth,
          applyEntry: {
            ok: true,
            skipped: true,
            reason: "auth_landing_choice_not_clicked",
          },
          jobFill: {
            ok: false,
            skipped: true,
            reason: auth.reason,
          },
          initialDetection,
          detection,
        };
      }
      const authTransition = await waitForAuthActionTransitionForTab(
        this.tabId,
        {
          beforeDetection: initialDetection,
          timeoutMs: 2500,
        },
      );
      detection = authTransition.detection?.ok
        ? authTransition.detection
        : await this.detect();
    }
    const applyEntry = await new C3ApplyEntryWorkflow(this).run(detection);
    if (applyEntry?.ok && !applyEntry?.skipped) {
      const decisionReady = await waitForWorkflowDecisionReadyAfterApplyEntry(
        this.tabId,
        {
          fillRunId: this.fillRunId,
        },
      );
      detection = decisionReady.detection?.ok
        ? decisionReady.detection
        : await this.detect();
      if (detection?.isJobFillPage && !detection?.isAuthPage) {
        const applicationReady = applyEntry.readiness?.ok
          ? applyEntry.readiness
          : await waitForApplicationFieldsReadyAfterAuth(this.tabId, {
              fillRunId: this.fillRunId,
              pageLabel: "application page",
              timeoutMs: 12000,
            });
        if (!applicationReady.ok) {
          return {
            auth,
            applyEntry: {
              ...applyEntry,
              readiness: applicationReady,
            },
            jobFill: {
              ok: false,
              skipped: true,
              reason:
                applicationReady.reason || "application_fields_not_ready",
              readiness: applicationReady,
            },
            initialDetection,
            detection,
          };
        }
      }
      if (detection?.isAuthPage) {
        auth = await new C3AuthWorkflow(this).run(detection);
        if (
          auth?.ok &&
          !auth.skipped &&
          detection?.authUiState === "landing_choice"
        ) {
          const authAction = await clickAuthPrimaryActionForTab(
            this.tabId,
            detection,
            {
              auto: true,
              triggeredBy: `${this.triggeredBy}:post_apply_auth_landing_choice`,
            },
          );
          auth = {
            ...auth,
            ok: Boolean(authAction.clicked),
            clicked: Boolean(authAction.clicked),
            reason: authAction.clicked
              ? "post_apply_auth_landing_choice_clicked"
              : authAction.reason ||
                "post_apply_auth_landing_choice_not_clicked",
            message: authAction.message || auth.message || "",
            landingChoiceAction: authAction,
          };
          if (!authAction.clicked) {
            return {
              auth,
              applyEntry,
              jobFill: {
                ok: false,
                skipped: true,
                reason: auth.reason,
              },
              initialDetection,
              detection,
            };
          }
          const authTransition = await waitForAuthActionTransitionForTab(
            this.tabId,
            {
              beforeDetection: detection,
              timeoutMs: 2500,
            },
          );
          detection = authTransition.detection?.ok
            ? authTransition.detection
            : await this.detect();
        }
      }
    }
    const jobFill = await new C3JobFillWorkflow(this).run(detection);
    return {
      auth,
      applyEntry,
      jobFill,
      initialDetection,
      detection,
    };
  }
}

async function logUiEvent(action, summary, details = {}, status = "ok") {
  await sendDebugLog("ui_event", {
    action,
    summary,
    status,
    details,
  });
}

async function sendPageUiMessage({
  tabId,
  message,
  action,
  failedAction,
  summary,
  failedSummary,
  skippedAction,
  skippedSummary,
  details = {},
  timeoutMs = 2500,
}) {
  if (!tabId) {
    await logUiEvent(
      skippedAction || `${action}.skipped`,
      skippedSummary || "Skipped page UI message because no tab was available.",
      details,
      "warn",
    );
    return false;
  }
  let sent = false;
  let errorMessage = "";
  let recoveredViaInjection = false;
  try {
    await withTimeout(
      chrome.tabs.sendMessage(tabId, message),
      timeoutMs,
      () => null,
    );
    sent = true;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  if (
    !sent &&
    /receiving end does not exist|could not establish connection/i.test(
      errorMessage,
    )
  ) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content/bootstrap.js"],
      });
      await withTimeout(
        chrome.tabs.sendMessage(tabId, message),
        timeoutMs,
        () => null,
      );
      sent = true;
      recoveredViaInjection = true;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }
  await logUiEvent(
    sent ? action : failedAction || `${action}_failed`,
    sent
      ? summary
      : failedSummary ||
          `Could not ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
    {
      tabId,
      ...details,
      error: sent ? "" : errorMessage,
      recoveredViaInjection,
    },
    sent ? "ok" : "warn",
  );
  return sent;
}

function safeFilePart(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function utf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function autoExportLogs(reason) {
  const state = await getExtensionState();
  if (!state.settings.autoExportLogs) {
    return { exported: false, reason: "disabled" };
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    reason,
    settings: {
      autofillOnLoad: state.settings.autofillOnLoad,
      manualFillEnabled: state.settings.manualFillEnabled,
      autoPromptEnabled: state.settings.autoPromptEnabled,
      fillRequiredOnly: state.settings.fillRequiredOnly,
      c4PollingEnabled: state.settings.c4PollingEnabled,
      autoClickNextAfterFill: state.settings.autoClickNextAfterFill,
    },
    activeApplyContext: state.activeApplyContext,
    attempts: state.attempts,
    activityLog: state.activityLog,
  };
  const json = JSON.stringify(payload, null, 2);
  const url = `data:application/json;base64,${utf8Base64(json)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = safeFilePart(
    state.settings.autoExportLogPrefix || "hunt-c3-logs",
  );
  const filename = `${prefix}/${stamp}-${safeFilePart(reason || "event")}.json`;
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
  return { exported: true, downloadId, filename, bytes: json.length };
}

async function maybeAutoExportLogs(reason) {
  try {
    const result = await autoExportLogs(reason);
    if (result.exported) {
      await logActivity("logs.auto_export", "C3 logs auto-exported.", {
        reason,
        filename: result.filename,
        downloadId: result.downloadId,
      });
    }
    return result;
  } catch (error) {
    await logActivity(
      "logs.auto_export_failed",
      error instanceof Error ? error.message : String(error),
      { reason },
      "failed",
    );
    return { exported: false, reason: "error" };
  }
}

async function showPageToast(tabId, message, tone = "info") {
  await sendPageUiMessage({
    tabId,
    message: {
      type: "hunt.apply.show_toast",
      message,
      tone,
    },
    action: "ui.toast.requested",
    failedAction: "ui.toast.request_failed",
    summary: "Requested page toast.",
    failedSummary: "Could not request page toast.",
    skippedAction: "ui.toast.skipped",
    skippedSummary: "Skipped toast because no tab was available.",
    details: { message, tone },
  });
}

function emailVerificationBridgeUrl(settings = {}) {
  return (
    settings.emailVerificationBridgeUrl || "http://127.0.0.1:8765/verify-email"
  );
}

function hostsFromEmailVerificationPayload(payload = {}, tabUrl = "") {
  const hosts = new Set();
  const addHost = (value) => {
    if (!value) {
      return;
    }
    try {
      hosts.add(new URL(value).hostname);
    } catch {
      String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => hosts.add(item));
    }
  };
  (payload.expectedDomains || []).forEach(addHost);
  addHost(payload.jobUrl);
  addHost(tabUrl);
  return Array.from(hosts).filter(Boolean);
}

function workdayAppScopeFromUrl(value = "") {
  try {
    const url = new URL(value);
    const segments = String(url.pathname || "")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .filter((segment) => !/^[a-z]{2}-[A-Z]{2}$/i.test(segment));
    return {
      host: String(url.hostname || "").toLowerCase(),
      appSegment: String(segments[0] || "").toLowerCase(),
    };
  } catch {
    return { host: "", appSegment: "" };
  }
}

function emailVerificationExpectedApplyUrl(payload = {}, state = {}, tabUrl = "") {
  return (
    payload.expectedApplyUrl ||
    payload.applyUrl ||
    state.activeApplyContext?.applyUrl ||
    payload.jobUrl ||
    tabUrl ||
    ""
  );
}

function emailVerificationTenantMatches(expectedUrl = "", actualUrl = "") {
  const expected = workdayAppScopeFromUrl(expectedUrl);
  const actual = workdayAppScopeFromUrl(actualUrl);
  if (!expected.host || !actual.host) {
    return true;
  }
  if (expected.host !== actual.host) {
    return false;
  }
  return (
    !expected.appSegment ||
    !actual.appSegment ||
    expected.appSegment === actual.appSegment
  );
}

async function enterEmailVerificationCode(tabId, code) {
  if (!tabId || !code) {
    return { ok: false, reason: "missing_tab_or_code" };
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [String(code).replace(/\D/g, "")],
    func: async (verificationCode) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      const visible = (el) => {
        if (
          !el ||
          el.disabled ||
          el.getAttribute?.("aria-disabled") === "true"
        ) {
          return false;
        }
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const textOf = (el) =>
        normalize(
          [
            el?.getAttribute?.("aria-label"),
            el?.getAttribute?.("title"),
            el?.getAttribute?.("placeholder"),
            el?.innerText,
            el?.textContent,
            el?.value,
          ]
            .filter(Boolean)
            .join(" "),
        );
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        if (setter) {
          setter.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const keyOn = (input, key) => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key }),
        );
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
      };
      const inputs = [...document.querySelectorAll("input")]
        .filter(visible)
        .filter((input) => {
          const type = String(input.type || "text").toLowerCase();
          const text = textOf(input).toLowerCase();
          return (
            ![
              "hidden",
              "checkbox",
              "radio",
              "password",
              "file",
              "submit",
            ].includes(type) &&
            (["text", "tel", "number", "search", ""].includes(type) ||
              /code|otp|verification|passcode|one-time|security/i.test(text))
          );
        });
      if (!inputs.length) {
        return {
          ok: false,
          reason: "verification_code_inputs_not_found",
          href: location.href,
        };
      }
      const digitBoxes = inputs.filter((input) => {
        const max = Number(
          input.maxLength || input.getAttribute("maxlength") || 0,
        );
        const width = input.getBoundingClientRect().width;
        return max === 1 || width <= 80;
      });
      if (digitBoxes.length >= verificationCode.length) {
        digitBoxes.slice(0, verificationCode.length).forEach((input, index) => {
          input.focus();
          setValue(input, verificationCode[index]);
          keyOn(input, verificationCode[index]);
        });
      } else {
        const scored = inputs
          .map((input, index) => {
            const text = textOf(input).toLowerCase();
            const score =
              (/code|otp|verification|passcode|one-time|security/.test(text)
                ? 10
                : 0) - index;
            return { input, score };
          })
          .sort((a, b) => b.score - a.score);
        const input = scored[0].input;
        input.focus();
        setValue(input, verificationCode);
      }
      await sleep(300);
      const forbidden =
        /(submit application|final submit|submit my application|withdraw|delete)/i;
      const submit = [
        ...document.querySelectorAll(
          "button, [role='button'], input[type='submit']",
        ),
      ]
        .filter(visible)
        .map((el) => ({ el, text: textOf(el) }))
        .find(
          (item) =>
            !forbidden.test(item.text) &&
            /^(verify|continue|next|submit|confirm)\b/i.test(item.text),
        );
      if (submit) {
        submit.el.scrollIntoView({ block: "center", inline: "nearest" });
        submit.el.click();
      }
      await sleep(700);
      return {
        ok: true,
        method:
          digitBoxes.length >= verificationCode.length
            ? "digit_boxes"
            : "single_input",
        clickedSubmit: Boolean(submit),
        href: location.href,
      };
    },
  });
  return (
    results.find((entry) => entry.frameId === 0 && entry.result?.ok)?.result ||
    results.find((entry) => entry.result?.ok)?.result ||
    results.find((entry) => entry.result)?.result || {
      ok: false,
      reason: "verification_code_entry_failed",
    }
  );
}

async function awaitEmailVerification(payload = {}, sender = {}) {
  const tabId = payload.tabId || sender.tab?.id;
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const fillRunId = payload.fillRunId || "";
  const state = await getExtensionState();
  if (!state.settings.autoEmailVerificationEnabled && payload.force !== true) {
    await showPageToast(
      tabId,
      "Manual email verification required: auto email verification is disabled.",
      "warn",
    );
    await logActivity(
      "email_verification.disabled",
      "Email verification bridge is disabled in extension settings.",
      { tabId },
      "blocked",
    );
    return {
      ok: false,
      reason: "email_verification_disabled",
      message: "Auto email verification is disabled in extension settings.",
    };
  }
  const email =
    payload.email || state.profile.accountEmail || state.profile.email || "";
  const signupStartedAt =
    payload.signupStartedAt ||
    payload.since ||
    new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const expectedDomains = hostsFromEmailVerificationPayload(
    payload,
    tab?.url || state.activeApplyContext.applyUrl || "",
  );
  const expectedApplyUrl = emailVerificationExpectedApplyUrl(
    payload,
    state,
    tab?.url || "",
  );
  if (!email) {
    await showPageToast(
      tabId,
      "Manual email verification required: no account email is saved.",
      "warn",
    );
    await logActivity(
      "email_verification.blocked",
      "Email verification skipped because no account email is saved.",
      { tabId, expectedDomains },
      "blocked",
    );
    return {
      ok: false,
      reason: "missing_email",
      message: "No account email is saved.",
    };
  }
  await showFillProgress(
    tabId,
    `Checking ${email} for a verification code`,
    fillRunId,
  );
  const bridgeUrl = emailVerificationBridgeUrl(state.settings);
  await logActivity(
    "email_verification.wait",
    "Waiting for verification email.",
    {
      tabId,
      email,
      expectedDomains,
      signupStartedAt,
      bridgeUrl,
    },
  );
  try {
    const response = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        expectedDomains,
        since: signupStartedAt,
        timeoutSeconds:
          payload.timeoutSeconds ||
          state.settings.emailVerificationTimeoutSeconds ||
          90,
        jobUrl: payload.jobUrl || tab?.url || state.activeApplyContext.applyUrl,
        expectedApplyUrl,
        expectedJobUrl: payload.expectedJobUrl || payload.jobUrl || expectedApplyUrl,
      }),
    });
    const result = await response.json().catch(() => ({
      ok: false,
      reason: "bad_bridge_response",
    }));
    if (!response.ok || !result.ok || (!result.link && !result.code)) {
      await showPageToast(
        tabId,
        result.message || "Manual email verification required.",
        "warn",
      );
      await logActivity(
        "email_verification.failed",
        result.message || "Email verification bridge did not return a link.",
        { tabId, result },
        "blocked",
      );
      return {
        ok: false,
        reason: result.reason || "bridge_failed",
        message: result.message || "Manual email verification required.",
        bridgeResult: result,
      };
    }
    if (result.code) {
      await showFillProgress(
        tabId,
        "Verification code found. Entering code",
        fillRunId,
      );
      const codeEntry = await enterEmailVerificationCode(tabId, result.code);
      await logActivity(
        codeEntry.ok
          ? "email_verification.enter_code"
          : "email_verification.enter_code_failed",
        codeEntry.ok
          ? "Entered email verification code."
          : "Could not enter email verification code.",
        {
          tabId,
          source: result.source,
          subject: result.subject,
          receivedAt: result.receivedAt,
          codeLength: String(result.code || "").length,
          codeEntry,
        },
        codeEntry.ok ? "ok" : "blocked",
      );
      if (!codeEntry.ok) {
        await showPageToast(
          tabId,
          "Verification code found, but it could not be entered automatically.",
          "warn",
        );
        return {
          ok: false,
          reason: codeEntry.reason || "code_entry_failed",
          bridgeResult: result,
          codeEntry,
        };
      }
      await showPageToast(tabId, "Verification code entered.", "info");
      return {
        ok: true,
        method: "code",
        source: result.source,
        subject: result.subject,
        receivedAt: result.receivedAt,
        codeEntry,
      };
    }
    await showFillProgress(
      tabId,
      "Verification link found. Opening link",
      fillRunId,
    );
    await chrome.tabs.update(tabId, { url: result.link, active: true });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterTab = await chrome.tabs.get(tabId).catch(() => null);
    if (
      afterTab?.url &&
      !emailVerificationTenantMatches(expectedApplyUrl, afterTab.url)
    ) {
      await showPageToast(
        tabId,
        "Manual email verification required: verification link opened a different Workday tenant.",
        "warn",
      );
      await logActivity(
        "email_verification.tenant_mismatch",
        "Blocked email verification because the opened link did not match the current Workday tenant.",
        {
          tabId,
          source: result.source,
          subject: result.subject,
          receivedAt: result.receivedAt,
          expectedApplyUrl,
          actualUrl: afterTab.url,
          linkHost: new URL(result.link).hostname,
        },
        "blocked",
      );
      return {
        ok: false,
        reason: "verification_link_tenant_mismatch",
        message:
          "Verification link opened a different Workday tenant than the current run.",
        bridgeResult: result,
        expectedApplyUrl,
        actualUrl: afterTab.url,
      };
    }
    await logActivity(
      "email_verification.open_link",
      "Opened email verification link.",
      {
        tabId,
        source: result.source,
        subject: result.subject,
        receivedAt: result.receivedAt,
        linkHost: new URL(result.link).hostname,
      },
    );
    await showPageToast(tabId, "Verification link opened.", "info");
    return {
      ok: true,
      method: "link",
      link: result.link,
      source: result.source,
      subject: result.subject,
      receivedAt: result.receivedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await showPageToast(
      tabId,
      "Manual email verification required: local mail bridge is not available.",
      "warn",
    );
    await logActivity(
      "email_verification.bridge_unavailable",
      message,
      { tabId, bridgeUrl },
      "blocked",
    );
    return {
      ok: false,
      reason: "bridge_unavailable",
      message,
    };
  } finally {
    await hideFillProgress(tabId);
  }
}

async function showFillProgress(
  tabId,
  message = "Filling page",
  fillRunId = "",
) {
  if (tabId) {
    activeFillProgressByTab.set(tabId, {
      message,
      fillRunId,
      updatedAt: Date.now(),
    });
  }
  await sendPageUiMessage({
    tabId,
    message: {
      type: "hunt.apply.show_fill_progress",
      message,
      fillRunId,
    },
    action: "ui.fill_progress.show_requested",
    failedAction: "ui.fill_progress.show_request_failed",
    summary: "Requested fill progress indicator.",
    failedSummary: "Could not request fill progress indicator.",
    skippedAction: "ui.fill_progress.skipped",
    skippedSummary: "Skipped fill progress because no tab was available.",
    details: { message, fillRunId },
  });
}

async function hideFillProgress(tabId) {
  if (tabId) {
    activeFillProgressByTab.delete(tabId);
  }
  await sendPageUiMessage({
    tabId,
    message: {
      type: "hunt.apply.hide_fill_progress",
    },
    action: "ui.fill_progress.hide_requested",
    failedAction: "ui.fill_progress.hide_request_failed",
    summary: "Requested fill progress indicator hide.",
    failedSummary: "Could not request fill progress indicator hide.",
    skippedAction: "ui.fill_progress.hide_skipped",
    skippedSummary:
      "Skipped hiding fill progress because no tab was available.",
  });
}

async function dismissPageTransientUi(tabId, options = {}) {
  const preserveFillProgress = Boolean(options.preserveFillProgress);
  await sendPageUiMessage({
    tabId,
    message: {
      type: "hunt.apply.dismiss_transient_ui",
      preserveFillProgress,
    },
    action: "ui.transient.dismiss_requested",
    failedAction: "ui.transient.dismiss_request_failed",
    summary: "Requested transient UI dismissal.",
    failedSummary: "Could not dismiss transient UI.",
    skippedAction: "ui.transient.dismiss_skipped",
    skippedSummary:
      "Skipped transient UI dismissal because no tab was available.",
    details: { preserveFillProgress },
  });
}

async function notePageFillCompleted(tabId, payload = {}) {
  await sendPageUiMessage({
    tabId,
    message: {
      type: "hunt.apply.note_fill_completed",
      ...payload,
    },
    action: "ui.fill_completed_note.requested",
    failedAction: "ui.fill_completed_note.request_failed",
    summary: "Requested post-fill prompt cooldown.",
    failedSummary: "Could not request post-fill prompt cooldown.",
    skippedAction: "ui.fill_completed_note.skipped",
    skippedSummary:
      "Skipped post-fill prompt cooldown because no tab was available.",
    details: payload,
  });
}

async function showFillSummary(tabId, payload = {}) {
  await sendPageUiMessage({
    tabId,
    message: {
      type: "hunt.apply.show_fill_summary",
      ...payload,
    },
    action: "ui.fill_summary.requested",
    failedAction: "ui.fill_summary.request_failed",
    summary: "Requested fill summary popup.",
    failedSummary: "Could not request fill summary popup.",
    skippedAction: "ui.fill_summary.skipped",
    skippedSummary: "Skipped fill summary because no tab was available.",
    details: {
      status: payload.status || "",
      title: payload.title || "",
      failedPageNumber: payload.failedPageNumber || 0,
      stoppedReason: payload.stoppedReason || "",
      successfulPageCount: payload.successfulPageCount || 0,
      lastPageNumber: payload.lastPageNumber || 0,
      reviewIssueCount: payload.reviewIssueCount || 0,
    },
  });
}

function createPageSnapshotFunction() {
  return function pageSnapshotForHuntApply() {
    function normalizeText(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function visible(el) {
      if (!el) {
        return false;
      }
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function currentWorkdayStep() {
      var activeStep = document.querySelector(
        '[data-automation-id="progressBarActiveStep"]',
      );
      if (activeStep) {
        var steps = Array.from(
          document.querySelectorAll('[data-automation-id^="progressBar"]'),
        );
        var labels = Array.from(activeStep.querySelectorAll("label"))
          .map(function (label) {
            return normalizeText(label.innerText || label.textContent || "");
          })
          .filter(Boolean);
        var title =
          labels[labels.length - 1] ||
          normalizeText(activeStep.innerText || activeStep.textContent || "")
            .split(/\n/)
            .map(normalizeText)
            .filter(Boolean)
            .pop() ||
          "";
        return title
          ? {
              current: Math.max(steps.indexOf(activeStep) + 1, 1),
              total: steps.length || 1,
              title: title,
            }
          : null;
      }
      var bodyText = document.body?.innerText || "";
      var stepMatch =
        bodyText.match(/current\s+s?tep\s+(\d+)\s+of\s+(\d+)\s*\n([^\n]+)/i) ||
        normalizeText(bodyText).match(
          /current\s+s?tep\s+(\d+)\s+of\s+(\d+)\s+(.+?)(?:\s+s?tep\s+\d+\s+of\s+\d+|$)/i,
        );
      return stepMatch
        ? {
            current: Number(stepMatch[1]),
            total: Number(stepMatch[2]),
            title: normalizeText(stepMatch[3]),
          }
        : null;
    }

    var bodyText = document.body?.innerText || "";
    var currentStep = currentWorkdayStep();
    var errorNodes = Array.from(
      document.querySelectorAll(
        '[role="alert"], [aria-invalid="true"], [data-automation-id*="error"], .css-1f0n2jl, .css-1b3i8od',
      ),
    )
      .filter(visible)
      .map(function (el) {
        return normalizeText(el.innerText || el.textContent || el.value || "");
      })
      .filter(function (text) {
        return text && /error|required|must have a value/i.test(text);
      });
    var seen = {};
    var visibleValidationErrors = errorNodes.filter(function (text) {
      var key = text.toLowerCase();
      if (seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    });
    return {
      href: window.location.href,
      title: document.title,
      currentStep,
      visibleValidationErrors: visibleValidationErrors.slice(0, 8),
    };
  };
}

function chooseBestPageSnapshot(results = []) {
  const snapshots = results.map((entry) => ({
    frameId: entry.frameId,
    snapshot: entry.result || {},
  }));
  const withStep = snapshots.find((entry) => entry.snapshot?.currentStep);
  if (withStep) {
    return {
      frameId: withStep.frameId,
      ...withStep.snapshot,
    };
  }
  const withErrors = snapshots.find(
    (entry) => (entry.snapshot?.visibleValidationErrors || []).length,
  );
  if (withErrors) {
    return {
      frameId: withErrors.frameId,
      ...withErrors.snapshot,
    };
  }
  return {
    frameId: snapshots[0]?.frameId || 0,
    ...(snapshots[0]?.snapshot || {}),
  };
}

async function getPageSnapshot(tabId) {
  if (!tabId) {
    return {};
  }
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: createPageSnapshotFunction(),
      }),
      3000,
      () => null,
    );
    return results ? chooseBestPageSnapshot(results) : {};
  } catch (_error) {
    return {};
  }
}

async function detectEmailVerificationCodePage(tabId) {
  if (!tabId) {
    return { ok: false, reason: "missing_tab_id" };
  }
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const visible = (el) => {
            if (!el) {
              return false;
            }
            const style = window.getComputedStyle(el);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.opacity === "0"
            ) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const textOf = (el) =>
            String(el?.innerText || el?.textContent || el?.value || "")
              .replace(/\s+/g, " ")
              .trim();
          const bodyText = textOf(document.body);
          const codePageText =
            /(confirm your identity|verification code|one[-\s]?time pass ?code|type the code|enter (?:the )?(?:verification|security|one[-\s]?time|pass) ?code|otp|passcode)/i.test(
              bodyText,
            );
          const emailLinkPageText =
            /(email has been sent|verify your account|verify your email|confirm your email|check your email|activation link|verification link)/i.test(
              bodyText,
            );
          const inputs = [...document.querySelectorAll("input")]
            .filter(visible)
            .map((input) => {
              const descriptor = [
                input.type,
                input.name,
                input.id,
                input.className,
                input.getAttribute("aria-label"),
                input.getAttribute("placeholder"),
                input.getAttribute("autocomplete"),
                input.getAttribute("inputmode"),
                input.getAttribute("pattern"),
              ]
                .join(" ")
                .toLowerCase();
              const maxLength = Number(input.getAttribute("maxlength") || 0);
              return {
                descriptor,
                type: String(input.type || "").toLowerCase(),
                maxLength,
                valueLength: String(input.value || "").length,
              };
            });
          const codeInputs = inputs.filter(
            (input) =>
              /(pin-code|verification code|otp|passcode|one-time|security code|digit \d+ of)/i.test(
                input.descriptor,
              ) ||
              (codePageText &&
                ["number", "tel", "text"].includes(input.type) &&
                input.maxLength === 1),
          );
          const singleInputOtp =
            codePageText &&
            codeInputs.length === 0 &&
            inputs.filter(
              (input) =>
                ["number", "tel", "text"].includes(input.type) &&
                input.type !== "password" &&
                input.type !== "search" &&
                (input.maxLength >= 4 ||
                  /(verification code|otp|passcode|one-time|security code|one-time-code|numeric|digit|\\d)/i.test(
                    input.descriptor,
                  )),
            ).length === 1;
          const buttons = [
            ...document.querySelectorAll(
              "button, [role='button'], input[type='button'], input[type='submit']",
            ),
          ]
            .filter(visible)
            .map(textOf)
            .filter(Boolean);
          const hasVerifyButton = buttons.some((text) =>
            /^(verify|confirm|continue|next)\b/i.test(text),
          );
          const emailMatch = bodyText.match(
            /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
          );
          const codeGate =
            codePageText &&
            (codeInputs.length >= 4 || singleInputOtp) &&
            hasVerifyButton;
          const ok = codeGate || emailLinkPageText;
          return {
            ok,
            reason: ok ? "" : "not_email_verification_gate",
            gateType: codeGate ? "code" : emailLinkPageText ? "link" : "",
            href: location.href,
            email: emailMatch?.[0] || "",
            inputCount: codeInputs.length,
            buttonLabels: buttons.slice(0, 8),
            bodyHead: bodyText.slice(0, 280),
          };
        },
      }),
      3000,
      () => null,
    );
    const detections = Array.isArray(results)
      ? results.map((entry) => ({
          frameId: entry.frameId,
          ...(entry.result || {}),
        }))
      : [];
    return (
      detections.find((entry) => entry.frameId === 0 && entry.ok) ||
      detections.find((entry) => entry.ok) ||
      detections[0] || {
        ok: false,
        reason: "no_detection_result",
      }
    );
  } catch (error) {
    return {
      ok: false,
      reason: "email_verification_detection_failed",
      message: String(error?.message || error),
    };
  }
}

async function maybeHandleEmailVerificationGate({
  tabId,
  state,
  fillRunId,
  triggeredBy,
  pageIndex,
}) {
  const detection = await detectEmailVerificationCodePage(tabId);
  if (!detection.ok) {
    return { handled: false, detection };
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await showFillProgress(
    tabId,
    detection.gateType === "link"
      ? "Email verification required. Checking email"
      : "Verification code required. Checking email",
    fillRunId,
  );
  await sendDebugLog("c3_email_verification_code_gate", {
    tabId,
    fillRunId,
    triggeredBy,
    pageIndex,
    detection,
  });
  await logActivity(
    "email_verification.code_gate",
    "Detected email verification code gate during page walk.",
    { tabId, fillRunId, pageIndex, detection },
  );
  const result = await awaitEmailVerification(
    {
      tabId,
      force: true,
      email:
        detection.email ||
        state?.profile?.accountEmail ||
        state?.profile?.email ||
        "",
      jobUrl: tab?.url || state?.activeApplyContext?.applyUrl || "",
      since: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      timeoutSeconds: state?.settings?.emailVerificationTimeoutSeconds || 90,
      fillRunId,
    },
    { tab: { id: tabId } },
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { handled: true, detection, result };
}

function pageNumberFromSnapshot(snapshot = {}, fallback = 1) {
  const stepNumber = Number(snapshot.currentStep?.current || 0);
  if (Number.isFinite(stepNumber) && stepNumber > 0) {
    return stepNumber;
  }
  const fallbackNumber = Number(fallback || 1);
  return Number.isFinite(fallbackNumber) && fallbackNumber > 0
    ? fallbackNumber
    : 1;
}

function describePageWalkPage(snapshot = {}, fallbackNumber = 1) {
  const title = String(snapshot.currentStep?.title || "")
    .replace(/\s+/g, " ")
    .trim();
  const pageNumber = pageNumberFromSnapshot(snapshot, fallbackNumber);
  return title ? `${title} page ${pageNumber}` : `page ${pageNumber}`;
}

function describePageWalkAttempt(
  action,
  snapshot = {},
  fallbackNumber = 1,
  attempt = 1,
) {
  const pageLabel = describePageWalkPage(snapshot, fallbackNumber);
  return `${action} ${pageLabel}: attempt ${attempt}`;
}

async function inspectApplicationFieldReadiness(tabId) {
  if (!tabId) {
    return { ok: false, reason: "missing_tab_id" };
  }
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const normalize = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim();
          const visible = (element) => {
            if (!element) {
              return false;
            }
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          };
          const textOf = (element) =>
            normalize(
              [
                element?.getAttribute?.("aria-label"),
                element?.getAttribute?.("data-automation-id"),
                element?.getAttribute?.("placeholder"),
                element?.innerText,
                element?.textContent,
                element?.value,
              ]
                .filter(Boolean)
                .join(" "),
            );
          const bodyText = normalize(document.body?.innerText || "");
          function currentWorkdayStep() {
            const activeStep = document.querySelector(
              '[data-automation-id="progressBarActiveStep"]',
            );
            if (activeStep) {
              const steps = Array.from(
                document.querySelectorAll(
                  '[data-automation-id^="progressBar"]',
                ),
              );
              const labels = Array.from(activeStep.querySelectorAll("label"))
                .map((label) =>
                  normalize(label.innerText || label.textContent || ""),
                )
                .filter(Boolean);
              const title =
                labels[labels.length - 1] ||
                normalize(activeStep.innerText || activeStep.textContent || "")
                  .split(/\n/)
                  .map(normalize)
                  .filter(Boolean)
                  .pop() ||
                "";
              return title
                ? {
                    current: Math.max(steps.indexOf(activeStep) + 1, 1),
                    total: steps.length || 1,
                    title,
                  }
                : null;
            }
            const stepMatch =
              bodyText.match(
                /current\s+s?tep\s+(\d+)\s+of\s+(\d+)\s*\n([^\n]+)/i,
              ) ||
              normalize(bodyText).match(
                /current\s+s?tep\s+(\d+)\s+of\s+(\d+)\s+(.+?)(?:\s+s?tep\s+\d+\s+of\s+\d+|$)/i,
              );
            return stepMatch
              ? {
                  current: Number(stepMatch[1]),
                  total: Number(stepMatch[2]),
                  title: normalize(stepMatch[3]),
                }
              : null;
          }
          const currentStep = currentWorkdayStep();
          const loadingIndicators = [
            ...document.querySelectorAll(
              [
                '[role="progressbar"]',
                '[aria-busy="true"]',
                '[data-automation-id*="loading" i]',
                '[data-automation-id*="spinner" i]',
                '[class*="loading" i]',
                '[class*="spinner" i]',
              ].join(", "),
            ),
          ].filter((element) => {
            if (!visible(element)) {
              return false;
            }
            const descriptor = textOf(element).toLowerCase();
            const rect = element.getBoundingClientRect();
            return (
              element.getAttribute?.("aria-busy") === "true" ||
              /loading|spinner|progress/i.test(descriptor) ||
              rect.width >= 20
            );
          });
          const controls = [
            ...document.querySelectorAll(
              "input, textarea, select, [role='combobox'], [role='listbox']",
            ),
          ].filter(visible);
          const isApplicationControl = (control) => {
            const descriptor = [
              control.id,
              control.name,
              control.className,
              control.getAttribute?.("data-automation-id"),
              control.getAttribute?.("aria-label"),
              control.getAttribute?.("placeholder"),
              control.getAttribute?.("role"),
              control.type,
              textOf(control.closest?.("label") || control),
            ]
              .join(" ")
              .toLowerCase();
            if (control.disabled) {
              return false;
            }
            if (
              control.type &&
              /^(hidden|submit|button|reset)$/i.test(control.type)
            ) {
              return false;
            }
            if (
              /settingsselectorbutton|settings selector|language/i.test(
                descriptor,
              )
            ) {
              return false;
            }
            if (/search/i.test(descriptor) && controls.length <= 2) {
              return false;
            }
            if (
              /skip to main content|search for jobs|back to job posting|candidate home/i.test(
                descriptor,
              )
            ) {
              return false;
            }
            return true;
          };
          const applicationControls = controls.filter(isApplicationControl);
          const requiredApplicationControls = applicationControls.filter(
            (control) =>
              control.required ||
              control.getAttribute?.("aria-required") === "true" ||
              control.closest?.("[aria-required='true']") ||
              /\brequired\b/i.test(textOf(control)),
          );
          const validationErrors = [
            ...document.querySelectorAll(
              [
                '[role="alert"]',
                '[data-automation-id*="error" i]',
                '[id*="error" i]',
                '[aria-invalid="true"]',
              ].join(", "),
            ),
          ]
            .filter(visible)
            .map(textOf)
            .filter(Boolean);
          const buttons = [
            ...document.querySelectorAll("button, [role='button']"),
          ]
            .filter(visible)
            .map(textOf)
            .filter(Boolean);
          const finalSubmitVisible = buttons.some((text) =>
            /^(submit|submit application)$/i.test(text),
          );
          return {
            ok: true,
            href: location.href,
            title: document.title || "",
            currentStep,
            readyState: document.readyState || "",
            bodyHead: bodyText.slice(0, 300),
            loadingIndicatorVisible: loadingIndicators.length > 0,
            visibleControlCount: controls.length,
            meaningfulControlCount: applicationControls.length,
            applicationFieldCount: applicationControls.length,
            requiredApplicationFieldCount: requiredApplicationControls.length,
            validationErrorCount: new Set(validationErrors).size,
            finalSubmitVisible,
          };
        },
      }),
      3000,
      () => null,
    );
    const entries = Array.isArray(results)
      ? results.map((entry) => ({
          frameId: entry.frameId,
          ...(entry.result || {}),
        }))
      : [];
    return (
      entries.find(
        (entry) =>
          entry.frameId === 0 &&
          entry.ok &&
          (entry.applicationFieldCount > 0 ||
            entry.validationErrorCount > 0 ||
            entry.finalSubmitVisible),
      ) ||
      entries.find((entry) => entry.ok && entry.applicationFieldCount > 0) ||
      entries.find((entry) => entry.ok && entry.validationErrorCount > 0) ||
      entries.find((entry) => entry.ok && entry.finalSubmitVisible) ||
      entries[0] || {
        ok: false,
        reason: "empty_readiness_result",
      }
    );
  } catch (error) {
    return {
      ok: false,
      reason: "readiness_probe_failed",
      message: String(error?.message || error),
    };
  }
}

async function waitForApplicationFieldsReadyAfterAuth(
  tabId,
  { fillRunId = "", pageLabel = "application page", timeoutMs = 10000 } = {},
) {
  const startedAt = Date.now();
  let lastProbe = null;
  let lastReadyKey = "";
  let stableReadyProbeCount = 0;
  let attempt = 1;
  while (Date.now() - startedAt < timeoutMs) {
    if (isFillRunCancelled(fillRunId)) {
      return {
        ok: false,
        reason: "user_cancelled",
        lastProbe,
      };
    }
    lastProbe = await inspectApplicationFieldReadiness(tabId);
    const workflowDetection = await detectWorkflowForTab(tabId);
    if (workflowDetection?.isAuthPage) {
      await sendDebugLog("c3_page_walk_wait_after_auth_still_auth", {
        tabId,
        fillRunId,
        pageLabel,
        waitMs: Date.now() - startedAt,
        detection: workflowDetection,
        probe: lastProbe,
      });
      return {
        ok: false,
        reason: "still_on_auth_page",
        waitMs: Date.now() - startedAt,
        detection: workflowDetection,
        lastProbe,
      };
    }
    const currentStepTitle = String(lastProbe?.currentStep?.title || "");
    const currentStepLooksAuth =
      /create account|sign in|log in|login|register|sign up/i.test(
        currentStepTitle,
      );
    const hasApplicationSurface =
      !currentStepLooksAuth &&
      (lastProbe.finalSubmitVisible ||
        lastProbe.applicationFieldCount > 0 ||
        Boolean(lastProbe.currentStep?.title));
    const readyKey = [
      lastProbe.href || "",
      currentStepTitle,
      Number(lastProbe.applicationFieldCount || 0),
      Number(lastProbe.requiredApplicationFieldCount || 0),
      Number(lastProbe.validationErrorCount || 0),
      Boolean(lastProbe.finalSubmitVisible),
    ].join("|");
    if (hasApplicationSurface && !lastProbe.loadingIndicatorVisible) {
      stableReadyProbeCount =
        readyKey && readyKey === lastReadyKey ? stableReadyProbeCount + 1 : 1;
      lastReadyKey = readyKey;
    } else {
      stableReadyProbeCount = 0;
      lastReadyKey = readyKey;
    }
    if (hasApplicationSurface && stableReadyProbeCount >= 2) {
      await sendDebugLog("c3_page_walk_application_fields_ready", {
        tabId,
        fillRunId,
        pageLabel,
        waitMs: Date.now() - startedAt,
        probe: lastProbe,
        stableReadyProbeCount,
      });
      return {
        ok: true,
        reason: "application_fields_ready",
        waitMs: Date.now() - startedAt,
        probe: lastProbe,
        stableReadyProbeCount,
      };
    }
    await showFillProgress(
      tabId,
      `Waiting for ${pageLabel} fields: attempt ${attempt}`,
      fillRunId,
    );
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
  await sendDebugLog("c3_page_walk_application_fields_not_ready", {
    tabId,
    fillRunId,
    pageLabel,
    timeoutMs,
    lastProbe,
  });
  return {
    ok: false,
    reason: "application_fields_not_ready_after_auth",
    waitMs: Date.now() - startedAt,
    lastProbe,
  };
}

function workflowDetectionReadyForDecision(detection = {}) {
  if (!detection || !detection.ok) {
    return false;
  }
  if (detection.isApplyEntryPage) {
    return true;
  }
  if (detection.isJobFillPage) {
    return true;
  }
  if (!detection.isAuthPage) {
    return false;
  }
  const authUiState = String(detection.authUiState || "");
  if (
    authUiState === "landing_choice" ||
    authUiState === "email_link_verification"
  ) {
    return true;
  }
  return Boolean(
    Number(detection.inputCount || 0) > 0 ||
    Number(detection.passwordCount || 0) > 0 ||
    Number(detection.emailCount || 0) > 0,
  );
}

async function waitForWorkflowDecisionReadyAfterApplyEntry(
  tabId,
  { fillRunId = "", timeoutMs = 8000, intervalMs = 150 } = {},
) {
  const startedAt = Date.now();
  let lastDetection = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (isFillRunCancelled(fillRunId)) {
      return {
        ok: false,
        reason: "user_cancelled",
        detection: lastDetection,
      };
    }
    lastDetection = await detectWorkflowForTab(tabId);
    if (workflowDetectionReadyForDecision(lastDetection)) {
      await sendDebugLog("c3_workflow_decision_ready_after_apply_entry", {
        tabId,
        fillRunId,
        waitMs: Date.now() - startedAt,
        detection: lastDetection,
      });
      return {
        ok: true,
        reason: "workflow_decision_ready",
        waitMs: Date.now() - startedAt,
        detection: lastDetection,
      };
    }
    await showFillProgress(
      tabId,
      "Checking the next application page",
      fillRunId,
    );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await sendDebugLog("c3_workflow_decision_not_ready_after_apply_entry", {
    tabId,
    fillRunId,
    timeoutMs,
    detection: lastDetection,
  });
  return {
    ok: false,
    reason: "workflow_decision_not_ready_after_apply_entry",
    waitMs: Date.now() - startedAt,
    detection: lastDetection,
  };
}

function compactStopDetails(details = {}) {
  const validationErrors = Array.isArray(details.visibleValidationErrors)
    ? details.visibleValidationErrors
        .map((error) =>
          String(error || "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const reviewReasons = Array.isArray(details.reviewReasons)
    ? details.reviewReasons
        .map((reason) =>
          String(reason || "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean)
        .slice(0, 3)
    : [];
  return {
    ...details,
    visibleValidationErrors: validationErrors,
    reviewReasons,
  };
}

function describePageWalkStop(reason = "", details = {}) {
  const compact = compactStopDetails(details);
  if (reason === "final_submit_visible") {
    return "Stopped before final submit.";
  }
  if (
    reason === "visible_validation_errors" ||
    reason === "visible_validation_errors_after_next"
  ) {
    return compact.visibleValidationErrors.length
      ? compact.visibleValidationErrors.join(" ")
      : "Workday showed visible validation errors after Next.";
  }
  if (reason === "page_did_not_advance_after_next") {
    return "Clicked Next, but Workday stayed on the same page.";
  }
  if (reason === "auth_action_did_not_advance") {
    return "Clicked the account action, but the account page did not advance.";
  }
  if (reason === "auth_same_page_attempt_limit_reached") {
    return "Account sign-in or signup stayed on the same page after 3 failed attempts.";
  }
  if (reason === "auth_primary_action_not_found") {
    return "No safe account sign-in or create-account button was found.";
  }
  if (reason === "workday_catalog_after_auth") {
    return "Signed in, but Workday returned to Candidate Home or Search for Jobs instead of the application step.";
  }
  if (reason === "fill_failed") {
    return (
      compact.message ||
      compact.reviewReasons.join(", ") ||
      "The page fill did not complete."
    );
  }
  if (reason === "user_cancelled") {
    return "Fill was canceled.";
  }
  if (reason === "max_pages_reached") {
    return "Stopped after reaching the page-walk limit.";
  }
  if (reason === "auth_flow_limit_reached") {
    return "Account sign-in or signup did not reach the application after repeated attempts.";
  }
  return compact.message || reason || "Page walk stopped.";
}

function pageWalkStopIsOk(reason = "") {
  return (
    reason === "final_submit_visible" || reason === "workday_catalog_after_auth"
  );
}

function issueSummaryKey(issue = {}) {
  return [
    issue.kind || "",
    issue.reason || "",
    issue.fieldName || "",
    issue.selectorPath || "",
    issue.questionType || "",
  ]
    .filter(Boolean)
    .join("|")
    .toLowerCase();
}

function uniqueReviewIssues(issues = []) {
  const seen = new Set();
  const unique = [];
  for (const issue of issues) {
    const key = issueSummaryKey(issue) || JSON.stringify(issue || {});
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

function buildFillSummaryPayload(result = {}) {
  const pageWalk = result.pageWalk || {};
  if (!pageWalk.enabled) {
    return null;
  }
  const stoppedReason = pageWalk.stoppedReason || result.reason || "";
  const reachedFinalSubmit = stoppedReason === "final_submit_visible";
  const stoppedDetails = pageWalk.stopDetails || {};
  const failedPageNumber = reachedFinalSubmit
    ? 0
    : Number(
        pageWalk.failedPageNumber ||
          pageWalk.currentPageNumber ||
          pageWalk.lastPageNumber ||
          pageWalk.successfulPageCount ||
          1,
      );
  const successfulPageCount = Number(
    pageWalk.successfulPageCount || pageWalk.pagesFilled || 0,
  );
  const lastPageNumber = Number(
    pageWalk.lastPageNumber || pageWalk.currentPageNumber || 0,
  );
  const completedPageCount = reachedFinalSubmit
    ? Math.max(lastPageNumber, successfulPageCount)
    : successfulPageCount;
  const summaryReviewIssues = uniqueReviewIssues(pageWalk.reviewIssues || []);
  const reviewIssueCount = Number(
    summaryReviewIssues.length || pageWalk.reviewIssueCount || 0,
  );
  const status = reachedFinalSubmit
    ? reviewIssueCount > 0
      ? "review"
      : "success"
    : result.ok
      ? "stopped"
      : "failed";
  const reason = describePageWalkStop(stoppedReason, stoppedDetails);
  return {
    status,
    title: reachedFinalSubmit
      ? "Fill reached review"
      : `Fill stopped on page ${failedPageNumber || "unknown"}`,
    message: reachedFinalSubmit
      ? "Reached the final review page and stopped before Submit."
      : reason,
    failedPageNumber,
    stoppedReason,
    stopReasonLabel: reason,
    successfulPageCount: completedPageCount,
    pagesAdvancedThisRun: successfulPageCount,
    lastPageNumber,
    reviewIssueCount,
    reviewIssueLabels: summaryReviewIssues
      .map((issue) =>
        String(issue.fieldName || issue.reason || issue.kind || "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean)
      .slice(0, 3),
  };
}

async function showLlmPrompt(tabId, payload = {}) {
  const sent = await sendPageUiMessage({
    tabId,
    message: {
      type: "hunt.apply.show_llm_prompt",
      ...payload,
    },
    action: "ui.llm_prompt.requested",
    failedAction: "ui.llm_prompt.request_failed",
    summary: "Requested LLM prompt.",
    failedSummary: "Could not request LLM prompt.",
    skippedAction: "ui.llm_prompt.skipped",
    skippedSummary: "Skipped LLM prompt because no tab was available.",
    details: {
      fieldCount: payload.fieldCount || 0,
      filledFieldCount: payload.filledFieldCount || 0,
    },
  });
  await logActivity(
    sent ? "llm.prompt.show" : "llm.prompt.show_failed",
    sent
      ? "Asked whether to use LLM help for remaining fields."
      : "Could not show in-page LLM prompt; popup confirmation remains available.",
    {
      tabId,
      fieldCount: payload.fieldCount || 0,
      filledFieldCount: payload.filledFieldCount || 0,
    },
    sent ? "ok" : "warn",
  );
}

async function probeSafeNextForTab(tabId) {
  if (!tabId) {
    return {
      ok: false,
      available: false,
      reason: "missing_tab",
      message: "No active tab is available for Next.",
    };
  }
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: createSafeNextFunction(),
        args: [{ click: false }],
      }),
      5000,
      () => null,
    );
    if (!results) {
      return {
        ok: false,
        available: false,
        reason: "safe_next_probe_timeout",
        message: "Safe Next check timed out.",
      };
    }
    return chooseBestSafeNextFrame(results);
  } catch (error) {
    return {
      ok: false,
      available: false,
      reason: "safe_next_probe_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForSafeNextAvailabilityForTab(
  tabId,
  { timeoutMs = 3500, intervalMs = 150 } = {},
) {
  const startedAt = Date.now();
  let lastProbe = null;
  let lastRuntime = { found: false, reason: "not_checked" };
  while (Date.now() - startedAt < timeoutMs) {
    lastRuntime = await detectWorkdayRuntimeErrorForTab(tabId);
    if (lastRuntime.found) {
      return {
        ok: false,
        reason: lastRuntime.reason || "workday_runtime_error",
        waitedMs: Date.now() - startedAt,
        runtime: lastRuntime,
        probe: lastProbe,
      };
    }
    lastProbe = await probeSafeNextForTab(tabId);
    if (
      lastProbe.available ||
      (lastProbe.reason && lastProbe.reason !== "no_safe_next_button")
    ) {
      return {
        ok: Boolean(lastProbe.available),
        reason: lastProbe.available
          ? "safe_next_available_after_wait"
          : lastProbe.reason,
        waitedMs: Date.now() - startedAt,
        runtime: lastRuntime,
        probe: lastProbe,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return {
    ok: false,
    reason: "safe_next_wait_timeout",
    waitedMs: Date.now() - startedAt,
    runtime: lastRuntime,
    probe: lastProbe,
  };
}

async function detectWorkflowForTab(tabId) {
  if (!tabId) {
    return { ok: false, reason: "missing_tab" };
  }
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: createC3WorkflowDetectionFunction(),
      }),
      5000,
      () => null,
    );
    if (!results) {
      return { ok: false, reason: "workflow_detection_timeout" };
    }
    return chooseBestWorkflowDetection(results);
  } catch (error) {
    return {
      ok: false,
      reason: "workflow_detection_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function detectWorkdayCatalogPageForTab(tabId) {
  if (!tabId) {
    return { ok: false, isCatalogPage: false, reason: "missing_tab" };
  }
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const text = String(document.body?.innerText || "")
            .replace(/\s+/g, " ")
            .trim();
          const title = document.title || "";
          const href = location.href;
          const heading =
            Array.from(document.querySelectorAll("h1,h2,[role='heading']"))
              .map((node) =>
                String(node.innerText || node.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim(),
              )
              .find(Boolean) || title;
          const lower = [href, title, heading, text.slice(0, 1000)]
            .join(" ")
            .toLowerCase();
          const isWorkday = /myworkdayjobs\.com/i.test(href);
          const visibleLabels = Array.from(
            document.querySelectorAll("button, a, [role='button']"),
          )
            .filter((el) => {
              if (!el || typeof el.getBoundingClientRect !== "function") {
                return false;
              }
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden"
              );
            })
            .map((el) =>
              [
                el.getAttribute("aria-label"),
                el.getAttribute("title"),
                el.innerText,
                el.textContent,
              ]
                .filter(Boolean)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase(),
            );
          const hasVisibleAuthChoice =
            visibleLabels.some((label) =>
              /\bsign in with email\b|\bsign in using email\b|\bemail sign in\b|sign in with google|sign in with apple|create account|sign up|register/.test(
                label,
              ),
            ) ||
            (/\/login\/?$/i.test(new URL(href).pathname) &&
              lower.includes("sign in"));
          const isCatalogPage =
            isWorkday &&
            !hasVisibleAuthChoice &&
            (href.includes("/userHome") ||
              /\/en-US\/[^/]+\/?$/.test(new URL(href).pathname) ||
              lower.includes("candidate home") ||
              lower.includes("search for jobs")) &&
            !lower.includes("current step") &&
            !lower.includes("save and continue") &&
            !lower.includes("submit");
          return {
            ok: true,
            isCatalogPage,
            href,
            title,
            heading,
            hasVisibleAuthChoice,
          };
        },
      }),
      5000,
      () => null,
    );
    const best = (results || [])
      .map((entry) => entry.result)
      .find((entry) => entry?.isCatalogPage);
    return best || { ok: true, isCatalogPage: false };
  } catch (error) {
    return {
      ok: false,
      isCatalogPage: false,
      reason: "catalog_page_probe_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeAuthPageForTab(tabId) {
  let results;
  try {
    results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: createAuthPageProbeFunction(),
      }),
      5000,
      () => null,
    );
  } catch (error) {
    return {
      ok: false,
      isAuthPage: false,
      reason: "auth_page_probe_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!results) {
    return {
      ok: false,
      isAuthPage: false,
      reason: "auth_page_probe_timeout",
      message: "Auth page probe timed out.",
    };
  }
  const best = chooseBestAuthPageProbe(results);
  if (!best) {
    return {
      ok: true,
      isAuthPage: false,
      reason: "not_auth_page",
    };
  }
  return {
    ...best.result,
    frameId: best.frameId,
    phase: "auth",
  };
}

async function clickAuthPrimaryActionForTab(
  tabId,
  detection = {},
  details = {},
) {
  if (!tabId) {
    return {
      ok: false,
      available: false,
      clicked: false,
      reason: "missing_tab",
      message: "No active tab is available for the account action.",
    };
  }
  const authState = detection.authState || "unknown";
  const authUiState = detection.authUiState || "unknown";
  let probe;
  try {
    const probeResults = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: createClickAuthPrimaryActionFunction(),
        args: [{ authState, authUiState, click: false }],
      }),
      5000,
      () => null,
    );
    if (!probeResults) {
      probe = {
        ok: false,
        found: false,
        clicked: false,
        reason: "auth_primary_action_probe_timeout",
        message: "Account action check timed out.",
      };
    } else {
      const candidates = probeResults
        .map((entry) => ({
          frameId: entry.frameId,
          result: entry.result || {},
        }))
        .filter((entry) => entry.result?.ok && entry.result?.found)
        .sort((a, b) => {
          const aScore = Number(a.result.candidate?.score || 0);
          const bScore = Number(b.result.candidate?.score || 0);
          if (aScore !== bScore) {
            return bScore - aScore;
          }
          return Number(a.frameId || 0) - Number(b.frameId || 0);
        });
      probe =
        candidates.length > 0
          ? { ...candidates[0].result, frameId: candidates[0].frameId }
          : {
              ok: false,
              found: false,
              clicked: false,
              reason: "auth_primary_action_not_found",
              message:
                "No safe account sign-in or create-account button was found.",
              authState,
              authUiState,
            };
    }
  } catch (error) {
    probe = {
      ok: false,
      found: false,
      clicked: false,
      reason: "auth_primary_action_probe_failed",
      message: error instanceof Error ? error.message : String(error),
      authState,
      authUiState,
    };
  }

  if (!probe.ok || !probe.found) {
    await logActivity(
      "auth.primary_action_blocked",
      probe.message || "No account action button was found.",
      {
        tabId,
        authState,
        authUiState,
        triggeredBy: details.triggeredBy || "",
        reason: probe.reason || "",
      },
      "blocked",
    );
    await showPageToast(
      tabId,
      probe.message || "No account action button was found.",
      "warn",
    );
    return {
      ...probe,
      available: false,
      clicked: false,
      auto: Boolean(details.auto),
    };
  }

  let clickResult;
  try {
    const state = await getExtensionState();
    const clickResults = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [probe.frameId] },
        func: createClickAuthPrimaryActionFunction(),
        args: [
          {
            authState,
            authUiState,
            click: true,
            accountEmail:
              state.profile?.accountEmail || state.profile?.email || "",
            accountPassword: state.profile?.accountPassword || "",
          },
        ],
      }),
      5000,
      () => null,
    );
    if (!clickResults) {
      throw new Error("Account action click timed out.");
    }
    clickResult = {
      frameId: probe.frameId,
      ...(clickResults[0]?.result || {}),
    };
  } catch (error) {
    clickResult = {
      ok: false,
      found: true,
      clicked: false,
      frameId: probe.frameId,
      reason: "auth_primary_action_click_failed",
      message: error instanceof Error ? error.message : String(error),
      authState,
      authUiState,
      candidate: probe.candidate,
    };
  }

  await logActivity(
    clickResult.clicked
      ? "auth.primary_action_click"
      : "auth.primary_action_blocked",
    clickResult.message ||
      (clickResult.clicked
        ? "Clicked account action."
        : "Account action was not clicked."),
    {
      tabId,
      frameId: probe.frameId,
      authState,
      authUiState,
      triggeredBy: details.triggeredBy || "",
      candidate: clickResult.candidate || probe.candidate || {},
      reason: clickResult.reason || "",
    },
    clickResult.clicked ? "ok" : "warn",
  );
  if (!clickResult.clicked) {
    await showPageToast(
      tabId,
      clickResult.message || "Account action was not clicked.",
      "warn",
    );
  }
  return {
    ...clickResult,
    authUiState,
    available: Boolean(clickResult.ok && clickResult.found),
    auto: Boolean(details.auto),
  };
}

async function clickSafeNextForTab(tabId, details = {}) {
  const runtimeBeforeProbe = await detectWorkdayRuntimeErrorForTab(tabId);
  if (runtimeBeforeProbe.found) {
    const blocked = {
      ok: false,
      available: false,
      clicked: false,
      auto: Boolean(details.auto),
      reason: "safe_next_workday_runtime_error",
      message:
        "Workday showed its refresh-required error page. C3 stopped before clicking Next.",
      runtimeError: runtimeBeforeProbe,
    };
    await logActivity(
      "next.workday_runtime_blocked",
      blocked.message,
      {
        tabId,
        triggeredBy: details.triggeredBy || "",
        runtimeError: runtimeBeforeProbe,
      },
      "blocked",
    );
    await showPageToast(tabId, blocked.message, "warn");
    return blocked;
  }
  let probe = await probeSafeNextForTab(tabId);
  if (!probe.available) {
    if (
      probe.reason === "no_safe_next_button" ||
      probe.reason === "final_submit_visible"
    ) {
      const workflowDetection = await detectWorkflowForTab(tabId);
      if (workflowDetection?.isAuthPage) {
        return clickAuthPrimaryActionForTab(tabId, workflowDetection, {
          auto: Boolean(details.auto),
          triggeredBy: details.triggeredBy || "",
        });
      }
      const authProbe = await probeAuthPageForTab(tabId);
      if (authProbe?.isAuthPage) {
        await logActivity(
          "next.auth_page_probe_detected",
          probe.reason === "final_submit_visible"
            ? "A submit button was visible on an account page, so C3 routed it as an account action."
            : "No Next button was visible, but an account action page was detected.",
          {
            tabId,
            triggeredBy: details.triggeredBy || "",
            safeNextReason: probe.reason,
            authState: authProbe.authState || "unknown",
            inputCount: authProbe.inputCount || 0,
            passwordCount: authProbe.passwordCount || 0,
          },
          "info",
        );
        return clickAuthPrimaryActionForTab(tabId, authProbe, {
          auto: Boolean(details.auto),
          triggeredBy: details.triggeredBy || "",
        });
      }
    }
    if (probe.reason === "no_safe_next_button") {
      const catalogState = await detectWorkdayCatalogPageForTab(tabId);
      if (catalogState?.isCatalogPage) {
        await logActivity(
          "next.workday_catalog_after_auth",
          "Workday is on Candidate Home or Search for Jobs after account login, so C3 is stopping without marking the auth step as failed.",
          {
            tabId,
            triggeredBy: details.triggeredBy || "",
            href: catalogState.href || "",
            title: catalogState.title || "",
            heading: catalogState.heading || "",
            reason: "workday_catalog_after_auth",
          },
          "warn",
        );
        await showPageToast(
          tabId,
          describePageWalkStop("workday_catalog_after_auth"),
          "warn",
        );
        return {
          ...probe,
          clicked: false,
          auto: Boolean(details.auto),
          reason: "workday_catalog_after_auth",
          message: describePageWalkStop("workday_catalog_after_auth"),
          catalogState,
        };
      }
    }
    if (
      probe.reason === "no_safe_next_button" &&
      !details.workdayRuntimeRecoveryAttempted
    ) {
      const runtimeRecovery = await recoverWorkdayRuntimeErrorForTab(tabId, {
        reason: "safe_next_probe_workday_runtime_error",
        settleMs: 1800,
      });
      if (runtimeRecovery.attempted) {
        const recovered = runtimeRecovery.ok;
        await logActivity(
          recovered
            ? "next.workday_runtime_recovered_before_probe"
            : "next.workday_runtime_unrecovered_before_probe",
          recovered
            ? "Refreshed after Workday showed its refresh-required error page before Next was available."
            : "Workday showed its refresh-required error page before Next was available and did not recover after one refresh.",
          {
            tabId,
            triggeredBy: details.triggeredBy || "",
            reason: runtimeRecovery.reason,
            before: runtimeRecovery.before || {},
            after: runtimeRecovery.after || {},
          },
          recovered ? "ok" : "warn",
        );
        if (recovered) {
          return clickSafeNextForTab(tabId, {
            ...details,
            workdayRuntimeRecoveryAttempted: true,
          });
        }
        return {
          ...probe,
          clicked: false,
          auto: Boolean(details.auto),
          reason: "safe_next_workday_runtime_error_unrecovered",
          message:
            "Workday showed its refresh-required error page and did not recover after one refresh.",
          runtimeRecovery,
        };
      }
    }
    if (probe.reason === "no_safe_next_button") {
      const waitResult = await waitForSafeNextAvailabilityForTab(tabId, {
        timeoutMs: 3500,
        intervalMs: 150,
      });
      if (waitResult.ok && waitResult.probe?.available) {
        await logActivity(
          "next.available_after_wait",
          "A safe Next or Continue button appeared after Workday finished rendering.",
          {
            tabId,
            triggeredBy: details.triggeredBy || "",
            waitedMs: waitResult.waitedMs || 0,
            candidate: waitResult.probe.candidate || {},
            inputCount: waitResult.probe.inputCount || 0,
            candidateCount: waitResult.probe.candidateCount || 0,
          },
          "ok",
        );
        probe = waitResult.probe;
      } else if (
        waitResult.probe &&
        waitResult.probe.reason !== "no_safe_next_button"
      ) {
        probe = waitResult.probe;
      }
    }
    if (probe.available) {
      // Workday mounted the footer after the first probe. Fall through to the
      // normal click path below with the fresh candidate.
    } else {
      await logActivity(
        "next.blocked",
        summarizeSafeNextResult(probe),
        {
          tabId,
          reason: probe.reason,
          triggeredBy: details.triggeredBy || "",
          blockedFinalSubmitLabels: probe.blockedFinalSubmitLabels || [],
          visibleValidationErrors: probe.visibleValidationErrors || [],
          inputCount: probe.inputCount || 0,
          candidateCount: probe.candidateCount || 0,
        },
        probe.reason === "no_safe_next_button" ? "warn" : "blocked",
      );
      await showPageToast(tabId, summarizeSafeNextResult(probe), "warn");
      return {
        ...probe,
        clicked: false,
        auto: Boolean(details.auto),
      };
    }
  }

  const beforeClickSnapshot = await getPageSnapshot(tabId);
  let clickResult;
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [probe.frameId] },
        func: createSafeNextFunction(),
        args: [{ click: true }],
      }),
      5000,
      () => null,
    );
    if (!results) {
      throw new Error("Safe Next click timed out.");
    }
    clickResult = {
      frameId: probe.frameId,
      ...(results[0]?.result || {}),
    };
  } catch (error) {
    clickResult = {
      ok: false,
      clicked: false,
      frameId: probe.frameId,
      reason: "safe_next_click_failed",
      message: error instanceof Error ? error.message : String(error),
      candidate: probe.candidate,
    };
  }

  if (clickResult.clicked) {
    const clickSentAt = new Date().toISOString();
    logActivity(
      "next.click_sent",
      "Sent safe Next click to the page.",
      {
        tabId,
        frameId: probe.frameId,
        sentAt: clickSentAt,
        triggeredBy: details.triggeredBy || "",
        candidate: clickResult.candidate || probe.candidate || {},
        inputCount: clickResult.inputCount || probe.inputCount || 0,
        candidateCount: clickResult.candidateCount || probe.candidateCount || 0,
        auto: Boolean(details.auto),
      },
      "ok",
    ).catch(() => {});
    clickResult.postNextSignal = await waitForPostNextSignalForTab(
      tabId,
      beforeClickSnapshot,
      {
        timeoutMs: 1800,
      },
    );
    const runtimeRecovery = await recoverWorkdayRuntimeErrorForTab(tabId, {
      reason: "safe_next_workday_runtime_error",
      settleMs: 1800,
    });
    if (runtimeRecovery.attempted) {
      clickResult.runtimeRecovery = runtimeRecovery;
      clickResult.reason = runtimeRecovery.ok
        ? "clicked_safe_next_recovered_workday_runtime_error"
        : "clicked_safe_next_workday_runtime_error_unrecovered";
      clickResult.message = runtimeRecovery.ok
        ? "Clicked Next, then refreshed after Workday showed its refresh-required error page."
        : "Clicked Next, but Workday showed its refresh-required error page and did not recover after one refresh.";
      await logActivity(
        runtimeRecovery.ok
          ? "next.workday_runtime_recovered"
          : "next.workday_runtime_unrecovered",
        clickResult.message,
        {
          tabId,
          frameId: probe.frameId,
          triggeredBy: details.triggeredBy || "",
          reason: runtimeRecovery.reason,
          before: runtimeRecovery.before || {},
          after: runtimeRecovery.after || {},
        },
        runtimeRecovery.ok ? "ok" : "warn",
      );
    }
  }

  const summary = summarizeSafeNextResult(clickResult);
  await logActivity(
    clickResult.clicked ? "next.click" : "next.blocked",
    summary,
    {
      tabId,
      frameId: probe.frameId,
      triggeredBy: details.triggeredBy || "",
      candidate: clickResult.candidate || probe.candidate || {},
      reason: clickResult.reason || "",
      visibleValidationErrors: clickResult.visibleValidationErrors || [],
      blockedFinalSubmitLabels: clickResult.blockedFinalSubmitLabels || [],
      inputCount: clickResult.inputCount || probe.inputCount || 0,
      candidateCount: clickResult.candidateCount || probe.candidateCount || 0,
      auto: Boolean(details.auto),
    },
    clickResult.clicked ? "ok" : "warn",
  );
  await showPageToast(tabId, summary, clickResult.clicked ? "info" : "warn");
  return {
    ...clickResult,
    available: Boolean(clickResult.ok && clickResult.found),
    auto: Boolean(details.auto),
  };
}

async function maybeHandleSafeNextAfterFill({
  tabId,
  fillResponse,
  settings,
  triggeredBy,
}) {
  if (!canOfferSafeNextAfterFill(fillResponse)) {
    return {
      ok: false,
      available: false,
      promptAvailable: false,
      clicked: false,
      skipped: true,
      reason: "fill_not_ready_for_next",
      message: "Next skipped because fill still needs review.",
    };
  }

  if (settings.autoClickNextAfterFill) {
    return clickSafeNextForTab(tabId, {
      auto: true,
      triggeredBy: triggeredBy || "auto_after_fill",
    });
  }

  const probe = await probeSafeNextForTab(tabId);
  if (probe.available) {
    await logActivity("next.prompt.available", "Safe Next is available.", {
      tabId,
      triggeredBy: triggeredBy || "",
      candidate: probe.candidate || {},
    });
    return {
      ...probe,
      promptAvailable: true,
      clicked: false,
      auto: false,
    };
  }
  return {
    ...probe,
    promptAvailable: false,
    clicked: false,
    auto: false,
  };
}

function v2PermanentIssues(fillResponse = {}) {
  return (
    fillResponse.result?.v2Audit?.permanentIssues ||
    fillResponse.attempt?.v2Audit?.permanentIssues ||
    []
  );
}

function v2ReviewIssues(fillResponse = {}) {
  return v2PermanentIssues(fillResponse).filter((issue) =>
    ["warn", "blocked", "error"].includes(issue.severity || ""),
  );
}

function summarizeV2Issues(issues = [], limit = 12) {
  return issues.slice(0, limit).map((issue) => ({
    kind: issue.kind || "",
    severity: issue.severity || "",
    failedStep: issue.failedStep || "",
    reason: issue.reason || "",
    descriptor: String(issue.descriptor || "").slice(0, 240),
    questionType: issue.questionType || "",
    uiModel: issue.uiModel || "",
    selectedOption: issue.selectedOption || "",
    fieldName: issue.fieldName || "",
    elementType: issue.elementType || "",
    selectorPath: String(issue.selectorPath || "").slice(0, 320),
    options: Array.isArray(issue.options) ? issue.options.slice(0, 20) : [],
  }));
}

function shouldRunV2PageWalk(settings = {}, fillResponse = {}, payload = {}) {
  return Boolean(
    settings.autoClickNextAfterFill &&
    payload.pageWalk !== false &&
    fillResponse.ok &&
    !fillResponse.cancelled &&
    !fillHasWorkdayRuntimeError(fillResponse),
  );
}

function pageWalkFillSummary(fillResponse = {}) {
  const issues = v2ReviewIssues(fillResponse);
  return {
    ok: Boolean(fillResponse.ok),
    message: fillResponse.message || "",
    filledFieldCount:
      fillResponse.attempt?.filledFieldCount ||
      fillResponse.result?.filledFieldCount ||
      0,
    generatedAnswerCount:
      fillResponse.attempt?.generatedAnswerCount ||
      fillResponse.result?.generatedAnswerCount ||
      0,
    manualReviewRequired: Boolean(
      fillResponse.attempt?.manualReviewRequired ||
      fillResponse.result?.manualReviewRequired,
    ),
    reviewIssueCount: issues.length,
    reviewIssues: summarizeV2Issues(issues, 10),
  };
}

function shouldRepairPageWalkValidation(nextAction = {}, snapshot = {}) {
  const reason = nextAction.reason || "";
  if (
    reason === "visible_validation_errors" ||
    reason === "visible_validation_errors_after_next"
  ) {
    return true;
  }
  if (reason !== "final_submit_visible") {
    return false;
  }
  return Boolean((snapshot.visibleValidationErrors || []).length);
}

async function runV2PageWalkAfterFill({
  tabId,
  state,
  initialResult,
  fillRunId,
  triggeredBy,
  allowLlmAnswers,
}) {
  const steps = [];
  let currentFill = initialResult;
  let stoppedReason = "";
  let stopDetails = {};
  let failedPageNumber = 0;
  let lastNextAction = null;
  let successfulPageCount = 0;
  let currentPageSnapshot = await getPageSnapshot(tabId);
  let lastPageNumber = pageNumberFromSnapshot(
    currentPageSnapshot,
    successfulPageCount || 1,
  );
  let authStepCount = 0;
  const validationRepairKeys = new Set();
  const authSamePageFailureCounts = new Map();

  function authSamePageKey(detection = {}, snapshot = {}) {
    return [
      normalizeComparableUrl(detection.href || snapshot.href || ""),
      detection.authState || "unknown",
      detection.authUiState || "unknown",
      snapshot.currentStep?.title || "",
    ].join("|");
  }

  function noteAuthSamePageFailure(detection = {}, snapshot = {}, reason = "") {
    const key = authSamePageKey(detection, snapshot);
    const count = (authSamePageFailureCounts.get(key) || 0) + 1;
    authSamePageFailureCounts.set(key, count);
    return {
      key,
      count,
      limit: V2_AUTH_SAME_PAGE_MAX_ATTEMPTS,
      reason,
    };
  }

  function samePageAuthLimitReached(failure = {}) {
    return Number(failure.count || 0) >= V2_AUTH_SAME_PAGE_MAX_ATTEMPTS;
  }

  for (let pageIndex = 1; pageIndex <= V2_PAGE_WALK_MAX_PAGES; pageIndex += 1) {
    if (isFillRunCancelled(fillRunId)) {
      stoppedReason = "user_cancelled";
      failedPageNumber = lastPageNumber;
      stopDetails = { message: fillRunCancelReason(fillRunId) };
      break;
    }
    const beforeNextSnapshot = await getPageSnapshot(tabId);
    const beforePageNumber = pageNumberFromSnapshot(
      beforeNextSnapshot,
      lastPageNumber || successfulPageCount || pageIndex,
    );
    currentPageSnapshot = beforeNextSnapshot;
    lastPageNumber = beforePageNumber;
    const runtimeRecovery = await recoverWorkdayRuntimeErrorForTab(tabId, {
      reason: WORKDAY_RUNTIME_ERROR_REASON,
    });
    if (runtimeRecovery.attempted) {
      steps.push({
        step: steps.length + 1,
        kind: "workday_runtime_recovery",
        pageIndex: beforePageNumber,
        attemptIndex: pageIndex,
        ok: Boolean(runtimeRecovery.ok),
        reason: runtimeRecovery.reason || WORKDAY_RUNTIME_ERROR_REASON,
        before: runtimeRecovery.before || {},
        after: runtimeRecovery.after || {},
      });
      if (!runtimeRecovery.ok) {
        stoppedReason = runtimeRecovery.reason || WORKDAY_RUNTIME_ERROR_REASON;
        failedPageNumber = beforePageNumber;
        stopDetails = {
          message:
            runtimeRecovery.after?.message ||
            runtimeRecovery.before?.message ||
            "Workday showed its generic runtime error after loading the application.",
          pageTitle:
            runtimeRecovery.after?.title ||
            runtimeRecovery.before?.title ||
            beforeNextSnapshot.currentStep?.title ||
            "",
          runtimeError: runtimeRecovery,
        };
        break;
      }
      currentPageSnapshot = await getPageSnapshot(tabId);
      lastPageNumber = pageNumberFromSnapshot(
        currentPageSnapshot,
        beforePageNumber,
      );
      continue;
    }
    const beforeVerificationGate = await maybeHandleEmailVerificationGate({
      tabId,
      state,
      fillRunId,
      triggeredBy,
      pageIndex,
    });
    if (beforeVerificationGate.handled) {
      steps.push({
        step: steps.length + 1,
        kind: "email_verification_code_gate",
        pageIndex: beforePageNumber,
        attemptIndex: pageIndex,
        ok: Boolean(beforeVerificationGate.result?.ok),
        method: beforeVerificationGate.result?.method || "",
        reason: beforeVerificationGate.result?.reason || "",
        detection: beforeVerificationGate.detection || {},
      });
      if (!beforeVerificationGate.result?.ok) {
        stoppedReason =
          beforeVerificationGate.result?.reason || "email_verification_failed";
        failedPageNumber = beforePageNumber;
        stopDetails = {
          message:
            beforeVerificationGate.result?.message ||
            "Email verification could not be completed automatically.",
          pageTitle: beforeNextSnapshot.currentStep?.title || "",
        };
        break;
      }
      currentPageSnapshot = await getPageSnapshot(tabId);
      lastPageNumber = pageNumberFromSnapshot(
        currentPageSnapshot,
        beforePageNumber,
      );
      continue;
    }
    const workflowDetection = await detectWorkflowForTab(tabId);
    if (workflowDetection?.isAuthPage) {
      authStepCount += 1;
      if (authStepCount > V2_AUTH_FLOW_MAX_STEPS) {
        stoppedReason = "auth_flow_limit_reached";
        failedPageNumber = lastPageNumber;
        stopDetails = {
          message:
            "Account sign-in or signup did not reach the application after repeated attempts.",
          pageTitle: currentPageSnapshot.currentStep?.title || "",
          authState: workflowDetection.authState || "unknown",
          authUiState: workflowDetection.authUiState || "unknown",
        };
        break;
      }
      if (workflowDetection.authState === "verify_email") {
        await showFillProgress(
          tabId,
          `Checking email verification for ${describePageWalkPage(beforeNextSnapshot, beforePageNumber)}`,
          fillRunId,
        );
        const verificationGate = await maybeHandleEmailVerificationGate({
          tabId,
          state,
          fillRunId,
          triggeredBy,
          pageIndex,
        });
        steps.push({
          step: steps.length + 1,
          kind: "email_verification_link_gate",
          pageIndex: beforePageNumber,
          attemptIndex: pageIndex,
          ok: Boolean(verificationGate.result?.ok),
          method: verificationGate.result?.method || "",
          reason:
            verificationGate.result?.reason ||
            verificationGate.detection?.reason ||
            "",
          detection: verificationGate.detection || {},
        });
        if (!verificationGate.handled || !verificationGate.result?.ok) {
          stoppedReason =
            verificationGate.result?.reason || "email_verification_failed";
          failedPageNumber = beforePageNumber;
          stopDetails = {
            message:
              verificationGate.result?.message ||
              "Email verification could not be completed automatically.",
            pageTitle: currentPageSnapshot.currentStep?.title || "",
          };
          break;
        }
        const verificationTransition = await waitForAuthActionTransitionForTab(
          tabId,
          {
            beforeDetection: workflowDetection,
            beforeSnapshot: beforeNextSnapshot,
            timeoutMs: 2500,
          },
        );
        currentPageSnapshot =
          verificationTransition.snapshot || (await getPageSnapshot(tabId));
        lastPageNumber = pageNumberFromSnapshot(
          currentPageSnapshot,
          beforePageNumber,
        );
        pageIndex -= 1;
        continue;
      }
      await showFillProgress(
        tabId,
        workflowDetection.authState === "signup"
          ? `Creating account for ${describePageWalkPage(beforeNextSnapshot, beforePageNumber)}: auth attempt ${authStepCount}`
          : `Logging in for ${describePageWalkPage(beforeNextSnapshot, beforePageNumber)}: auth attempt ${authStepCount}`,
        fillRunId,
      );
      markFillRunExpectedReload(fillRunId);
      const authAction = await clickAuthPrimaryActionForTab(
        tabId,
        workflowDetection,
        {
          auto: true,
          triggeredBy: `${triggeredBy || "fill_current_page"}:v2_page_walk:${pageIndex}`,
        },
      );
      steps.push({
        step: steps.length + 1,
        kind: "auth_primary_action",
        pageIndex: beforePageNumber,
        attemptIndex: pageIndex,
        pageTitle: beforeNextSnapshot.currentStep?.title || "",
        clicked: Boolean(authAction.clicked),
        reason: authAction.reason || "",
        message: authAction.message || "",
        authState: workflowDetection.authState || "unknown",
        authUiState: workflowDetection.authUiState || "unknown",
        candidate: authAction.candidate || {},
        filledAuthFields: authAction.filledAuthFields || [],
        inputCount: workflowDetection.inputCount || 0,
        fillBeforeClick: pageWalkFillSummary(currentFill),
      });
      if (!authAction.clicked) {
        stoppedReason = authAction.reason || "auth_primary_action_not_found";
        failedPageNumber = beforePageNumber;
        stopDetails = {
          message: authAction.message || "Account action was not clicked.",
          pageTitle: beforeNextSnapshot.currentStep?.title || "",
        };
        break;
      }

      await dismissPageTransientUi(tabId, { preserveFillProgress: true });
      const authTransition = await waitForAuthActionTransitionForTab(tabId, {
        beforeDetection: workflowDetection,
        beforeSnapshot: beforeNextSnapshot,
        timeoutMs: 2500,
      });
      currentPageSnapshot =
        authTransition.snapshot || (await getPageSnapshot(tabId));
      lastPageNumber = pageNumberFromSnapshot(
        currentPageSnapshot,
        beforePageNumber,
      );
      const afterAuthVerificationGate = await maybeHandleEmailVerificationGate({
        tabId,
        state,
        fillRunId,
        triggeredBy,
        pageIndex,
      });
      if (afterAuthVerificationGate.handled) {
        steps.push({
          step: steps.length + 1,
          kind: "email_verification_code_gate",
          pageIndex: lastPageNumber,
          attemptIndex: pageIndex,
          ok: Boolean(afterAuthVerificationGate.result?.ok),
          method: afterAuthVerificationGate.result?.method || "",
          reason: afterAuthVerificationGate.result?.reason || "",
          detection: afterAuthVerificationGate.detection || {},
        });
        if (!afterAuthVerificationGate.result?.ok) {
          stoppedReason =
            afterAuthVerificationGate.result?.reason ||
            "email_verification_failed";
          failedPageNumber = lastPageNumber;
          stopDetails = {
            message:
              afterAuthVerificationGate.result?.message ||
              "Email verification could not be completed automatically.",
            pageTitle: currentPageSnapshot.currentStep?.title || "",
          };
          break;
        }
        currentPageSnapshot = await getPageSnapshot(tabId);
        lastPageNumber = pageNumberFromSnapshot(
          currentPageSnapshot,
          lastPageNumber,
        );
        pageIndex -= 1;
        continue;
      }

      const afterAuthDetection = await detectWorkflowForTab(tabId);
      if (afterAuthDetection?.isAuthPage) {
        const sameAuthPage =
          afterAuthDetection.authState === workflowDetection.authState &&
          afterAuthDetection.authUiState === workflowDetection.authUiState &&
          afterAuthDetection.href === workflowDetection.href;
        if (!sameAuthPage) {
          steps.push({
            step: steps.length + 1,
            kind: "auth_chain_continue",
            pageIndex: lastPageNumber,
            attemptIndex: pageIndex,
            fromAuthState: workflowDetection.authState || "unknown",
            fromAuthUiState: workflowDetection.authUiState || "unknown",
            toAuthState: afterAuthDetection.authState || "unknown",
            toAuthUiState: afterAuthDetection.authUiState || "unknown",
            href: afterAuthDetection.href || "",
          });
          currentPageSnapshot = await getPageSnapshot(tabId);
          lastPageNumber = pageNumberFromSnapshot(
            currentPageSnapshot,
            lastPageNumber,
          );
          pageIndex -= 1;
          continue;
        }
      }

      const afterAuthPageLabel = describePageWalkPage(
        currentPageSnapshot,
        lastPageNumber,
      );
      const readiness = await waitForApplicationFieldsReadyAfterAuth(tabId, {
        fillRunId,
        pageLabel: afterAuthPageLabel,
      });
      steps.push({
        step: steps.length + 1,
        kind: "wait_after_auth_fields",
        pageIndex: lastPageNumber,
        attemptIndex: pageIndex,
        ok: Boolean(readiness.ok),
        reason: readiness.reason || "",
        waitMs: readiness.waitMs || 0,
        probe: readiness.probe || readiness.lastProbe || {},
      });
      currentPageSnapshot = await getPageSnapshot(tabId);
      lastPageNumber = pageNumberFromSnapshot(
        currentPageSnapshot,
        lastPageNumber,
      );
      if (!readiness.ok) {
        if (readiness.reason === "still_on_auth_page") {
          if (!(currentPageSnapshot.visibleValidationErrors || []).length) {
            const samePageFailure = noteAuthSamePageFailure(
              readiness.detection || workflowDetection,
              currentPageSnapshot,
              readiness.reason,
            );
            if (samePageAuthLimitReached(samePageFailure)) {
              stoppedReason = "auth_same_page_attempt_limit_reached";
              failedPageNumber = lastPageNumber;
              stopDetails = {
                message:
                  "Account sign-in or signup stayed on the same page after 3 failed attempts.",
                pageTitle: currentPageSnapshot.currentStep?.title || "",
                authState:
                  readiness.detection?.authState ||
                  workflowDetection.authState ||
                  "unknown",
                authUiState:
                  readiness.detection?.authUiState ||
                  workflowDetection.authUiState ||
                  "unknown",
                samePageAttempts: samePageFailure.count,
                maxSamePageAttempts: samePageFailure.limit,
                lastReason: samePageFailure.reason,
              };
              break;
            }
            steps.push({
              step: steps.length + 1,
              kind: "auth_chain_continue",
              pageIndex: lastPageNumber,
              attemptIndex: pageIndex,
              fromAuthState: workflowDetection.authState || "unknown",
              fromAuthUiState: workflowDetection.authUiState || "unknown",
              toAuthState: readiness.detection?.authState || "unknown",
              toAuthUiState: readiness.detection?.authUiState || "unknown",
              href: readiness.detection?.href || currentPageSnapshot.href || "",
              reason: readiness.reason,
            });
            currentPageSnapshot = await getPageSnapshot(tabId);
            lastPageNumber = pageNumberFromSnapshot(
              currentPageSnapshot,
              lastPageNumber,
            );
            pageIndex -= 1;
            continue;
          }
        } else {
          stoppedReason =
            readiness.reason || "application_fields_not_ready_after_auth";
          failedPageNumber = lastPageNumber;
          stopDetails = {
            message:
              "Signed in, but Workday did not expose fillable application fields before the timeout.",
            pageTitle: currentPageSnapshot.currentStep?.title || "",
            readiness: readiness.lastProbe || {},
          };
          break;
        }
      }

      if (
        afterAuthDetection?.isAuthPage &&
        afterAuthDetection.authState === workflowDetection.authState &&
        afterAuthDetection.href === workflowDetection.href
      ) {
        const samePageFailure = noteAuthSamePageFailure(
          afterAuthDetection,
          currentPageSnapshot,
          "auth_action_did_not_advance",
        );
        if (samePageAuthLimitReached(samePageFailure)) {
          stoppedReason = "auth_same_page_attempt_limit_reached";
          failedPageNumber = beforePageNumber;
          stopDetails = {
            message:
              "Account sign-in or signup stayed on the same page after 3 failed attempts.",
            pageTitle: currentPageSnapshot.currentStep?.title || "",
            authState: afterAuthDetection.authState || "unknown",
            authUiState: afterAuthDetection.authUiState || "unknown",
            visibleValidationErrors:
              currentPageSnapshot.visibleValidationErrors || [],
            samePageAttempts: samePageFailure.count,
            maxSamePageAttempts: samePageFailure.limit,
            lastReason: samePageFailure.reason,
          };
          break;
        }
        const repairKey = `${beforePageNumber}:${beforeNextSnapshot.href || ""}:auth_after_action`;
        if (
          shouldRepairPageWalkValidation(
            {
              reason: "visible_validation_errors_after_next",
              visibleValidationErrors:
                currentPageSnapshot.visibleValidationErrors || [],
            },
            currentPageSnapshot,
          ) &&
          !validationRepairKeys.has(repairKey)
        ) {
          validationRepairKeys.add(repairKey);
          await showFillProgress(
            tabId,
            describePageWalkAttempt(
              "Repairing account validation on",
              currentPageSnapshot,
              beforePageNumber,
              2,
            ),
            fillRunId,
          );
          const repairState = await getExtensionState();
          const repairFill = await runFillWithOneRefreshRetry(
            tabId,
            repairState,
            `${triggeredBy || "fill_current_page"}:v2_page_walk_auth_validation_repair`,
            fillRunId,
            {
              allowLlmAnswers,
              repairVisibleValidationErrors:
                currentPageSnapshot.visibleValidationErrors || [],
            },
          );
          currentFill = repairFill;
          steps.push({
            step: steps.length + 1,
            kind: "auth_validation_repair",
            pageIndex: beforePageNumber,
            attemptIndex: pageIndex,
            pageTitle: currentPageSnapshot.currentStep?.title || "",
            stoppedReason: "auth_action_did_not_advance",
            ...pageWalkFillSummary(repairFill),
          });
          if (
            repairFill?.ok &&
            !repairFill.cancelled &&
            pageWalkFillSummary(repairFill).filledFieldCount > 0
          ) {
            pageIndex -= 1;
            continue;
          }
        }
        stoppedReason = "auth_action_did_not_advance";
        failedPageNumber = beforePageNumber;
        stopDetails = {
          message:
            "Clicked the account action, but the account page did not advance.",
          visibleValidationErrors:
            currentPageSnapshot.visibleValidationErrors || [],
          pageTitle: currentPageSnapshot.currentStep?.title || "",
        };
        break;
      }

      await showFillProgress(
        tabId,
        describePageWalkAttempt(
          "Filling after account action on",
          currentPageSnapshot,
          lastPageNumber,
          1,
        ),
        fillRunId,
      );
      const pageState = await getExtensionState();
      currentFill = await runFillWithOneRefreshRetry(
        tabId,
        pageState,
        `${triggeredBy || "fill_current_page"}:v2_page_walk_auth_followup`,
        fillRunId,
        { allowLlmAnswers },
      );
      await notePageFillCompleted(tabId, {
        triggeredBy: `${triggeredBy || "fill_current_page"}:v2_page_walk_auth_followup`,
        ok: Boolean(currentFill?.ok),
        filledFieldCount: Number(currentFill?.attempt?.filledFieldCount || 0),
      });
      steps.push({
        step: steps.length + 1,
        kind: "fill_after_auth_action",
        pageIndex: lastPageNumber,
        attemptIndex: pageIndex,
        pageTitle: currentPageSnapshot.currentStep?.title || "",
        ...pageWalkFillSummary(currentFill),
      });
      if (!currentFill.ok || currentFill.cancelled) {
        stoppedReason = currentFill.cancelled
          ? "user_cancelled"
          : "fill_failed";
        failedPageNumber = lastPageNumber;
        stopDetails = {
          message: currentFill.message || "",
          reviewReasons:
            currentFill.attempt?.manualReviewReasons ||
            currentFill.result?.manualReviewReasons ||
            [],
          pageTitle: currentPageSnapshot.currentStep?.title || "",
        };
        break;
      }
      pageIndex -= 1;
      continue;
    }
    await showFillProgress(
      tabId,
      `Trying to continue from ${describePageWalkPage(beforeNextSnapshot, beforePageNumber)}`,
      fillRunId,
    );
    markFillRunExpectedReload(fillRunId);
    const nextAction = await clickSafeNextForTab(tabId, {
      auto: true,
      triggeredBy: `${triggeredBy || "fill_current_page"}:v2_page_walk:${pageIndex}`,
    });
    lastNextAction = nextAction;
    steps.push({
      step: steps.length + 1,
      kind: "safe_next",
      pageIndex: beforePageNumber,
      attemptIndex: pageIndex,
      pageTitle: beforeNextSnapshot.currentStep?.title || "",
      clicked: Boolean(nextAction.clicked),
      reason: nextAction.reason || "",
      message: nextAction.message || summarizeSafeNextResult(nextAction),
      candidate: nextAction.candidate || {},
      visibleValidationErrors: nextAction.visibleValidationErrors || [],
      blockedFinalSubmitLabels: nextAction.blockedFinalSubmitLabels || [],
      inputCount: nextAction.inputCount || 0,
      candidateCount: nextAction.candidateCount || 0,
      fillBeforeClick: pageWalkFillSummary(currentFill),
    });
    if (!nextAction.clicked) {
      const repairKey = `${beforePageNumber}:${beforeNextSnapshot.href || ""}`;
      if (
        shouldRepairPageWalkValidation(nextAction, beforeNextSnapshot) &&
        !validationRepairKeys.has(repairKey)
      ) {
        validationRepairKeys.add(repairKey);
        await showFillProgress(
          tabId,
          describePageWalkAttempt(
            "Repairing validation on",
            beforeNextSnapshot,
            beforePageNumber,
            2,
          ),
          fillRunId,
        );
        const repairState = await getExtensionState();
        const repairFill = await runFillWithOneRefreshRetry(
          tabId,
          repairState,
          `${triggeredBy || "fill_current_page"}:v2_page_walk_validation_repair`,
          fillRunId,
          {
            allowLlmAnswers,
            repairVisibleValidationErrors:
              nextAction.visibleValidationErrors || [],
          },
        );
        currentFill = repairFill;
        steps.push({
          step: steps.length + 1,
          kind: "fill_validation_repair",
          pageIndex: beforePageNumber,
          attemptIndex: pageIndex,
          pageTitle: beforeNextSnapshot.currentStep?.title || "",
          stoppedReason: nextAction.reason || "",
          ...pageWalkFillSummary(repairFill),
        });
        if (
          repairFill?.ok &&
          !repairFill.cancelled &&
          pageWalkFillSummary(repairFill).filledFieldCount > 0
        ) {
          continue;
        }
      }
      stoppedReason = nextAction.reason || "safe_next_stopped";
      if (stoppedReason === "final_submit_visible" && currentFill?.ok) {
        successfulPageCount += 1;
      }
      failedPageNumber =
        stoppedReason === "final_submit_visible" ? 0 : beforePageNumber;
      stopDetails = {
        message: nextAction.message || summarizeSafeNextResult(nextAction),
        visibleValidationErrors: nextAction.visibleValidationErrors || [],
        blockedFinalSubmitLabels: nextAction.blockedFinalSubmitLabels || [],
        pageTitle: beforeNextSnapshot.currentStep?.title || "",
      };
      break;
    }
    if (
      nextAction.reason ===
      "clicked_safe_next_workday_runtime_error_unrecovered"
    ) {
      stoppedReason = nextAction.reason;
      failedPageNumber = beforePageNumber;
      stopDetails = {
        message: nextAction.message || summarizeSafeNextResult(nextAction),
        pageTitle: beforeNextSnapshot.currentStep?.title || "",
      };
      break;
    }

    if (isFillRunCancelled(fillRunId)) {
      stoppedReason = "user_cancelled";
      failedPageNumber = beforePageNumber;
      stopDetails = { message: fillRunCancelReason(fillRunId) };
      break;
    }
    await dismissPageTransientUi(tabId, { preserveFillProgress: true });
    let postNextSignal = nextAction.postNextSignal || null;
    let reusedPostNextSignal = false;
    if (
      nextAction.runtimeRecovery?.attempted ||
      !postNextSignalHasPageChange(postNextSignal, beforeNextSnapshot)
    ) {
      postNextSignal = await waitForPostNextSignalForTab(
        tabId,
        beforeNextSnapshot,
        { timeoutMs: 1550 },
      );
    } else {
      reusedPostNextSignal = true;
    }
    let afterNextSnapshot =
      postNextSignal.snapshot || (await getPageSnapshot(tabId));
    const beforeStepNumber = Number(
      beforeNextSnapshot.currentStep?.current || 0,
    );
    let afterStepNumber = Number(afterNextSnapshot.currentStep?.current || 0);
    const afterNextErrors = afterNextSnapshot.visibleValidationErrors || [];
    if (
      beforeStepNumber &&
      afterStepNumber &&
      afterStepNumber <= beforeStepNumber
    ) {
      const afterSameStepWorkflow = await detectWorkflowForTab(tabId);
      const beforeAuthUiState =
        nextAction.authUiState || nextAction.authState || "";
      const afterAuthUiState =
        afterSameStepWorkflow?.authUiState ||
        afterSameStepWorkflow?.authState ||
        "";
      if (
        afterSameStepWorkflow?.isAuthPage &&
        nextAction.reason === "clicked_auth_primary_action" &&
        afterAuthUiState &&
        afterAuthUiState !== beforeAuthUiState
      ) {
        steps.push({
          step: steps.length + 1,
          kind: "auth_same_step_transition",
          pageIndex: beforePageNumber,
          attemptIndex: pageIndex,
          ok: true,
          beforeAuthUiState,
          afterAuthUiState,
          beforeStep: beforeNextSnapshot.currentStep || null,
          afterStep: afterNextSnapshot.currentStep || null,
        });
        currentPageSnapshot = afterNextSnapshot;
        lastPageNumber = pageNumberFromSnapshot(
          currentPageSnapshot,
          beforePageNumber,
        );
        continue;
      }
      stoppedReason = afterNextErrors.length
        ? "visible_validation_errors_after_next"
        : "page_did_not_advance_after_next";
      failedPageNumber = beforePageNumber;
      stopDetails = {
        message: describePageWalkStop(stoppedReason, {
          visibleValidationErrors: afterNextErrors,
        }),
        visibleValidationErrors: afterNextErrors,
        pageTitle: beforeNextSnapshot.currentStep?.title || "",
      };
      steps.push({
        step: steps.length + 1,
        kind: "page_advance_check",
        pageIndex: beforePageNumber,
        attemptIndex: pageIndex,
        ok: false,
        stoppedReason,
        visibleValidationErrors: afterNextErrors,
        beforeStep: beforeNextSnapshot.currentStep || null,
        afterStep: afterNextSnapshot.currentStep || null,
      });
      const repairKey = `${beforePageNumber}:${beforeNextSnapshot.href || ""}:after_next`;
      if (
        stoppedReason === "visible_validation_errors_after_next" &&
        shouldRepairPageWalkValidation(
          { reason: stoppedReason, visibleValidationErrors: afterNextErrors },
          afterNextSnapshot,
        ) &&
        !validationRepairKeys.has(repairKey)
      ) {
        validationRepairKeys.add(repairKey);
        await showFillProgress(
          tabId,
          describePageWalkAttempt(
            "Repairing validation on",
            afterNextSnapshot,
            beforePageNumber,
            2,
          ),
          fillRunId,
        );
        const repairState = await getExtensionState();
        const repairFill = await runFillWithOneRefreshRetry(
          tabId,
          repairState,
          `${triggeredBy || "fill_current_page"}:v2_page_walk_after_next_validation_repair`,
          fillRunId,
          {
            allowLlmAnswers,
            repairVisibleValidationErrors: afterNextErrors,
          },
        );
        currentFill = repairFill;
        steps.push({
          step: steps.length + 1,
          kind: "after_next_validation_repair",
          pageIndex: beforePageNumber,
          attemptIndex: pageIndex,
          pageTitle: afterNextSnapshot.currentStep?.title || "",
          stoppedReason,
          ...pageWalkFillSummary(repairFill),
        });
        if (
          repairFill?.ok &&
          !repairFill.cancelled &&
          pageWalkFillSummary(repairFill).filledFieldCount > 0
        ) {
          currentPageSnapshot = await getPageSnapshot(tabId);
          lastPageNumber = pageNumberFromSnapshot(
            currentPageSnapshot,
            beforePageNumber,
          );
          continue;
        }
      }
      break;
    }
    const nextPageNumber = pageNumberFromSnapshot(
      afterNextSnapshot,
      beforePageNumber + 1,
    );
    successfulPageCount += 1;
    lastPageNumber = nextPageNumber;
    currentPageSnapshot = afterNextSnapshot;
    await logActivity(
      "page_walk.advance_observed",
      "Observed Workday advance to the next page.",
      {
        tabId,
        fillRunId,
        beforePageNumber,
        nextPageNumber,
        postNextSignalReason: postNextSignal.reason || "",
        postNextSignalWaitedMs: postNextSignal.waitedMs || 0,
        reusedPostNextSignal,
        beforeStep: beforeNextSnapshot.currentStep || null,
        afterStep: afterNextSnapshot.currentStep || null,
      },
    );
    const afterVerificationGate = await maybeHandleEmailVerificationGate({
      tabId,
      state,
      fillRunId,
      triggeredBy,
      pageIndex,
    });
    if (afterVerificationGate.handled) {
      steps.push({
        step: steps.length + 1,
        kind: "email_verification_code_gate",
        pageIndex: nextPageNumber,
        attemptIndex: pageIndex,
        ok: Boolean(afterVerificationGate.result?.ok),
        method: afterVerificationGate.result?.method || "",
        reason: afterVerificationGate.result?.reason || "",
        detection: afterVerificationGate.detection || {},
      });
      if (!afterVerificationGate.result?.ok) {
        stoppedReason =
          afterVerificationGate.result?.reason || "email_verification_failed";
        failedPageNumber = nextPageNumber;
        stopDetails = {
          message:
            afterVerificationGate.result?.message ||
            "Email verification could not be completed automatically.",
          pageTitle: afterNextSnapshot.currentStep?.title || "",
        };
        break;
      }
      currentPageSnapshot = await getPageSnapshot(tabId);
      lastPageNumber = pageNumberFromSnapshot(
        currentPageSnapshot,
        nextPageNumber,
      );
      continue;
    }
    await showFillProgress(
      tabId,
      describePageWalkAttempt("Filling", afterNextSnapshot, nextPageNumber, 1),
      fillRunId,
    );
    const pageState = await getExtensionState();
    currentFill = await runFillWithOneRefreshRetry(
      tabId,
      pageState,
      `${triggeredBy || "fill_current_page"}:v2_page_walk`,
      fillRunId,
      { allowLlmAnswers },
    );
    await notePageFillCompleted(tabId, {
      triggeredBy: `${triggeredBy || "fill_current_page"}:v2_page_walk`,
      ok: Boolean(currentFill?.ok),
      filledFieldCount: Number(currentFill?.attempt?.filledFieldCount || 0),
    });
    steps.push({
      step: steps.length + 1,
      kind: "fill",
      pageIndex: nextPageNumber,
      attemptIndex: pageIndex,
      pageTitle: afterNextSnapshot.currentStep?.title || "",
      ...pageWalkFillSummary(currentFill),
    });
    if (!currentFill.ok || currentFill.cancelled) {
      stoppedReason = currentFill.cancelled ? "user_cancelled" : "fill_failed";
      failedPageNumber = nextPageNumber;
      stopDetails = {
        message: currentFill.message || "",
        reviewReasons:
          currentFill.attempt?.manualReviewReasons ||
          currentFill.result?.manualReviewReasons ||
          [],
        pageTitle: afterNextSnapshot.currentStep?.title || "",
      };
      break;
    }
  }

  if (!stoppedReason) {
    stoppedReason = "max_pages_reached";
    failedPageNumber = lastPageNumber;
    stopDetails = { message: describePageWalkStop(stoppedReason) };
  }
  const reviewIssues = uniqueReviewIssues(
    steps.flatMap((step) =>
      (step.reviewIssues || []).concat(
        step.fillBeforeClick?.reviewIssues || [],
      ),
    ),
  );
  const pageWalk = {
    ok: pageWalkStopIsOk(stoppedReason),
    enabled: true,
    maxPages: V2_PAGE_WALK_MAX_PAGES,
    maxAuthSteps: V2_AUTH_FLOW_MAX_STEPS,
    maxSamePageAuthAttempts: V2_AUTH_SAME_PAGE_MAX_ATTEMPTS,
    authStepCount,
    pagesFilled: successfulPageCount,
    successfulPageCount,
    currentPageNumber: lastPageNumber,
    lastPageNumber,
    failedPageNumber,
    stopDetails: compactStopDetails(stopDetails),
    stoppedReason,
    manualReviewRequired: reviewIssues.length > 0,
    reviewIssueCount: reviewIssues.length,
    reviewIssues,
    steps,
    lastNextAction,
  };
  await sendDebugLog("c3_v2_page_walk", {
    tabId,
    fillRunId,
    stoppedReason,
    pagesFilled: successfulPageCount,
    successfulPageCount,
    lastPageNumber,
    failedPageNumber,
    stopDetails: compactStopDetails(stopDetails),
    reviewIssueCount: reviewIssues.length,
    steps,
  });
  await logActivity(
    "next.v2_page_walk",
    stoppedReason === "final_submit_visible"
      ? "V2 filled pages and stopped before final submit."
      : `V2 page walk stopped: ${stoppedReason || "unknown"}.`,
    {
      tabId,
      fillRunId,
      pagesFilled: successfulPageCount,
      successfulPageCount,
      lastPageNumber,
      failedPageNumber,
      stopDetails: compactStopDetails(stopDetails),
      stoppedReason,
      reviewIssueCount: reviewIssues.length,
      reviewIssues,
      steps,
    },
    stoppedReason === "final_submit_visible" || pageWalk.ok ? "ok" : "warn",
  );
  return pageWalk;
}

function chooseBestV2ClearFrame(results = []) {
  const candidates = results
    .map((entry) => ({
      frameId: entry.frameId,
      result: entry.result || {},
    }))
    .filter((entry) => entry.result && entry.result.ok !== false);
  if (!candidates.length) {
    return (
      results[0]?.result || {
        ok: false,
        reason: "missing_clear_result",
        message: "No V2 clear result was returned.",
      }
    );
  }
  candidates.sort((a, b) => {
    const aCleared = Number(a.result.clearedFieldCount || 0);
    const bCleared = Number(b.result.clearedFieldCount || 0);
    if (aCleared !== bCleared) {
      return bCleared - aCleared;
    }
    const aFields = Number(a.result.v2Audit?.summary?.fieldCount || 0);
    const bFields = Number(b.result.v2Audit?.summary?.fieldCount || 0);
    if (aFields !== bFields) {
      return bFields - aFields;
    }
    return Number(a.frameId || 0) - Number(b.frameId || 0);
  });
  return {
    ...candidates[0].result,
    frameId: candidates[0].frameId,
    frameResults: candidates.map((entry) => ({
      frameId: entry.frameId,
      clearedFieldCount: entry.result.clearedFieldCount || 0,
      issueCount: entry.result.v2Audit?.permanentIssues?.length || 0,
      fieldCount: entry.result.v2Audit?.summary?.fieldCount || 0,
    })),
  };
}

async function clearCurrentPageV2(tabId, state) {
  const atsType = state.activeApplyContext.atsType || "generic";
  const clearRunId = `clear_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  await injectV2ScriptsForTab(tabId, atsType);
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [
      {
        fillRunId: clearRunId,
        atsType,
      },
    ],
    func: async (context) => {
      if (!window.__huntV2?.clearPipeline) {
        return {
          ok: false,
          reason: "missing_v2_clear_pipeline",
          message: "C3 V2 clear pipeline scripts were not injected.",
        };
      }
      return window.__huntV2.clearPipeline.runHuntV2Clear(context);
    },
  });
  const result = chooseBestV2ClearFrame(results);
  const issues = result.v2Audit?.permanentIssues || [];
  await sendDebugLog("c3_v2_clear_audit", {
    tabId,
    clearRunId,
    atsType,
    result,
    audit: result.v2Audit || {},
  });
  await logActivity(
    "page.clear.v2",
    issues.length
      ? "V2 clear completed with review items."
      : "V2 clear completed.",
    {
      tabId,
      clearRunId,
      atsType,
      clearedFieldCount: result.clearedFieldCount || 0,
      issueCount: issues.length,
      reviewIssues: summarizeV2Issues(issues, 20),
      frameResults: result.frameResults || [],
      v2Audit: result.v2Audit || {},
    },
    issues.length ? "warn" : result.ok ? "ok" : "failed",
  );
  await showPageToast(
    tabId,
    issues.length
      ? `V2 cleared ${result.clearedFieldCount || 0} field${result.clearedFieldCount === 1 ? "" : "s"} with ${issues.length} review item${issues.length === 1 ? "" : "s"}.`
      : `V2 cleared ${result.clearedFieldCount || 0} field${result.clearedFieldCount === 1 ? "" : "s"}.`,
    issues.length ? "warn" : "info",
  );
  return {
    ok: Boolean(result.ok && issues.length === 0),
    reason: issues.length ? "v2_clear_needs_review" : result.reason || "",
    message: issues.length
      ? "V2 clear completed with review items."
      : result.message ||
        `V2 cleared ${result.clearedFieldCount || 0} fields on the current page.`,
    cleared: result.clearedFieldCount || 0,
    clearedFields: result.clearedFields || [],
    reviewIssueCount: issues.length,
    reviewIssues: summarizeV2Issues(issues, 30),
    v2Audit: result.v2Audit || {},
    frameResults: result.frameResults || [],
  };
}

async function clearCurrentPage(tabId) {
  if (!tabId) {
    return {
      ok: false,
      reason: "missing_tab",
      message: "No active tab is available to clear.",
    };
  }

  const state = await getExtensionState();
  return clearCurrentPageV2(tabId, state);
}
function alarmPeriodMinutes(seconds) {
  return Math.max(0.5, Number(seconds || 60) / 60);
}

async function refreshPollingAlarms(settings) {
  await chrome.alarms.clear(C4_POLL_ALARM);
  await chrome.alarms.clear(C4_HEARTBEAT_ALARM);
  if (!settings.c4PollingEnabled) {
    return;
  }
  await chrome.alarms.create(C4_POLL_ALARM, {
    periodInMinutes: alarmPeriodMinutes(settings.pollIntervalSeconds),
  });
  await chrome.alarms.create(C4_HEARTBEAT_ALARM, {
    periodInMinutes: alarmPeriodMinutes(settings.heartbeatIntervalSeconds),
  });
}

function normalizePendingFill(fill = {}) {
  const payload = fill.c3_payload || fill.c3Payload || {};
  return {
    runId: String(fill.run_id || fill.runId || payload.runId || ""),
    applyUrl: fill.apply_url || fill.applyUrl || payload.applyUrl || "",
    c3Payload: {
      ...payload,
      jobId: String(payload.jobId || fill.job_id || fill.jobId || ""),
      sourceMode: payload.sourceMode || "c4",
      source: payload.source || "c4",
      atsType: payload.atsType || fill.ats_type || fill.atsType || "",
      applyUrl: payload.applyUrl || fill.apply_url || fill.applyUrl || "",
      jobUrl: payload.jobUrl || fill.job_url || fill.jobUrl || "",
      title: payload.title || fill.title || "",
      company: payload.company || fill.company || "",
    },
  };
}

function finalHostFor(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

function resultPayloadFromFill(runId, fillResult, attempt) {
  const result = fillResult?.result || {};
  const finalUrl = attempt?.applyUrl || result.finalUrl || "";
  const manualReviewReasons = attempt?.manualReviewReasons || [];
  const status = fillResult?.ok
    ? attempt?.manualReviewRequired
      ? "manual_review"
      : "ok"
    : "failed";
  return {
    status,
    message: fillResult?.message || attempt?.resultSummary || "",
    runId,
    finalUrl,
    finalHost: finalHostFor(finalUrl),
    atsType: attempt?.atsType || result.atsType || "unknown",
    fillRoute: attempt?.fillRoute || "",
    filledFields: result.filledFields || [],
    filledFieldCount: attempt?.filledFieldCount || 0,
    fieldInventory: result.fieldInventory || attempt?.fieldInventory || [],
    interactionTrace:
      result.interactionTrace || attempt?.interactionTrace || [],
    generatedAnswersUsed: (attempt?.generatedAnswerCount || 0) > 0,
    generatedAnswers: fillResult?.generatedAnswers || [],
    missingRequiredFields: result.missingRequiredFields || [],
    manualReviewFlags: manualReviewReasons,
    manualReviewReasons,
    resumeUploadOk: !manualReviewReasons.some((reason) =>
      String(reason).startsWith("resume_upload:"),
    ),
    evidence: {
      screenshotDataUrl: attempt?.screenshotDataUrl || "",
      htmlSnapshot: attempt?.htmlSnapshot || "",
      activityAttemptId: attempt?.id || "",
    },
  };
}

async function sendStatus(settings, payload) {
  try {
    await postExtensionStatus(settings, {
      worker: "c3_extension",
      ...payload,
    });
  } catch (error) {
    await logActivity(
      "poll.status_failed",
      error instanceof Error ? error.message : String(error),
      {},
      "warn",
    );
  }
}

async function pollC4Once() {
  const state = await getExtensionState();
  const settings = state.settings;
  if (!settings.c4PollingEnabled) {
    return { ok: true, skipped: true, reason: "polling_disabled" };
  }
  if (!settings.backendUrl || !settings.serviceToken) {
    await logActivity(
      "poll.skip",
      "C4 polling skipped because backend URL or service token is missing.",
      {
        hasBackendUrl: Boolean(settings.backendUrl),
        hasServiceToken: Boolean(settings.serviceToken),
      },
      "blocked",
    );
    return { ok: false, reason: "missing_poll_settings" };
  }
  if (settings.oneActiveRunLock && activeRunId) {
    return {
      ok: true,
      skipped: true,
      reason: "active_run_lock",
      runId: activeRunId,
    };
  }

  const pending = await fetchPendingFills(settings, 1);
  const fill = (pending.fills || [])[0];
  if (!fill) {
    await sendStatus(settings, { state: "idle", reason: "no_pending_fills" });
    return { ok: true, claimed: false, reason: "no_pending_fills" };
  }

  const normalized = normalizePendingFill(fill);
  if (!normalized.runId || !normalized.applyUrl) {
    await logActivity(
      "poll.bad_payload",
      "Pending fill is missing run id or apply URL.",
      { runId: normalized.runId, applyUrl: normalized.applyUrl },
      "failed",
    );
    return { ok: false, reason: "bad_pending_fill_payload" };
  }

  activeRunId = normalized.runId;
  await saveActiveApplyContext(normalized.c3Payload);
  await logActivity("poll.claim", "C4 pending fill loaded into C3.", {
    runId: normalized.runId,
    applyUrl: normalized.applyUrl,
    atsType: normalized.c3Payload.atsType,
  });
  await sendStatus(settings, { state: "running", runId: normalized.runId });

  let tab;
  try {
    tab = await chrome.tabs.create({ url: normalized.applyUrl, active: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const fillState = await getExtensionState();
    const fillResult = await runFillForTab(tab.id, fillState);
    const payload = resultPayloadFromFill(
      normalized.runId,
      fillResult,
      fillResult.attempt,
    );
    const postResult = await postFillResult(
      settings,
      normalized.runId,
      payload,
    );
    await logActivity("poll.post_result", "C4 fill result posted.", {
      runId: normalized.runId,
      status: payload.status,
      c4Status: postResult?.run?.status,
    });
    return { ok: true, runId: normalized.runId, postResult, fillResult };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failurePayload = {
      status: "failed",
      message,
      runId: normalized.runId,
      finalUrl: tab?.url || normalized.applyUrl,
      finalHost: finalHostFor(tab?.url || normalized.applyUrl),
      manualReviewFlags: ["c3_extension_failure"],
      evidence: { notes: message },
    };
    try {
      await postFillResult(settings, normalized.runId, failurePayload);
    } catch (postError) {
      await logActivity(
        "poll.post_failure_failed",
        postError instanceof Error ? postError.message : String(postError),
        { runId: normalized.runId },
        "failed",
      );
    }
    await logActivity(
      "poll.failed",
      message,
      { runId: normalized.runId },
      "failed",
    );
    return { ok: false, runId: normalized.runId, reason: message };
  } finally {
    activeRunId = "";
    await sendStatus(settings, {
      state: "idle",
      previousRunId: normalized.runId,
    });
  }
}

async function sendHeartbeat() {
  const state = await getExtensionState();
  if (!state.settings.c4PollingEnabled) {
    return;
  }
  await sendStatus(state.settings, {
    state: activeRunId ? "running" : "idle",
    activeRunId,
    pollingEnabled: true,
  });
}

function fillNeedsRefreshRetry(result) {
  const reasons = [
    ...(result?.attempt?.manualReviewReasons || []),
    ...(result?.result?.manualReviewReasons || []),
  ].map((reason) => String(reason || ""));
  return reasons.some((reason) => reason.includes("commit_not_verified"));
}

async function waitForTabReloadComplete(tabId, timeoutMs = 12000) {
  if (!tabId) {
    return { ok: false, reason: "missing_tab" };
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ ok: false, reason: "reload_timeout" });
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ ok: true });
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function markPageFillCancelled(tabId, fillRunId, cancelled = true) {
  if (!tabId) {
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [fillRunId || "", Boolean(cancelled)],
      func: (runId, isCancelled) => {
        const cancelledIds = Array.isArray(
          window.__huntApplyCancelledFillRunIds,
        )
          ? window.__huntApplyCancelledFillRunIds
          : [];
        window.__huntApplyCancelAllFills = isCancelled && !runId;
        if (runId && isCancelled) {
          window.__huntApplyCancelFillRunId = runId;
          if (!cancelledIds.includes(runId)) {
            cancelledIds.push(runId);
          }
          window.__huntApplyCancelledFillRunIds = cancelledIds.slice(-25);
        } else if (!isCancelled) {
          if (runId) {
            window.__huntApplyActiveFillRunId = runId;
            window.__huntApplyCancelledFillRunIds = cancelledIds
              .filter((id) => id !== runId)
              .slice(-25);
            if (window.__huntApplyCancelFillRunId === runId) {
              window.__huntApplyCancelFillRunId = "";
            }
          } else {
            window.__huntApplyCancelFillRunId = "";
          }
        }
      },
    });
  } catch {
    // The active page may have navigated or may not allow script injection.
  }
}

function fillCancelledResponse(state, reason = "user_cancelled") {
  return {
    ok: false,
    reason,
    message: "Fill canceled.",
    route: {
      routeName: "cancelled",
      fillSource: state.activeApplyContext.sourceMode || "manual",
      strategy: "cancelled",
      adapterName: "",
      requestedAtsType: state.activeApplyContext.atsType || "",
      detectedAtsType: "",
      usedGenericFallback: false,
      adapterBackedByGeneric: false,
    },
    attempt: {
      applyUrl: state.activeApplyContext.applyUrl,
      atsType: state.activeApplyContext.atsType,
      filledFieldCount: 0,
      manualReviewRequired: true,
      manualReviewReasons: [reason],
    },
    result: {
      ok: false,
      pendingLlmFieldCount: 0,
      manualReviewReasons: [reason],
      filledFieldCount: 0,
      filledFields: [],
      fieldInventory: [],
      generatedAnswers: [],
    },
    generatedAnswers: [],
    cancelled: true,
  };
}

function fillNoProgressTimeoutResponse(state, progress = {}) {
  const timeoutSeconds = Math.round(Number(progress.timeoutMs || 5000) / 1000);
  return {
    ok: false,
    reason: "fill_no_progress_timeout",
    message: `Fill stopped because no visible fields changed within ${timeoutSeconds} seconds.`,
    route: {
      routeName: "timeout",
      fillSource: state.activeApplyContext.sourceMode || "manual",
      strategy: "no_progress_timeout",
      adapterName: state.activeApplyContext.atsType || "",
      requestedAtsType: state.activeApplyContext.atsType || "",
      detectedAtsType: state.activeApplyContext.atsType || "",
      usedGenericFallback: false,
      adapterBackedByGeneric: false,
    },
    attempt: {
      applyUrl: state.activeApplyContext.applyUrl,
      atsType: state.activeApplyContext.atsType,
      filledFieldCount: 0,
      manualReviewRequired: true,
      manualReviewReasons: ["fill_no_progress_timeout"],
    },
    result: {
      ok: false,
      pendingLlmFieldCount: 0,
      manualReviewReasons: ["fill_no_progress_timeout"],
      filledFieldCount: 0,
      filledFields: [],
      fieldInventory: [],
      generatedAnswers: [],
      fillProgressWatchdog: progress,
    },
    generatedAnswers: [],
    fillProgressWatchdog: progress,
  };
}

async function inspectVisibleFillProgress(tabId) {
  if (!tabId) {
    return { ok: false, reason: "missing_tab_id", filledCount: 0 };
  }
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const normalize = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim();
          const visible = (element) => {
            if (!element) {
              return false;
            }
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          };
          const values = [];
          const activeStep = document.querySelector(
            '[data-automation-id="progressBarActiveStep"]',
          );
          if (activeStep && visible(activeStep)) {
            const stepText = normalize(
              activeStep.innerText || activeStep.textContent || "",
            );
            if (stepText) {
              values.push(`step:${stepText}`);
            }
          }
          values.push(`href:${location.href.split("#")[0]}`);
          for (const input of document.querySelectorAll("input, textarea")) {
            if (!visible(input)) {
              continue;
            }
            const type = String(input.type || "").toLowerCase();
            if (/^(hidden|submit|button|reset|file)$/i.test(type)) {
              continue;
            }
            if (type === "checkbox" || type === "radio") {
              if (input.checked) {
                values.push(`checked:${input.id || input.name || type}`);
              }
              continue;
            }
            const value = normalize(input.value || "");
            if (value) {
              values.push(`value:${input.id || input.name || value}`);
            }
          }
          for (const select of document.querySelectorAll("select")) {
            if (!visible(select)) {
              continue;
            }
            const value = normalize(select.value || select.selectedOptions?.[0]?.text || "");
            if (value && !/^select one$/i.test(value)) {
              values.push(`select:${select.id || select.name || value}`);
            }
          }
          for (const button of document.querySelectorAll("button, [role='button']")) {
            if (!visible(button)) {
              continue;
            }
            const text = normalize(
              button.innerText ||
                button.textContent ||
                button.getAttribute?.("aria-label") ||
                "",
            );
            const id = button.id || button.getAttribute?.("data-automation-id") || "";
            const name = button.getAttribute?.("name") || "";
            const aria = button.getAttribute?.("aria-label") || "";
            const isFieldValue =
              Boolean(button.id || name) &&
              !/^pageFooter|^utilityButton|^navigationItem|^backToJobPosting|^add-button$/i.test(id);
            if (
              isFieldValue &&
              text &&
              !/^select one$/i.test(text) &&
              !/^0 items selected$/i.test(text) &&
              !/^(next|back|cancel|add|remove|upload|select files)$/i.test(text)
            ) {
              values.push(`button:${id || name || aria || text}:${text}`);
            }
          }
          for (const pill of document.querySelectorAll(
            [
              '[data-automation-id="selectedItem"]',
              '[data-automation-id="promptSelectionLabel"]',
              '[aria-label*="press delete" i]',
            ].join(", "),
          )) {
            if (!visible(pill)) {
              continue;
            }
            const text = normalize(
              pill.innerText ||
                pill.textContent ||
                pill.getAttribute?.("aria-label") ||
                "",
            );
            if (text) {
              values.push(`pill:${text}`);
            }
          }
          for (const upload of document.querySelectorAll(
            '[data-automation-id*="attachment" i], [data-automation-id*="upload" i]',
          )) {
            if (!visible(upload)) {
              continue;
            }
            const text = normalize(upload.innerText || upload.textContent || "");
            if (/successfully uploaded|\.pdf|\.docx?/i.test(text)) {
              values.push(`upload:${text.slice(0, 160)}`);
            }
          }
          const activeWidgetLabels = [];
          for (const widget of document.querySelectorAll(
            [
              '[role="listbox"]',
              '[data-automation-id="activeListContainer"]',
              '[data-automation-id="menuItem"]',
              '[role="option"]',
            ].join(", "),
          )) {
            if (!visible(widget)) {
              continue;
            }
            const text = normalize(
              widget.innerText ||
                widget.textContent ||
                widget.getAttribute?.("aria-label") ||
                "",
            );
            if (text) {
              activeWidgetLabels.push(text.slice(0, 120));
            }
          }
          if (activeWidgetLabels.length) {
            values.push(
              `activeWidget:${activeWidgetLabels.slice(0, 6).join("|")}`,
            );
          }
          const errors = [...document.querySelectorAll('[role="alert"], [data-automation-id*="error" i], [id*="error" i]')]
            .filter(visible)
            .map((element) => normalize(element.innerText || element.textContent || ""))
            .filter(Boolean)
            .slice(0, 20);
          if (errors.length) {
            values.push(`errors:${errors.join("||")}`);
          }
          return {
            ok: true,
            href: location.href,
            filledCount: new Set(values).size,
            signature: Array.from(new Set(values)).sort().join("|"),
            values: Array.from(new Set(values)).slice(0, 25),
          };
        },
      }),
      3000,
      () => null,
    );
    const entries = Array.isArray(results)
      ? results.map((entry) => entry.result).filter(Boolean)
      : [];
    return (
      entries.sort(
        (a, b) => Number(b.filledCount || 0) - Number(a.filledCount || 0),
      )[0] || { ok: false, reason: "empty_progress_result", filledCount: 0 }
    );
  } catch (error) {
    return {
      ok: false,
      reason: "fill_progress_probe_failed",
      message: String(error?.message || error),
      filledCount: 0,
    };
  }
}

async function runFillForTabWithNoProgressWatchdog(
  tabId,
  state,
  fillRunId,
  options = {},
) {
  const startedAt = Date.now();
  const before = await inspectVisibleFillProgress(tabId);
  let lastProgress = before;
  let lastProgressSignature = String(before.signature || "");
  let lastProgressAt = Date.now();
  let settled = false;
  const run = activeFillRuns.get(fillRunId);
  const hasUploadProgress = (progress = {}) =>
    (progress.values || []).some((value) =>
      /^(upload:)|successfully uploaded|\.pdf|\.docx?/i.test(
        String(value || ""),
      ),
    );
  const hasActiveWidgetProgress = (progress = {}) =>
    (progress.values || []).some((value) =>
      /^activeWidget:/i.test(String(value || "")),
    );
  const fillPromise = runFillForTab(tabId, state, options)
    .then((result) => {
      settled = true;
      return result;
    })
    .catch((error) => {
      settled = true;
      throw error;
    });
  const watchdogPromise = (async () => {
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (settled) {
        return null;
      }
      const after = await inspectVisibleFillProgress(tabId);
      const nextSignature = String(after.signature || "");
      if (nextSignature && nextSignature !== lastProgressSignature) {
        lastProgress = after;
        lastProgressSignature = nextSignature;
        lastProgressAt = Date.now();
        continue;
      }
      const baseNoProgressTimeoutMs = Math.max(
        Number(options.noProgressTimeoutMs || 0),
        FILL_NO_PROGRESS_TIMEOUT_MS,
      );
      const progressTimeoutMs = hasUploadProgress(lastProgress)
        ? FILL_UPLOAD_PROGRESS_TIMEOUT_MS
        : hasActiveWidgetProgress(lastProgress)
          ? FILL_ACTIVE_WIDGET_PROGRESS_TIMEOUT_MS
          : baseNoProgressTimeoutMs;
      if (Date.now() - lastProgressAt < progressTimeoutMs) {
        continue;
      }
      try {
        run?.abortController?.abort("fill_no_progress_timeout");
      } catch (_error) {
        // Abort is best effort; the page-side cancel flag below stops V2 loops.
      }
      await markPageFillCancelled(tabId, fillRunId, true);
      await logActivity(
        "fill.no_progress_timeout",
        `Stopped fill because no visible fields changed within ${Math.round(progressTimeoutMs / 1000)} seconds.`,
        {
          tabId,
          fillRunId,
          timeoutMs: progressTimeoutMs,
          before,
          lastProgress,
          after,
        },
        "blocked",
      );
      return fillNoProgressTimeoutResponse(state, {
        timeoutMs: progressTimeoutMs,
        elapsedMs: Date.now() - startedAt,
        idleMs: Date.now() - lastProgressAt,
        before,
        lastProgress,
        after,
      });
    }
    return null;
  })();
  const raced = await Promise.race([fillPromise, watchdogPromise]);
  if (raced) {
    fillPromise.catch(() => {});
    return raced;
  }
  return fillPromise;
}

function workflowBlockedResponse(state, workflow, reason = "workflow_blocked") {
  return {
    ok: false,
    reason,
    message:
      workflow?.auth?.message ||
      workflow?.applyEntry?.message ||
      "C3 stopped before job fill because an earlier workflow section failed.",
    route: {
      routeName: "workflow_blocked",
      fillSource: state.activeApplyContext.sourceMode || "manual",
      strategy: "workflow_blocked",
      adapterName: state.activeApplyContext.atsType || "",
      requestedAtsType: state.activeApplyContext.atsType || "",
      detectedAtsType: workflow?.detection?.phase || "",
      usedGenericFallback: false,
      adapterBackedByGeneric: false,
    },
    attempt: {
      applyUrl: state.activeApplyContext.applyUrl,
      atsType: state.activeApplyContext.atsType,
      filledFieldCount: 0,
      manualReviewRequired: true,
      manualReviewReasons: [reason],
    },
    result: {
      ok: false,
      pendingLlmFieldCount: 0,
      manualReviewReasons: [reason],
      filledFieldCount: 0,
      filledFields: [],
      fieldInventory: [],
      generatedAnswers: [],
      workflow,
    },
    generatedAnswers: [],
    workflow,
  };
}

async function runFillWithOneRefreshRetry(
  tabId,
  state,
  triggeredBy,
  fillRunId,
  options = {},
) {
  const siteMonitor = startFillSiteActionMonitor(tabId, fillRunId);
  try {
    let beforeSiteState = await collectTabSiteState(tabId, "before_fill");
    await logActivity(
      "fill.site_state.before",
      "Captured site state before fill.",
      {
        tabId,
        fillRunId,
        triggeredBy: triggeredBy || "",
        siteState: beforeSiteState,
      },
      beforeSiteState.workdayRuntimeError ? "blocked" : "info",
    );
    if (beforeSiteState.workdayRuntimeError) {
      await showFillProgress(
        tabId,
        "Refreshing Workday after runtime error",
        fillRunId,
      );
      const runtimeRecovery = await recoverWorkdayRuntimeErrorForTab(tabId, {
        reason: "workday_runtime_error_before_fill",
      });
      await logActivity(
        runtimeRecovery.ok
          ? "fill.workday_runtime_recovered_before_fill"
          : "fill.workday_runtime_unrecovered_before_fill",
        runtimeRecovery.ok
          ? "Recovered Workday runtime error before fill."
          : "Workday runtime error remained before fill.",
        {
          tabId,
          fillRunId,
          triggeredBy: triggeredBy || "",
          reason: runtimeRecovery.reason || "",
          before: runtimeRecovery.before || {},
          after: runtimeRecovery.after || {},
        },
        runtimeRecovery.ok ? "ok" : "blocked",
      );
      if (!runtimeRecovery.ok) {
        const blocked = markWorkdayRuntimeErrorFill(
          workflowBlockedResponse(
            state,
            null,
            "workday_runtime_error_before_fill",
          ),
          beforeSiteState,
          "workday_runtime_error_before_fill",
        );
        blocked.runtimeRecovery = runtimeRecovery;
        if (blocked.result) {
          blocked.result.runtimeRecovery = runtimeRecovery;
        }
        return blocked;
      }
      await dismissPageTransientUi(tabId, { preserveFillProgress: true });
      await showFillProgress(
        tabId,
        "Retrying fill after Workday refresh",
        fillRunId,
      );
      beforeSiteState = await collectTabSiteState(
        tabId,
        "before_fill_after_runtime_recovery",
      );
      await logActivity(
        "fill.site_state.before_after_runtime_recovery",
        "Captured site state after Workday runtime recovery.",
        {
          tabId,
          fillRunId,
          triggeredBy: triggeredBy || "",
          siteState: beforeSiteState,
        },
        beforeSiteState.workdayRuntimeError ? "blocked" : "info",
      );
      if (beforeSiteState.workdayRuntimeError) {
        return markWorkdayRuntimeErrorFill(
          workflowBlockedResponse(
            state,
            null,
            "workday_runtime_error_before_fill_recovered_still_present",
          ),
          beforeSiteState,
          "workday_runtime_error_before_fill_recovered_still_present",
        );
      }
    }
    let result = await withTimeout(
      runFillForTabWithNoProgressWatchdog(tabId, state, fillRunId, {
        fillRunId,
        isCancelled: () => isFillRunCancelled(fillRunId),
        allowLlmAnswers: options.allowLlmAnswers === true,
        abortSignal: activeFillRuns.get(fillRunId)?.abortController?.signal,
        noProgressTimeoutMs: options.noProgressTimeoutMs,
        fieldFillTimeoutMs: options.fieldFillTimeoutMs,
      }),
      FILL_TIMEOUT_MS,
      () => ({
        ok: false,
        message: "Fill timed out before the page responded.",
        route: {
          routeName: "timeout",
          fillSource: state.activeApplyContext.sourceMode || "manual",
          strategy: "timeout",
          adapterName: "",
          requestedAtsType: state.activeApplyContext.atsType || "",
          detectedAtsType: "",
          usedGenericFallback: false,
          adapterBackedByGeneric: false,
        },
        attempt: {
          applyUrl: state.activeApplyContext.applyUrl,
          atsType: state.activeApplyContext.atsType,
          filledFieldCount: 0,
          manualReviewRequired: true,
          manualReviewReasons: ["fill_timeout"],
        },
        result: {
          pendingLlmFieldCount: 0,
          manualReviewReasons: ["fill_timeout"],
        },
        generatedAnswers: [],
      }),
    );
    if (isFillRunCancelled(fillRunId)) {
      return fillCancelledResponse(state, fillRunCancelReason(fillRunId));
    }
    const afterInitialSiteState = await collectTabSiteState(
      tabId,
      fillHasManualReviewReason(result, "fill_timeout")
        ? "fill_timeout"
        : "after_fill",
    );
    const afterInitialAction = fillHasManualReviewReason(result, "fill_timeout")
      ? "fill.site_state.timeout"
      : "fill.site_state.after";
    appendSiteActionToFillResult(result, {
      action: afterInitialAction,
      status: afterInitialSiteState.workdayRuntimeError ? "blocked" : "info",
      siteState: afterInitialSiteState,
    });
    appendMonitorSiteActionsToFillResult(result, siteMonitor);
    await logActivity(
      afterInitialAction,
      fillHasManualReviewReason(result, "fill_timeout")
        ? "Captured site state after fill timeout."
        : "Captured site state after fill.",
      {
        tabId,
        fillRunId,
        triggeredBy: triggeredBy || "",
        siteState: afterInitialSiteState,
      },
      afterInitialSiteState.workdayRuntimeError ? "blocked" : "info",
    );
    if (afterInitialSiteState.workdayRuntimeError) {
      appendMonitorSiteActionsToFillResult(result, siteMonitor);
      return markWorkdayRuntimeErrorFill(
        result,
        afterInitialSiteState,
        "workday_runtime_error_after_fill",
      );
    }
    if (!fillNeedsRefreshRetry(result)) {
      return result;
    }
    await logActivity(
      "fill.refresh_retry",
      "Refreshing page once before retrying fill after commit verification failure.",
      {
        tabId,
        triggeredBy: triggeredBy || "",
        manualReviewReasons: fillManualReviewReasons(result),
        maxRefreshRetries: 1,
      },
      "warn",
    );
    await showFillProgress(
      tabId,
      "Refreshing page before fill retry: attempt 2",
      fillRunId,
    );
    if (isFillRunCancelled(fillRunId)) {
      return fillCancelledResponse(state, fillRunCancelReason(fillRunId));
    }
    markFillRunExpectedReload(fillRunId);
    await chrome.tabs.reload(tabId);
    const reloadResult = await waitForTabReloadComplete(tabId);
    if (!reloadResult.ok) {
      result.refreshRetry = {
        attempted: true,
        ok: false,
        reason: reloadResult.reason || "reload_failed",
        maxRefreshRetries: 1,
      };
      const reloadSiteState = await collectTabSiteState(
        tabId,
        "refresh_retry_reload_failed",
      );
      appendSiteActionToFillResult(result, {
        action: "fill.site_state.refresh_retry_reload_failed",
        status: "warn",
        siteState: reloadSiteState,
      });
      appendMonitorSiteActionsToFillResult(result, siteMonitor);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await dismissPageTransientUi(tabId);
    await showFillProgress(
      tabId,
      "Retrying fill after refresh: attempt 2",
      fillRunId,
    );
    const retryResult = await withTimeout(
      runFillForTabWithNoProgressWatchdog(tabId, state, fillRunId, {
        fillRunId,
        isCancelled: () => isFillRunCancelled(fillRunId),
        allowLlmAnswers: options.allowLlmAnswers === true,
        abortSignal: activeFillRuns.get(fillRunId)?.abortController?.signal,
        noProgressTimeoutMs: options.noProgressTimeoutMs,
        fieldFillTimeoutMs: options.fieldFillTimeoutMs,
      }),
      FILL_TIMEOUT_MS,
      () => ({
        ok: false,
        message: "Fill retry timed out after page refresh.",
        route: {
          routeName: "timeout",
          fillSource: state.activeApplyContext.sourceMode || "manual",
          strategy: "timeout",
          adapterName: "",
          requestedAtsType: state.activeApplyContext.atsType || "",
          detectedAtsType: "",
          usedGenericFallback: false,
          adapterBackedByGeneric: false,
        },
        attempt: {
          applyUrl: state.activeApplyContext.applyUrl,
          atsType: state.activeApplyContext.atsType,
          filledFieldCount: 0,
          manualReviewRequired: true,
          manualReviewReasons: ["fill_retry_timeout"],
        },
        result: {
          pendingLlmFieldCount: 0,
          manualReviewReasons: ["fill_retry_timeout"],
        },
        generatedAnswers: [],
      }),
    );
    if (isFillRunCancelled(fillRunId)) {
      return fillCancelledResponse(state, fillRunCancelReason(fillRunId));
    }
    const afterRetrySiteState = await collectTabSiteState(
      tabId,
      fillHasManualReviewReason(retryResult, "fill_retry_timeout")
        ? "fill_retry_timeout"
        : "after_retry_fill",
    );
    appendSiteActionToFillResult(retryResult, {
      action: fillHasManualReviewReason(retryResult, "fill_retry_timeout")
        ? "fill.site_state.retry_timeout"
        : "fill.site_state.after_retry",
      status: afterRetrySiteState.workdayRuntimeError ? "blocked" : "info",
      siteState: afterRetrySiteState,
    });
    appendMonitorSiteActionsToFillResult(retryResult, siteMonitor);
    await logActivity(
      fillHasManualReviewReason(retryResult, "fill_retry_timeout")
        ? "fill.site_state.retry_timeout"
        : "fill.site_state.after_retry",
      fillHasManualReviewReason(retryResult, "fill_retry_timeout")
        ? "Captured site state after retry timeout."
        : "Captured site state after retry fill.",
      {
        tabId,
        fillRunId,
        triggeredBy: triggeredBy || "",
        siteState: afterRetrySiteState,
      },
      afterRetrySiteState.workdayRuntimeError ? "blocked" : "info",
    );
    if (afterRetrySiteState.workdayRuntimeError) {
      appendMonitorSiteActionsToFillResult(retryResult, siteMonitor);
      return markWorkdayRuntimeErrorFill(
        retryResult,
        afterRetrySiteState,
        "workday_runtime_error_after_retry_fill",
      );
    }
    retryResult.refreshRetry = {
      attempted: true,
      ok: true,
      reason: "commit_not_verified",
      maxRefreshRetries: 1,
      previousMessage: result.message || "",
      previousManualReviewReasons: fillManualReviewReasons(result),
    };
    return retryResult;
  } finally {
    siteMonitor.stop();
  }
}

async function handleMessage(message, sender = {}) {
  switch (message?.type) {
    case "hunt.apply.ping":
      return { ok: true, source: "background" };

    case "hunt.apply.get_state":
      return { ok: true, ...(await getExtensionState()) };

    case "hunt.apply.get_active_fill_progress": {
      const tabId = message.payload?.tabId || sender.tab?.id;
      const progress = tabId ? activeFillProgressByTab.get(tabId) : null;
      const activeFillRunId = tabId ? activeFillRunByTab.get(tabId) : "";
      const fillRunId = progress?.fillRunId || activeFillRunId || "";
      const run = fillRunId ? activeFillRuns.get(fillRunId) : null;
      if (!run) {
        return { ok: true, active: false };
      }
      return {
        ok: true,
        active: true,
        message: progress?.message || ACTIVE_FILL_PREPARING_MESSAGE,
        fillRunId,
        updatedAt: progress?.updatedAt || Date.parse(run.startedAt || "") || 0,
      };
    }

    case "hunt.apply.cancel_fill": {
      const tabId = message.payload?.tabId || sender.tab?.id;
      const fillRunId =
        message.payload?.fillRunId || activeFillRunByTab.get(tabId) || "";
      const cancelled = cancelFillRun(fillRunId);
      if (tabId && activeFillRunByTab.get(tabId) === fillRunId) {
        activeFillRunByTab.delete(tabId);
      }
      Promise.allSettled([
        markPageFillCancelled(tabId, fillRunId),
        logActivity(
          cancelled ? "fill.cancel_requested" : "fill.cancel_missing",
          cancelled
            ? "Requested cancellation for the current fill."
            : "Tried to cancel fill, but no active fill run matched.",
          { fillRunId, tabId },
          cancelled ? "warn" : "blocked",
        ),
        hideFillProgress(tabId),
      ]).catch(() => {});
      return { ok: cancelled, cancelled, fillRunId };
    }

    case "hunt.apply.site_action_log": {
      const payload = message.payload || {};
      const status = payload.status === "blocked" ? "blocked" : "info";
      await logActivity(
        `fill.site_action.${payload.action || "unknown"}`,
        payload.action === "site_state_after_field"
          ? "Captured site state after a field action."
          : "Captured site state before a field action.",
        {
          tabId: sender.tab?.id || 0,
          frameId: sender.frameId ?? 0,
          fillRunId: payload.fillRunId || "",
          fieldId: payload.fieldId || "",
          descriptor: payload.descriptor || "",
          uiModel: payload.uiModel || "",
          filled: Boolean(payload.filled),
          fillReason: payload.fillReason || "",
          reason: payload.reason || "",
          siteState: payload.siteState || {},
        },
        status,
      );
      return { ok: true };
    }

    case "hunt.apply.trusted_input":
      return dispatchTrustedInput(message.payload || {}, sender);

    case "hunt.apply.await_email_verification":
      return awaitEmailVerification(message.payload || {}, sender);

    case "hunt.apply.save_settings": {
      const settings = await saveSettings(message.payload || {});
      await refreshPollingAlarms(settings);
      await logActivity("settings.save", "Behavior settings saved.", {
        autofillOnLoad: settings.autofillOnLoad,
        manualFillEnabled: settings.manualFillEnabled,
        autoPromptEnabled: settings.autoPromptEnabled,
        autoAccountSignupLoginEnabled: settings.autoAccountSignupLoginEnabled,
        autoEmailVerificationEnabled: settings.autoEmailVerificationEnabled,
        emailVerificationTimeoutSeconds:
          settings.emailVerificationTimeoutSeconds,
        autoExportLogs: settings.autoExportLogs,
        autoClickNextAfterFill: settings.autoClickNextAfterFill,
        allowGeneratedAnswers: settings.allowGeneratedAnswers,
        c4PollingEnabled: settings.c4PollingEnabled,
        pollIntervalSeconds: settings.pollIntervalSeconds,
      });
      return { ok: true, settings };
    }

    case "hunt.apply.save_profile": {
      const profile = await saveProfile(message.payload || {});
      await logActivity("profile.save", "Candidate profile saved.", {
        fullName: profile.fullName,
        email: profile.email,
        hasPhone: Boolean(profile.phone),
        location: profile.location,
      });
      return { ok: true, profile };
    }

    case "hunt.apply.save_default_resume": {
      const defaultResume = await saveDefaultResume(message.payload || {});
      await logActivity("resume.save", "Default resume saved.", {
        label: defaultResume.label,
        sourceType: defaultResume.sourceType,
        pdfFileName: defaultResume.pdfFileName,
        hasPdfData: Boolean(defaultResume.pdfDataUrl),
      });
      return {
        ok: true,
        defaultResume,
      };
    }

    case "hunt.apply.set_apply_context": {
      const activeApplyContext = await saveActiveApplyContext(
        message.payload || {},
      );
      await logActivity("context.import", "Active apply context imported.", {
        jobId: activeApplyContext.jobId,
        applyUrl: activeApplyContext.applyUrl,
        atsType: activeApplyContext.atsType,
        selectedResumeName: activeApplyContext.selectedResumeName,
      });
      return {
        ok: true,
        activeApplyContext,
      };
    }

    case "hunt.apply.clear_apply_context": {
      const activeApplyContext = await clearActiveApplyContext();
      await logActivity("context.clear", "Active apply context cleared.");
      return { ok: true, activeApplyContext };
    }

    case "hunt.apply.fill_current_page": {
      const tabId = message.payload?.tabId || sender.tab?.id;
      const state = await getExtensionState();
      if (!state.settings.manualFillEnabled) {
        await logActivity(
          "fill.skip",
          "Manual fill skipped because manual fill is disabled.",
          {},
          "blocked",
        );
        return {
          ok: false,
          reason: "manual_fill_disabled",
          message: "Manual fill is currently disabled in extension settings.",
        };
      }
      const passwordSaving = await ensurePasswordSavingDisabled(
        "fill_current_page",
      );
      if (!passwordSaving.ok) {
        await logActivity(
          "password_saving.disable_failed",
          "C3 could not disable Chrome password saving before fill.",
          passwordSaving,
          "warn",
        );
      }
      let result;
      const fillRunId = createFillRunId();
      const abortController = new AbortController();
      const supersededFillRunIds = cancelActiveFillRunsForTab(tabId);
      activeFillRunByTab.set(tabId, fillRunId);
      activeFillRuns.set(fillRunId, {
        tabId,
        triggeredBy: message.payload?.triggeredBy || "fill_current_page",
        startedAt: new Date().toISOString(),
        cancelled: false,
        lastKnownUrl: sender.tab?.url || message.payload?.url || "",
        expectedReloads: 0,
        abortController,
        supersededFillRunIds,
      });
      for (const supersededFillRunId of supersededFillRunIds) {
        await markPageFillCancelled(tabId, supersededFillRunId, true);
      }
      if (supersededFillRunIds.length) {
        await logActivity(
          "fill.supersede_previous",
          "Started a new fill and canceled previous active fill run(s) on this tab.",
          {
            tabId,
            fillRunId,
            supersededFillRunIds,
            triggeredBy: message.payload?.triggeredBy || "fill_current_page",
          },
          "warn",
        );
      }
      await dismissPageTransientUi(tabId, { preserveFillProgress: true });
      await markPageFillCancelled(tabId, fillRunId, false);
      const allowLlmAnswers =
        state.settings.llmAnswerFallbackEnabled === true &&
        message.payload?.allowLlmAnswers !== false;
      const startupDetection = await detectWorkflowForTab(tabId);
      const startsAtApplyEntry = Boolean(startupDetection?.isApplyEntryPage);
      let workflow = null;
      try {
        const startupRuntimeRecovery = startsAtApplyEntry
          ? { attempted: false, ok: true, reason: "apply_entry_section" }
          : await recoverWorkdayRuntimeErrorForTab(tabId, {
              reason: WORKDAY_RUNTIME_ERROR_REASON,
            });
        if (startupRuntimeRecovery.attempted && !startupRuntimeRecovery.ok) {
          result = {
            ok: false,
            reason:
              startupRuntimeRecovery.reason || WORKDAY_RUNTIME_ERROR_REASON,
            message:
              startupRuntimeRecovery.after?.message ||
              startupRuntimeRecovery.before?.message ||
              "Workday showed its generic runtime error after loading the application.",
            route: {
              routeName: "workday_runtime_recovery",
              fillSource: state.activeApplyContext.sourceMode || "manual",
              strategy: "runtime_recovery",
              adapterName: state.activeApplyContext.atsType || "workday",
              requestedAtsType: state.activeApplyContext.atsType || "workday",
              detectedAtsType: "workday",
              usedGenericFallback: false,
              adapterBackedByGeneric: false,
            },
            attempt: {
              applyUrl: state.activeApplyContext.applyUrl,
              atsType: state.activeApplyContext.atsType || "workday",
              filledFieldCount: 0,
              manualReviewRequired: true,
              manualReviewReasons: [
                startupRuntimeRecovery.reason || WORKDAY_RUNTIME_ERROR_REASON,
              ],
            },
            result: {
              ok: false,
              pendingLlmFieldCount: 0,
              manualReviewReasons: [
                startupRuntimeRecovery.reason || WORKDAY_RUNTIME_ERROR_REASON,
              ],
              filledFieldCount: 0,
              filledFields: [],
              fieldInventory: [],
              generatedAnswers: [],
              runtimeRecovery: startupRuntimeRecovery,
            },
            generatedAnswers: [],
          };
        }
        const directVerificationGate = startsAtApplyEntry
          ? { handled: false, result: null, reason: "apply_entry_section" }
          : await maybeHandleEmailVerificationGate({
              tabId,
              state,
              fillRunId,
              triggeredBy: message.payload?.triggeredBy || "fill_current_page",
              pageIndex: 0,
            });
        if (result) {
          // Startup runtime recovery already classified the page.
        } else if (
          directVerificationGate.handled &&
          !directVerificationGate.result?.ok
        ) {
          result = {
            ok: false,
            reason:
              directVerificationGate.result?.reason ||
              "email_verification_failed",
            message:
              directVerificationGate.result?.message ||
              "Email verification could not be completed automatically.",
            route: {
              routeName: "email_verification",
              fillSource: state.activeApplyContext.sourceMode || "manual",
              strategy: "email_verification",
              adapterName: state.activeApplyContext.atsType || "",
              requestedAtsType: state.activeApplyContext.atsType || "",
              detectedAtsType: "email_verification",
              usedGenericFallback: false,
              adapterBackedByGeneric: false,
            },
            attempt: {
              applyUrl: state.activeApplyContext.applyUrl,
              atsType: state.activeApplyContext.atsType,
              filledFieldCount: 0,
              manualReviewRequired: true,
              manualReviewReasons: [
                directVerificationGate.result?.reason ||
                  "email_verification_failed",
              ],
            },
            result: {
              ok: false,
              pendingLlmFieldCount: 0,
              manualReviewReasons: [
                directVerificationGate.result?.reason ||
                  "email_verification_failed",
              ],
              filledFieldCount: 0,
              filledFields: [],
              fieldInventory: [],
              generatedAnswers: [],
              emailVerification: directVerificationGate,
            },
            generatedAnswers: [],
          };
        } else {
          workflow = await new C3CombinedFillWorkflow({
            tabId,
            fillRunId,
            state,
            triggeredBy: message.payload?.triggeredBy || "fill_current_page",
            initialDetection: startupDetection,
          }).prepare();
          if (!workflow.auth?.ok) {
            result = workflowBlockedResponse(
              state,
              workflow,
              workflow.auth?.reason || "auth_workflow_failed",
            );
          } else if (!workflow.applyEntry?.ok) {
            result = workflowBlockedResponse(
              state,
              workflow,
              workflow.applyEntry?.reason || "apply_entry_failed",
            );
          } else {
            const fillMessage = workflow.detection?.isAuthPage
              ? workflow.detection?.authState === "signup"
                ? "Filling account signup fields: attempt 1"
                : "Filling account sign-in fields: attempt 1"
              : message.payload?.pageKind === "apply_entry" ||
                  (workflow.applyEntry?.ok && !workflow.applyEntry?.skipped)
                ? "Filling application page: attempt 1"
                : "Filling current page: attempt 1";
            await showFillProgress(tabId, fillMessage, fillRunId);
            try {
              const justEnteredApplication = Boolean(
                workflow.applyEntry?.ok && !workflow.applyEntry?.skipped,
              );
              result = await runFillWithOneRefreshRetry(
                tabId,
                state,
                message.payload?.triggeredBy || "fill_current_page",
                fillRunId,
                {
                  allowLlmAnswers,
                  noProgressTimeoutMs: justEnteredApplication ? 15000 : 0,
                  fieldFillTimeoutMs: justEnteredApplication ? 15000 : 0,
                },
              );
            } finally {
              clearFillRunExpectedReloads(fillRunId);
            }
            result.workflow = workflow;
            if (result.result) {
              result.result.workflow = workflow;
            }
          }
        }
        if (
          shouldRunV2PageWalk(state.settings, result, message.payload || {})
        ) {
          result.pageWalk = await runV2PageWalkAfterFill({
            tabId,
            state,
            initialResult: result,
            fillRunId,
            triggeredBy: message.payload?.triggeredBy || "fill_current_page",
            allowLlmAnswers,
          });
          result.message =
            result.pageWalk.stoppedReason === "final_submit_visible"
              ? `V2 filled ${result.pageWalk.pagesFilled} page${result.pageWalk.pagesFilled === 1 ? "" : "s"} and stopped before final submit.`
              : `V2 filled ${result.pageWalk.pagesFilled} page${result.pageWalk.pagesFilled === 1 ? "" : "s"}; page walk stopped: ${result.pageWalk.stoppedReason}.`;
          if (!result.pageWalk.ok) {
            result.ok = false;
            result.reason =
              result.pageWalk.stoppedReason || "page_walk_stopped";
            if (result.attempt) {
              result.attempt.status = "manual_review";
              result.attempt.manualReviewRequired = true;
              result.attempt.manualReviewReasons = Array.from(
                new Set([
                  ...(result.attempt.manualReviewReasons || []),
                  `page_walk:${result.reason}`,
                ]),
              );
            }
          }
          if (
            result.pageWalk.manualReviewRequired &&
            result.pageWalk.stoppedReason !== "final_submit_visible" &&
            result.attempt
          ) {
            result.attempt.manualReviewRequired = true;
            result.attempt.manualReviewReasons = Array.from(
              new Set([
                ...(result.attempt.manualReviewReasons || []),
                "c3_v2_page_walk_review_items",
              ]),
            );
          }
        }
        if (result && workflow && !result.workflow) {
          result.workflow = workflow;
          if (result.result) {
            result.result.workflow = workflow;
          }
        }
      } finally {
        const stillOwnsPageUi = activeFillRunByTab.get(tabId) === fillRunId;
        activeFillRuns.delete(fillRunId);
        if (stillOwnsPageUi) {
          activeFillRunByTab.delete(tabId);
          await hideFillProgress(tabId);
        } else if (result) {
          result.superseded = true;
        }
      }
      if (result?.superseded || result?.reason === "superseded_by_new_fill") {
        await sendDebugLog("fill_result", {
          ok: result.ok,
          message: result.message,
          route: result.route,
          attempt: result.attempt,
          result: result.result,
          generatedAnswers: result.generatedAnswers,
          refreshRetry: result.refreshRetry || null,
          pageWalk: result.pageWalk || null,
          workflow: result.workflow || null,
          superseded: true,
        });
        await logActivity(
          "fill.superseded",
          "Ignored stale fill result because a newer fill owns this tab.",
          {
            fillRunId,
            tabId,
            reason: result.reason || "",
            newerFillRunId: activeFillRunByTab.get(tabId) || "",
          },
          "warn",
        );
        return result;
      }
      await notePageFillCompleted(tabId, {
        triggeredBy: message.payload?.triggeredBy || "fill_current_page",
        ok: Boolean(result?.ok),
        filledFieldCount: Number(result?.attempt?.filledFieldCount || 0),
      });
      await sendDebugLog("fill_result", {
        ok: result.ok,
        message: result.message,
        route: result.route,
        attempt: result.attempt,
        result: result.result,
        generatedAnswers: result.generatedAnswers,
        refreshRetry: result.refreshRetry || null,
        pageWalk: result.pageWalk || null,
        workflow: result.workflow || null,
      });
      await logActivity(
        result.cancelled
          ? "fill.cancelled"
          : result.ok
            ? "fill.complete"
            : "fill.failed",
        result.message || (result.ok ? "Fill completed." : "Fill failed."),
        {
          fillRunId,
          jobId: state.activeApplyContext.jobId,
          applyUrl:
            result.attempt?.applyUrl || state.activeApplyContext.applyUrl,
          atsType: result.attempt?.atsType,
          filledFieldCount: result.attempt?.filledFieldCount,
          pendingLlmFieldCount: result.result?.pendingLlmFieldCount || 0,
          pendingLlmFields: (result.result?.pendingLlmFields || []).slice(
            0,
            10,
          ),
          interactionTrace: (result.result?.interactionTrace || []).slice(
            0,
            80,
          ),
          refreshRetry: result.refreshRetry || null,
          pageWalk: result.pageWalk || null,
          workflow: result.workflow || null,
          v2PermanentIssues: summarizeV2Issues(v2PermanentIssues(result), 20),
          manualReviewRequired: result.attempt?.manualReviewRequired,
        },
        result.ok ? "ok" : "failed",
      );
      const reviewReasons =
        result.attempt?.manualReviewReasons ||
        result.result?.manualReviewReasons ||
        [];
      const missingResume = reviewReasons.some((reason) =>
        String(reason).includes("missing_resume_data"),
      );
      const filledNothing = result.ok && !result.attempt?.filledFieldCount;
      const exportResult = state.settings.autoExportLogs
        ? await withTimeout(
            maybeAutoExportLogs(result.ok ? "fill-complete" : "fill-failed"),
            5000,
            () => ({ exported: false, reason: "auto_export_timeout" }),
          )
        : { exported: false, reason: "disabled" };
      const fillSummaryPayload = buildFillSummaryPayload(result);
      if (fillSummaryPayload) {
        await showFillSummary(tabId, fillSummaryPayload);
      }
      await showPageToast(
        tabId,
        result.cancelled
          ? "Fill canceled."
          : missingResume
            ? "No default resume is saved. Open Hunt Apply Options and save a PDF resume."
            : filledNothing
              ? "No fields were filled. Hunt logged the detected fields for review."
              : exportResult.exported
                ? `${result.message || (result.ok ? "Fill completed." : "Fill failed.")} Logs exported to ${exportResult.filename}.`
                : result.message ||
                  (result.ok ? "Fill completed." : "Fill failed."),
        result.cancelled ||
          missingResume ||
          filledNothing ||
          !result.ok ||
          result.attempt?.manualReviewRequired
          ? "warn"
          : "info",
      );
      if (result.ok && result.result?.pendingLlmFieldCount > 0) {
        await showLlmPrompt(tabId, {
          fieldCount: result.result.pendingLlmFieldCount,
          filledFieldCount: result.result.filledFieldCount || 0,
        });
      }
      if (!result.cancelled) {
        if (result.pageWalk?.enabled) {
          result.nextAction = result.pageWalk.lastNextAction || null;
        } else {
          result.nextAction = await maybeHandleSafeNextAfterFill({
            tabId,
            fillResponse: result,
            settings: state.settings,
            triggeredBy: message.payload?.triggeredBy || "fill_current_page",
          });
        }
      }
      return result;
    }

    case "hunt.apply.fill_remaining_with_llm": {
      const tabId = message.payload?.tabId || sender.tab?.id;
      const state = await getExtensionState();
      const result = await runPendingLlmFillForTab(tabId, state);
      await sendDebugLog("llm_fill_result", {
        ok: result.ok,
        message: result.message,
        route: result.route,
        attempt: result.attempt,
        result: result.result,
        generatedAnswers: result.generatedAnswers,
      });
      await logActivity(
        result.ok ? "llm_fill.complete" : "llm_fill.failed",
        result.message ||
          (result.ok ? "LLM fill completed." : "LLM fill failed."),
        {
          filledFieldCount: result.attempt?.filledFieldCount,
          generatedAnswerCount: result.attempt?.generatedAnswerCount,
          pendingLlmFieldCount: result.result?.pendingLlmFieldCount || 0,
          answerDecisionDiagnostics: (
            result.result?.answerDecisionDiagnostics || []
          ).slice(0, 20),
        },
        result.ok ? "ok" : "failed",
      );
      await showPageToast(
        tabId,
        result.message ||
          (result.ok ? "LLM fill completed." : "LLM fill failed."),
        result.ok ? "info" : "warn",
      );
      await notePageFillCompleted(tabId, {
        triggeredBy: message.payload?.triggeredBy || "fill_remaining_with_llm",
        ok: Boolean(result?.ok),
        filledFieldCount: Number(result?.attempt?.filledFieldCount || 0),
      });
      result.nextAction = await maybeHandleSafeNextAfterFill({
        tabId,
        fillResponse: result,
        settings: state.settings,
        triggeredBy: message.payload?.triggeredBy || "fill_remaining_with_llm",
      });
      return result;
    }

    case "hunt.apply.click_next_after_fill": {
      const tabId = message.payload?.tabId || sender.tab?.id;
      if (message.payload?.remember) {
        const state = await getExtensionState();
        const settings = await saveSettings({
          ...state.settings,
          autoClickNextAfterFill: true,
        });
        await refreshPollingAlarms(settings);
        await logActivity("settings.save", "Behavior settings saved.", {
          autoClickNextAfterFill: true,
          reason: "next_prompt_remember",
        });
      }
      return clickSafeNextForTab(tabId, {
        triggeredBy: message.payload?.triggeredBy || "popup_next_prompt",
      });
    }

    case "hunt.apply.clear_current_page": {
      const tabId = message.payload?.tabId || sender.tab?.id;
      await dismissPageTransientUi(tabId);
      await showFillProgress(tabId, "Clearing page");
      try {
        return await clearCurrentPage(tabId);
      } finally {
        await hideFillProgress(tabId);
      }
    }

    case "hunt.apply.clear_activity_log":
      await clearActivityLog();
      return { ok: true, activityLog: [] };

    case "hunt.apply.poll_c4_once":
      return pollC4Once();

    case "hunt.apply.c3_status":
      await sendHeartbeat();
      return { ok: true, activeRunId };

    case "hunt.apply.export_logs":
      return autoExportLogs(message.payload?.reason || "manual-export");

    case "hunt.apply.test_debug_log_sink":
      return sendDebugLog("sink_test", {
        message: "C3 debug log sink test.",
        requestedAt: new Date().toISOString(),
      });

    case "hunt.apply.log_activity":
      return {
        ok: true,
        activity: await logActivity(
          message.payload?.action || "extension.event",
          message.payload?.summary || "Extension event.",
          message.payload?.details || {},
          message.payload?.status || "ok",
        ),
      };

    default:
      return {
        ok: false,
        reason: "unknown_message",
        message: `Unknown message type: ${message?.type || "undefined"}`,
      };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await ensureStageOneState();
  const passwordSaving = await ensurePasswordSavingDisabled("on_installed");
  if (!passwordSaving.ok) {
    console.warn("Could not disable Chrome password saving:", passwordSaving);
  }
  await refreshPollingAlarms(state.settings);
  console.log("Hunt Apply extension installed.");
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await ensureStageOneState();
  const passwordSaving = await ensurePasswordSavingDisabled("on_startup");
  if (!passwordSaving.ok) {
    console.warn("Could not disable Chrome password saving:", passwordSaving);
  }
  await refreshPollingAlarms(state.settings);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === C4_POLL_ALARM) {
    pollC4Once().catch((error) => {
      console.error("C4 polling failed:", error);
    });
  }
  if (alarm.name === C4_HEARTBEAT_ALARM) {
    sendHeartbeat().catch((error) => {
      console.error("C3 status heartbeat failed:", error);
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    cancelFillRunForUserReload(tabId, changeInfo, tab).catch((error) => {
      console.error("Cancel on page reload failed:", error);
    });
  }
  if (changeInfo.status !== "complete") {
    return;
  }
  const pageUrl = tab?.url || "";
  if (
    !pageUrl ||
    pageUrl.startsWith("chrome:") ||
    pageUrl.startsWith("chrome-extension:") ||
    pageUrl.startsWith("edge:")
  ) {
    return;
  }
  (async () => {
    const state = await getExtensionState();
    if (
      !state.settings.autofillOnLoad ||
      !(
        state.activeApplyContext.selectedResumeDataUrl ||
        state.defaultResume.pdfDataUrl
      )
    ) {
      return;
    }
    const result = await runFillForTab(tabId, state);
    if (result.ok && result.result?.pendingLlmFieldCount > 0) {
      await showLlmPrompt(tabId, {
        fieldCount: result.result.pendingLlmFieldCount,
        filledFieldCount: result.result.filledFieldCount || 0,
      });
    }
    if (state.settings.autoClickNextAfterFill) {
      await maybeHandleSafeNextAfterFill({
        tabId,
        fillResponse: result,
        settings: state.settings,
        triggeredBy: "autofill_on_load",
      });
    }
  })().catch((error) => {
    console.error("Autofill on load failed:", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message, _sender)
    .then((response) => sendResponse(response))
    .catch((error) =>
      sendResponse({
        ok: false,
        reason: "background_error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
});
