// fill-runner.js
// Resolves the correct ATS adapter for a tab, injects shared utilities and
// the adapter fill function, then logs the attempt.
// Adding a new ATS: import its createXxxFillFunction, add it to FILL_ADAPTERS.
import { chooseDetectedAtsType } from "../ats/registry.js";
import { GENERIC_FIELD_RULES } from "../ats/generic/field-rules.js";
import { createGenericFillFunction } from "../ats/generic/fill.js";
import { createGenericFillV2Function } from "../ats/generic/fill-v2.js";
import { genericBackedAtsNames } from "../ats/support-matrix.js";
import { postAnswerDecision, postDebugLog } from "../shared/api.js";
import { createWorkdayFillFunction } from "../ats/workday/fill.js";
import { createWorkdayFillV2Function } from "../ats/workday/fill-v2.js";
import {
  appendAttempt,
  appendQuestionAnswers,
  sanitizeAttempt,
} from "../shared/storage.js";
import { selectFillRoute } from "./fill-routes.js";
import {
  WORKDAY_RUNTIME_ERROR_REASON,
  recoverWorkdayRuntimeErrorForTab,
} from "./workday-runtime.js";

// Map of ATS name to fill-function factory.
// Each factory must return a self-contained async function (no outer references)
// because Chrome serialises it via Function.prototype.toString() for injection.
const GENERIC_BACKED_ATS_NAMES = genericBackedAtsNames();

const FILL_ADAPTERS = {
  generic: createGenericFillFunction,
  workday: createWorkdayFillFunction,
};

const FILL_ADAPTERS_V2 = {
  generic: createGenericFillV2Function,
  workday: createWorkdayFillV2Function,
};

for (const atsName of GENERIC_BACKED_ATS_NAMES) {
  FILL_ADAPTERS[atsName] = createGenericFillFunction;
  FILL_ADAPTERS_V2[atsName] = createGenericFillV2Function;
}

const pendingLlmFillByTab = new Map();
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 1500;
const BACKEND_ANSWER_DECISION_TIMEOUT_MS = 8000;

function filledTextNeedsBackendRepair(entry, isTextual) {
  if (!isTextual) {
    return false;
  }
  const valueSource = String(entry.valueSource || "").toLowerCase();
  const warning = String(entry.bestEffortWarning || "").toLowerCase();
  const isRequiredTextboxFallback =
    valueSource.startsWith("fallback:") &&
    [
      "fallback:zero_width_space",
      "fallback:not_applicable",
      "fallback:na",
    ].includes(valueSource);
  return (
    isRequiredTextboxFallback ||
    warning.includes("generated_or_placeholder_text_fallback") ||
    warning.includes("filled required unknown textbox with fallback text")
  );
}

function debugIdentityForState(extensionState = {}) {
  const settings = extensionState.settings || {};
  const browserContext = extensionState.browserContext || {};
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
    pipelineVersion: settings.useFieldPipelineV2 ? "v2" : "v1",
    useFieldPipelineV2: Boolean(settings.useFieldPipelineV2),
    settingsVersion: Number(settings.settingsVersion || 0),
    extensionVersion: manifest.version || "",
    extensionId: chrome.runtime.id || "",
  };
}

async function captureScreenshot(timeoutMs = SCREENSHOT_CAPTURE_TIMEOUT_MS) {
  let timedOut = false;
  try {
    const dataUrl = await Promise.race([
      chrome.tabs.captureVisibleTab(undefined, { format: "png" }),
      new Promise((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve("");
        }, timeoutMs);
      }),
    ]);
    return {
      dataUrl: typeof dataUrl === "string" ? dataUrl : "",
      reason: timedOut ? "capture_visible_tab_timeout" : "",
    };
  } catch (_error) {
    return {
      dataUrl: "",
      reason: "capture_visible_tab_failed",
    };
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
      frameUrl: entry.result.frameUrl || "",
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

async function collectFrameSignals(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const iframeSrcs = Array.from(document.querySelectorAll("iframe[src]"))
          .map((iframe) => iframe.src || "")
          .filter(Boolean)
          .slice(0, 30);
        const embeddedAtsTypes = [];
        if (
          document.querySelector("#grnhse_app") ||
          iframeSrcs.some((src) => src.includes("greenhouse.io"))
        ) {
          embeddedAtsTypes.push("greenhouse");
        }
        if (iframeSrcs.some((src) => src.includes("ashbyhq.com"))) {
          embeddedAtsTypes.push("ashby");
        }
        if (iframeSrcs.some((src) => src.includes("jobs.lever.co"))) {
          embeddedAtsTypes.push("lever");
        }
        return {
          href: window.location.href,
          iframeSrcs,
          embeddedAtsTypes,
        };
      },
    });
    return results.map((entry) => entry.result || {});
  } catch (_error) {
    return [];
  }
}

async function detectAtsTypeForTab(tabId, pageUrl, availableAdapters) {
  const frameSignals = await collectFrameSignals(tabId);
  const frameUrls = [];
  const embeddedAtsTypes = [];
  frameSignals.forEach((signal) => {
    if (signal.href) {
      frameUrls.push(signal.href);
    }
    (signal.iframeSrcs || []).forEach((src) => frameUrls.push(src));
    (signal.embeddedAtsTypes || []).forEach((name) =>
      embeddedAtsTypes.push(name),
    );
  });
  return chooseDetectedAtsType({
    pageUrl,
    frameUrls,
    embeddedAtsTypes,
    availableAdapters,
  });
}

