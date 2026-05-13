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
import { recoverWorkdayRuntimeErrorForTab } from "./workday-runtime.js";

const C4_POLL_ALARM = "hunt.apply.c4.poll";
const C4_HEARTBEAT_ALARM = "hunt.apply.c4.heartbeat";
const FILL_TIMEOUT_MS = 45000;
let activeRunId = "";
const activeFillRuns = new Map();

function createFillRunId() {
  return `fill_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isFillRunCancelled(fillRunId) {
  return Boolean(fillRunId && activeFillRuns.get(fillRunId)?.cancelled);
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
  return true;
}

function compactApplyContextForLog(context = {}) {
  return {
    ...context,
    selectedResumeDataUrl: context.selectedResumeDataUrl
      ? "[omitted:data-url]"
      : "",
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
  const activity = await appendActivityLog({
    action,
    summary,
    details,
    status,
  });
  await sendDebugLog("activity", { activity });
  return activity;
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
  await logUiEvent(
    sent ? action : failedAction || `${action}_failed`,
    sent
      ? summary
      : failedSummary ||
          `Could not ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
    { tabId, ...details, error: errorMessage },
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

function emailVerificationBridgeUrl() {
  return "http://127.0.0.1:8765/verify-email";
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

async function awaitEmailVerification(payload = {}, sender = {}) {
  const tabId = payload.tabId || sender.tab?.id;
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
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
  await showFillProgress(tabId, "Waiting for verification email");
  await logActivity(
    "email_verification.wait",
    "Waiting for verification email.",
    {
      tabId,
      email,
      expectedDomains,
      signupStartedAt,
      bridgeUrl: emailVerificationBridgeUrl(),
    },
  );
  try {
    const response = await fetch(emailVerificationBridgeUrl(), {
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
      }),
    });
    const result = await response.json().catch(() => ({
      ok: false,
      reason: "bad_bridge_response",
    }));
    if (!response.ok || !result.ok || !result.link) {
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
    await chrome.tabs.update(tabId, { url: result.link, active: true });
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
      { tabId, bridgeUrl: emailVerificationBridgeUrl() },
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

async function dismissPageTransientUi(tabId) {
  await sendPageUiMessage({
    tabId,
    message: {
      type: "hunt.apply.dismiss_transient_ui",
    },
    action: "ui.transient.dismiss_requested",
    failedAction: "ui.transient.dismiss_request_failed",
    summary: "Requested transient UI dismissal.",
    failedSummary: "Could not dismiss transient UI.",
    skippedAction: "ui.transient.dismiss_skipped",
    skippedSummary:
      "Skipped transient UI dismissal because no tab was available.",
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

async function clickSafeNextForTab(tabId, details = {}) {
  const probe = await probeSafeNextForTab(tabId);
  if (!probe.available) {
    await logActivity(
      "next.blocked",
      summarizeSafeNextResult(probe),
      {
        tabId,
        reason: probe.reason,
        triggeredBy: details.triggeredBy || "",
        blockedFinalSubmitLabels: probe.blockedFinalSubmitLabels || [],
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
    await new Promise((resolve) => setTimeout(resolve, 1800));
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

async function clearCurrentPage(tabId) {
  if (!tabId) {
    return {
      ok: false,
      reason: "missing_tab",
      message: "No active tab is available to clear.",
    };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async () => {
      function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      function isVisibleEnabled(el) {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          !el.disabled &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      const clearTrace = [];
      const clearTraceLimit = 1000;
      let clearTraceTruncated = false;

      function elementSummary(el) {
        if (!el?.getBoundingClientRect) {
          return {
            tagName: "",
            type: "",
            id: "",
            name: "",
            text: "",
            ariaLabel: "",
            rect: { top: 0, left: 0, width: 0, height: 0 },
          };
        }
        const rect = el.getBoundingClientRect();
        return {
          tagName: el.tagName || "",
          type: el.type || "",
          id: el.id || "",
          name: el.name || "",
          text: normalizeText(el.innerText || el.textContent || "").slice(
            0,
            160,
          ),
          ariaLabel: normalizeText(el.getAttribute?.("aria-label") || "").slice(
            0,
            160,
          ),
          rect: {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }

      function traceClear(action, el, detail = {}) {
        if (clearTrace.length >= clearTraceLimit) {
          clearTraceTruncated = true;
          return;
        }
        clearTrace.push({
          index: clearTrace.length + 1,
          action,
          target: elementSummary(el),
          ...detail,
        });
      }

      function dispatch(el) {
        scrollToClearingTarget(el);
        traceClear("clear_dispatch", el);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }

      function scrollToClearingTarget(el) {
        if (!el || typeof el.scrollIntoView !== "function") {
          return;
        }
        try {
          el.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "nearest",
          });
        } catch (_error) {
          el.scrollIntoView();
        }
      }

      function setNativeValue(el, value) {
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : el instanceof HTMLSelectElement
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor?.set) {
          descriptor.set.call(el, value);
        } else {
          el.value = value;
        }
      }

      function setNativeChecked(el, checked) {
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "checked",
        );
        if (descriptor?.set) {
          descriptor.set.call(el, checked);
        } else {
          el.checked = checked;
        }
      }

      function realisticClick(el) {
        if (!el || typeof el.dispatchEvent !== "function") {
          return;
        }
        scrollToClearingTarget(el);
        traceClear("clear_click", el);
        if (typeof el.focus === "function" && isVisibleEnabled(el)) {
          try {
            el.focus({ preventScroll: true });
          } catch (_error) {
            el.focus();
          }
        }
        [
          "mouseover",
          "mousemove",
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ].forEach((type) => {
          const event =
            type.startsWith("pointer") && typeof PointerEvent !== "undefined"
              ? new PointerEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  pointerType: "mouse",
                  isPrimary: true,
                  view: window,
                })
              : new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                });
          el.dispatchEvent(event);
        });
      }

      const clickedClearControls = new WeakSet();

      function clickClearControl(el) {
        if (!el || clickedClearControls.has(el)) {
          return false;
        }
        clickedClearControls.add(el);
        realisticClick(el);
        return true;
      }

      function clearDatasetSelection(el) {
        let changed = false;
        ["selected", "selectedValue", "value"].forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(el.dataset || {}, key)) {
            delete el.dataset[key];
            traceClear("clear_dataset_value", el, { key });
            changed = true;
          }
        });
        return changed;
      }

      function keyOn(target, keyName) {
        if (!target || typeof target.dispatchEvent !== "function") {
          return;
        }
        traceClear("clear_key", target, { key: keyName });
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key: keyName, bubbles: true }),
        );
        target.dispatchEvent(
          new KeyboardEvent("keyup", { key: keyName, bubbles: true }),
        );
      }

      function clickOutsideDropdowns() {
        const target = document.body || document.documentElement;
        if (!target) {
          return;
        }
        ["pointerdown", "mousedown", "mouseup", "click"].forEach((type) => {
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
          );
        });
      }

      function hasMenuOpenClass(el) {
        return Array.from(el?.classList || []).some(
          (className) =>
            className === "open" ||
            className === "is-open" ||
            className === "select__menu--is-open" ||
            className === "select__control--menu-is-open" ||
            className.includes("menu-is-open"),
        );
      }

      function removeMenuOpenClasses(el) {
        if (!el?.classList) {
          return;
        }
        el.classList.remove(
          "open",
          "is-open",
          "select__menu--is-open",
          "select__control--menu-is-open",
        );
        Array.from(el.classList).forEach((className) => {
          if (className.includes("menu-is-open")) {
            el.classList.remove(className);
          }
        });
      }

      function closeOpenDropdowns() {
        let closed = 0;
        const targets = new Set();
        [
          '[aria-expanded="true"]',
          '[role="combobox"]',
          '[aria-autocomplete="list"]',
          '[aria-haspopup="listbox"]',
          '[role="listbox"]',
          "[id^='react-select-'][id*='-listbox']",
          "[class*='menu-is-open']",
          ".select__control--menu-is-open",
          ".select__container",
          ".select__control",
          ".select__menu",
          ".select__menu-list",
          ".select-shell",
          ".custom-select",
        ].forEach((selector) => {
          document.querySelectorAll(selector).forEach((el) => targets.add(el));
        });

        traceClear("dropdown_close_start", document.activeElement, {
          openMenuCount: targets.size,
        });
        targets.forEach((el) => {
          const beforeExpanded = el.getAttribute("aria-expanded") === "true";
          const beforeOpenClass = hasMenuOpenClass(el);
          traceClear("dropdown_close_attempt", el, {
            beforeExpanded,
            beforeOpenClass,
          });
          if (typeof el.focus === "function" && isVisibleEnabled(el)) {
            try {
              el.focus({ preventScroll: true });
            } catch (_error) {
              el.focus();
            }
          }
          keyOn(el, "Escape");
          const field = el.closest?.(
            ".select__container, .select-shell, .custom-select, .application-field, [role='group']",
          );
          if (field && field !== el) {
            keyOn(field, "Escape");
          }
          if (el.hasAttribute?.("aria-expanded")) {
            el.setAttribute("aria-expanded", "false");
          }
          removeMenuOpenClasses(el);
          removeMenuOpenClasses(field);
          field
            ?.querySelectorAll?.("[class*='menu-is-open']")
            .forEach(removeMenuOpenClasses);
          if (typeof el.blur === "function") {
            el.blur();
          }
          if (beforeExpanded || beforeOpenClass) {
            closed += 1;
          }
        });

        keyOn(document.activeElement, "Escape");
        keyOn(document.body, "Escape");
        keyOn(document, "Escape");
        keyOn(window, "Escape");
        clickOutsideDropdowns();
        if (document.activeElement?.blur) {
          document.activeElement.blur();
        }
        traceClear("dropdown_close_end", document.activeElement, {
          closedDropdowns: closed,
        });
        return closed;
      }

      function countOpenDropdowns() {
        return Array.from(
          document.querySelectorAll(
            [
              '[aria-expanded="true"]',
              '[role="listbox"]',
              "[id^='react-select-'][id*='-listbox']",
              "[class*='menu-is-open']",
              ".select__control--menu-is-open",
              ".select__menu",
              ".select__menu-list",
            ].join(", "),
          ),
        ).filter(isVisibleEnabled).length;
      }

      function hideTransientDropdownMenus() {
        let hidden = 0;
        Array.from(
          document.querySelectorAll(
            [
              '[aria-expanded="true"]',
              '[role="combobox"][aria-expanded]',
              '[aria-autocomplete="list"][aria-expanded]',
            ].join(", "),
          ),
        ).forEach((el) => {
          if (el.getAttribute("aria-expanded") === "true") {
            hidden += 1;
          }
          el.setAttribute("aria-expanded", "false");
          keyOn(el, "Escape");
          if (typeof el.blur === "function") {
            el.blur();
          }
        });

        Array.from(
          document.querySelectorAll(
            [
              ".select__menu",
              ".select__menu-list",
              "[id^='react-select-'][id*='-listbox']",
              "[role='listbox']",
            ].join(", "),
          ),
        ).forEach((menu) => {
          const wasAlreadyHidden =
            menu.hidden ||
            menu.getAttribute("aria-hidden") === "true" ||
            menu.style.display === "none" ||
            menu.style.visibility === "hidden";
          if (!wasAlreadyHidden) {
            hidden += 1;
          }
          menu.setAttribute("aria-hidden", "true");
          menu.hidden = true;
          menu.style.display = "none";
          menu.style.visibility = "hidden";
          menu.style.pointerEvents = "none";
          if (
            menu.classList?.contains("select__menu") ||
            menu.classList?.contains("select__menu-list") ||
            String(menu.id || "").startsWith("react-select-")
          ) {
            menu.remove();
          }
        });
        Array.from(
          document.querySelectorAll("[class*='menu-is-open']"),
        ).forEach(removeMenuOpenClasses);
        clickOutsideDropdowns();
        return hidden;
      }

      function countRemainingFilledControls() {
        let remaining = 0;
        Array.from(document.querySelectorAll("input")).forEach((el) => {
          const type = String(el.type || "text").toLowerCase();
          if (["button", "hidden", "image", "reset", "submit"].includes(type)) {
            return;
          }
          if (!isVisibleEnabled(el) && type !== "file") {
            return;
          }
          if (["checkbox", "radio"].includes(type)) {
            if (el.checked) {
              remaining += 1;
            }
            return;
          }
          if (type !== "file" && el.value) {
            remaining += 1;
          }
        });
        Array.from(document.querySelectorAll("textarea"))
          .filter(isVisibleEnabled)
          .forEach((el) => {
            if (el.value) {
              remaining += 1;
            }
          });
        Array.from(document.querySelectorAll("select"))
          .filter(isVisibleEnabled)
          .forEach((el) => {
            const selectedOptions = Array.from(el.options || []).filter(
              (option) => option.selected,
            );
            if (
              el.multiple
                ? selectedOptions.some((option) => option.value)
                : Boolean(el.value)
            ) {
              remaining += 1;
            }
          });
        Array.from(
          document.querySelectorAll(
            ".select__single-value, .select__multi-value, [class*='singleValue'], [class*='multiValue']",
          ),
        )
          .filter(isVisibleEnabled)
          .forEach((el) => {
            if ((el.textContent || "").trim()) {
              remaining += 1;
            }
          });
        return remaining;
      }

      function controlLabel(el) {
        return [
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.innerText,
          el.textContent,
          el.className?.baseVal || el.className,
          ...Array.from(el.querySelectorAll?.("[aria-label], [title]") || [])
            .map(
              (child) =>
                child.getAttribute?.("aria-label") ||
                child.getAttribute?.("title"),
            )
            .filter(Boolean),
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
          .toLowerCase();
      }

      function isClearControlLabel(label) {
        return (
          label.includes("clear") ||
          label.includes("remove") ||
          label.includes("close") ||
          label === "x" ||
          label === "Ã—" ||
          label === "Ãƒâ€”"
        );
      }

      function isDropdownToggleLabel(label) {
        return (
          label.includes("toggle") ||
          label.includes("dropdown") ||
          label.includes("drop-down") ||
          label.includes("chevron") ||
          label.includes("arrow") ||
          label.includes("menu") ||
          label.includes("indicator-separator") ||
          label.includes("separator")
        );
      }

      function fieldHasSelectedValue(field) {
        if (!field) {
          return false;
        }
        if (
          ["selected", "selectedValue", "value"].some((key) =>
            Boolean(field.dataset?.[key]),
          )
        ) {
          return true;
        }
        return Array.from(
          field.querySelectorAll(
            ".select__single-value, .select__multi-value, [class*='singleValue'], [class*='multiValue']",
          ),
        ).some((el) => (el.textContent || "").trim());
      }

      function clickSelectClearIndicators(field) {
        const indicators = Array.from(
          field.querySelectorAll(
            "[data-testid='clear-selection'], .select__clear-indicator, .select__indicators button, .select__indicators [role='button'], .select__indicators > *, [class*='indicators'] button, [class*='Indicators'] button, [class*='indicators'] [role='button'], [class*='Indicators'] [role='button'], [class*='indicators'] > *, [class*='Indicators'] > *",
          ),
        ).filter(isVisibleEnabled);
        const clickableIndicators = indicators.filter((indicator) => {
          const label = controlLabel(indicator);
          return !label.includes("indicator-separator");
        });
        const toClick = new Set(
          clickableIndicators.filter((indicator) =>
            isClearControlLabel(controlLabel(indicator)),
          ),
        );
        if (toClick.size === 0 && fieldHasSelectedValue(field)) {
          clickableIndicators.slice(0, -1).forEach((indicator) => {
            const label = controlLabel(indicator);
            if (!isDropdownToggleLabel(label)) {
              toClick.add(indicator);
            }
          });
        }
        let clicked = 0;
        toClick.forEach((indicator) => {
          if (clickClearControl(indicator)) {
            clicked += 1;
          }
        });
        return clicked;
      }

      function normalizeText(value) {
        return String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function isPlaceholderText(value) {
        const text = normalizeText(value).toLowerCase();
        return (
          !text ||
          text === "select one" ||
          text === "select..." ||
          text === "select" ||
          text === "none"
        );
      }

      function buttonValueText(button) {
        return normalizeText(
          button.innerText ||
            button.textContent ||
            button.getAttribute("aria-label") ||
            button.getAttribute("value") ||
            "",
        );
      }

      function forceClearWorkdayButton(button) {
        const current = buttonValueText(button);
        button.value = "";
        button.removeAttribute("value");
        if (current) {
          button.setAttribute(
            "aria-label",
            normalizeText(
              (button.getAttribute("aria-label") || current).replace(
                current,
                "Select One",
              ),
            ),
          );
        }
        button.textContent = "Select One";
        dispatch(button);
        return isPlaceholderText(buttonValueText(button));
      }

      function visibleOptions() {
        return Array.from(document.querySelectorAll('[role="option"]')).filter(
          isVisibleEnabled,
        );
      }

      async function selectAlternateWorkdayOptionBeforeForceClear(
        button,
        before,
      ) {
        const normalizedBefore = normalizeText(before).toLowerCase();
        const alternate = visibleOptions().find((option) => {
          const text = normalizeText(option.innerText || option.textContent);
          return (
            text &&
            !isPlaceholderText(text) &&
            text.toLowerCase() !== normalizedBefore &&
            option.getAttribute("aria-disabled") !== "true" &&
            !option.hasAttribute("disabled")
          );
        });
        if (!alternate) {
          traceClear("dropdown_select_failed", button, {
            reason: "no_alternate_option_before_force_clear",
            currentValue: before,
            optionCount: visibleOptions().length,
          });
          return false;
        }
        traceClear("dropdown_select_attempt", alternate, {
          reason: "select_alternate_before_force_clear",
          currentValue: before,
          optionText: normalizeText(
            alternate.innerText || alternate.textContent || "",
          ).slice(0, 160),
        });
        realisticClick(alternate);
        if (typeof alternate.click === "function") {
          alternate.click();
        }
        await sleep(160);
        dispatch(button);
        return true;
      }

      async function clearWorkdayButtonDropdowns() {
        let clearedButtons = 0;
        const buttons = Array.from(
          document.querySelectorAll('button[aria-haspopup="listbox"]'),
        ).filter(isVisibleEnabled);
        for (const button of buttons) {
          const before = buttonValueText(button);
          if (isPlaceholderText(before)) {
            continue;
          }
          traceClear("dropdown_open_attempt", button, {
            reason: "clear_workday_button_dropdown",
            currentValue: before,
          });
          realisticClick(button);
          await sleep(120);
          const placeholder = visibleOptions().find((option) =>
            isPlaceholderText(option.innerText || option.textContent || ""),
          );
          const placeholderDisabled =
            !placeholder ||
            placeholder.getAttribute("aria-disabled") === "true" ||
            placeholder.hasAttribute("disabled");
          if (!placeholder || placeholderDisabled) {
            traceClear("dropdown_select_failed", button, {
              reason: "placeholder_not_available_for_clear",
              currentValue: before,
              optionCount: visibleOptions().length,
            });
            await selectAlternateWorkdayOptionBeforeForceClear(button, before);
            if (forceClearWorkdayButton(button)) {
              traceClear("dropdown_force_clear", button, {
                reason: "workday_button_force_clear",
                currentValue: before,
              });
              clearedButtons += 1;
            }
            keyOn(button, "Escape");
            continue;
          }
          traceClear("dropdown_select_attempt", placeholder, {
            reason: "select_placeholder_to_clear",
            currentValue: before,
            optionText: normalizeText(
              placeholder.innerText || placeholder.textContent || "",
            ).slice(0, 160),
          });
          realisticClick(placeholder);
          if (typeof placeholder.click === "function") {
            placeholder.click();
          }
          await sleep(120);
          dispatch(button);
          keyOn(button, "Escape");
          if (!isPlaceholderText(buttonValueText(button))) {
            await selectAlternateWorkdayOptionBeforeForceClear(button, before);
          }
          if (
            isPlaceholderText(buttonValueText(button)) ||
            forceClearWorkdayButton(button)
          ) {
            traceClear("dropdown_clear_success", button, {
              reason: "workday_button_cleared",
              previousValue: before,
              currentValue: buttonValueText(button),
            });
            clearedButtons += 1;
          }
        }
        return clearedButtons;
      }

      function workdayMultiselectContainers() {
        const containers = new Set();
        document
          .querySelectorAll(
            [
              '[data-automation-id="multiSelectContainer"]',
              '[data-automation-id="multiselectInputContainer"]',
              '[data-uxi-widget-type="multiselect"]',
              "[data-uxi-multiselect-id]",
            ].join(", "),
          )
          .forEach((el) => {
            const id = el.getAttribute("data-uxi-multiselect-id");
            const root = id ? document.getElementById(id) : null;
            containers.add(
              root ||
                el.closest(
                  [
                    '[data-automation-id="multiSelectContainer"]',
                    '[data-automation-id="multiselectInputContainer"]',
                    '[data-uxi-widget-type="multiselect"]',
                    '[data-automation-id="formField"]',
                  ].join(", "),
                ) ||
                el,
            );
          });
        return Array.from(containers).filter(Boolean);
      }

      function containerHasWorkdaySelection(container) {
        return Array.from(
          container.querySelectorAll(
            [
              '[data-automation-id="selectedItem"]',
              '[role="option"][aria-selected="true"]',
              '[id^="pill-"]',
              '[aria-label*="press delete to clear value"]',
            ].join(", "),
          ),
        ).some((el) =>
          normalizeText(
            el.innerText || el.textContent || el.getAttribute("aria-label"),
          ),
        );
      }

      function workdaySelectedItems(container) {
        return Array.from(
          container.querySelectorAll(
            [
              '[data-automation-id="selectedItem"]',
              '[id^="pill-"][aria-label*="press delete to clear value"]',
            ].join(", "),
          ),
        ).filter((el) =>
          normalizeText(
            el.innerText || el.textContent || el.getAttribute("aria-label"),
          ),
        );
      }

      async function clearWorkdayMultiselects() {
        let clearedMultiselects = 0;
        for (const container of workdayMultiselectContainers()) {
          if (!containerHasWorkdaySelection(container)) {
            continue;
          }
          traceClear("multiselect_clear_start", container);
          let changed = false;
          for (const selectedItem of workdaySelectedItems(container)) {
            try {
              selectedItem.focus({ preventScroll: true });
            } catch (_error) {
              selectedItem.focus?.();
            }
            traceClear("multiselect_selected_item_clear_attempt", selectedItem);
            keyOn(selectedItem, "Delete");
            keyOn(selectedItem, "Backspace");
            changed = true;
          }
          Array.from(
            container.querySelectorAll(
              'button, [role="button"], [aria-label], [data-automation-id]',
            ),
          )
            .filter(isVisibleEnabled)
            .forEach((candidate) => {
              const label = normalizeText(
                [
                  candidate.getAttribute("aria-label"),
                  candidate.getAttribute("data-automation-id"),
                  candidate.innerText,
                  candidate.textContent,
                ]
                  .filter(Boolean)
                  .join(" "),
              ).toLowerCase();
              if (
                label.includes("remove") ||
                label.includes("delete") ||
                label.includes("clear") ||
                label.includes("press delete to clear value")
              ) {
                if (clickClearControl(candidate)) {
                  traceClear("multiselect_clear_control_clicked", candidate, {
                    label,
                  });
                  changed = true;
                }
              }
            });
          const input =
            container.querySelector("input:not([type='hidden'])") ||
            container.querySelector("[role='combobox']");
          if (input) {
            try {
              input.focus({ preventScroll: true });
            } catch (_error) {
              input.focus?.();
            }
            keyOn(input, "Backspace");
            keyOn(input, "Delete");
            traceClear("multiselect_input_clear", input);
            setNativeValue(input, "");
            dispatch(input);
            changed = true;
          }
          await sleep(100);
          if (changed && !containerHasWorkdaySelection(container)) {
            traceClear("multiselect_clear_success", container);
            clearedMultiselects += 1;
          }
        }
        return clearedMultiselects;
      }

      function containsUploadText(text) {
        const normalized = normalizeText(text).toLowerCase();
        return (
          normalized.includes("upload") ||
          normalized.includes("drop files") ||
          normalized.includes("select files") ||
          normalized.includes("application documents") ||
          normalized.includes("resume") ||
          normalized.includes("cv") ||
          normalized.includes("cover letter") ||
          normalized.includes("successfully uploaded")
        );
      }

      function containsUploadedFileText(text) {
        const normalized = normalizeText(text).toLowerCase();
        return (
          normalized.includes("successfully uploaded") ||
          normalized.includes(".pdf") ||
          normalized.includes(".doc") ||
          normalized.includes(".docx") ||
          normalized.includes(".rtf") ||
          normalized.includes(".txt")
        );
      }

      function nearestHeadingText(el) {
        const rect = el?.getBoundingClientRect?.();
        if (!rect) {
          return "";
        }
        return (
          Array.from(
            document.querySelectorAll(
              "h1, h2, h3, h4, h5, h6, [role='heading']",
            ),
          )
            .filter(isVisibleEnabled)
            .map((heading) => ({
              heading,
              text: normalizeText(
                heading.innerText || heading.textContent || "",
              ),
              rect: heading.getBoundingClientRect(),
            }))
            .filter((item) => item.text && item.rect.top <= rect.top + 8)
            .sort((a, b) => b.rect.top - a.rect.top)[0]?.text || ""
        );
      }

      function nearestUploadedFileText(el) {
        const rect = el?.getBoundingClientRect?.();
        if (!rect) {
          return "";
        }
        return (
          Array.from(document.querySelectorAll("body *"))
            .filter(isVisibleEnabled)
            .map((node) => ({
              node,
              text: normalizeText(node.innerText || node.textContent || ""),
              rect: node.getBoundingClientRect(),
            }))
            .filter((item) => {
              if (!containsUploadedFileText(item.text)) {
                return false;
              }
              const verticalDistance = Math.abs(
                item.rect.top +
                  item.rect.height / 2 -
                  (rect.top + rect.height / 2),
              );
              const horizontalDistance =
                item.rect.left > rect.right
                  ? item.rect.left - rect.right
                  : rect.left > item.rect.right
                    ? rect.left - item.rect.right
                    : 0;
              return verticalDistance <= 160 && horizontalDistance <= 1200;
            })
            .sort((a, b) => {
              const aDistance = Math.abs(a.rect.top - rect.top);
              const bDistance = Math.abs(b.rect.top - rect.top);
              return aDistance - bDistance;
            })[0]?.text || ""
        );
      }

      function uploadedFileContextFor(el) {
        const parts = [
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("title"),
          el.getAttribute?.("data-automation-id"),
          el.innerText,
          el.textContent,
          nearestHeadingText(el),
          nearestUploadedFileText(el),
        ];
        let node = el;
        let depth = 0;
        while (node && node !== document.body && depth < 8) {
          const nodeText = normalizeText(
            node.innerText || node.textContent || "",
          );
          if (nodeText.length <= 1500 || containsUploadedFileText(nodeText)) {
            parts.push(nodeText);
          }
          parts.push(node.className);
          node = node.parentElement;
          depth += 1;
        }
        return normalizeText(parts.filter(Boolean).join(" "));
      }

      function isUploadedFileDeleteControl(el) {
        const label = normalizeText(
          [
            el.getAttribute?.("aria-label"),
            el.getAttribute?.("title"),
            el.getAttribute?.("data-automation-id"),
            el.innerText,
            el.textContent,
            el.className?.baseVal || el.className,
            ...Array.from(el.querySelectorAll?.("[aria-label], [title]") || [])
              .map(
                (child) =>
                  child.getAttribute?.("aria-label") ||
                  child.getAttribute?.("title"),
              )
              .filter(Boolean),
          ]
            .filter(Boolean)
            .join(" "),
        ).toLowerCase();
        const iconLikeDelete =
          label.includes("trash") ||
          label.includes("delete") ||
          label.includes("remove") ||
          label.includes("clear") ||
          el.querySelector?.("svg, [data-icon*='trash'], [class*='trash']");
        if (!iconLikeDelete) {
          return false;
        }
        const context = uploadedFileContextFor(el);
        const heading = nearestHeadingText(el).toLowerCase();
        if (
          (heading.includes("work experience") ||
            heading.includes("education")) &&
          !containsUploadText(heading)
        ) {
          return false;
        }
        return containsUploadText(context) && containsUploadedFileText(context);
      }

      async function clickVisibleUploadConfirmButton() {
        const dialog = Array.from(
          document.querySelectorAll(
            [
              "[role='dialog']",
              "[aria-modal='true']",
              "[data-automation-id*='modal']",
              "[data-automation-id*='popup']",
              ".modal",
            ].join(", "),
          ),
        ).find(isVisibleEnabled);
        if (!dialog) {
          return false;
        }
        const confirm = Array.from(
          dialog.querySelectorAll('button, [role="button"]'),
        )
          .filter(isVisibleEnabled)
          .find((button) => {
            const text = normalizeText(
              [
                button.getAttribute?.("aria-label"),
                button.getAttribute?.("title"),
                button.innerText,
                button.textContent,
              ]
                .filter(Boolean)
                .join(" "),
            ).toLowerCase();
            return (
              text === "delete" ||
              text === "remove" ||
              text === "yes" ||
              text === "ok" ||
              text === "confirm"
            );
          });
        if (!confirm) {
          return false;
        }
        traceClear("uploaded_file_confirm_clicked", confirm, {
          label: controlLabel(confirm),
        });
        realisticClick(confirm);
        if (typeof confirm.click === "function") {
          confirm.click();
        }
        await sleep(180);
        return true;
      }

      async function clearUploadedFileControls() {
        let clearedFiles = 0;
        const candidates = Array.from(
          document.querySelectorAll(
            [
              "button",
              "[role='button']",
              "a[aria-label]",
              "[data-automation-id*='delete']",
              "[data-automation-id*='remove']",
              "[class*='delete']",
              "[class*='remove']",
              "[class*='trash']",
            ].join(", "),
          ),
        )
          .filter(isVisibleEnabled)
          .filter(isUploadedFileDeleteControl);

        traceClear("uploaded_file_clear_scan", document.body, {
          candidateCount: candidates.length,
        });

        for (const candidate of candidates) {
          const beforeUploadedText = nearestUploadedFileText(candidate);
          if (!beforeUploadedText) {
            continue;
          }
          traceClear("uploaded_file_delete_attempt", candidate, {
            label: controlLabel(candidate),
            nearby: beforeUploadedText.slice(0, 240),
          });
          if (!clickClearControl(candidate)) {
            continue;
          }
          if (typeof candidate.click === "function") {
            candidate.click();
          }
          await sleep(240);
          await clickVisibleUploadConfirmButton();
          await sleep(360);
          const afterUploadedText = nearestUploadedFileText(candidate);
          if (!afterUploadedText || afterUploadedText !== beforeUploadedText) {
            traceClear("uploaded_file_delete_success", candidate, {
              previousValue: beforeUploadedText.slice(0, 240),
              currentValue: afterUploadedText.slice(0, 240),
            });
            clearedFiles += 1;
          } else {
            traceClear("uploaded_file_delete_pending", candidate, {
              previousValue: beforeUploadedText.slice(0, 240),
              currentValue: afterUploadedText.slice(0, 240),
            });
          }
        }
        return clearedFiles;
      }

      function countRemainingWorkdayButtonValues() {
        return Array.from(
          document.querySelectorAll('button[aria-haspopup="listbox"]'),
        )
          .filter(isVisibleEnabled)
          .filter((button) => !isPlaceholderText(buttonValueText(button)))
          .length;
      }

      function countRemainingWorkdayMultiselectValues() {
        return workdayMultiselectContainers().filter(
          containerHasWorkdaySelection,
        ).length;
      }

      let cleared = 0;
      let clearIndicatorClicks = 0;
      const openDropdownsBefore = countOpenDropdowns();
      const preClosedDropdowns = closeOpenDropdowns();
      await sleep(80);
      const inputs = Array.from(document.querySelectorAll("input")).filter(
        (el) => !el.disabled,
      );

      inputs.forEach((el) => {
        const type = String(el.type || "text").toLowerCase();
        if (["button", "hidden", "image", "reset", "submit"].includes(type)) {
          return;
        }
        if (type === "file") {
          if (el.files?.length) {
            traceClear("field_clear", el, {
              fieldType: "file",
              previousValue: String(el.files.length),
            });
            setNativeValue(el, "");
            dispatch(el);
            cleared += 1;
          }
          return;
        }
        if (!isVisibleEnabled(el)) {
          return;
        }
        if (["checkbox", "radio"].includes(type)) {
          if (el.checked) {
            traceClear("field_clear", el, {
              fieldType: type,
              previousValue: "checked",
            });
            setNativeChecked(el, false);
            dispatch(el);
            cleared += 1;
          }
          return;
        }
        if (el.value) {
          traceClear("field_clear", el, {
            fieldType: type,
            previousValue: el.value,
          });
          setNativeValue(el, "");
          dispatch(el);
          cleared += 1;
        }
      });

      Array.from(
        document.querySelectorAll(
          '[role="combobox"], [aria-autocomplete="list"], .select__container input, [class*="select"] input',
        ),
      )
        .filter(isVisibleEnabled)
        .forEach((el) => {
          let changed = false;
          if (el.value) {
            traceClear("field_clear", el, {
              fieldType: "combobox",
              previousValue: el.value,
            });
            setNativeValue(el, "");
            changed = true;
          }
          [
            "aria-activedescendant",
            "aria-controls",
            "data-selected",
            "data-value",
          ].forEach((attr) => {
            if (el.hasAttribute(attr)) {
              el.removeAttribute(attr);
              changed = true;
            }
          });
          const field = el.closest(
            ".select__container, .select-shell, .custom-select, .application-field, [role='group']",
          );
          if (field && clearDatasetSelection(field)) {
            changed = true;
          }
          if (field) {
            const indicatorClicks = clickSelectClearIndicators(field);
            if (indicatorClicks > 0) {
              traceClear("clear_indicator_clicked", field, {
                clickCount: indicatorClicks,
              });
              clearIndicatorClicks += indicatorClicks;
              changed = true;
            }
            Array.from(
              field.querySelectorAll(
                ".select__indicators button, .select__indicators [role='button']",
              ),
            )
              .filter(isVisibleEnabled)
              .forEach((button, index, buttons) => {
                const label = [
                  button.getAttribute("aria-label"),
                  button.getAttribute("title"),
                  button.innerText,
                  button.textContent,
                ]
                  .filter(Boolean)
                  .join(" ")
                  .trim()
                  .toLowerCase();
                const isToggle = label.includes("toggle");
                const isClear =
                  label.includes("clear") ||
                  label.includes("remove") ||
                  label === "x" ||
                  label === "×" ||
                  label === "Ã—";
                if (
                  isClear ||
                  (!isToggle && buttons.length > 1 && index === 0)
                ) {
                  if (clickClearControl(button)) {
                    traceClear("clear_indicator_clicked", button, { label });
                    clearIndicatorClicks += 1;
                  }
                  changed = true;
                }
              });
            Array.from(
              field.querySelectorAll(
                "input[aria-hidden='true'], input[tabindex='-1']",
              ),
            ).forEach((hiddenInput) => {
              if (hiddenInput.value) {
                traceClear("field_clear", hiddenInput, {
                  fieldType: "hidden_select_input",
                  previousValue: hiddenInput.value,
                });
                setNativeValue(hiddenInput, "");
                dispatch(hiddenInput);
                changed = true;
              }
            });
            Array.from(
              field.querySelectorAll(
                ".select__single-value, .select__multi-value, [class*='singleValue'], [class*='multiValue'], [class*='placeholder']",
              ),
            ).forEach((valueEl) => {
              if ((valueEl.textContent || "").trim()) {
                traceClear("field_clear", valueEl, {
                  fieldType: "select_value_label",
                  previousValue: valueEl.textContent || "",
                });
                valueEl.textContent = "";
                changed = true;
              }
            });
            Array.from(
              field.querySelectorAll(
                'button, [role="button"], [aria-label], [class*="clear"], [class*="remove"]',
              ),
            )
              .filter(isVisibleEnabled)
              .forEach((button) => {
                const label = [
                  button.getAttribute("aria-label"),
                  button.getAttribute("title"),
                  button.innerText,
                  button.textContent,
                ]
                  .filter(Boolean)
                  .join(" ")
                  .trim()
                  .toLowerCase();
                if (
                  label.includes("clear") ||
                  label.includes("remove") ||
                  label === "x" ||
                  label === "×" ||
                  label === "Ã—"
                ) {
                  if (clickClearControl(button)) {
                    traceClear("clear_control_clicked", button, { label });
                    clearIndicatorClicks += 1;
                  }
                  changed = true;
                }
              });
          }
          if (changed) {
            dispatch(el);
            cleared += 1;
          }
        });

      Array.from(
        document.querySelectorAll('button, [role="button"], a[aria-label]'),
      )
        .filter(isVisibleEnabled)
        .forEach((el) => {
          const label = [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.innerText,
            el.textContent,
          ]
            .filter(Boolean)
            .join(" ")
            .trim()
            .toLowerCase();
          const nearby = (
            el.closest(
              "li, [class*='file'], [class*='upload'], [class*='attachment'], [class*='resume'], [class*='document'], div",
            )?.innerText || ""
          )
            .trim()
            .toLowerCase();
          const looksLikeRemove =
            label.includes("remove") ||
            label.includes("delete") ||
            label.includes("clear") ||
            label === "x" ||
            label === "×";
          const looksLikeUploadedFile =
            nearby.includes(".pdf") ||
            nearby.includes(".doc") ||
            nearby.includes("uploaded") ||
            nearby.includes("resume") ||
            nearby.includes("cv") ||
            nearby.includes("cover letter");
          if (looksLikeRemove && looksLikeUploadedFile) {
            if (clickClearControl(el)) {
              traceClear("file_remove_control_clicked", el, { label, nearby });
              cleared += 1;
            }
          }
        });

      Array.from(document.querySelectorAll("textarea"))
        .filter(isVisibleEnabled)
        .forEach((el) => {
          if (el.value) {
            traceClear("field_clear", el, {
              fieldType: "textarea",
              previousValue: el.value,
            });
            setNativeValue(el, "");
            dispatch(el);
            cleared += 1;
          }
        });

      Array.from(document.querySelectorAll("select"))
        .filter(isVisibleEnabled)
        .forEach((el) => {
          const hadSelection = Array.from(el.options || []).some(
            (option) => option.selected,
          );
          if (hadSelection) {
            traceClear("field_clear", el, {
              fieldType: "select",
              previousValue: el.value,
            });
          }
          if (el.multiple) {
            Array.from(el.options || []).forEach((option) => {
              option.selected = false;
            });
          } else if (Array.from(el.options || []).some((o) => o.value === "")) {
            setNativeValue(el, "");
          } else {
            el.selectedIndex = -1;
          }
          if (hadSelection) {
            dispatch(el);
            cleared += 1;
          }
        });

      Array.from(
        document.querySelectorAll('[contenteditable="true"], [role="textbox"]'),
      )
        .filter((el) => !["INPUT", "TEXTAREA"].includes(el.tagName))
        .filter(isVisibleEnabled)
        .forEach((el) => {
          if ((el.textContent || "").trim()) {
            traceClear("field_clear", el, {
              fieldType: "contenteditable",
              previousValue: el.textContent || "",
            });
            el.textContent = "";
            dispatch(el);
            cleared += 1;
          }
        });

      let workdayButtonClears = await clearWorkdayButtonDropdowns();
      cleared += workdayButtonClears;
      let workdayMultiselectClears = await clearWorkdayMultiselects();
      cleared += workdayMultiselectClears;
      let uploadedFileClears = await clearUploadedFileControls();
      cleared += uploadedFileClears;

      await sleep(250);
      const stabilizedWorkdayButtonClears = await clearWorkdayButtonDropdowns();
      const stabilizedWorkdayMultiselectClears =
        await clearWorkdayMultiselects();
      const stabilizedUploadedFileClears = await clearUploadedFileControls();
      workdayButtonClears += stabilizedWorkdayButtonClears;
      workdayMultiselectClears += stabilizedWorkdayMultiselectClears;
      uploadedFileClears += stabilizedUploadedFileClears;
      cleared +=
        stabilizedWorkdayButtonClears +
        stabilizedWorkdayMultiselectClears +
        stabilizedUploadedFileClears;

      await sleep(400);
      const lateWorkdayMultiselectClears = await clearWorkdayMultiselects();
      const lateUploadedFileClears = await clearUploadedFileControls();
      workdayMultiselectClears += lateWorkdayMultiselectClears;
      uploadedFileClears += lateUploadedFileClears;
      cleared += lateWorkdayMultiselectClears + lateUploadedFileClears;

      await sleep(150);
      const closedDropdowns = preClosedDropdowns + closeOpenDropdowns();
      await sleep(60);
      const finalClosedDropdowns = closeOpenDropdowns();
      await sleep(40);
      const hiddenDropdownMenus = hideTransientDropdownMenus();
      await sleep(40);
      const remainingOpenDropdowns = countOpenDropdowns();
      const remainingFilledControls =
        countRemainingFilledControls() +
        countRemainingWorkdayButtonValues() +
        countRemainingWorkdayMultiselectValues();

      return {
        cleared,
        closedDropdowns: closedDropdowns + finalClosedDropdowns,
        hiddenDropdownMenus,
        openDropdownsBefore,
        remainingOpenDropdowns,
        remainingFilledControls,
        clearIndicatorClicks,
        workdayButtonClears,
        workdayMultiselectClears,
        uploadedFileClears,
        clearTrace,
        clearTraceLimit,
        clearTraceTruncated,
      };
    },
  });

  const cleared = results.reduce(
    (total, result) => total + Number(result.result?.cleared || 0),
    0,
  );
  const closedDropdowns = results.reduce(
    (total, result) => total + Number(result.result?.closedDropdowns || 0),
    0,
  );
  const hiddenDropdownMenus = results.reduce(
    (total, result) => total + Number(result.result?.hiddenDropdownMenus || 0),
    0,
  );
  const openDropdownsBefore = results.reduce(
    (total, result) => total + Number(result.result?.openDropdownsBefore || 0),
    0,
  );
  const remainingOpenDropdowns = results.reduce(
    (total, result) =>
      total + Number(result.result?.remainingOpenDropdowns || 0),
    0,
  );
  const remainingFilledControls = results.reduce(
    (total, result) =>
      total + Number(result.result?.remainingFilledControls || 0),
    0,
  );
  const clearIndicatorClicks = results.reduce(
    (total, result) => total + Number(result.result?.clearIndicatorClicks || 0),
    0,
  );
  const workdayButtonClears = results.reduce(
    (total, result) => total + Number(result.result?.workdayButtonClears || 0),
    0,
  );
  const workdayMultiselectClears = results.reduce(
    (total, result) =>
      total + Number(result.result?.workdayMultiselectClears || 0),
    0,
  );
  const uploadedFileClears = results.reduce(
    (total, result) => total + Number(result.result?.uploadedFileClears || 0),
    0,
  );
  const clearTrace = results
    .flatMap((result) => result.result?.clearTrace || [])
    .slice(0, 1000);
  const clearTraceTruncated =
    clearTrace.length >= 1000 ||
    results.some((result) => result.result?.clearTraceTruncated);
  const needsReview = remainingOpenDropdowns > 0 || remainingFilledControls > 0;
  await logActivity(
    "page.clear",
    needsReview
      ? "Current page clear needs review."
      : "Current page fields cleared.",
    {
      tabId,
      cleared,
      closedDropdowns,
      hiddenDropdownMenus,
      openDropdownsBefore,
      remainingOpenDropdowns,
      remainingFilledControls,
      clearIndicatorClicks,
      workdayButtonClears,
      workdayMultiselectClears,
      uploadedFileClears,
      clearTrace,
      clearTraceTruncated,
      frameCount: results.length,
    },
    needsReview ? "warn" : "ok",
  );
  await hideFillProgress(tabId);
  await showPageToast(
    tabId,
    needsReview
      ? `Cleared ${cleared} field${cleared === 1 ? "" : "s"}, but ${remainingOpenDropdowns} dropdown${remainingOpenDropdowns === 1 ? "" : "s"} and ${remainingFilledControls} control${remainingFilledControls === 1 ? "" : "s"} may still need review.`
      : `Cleared ${cleared} field${cleared === 1 ? "" : "s"} and closed ${closedDropdowns} dropdown${closedDropdowns === 1 ? "" : "s"}.`,
    needsReview ? "warn" : "info",
  );
  return {
    ok: !needsReview,
    reason: needsReview ? "clear_needs_review" : "",
    cleared,
    closedDropdowns,
    hiddenDropdownMenus,
    openDropdownsBefore,
    remainingOpenDropdowns,
    remainingFilledControls,
    clearIndicatorClicks,
    workdayButtonClears,
    workdayMultiselectClears,
    uploadedFileClears,
    clearTrace,
    clearTraceTruncated,
    frameCount: results.length,
    message: needsReview
      ? `Cleared ${cleared} field${cleared === 1 ? "" : "s"}, but ${remainingOpenDropdowns} dropdown${remainingOpenDropdowns === 1 ? "" : "s"} and ${remainingFilledControls} control${remainingFilledControls === 1 ? "" : "s"} may still need review.`
      : `Cleared ${cleared} field${cleared === 1 ? "" : "s"} and closed ${closedDropdowns} dropdown${closedDropdowns === 1 ? "" : "s"} on the current page.`,
  };
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
        window.__huntApplyCancelAllFills = isCancelled;
        if (runId && isCancelled) {
          window.__huntApplyCancelFillRunId = runId;
        } else if (!isCancelled) {
          window.__huntApplyCancelFillRunId = "";
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

async function runFillWithOneRefreshRetry(
  tabId,
  state,
  triggeredBy,
  fillRunId,
) {
  let result = await withTimeout(
    runFillForTab(tabId, state, {
      fillRunId,
      isCancelled: () => isFillRunCancelled(fillRunId),
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
    return fillCancelledResponse(state);
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
      manualReviewReasons:
        result.attempt?.manualReviewReasons ||
        result.result?.manualReviewReasons ||
        [],
      maxRefreshRetries: 1,
    },
    "warn",
  );
  await showFillProgress(tabId, "Refreshing page before retry", fillRunId);
  if (isFillRunCancelled(fillRunId)) {
    return fillCancelledResponse(state);
  }
  await chrome.tabs.reload(tabId);
  const reloadResult = await waitForTabReloadComplete(tabId);
  if (!reloadResult.ok) {
    result.refreshRetry = {
      attempted: true,
      ok: false,
      reason: reloadResult.reason || "reload_failed",
      maxRefreshRetries: 1,
    };
    return result;
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await dismissPageTransientUi(tabId);
  await showFillProgress(tabId, "Retrying fill after refresh", fillRunId);
  const retryResult = await withTimeout(
    runFillForTab(tabId, state, {
      fillRunId,
      isCancelled: () => isFillRunCancelled(fillRunId),
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
    return fillCancelledResponse(state);
  }
  retryResult.refreshRetry = {
    attempted: true,
    ok: true,
    reason: "commit_not_verified",
    maxRefreshRetries: 1,
    previousMessage: result.message || "",
    previousManualReviewReasons:
      result.attempt?.manualReviewReasons ||
      result.result?.manualReviewReasons ||
      [],
  };
  return retryResult;
}

async function handleMessage(message, sender = {}) {
  switch (message?.type) {
    case "hunt.apply.ping":
      return { ok: true, source: "background" };

    case "hunt.apply.get_state":
      return { ok: true, ...(await getExtensionState()) };

    case "hunt.apply.cancel_fill": {
      const fillRunId = message.payload?.fillRunId || "";
      const tabId = message.payload?.tabId || sender.tab?.id;
      const cancelled = cancelFillRun(fillRunId);
      await markPageFillCancelled(tabId, fillRunId);
      await logActivity(
        cancelled ? "fill.cancel_requested" : "fill.cancel_missing",
        cancelled
          ? "Requested cancellation for the current fill."
          : "Tried to cancel fill, but no active fill run matched.",
        { fillRunId, tabId },
        cancelled ? "warn" : "blocked",
      );
      await showFillProgress(tabId, "Canceling fill", fillRunId);
      return { ok: cancelled, cancelled, fillRunId };
    }

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
      let result;
      const fillRunId = createFillRunId();
      activeFillRuns.set(fillRunId, {
        tabId,
        triggeredBy: message.payload?.triggeredBy || "fill_current_page",
        startedAt: new Date().toISOString(),
        cancelled: false,
      });
      await dismissPageTransientUi(tabId);
      await markPageFillCancelled(tabId, fillRunId, false);
      await showFillProgress(tabId, "Filling page", fillRunId);
      try {
        result = await runFillWithOneRefreshRetry(
          tabId,
          state,
          message.payload?.triggeredBy || "fill_current_page",
          fillRunId,
        );
      } finally {
        activeFillRuns.delete(fillRunId);
        await hideFillProgress(tabId);
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
        result.nextAction = await maybeHandleSafeNextAfterFill({
          tabId,
          fillResponse: result,
          settings: state.settings,
          triggeredBy: message.payload?.triggeredBy || "fill_current_page",
        });
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
  await refreshPollingAlarms(state.settings);
  console.log("Hunt Apply extension installed.");
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await ensureStageOneState();
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
