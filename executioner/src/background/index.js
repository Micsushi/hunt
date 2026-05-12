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

const C4_POLL_ALARM = "hunt.apply.c4.poll";
const C4_HEARTBEAT_ALARM = "hunt.apply.c4.heartbeat";
let activeRunId = "";

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
      activeApplyContext: state.activeApplyContext,
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
  if (!tabId) {
    return;
  }
  try {
    await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "hunt.apply.show_toast",
        message,
        tone,
      }),
      2500,
      () => null,
    );
  } catch (_error) {
    // Some pages cannot receive content-script messages.
  }
}

async function showFillProgress(tabId, message = "Filling page") {
  if (!tabId) {
    return;
  }
  try {
    await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "hunt.apply.show_fill_progress",
        message,
      }),
      2500,
      () => null,
    );
  } catch (_error) {
    // Some pages cannot receive content-script messages.
  }
}

async function hideFillProgress(tabId) {
  if (!tabId) {
    return;
  }
  try {
    await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "hunt.apply.hide_fill_progress",
      }),
      2500,
      () => null,
    );
  } catch (_error) {
    // Some pages cannot receive content-script messages.
  }
}

async function dismissPageTransientUi(tabId) {
  if (!tabId) {
    return;
  }
  try {
    await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "hunt.apply.dismiss_transient_ui",
      }),
      2500,
      () => null,
    );
  } catch (_error) {
    // Some pages cannot receive content-script messages.
  }
}

async function showLlmPrompt(tabId, payload = {}) {
  if (!tabId) {
    return;
  }
  let sent = false;
  try {
    await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "hunt.apply.show_llm_prompt",
        ...payload,
      }),
      2500,
      () => null,
    );
    sent = true;
  } catch (_error) {
    // Some pages cannot receive content-script messages.
  }
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

      function dispatch(el) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
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
            changed = true;
          }
        });
        return changed;
      }

      function keyOn(target, keyName) {
        if (!target || typeof target.dispatchEvent !== "function") {
          return;
        }
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

        targets.forEach((el) => {
          const beforeExpanded = el.getAttribute("aria-expanded") === "true";
          const beforeOpenClass = hasMenuOpenClass(el);
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
          realisticClick(button);
          await sleep(220);
          const placeholder = visibleOptions().find((option) =>
            isPlaceholderText(option.innerText || option.textContent || ""),
          );
          const placeholderDisabled =
            !placeholder ||
            placeholder.getAttribute("aria-disabled") === "true" ||
            placeholder.hasAttribute("disabled");
          if (!placeholder || placeholderDisabled) {
            if (forceClearWorkdayButton(button)) {
              clearedButtons += 1;
            }
            keyOn(button, "Escape");
            continue;
          }
          realisticClick(placeholder);
          await sleep(220);
          dispatch(button);
          keyOn(button, "Escape");
          if (
            isPlaceholderText(buttonValueText(button)) ||
            forceClearWorkdayButton(button)
          ) {
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
          let changed = false;
          for (const selectedItem of workdaySelectedItems(container)) {
            try {
              selectedItem.focus({ preventScroll: true });
            } catch (_error) {
              selectedItem.focus?.();
            }
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
            setNativeValue(input, "");
            dispatch(input);
            changed = true;
          }
          await sleep(180);
          if (changed && !containerHasWorkdaySelection(container)) {
            clearedMultiselects += 1;
          }
        }
        return clearedMultiselects;
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
            setNativeChecked(el, false);
            dispatch(el);
            cleared += 1;
          }
          return;
        }
        if (el.value) {
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
              cleared += 1;
            }
          }
        });

      Array.from(document.querySelectorAll("textarea"))
        .filter(isVisibleEnabled)
        .forEach((el) => {
          if (el.value) {
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
            el.textContent = "";
            dispatch(el);
            cleared += 1;
          }
        });

      let workdayButtonClears = await clearWorkdayButtonDropdowns();
      cleared += workdayButtonClears;
      let workdayMultiselectClears = await clearWorkdayMultiselects();
      cleared += workdayMultiselectClears;

      await sleep(650);
      const stabilizedWorkdayButtonClears = await clearWorkdayButtonDropdowns();
      const stabilizedWorkdayMultiselectClears =
        await clearWorkdayMultiselects();
      workdayButtonClears += stabilizedWorkdayButtonClears;
      workdayMultiselectClears += stabilizedWorkdayMultiselectClears;
      cleared +=
        stabilizedWorkdayButtonClears + stabilizedWorkdayMultiselectClears;

      await sleep(1000);
      const lateWorkdayMultiselectClears = await clearWorkdayMultiselects();
      workdayMultiselectClears += lateWorkdayMultiselectClears;
      cleared += lateWorkdayMultiselectClears;

      await sleep(300);
      const closedDropdowns = preClosedDropdowns + closeOpenDropdowns();
      await sleep(120);
      const finalClosedDropdowns = closeOpenDropdowns();
      await sleep(80);
      const hiddenDropdownMenus = hideTransientDropdownMenus();
      await sleep(80);
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
      frameCount: results.length,
    },
    needsReview ? "warn" : "ok",
  );
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

async function handleMessage(message, sender = {}) {
  switch (message?.type) {
    case "hunt.apply.ping":
      return { ok: true, source: "background" };

    case "hunt.apply.get_state":
      return { ok: true, ...(await getExtensionState()) };

    case "hunt.apply.save_settings": {
      const settings = await saveSettings(message.payload || {});
      await refreshPollingAlarms(settings);
      await logActivity("settings.save", "Behavior settings saved.", {
        autofillOnLoad: settings.autofillOnLoad,
        manualFillEnabled: settings.manualFillEnabled,
        autoPromptEnabled: settings.autoPromptEnabled,
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
      await dismissPageTransientUi(tabId);
      await showFillProgress(tabId, "Filling page");
      try {
        result = await withTimeout(runFillForTab(tabId, state), 45000, () => ({
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
        }));
      } finally {
        await hideFillProgress(tabId);
      }
      await sendDebugLog("fill_result", {
        ok: result.ok,
        message: result.message,
        route: result.route,
        attempt: result.attempt,
        result: result.result,
        generatedAnswers: result.generatedAnswers,
      });
      await logActivity(
        result.ok ? "fill.complete" : "fill.failed",
        result.message || (result.ok ? "Fill completed." : "Fill failed."),
        {
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
        missingResume
          ? "No default resume is saved. Open Hunt Apply Options and save a PDF resume."
          : filledNothing
            ? "No fields were filled. Hunt logged the detected fields for review."
            : exportResult.exported
              ? `${result.message || (result.ok ? "Fill completed." : "Fill failed.")} Logs exported to ${exportResult.filename}.`
              : result.message ||
                (result.ok ? "Fill completed." : "Fill failed."),
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
      result.nextAction = await maybeHandleSafeNextAfterFill({
        tabId,
        fillResponse: result,
        settings: state.settings,
        triggeredBy: message.payload?.triggeredBy || "fill_current_page",
      });
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
      return clearCurrentPage(tabId);
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
