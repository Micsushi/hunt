// Workday ATS adapter.
// Exports createWorkdayFillFunction() — a factory that returns a self-contained
// async function suitable for chrome.scripting.executeScript func:.
// The returned function must not close over any module-scope variables because
// Chrome serialises it via Function.prototype.toString() before injection.
// All shared logic lives in window.__huntApplyUtils (injected.js).
export function createWorkdayFillFunction() {
  return async function workdayFill({ profile, settings, activeApplyContext, defaultResume }) {
    var u = window.__huntApplyUtils;
    if (!u) {
      return {
        ok: false,
        reason: "missing_utils",
        message: "Shared fill utils (injected.js) were not injected before this adapter ran."
      };
    }

    var perFieldDelayMs = 25;
    var perUploadDelayMs = 75;
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var stripLongDash = settings.stripLongDash !== false;

    // Workday uses data-automation-id="formField" as the canonical field container.
    var containerSelectors = ["label", '[data-automation-id="formField"]', '[role="group"]'];
    var getDescriptor = function (el) { return u.getDescriptor(el, containerSelectors); };

    var filledFields = [];
    var generatedAnswers = [];
    var manualReviewReasons = [];

    if (activeApplyContext.jobId && activeApplyContext.selectedResumeReadyForC3 === false) {
      manualReviewReasons.push("resume_not_ready_for_c3");
    }

    // Collect every visible fillable element on the current step.
    var textInputs = u.getVisibleElements('input:not([type="hidden"]):not([type="file"])');
    var textareas = u.getVisibleElements("textarea");
    var selects = u.getVisibleElements("select");
    var fileInputs = u.getVisibleElements('input[type="file"]');
    var radios = u.getVisibleElements('input[type="radio"]');

    // Group radios by name so yes/no pairs are handled together.
    var radiosByName = new Map();
    for (var i = 0; i < radios.length; i++) {
      var radio = radios[i];
      var key = radio.name || radio.id || Math.random().toString(36);
      if (!radiosByName.has(key)) {
        radiosByName.set(key, []);
      }
      radiosByName.get(key).push(radio);
    }

    // Build a unified candidate list with DOM position for top-down ordering.
    var candidates = [];
    var flatEls = textInputs.concat(textareas, selects, fileInputs);
    for (var j = 0; j < flatEls.length; j++) {
      var el = flatEls[j];
      candidates.push({ kind: "element", element: el, rect: el.getBoundingClientRect() });
    }
    radiosByName.forEach(function (group) {
      var anchor = group[0];
      if (anchor) {
        candidates.push({ kind: "radioGroup", radios: group, rect: anchor.getBoundingClientRect() });
      }
    });

    var sorted = u.sortCandidatesByPosition(candidates);

    for (var k = 0; k < sorted.length; k++) {
      var candidate = sorted[k];

      if (candidate.kind === "radioGroup") {
        var descriptor = candidate.radios.map(function (r) { return getDescriptor(r); }).join(" ").toLowerCase();
        if (u.fillRadioGroup(candidate.radios, descriptor, profile, containerSelectors)) {
          filledFields.push({ field: descriptor, valueSource: "radio_rule" });
          await sleep(perFieldDelayMs);
        }
        continue;
      }

      var elem = candidate.element;
      var desc = getDescriptor(elem);
      if (!desc) {
        continue;
      }

      if (elem.tagName === "TEXTAREA") {
        // Skip already-filled or generation-disabled.
        if (elem.value || settings.allowGeneratedAnswers === false) {
          continue;
        }
        var answer = u.generateAnswer(desc, profile, activeApplyContext, stripLongDash);
        if (u.setElementValue(elem, answer.answerText, stripLongDash)) {
          var qHash = u.buildQuestionHash(desc);
          generatedAnswers.push({
            questionHash: qHash,
            questionText: desc,
            answerText: answer.answerText,
            answerSource: "generated",
            confidence: answer.confidence,
            manualReviewRequired: answer.manualReviewRequired
          });
          filledFields.push({ field: desc, valueSource: "generated_answer" });
          if (settings.flagLowConfidenceAnswers !== false && answer.manualReviewRequired) {
            manualReviewReasons.push("low_confidence_answer:" + qHash);
          }
          await sleep(perFieldDelayMs);
        }
        continue;
      }

      if (elem.tagName === "SELECT") {
        if (u.fillSelectElement(elem, desc, profile, stripLongDash)) {
          filledFields.push({ field: desc, valueSource: "select_rule" });
          await sleep(perFieldDelayMs);
        }
        continue;
      }

      if (elem.tagName === "INPUT" && elem.type === "file") {
        var attachment = await u.attachResumeToFileInput(elem, activeApplyContext, defaultResume);
        if (attachment.attached) {
          filledFields.push({ field: getDescriptor(elem) || "resume_upload", valueSource: "resume_upload" });
          await sleep(perUploadDelayMs);
        } else {
          manualReviewReasons.push("resume_upload:" + attachment.reason);
        }
        continue;
      }

      // Plain text input — map descriptor to profile value.
      var profileValue = u.chooseProfileValue(desc, profile);
      if (profileValue && u.setElementValue(elem, profileValue, stripLongDash)) {
        filledFields.push({ field: desc, valueSource: "profile" });
        await sleep(perFieldDelayMs);
      }
    }

    return {
      ok: true,
      atsType: "workday",
      authState: u.detectAuthState(),
      filledFieldCount: filledFields.length,
      generatedAnswerCount: generatedAnswers.length,
      manualReviewRequired: manualReviewReasons.length > 0,
      manualReviewReasons: manualReviewReasons,
      filledFields: filledFields,
      generatedAnswers: generatedAnswers,
      htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000)
    };
  };
}
