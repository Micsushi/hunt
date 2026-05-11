// Workday ATS adapter.
// Exports createWorkdayFillFunction() - a factory that returns a self-contained
// async function suitable for chrome.scripting.executeScript func:.
// The returned function must not close over any module-scope variables because
// Chrome serialises it via Function.prototype.toString() before injection.
// All shared logic lives in window.__huntApplyUtils (injected.js).
export function createWorkdayFillFunction() {
  return async function workdayFill({
    profile,
    settings,
    activeApplyContext,
    defaultResume,
  }) {
    var u = window.__huntApplyUtils;
    if (!u) {
      return {
        ok: false,
        reason: "missing_utils",
        message:
          "Shared fill utils (injected.js) were not injected before this adapter ran.",
      };
    }

    var perFieldDelayMs = 25;
    var perUploadDelayMs = 75;
    var sleep = function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    };
    var stripLongDash = settings.stripLongDash !== false;

    // Workday uses data-automation-id="formField" as the canonical field container.
    var containerSelectors = [
      "label",
      '[data-automation-id="formField"]',
      '[role="group"]',
    ];
    var getDescriptor = function (el) {
      return u.getDescriptor(el, containerSelectors);
    };
    var descriptorHasAny = function (descriptor, phrases) {
      var desc = u.normalizeText(descriptor).toLowerCase();
      return phrases.some(function (phrase) {
        return desc.includes(phrase);
      });
    };
    var isExactCityField = function (el, descriptor) {
      var key = u
        .normalizeText(
          [el?.name, el?.id, el?.getAttribute?.("aria-label")]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      var desc = u.normalizeText(descriptor).toLowerCase();
      return (
        key === "city" ||
        key.endsWith("--city") ||
        key.includes(" address--city") ||
        (desc.includes("city*") && !desc.includes("postal code"))
      );
    };
    var isExactProvinceField = function (el, descriptor) {
      var key = u
        .normalizeText(
          [el?.name, el?.id, el?.getAttribute?.("aria-label")]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      var desc = u.normalizeText(descriptor).toLowerCase();
      return (
        key.includes("province") ||
        key.includes("territory") ||
        desc.includes("province or territory")
      );
    };
    var shouldSkipProfileFill = function (el, descriptor) {
      if (
        isExactCityField(el, descriptor) ||
        isExactProvinceField(el, descriptor)
      ) {
        return false;
      }
      return descriptorHasAny(descriptor, [
        "address line",
        "postal code",
        "zip code",
        "work experience",
        "job title",
        "company",
        "role description",
        "education",
        "school or university",
        "degree",
        "field of study",
        "overall result",
        "gpa",
      ]);
    };
    var shouldSkipGeneratedAnswer = function (descriptor) {
      return descriptorHasAny(descriptor, [
        "work experience",
        "role description",
        "education",
        "school or university",
        "cover letter",
      ]);
    };
    var isResumeFileInput = function (descriptor) {
      return (
        !descriptorHasAny(descriptor, ["cover letter"]) &&
        descriptorHasAny(descriptor, ["resume", "cv", "curriculum vitae"])
      );
    };
    var getApplicationSource = function () {
      var explicitSource = u.normalizeText(activeApplyContext.source);
      if (explicitSource) {
        return explicitSource;
      }
      var url = new URL(window.location.href);
      var source = u.normalizeText(url.searchParams.get("source"));
      if (source) {
        return source;
      }
      var src = u.normalizeText(url.searchParams.get("src"));
      if (src) {
        return src;
      }
      return "";
    };
    var profileWithContext = Object.assign({}, profile, {
      applicationSource: getApplicationSource(),
    });

    var filledFields = [];
    var generatedAnswers = [];
    var manualReviewReasons = [];
    var fieldInventory = [];
    var resumeUploadDone = false;
    var rectSummary = function (rect) {
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    var inventoryEntry = function (candidate, descriptor, extra) {
      var el =
        candidate.kind === "radioGroup"
          ? candidate.radios[0]
          : candidate.element;
      return Object.assign(
        {
          kind: candidate.kind,
          tagName: el?.tagName || "",
          type: el?.type || "",
          name: el?.name || "",
          id: el?.id || "",
          descriptor: descriptor || "",
          questionHash: u.buildQuestionHash(descriptor || ""),
          required: Boolean(
            el?.required || el?.getAttribute("aria-required") === "true",
          ),
          filled: false,
          skippedReason: "",
          valueSource: "",
          options: [],
          rect: rectSummary(candidate.rect),
        },
        extra || {},
      );
    };
    var hasResumeData = Boolean(
      activeApplyContext.selectedResumeDataUrl || defaultResume.pdfDataUrl,
    );
    var pageLooksLikeResumeUpload = function () {
      var text = u
        .normalizeText(document.body ? document.body.innerText : "")
        .toLowerCase();
      return (
        text.includes("resume") ||
        text.includes("cv") ||
        text.includes("drop file") ||
        text.includes("select file") ||
        text.includes("upload")
      );
    };

    if (
      activeApplyContext.jobId &&
      activeApplyContext.selectedResumeReadyForC3 === false
    ) {
      manualReviewReasons.push("resume_not_ready_for_c3");
    }
    if (!hasResumeData && pageLooksLikeResumeUpload()) {
      manualReviewReasons.push("resume_upload:missing_resume_data");
    }

    // Collect every visible fillable element on the current step.
    var textInputs = u.getVisibleElements(
      'input:not([type="hidden"]):not([type="file"])',
    );
    var textareas = u.getVisibleElements("textarea");
    var selects = u.getVisibleElements("select");
    var fileInputs = Array.from(
      document.querySelectorAll('input[type="file"]'),
    ).filter(function (el) {
      return !el.disabled;
    });
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
      candidates.push({
        kind: "element",
        element: el,
        rect: el.getBoundingClientRect(),
      });
    }
    radiosByName.forEach(function (group) {
      var anchor = group[0];
      if (anchor) {
        candidates.push({
          kind: "radioGroup",
          radios: group,
          rect: anchor.getBoundingClientRect(),
        });
      }
    });

    var sorted = u.sortCandidatesByPosition(candidates);

    for (var k = 0; k < sorted.length; k++) {
      var candidate = sorted[k];

      if (candidate.kind === "radioGroup") {
        var descriptor = candidate.radios
          .map(function (r) {
            return getDescriptor(r);
          })
          .join(" ")
          .toLowerCase();
        var radioInventory = inventoryEntry(candidate, descriptor);
        fieldInventory.push(radioInventory);
        if (
          u.fillRadioGroup(
            candidate.radios,
            descriptor,
            profile,
            containerSelectors,
          )
        ) {
          radioInventory.filled = true;
          radioInventory.valueSource = "radio_rule";
          filledFields.push({ field: descriptor, valueSource: "radio_rule" });
          await sleep(perFieldDelayMs);
        } else {
          radioInventory.skippedReason = "no_known_match";
        }
        continue;
      }

      var elem = candidate.element;
      var desc = getDescriptor(elem);
      var elementInventory = inventoryEntry(candidate, desc);
      fieldInventory.push(elementInventory);
      if (!desc) {
        elementInventory.skippedReason = "missing_descriptor";
        continue;
      }

      if (elem.tagName === "INPUT" && elem.type === "checkbox") {
        elementInventory.skippedReason = "unsupported_checkbox";
        continue;
      }

      if (elem.tagName === "TEXTAREA") {
        if (shouldSkipGeneratedAnswer(desc)) {
          elementInventory.skippedReason = "unsafe_generated_answer_context";
          continue;
        }
        // Skip already-filled or generation-disabled.
        if (elem.value || settings.allowGeneratedAnswers === false) {
          elementInventory.skippedReason = elem.value
            ? "already_filled"
            : "generated_answers_disabled";
          continue;
        }
        var answer = u.generateAnswer(
          desc,
          profile,
          activeApplyContext,
          stripLongDash,
        );
        if (u.setElementValue(elem, answer.answerText, stripLongDash)) {
          elementInventory.filled = true;
          elementInventory.valueSource = "generated_answer";
          var qHash = u.buildQuestionHash(desc);
          generatedAnswers.push({
            questionHash: qHash,
            questionText: desc,
            answerText: answer.answerText,
            answerSource: "generated",
            confidence: answer.confidence,
            manualReviewRequired: answer.manualReviewRequired,
          });
          filledFields.push({ field: desc, valueSource: "generated_answer" });
          if (
            settings.flagLowConfidenceAnswers !== false &&
            answer.manualReviewRequired
          ) {
            manualReviewReasons.push("low_confidence_answer:" + qHash);
          }
          await sleep(perFieldDelayMs);
        }
        continue;
      }

      if (elem.tagName === "SELECT") {
        var selectResult = u.fillSelectElement(
          elem,
          desc,
          profileWithContext,
          stripLongDash,
        );
        if (selectResult.filled) {
          elementInventory.filled = true;
          elementInventory.valueSource =
            selectResult.valueSource || "select_rule";
          filledFields.push({
            field: desc,
            valueSource: elementInventory.valueSource,
          });
          await sleep(perFieldDelayMs);
        } else {
          elementInventory.skippedReason =
            selectResult.reason || "no_known_match";
        }
        continue;
      }

      if (
        elem.getAttribute("role") === "combobox" ||
        elem.getAttribute("aria-haspopup") === "listbox" ||
        elem.getAttribute("aria-autocomplete") === "list" ||
        elem.closest(".select__container")
      ) {
        var comboResult = await u.fillComboboxElement(
          elem,
          desc,
          profileWithContext,
          stripLongDash,
        );
        if (comboResult.filled) {
          elementInventory.filled = true;
          elementInventory.valueSource =
            comboResult.valueSource || "combobox_rule";
          filledFields.push({
            field: desc,
            valueSource: elementInventory.valueSource,
          });
          await sleep(perFieldDelayMs);
        } else {
          elementInventory.skippedReason =
            comboResult.reason || "no_known_match";
        }
        continue;
      }

      if (elem.tagName === "INPUT" && elem.type === "file") {
        if (resumeUploadDone) {
          elementInventory.skippedReason = "resume_already_uploaded";
          continue;
        }
        if (!isResumeFileInput(desc)) {
          elementInventory.skippedReason = "not_resume_input";
          continue;
        }
        var attachment = await u.attachResumeToFileInput(
          elem,
          activeApplyContext,
          defaultResume,
        );
        if (attachment.attached) {
          elementInventory.filled = true;
          elementInventory.valueSource = "resume_upload";
          resumeUploadDone = true;
          filledFields.push({
            field: getDescriptor(elem) || "resume_upload",
            valueSource: "resume_upload",
          });
          await sleep(perUploadDelayMs);
        } else {
          elementInventory.skippedReason = "resume_upload:" + attachment.reason;
          manualReviewReasons.push("resume_upload:" + attachment.reason);
        }
        continue;
      }

      // Plain text input - map descriptor to profile value.
      if (shouldSkipProfileFill(elem, desc)) {
        elementInventory.skippedReason = "unsafe_profile_context";
        continue;
      }
      if (isExactCityField(elem, desc) && profile.location) {
        var cityValue = u.normalizeText(profile.location).split(",")[0].trim();
        if (cityValue && u.setElementValue(elem, cityValue, stripLongDash)) {
          elementInventory.filled = true;
          elementInventory.valueSource = "profile:location";
          filledFields.push({
            field: desc,
            valueSource: elementInventory.valueSource,
          });
          await sleep(perFieldDelayMs);
          continue;
        }
      }
      var profileMatch = u.chooseProfileMatch
        ? u.chooseProfileMatch(desc, profile)
        : null;
      var profileValue = profileMatch
        ? profileMatch.value
        : u.chooseProfileValue(desc, profile);
      if (
        profileValue &&
        u.setElementValue(elem, profileValue, stripLongDash)
      ) {
        elementInventory.filled = true;
        elementInventory.valueSource = profileMatch
          ? profileMatch.key
          : "profile";
        filledFields.push({
          field: desc,
          valueSource: elementInventory.valueSource,
        });
        await sleep(perFieldDelayMs);
      } else {
        elementInventory.skippedReason = "no_known_match";
      }
    }

    return {
      ok: true,
      atsType: "workday",
      frameUrl: window.location.href,
      authState: u.detectAuthState(),
      filledFieldCount: filledFields.length,
      generatedAnswerCount: generatedAnswers.length,
      manualReviewRequired: manualReviewReasons.length > 0,
      manualReviewReasons: manualReviewReasons,
      filledFields: filledFields,
      fieldInventory: fieldInventory,
      generatedAnswers: generatedAnswers,
      htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000),
    };
  };
}