function answerableFieldInventory(result) {
  return (result.fieldInventory || []).filter((entry) => {
    if (!entry.required) {
      return false;
    }
    const hasOptions = Array.isArray(entry.options) && entry.options.length > 0;
    const tagName = String(entry.tagName || "").toUpperCase();
    const type = String(entry.type || "").toLowerCase();
    const kind = String(entry.kind || "").toLowerCase();
    const isTextual =
      kind.includes("text") ||
      kind === "textarea" ||
      tagName === "TEXTAREA" ||
      (tagName === "INPUT" &&
        ["", "text", "email", "tel", "url", "search", "number"].includes(type));
    const isFallbackFill = filledTextNeedsBackendRepair(entry, isTextual);
    if (entry.filled && isFallbackFill) {
      return true;
    }
    if (entry.filled) {
      return false;
    }
    const needsAnswer = [
      "no_known_choice",
      "no_matching_option",
      "no_known_match",
      "no_known_fields_filled",
    ].includes(entry.skippedReason);
    if (hasOptions) {
      return needsAnswer;
    }
    return isTextual && needsAnswer;
  });
}

function summarizeAnswerableField(entry) {
  return {
    questionHash: entry.questionHash || "",
    descriptor: String(entry.descriptor || "").slice(0, 240),
    kind: entry.kind || "",
    tagName: entry.tagName || "",
    type: entry.type || "",
    id: entry.id || "",
    name: entry.name || "",
    filled: Boolean(entry.filled),
    skippedReason: entry.skippedReason || "",
    valueSource: entry.valueSource || "",
    bestEffortWarning: entry.bestEffortWarning || "",
    optionCount: Array.isArray(entry.options) ? entry.options.length : 0,
    options: Array.isArray(entry.options) ? entry.options.slice(0, 20) : [],
    rect: entry.rect || {},
  };
}

function attachPendingLlmSummary(result) {
  const fields = answerableFieldInventory(result);
  result.pendingLlmFieldCount = fields.length;
  result.pendingLlmFields = fields.map(summarizeAnswerableField);
  result.llmPromptAvailable = fields.length > 0;
  return fields;
}

function markInventoryFilledByDecision(result, decisionResult) {
  const filledByHash = new Map();
  (decisionResult?.filledFields || []).forEach((field) => {
    if (field.questionHash) {
      filledByHash.set(field.questionHash, field);
    }
  });
  if (!filledByHash.size || !Array.isArray(result.fieldInventory)) {
    return;
  }
  result.fieldInventory.forEach((entry) => {
    const filled = filledByHash.get(entry.questionHash);
    if (!filled) {
      return;
    }
    entry.filled = true;
    entry.skippedReason = "";
    entry.valueSource = filled.valueSource || "backend:answer_router";
    entry.selectedOption = filled.selectedOption || "";
    entry.canonicalField = filled.canonicalField || "";
  });
}

async function applyBackendAnswerDecisions({
  activeTabId,
  extensionState,
  pageUrl,
  atsType,
  result,
  abortSignal,
  isCancelled,
}) {
  const backendAnswerFields = answerableFieldInventory(result);
  postDebugLog(extensionState.settings, {
    eventType: "c3_backend_answer_inventory",
    ...debugIdentityForState(extensionState),
    payload: {
      atsType: result.atsType || atsType,
      pageUrl,
      fieldCount: backendAnswerFields.length,
      fields: backendAnswerFields.map(summarizeAnswerableField),
    },
  }).catch(() => {});
  if (backendAnswerFields.length === 0) {
    return {
      answerDecisions: [],
      filledFieldCount: 0,
      generatedAnswers: [],
      diagnostics: [],
    };
  }
  if (abortSignal?.aborted || isCancelled?.()) {
    result.answerDecisions = [];
    result.answerDecisionDiagnostics = [];
    attachPendingLlmSummary(result);
    return {
      answerDecisions: [],
      filledFieldCount: 0,
      generatedAnswers: [],
      diagnostics: [],
      cancelled: true,
    };
  }
  const answerDecisions = await requestBackendAnswerDecisions({
    settings: extensionState.settings,
    profile: extensionState.profile,
    activeApplyContext: extensionState.activeApplyContext,
    atsType: result.atsType || atsType,
    pageUrl,
    fields: backendAnswerFields,
    abortSignal,
    isCancelled,
  });
  if (abortSignal?.aborted || isCancelled?.()) {
    result.answerDecisions = answerDecisions;
    result.answerDecisionDiagnostics = [];
    attachPendingLlmSummary(result);
    return {
      answerDecisions,
      filledFieldCount: 0,
      generatedAnswers: [],
      diagnostics: [],
      cancelled: true,
    };
  }
  const fillableDecisions = answerDecisions.filter(
    (entry) => entry.decision?.status === "fillable",
  );
  if (fillableDecisions.length === 0) {
    result.answerDecisions = answerDecisions;
    result.answerDecisionDiagnostics = answerDecisions.map((entry) => ({
      questionHash: entry.questionHash,
      descriptor: entry.descriptor,
      status: entry.decision?.status || "unknown",
      action: entry.decision?.action || "",
      reason: entry.decision?.reason || "",
      selectedOption: entry.decision?.selected_option || "",
    }));
    attachPendingLlmSummary(result);
    return {
      answerDecisions,
      filledFieldCount: 0,
      generatedAnswers: [],
      diagnostics: result.answerDecisionDiagnostics,
    };
  }

  const target =
    result.frameId === undefined
      ? { tabId: activeTabId, allFrames: true }
      : { tabId: activeTabId, frameIds: [result.frameId] };
  const decisionFillResults = await chrome.scripting.executeScript({
    target,
    func: createApplyAnswerDecisionsFunction(),
    args: [
      {
        decisions: fillableDecisions,
        stripLongDash: extensionState.settings.stripLongDash !== false,
      },
    ],
  });
  const decisionResult = chooseBestFrameResult(decisionFillResults);
  markInventoryFilledByDecision(result, decisionResult);
  const filledDecisionHashes = new Set(
    (decisionResult.filledFields || []).map((field) => field.questionHash),
  );
  const generatedAnswers = fillableDecisions
    .filter((entry) => filledDecisionHashes.has(entry.questionHash))
    .map((entry) => ({
      questionHash: entry.questionHash,
      questionText: entry.descriptor,
      answerText:
        entry.decision.selected_option || entry.decision.answer_text || "",
      answerSource: "backend:" + (entry.decision.provider || "answer_router"),
      confidence: String(entry.decision.confidence || ""),
      manualReviewRequired: false,
    }));

  if (decisionResult.ok && decisionResult.filledFieldCount > 0) {
    result.filledFieldCount =
      Number(result.filledFieldCount || 0) +
      Number(decisionResult.filledFieldCount || 0);
    result.filledFields = (result.filledFields || []).concat(
      decisionResult.filledFields || [],
    );
    result.generatedAnswerCount =
      Number(result.generatedAnswerCount || 0) + generatedAnswers.length;
    result.generatedAnswers = (result.generatedAnswers || []).concat(
      generatedAnswers,
    );
    result.manualReviewReasons = (result.manualReviewReasons || []).filter(
      (reason) => reason !== "no_known_fields_filled",
    );
    result.manualReviewRequired = result.manualReviewReasons.length > 0;
  }
  result.answerDecisions = answerDecisions;
  result.answerDecisionDiagnostics = decisionResult.diagnostics || [];
  attachPendingLlmSummary(result);
  return {
    answerDecisions,
    filledFieldCount: Number(decisionResult.filledFieldCount || 0),
    generatedAnswers,
    diagnostics: result.answerDecisionDiagnostics,
  };
}

async function requestBackendAnswerDecisions({
  settings,
  profile,
  activeApplyContext,
  atsType,
  pageUrl,
  fields,
  abortSignal,
  isCancelled,
}) {
  if (!settings.llmAnswerFallbackEnabled || !settings.backendUrl) {
    return [];
  }
  const url = new URL(pageUrl || "https://unknown.invalid");
  const decisions = [];
  for (const field of fields.slice(0, 12)) {
    if (abortSignal?.aborted || isCancelled?.()) {
      break;
    }
    try {
      const response = await postAnswerDecision(
        settings,
        {
          url: pageUrl,
          host: url.host,
          ats: atsType,
          job: {
            title: activeApplyContext.title || "",
            company: activeApplyContext.company || "",
            description_excerpt: (activeApplyContext.description || "").slice(
              0,
              2500,
            ),
          },
          field: {
            label: field.descriptor || "",
            question_hash: field.questionHash || "",
            required: Boolean(field.required),
            kind: field.kind || "",
            options: field.options || [],
          },
          profile,
          policy: {
            required_only: settings.fillRequiredOnly !== false,
            allow_generated_paragraphs: settings.allowGeneratedAnswers === true,
            allow_cloud: settings.allowCloudLlmForC3 === true,
            confidence_threshold: settings.flagLowConfidenceAnswers
              ? 0.72
              : 0.5,
          },
        },
        {
          signal: abortSignal,
          timeoutMs: BACKEND_ANSWER_DECISION_TIMEOUT_MS,
        },
      );
      decisions.push({
        questionHash: field.questionHash,
        descriptor: field.descriptor,
        id: field.id || "",
        name: field.name || "",
        kind: field.kind || "",
        tagName: field.tagName || "",
        options: field.options || [],
        decision: response?.decision || {
          status: "provider_unavailable",
          action: "manual_review",
          reason: "Backend did not return a decision.",
          requires_review: true,
        },
      });
    } catch (error) {
      if (abortSignal?.aborted || isCancelled?.()) {
        break;
      }
      decisions.push({
        questionHash: field.questionHash,
        descriptor: field.descriptor,
        id: field.id || "",
        name: field.name || "",
        kind: field.kind || "",
        tagName: field.tagName || "",
        options: field.options || [],
        decision: {
          status: "provider_unavailable",
          action: "manual_review",
          reason: error?.message || String(error),
          requires_review: true,
        },
      });
    }
  }
  return decisions;
}

function createApplyAnswerDecisionsFunction() {
  return async function applyAnswerDecisions({ decisions, stripLongDash }) {
    var u = window.__huntApplyUtils;
    if (!u) {
      return { ok: false, reason: "missing_utils", filledFieldCount: 0 };
    }
    var sleep = function (ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    };
    var containerSelectors = [
      "label",
      "fieldset",
      '[role="group"]',
      "[data-testid]",
      ".form-group",
      ".field",
      ".form-field",
      ".input-group",
      ".application-field",
      ".application-question",
      '[class*="field"]',
      '[class*="Field"]',
      '[data-qa*="field"]',
      '[data-testid*="field"]',
    ];
    var decisionByHash = new Map();
    var decisionById = new Map();
    var decisionByName = new Map();
    (decisions || []).forEach(function (entry) {
      if (entry.questionHash && entry.decision?.status === "fillable") {
        decisionByHash.set(entry.questionHash, entry.decision);
      }
      if (entry.id && entry.decision?.status === "fillable") {
        decisionById.set(entry.id, entry.decision);
      }
      if (entry.name && entry.decision?.status === "fillable") {
        decisionByName.set(entry.name, entry.decision);
      }
    });
    var fields = u.getVisibleElements("select").concat(
      u.getVisibleElements('button[aria-haspopup="listbox"]'),
      u
        .getVisibleElements(
          'input[role="combobox"], input[aria-autocomplete="list"], textarea, input:not([type="hidden"]):not([type="file"])',
        )
        .filter(function (el) {
          return el.tagName !== "SELECT";
        }),
    );
    var filled = [];
    var diagnostics = [];
    var normalize = function (value) {
      return u.normalizeText(value, stripLongDash).toLowerCase();
    };
    var exactOptionText = function (optionText, selected) {
      return normalize(optionText) === normalize(selected);
    };
    var keyDetails = function (keyName) {
      var map = {
        Enter: { code: "Enter", keyCode: 13 },
        Escape: { code: "Escape", keyCode: 27 },
        Tab: { code: "Tab", keyCode: 9 },
        ArrowDown: { code: "ArrowDown", keyCode: 40 },
        ArrowUp: { code: "ArrowUp", keyCode: 38 },
      };
      return map[keyName] || { code: keyName, keyCode: 0 };
    };
    var keyOn = function (target, keyName) {
      if (!target || typeof target.dispatchEvent !== "function") {
        return;
      }
      var details = keyDetails(keyName);
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: keyName,
          code: details.code,
          keyCode: details.keyCode,
          which: details.keyCode,
          bubbles: true,
          cancelable: true,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: keyName,
          code: details.code,
          keyCode: details.keyCode,
          which: details.keyCode,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    var clickOutsideMenu = function () {
      var target = document.body || document.documentElement;
      if (!target) {
        return;
      }
      ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
      });
    };
    var closeMenu = async function (el) {
      var control = el.closest(".select__control") || el;
      keyOn(el, "Escape");
      keyOn(control, "Escape");
      keyOn(document.body, "Escape");
      keyOn(document, "Escape");
      keyOn(window, "Escape");
      if (typeof el.blur === "function") {
        el.blur();
      }
      clickOutsideMenu();
      await sleep(90);
      keyOn(document, "Escape");
      keyOn(window, "Escape");
    };
    var committedState = function (el) {
      var container =
        el.closest(".select__container") ||
        el.closest(".custom-select") ||
        el.parentElement;
      var field = el.closest(".custom-select, .application-field");
      var datasetSelected = u.normalizeText(
        field?.dataset?.selected || el.dataset?.selected || "",
        stripLongDash,
      );
      if (datasetSelected) {
        return { text: datasetSelected, source: "dataset" };
      }
      var selected = container?.querySelector(
        '.select__single-value, [class*="single-value"]',
      );
      var selectedText = u.normalizeText(
        selected ? selected.innerText || selected.textContent : "",
        stripLongDash,
      );
      if (selectedText) {
        return { text: selectedText, source: "single_value" };
      }
      var inputText = u.normalizeText(el.value, stripLongDash);
      return { text: inputText, source: inputText ? "input" : "" };
    };
    var optionLooksSelected = function (option) {
      if (!option) {
        return false;
      }
      var selectedAttr = u
        .normalizeText(
          [
            option.getAttribute("aria-selected"),
            option.getAttribute("data-selected"),
            option.getAttribute("data-state"),
          ]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      var className = u.normalizeText(option.className || "").toLowerCase();
      return (
        selectedAttr.includes("true") ||
        selectedAttr.includes("selected") ||
        className.includes("selected") ||
        className.includes("is-focused")
      );
    };
    var trackNativeCommitEvents = function (el) {
      var changed = false;
      var mark = function () {
        changed = true;
      };
      el.addEventListener("change", mark, true);
      el.addEventListener("input", mark, true);
      return {
        changed: function () {
          return changed;
        },
        stop: function () {
          el.removeEventListener("change", mark, true);
          el.removeEventListener("input", mark, true);
        },
      };
    };
    var pointerEvent = function (target, type, rect) {
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
    };
    var realisticOptionClick = function (option) {
      if (!option) {
        return;
      }
      if (typeof option.scrollIntoView === "function") {
        option.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      var rect = option.getBoundingClientRect();
      [
        "mouseover",
        "mousemove",
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ].forEach(function (type) {
        pointerEvent(option, type, rect);
      });
    };
    var exactCommitMatches = function (state, selected) {
      return exactOptionText(state.text, selected);
    };
    var fillSelect = function (el, selected) {
      var option = Array.from(el.options || []).find(function (candidate) {
        return exactOptionText(candidate.text || candidate.value, selected);
      });
      if (!option) {
        return false;
      }
      el.value = option.value;
      u.dispatchInputEvents(el);
      return true;
    };
    var fillCombo = async function (el, selected) {
      el.focus();
      (el.closest(".select__control") || el).click();
      await sleep(120);
      u.setElementValue(el, selected, stripLongDash);
      await sleep(300);
      var options = Array.from(
        document.querySelectorAll(
          '[role="option"], .option, .select__option, [class*="__option"], [class*="-option"]',
        ),
      ).filter(function (option) {
        var text = option.innerText || option.textContent || "";
        return exactOptionText(text, selected);
      });
      var visible = options.find(function (option) {
        var style = window.getComputedStyle(option);
        var rect = option.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
      var option = visible || options[0];
      if (option) {
        var beforeClick = committedState(el);
        var tracker = trackNativeCommitEvents(el);
        realisticOptionClick(option);
        await sleep(180);
        var changedByClick = tracker.changed();
        tracker.stop();
        var after = committedState(el);
        u.dispatchInputEvents(el);
        if (
          exactOptionText(after.text, selected) &&
          (!beforeClick.text ||
            after.text !== beforeClick.text ||
            after.source !== beforeClick.source ||
            after.source !== "input" ||
            changedByClick ||
            optionLooksSelected(option))
        ) {
          await closeMenu(el);
          return true;
        }
        var beforeEnter = committedState(el);
        var enterTracker = trackNativeCommitEvents(el);
        keyOn(el, "Enter");
        await sleep(180);
        var changedByEnter = enterTracker.changed();
        enterTracker.stop();
        var afterEnter = committedState(el);
        u.dispatchInputEvents(el);
        await closeMenu(el);
        return (
          (exactCommitMatches(afterEnter, selected) &&
            (!beforeEnter.text ||
              afterEnter.text !== beforeEnter.text ||
              afterEnter.source !== beforeEnter.source ||
              afterEnter.source !== "input" ||
              changedByEnter ||
              optionLooksSelected(option))) ||
          exactCommitMatches(committedState(el), selected)
        );
      }
      u.dispatchInputEvents(el);
      await closeMenu(el);
      return exactOptionText(committedState(el).text, selected);
    };
    var fillWorkdayButton = async function (button, selected) {
      button.scrollIntoView({ block: "center", inline: "nearest" });
      realisticOptionClick(button);
      await sleep(200);
      var options = Array.from(document.querySelectorAll('[role="option"]'));
      var visible = options.filter(function (option) {
        var style = window.getComputedStyle(option);
        var rect = option.getBoundingClientRect();
        return (
          option.getAttribute("aria-disabled") !== "true" &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
      var option = visible.find(function (candidate) {
        return exactOptionText(
          candidate.innerText || candidate.textContent || "",
          selected,
        );
      });
      if (!option) {
        await closeMenu(button);
        return false;
      }
      realisticOptionClick(option);
      if (typeof option.click === "function") {
        option.click();
      }
      await sleep(250);
      u.dispatchInputEvents(button);
      var current = u.normalizeText(
        button.innerText ||
          button.textContent ||
          button.getAttribute("aria-label") ||
          "",
        stripLongDash,
      );
      await closeMenu(button);
      return exactOptionText(current, selected);
    };

    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      var descriptor = u.getDescriptor(el, containerSelectors);
      var questionHash = u.buildQuestionHash(descriptor || "");
      var decision =
        decisionByHash.get(questionHash) ||
        (el.id ? decisionById.get(el.id) : null) ||
        (el.name ? decisionByName.get(el.name) : null);
      if (!decision) {
        continue;
      }
      var ok = false;
      var diagnostic = {
        questionHash,
        descriptor: descriptor.slice(0, 240),
        action: decision.action || "",
        selectedOption: decision.selected_option || "",
        answerTextLength: String(decision.answer_text || "").length,
        status: decision.status || "",
        reason: "",
        before: "",
        after: "",
      };
      if (decision.action === "select_option") {
        if (el.tagName === "SELECT") {
          diagnostic.before = el.value || "";
          ok = fillSelect(el, decision.selected_option);
          diagnostic.after = el.value || "";
        } else if (
          el.tagName === "BUTTON" &&
          el.getAttribute("aria-haspopup") === "listbox"
        ) {
          diagnostic.before = u.normalizeText(
            el.innerText || el.textContent || "",
            stripLongDash,
          );
          ok = await fillWorkdayButton(el, decision.selected_option);
          diagnostic.after = u.normalizeText(
            el.innerText || el.textContent || "",
            stripLongDash,
          );
        } else if (
          el.getAttribute("role") === "combobox" ||
          el.getAttribute("aria-autocomplete") === "list" ||
          el.closest(".select__container") ||
          el.closest(".custom-select")
        ) {
          diagnostic.before = committedState(el).text;
          ok = await fillCombo(el, decision.selected_option);
          diagnostic.after = committedState(el).text;
        }
      } else if (decision.action === "fill_text") {
        diagnostic.before = el.value || el.textContent || "";
        ok = u.setElementValue(el, decision.answer_text, stripLongDash);
        diagnostic.after = el.value || el.textContent || "";
      }
      if (ok) {
        filled.push({
          field: descriptor,
          questionHash: questionHash,
          valueSource: "backend:" + (decision.provider || "answer_router"),
          selectedOption: decision.selected_option || "",
          canonicalField: decision.canonical_field || "",
        });
      } else {
        diagnostic.reason = "decision_not_committed_to_page";
      }
      diagnostic.ok = Boolean(ok);
      diagnostics.push(diagnostic);
    }
    return {
      ok: true,
      filledFieldCount: filled.length,
      filledFields: filled,
      diagnostics,
    };
  };
}

class C3AutofillPipelineContext {
  constructor({ tabId, extensionState, options }) {
    this.requestedTabId = tabId;
    this.extensionState = extensionState;
    this.options = options || {};
    this.availableAdapters = Object.keys(FILL_ADAPTERS);
    this.response = null;
  }

  stop(response) {
    this.response = response;
  }

  get stopped() {
    return Boolean(this.response);
  }

  get cancelled() {
    return Boolean(
      typeof this.options.isCancelled === "function" &&
      this.options.isCancelled(),
    );
  }
}

function buildCancelledPipelineResponse(context) {
  const route = context.route || {
    routeName: "cancelled",
    fillSource:
      context.extensionState?.activeApplyContext?.sourceMode || "manual",
    strategy: "cancelled",
    adapterName: context.atsType || "",
    requestedAtsType: context.extensionState?.activeApplyContext?.atsType || "",
    detectedAtsType: context.detectedAtsType || "",
    usedGenericFallback: false,
    adapterBackedByGeneric: false,
  };
  return {
    ok: false,
    cancelled: true,
    reason: "user_cancelled",
    message: "Fill canceled.",
    route,
    attempt: {
      applyUrl:
        context.pageUrl ||
        context.extensionState?.activeApplyContext?.applyUrl ||
        "",
      atsType: context.atsType || context.detectedAtsType || "",
      filledFieldCount: 0,
      manualReviewRequired: true,
      manualReviewReasons: ["user_cancelled"],
    },
    result: {
      ok: false,
      filledFieldCount: 0,
      pendingLlmFieldCount: 0,
      manualReviewReasons: ["user_cancelled"],
      filledFields: [],
      fieldInventory: [],
      generatedAnswers: [],
    },
    generatedAnswers: [],
  };
}

function buildWorkdayRuntimeErrorResponse(context, recovery) {
  const route = context.route || {
    routeName: "workday_runtime_error",
    fillSource:
      context.extensionState?.activeApplyContext?.sourceMode || "manual",
    strategy: "workday_runtime_error",
    adapterName: context.atsType || "workday",
    requestedAtsType: context.extensionState?.activeApplyContext?.atsType || "",
    detectedAtsType: context.detectedAtsType || "workday",
    usedGenericFallback: false,
    adapterBackedByGeneric: false,
  };
  return {
    ok: false,
    reason: WORKDAY_RUNTIME_ERROR_REASON,
    message:
      "Workday showed its refresh-required error page and did not recover after one refresh.",
    route,
    attempt: {
      applyUrl:
        context.pageUrl ||
        context.extensionState?.activeApplyContext?.applyUrl ||
        "",
      atsType: "workday",
      filledFieldCount: 0,
      manualReviewRequired: true,
      manualReviewReasons: [WORKDAY_RUNTIME_ERROR_REASON],
    },
    result: {
      ok: false,
      filledFieldCount: 0,
      pendingLlmFieldCount: 0,
      manualReviewRequired: true,
      manualReviewReasons: [WORKDAY_RUNTIME_ERROR_REASON],
      filledFields: [],
      fieldInventory: [],
      generatedAnswers: [],
      workdayRuntimeRecovery: recovery,
    },
    generatedAnswers: [],
  };
}

class ResolveActiveTabStep {
  async run(context) {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    context.activeTabId = context.requestedTabId || tab?.id;
    if (!context.activeTabId) {
      context.stop({
        ok: false,
        reason: "missing_tab",
        message: "No active tab is available for fill.",
      });
      return;
    }

    context.tabInfo = await chrome.tabs.get(context.activeTabId);
    context.pageUrl = context.tabInfo.url || "";
  }
}

class DetectAtsStep {
  async run(context) {
    context.detectedAtsType = await detectAtsTypeForTab(
      context.activeTabId,
      context.pageUrl,
      context.availableAdapters,
    );
  }
}

class SelectFillRouteStep {
  run(context) {
    context.route = selectFillRoute({
      activeApplyContext: context.extensionState.activeApplyContext,
      detectedAtsType: context.detectedAtsType,
      availableAdapters: context.availableAdapters,
    });
    context.route.adapterBackedByGeneric = GENERIC_BACKED_ATS_NAMES.includes(
      context.route.adapterName,
    );
    context.atsType = context.route.adapterName;
  }
}

class ResolveFillAdapterStep {
  run(context) {
    context.useFieldPipelineV2 = Boolean(
      context.extensionState.settings.useFieldPipelineV2,
    );
    const adapters = context.useFieldPipelineV2
      ? FILL_ADAPTERS_V2
      : FILL_ADAPTERS;
    context.adapterFactory = adapters[context.atsType];
    if (context.adapterFactory) {
      return;
    }

    const supported = Object.keys(FILL_ADAPTERS).join(", ");
    context.stop({
      ok: false,
      reason: "unsupported_ats",
      atsType: context.atsType,
      message: `ATS "${context.atsType}" is not yet supported. Supported: ${supported}.`,
    });
  }
}

class RecoverWorkdayRuntimeErrorStep {
  async run(context) {
    if (context.atsType !== "workday") {
      return;
    }
    const recovery = await recoverWorkdayRuntimeErrorForTab(
      context.activeTabId,
    );
    if (!recovery.attempted) {
      return;
    }
    context.workdayRuntimeRecovery = recovery;
    if (!recovery.ok) {
      context.stop(buildWorkdayRuntimeErrorResponse(context, recovery));
      return;
    }
    context.tabInfo = await chrome.tabs.get(context.activeTabId);
    context.pageUrl = context.tabInfo.url || context.pageUrl || "";
  }
}

class InjectSharedUtilitiesStep {
  async run(context) {
    const files = ["src/shared/injected.js"];
    if (context.useFieldPipelineV2) {
      files.push(
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
      );
      if (context.atsType === "workday") {
        files.push(
          "src/ats/workday/workday-ui-v2.js",
          "src/ats/workday/workday-drivers-v2.js",
          "src/ats/workday/workday-repeatables-v2.js",
        );
      }
    }
    await chrome.scripting.executeScript({
      target: { tabId: context.activeTabId, allFrames: true },
      files,
    });
  }
}

class RunAdapterFillStep {
  async run(context) {
    const adapterProfile = context.extensionState.settings
      .autoAccountSignupLoginEnabled
      ? context.extensionState.profile
      : {
          ...context.extensionState.profile,
          accountEmail: "",
          accountPassword: "",
        };
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: context.activeTabId, allFrames: true },
      func: context.adapterFactory(),
      args: [
        {
          profile: adapterProfile,
          settings: context.extensionState.settings,
          activeApplyContext: context.extensionState.activeApplyContext,
          defaultResume: context.extensionState.defaultResume,
          fieldRules: GENERIC_FIELD_RULES,
          fillRoute: context.route,
          fillRunId: context.options.fillRunId || "",
        },
      ],
    });

    context.result = chooseBestFrameResult(injectionResults);
    if (context.workdayRuntimeRecovery) {
      context.result.workdayRuntimeRecovery = context.workdayRuntimeRecovery;
    }
    if (context.result.v2Audit) {
      try {
        await postDebugLog(context.extensionState.settings, {
          eventType: "c3_v2_audit",
          extensionTime: new Date().toISOString(),
          ...debugIdentityForState(context.extensionState),
          payload: {
            pageUrl: context.pageUrl,
            atsType: context.result.atsType || context.atsType,
            route: context.route,
            audit: context.result.v2Audit,
          },
        });
      } catch (_error) {
        context.result.v2AuditBackendLogFailed = true;
      }
    }
  }
}

class PrepareLlmHelpStep {
  async run(context) {
    const backendAnswerFields = attachPendingLlmSummary(context.result);

    if (backendAnswerFields.length > 0 && !context.options.allowLlmAnswers) {
      pendingLlmFillByTab.set(context.activeTabId, {
        extensionState: context.extensionState,
        pageUrl: context.pageUrl,
        atsType: context.result.atsType || context.atsType,
        route: context.route,
        result: context.result,
        createdAt: Date.now(),
      });
    }

    if (backendAnswerFields.length > 0 && context.options.allowLlmAnswers) {
      await applyBackendAnswerDecisions({
        activeTabId: context.activeTabId,
        extensionState: context.extensionState,
        pageUrl: context.pageUrl,
        atsType: context.result.atsType || context.atsType,
        result: context.result,
        abortSignal: context.options.abortSignal,
        isCancelled: () => context.cancelled,
      });
      attachPendingLlmSummary(context.result);
      pendingLlmFillByTab.delete(context.activeTabId);
    }
  }
}

class PersistFillAttemptStep {
  async run(context) {
    const { attempt, answerEntries } = await persistFillAttempt({
      extensionState: context.extensionState,
      pageUrl: context.pageUrl,
      atsType: context.result.atsType || context.atsType,
      route: context.route,
      result: context.result,
    });
    context.attempt = attempt;
    context.answerEntries = answerEntries;
  }
}

class BuildFillResponseStep {
  run(context) {
    context.stop(
      buildFillResponse({
        result: context.result,
        attempt: context.attempt,
        answerEntries: context.answerEntries,
        route: context.route,
      }),
    );
  }
}

class C3AutofillPipeline {
  constructor(
    steps = [
      new ResolveActiveTabStep(),
      new DetectAtsStep(),
      new SelectFillRouteStep(),
      new ResolveFillAdapterStep(),
      new RecoverWorkdayRuntimeErrorStep(),
      new InjectSharedUtilitiesStep(),
      new RunAdapterFillStep(),
      new PrepareLlmHelpStep(),
      new PersistFillAttemptStep(),
      new BuildFillResponseStep(),
    ],
  ) {
    this.steps = steps;
  }

  async run(input) {
    const context = new C3AutofillPipelineContext(input);
    for (const step of this.steps) {
      if (context.stopped) {
        break;
      }
      if (context.cancelled) {
        context.stop(buildCancelledPipelineResponse(context));
        break;
      }
      await step.run(context);
      if (!context.stopped && context.cancelled) {
        context.stop(buildCancelledPipelineResponse(context));
        break;
      }
    }
    return context.response;
  }
}

function buildFillResponse({ result, attempt, answerEntries, route }) {
  const manualReviewRequired = Boolean(attempt?.manualReviewRequired);
  const bestEffortWarningCount = Number(result.bestEffortWarnings?.length || 0);
  const v2IssueCount = Number(result.v2Audit?.permanentIssues?.length || 0);
  const filledLabel = result.answerDecisions
    ? "fields"
    : "deterministic fields";
  return {
    ok: result.ok,
    message: result.ok
      ? result.pendingLlmFieldCount
        ? `Filled ${result.filledFieldCount || 0} ${filledLabel}. ${result.pendingLlmFieldCount} unanswered required question${result.pendingLlmFieldCount === 1 ? "" : "s"} can use LLM help.`
        : manualReviewRequired
          ? `Filled ${result.filledFieldCount || 0} fields; manual review needed${v2IssueCount ? ` for ${v2IssueCount} V2 issue${v2IssueCount === 1 ? "" : "s"}` : ""}.`
          : bestEffortWarningCount
            ? `Filled ${result.filledFieldCount || 0} fields and used ${bestEffortWarningCount} best-effort default${bestEffortWarningCount === 1 ? "" : "s"} to keep moving. Review flagged answers before submitting.`
            : `Filled ${result.filledFieldCount || 0} fields and logged ${result.generatedAnswerCount || 0} generated answers.`
      : result.message || "Fill failed.",
    attempt,
    generatedAnswers: answerEntries,
    route,
    result,
  };
}

async function persistFillAttempt({
  extensionState,
  pageUrl,
  atsType,
  route,
  result,
}) {
  const screenshot = await captureScreenshot();
  if (screenshot.reason) {
    result.persistenceDiagnostics = {
      ...(result.persistenceDiagnostics || {}),
      screenshotCapture: {
        reason: screenshot.reason,
        timeoutMs: SCREENSHOT_CAPTURE_TIMEOUT_MS,
      },
    };
  }
  const attemptId = crypto.randomUUID();
  const manualReviewRequired = Boolean(result.manualReviewRequired);

  const attemptPayload = {
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
    bestEffortWarnings: result.bestEffortWarnings || [],
    fieldInventory: result.fieldInventory || [],
    interactionTrace: result.interactionTrace || [],
    v2Audit: result.v2Audit || {},
    traceTruncated: Boolean(result.traceTruncated),
    htmlSnapshot: result.htmlSnapshot || "",
    screenshotDataUrl: screenshot.dataUrl,
    resultSummary: result.ok
      ? manualReviewRequired
        ? `Filled ${result.filledFieldCount || 0} fields via ${route.routeName}; manual review needed.`
        : `Filled ${result.filledFieldCount || 0} fields via ${route.routeName}.`
      : result.message || result.reason || "Fill failed.",
  };
  let attempt = sanitizeAttempt(attemptPayload);
  try {
    attempt = await appendAttempt(attemptPayload);
  } catch (error) {
    result.persistenceDiagnostics = {
      ...(result.persistenceDiagnostics || {}),
      attemptStorage: {
        reason: "append_attempt_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

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
  try {
    await appendQuestionAnswers(answerEntries);
  } catch (error) {
    result.persistenceDiagnostics = {
      ...(result.persistenceDiagnostics || {}),
      answerStorage: {
        reason: "append_question_answers_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  return { attempt, answerEntries };
}

export async function runFillForTab(tabId, extensionState, options = {}) {
  return new C3AutofillPipeline().run({
    tabId,
    extensionState,
    options,
  });
}

export async function runPendingLlmFillForTab(tabId, extensionState = null) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = tabId || tab?.id;
  let pending = pendingLlmFillByTab.get(activeTabId);
  if (!pending && extensionState) {
    const rebuilt = await runFillForTab(activeTabId, extensionState, {
      prepareLlmOnly: true,
    });
    pending = pendingLlmFillByTab.get(activeTabId);
    if (!pending) {
      return {
        ok: false,
        reason:
          rebuilt?.ok === false ? rebuilt.reason : "missing_pending_llm_fill",
        message:
          rebuilt?.ok === false
            ? rebuilt.message || "Could not prepare LLM fill for this tab."
            : rebuilt?.result?.pendingLlmFieldCount === 0
              ? "No unanswered required questions are available for LLM help on this tab."
              : "No pending LLM fill is available for this tab.",
        result: rebuilt?.result,
        route: rebuilt?.route,
      };
    }
  }
  if (!pending) {
    return {
      ok: false,
      reason: "missing_pending_llm_fill",
      message: "No pending LLM fill is available for this tab.",
    };
  }
  await applyBackendAnswerDecisions({
    activeTabId,
    extensionState: pending.extensionState,
    pageUrl: pending.pageUrl,
    atsType: pending.atsType,
    result: pending.result,
  });
  attachPendingLlmSummary(pending.result);
  pendingLlmFillByTab.delete(activeTabId);
  const { attempt, answerEntries } = await persistFillAttempt({
    extensionState: pending.extensionState,
    pageUrl: pending.pageUrl,
    atsType: pending.atsType,
    route: pending.route,
    result: pending.result,
  });
  return buildFillResponse({
    result: pending.result,
    attempt,
    answerEntries,
    route: pending.route,
  });
}
