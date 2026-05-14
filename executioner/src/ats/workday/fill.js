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
    fillRunId,
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
    var fillStartedAt = Date.now();
    var fillBudgetMs = 30000;
    var fillCancelled = function () {
      return Boolean(
        window.__huntApplyCancelAllFills ||
        (fillRunId && window.__huntApplyCancelFillRunId === fillRunId),
      );
    };
    var fillBudgetExceeded = function () {
      return fillCancelled() || Date.now() - fillStartedAt >= fillBudgetMs;
    };
    var stripLongDash = settings.stripLongDash !== false;
    var fillRequiredOnly = settings.fillRequiredOnly !== false;

    // Workday uses data-automation-id="formField" as the canonical field container.
    var containerSelectors = [
      "label",
      '[data-automation-id="formField"]',
      '[role="group"]',
    ];
    var getDescriptor = function (el) {
      var descriptor = u.getDescriptor(el, containerSelectors);
      var key = u.normalizeText(descriptor).toLowerCase();
      if (
        el?.tagName === "BUTTON" &&
        key.includes("required") &&
        (String(el.id || "").includes("secondaryQuestionnaire--") ||
          String(el.id || "").includes("primaryQuestionnaire--"))
      ) {
        var formField = el.closest?.('[data-automation-id="formField"]');
        var formFieldText = u.normalizeText(
          formField ? formField.innerText || formField.textContent || "" : "",
        );
        var labelledGroup = el.closest?.('[role="group"][aria-label]');
        var groupLabel = u.normalizeText(
          labelledGroup ? labelledGroup.getAttribute("aria-label") || "" : "",
        );
        if (groupLabel) {
          return u.normalizeText([descriptor, groupLabel].join(" "));
        }
        var fieldset = el.closest?.("fieldset");
        var fieldsetText = u.normalizeText(
          fieldset ? fieldset.innerText || fieldset.textContent || "" : "",
        );
        if (fieldsetText) {
          return u.normalizeText([descriptor, fieldsetText].join(" "));
        }
        if (!formFieldText) {
          var parent = el.parentElement;
          var parentTexts = [];
          for (var idx = 0; parent && idx < 8; idx++) {
            var parentText = u.normalizeText(
              parent.innerText || parent.textContent || "",
            );
            if (
              parentText &&
              parentText.length > descriptor.length &&
              parentText.length <= 8000
            ) {
              parentTexts.push(parentText);
            }
            parent = parent.parentElement;
          }
          parentTexts.sort(function (a, b) {
            return a.length - b.length;
          });
          formFieldText = parentTexts[0] || "";
        }
        if (formFieldText) {
          descriptor = u.normalizeText(
            [descriptor, formFieldText.slice(0, 4000)].join(" "),
          );
        }
      }
      return descriptor;
    };
    var descriptorHasAny = function (descriptor, phrases) {
      var desc = u.normalizeText(descriptor).toLowerCase();
      return phrases.some(function (phrase) {
        return desc.includes(phrase);
      });
    };
    var requiredTextFor = function (el, descriptor) {
      return u
        .normalizeText(
          [
            descriptor,
            el?.getAttribute?.("aria-label"),
            el?.getAttribute?.("placeholder"),
            el?.getAttribute?.("data-required"),
            u.getContainerText
              ? u.getContainerText(el, containerSelectors)
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
    };
    var isRequiredField = function (el, descriptor) {
      var exactFieldKey = u
        .normalizeText(
          [el?.id, el?.name, el?.getAttribute?.("aria-label")]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      if (
        exactFieldKey.includes("preferredcheck") ||
        exactFieldKey.includes("preferred name") ||
        exactFieldKey.includes("phonenumber--extension") ||
        /\bphone extension\b/.test(exactFieldKey) ||
        exactFieldKey.includes("addressline2") ||
        /\baddress line 2\b/.test(exactFieldKey)
      ) {
        return false;
      }
      if (el?.required || el?.getAttribute?.("aria-required") === "true") {
        return true;
      }
      var dataRequired = u
        .normalizeText(el?.getAttribute?.("data-required") || "")
        .toLowerCase();
      if (
        dataRequired === "true" ||
        dataRequired === "required" ||
        dataRequired === "yes"
      ) {
        return true;
      }
      var requiredText = requiredTextFor(el, descriptor);
      return requiredText.includes("*") || /\brequired\b/.test(requiredText);
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
      var key = u
        .normalizeText(
          [el?.name, el?.id, el?.getAttribute?.("aria-label")]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      var hasAddressLine1Value = u.normalizeText(
        profileWithContext.addressLine1,
      );
      var hasAddressLine2Value = u.normalizeText(
        profileWithContext.addressLine2,
      );
      var hasAddressLineValue = hasAddressLine1Value || hasAddressLine2Value;
      var hasPostalCodeValue = u.normalizeText(profileWithContext.postalCode);
      if (
        (key.includes("addressline1") || key.includes("address line 1")) &&
        !hasAddressLine1Value
      ) {
        return true;
      }
      if (
        (key.includes("addressline2") || key.includes("address line 2")) &&
        !hasAddressLine2Value
      ) {
        return true;
      }
      if (
        ((key.includes("addressline") || key.includes("address line")) &&
          !hasAddressLineValue) ||
        ((key.includes("postalcode") ||
          key.includes("postal code") ||
          key.includes("zip")) &&
          !hasPostalCodeValue) ||
        key === "extension" ||
        key.endsWith("--extension") ||
        key.includes("phone extension")
      ) {
        return true;
      }
      if (
        isExactCityField(el, descriptor) ||
        isExactProvinceField(el, descriptor)
      ) {
        return false;
      }
      var descriptorBlocked = descriptorHasAny(descriptor, [
        "address line",
        "addressline",
        "postal code",
        "postalcode",
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
      if (!descriptorBlocked) {
        return false;
      }
      var desc = u.normalizeText(descriptor).toLowerCase();
      if (
        hasAddressLineValue &&
        (desc.includes("address line") || desc.includes("addressline"))
      ) {
        return false;
      }
      if (
        hasPostalCodeValue &&
        (desc.includes("postal code") ||
          desc.includes("postalcode") ||
          desc.includes("zip code"))
      ) {
        return false;
      }
      return true;
    };
    var shouldSkipGeneratedAnswer = function (descriptor) {
      return descriptorHasAny(descriptor, [
        "work experience",
        "role description",
        "education",
        "school or university",
        "cover letter",
        "if yes",
        "referral",
        "referred",
        "employee who referred",
        "known this person",
      ]);
    };
    var isResumeFileInput = function (descriptor) {
      if (
        descriptorHasAny(descriptor, ["cover letter"]) &&
        !descriptorHasAny(descriptor, [
          "resume",
          "resume/cv",
          "cv",
          "curriculum vitae",
        ])
      ) {
        return false;
      }
      return (
        descriptorHasAny(descriptor, ["resume", "cv", "curriculum vitae"]) ||
        (pageLooksLikeResumeUpload() &&
          descriptorHasAny(descriptor, [
            "drop file",
            "select file",
            "upload",
            "file-upload",
          ]))
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
    var bestEffortWarnings = [];
    var fieldInventory = [];
    var interactionTrace = [];
    var traceTruncated = false;
    var traceInteractionLimit = 1000;
    var resumeUploadDone = false;
    var pushManualReviewReason = function (reason) {
      if (reason && !manualReviewReasons.includes(reason)) {
        manualReviewReasons.push(reason);
      }
    };
    var pushBestEffortWarning = function (warning) {
      var text = u.normalizeText(warning || "").slice(0, 500);
      if (text && !bestEffortWarnings.includes(text)) {
        bestEffortWarnings.push(text);
      }
    };
    var finalizeRequiredFieldReview = function () {
      var checkboxGroupHasSelection = function (entry) {
        if (entry.type !== "checkbox" || !entry.id) {
          return false;
        }
        var parts = String(entry.id).split("-");
        var suffix = parts.length > 1 ? parts[parts.length - 1] : "";
        if (!suffix) {
          return false;
        }
        return Boolean(
          document.querySelector(
            'input[type="checkbox"][id$="-' + CSS.escape(suffix) + '"]:checked',
          ),
        );
      };
      fieldInventory.forEach(function (entry) {
        if (
          entry.type === "radio" &&
          entry.name &&
          document.querySelector(
            'input[type="radio"][name="' +
              CSS.escape(entry.name) +
              '"]:checked',
          )
        ) {
          entry.filled = true;
          entry.skippedReason = entry.skippedReason || "radio_group_selected";
        }
        if (checkboxGroupHasSelection(entry)) {
          entry.filled = true;
          entry.skippedReason =
            entry.skippedReason || "checkbox_group_selected";
        }
        if (
          !entry.required ||
          entry.filled ||
          entry.skippedReason === "not_required"
        ) {
          return;
        }
        pushManualReviewReason(
          "required_field_unresolved:" + (entry.skippedReason || "not_filled"),
        );
      });
    };
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
          required: Boolean(isRequiredField(el, descriptor)),
          filled: false,
          skippedReason: "",
          valueSource: "",
          options: [],
          rect: rectSummary(candidate.rect),
        },
        extra || {},
      );
    };
    var elementTraceSummary = function (target) {
      if (!target || !target.getBoundingClientRect) {
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
      var rect = target.getBoundingClientRect();
      return {
        tagName: target.tagName || "",
        type: target.type || "",
        id: target.id || "",
        name: target.name || "",
        text: u
          .normalizeText(target.innerText || target.textContent || "")
          .slice(0, 160),
        ariaLabel: u
          .normalizeText(target.getAttribute?.("aria-label") || "")
          .slice(0, 160),
        rect: rectSummary(rect),
      };
    };
    var traceInteraction = function (action, target, detail) {
      if (interactionTrace.length >= traceInteractionLimit) {
        traceTruncated = true;
        return;
      }
      interactionTrace.push(
        Object.assign(
          {
            index: interactionTrace.length + 1,
            action: action,
            target: elementTraceSummary(target),
          },
          detail || {},
        ),
      );
    };
    var fieldTraceSummary = function (entry, detail) {
      return Object.assign(
        {
          fieldId: entry?.id || "",
          fieldName: entry?.name || "",
          descriptor: u.normalizeText(entry?.descriptor || "").slice(0, 240),
          required: Boolean(entry?.required),
          valueSource: entry?.valueSource || "",
          skippedReason: entry?.skippedReason || "",
          kind: entry?.kind || "",
        },
        detail || {},
      );
    };
    var traceFieldEvent = function (action, entry, target, detail) {
      traceInteraction(action, target, fieldTraceSummary(entry, detail));
    };
    var markFieldSkipped = function (entry, target, reason, detail) {
      entry.skippedReason = reason || "skipped";
      traceFieldEvent(
        "field_skipped",
        entry,
        target,
        Object.assign({ reason: entry.skippedReason }, detail || {}),
      );
    };
    var markFieldFilled = function (entry, target, valueSource, detail) {
      entry.filled = true;
      entry.valueSource = valueSource || entry.valueSource || "unknown";
      if (detail?.bestEffortWarning) {
        entry.bestEffortWarning = detail.bestEffortWarning;
        pushBestEffortWarning(detail.bestEffortWarning);
      }
      traceFieldEvent(
        "field_filled",
        entry,
        target,
        Object.assign({ reason: "field_counted_changed" }, detail || {}),
      );
    };
    var markFieldAlreadyFilled = function (entry, target, valueSource, detail) {
      entry.filled = true;
      entry.valueSource = valueSource || entry.valueSource || "existing_value";
      entry.skippedReason = "already_filled";
      traceFieldEvent(
        "field_already_filled",
        entry,
        target,
        Object.assign({ reason: "existing_value_matches" }, detail || {}),
      );
    };
    var currentValueForTarget = function (target, detail) {
      if (detail?.currentValue) {
        return u.normalizeText(detail.currentValue).slice(0, 500);
      }
      if (detail?.defaultSelectedOption) {
        return u.normalizeText(detail.defaultSelectedOption).slice(0, 500);
      }
      if (detail?.selectedOption) {
        return u.normalizeText(detail.selectedOption).slice(0, 500);
      }
      if (!target) {
        return "";
      }
      if ("value" in target) {
        return u.normalizeText(target.value || "").slice(0, 500);
      }
      if (target.type === "checkbox" || target.type === "radio") {
        return target.checked ? "checked" : "unchecked";
      }
      return u
        .normalizeText(
          target.innerText ||
            target.textContent ||
            target.getAttribute?.("aria-label") ||
            "",
        )
        .slice(0, 500);
    };
    var pushFilledField = function (field, valueSource, entry, target, detail) {
      filledFields.push({
        field: field,
        valueSource: valueSource,
        value: currentValueForTarget(target, detail),
        id: entry?.id || target?.id || "",
        name: entry?.name || target?.name || "",
        type: entry?.type || target?.type || "",
        tagName: entry?.tagName || target?.tagName || "",
        descriptor: entry?.descriptor || field || "",
        bestEffortWarning: detail?.bestEffortWarning || "",
        selectedOption:
          detail?.defaultSelectedOption || detail?.selectedOption || "",
      });
      if (entry) {
        traceFieldEvent(
          "field_count_recorded",
          entry,
          target,
          Object.assign(
            {
              reason: "filled_fields_push",
              filledFieldCount: filledFields.length,
              valueSource: valueSource || "",
            },
            detail || {},
          ),
        );
        return;
      }
      traceInteraction(
        "field_count_recorded",
        target || document.body,
        Object.assign(
          {
            reason: "filled_fields_push",
            descriptor: u.normalizeText(field || "").slice(0, 240),
            filledFieldCount: filledFields.length,
            valueSource: valueSource || "",
          },
          detail || {},
        ),
      );
    };
    var previousTraceInteraction = u.traceInteraction;
    u.traceInteraction = traceInteraction;
    try {
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
      var keyDetails = function (keyName) {
        var map = {
          Backspace: { code: "Backspace", keyCode: 8 },
          Delete: { code: "Delete", keyCode: 46 },
          Enter: { code: "Enter", keyCode: 13 },
          Escape: { code: "Escape", keyCode: 27 },
          ArrowDown: { code: "ArrowDown", keyCode: 40 },
          ArrowUp: { code: "ArrowUp", keyCode: 38 },
          Home: { code: "Home", keyCode: 36 },
          End: { code: "End", keyCode: 35 },
          " ": { code: "Space", keyCode: 32 },
          Space: { code: "Space", keyCode: 32 },
        };
        if (map[keyName]) {
          return map[keyName];
        }
        if (String(keyName || "").length === 1) {
          return {
            code: "Key" + keyName.toUpperCase(),
            keyCode: keyName.toUpperCase().charCodeAt(0),
          };
        }
        return map[keyName] || { code: keyName, keyCode: 0 };
      };
      var keyOn = function (target, keyName, reason) {
        if (!target || typeof target.dispatchEvent !== "function") {
          return;
        }
        traceInteraction("key", target, { key: keyName, reason: reason || "" });
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
      var printableKeyOn = function (target, char, reason) {
        if (!target || typeof target.dispatchEvent !== "function" || !char) {
          return;
        }
        traceInteraction("key", target, { key: char, reason: reason || "" });
        var details = keyDetails(char);
        var base = {
          key: char,
          code: details.code,
          keyCode: details.keyCode,
          which: details.keyCode,
          charCode: details.keyCode,
          bubbles: true,
          cancelable: true,
        };
        target.dispatchEvent(new KeyboardEvent("keydown", base));
        target.dispatchEvent(new KeyboardEvent("keypress", base));
        target.dispatchEvent(new KeyboardEvent("keyup", base));
      };
      var typeaheadOn = async function (target, text, reason) {
        var value = u.normalizeText(text || "", stripLongDash);
        if (!target || !value) {
          return;
        }
        if (typeof target.focus === "function") {
          target.focus();
        }
        for (var idx = 0; idx < value.length; idx++) {
          printableKeyOn(target, value[idx], reason);
          await sleep(25);
        }
      };
      var getActiveDescendantOption = function (owner) {
        var activeId =
          owner?.getAttribute?.("aria-activedescendant") ||
          document.activeElement?.getAttribute?.("aria-activedescendant") ||
          "";
        if (!activeId) {
          return null;
        }
        return document.getElementById(activeId) || null;
      };
      var pointerEvent = function (target, type, rect) {
        var isClick =
          type === "click" ||
          type === "mousedown" ||
          type === "mouseup" ||
          type === "pointerdown" ||
          type === "pointerup";
        var init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          button: 0,
          buttons: type.includes("down") ? 1 : 0,
          detail: isClick ? 1 : 0,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
          screenX: Math.round(rect.left + rect.width / 2),
          screenY: Math.round(rect.top + rect.height / 2),
        };
        var EventCtor =
          window.PointerEvent && type.startsWith("pointer")
            ? window.PointerEvent
            : MouseEvent;
        target.dispatchEvent(new EventCtor(type, init));
      };
      var realisticClick = function (target, reason) {
        if (!target) {
          return;
        }
        if (typeof target.scrollIntoView === "function") {
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        var rect = target.getBoundingClientRect();
        traceInteraction("hover", target, { reason: reason || "" });
        traceInteraction("click", target, { reason: reason || "" });
        [
          "mouseover",
          "mousemove",
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ].forEach(function (type) {
          pointerEvent(target, type, rect);
        });
      };
      var triggerReactClickHandler = function (el) {
        try {
          var fiberKey = Object.keys(el || {}).find(function (k) {
            return (
              k.startsWith("__reactFiber$") ||
              k.startsWith("__reactInternalInstance$")
            );
          });
          if (!fiberKey) {
            return false;
          }
          var fiber = el[fiberKey];
          var node = fiber;
          while (node) {
            var props = node.memoizedProps || node.pendingProps;
            if (props) {
              var mockEvt = {
                type: "click",
                target: el,
                currentTarget: el,
                bubbles: true,
                preventDefault: function () {},
                stopPropagation: function () {},
                isPropagationStopped: function () {
                  return false;
                },
                isDefaultPrevented: function () {
                  return false;
                },
                nativeEvent: new MouseEvent("click", {
                  bubbles: true,
                  cancelable: true,
                  detail: 1,
                }),
              };
              if (typeof props.onClick === "function") {
                props.onClick(mockEvt);
                return true;
              }
              if (typeof props.onMouseDown === "function") {
                mockEvt.type = "mousedown";
                props.onMouseDown(mockEvt);
                return true;
              }
            }
            node = node.return;
          }
        } catch (_error) {}
        return false;
      };
      var triggerReactClickDeep = function (el) {
        if (!el) {
          return false;
        }
        var candidates = [el].concat(
          Array.from(
            el.querySelectorAll?.(
              '[data-automation-id="promptLeafNode"], [data-uxi-widget-type], span, div',
            ) || [],
          ).slice(0, 8),
        );
        for (var ci = 0; ci < candidates.length; ci++) {
          if (triggerReactClickHandler(candidates[ci])) {
            return true;
          }
        }
        return false;
      };
      var closeOpenMenus = async function () {
        var openMenus = Array.from(
          document.querySelectorAll('[aria-expanded="true"], [role="listbox"]'),
        );
        traceInteraction("dropdown_close_start", document.activeElement, {
          reason: "close_open_menus",
          openMenuCount: openMenus.length,
        });
        keyOn(document.activeElement, "Escape", "close_open_menus");
        keyOn(document.body, "Escape", "close_open_menus");
        keyOn(document, "Escape", "close_open_menus");
        keyOn(window, "Escape", "close_open_menus");
        openMenus.forEach(function (el) {
          keyOn(el, "Escape", "close_open_menus");
          if (el.hasAttribute && el.hasAttribute("aria-expanded")) {
            el.setAttribute("aria-expanded", "false");
          }
          if (el.getAttribute && el.getAttribute("role") === "listbox") {
            el.setAttribute("aria-hidden", "true");
            el.hidden = true;
            el.style.display = "none";
            el.style.visibility = "hidden";
            el.style.pointerEvents = "none";
          }
          if (typeof el.blur === "function") {
            el.blur();
          }
        });
        if (
          document.activeElement &&
          typeof document.activeElement.blur === "function"
        ) {
          document.activeElement.blur();
        }
        var outside = document.body || document.documentElement;
        if (outside) {
          ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
            function (type) {
              outside.dispatchEvent(
                new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  clientX: 4,
                  clientY: 4,
                }),
              );
            },
          );
        }
        await sleep(80);
        traceInteraction("dropdown_close_end", document.activeElement, {
          reason: "close_open_menus",
          openMenuCount: openMenus.length,
          remainingOpenMenuCount: document.querySelectorAll(
            '[aria-expanded="true"], [role="listbox"]:not([aria-hidden="true"])',
          ).length,
        });
      };
      var visibleOptionCandidates = function () {
        return Array.from(document.querySelectorAll('[role="option"]')).filter(
          function (option) {
            var style = window.getComputedStyle(option);
            var rect = option.getBoundingClientRect();
            return (
              option.getAttribute("aria-disabled") !== "true" &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          },
        );
      };
      var optionTextList = function (options) {
        return (options || [])
          .map(function (option) {
            return u.normalizeText(
              option.innerText || option.textContent || "",
              stripLongDash,
            );
          })
          .filter(Boolean);
      };
      var waitForVisibleOptions = async function (minimumCount) {
        var required = minimumCount || 1;
        for (var attempt = 0; attempt < 5; attempt++) {
          var options = visibleOptionCandidates();
          if (options.length >= required) {
            return options;
          }
          await sleep(60);
        }
        return visibleOptionCandidates();
      };
      var isPlaceholderText = function (value) {
        var text = u.normalizeText(value).toLowerCase();
        return !text || text === "select one" || text === "select...";
      };
      var textInputValueMatches = function (el, value) {
        var current = u
          .normalizeText(
            el.isContentEditable || el.getAttribute("role") === "textbox"
              ? el.textContent || ""
              : el.value || "",
            stripLongDash,
          )
          .toLowerCase();
        var intended = u
          .normalizeText(value || "", stripLongDash)
          .toLowerCase();
        return Boolean(current && intended && current === intended);
      };
      var markTextInputAlreadyFilled = function (
        elementInventory,
        elem,
        desc,
        value,
        valueSource,
      ) {
        if (!textInputValueMatches(elem, value)) {
          return false;
        }
        if (
          elem.getAttribute?.("aria-invalid") === "true" ||
          elem.matches?.('[aria-invalid="true"]')
        ) {
          return false;
        }
        u.dispatchInputEvents(elem);
        markFieldAlreadyFilled(
          elementInventory,
          elem,
          valueSource || "existing_value",
          {
            reason: "text_input_matches_value",
            intendedValue: value || "",
          },
        );
        traceInteraction("already_filled", elem, {
          reason: "text_input_matches_value",
          currentValue: elem.value || elem.textContent || "",
          intendedValue: value || "",
          descriptor: desc,
        });
        return true;
      };
      var setStructuredTextValue = function (el, value) {
        var normalized = normalizeStructuredMultilineText(value);
        if (!normalized) {
          return false;
        }
        if (typeof el.focus === "function") {
          el.focus();
        }
        if (el.isContentEditable || el.getAttribute("role") === "textbox") {
          el.textContent = normalized;
        } else {
          var proto =
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : el instanceof HTMLInputElement
                ? HTMLInputElement.prototype
                : null;
          var setter = proto
            ? Object.getOwnPropertyDescriptor(proto, "value")?.set
            : null;
          if (setter) {
            setter.call(el, normalized);
          } else {
            el.value = normalized;
          }
        }
        u.dispatchInputEvents(el);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return true;
      };
      var normalizeStructuredMultilineText = function (value) {
        return String(value || "")
          .replace(/\r\n?/g, "\n")
          .split("\n")
          .map(function (line) {
            return u.normalizeText(line, stripLongDash);
          })
          .filter(Boolean)
          .join("\n")
          .trim();
      };
      var splitInlineDashBullets = function (value) {
        return normalizeStructuredMultilineText(value)
          .split("\n")
          .flatMap(function (line) {
            return line
              .split(/\s+(?=(?:[-*]|\u2022)\s+[A-Z0-9])/)
              .map(function (part) {
                return part.replace(/^(?:[-*]|\u2022)\s*/, "");
              })
              .map(function (part) {
                return u.normalizeText(part, stripLongDash);
              })
              .filter(Boolean)
              .map(function (part) {
                return "- " + part;
              });
          })
          .join("\n")
          .trim();
      };
      var clearStructuredTextValue = function (el) {
        if (!el) {
          return false;
        }
        if (typeof el.focus === "function") {
          el.focus();
        }
        if (el.isContentEditable || el.getAttribute("role") === "textbox") {
          el.textContent = "";
        } else {
          var proto =
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : el instanceof HTMLInputElement
                ? HTMLInputElement.prototype
                : null;
          var setter = proto
            ? Object.getOwnPropertyDescriptor(proto, "value")?.set
            : null;
          if (setter) {
            setter.call(el, "");
          } else {
            el.value = "";
          }
        }
        u.dispatchInputEvents(el);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        return true;
      };
      var sanitizeWorkdayStructuredText = function (value) {
        return splitInlineDashBullets(value)
          .replace(/\\([$#_{}])/g, "$1")
          .replace(/[<>[\]{}\\]/g, "")
          .trim();
      };
      var chooseExactWorkdayTextProfileMatch = function (elem) {
        var key = u
          .normalizeText(
            [elem?.name, elem?.id, elem?.getAttribute?.("aria-label")]
              .filter(Boolean)
              .join(" "),
          )
          .toLowerCase();
        if (key.includes("addressline1") || key.includes("address line 1")) {
          return {
            value: u.normalizeText(profileWithContext.addressLine1),
            key: "profile:addressLine1",
          };
        }
        if (key.includes("addressline2") || key.includes("address line 2")) {
          return {
            value: u.normalizeText(profileWithContext.addressLine2),
            key: "profile:addressLine2",
          };
        }
        if (
          key.includes("postalcode") ||
          key.includes("postal code") ||
          key.includes("zip")
        ) {
          return {
            value: u.normalizeText(profileWithContext.postalCode),
            key: "profile:postalCode",
          };
        }
        // Latin-script legal name fields (Sun Life and other Workday tenants).
        // These have IDs like "name--legalName--firstName--latinFirstName" or
        // aria-label "Given Name(s) - Latin Script" — the container label may
        // not be captured by getContainerText so match on the element key.
        var nameParts = u
          .normalizeText(profileWithContext.fullName || "")
          .split(" ")
          .filter(Boolean);
        var profileFirstName = nameParts[0] || "";
        var profileLastName = nameParts.slice(1).join(" ") || "";
        if (
          profileFirstName &&
          !key.includes("lastname") &&
          !key.includes("last name") &&
          !key.includes("familyname") &&
          !key.includes("family name") &&
          (key.includes("latin") ||
            key.includes("given name") ||
            key.includes("givenname")) &&
          (key.includes("firstname") ||
            key.includes("first name") ||
            key.includes("givenname") ||
            key.includes("given name"))
        ) {
          return { value: profileFirstName, key: "profile:firstName" };
        }
        if (
          profileLastName &&
          (key.includes("latin") ||
            key.includes("family name") ||
            key.includes("familyname")) &&
          (key.includes("lastname") ||
            key.includes("last name") ||
            key.includes("familyname") ||
            key.includes("family name") ||
            key.includes("surname"))
        ) {
          return { value: profileLastName, key: "profile:lastName" };
        }
        return null;
      };
      var optionScore = function (text, value, choice) {
        return u.optionScoreForChoice
          ? u.optionScoreForChoice(text, value || "", choice, stripLongDash)
          : 0;
      };
      var getButtonValueText = function (button) {
        return u.normalizeText(
          button.innerText ||
            button.textContent ||
            button.getAttribute("value"),
          stripLongDash,
        );
      };
      var buttonValueMatchesChoice = function (button, choice) {
        if (
          button.getAttribute?.("aria-invalid") === "true" ||
          button.matches?.('[aria-invalid="true"]')
        ) {
          return false;
        }
        var current = getButtonValueText(button);
        return (
          !isPlaceholderText(current) && optionScore(current, "", choice) > 0
        );
      };
      var optionText = function (option) {
        return u.normalizeText(
          option?.innerText || option?.textContent || "",
          stripLongDash,
        );
      };
      var defaultOptionScore = function (text, descriptor) {
        var option = u.normalizeText(text, stripLongDash).toLowerCase();
        var desc = u
          .normalizeText(descriptor || "", stripLongDash)
          .toLowerCase();
        if (
          !option ||
          isPlaceholderText(option) ||
          /no (items|options|results)/i.test(option)
        ) {
          return 0;
        }
        var negativeConflict =
          desc.includes("sponsor") ||
          desc.includes("family member") ||
          desc.includes("relative") ||
          desc.includes("domestic partner") ||
          desc.includes("criminal") ||
          desc.includes("convicted") ||
          desc.includes("deloitte") ||
          desc.includes("ernst") ||
          desc.includes("previously worked") ||
          desc.includes("previously been employed");
        var positiveEligibility =
          desc.includes("authorized") ||
          desc.includes("legally") ||
          desc.includes("eligible") ||
          desc.includes("work permit") ||
          desc.includes("clearance") ||
          desc.includes("background") ||
          desc.includes("relocat") ||
          desc.includes("available");
        if (negativeConflict) {
          if (/^no\b|not\b|none\b|never\b/.test(option)) {
            return 120;
          }
          if (/^yes\b/.test(option)) {
            return 10;
          }
        }
        if (positiveEligibility) {
          if (
            option.includes("all canada employers") ||
            option.includes("citizen") ||
            option.includes("permanent resident") ||
            option.includes("meet the requirements") ||
            option.includes("authorized")
          ) {
            return 130;
          }
          if (/^yes\b/.test(option)) {
            return 110;
          }
          if (/^no\b/.test(option)) {
            return 5;
          }
        }
        if (
          desc.includes("gender") ||
          desc.includes("disability") ||
          desc.includes("ethnic") ||
          desc.includes("race") ||
          desc.includes("veteran") ||
          desc.includes("indigenous") ||
          desc.includes("citizenship status")
        ) {
          if (
            option.includes("prefer not") ||
            option.includes("choose not") ||
            option.includes("do not wish") ||
            option.includes("decline")
          ) {
            return 125;
          }
        }
        if (desc.includes("source") || desc.includes("how did you hear")) {
          if (option.includes("job board") || option.includes("linkedin")) {
            return 115;
          }
          if (option.includes("social") || option.includes("career")) {
            return 90;
          }
        }
        if (option === "other") {
          return 30;
        }
        return 50;
      };
      var chooseBestEffortOption = function (options, descriptor) {
        return (options || [])
          .map(function (option, index) {
            return {
              option: option,
              text: optionText(option),
              score: defaultOptionScore(optionText(option), descriptor),
              index: index,
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            if (b.score !== a.score) {
              return b.score - a.score;
            }
            return a.index - b.index;
          })[0];
      };
      var sourceChoiceText = function () {
        var source = u.normalizeText(profileWithContext.applicationSource);
        var normalizedSource = source.toLowerCase().replace(/[_-]+/g, " ");
        if (
          /\blinked\s*in\b/.test(normalizedSource) ||
          /\blinkedin\b/.test(normalizedSource)
        ) {
          return "LinkedIn";
        }
        if (/indeed/i.test(source)) {
          return "Indeed";
        }
        return source;
      };
      var isApplicationSourceField = function (el, descriptor) {
        var key = u
          .normalizeText(
            [
              el?.id,
              el?.name,
              el?.getAttribute?.("aria-label"),
              el?.getAttribute?.("placeholder"),
              descriptor,
            ]
              .filter(Boolean)
              .join(" "),
          )
          .toLowerCase();
        return (
          key.includes("how did you hear about us") ||
          key.includes("source--source") ||
          /\bsource\b/.test(key)
        );
      };
      var isWorkdaySearchInputField = function (el) {
        return (
          el?.tagName === "INPUT" &&
          (el.getAttribute?.("data-automation-id") === "searchBox" ||
            /selectinput|multiselect/i.test(
              el.getAttribute?.("data-uxi-widget-type") || "",
            ) ||
            el.getAttribute?.("role") === "combobox" ||
            el.getAttribute?.("aria-autocomplete") === "list")
        );
      };
      var isKnownWorkdayRadioGroup = function (descriptor) {
        var lowered = u.normalizeText(descriptor || "").toLowerCase();
        return (
          lowered.includes("candidateispreviousworker") ||
          lowered.includes("previously worked") ||
          lowered.includes("previously been employed") ||
          (lowered.includes("student at") && lowered.includes("previous"))
        );
      };
      var isWorkdayPhoneTextField = function (el, descriptor) {
        var key = u
          .normalizeText(
            [el?.id, el?.name, descriptor].filter(Boolean).join(" "),
          )
          .toLowerCase();
        return (
          key.includes("phonenumber--phonenumber") ||
          /\bphone number\b/.test(key)
        );
      };
      var workdayPhoneTextValue = function (el, descriptor, value) {
        if (!isWorkdayPhoneTextField(el, descriptor)) {
          return value;
        }
        var digits = String(value || "").replace(/\D/g, "");
        if (digits.length === 11 && digits.startsWith("1")) {
          digits = digits.slice(1);
        }
        if (digits.length !== 10) {
          return value;
        }
        return (
          "(" +
          digits.slice(0, 3) +
          ") " +
          digits.slice(3, 6) +
          "-" +
          digits.slice(6)
        );
      };
      var workdayDatePartValue = function (el, descriptor, value) {
        var key = u
          .normalizeText(
            [el?.id, el?.name, el?.getAttribute?.("aria-label"), descriptor]
              .filter(Boolean)
              .join(" "),
          )
          .toLowerCase();
        if (!key.includes("datesection")) {
          return value;
        }
        var rawDate =
          u.normalizeText(profileWithContext.desiredStartDate) ||
          u.normalizeText(value) ||
          "2026-05-25";
        var match = rawDate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
        if (!match) {
          return value;
        }
        if (key.includes("datesectionmonth")) {
          return match[2].padStart(2, "0");
        }
        if (key.includes("datesectionday")) {
          return match[3].padStart(2, "0");
        }
        if (key.includes("datesectionyear")) {
          return match[1];
        }
        return value;
      };
      var isWorkdayDatePartField = function (el, descriptor) {
        var key = u
          .normalizeText(
            [el?.id, el?.name, el?.getAttribute?.("aria-label"), descriptor]
              .filter(Boolean)
              .join(" "),
          )
          .toLowerCase();
        return (
          key.includes("datesectionmonth") ||
          key.includes("datesectionday") ||
          key.includes("datesectionyear")
        );
      };
      var setWorkdayTextValue = async function (el, descriptor, value) {
        if (!u.setElementValue(el, value, stripLongDash)) {
          return false;
        }
        if (isWorkdayPhoneTextField(el, descriptor)) {
          u.dispatchInputEvents(el);
          try {
            el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
          } catch (_error) {
            el.dispatchEvent(new Event("focusout", { bubbles: true }));
          }
          keyOn(el, "Tab", "commit_phone_number_text");
          traceInteraction("phone_number_commit_events", el, {
            reason: "commit_phone_number_text",
            currentValue: el.value || "",
            ariaInvalid: el.getAttribute?.("aria-invalid") || "",
            descriptor: descriptor || "",
          });
          await sleep(250);
        }
        return true;
      };
      var searchInputValueMatchesChoice = function (input, choice) {
        var container =
          input.closest?.('[data-automation-id="formField"]') ||
          input.closest?.('[data-automation-id="multiselectInputContainer"]') ||
          input.closest?.('[data-uxi-widget-type="multiselect"]') ||
          input.parentElement;
        var containerText = u.normalizeText(
          [container?.innerText, container?.textContent]
            .filter(Boolean)
            .join(" "),
          stripLongDash,
        );
        if (/0 items selected/i.test(containerText)) {
          return false;
        }
        if (
          /\b[1-9]\d*\s+items?\s+selected\b/i.test(containerText) &&
          optionScore(containerText, "", choice) > 0
        ) {
          return true;
        }
        var selectedText = u.normalizeText(
          Array.from(
            container?.querySelectorAll?.(
              '[role="option"][aria-label*="press delete"], [aria-selected="true"]',
            ) || [],
          )
            .map(function (option) {
              return [
                option.getAttribute?.("aria-label"),
                option.innerText,
                option.textContent,
              ]
                .filter(Boolean)
                .join(" ");
            })
            .join(" "),
          stripLongDash,
        );
        if (selectedText && optionScore(selectedText, "", choice) > 0) {
          return true;
        }
        var isMultiselect =
          !!input.getAttribute?.("data-uxi-multiselect-id") ||
          !!container?.querySelector?.('[aria-label*="items selected"]');
        if (isMultiselect) {
          return false;
        }
        var text = u.normalizeText(
          [input.value, input.getAttribute?.("aria-label"), containerText]
            .filter(Boolean)
            .join(" "),
          stripLongDash,
        );
        return (
          !/0 items selected/i.test(text) && optionScore(text, "", choice) > 0
        );
      };
      var searchInputHasAnySelection = function (input) {
        var container =
          input.closest?.('[data-automation-id="formField"]') ||
          input.closest?.('[data-automation-id="multiselectInputContainer"]') ||
          input.closest?.('[data-uxi-widget-type="multiselect"]') ||
          input.parentElement;
        var text = u.normalizeText(
          [container?.innerText, container?.textContent, input.value]
            .filter(Boolean)
            .join(" "),
          stripLongDash,
        );
        var selectedText = u.normalizeText(
          Array.from(
            container?.querySelectorAll?.(
              '[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"], [aria-label*="press delete"]',
            ) || [],
          )
            .map(function (el) {
              return [
                el.getAttribute?.("aria-label"),
                el.innerText,
                el.textContent,
              ]
                .filter(Boolean)
                .join(" ");
            })
            .join(" "),
          stripLongDash,
        );
        return (
          /\b[1-9]\d*\s+items?\s+selected\b/i.test(text) ||
          (selectedText &&
            !/0 items selected/i.test(text) &&
            !/^expanded$/i.test(selectedText) &&
            !/^search$/i.test(selectedText))
        );
      };
      var fillWorkdaySearchInputChoice = async function (
        input,
        descriptor,
        value,
        source,
      ) {
        if (fillBudgetExceeded()) {
          return { filled: false, reason: "fill_budget_exceeded" };
        }
        var normalized = u.normalizeText(value, stripLongDash);
        if (!normalized) {
          return { filled: false, reason: "empty_choice" };
        }
        var choice = {
          text: normalized,
          aliases: /linked\s*in/i.test(normalized)
            ? [
                normalized,
                "LinkedIn",
                "Social Referral",
                "Social Media",
                "Job Board",
                "Other",
              ]
            : [normalized],
          source: source || "workday_search_input",
          requireOptionMatch: true,
        };
        var childChoice = {
          text: normalized,
          aliases: /linked\s*in/i.test(normalized)
            ? [normalized, "LinkedIn", "Other", "Social Media", "Job Board"]
            : [normalized, "Other"],
          source: source || "workday_search_input",
          requireOptionMatch: true,
        };
        if (/linked\s*in/i.test(normalized)) {
          childChoice.aliases.push("Industry Job Board");
        }
        var searchInputOptionScore = function (optionText, stage) {
          var score = optionScore(optionText, "", choice);
          var loweredOption = u
            .normalizeText(optionText, stripLongDash)
            .toLowerCase();
          if (/linked\s*in/i.test(normalized)) {
            if (/^linked\s*in$/.test(loweredOption)) {
              score += 1000;
            } else if (loweredOption === "social referral") {
              score += 980;
            } else if (
              stage === "child" &&
              loweredOption === "industry job board"
            ) {
              score += 950;
            } else if (stage === "child" && loweredOption === "other") {
              score += 900;
            } else if (loweredOption === "social media") {
              score += 800;
            } else if (loweredOption === "job board") {
              score += 600;
            }
          }
          return score;
        };
        var optionElementId = function (option) {
          return String(
            option?.id ||
              option?.closest?.("[role='option']")?.id ||
              option?.getAttribute?.("data-automation-id") ||
              "",
          );
        };
        var activeListboxForInput = function () {
          var multiSelectId =
            input.getAttribute?.("data-uxi-multiselect-id") || "";
          var listboxes = visibleOptionCandidates()
            .map(function (option) {
              return option.closest?.('[role="listbox"]') || null;
            })
            .filter(Boolean);
          for (var li = 0; li < listboxes.length; li++) {
            var listbox = listboxes[li];
            var associatedWidget =
              listbox.closest?.("[data-associated-widget]") ||
              listbox.parentElement;
            if (
              !multiSelectId ||
              listbox.innerText ||
              associatedWidget?.getAttribute?.("data-associated-widget") ===
                multiSelectId
            ) {
              return listbox;
            }
          }
          return (
            document.querySelector(
              '[data-automation-id="activeListContainer"]',
            ) ||
            document.querySelector('[role="listbox"]') ||
            input
          );
        };
        var keyboardSelectScoredOption = async function (
          stage,
          targetText,
          previousOptionIds,
        ) {
          var stageOptions = visibleOptionCandidates();
          if (!stageOptions.length) {
            if (typeof input.focus === "function") {
              input.focus();
            }
            keyOn(input, "ArrowDown", "keyboard_open_search_options");
            await sleep(250);
            stageOptions = visibleOptionCandidates();
          }
          var previousIds = new Set(previousOptionIds || []);
          var stageScored = stageOptions
            .map(function (option, index) {
              var optionText = u.normalizeText(
                option.innerText || option.textContent || "",
                stripLongDash,
              );
              return {
                option: option,
                text: optionText,
                index: index,
                optionId: optionElementId(option),
                score: searchInputOptionScore(optionText, stage),
              };
            })
            .filter(function (candidate) {
              return (
                candidate.score > 0 && !previousIds.has(candidate.optionId)
              );
            })
            .sort(function (a, b) {
              return b.score - a.score || a.index - b.index;
            });
          var bestKeyboard = stageScored[0] || null;
          traceInteraction("search_input_keyboard_options_scored", input, {
            reason: "score_workday_search_input_keyboard_options",
            stage: stage,
            intendedValue: targetText || normalized,
            optionCount: stageOptions.length,
            matchingOptionCount: stageScored.length,
            optionTexts: optionTextList(stageOptions).slice(0, 20),
            topOptionText: bestKeyboard?.text || "",
            topOptionIndex: bestKeyboard?.index ?? -1,
            topScore: bestKeyboard?.score || 0,
          });
          if (!bestKeyboard) {
            return { selected: false, optionIds: optionTextList(stageOptions) };
          }
          var listbox = activeListboxForInput();
          if (typeof input.focus === "function") {
            input.focus();
          }
          realisticClick(input, "keyboard_open_workday_search_input");
          await sleep(120);
          for (var step = 0; step <= bestKeyboard.index; step++) {
            keyOn(
              listbox || input,
              "ArrowDown",
              "keyboard_select_search_option",
            );
            keyOn(input, "ArrowDown", "keyboard_select_search_option_input");
            await sleep(60);
          }
          keyOn(listbox || input, "Enter", "keyboard_commit_search_option");
          keyOn(input, "Enter", "keyboard_commit_search_option_input");
          await sleep(350);
          return {
            selected: true,
            optionText: bestKeyboard.text,
            optionId: bestKeyboard.optionId,
            optionIds: stageOptions.map(optionElementId).filter(Boolean),
          };
        };
        traceInteraction("search_input_fill_start", input, {
          reason: "workday_search_input_choice",
          descriptor: descriptor || "",
          currentValue: input.value || "",
          intendedValue: normalized,
          valueSource: choice.source,
        });
        if (searchInputValueMatchesChoice(input, choice)) {
          traceInteraction("already_filled", input, {
            reason: "workday_search_input_matches_choice",
            currentValue: input.value || "",
            intendedValue: normalized,
          });
          return {
            filled: false,
            reason: "already_filled",
            valueSource: source,
          };
        }
        if (searchInputValueMatchesChoice(input, childChoice)) {
          traceInteraction("already_filled", input, {
            reason: "workday_search_input_child_matches_choice",
            currentValue: input.value || "",
            intendedValue: normalized,
          });
          return {
            filled: false,
            reason: "already_filled",
            valueSource: source,
          };
        }
        await closeOpenMenus();
        realisticClick(input, "open_workday_search_input");
        if (typeof input.focus === "function") {
          input.focus();
        }
        u.setElementValue(input, "", stripLongDash);
        await sleep(60);
        u.setElementValue(input, normalized, stripLongDash);
        await typeaheadOn(input, normalized, "typeahead_workday_search_input");
        keyOn(input, "ArrowDown", "open_workday_search_input_options");
        var options = await waitForVisibleOptions(1);
        var scored = options
          .map(function (option) {
            var optionText = u.normalizeText(
              option.innerText || option.textContent || "",
              stripLongDash,
            );
            return {
              option: option,
              text: optionText,
              score: searchInputOptionScore(optionText, "parent"),
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          });
        traceInteraction("search_input_options_scored", input, {
          reason: "score_workday_search_input_options",
          descriptor: descriptor || "",
          intendedValue: normalized,
          optionCount: options.length,
          matchingOptionCount: scored.length,
          topOptionText: scored[0]?.text || "",
          topScore: scored[0]?.score || 0,
        });
        var best = scored[0]?.option || null;
        if (!best) {
          await closeOpenMenus();
          return {
            filled: false,
            reason: "no_matching_option",
            options: optionTextList(options),
          };
        }
        realisticClick(best, "select_workday_search_input_option");
        triggerReactClickDeep(best);
        await sleep(250);
        if (
          !searchInputValueMatchesChoice(input, choice) &&
          !searchInputValueMatchesChoice(input, childChoice)
        ) {
          var childOptions = visibleOptionCandidates();
          var childScored = childOptions
            .map(function (option) {
              var optionText = u.normalizeText(
                option.innerText || option.textContent || "",
                stripLongDash,
              );
              return {
                option: option,
                text: optionText,
                score: searchInputOptionScore(optionText, "child"),
              };
            })
            .filter(function (candidate) {
              return candidate.score > 0;
            })
            .sort(function (a, b) {
              return b.score - a.score;
            });
          traceInteraction("search_input_child_options_scored", input, {
            reason: "score_workday_search_input_child_options",
            descriptor: descriptor || "",
            intendedValue: normalized,
            optionCount: childOptions.length,
            matchingOptionCount: childScored.length,
            topOptionText: childScored[0]?.text || "",
            topScore: childScored[0]?.score || 0,
          });
          var childBest = childScored[0]?.option || null;
          if (childBest && childBest !== best) {
            var childInput =
              childBest.querySelector?.('input[type="checkbox"], input') ||
              childBest;
            realisticClick(
              childInput,
              "select_workday_search_input_child_option",
            );
            triggerReactClickDeep(childInput);
            if (
              childInput !== childBest &&
              typeof childInput.click === "function"
            ) {
              childInput.click();
            }
            triggerReactClickDeep(childBest);
            await sleep(250);
          }
        }
        if (
          !searchInputValueMatchesChoice(input, choice) &&
          !searchInputValueMatchesChoice(input, childChoice)
        ) {
          keyOn(input, "Enter", "commit_workday_search_input_option");
          await sleep(250);
        }
        if (
          !searchInputValueMatchesChoice(input, choice) &&
          !searchInputValueMatchesChoice(input, childChoice)
        ) {
          await closeOpenMenus();
          u.setElementValue(input, "", stripLongDash);
          u.dispatchInputEvents(input);
          realisticClick(input, "keyboard_fallback_open_search_input");
          if (typeof input.focus === "function") {
            input.focus();
          }
          keyOn(input, "ArrowDown", "keyboard_fallback_open_options");
          await sleep(350);
          var parentKeyboard = await keyboardSelectScoredOption(
            "parent",
            normalized,
          );
          if (
            !searchInputValueMatchesChoice(input, choice) &&
            !searchInputValueMatchesChoice(input, childChoice)
          ) {
            var childKeyboard = await keyboardSelectScoredOption(
              "child",
              normalized,
              parentKeyboard.optionIds || [],
            );
            if (!childKeyboard.selected) {
              keyOn(input, "Enter", "keyboard_fallback_final_enter");
              await sleep(250);
            }
          }
        }
        if (
          !searchInputValueMatchesChoice(input, choice) &&
          !searchInputValueMatchesChoice(input, childChoice)
        ) {
          await closeOpenMenus();
          u.setElementValue(input, "", stripLongDash);
          u.dispatchInputEvents(input);
          realisticClick(input, "keyboard_any_source_open_search_input");
          if (typeof input.focus === "function") {
            input.focus();
          }
          await sleep(150);
          for (var anyAttempt = 0; anyAttempt < 3; anyAttempt++) {
            keyOn(input, "ArrowDown", "keyboard_any_source_arrow_down");
            await sleep(90);
            keyOn(input, "Enter", "keyboard_any_source_enter");
            await sleep(350);
            if (searchInputHasAnySelection(input)) {
              traceInteraction("search_input_any_selection_committed", input, {
                reason: "keyboard_any_source_selection_committed",
                intendedValue: normalized,
                currentValue: input.value || "",
                valueSource: choice.source,
              });
              await closeOpenMenus();
              return {
                filled: true,
                valueSource: choice.source + ":keyboard_any_selection",
              };
            }
          }
        }
        if (
          searchInputValueMatchesChoice(input, choice) ||
          searchInputValueMatchesChoice(input, childChoice)
        ) {
          traceInteraction("search_input_commit_verified", input, {
            reason: "workday_search_input_choice_committed",
            currentValue: input.value || "",
            intendedValue: normalized,
            valueSource: choice.source,
          });
          await closeOpenMenus();
          return { filled: true, valueSource: choice.source };
        }
        await closeOpenMenus();
        traceInteraction("search_input_commit_failed", input, {
          reason: "workday_search_input_commit_not_verified",
          currentValue: input.value || "",
          intendedValue: normalized,
          valueSource: choice.source,
        });
        return { filled: false, reason: "commit_not_verified" };
      };
      var buttonValueMatchesOption = function (button, option) {
        var current = getButtonValueText(button).toLowerCase();
        var optionText = u
          .normalizeText(
            option?.innerText || option?.textContent || "",
            stripLongDash,
          )
          .toLowerCase();
        return Boolean(
          current &&
          optionText &&
          !isPlaceholderText(current) &&
          (current === optionText ||
            current.includes(optionText) ||
            optionText.includes(current)),
        );
      };
      var waitForButtonChoiceCommit = async function (
        button,
        choice,
        attempts,
      ) {
        var committed = "";
        var committedScore = 0;
        var attemptCount = 0;
        for (
          var verifyAttempt = 0;
          verifyAttempt < (attempts || 20);
          verifyAttempt++
        ) {
          attemptCount = verifyAttempt + 1;
          committed = u.normalizeText(
            button.innerText ||
              button.textContent ||
              button.getAttribute("value"),
            stripLongDash,
          );
          committedScore = optionScore(committed, "", choice);
          if (committedScore > 0) {
            break;
          }
          await sleep(120);
        }
        return {
          committed: committed,
          committedScore: committedScore,
          attemptCount: attemptCount,
        };
      };
      var openWorkdayDropdownWithKeyboard = async function (
        button,
        descriptor,
        choice,
        reason,
      ) {
        if (fillBudgetExceeded()) {
          return [];
        }
        await closeOpenMenus();
        traceInteraction("dropdown_open_attempt", button, {
          reason: reason || "open_workday_dropdown_keyboard",
          descriptor: descriptor || "",
          currentValue: getButtonValueText(button),
          intendedValue: choice?.text || "",
          method: "keyboard",
        });
        if (typeof button.focus === "function") {
          button.focus();
        }
        keyOn(button, "Enter", reason || "open_workday_dropdown_keyboard");
        var options = await waitForVisibleOptions(1);
        if (!options.length) {
          keyOn(
            button,
            "ArrowDown",
            reason || "open_workday_dropdown_keyboard",
          );
          options = await waitForVisibleOptions(1);
        }
        if (fillBudgetExceeded()) {
          return [];
        }
        if (!options.length) {
          keyOn(button, " ", reason || "open_workday_dropdown_keyboard");
          options = await waitForVisibleOptions(1);
        }
        return options;
      };
      var keyboardCommitWorkdayButtonChoice = async function (
        button,
        best,
        choice,
        descriptor,
        scored,
      ) {
        if (!button || !best || !choice) {
          return { committed: false, committedValue: "", committedScore: 0 };
        }
        var intendedText = choice.text || "";
        var bestOptionText = function (option) {
          return u.normalizeText(
            option?.innerText || option?.textContent || "",
            stripLongDash,
          );
        };
        var reacquireBestVisibleOption = function () {
          var candidates = visibleOptionCandidates()
            .map(function (option) {
              return {
                option: option,
                text: bestOptionText(option),
                score: optionScore(bestOptionText(option), "", choice),
              };
            })
            .filter(function (candidate) {
              return candidate.score > 0;
            })
            .sort(function (a, b) {
              return b.score - a.score;
            });
          return candidates[0]?.option || null;
        };
        traceInteraction("dropdown_keyboard_select_attempt", button, {
          reason: "keyboard_commit_workday_button_option",
          descriptor: descriptor || "",
          intendedValue: intendedText,
          optionText: bestOptionText(best).slice(0, 160),
          method: "typeahead_enter",
        });
        if (typeof button.focus === "function") {
          button.focus();
        }
        await typeaheadOn(
          button,
          intendedText,
          "typeahead_workday_button_option",
        );
        await sleep(120);
        var activeOption = getActiveDescendantOption(button);
        traceInteraction(
          "dropdown_keyboard_active_option",
          activeOption || button,
          {
            reason: "after_typeahead_workday_button_option",
            descriptor: descriptor || "",
            intendedValue: intendedText,
            activeOptionText: u
              .normalizeText(
                activeOption?.innerText || activeOption?.textContent || "",
                stripLongDash,
              )
              .slice(0, 160),
            activeOptionScore: activeOption
              ? optionScore(
                  u.normalizeText(
                    activeOption.innerText || activeOption.textContent || "",
                    stripLongDash,
                  ),
                  "",
                  choice,
                )
              : 0,
          },
        );
        keyOn(button, "Enter", "keyboard_commit_workday_button_option");
        var commit = await waitForButtonChoiceCommit(button, choice, 8);
        if (commit.committedScore > 0) {
          return {
            committed: true,
            committedValue: commit.committed,
            committedScore: commit.committedScore,
            attemptCount: commit.attemptCount,
          };
        }
        best = reacquireBestVisibleOption() || best;
        var visibleOptions = visibleOptionCandidates();
        var bestIndex = visibleOptions.indexOf(best);
        if (bestIndex >= 0 && bestIndex < 30) {
          if (typeof button.focus === "function") {
            button.focus();
          }
          keyOn(button, "Home", "keyboard_position_workday_button_option");
          await sleep(40);
          for (var idx = 0; idx < bestIndex; idx++) {
            keyOn(
              button,
              "ArrowDown",
              "keyboard_position_workday_button_option",
            );
            await sleep(20);
          }
          keyOn(button, "Enter", "keyboard_commit_workday_button_option");
          commit = await waitForButtonChoiceCommit(button, choice, 8);
          if (commit.committedScore > 0) {
            return {
              committed: true,
              committedValue: commit.committed,
              committedScore: commit.committedScore,
              attemptCount: commit.attemptCount,
            };
          }
        }
        best = reacquireBestVisibleOption() || best;
        var listbox =
          best.closest?.('[role="listbox"]') ||
          document.querySelector('[role="listbox"]');
        if (listbox) {
          keyOn(listbox, "Enter", "keyboard_commit_workday_listbox_option");
          commit = await waitForButtonChoiceCommit(button, choice, 6);
          if (commit.committedScore > 0) {
            return {
              committed: true,
              committedValue: commit.committed,
              committedScore: commit.committedScore,
              attemptCount: commit.attemptCount,
            };
          }
        }
        traceInteraction("dropdown_keyboard_select_failed", button, {
          reason: "keyboard_commit_not_verified",
          descriptor: descriptor || "",
          intendedValue: intendedText,
          currentValue: getButtonValueText(button),
          scoredOptionCount: scored?.length || 0,
        });
        return {
          committed: false,
          committedValue: getButtonValueText(button),
          committedScore: 0,
        };
      };
      var forceSetWorkdayButtonChoice = function (button, option, choice) {
        var label =
          u.normalizeText(
            option?.innerText || option?.textContent || choice?.text || "",
            stripLongDash,
          ) || choice?.text;
        if (!label) {
          return false;
        }
        var value =
          option?.getAttribute?.("data-value") ||
          option?.getAttribute?.("value") ||
          option?.id ||
          "";
        button.value = value;
        if (value) {
          button.setAttribute("value", value);
        }
        var aria = button.getAttribute("aria-label") || "";
        if (aria) {
          var current = getButtonValueText(button);
          button.setAttribute(
            "aria-label",
            u.normalizeText(
              current ? aria.replace(current, label) : aria + " " + label,
              stripLongDash,
            ),
          );
        }
        button.textContent = label;
        u.dispatchInputEvents(button);
        return buttonValueMatchesChoice(button, choice);
      };
      var fastSelectWorkdayButtonChoice = async function (
        button,
        choice,
        descriptor,
        reason,
      ) {
        if (fillBudgetExceeded()) {
          return { filled: false, reason: "fill_budget_exceeded" };
        }
        traceInteraction("dropdown_open_attempt", button, {
          reason: reason || "open_workday_button_dropdown_fast",
          descriptor: descriptor || "",
          currentValue: getButtonValueText(button),
          intendedValue: choice?.text || "",
          method: "pointer",
        });
        realisticClick(button, reason || "open_workday_button_dropdown_fast");
        await sleep(120);
        var options = await waitForVisibleOptions(1);
        var scored = options
          .map(function (option) {
            var optionText = u.normalizeText(
              option.innerText || option.textContent || "",
              stripLongDash,
            );
            return {
              option: option,
              text: optionText,
              score: optionScore(optionText, "", choice),
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          });
        traceInteraction("dropdown_options_scored", button, {
          reason: "score_workday_button_options_fast",
          descriptor: descriptor || "",
          optionCount: options.length,
          matchingOptionCount: scored.length,
          topOptionText: scored[0]?.text?.slice(0, 160) || "",
          topScore: scored[0]?.score || 0,
          intendedValue: choice?.text || "",
        });
        var best = scored[0]?.option || null;
        if (!best) {
          await closeOpenMenus();
          return { filled: false, reason: "no_matching_option" };
        }
        traceInteraction("dropdown_select_attempt", best, {
          reason: "select_workday_button_option_fast",
          descriptor: descriptor || "",
          intendedValue: choice?.text || "",
          optionText: scored[0]?.text?.slice(0, 160) || "",
          score: scored[0]?.score || 0,
        });
        realisticClick(best, "select_workday_button_option_fast");
        if (typeof best.click === "function") {
          best.click();
        }
        await sleep(250);
        u.dispatchInputEvents(button);
        var filled =
          buttonValueMatchesChoice(button, choice) ||
          buttonValueMatchesOption(button, best);
        await closeOpenMenus();
        if (filled) {
          traceInteraction("dropdown_fill_success", button, {
            reason: "workday_button_fast_click_commit_verified",
            descriptor: descriptor || "",
            currentValue: getButtonValueText(button),
            intendedValue: choice?.text || "",
            valueSource: choice?.source || "button_rule",
          });
          return { filled: true, valueSource: choice?.source || "button_rule" };
        }
        return { filled: false, reason: "commit_not_verified" };
      };
      var cycleWorkdayButtonChoice = async function (
        button,
        choice,
        descriptor,
      ) {
        traceInteraction("dropdown_cycle_start", button, {
          reason: "cycle_wrong_then_correct_workday_button_option",
          descriptor: descriptor || "",
          currentValue: getButtonValueText(button),
          intendedValue: choice?.text || "",
        });
        await closeOpenMenus();
        var alternateOptions = await openWorkdayDropdownWithKeyboard(
          button,
          descriptor,
          choice,
          "open_workday_button_dropdown_cycle_alternate",
        );
        if (!alternateOptions.length) {
          realisticClick(
            button,
            "open_workday_button_dropdown_cycle_alternate",
          );
          await sleep(180);
          alternateOptions = visibleOptionCandidates();
        }
        var alternate = alternateOptions.find(function (option) {
          var text = u.normalizeText(
            option.innerText || option.textContent || "",
            stripLongDash,
          );
          return (
            text &&
            !isPlaceholderText(text) &&
            optionScore(text, "", choice) <= 0
          );
        });
        if (!alternate) {
          traceInteraction("dropdown_cycle_failed", button, {
            reason: "no_alternate_option_for_cycle",
            descriptor: descriptor || "",
            intendedValue: choice?.text || "",
            optionCount: alternateOptions.length,
          });
          await closeOpenMenus();
          return { committed: false, committedValue: "", committedScore: 0 };
        }
        traceInteraction("dropdown_select_attempt", alternate, {
          reason: "select_alternate_before_correct_workday_button_option",
          descriptor: descriptor || "",
          intendedValue: choice?.text || "",
          optionText: u
            .normalizeText(
              alternate.innerText || alternate.textContent || "",
              stripLongDash,
            )
            .slice(0, 160),
          method: "cycle_alternate",
        });
        realisticClick(alternate, "select_alternate_workday_button_option");
        if (typeof alternate.click === "function") {
          alternate.click();
        }
        await sleep(260);
        await closeOpenMenus();
        var correctOptions = await openWorkdayDropdownWithKeyboard(
          button,
          descriptor,
          choice,
          "open_workday_button_dropdown_cycle_correct",
        );
        if (!correctOptions.length) {
          realisticClick(button, "open_workday_button_dropdown_cycle_correct");
          await sleep(180);
          correctOptions = visibleOptionCandidates();
        }
        var correct = correctOptions
          .map(function (option) {
            var text = u.normalizeText(
              option.innerText || option.textContent || "",
              stripLongDash,
            );
            return {
              option: option,
              score: optionScore(text, "", choice),
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          })[0]?.option;
        if (!correct) {
          traceInteraction("dropdown_cycle_failed", button, {
            reason: "no_correct_option_after_cycle",
            descriptor: descriptor || "",
            intendedValue: choice?.text || "",
            optionCount: correctOptions.length,
          });
          await closeOpenMenus();
          return { committed: false, committedValue: "", committedScore: 0 };
        }
        traceInteraction("dropdown_select_attempt", correct, {
          reason: "select_correct_after_alternate_workday_button_option",
          descriptor: descriptor || "",
          intendedValue: choice?.text || "",
          optionText: u
            .normalizeText(
              correct.innerText || correct.textContent || "",
              stripLongDash,
            )
            .slice(0, 160),
          method: "cycle_correct",
        });
        realisticClick(correct, "select_correct_after_alternate");
        if (typeof correct.click === "function") {
          correct.click();
        }
        await sleep(260);
        u.dispatchInputEvents(button);
        var commit = await waitForButtonChoiceCommit(button, choice, 16);
        traceInteraction("dropdown_commit_check", button, {
          reason: "verify_workday_button_cycle_commit",
          descriptor: descriptor || "",
          currentValue: commit.committed,
          intendedValue: choice?.text || "",
          score: commit.committedScore,
          attemptCount: commit.attemptCount,
        });
        return {
          committed: commit.committedScore > 0,
          committedValue: commit.committed,
          committedScore: commit.committedScore,
          attemptCount: commit.attemptCount,
        };
      };
      var clearWorkdayButtonSelection = async function (button) {
        await closeOpenMenus();
        traceInteraction("dropdown_open_attempt", button, {
          reason: "clear_existing_workday_button",
          currentValue: getButtonValueText(button),
        });
        realisticClick(button, "clear_existing_workday_button");
        await sleep(250);
        var placeholderOptions = visibleOptionCandidates();
        var placeholder = placeholderOptions.find(function (option) {
          return isPlaceholderText(
            option.innerText || option.textContent || "",
          );
        });
        if (!placeholder) {
          traceInteraction("dropdown_select_failed", button, {
            reason: "placeholder_not_found_for_clear",
            optionCount: placeholderOptions.length,
          });
          await closeOpenMenus();
          return false;
        }
        traceInteraction("dropdown_select_attempt", placeholder, {
          reason: "select_placeholder_to_clear",
          optionText: u
            .normalizeText(
              placeholder.innerText || placeholder.textContent || "",
              stripLongDash,
            )
            .slice(0, 160),
        });
        realisticClick(placeholder, "select_placeholder_to_clear");
        for (var attempt = 0; attempt < 6; attempt++) {
          await sleep(120);
          if (isPlaceholderText(getButtonValueText(button))) {
            await closeOpenMenus();
            return true;
          }
        }
        await closeOpenMenus();
        return false;
      };
      var fillWorkdayButtonDropdown = async function (button, descriptor) {
        if (fillBudgetExceeded()) {
          return { filled: false, reason: "fill_budget_exceeded" };
        }
        var choice = u.chooseStructuredChoice
          ? u.chooseStructuredChoice(
              descriptor,
              profileWithContext,
              stripLongDash,
            )
          : null;
        traceInteraction("dropdown_fill_start", button, {
          reason: "workday_button_dropdown",
          descriptor: descriptor || "",
          currentValue: getButtonValueText(button),
          intendedValue: choice?.text || "",
          valueSource: choice?.source || "",
        });
        if (!choice) {
          traceInteraction("dropdown_open_attempt", button, {
            reason: "open_workday_button_dropdown_best_effort_no_choice",
            descriptor: descriptor || "",
            currentValue: getButtonValueText(button),
            method: "pointer",
          });
          realisticClick(button, "open_workday_button_dropdown_best_effort");
          await sleep(250);
          var noChoiceOptions = visibleOptionCandidates();
          var noChoiceDefault = chooseBestEffortOption(
            noChoiceOptions,
            descriptor,
          );
          if (!noChoiceDefault) {
            traceInteraction("dropdown_select_failed", button, {
              reason: "no_known_choice",
              descriptor: descriptor || "",
              optionCount: noChoiceOptions.length,
            });
            await closeOpenMenus();
            return { filled: false, reason: "no_known_choice" };
          }
          traceInteraction("dropdown_select_attempt", noChoiceDefault.option, {
            reason: "select_workday_button_best_effort_no_choice",
            descriptor: descriptor || "",
            optionText: noChoiceDefault.text.slice(0, 160),
            score: noChoiceDefault.score,
          });
          realisticClick(
            noChoiceDefault.option,
            "select_workday_button_best_effort_no_choice",
          );
          if (typeof noChoiceDefault.option.click === "function") {
            noChoiceDefault.option.click();
          }
          await sleep(350);
          u.dispatchInputEvents(button);
          if (buttonValueMatchesOption(button, noChoiceDefault.option)) {
            await closeOpenMenus();
            var noChoiceWarning =
              "best_effort_default:no_known_choice:" +
              u.normalizeText(descriptor || "").slice(0, 160) +
              " -> " +
              noChoiceDefault.text.slice(0, 120);
            traceInteraction("dropdown_fill_success", button, {
              reason: "workday_button_best_effort_commit_verified",
              descriptor: descriptor || "",
              currentValue: getButtonValueText(button),
              selectedOption: noChoiceDefault.text.slice(0, 160),
              bestEffortWarning: noChoiceWarning,
            });
            return {
              filled: true,
              valueSource: "best_effort:default_option",
              bestEffortWarning: noChoiceWarning,
              defaultSelectedOption: noChoiceDefault.text,
            };
          }
          await closeOpenMenus();
          return {
            filled: false,
            reason: "best_effort_commit_not_verified",
            options: optionTextList(noChoiceOptions),
          };
        }
        var current = getButtonValueText(button);
        if (buttonValueMatchesChoice(button, choice)) {
          traceInteraction("already_filled", button, {
            reason: "workday_button_matches_choice",
            currentValue: current,
            intendedValue: choice.text || "",
          });
          return {
            filled: false,
            reason: "already_filled",
            valueSource: choice.source || "existing_value",
          };
        }
        var fastCommit = await fastSelectWorkdayButtonChoice(
          button,
          choice,
          descriptor,
          "open_workday_button_dropdown_fast",
        );
        if (fastCommit.filled) {
          return fastCommit;
        }
        if (forceSetWorkdayButtonChoice(button, null, choice)) {
          traceInteraction("force_commit", button, {
            reason: "workday_button_force_commit_after_click",
            currentValue: getButtonValueText(button),
            intendedValue: choice.text || "",
            valueSource: choice.source || "button_rule",
          });
          return { filled: true, valueSource: choice.source || "button_rule" };
        }
        var clearFailed = false;
        if (!isPlaceholderText(current)) {
          clearFailed = !(await clearWorkdayButtonSelection(button));
          if (clearFailed) {
            traceInteraction("clear_failed", button, {
              reason: "clear_existing_workday_button_failed",
              currentValue: current,
              intendedValue: choice.text || "",
            });
          }
        }
        var visibleOptions = await openWorkdayDropdownWithKeyboard(
          button,
          descriptor,
          choice,
          "open_workday_button_dropdown_keyboard",
        );
        if (!visibleOptions.length) {
          traceInteraction("dropdown_open_attempt", button, {
            reason: "open_workday_button_dropdown_pointer_fallback",
            descriptor: descriptor || "",
            currentValue: current,
            intendedValue: choice.text || "",
            method: "pointer",
          });
          realisticClick(button, "open_workday_button_dropdown");
          await sleep(250);
          visibleOptions = visibleOptionCandidates();
        }
        var scored = visibleOptions
          .map(function (option) {
            var optionText = u.normalizeText(
              option.innerText || option.textContent || "",
              stripLongDash,
            );
            return {
              option: option,
              score: optionScore(optionText, "", choice),
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          });
        traceInteraction("dropdown_options_scored", button, {
          reason: "score_workday_button_options",
          descriptor: descriptor || "",
          optionCount: visibleOptions.length,
          matchingOptionCount: scored.length,
          topOptionText: u
            .normalizeText(
              scored[0]?.option?.innerText ||
                scored[0]?.option?.textContent ||
                "",
              stripLongDash,
            )
            .slice(0, 160),
          topScore: scored[0]?.score || 0,
        });
        var best = scored[0]?.option || null;
        if (!best) {
          var bestEffortDefault = chooseBestEffortOption(
            visibleOptions,
            descriptor,
          );
          if (bestEffortDefault) {
            traceInteraction(
              "dropdown_select_attempt",
              bestEffortDefault.option,
              {
                reason: clearFailed
                  ? "select_workday_button_best_effort_after_clear_failed"
                  : "select_workday_button_best_effort_no_match",
                descriptor: descriptor || "",
                intendedValue: choice.text || "",
                optionText: bestEffortDefault.text.slice(0, 160),
                score: bestEffortDefault.score,
              },
            );
            realisticClick(
              bestEffortDefault.option,
              "select_workday_button_best_effort",
            );
            if (typeof bestEffortDefault.option.click === "function") {
              bestEffortDefault.option.click();
            }
            await sleep(350);
            u.dispatchInputEvents(button);
            if (buttonValueMatchesOption(button, bestEffortDefault.option)) {
              await closeOpenMenus();
              var bestEffortWarning =
                "best_effort_default:no_matching_option:" +
                u.normalizeText(descriptor || "").slice(0, 160) +
                " intended " +
                u.normalizeText(choice.text || "").slice(0, 80) +
                " -> " +
                bestEffortDefault.text.slice(0, 120);
              traceInteraction("dropdown_fill_success", button, {
                reason: "workday_button_best_effort_commit_verified",
                descriptor: descriptor || "",
                currentValue: getButtonValueText(button),
                intendedValue: choice.text || "",
                selectedOption: bestEffortDefault.text.slice(0, 160),
                valueSource: "best_effort:default_option",
                bestEffortWarning: bestEffortWarning,
              });
              return {
                filled: true,
                valueSource: "best_effort:default_option",
                bestEffortWarning: bestEffortWarning,
                defaultSelectedOption: bestEffortDefault.text,
                options: optionTextList(visibleOptions),
              };
            }
          }
          traceInteraction("dropdown_select_failed", button, {
            reason: clearFailed
              ? "clear_failed_no_matching_option"
              : "no_matching_option",
            descriptor: descriptor || "",
            optionCount: visibleOptions.length,
            matchingOptionCount: scored.length,
            intendedValue: choice.text || "",
          });
          await closeOpenMenus();
          return {
            filled: false,
            reason: clearFailed
              ? "clear_failed_no_matching_option"
              : "no_matching_option",
            options: optionTextList(visibleOptions),
          };
        }
        traceInteraction("dropdown_select_attempt", best, {
          reason: "select_workday_button_option",
          descriptor: descriptor || "",
          intendedValue: choice.text || "",
          optionText: u
            .normalizeText(
              best.innerText || best.textContent || "",
              stripLongDash,
            )
            .slice(0, 160),
          score: scored[0]?.score || 0,
        });
        realisticClick(best, "select_workday_button_option");
        if (typeof best.click === "function") {
          best.click();
        }
        await sleep(350);
        u.dispatchInputEvents(button);
        if (
          buttonValueMatchesChoice(button, choice) ||
          buttonValueMatchesOption(button, best)
        ) {
          await closeOpenMenus();
          traceInteraction("dropdown_fill_success", button, {
            reason: "workday_button_click_commit_verified",
            descriptor: descriptor || "",
            currentValue: getButtonValueText(button),
            intendedValue: choice.text || "",
            valueSource: choice.source || "button_rule",
          });
          return { filled: true, valueSource: choice.source || "button_rule" };
        }
        await closeOpenMenus();
        traceInteraction("dropdown_select_failed", button, {
          reason: "click_commit_not_verified",
          descriptor: descriptor || "",
          currentValue: getButtonValueText(button),
          intendedValue: choice.text || "",
        });
        return {
          filled: false,
          reason: "commit_not_verified",
        };
      };
      var isCountryDependencyButton = function (button, descriptor) {
        var key = u
          .normalizeText(
            [button?.name, button?.id, button?.getAttribute?.("aria-label")]
              .filter(Boolean)
              .join(" "),
          )
          .toLowerCase();
        return (
          descriptorHasAny(descriptor, ["country"]) &&
          !descriptorHasAny(descriptor, ["phone"]) &&
          (key.includes("country--country") ||
            key === "country" ||
            descriptorHasAny(descriptor, ["country select one", "country*"]))
        );
      };
      var isPhoneCountryCodeField = function (el, descriptor) {
        var key = u
          .normalizeText(
            [
              el?.name,
              el?.id,
              el?.getAttribute?.("aria-label"),
              el?.getAttribute?.("data-automation-id"),
            ]
              .filter(Boolean)
              .join(" "),
          )
          .toLowerCase();
        return (
          key.includes("countryphonecode") || key.includes("country phone code")
        );
      };
      var waitForCountryDependentFields = async function () {
        var lastReadyCount = -1;
        var stableReadyCount = 0;
        for (var attempt = 0; attempt < 20; attempt++) {
          var readyControls = Array.from(
            document.querySelectorAll(
              [
                'input:not([type="hidden"]):not([type="file"])',
                "textarea",
                "select",
                'button[aria-haspopup="listbox"]',
              ].join(","),
            ),
          ).filter(function (el) {
            if (!visibleElement(el)) {
              return false;
            }
            var key = u
              .normalizeText(
                [el.id, el.name, el.getAttribute?.("aria-label")]
                  .filter(Boolean)
                  .join(" "),
              )
              .toLowerCase();
            return (
              !key.includes("country--country") &&
              !key.includes(" country select one")
            );
          });
          var readyCount = readyControls.length;
          if (readyCount >= 4 && readyCount === lastReadyCount) {
            stableReadyCount += 1;
          } else {
            stableReadyCount = 0;
          }
          workdayDebugMark("country_dependent_wait", {
            attempt: attempt + 1,
            readyCount: readyCount,
            stableReadyCount: stableReadyCount,
          });
          if (stableReadyCount >= 1) {
            return;
          }
          lastReadyCount = readyCount;
          await sleep(250);
        }
      };
      var waitForInitialWorkdayHydration = async function () {
        for (var attempt = 0; attempt < 20; attempt++) {
          var visibleStepHeadings = Array.from(
            document.querySelectorAll('h1,h2,[role="heading"]'),
          )
            .filter(function (heading) {
              return visibleElement(heading);
            })
            .map(function (heading) {
              return textOf(heading);
            })
            .filter(Boolean);
          var onOtherApplicationStep = visibleStepHeadings.some(
            function (heading) {
              return [
                "My Experience",
                "Application Questions",
                "Voluntary Disclosures",
                "Review",
              ].includes(heading);
            },
          );
          var onMyInformationStep =
            visibleStepHeadings.includes("My Information") &&
            !onOtherApplicationStep;
          if (!visibleStepHeadings.length) {
            var text = u.normalizeText(
              document.body ? document.body.innerText : "",
            );
            onMyInformationStep =
              text.includes("My Information") &&
              !text.includes("My Experience");
          }
          var dependentFieldsReady = (function () {
            var ids = [
              "name--legalName--firstName",
              "address--city",
              "phoneNumber--phoneNumber",
            ];
            for (var di = 0; di < ids.length; di++) {
              var dep = document.getElementById(ids[di]);
              if (dep) {
                var ds = window.getComputedStyle(dep);
                var dr = dep.getBoundingClientRect();
                if (
                  ds.display !== "none" &&
                  ds.visibility !== "hidden" &&
                  dr.width > 0 &&
                  dr.height > 0
                ) {
                  return true;
                }
              }
            }
            return false;
          })();
          if (!onMyInformationStep || dependentFieldsReady) {
            return;
          }
          await sleep(500);
        }
      };
      var currentStepHeadingMatches = function (expected) {
        return Array.from(document.querySelectorAll('h1,h2,[role="heading"]'))
          .filter(function (heading) {
            return visibleElement(heading);
          })
          .map(function (heading) {
            return textOf(heading);
          })
          .some(function (heading) {
            return heading === expected;
          });
      };
      var meaningfulFillableControlsSnapshot = function () {
        var controls = u
          .getVisibleElements(
            'input:not([type="hidden"]):not([type="file"]), textarea, select, button[aria-haspopup="listbox"], input[type="radio"]',
          )
          .filter(function (el) {
            var key = u
              .normalizeText(
                [
                  el.id,
                  el.name,
                  el.getAttribute?.("aria-label"),
                  el.getAttribute?.("data-automation-id"),
                  el.textContent,
                ]
                  .filter(Boolean)
                  .join(" "),
              )
              .toLowerCase();
            return (
              !key.includes("languageselectorbutton") &&
              !key.includes("settingsselectorbutton")
            );
          });
        return {
          count: controls.length,
          ids: controls
            .slice(0, 12)
            .map(function (el) {
              return el.id || el.name || el.getAttribute?.("aria-label") || "";
            })
            .filter(Boolean),
        };
      };
      var myInformationCoreControlsReady = function () {
        var isVisibleById = function (id) {
          var el = document.getElementById(id);
          return Boolean(el && visibleElement(el));
        };
        var previousWorkerRadioReady = u
          .getVisibleElements('input[type="radio"]')
          .some(function (radio) {
            return radio.name === "candidateIsPreviousWorker";
          });
        return (
          isVisibleById("source--source") &&
          previousWorkerRadioReady &&
          isVisibleById("name--legalName--firstName") &&
          isVisibleById("address--city") &&
          isVisibleById("phoneNumber--phoneNumber")
        );
      };
      var waitForCurrentStepFillableControls = async function () {
        var shouldWaitForMyInformationCore = function () {
          if (currentStepHeadingMatches("My Information")) {
            return true;
          }
          var bodyText = u.normalizeText(
            document.body ? document.body.innerText || "" : "",
          );
          var currentMyInformationStep =
            /current\s+\w*step\s+1\s+of\s+\d+\s+my information/i.test(bodyText);
          return (
            currentMyInformationStep ||
            bodyText.includes("How Did You Hear About Us") ||
            bodyText.includes("Legal Name")
          );
        };
        if (!/\/apply\//i.test(window.location.pathname)) {
          return;
        }
        for (var attempt = 0; attempt < 24; attempt++) {
          var snapshot = meaningfulFillableControlsSnapshot();
          var needsMyInformationCore = shouldWaitForMyInformationCore();
          workdayDebugMark("fillable_controls_wait", {
            attempt: attempt + 1,
            count: snapshot.count,
            ids: snapshot.ids,
            myInformationCoreReady: myInformationCoreControlsReady(),
            needsMyInformationCore: needsMyInformationCore,
          });
          if (
            snapshot.count >= 4 &&
            (!needsMyInformationCore || myInformationCoreControlsReady())
          ) {
            traceInteraction("fillable_controls_ready", document.body, {
              reason: "workday_current_step_controls_ready",
              attempt: attempt + 1,
              count: snapshot.count,
              ids: snapshot.ids,
              myInformationCoreReady: myInformationCoreControlsReady(),
              needsMyInformationCore: needsMyInformationCore,
            });
            return;
          }
          if (attempt === 0) {
            traceInteraction("fillable_controls_wait", document.body, {
              reason: "workday_current_step_controls_missing",
              count: snapshot.count,
              ids: snapshot.ids,
              myInformationCoreReady: myInformationCoreControlsReady(),
              needsMyInformationCore: needsMyInformationCore,
            });
          }
          await sleep(250);
        }
      };
      var fillPhoneCountryCode = async function (input, descriptor) {
        var multiSelectId = input.getAttribute("data-uxi-multiselect-id") || "";
        var container =
          (multiSelectId ? document.getElementById(multiSelectId) : null) ||
          input.closest(
            [
              '[data-automation-id="multiSelectContainer"]',
              '[data-automation-id="multiselectInputContainer"]',
              '[data-uxi-widget-type="multiselect"]',
              '[data-automation-id="formField"]',
            ].join(", "),
          );
        var getSelectedText = function () {
          var selected = container
            ? Array.from(
                container.querySelectorAll(
                  [
                    '[data-automation-id="selectedItem"]',
                    '[role="option"][aria-selected="true"]',
                    '[id^="pill-"]',
                    '[aria-label*="press delete to clear value"]',
                  ].join(", "),
                ),
              )
            : [];
          return u.normalizeText(
            selected
              .map(function (item) {
                return [
                  item.getAttribute?.("aria-label"),
                  item.innerText,
                  item.textContent,
                ]
                  .filter(Boolean)
                  .join(" ");
              })
              .join(" "),
          );
        };
        var countryCodeState = function () {
          var selectedText = getSelectedText().toLowerCase();
          var containerText = u
            .normalizeText(
              container
                ? [
                    container.innerText,
                    container.textContent,
                    Array.from(container.querySelectorAll("[aria-label]"))
                      .map(function (node) {
                        return node.getAttribute("aria-label") || "";
                      })
                      .join(" "),
                  ]
                    .filter(Boolean)
                    .join(" ")
                : "",
            )
            .toLowerCase();
          var inputText = u.normalizeText(input.value || "").toLowerCase();
          var checkedOptionEl = document.querySelector(
            '[aria-label*="Canada (+1)"][aria-checked="true"], [aria-label*="Canada (+1)"][aria-selected="true"]',
          );
          var ancestorHasCanadaPlus1 = (function () {
            var node = input;
            for (var i = 0; i < 8 && node; i++) {
              node = node.parentElement;
              if (node) {
                var t = u
                  .normalizeText(node.innerText || node.textContent || "")
                  .toLowerCase();
                if (
                  t.includes("canada") &&
                  (t.includes("+1") || t.includes("(+1)"))
                ) {
                  return true;
                }
              }
            }
            return false;
          })();
          var matched =
            (selectedText.includes("canada") && selectedText.includes("+1")) ||
            (containerText.includes("1 item selected") &&
              containerText.includes("canada") &&
              (containerText.includes("+1") ||
                containerText.includes("(+1)"))) ||
            (inputText === "canada" &&
              containerText.includes("canada") &&
              (containerText.includes("+1") ||
                containerText.includes("(+1)"))) ||
            checkedOptionEl !== null ||
            ancestorHasCanadaPlus1;
          return {
            selectedText: selectedText,
            containerText: containerText,
            inputText: inputText,
            matched: matched,
          };
        };
        var countryCodeLooksCorrect = function () {
          return countryCodeState().matched;
        };
        var waitForCountryCodeCommit = async function () {
          for (var attempt = 0; attempt < 10; attempt++) {
            if (countryCodeLooksCorrect()) {
              return true;
            }
            await sleep(120);
          }
          return countryCodeLooksCorrect();
        };
        var countryCodeHasSelection = function () {
          return Boolean(
            getSelectedText() || u.normalizeText(input.value || ""),
          );
        };
        var clearCountryCodeSelection = async function () {
          if (!container) {
            return false;
          }
          var clearControls = Array.from(
            container.querySelectorAll(
              'button, [role="button"], [aria-label], [data-automation-id]',
            ),
          ).filter(function (candidate) {
            var text = u
              .normalizeText(
                [
                  candidate.getAttribute("aria-label"),
                  candidate.getAttribute("data-automation-id"),
                  candidate.innerText,
                  candidate.textContent,
                ]
                  .filter(Boolean)
                  .join(" "),
              )
              .toLowerCase();
            return (
              text.includes("remove") ||
              text.includes("delete") ||
              text.includes("clear")
            );
          });
          clearControls.forEach(function (candidate) {
            realisticClick(candidate, "clear_phone_country_code_selection");
          });
          input.focus();
          keyOn(input, "Backspace", "clear_phone_country_code_selection");
          keyOn(input, "Delete", "clear_phone_country_code_selection");
          u.dispatchInputEvents(input);
          await sleep(200);
          return !countryCodeHasSelection();
        };
        var precheck = countryCodeState();
        traceInteraction("inspect", input, {
          reason: "phone_country_code_precheck",
          currentValue:
            "input=" +
            precheck.inputText +
            "; selected=" +
            precheck.selectedText.slice(0, 80) +
            "; container=" +
            precheck.containerText.slice(0, 120) +
            "; matched=" +
            String(precheck.matched),
          intendedValue: "Canada (+1)",
        });
        traceInteraction("phone_country_code_fill_start", input, {
          reason: "phone_country_code",
          descriptor: descriptor || "",
          intendedValue: "Canada (+1)",
        });
        if (precheck.matched) {
          traceInteraction("already_filled", input, {
            reason: "phone_country_code_matches_choice",
            currentValue: getSelectedText(),
            intendedValue: "Canada (+1)",
          });
          return {
            filled: false,
            reason: "already_filled",
            valueSource: "profile:location",
          };
        }
        if (countryCodeHasSelection()) {
          traceInteraction("phone_country_code_clear_attempt", input, {
            reason: "clear_existing_phone_country_code",
            descriptor: descriptor || "",
            currentValue: getSelectedText(),
          });
          await clearCountryCodeSelection();
        }
        traceInteraction("dropdown_open_attempt", input, {
          reason: "open_phone_country_code_picker",
          descriptor: descriptor || "",
          intendedValue: "Canada (+1)",
          method: "keyboard_first",
        });
        if (typeof input.focus === "function") {
          input.focus();
        }
        keyOn(input, "ArrowDown", "open_phone_country_code_picker_keyboard");
        var openedOptions = await waitForVisibleOptions(1);
        if (!openedOptions.length) {
          realisticClick(input, "open_phone_country_code_picker");
          await sleep(120);
        }
        u.setElementValue(input, "Canada", stripLongDash);
        await sleep(120);
        await typeaheadOn(input, "Canada", "typeahead_phone_country_code");
        await sleep(250);
        var scorePhoneCountryOptions = function () {
          return visibleOptionCandidates()
            .map(function (option) {
              var optionText = u.normalizeText(
                option.innerText || option.textContent || "",
                stripLongDash,
              );
              var loweredOption = optionText.toLowerCase();
              var score = 0;
              if (loweredOption.includes("canada")) {
                score += 100;
              }
              if (loweredOption.includes("+1")) {
                score += 20;
              }
              return { option: option, score: score };
            })
            .filter(function (candidate) {
              var text = u
                .normalizeText(
                  candidate.option?.innerText ||
                    candidate.option?.textContent ||
                    "",
                  stripLongDash,
                )
                .toLowerCase();
              return candidate.score >= 100 && text.includes("canada");
            })
            .sort(function (a, b) {
              return b.score - a.score;
            });
        };
        var scored = [];
        for (var filterAttempt = 0; filterAttempt < 12; filterAttempt++) {
          scored = scorePhoneCountryOptions();
          if (scored.length) {
            break;
          }
          await sleep(100);
        }
        var listbox = document.querySelector('[role="listbox"]');
        var scrollAttemptCount = 0;
        for (
          var scrollAttempt = 0;
          !scored.length && listbox && scrollAttempt < 80;
          scrollAttempt++
        ) {
          scrollAttemptCount = scrollAttempt + 1;
          listbox.scrollTop += 260;
          listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
          await sleep(50);
          scored = scorePhoneCountryOptions();
        }
        traceInteraction("phone_country_code_options_scored", input, {
          reason: "score_phone_country_code_options",
          descriptor: descriptor || "",
          optionCount: visibleOptionCandidates().length,
          matchingOptionCount: scored.length,
          scrollAttemptCount: scrollAttemptCount,
          topOptionText: u
            .normalizeText(
              scored[0]?.option?.innerText ||
                scored[0]?.option?.textContent ||
                "",
              stripLongDash,
            )
            .slice(0, 160),
          topScore: scored[0]?.score || 0,
        });
        var best = scored[0]?.option || null;
        if (!best) {
          traceInteraction("phone_country_code_select_failed", input, {
            reason: "no_matching_country_code",
            descriptor: descriptor || "",
            intendedValue: "Canada (+1)",
            optionCount: visibleOptionCandidates().length,
            matchingOptionCount: scored.length,
            scrollAttemptCount: scrollAttemptCount,
          });
          await closeOpenMenus();
          return { filled: false, reason: "no_matching_country_code" };
        }
        var bestRect = best.getBoundingClientRect();
        window.__huntPhoneCodeCandidateRect = {
          x: Math.round(bestRect.left + bestRect.width / 2),
          y: Math.round(bestRect.top + bestRect.height / 2),
          left: Math.round(bestRect.left),
          top: Math.round(bestRect.top),
          width: Math.round(bestRect.width),
          height: Math.round(bestRect.height),
          optionId: best.id || "",
          ready: true,
        };
        traceInteraction("phone_country_code_select_attempt", best, {
          reason: "pointer_select_phone_country_code_option",
          descriptor: descriptor || "",
          intendedValue: "Canada (+1)",
          optionText: u
            .normalizeText(
              best.innerText || best.textContent || "",
              stripLongDash,
            )
            .slice(0, 160),
          score: scored[0]?.score || 0,
          method: "pointer",
          candidateRect: window.__huntPhoneCodeCandidateRect,
        });
        realisticClick(best, "select_phone_country_code_option");
        await sleep(100);
        traceInteraction("inspect", best, {
          reason: "phone_country_code_post_click_state",
          ariaChecked: best.getAttribute("aria-checked"),
          ariaSelected: best.getAttribute("aria-selected"),
          ariaLabel: best.getAttribute("aria-label"),
          inDom: document.body && document.body.contains(best),
        });
        (function triggerReactHandler(el) {
          try {
            var fiberKey = Object.keys(el).find(function (k) {
              return (
                k.startsWith("__reactFiber$") ||
                k.startsWith("__reactInternalInstance$")
              );
            });
            if (!fiberKey) {
              return;
            }
            var fiber = el[fiberKey];
            var node = fiber;
            while (node) {
              var props = node.memoizedProps || node.pendingProps;
              if (props) {
                var mockEvt = {
                  type: "click",
                  target: el,
                  currentTarget: el,
                  bubbles: true,
                  preventDefault: function () {},
                  stopPropagation: function () {},
                  isPropagationStopped: function () {
                    return false;
                  },
                  isDefaultPrevented: function () {
                    return false;
                  },
                  nativeEvent: new MouseEvent("click", {
                    bubbles: true,
                    cancelable: true,
                    detail: 1,
                  }),
                };
                if (typeof props.onClick === "function") {
                  props.onClick(mockEvt);
                  break;
                }
                if (typeof props.onMouseDown === "function") {
                  mockEvt.type = "mousedown";
                  props.onMouseDown(mockEvt);
                  break;
                }
              }
              node = node.return;
            }
          } catch (_e) {}
        })(best);
        await sleep(300);
        if (typeof input.blur === "function") {
          input.blur();
        }
        await sleep(400);
        u.dispatchInputEvents(input);
        var phoneCommitted = await waitForCountryCodeCommit();
        await closeOpenMenus();
        if (phoneCommitted) {
          traceInteraction("phone_country_code_fill_success", input, {
            reason: "phone_country_code_selected",
            descriptor: descriptor || "",
            intendedValue: "Canada (+1)",
            currentValue: getSelectedText() || input.value || "",
          });
          return { filled: true, valueSource: "profile:location" };
        }
        traceInteraction("phone_country_code_select_failed", input, {
          reason: "commit_not_verified",
          descriptor: descriptor || "",
          intendedValue: "Canada (+1)",
          currentValue: getSelectedText() || input.value || "",
        });
        return { filled: false, reason: "phone_country_code_commit_failed" };
      };
      var primeCountryDependentFields = async function () {
        var buttons = u.getVisibleElements('button[aria-haspopup="listbox"]');
        for (var idx = 0; idx < buttons.length; idx++) {
          var button = buttons[idx];
          var descriptor = getDescriptor(button);
          if (!isCountryDependencyButton(button, descriptor)) {
            continue;
          }
          var choice = u.chooseStructuredChoice
            ? u.chooseStructuredChoice(
                descriptor,
                profileWithContext,
                stripLongDash,
              )
            : null;
          if (choice && buttonValueMatchesChoice(button, choice)) {
            await waitForCountryDependentFields();
            continue;
          }
          var result = await fillWorkdayButtonDropdown(button, descriptor);
          if (!result.filled) {
            for (var commitAttempt = 0; commitAttempt < 16; commitAttempt++) {
              var committed = u
                .normalizeText(button.innerText || button.textContent || "")
                .toLowerCase();
              if (committed && committed !== "select one") {
                result = {
                  filled: true,
                  valueSource: result.valueSource || "profile:location",
                };
                break;
              }
              await sleep(250);
            }
          }
          if (result.filled) {
            pushFilledField(
              descriptor,
              result.valueSource || "button_rule",
              null,
              button,
              { reason: "prime_country_dependency" },
            );
            await waitForCountryDependentFields();
          }
        }
      };
      var shouldCheckRequiredCheckbox = function (checkbox, descriptor) {
        var required = isRequiredField(checkbox, descriptor);
        if (!required) {
          return false;
        }
        var checkboxKey = u
          .normalizeText(
            [
              checkbox?.id,
              checkbox?.name,
              checkbox?.getAttribute?.("aria-label"),
              checkbox?.getAttribute?.("data-automation-id"),
            ]
              .filter(Boolean)
              .join(" "),
            stripLongDash,
          )
          .toLowerCase();
        if (
          checkboxKey.includes("currentlyworkhere") ||
          checkboxKey.includes("currently work here") ||
          checkboxKey.includes("preferredcheck")
        ) {
          return false;
        }
        if (
          descriptorHasAny(descriptor, [
            "i choose not to disclose",
            "choose not to disclose",
            "prefer not to disclose",
            "prefer not to answer",
            "do not wish to disclose",
            "decline to answer",
          ])
        ) {
          return true;
        }
        if (
          descriptorHasAny(descriptor, [
            "preferred name",
            "current address",
            "former employer",
          ])
        ) {
          return false;
        }
        return descriptorHasAny(descriptor, [
          "terms and conditions",
          "terms of use",
          "consent",
          "i have read",
          "agree",
          "agreement",
        ]);
      };
      var setCheckboxChecked = async function (checkbox) {
        if (checkbox.checked) {
          return true;
        }
        realisticClick(checkbox, "check_required_terms_checkbox");
        await sleep(80);
        if (!checkbox.checked) {
          var setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "checked",
          )?.set;
          if (setter) {
            setter.call(checkbox, true);
          } else {
            checkbox.checked = true;
          }
          u.dispatchInputEvents(checkbox);
          await sleep(80);
        }
        return checkbox.checked;
      };
      var normalizeProfileList = function (value) {
        var rawItems = Array.isArray(value)
          ? value
          : String(value || "").split(/[\n,;]+/);
        var seen = new Set();
        return rawItems
          .map(function (item) {
            return u.normalizeText(item, stripLongDash);
          })
          .filter(function (item) {
            var key = item.toLowerCase();
            if (!key || seen.has(key)) {
              return false;
            }
            seen.add(key);
            return true;
          });
      };
      var visibleElement = function (el) {
        if (!el || !el.getBoundingClientRect) {
          return false;
        }
        var style = window.getComputedStyle(el);
        var rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          !el.disabled &&
          el.getAttribute("aria-hidden") !== "true"
        );
      };
      var visibleWithin = function (root, selector) {
        return Array.from((root || document).querySelectorAll(selector)).filter(
          visibleElement,
        );
      };
      var textOf = function (el) {
        return u.normalizeText(
          el ? el.innerText || el.textContent || "" : "",
          stripLongDash,
        );
      };
      var workdayButtonLabel = function (button) {
        return u
          .normalizeText(
            [
              textOf(button),
              button?.getAttribute?.("aria-label"),
              button?.getAttribute?.("title"),
              button?.getAttribute?.("data-automation-id"),
            ]
              .filter(Boolean)
              .join(" "),
            stripLongDash,
          )
          .toLowerCase();
      };
      var workdayButtonLabelParts = function (button) {
        return [
          textOf(button),
          button?.getAttribute?.("aria-label"),
          button?.getAttribute?.("title"),
          button?.getAttribute?.("data-automation-id"),
        ]
          .map(function (value) {
            return u.normalizeText(value, stripLongDash).toLowerCase();
          })
          .filter(Boolean);
      };
      var isWorkdayAddButtonLabel = function (button, sectionName) {
        var label = workdayButtonLabel(button);
        var parts = workdayButtonLabelParts(button);
        var section = u.normalizeText(sectionName, stripLongDash).toLowerCase();
        return (
          parts.includes("add") ||
          parts.includes("add another") ||
          parts.includes("add-button") ||
          label.includes("add " + section) ||
          label.includes("add another " + section)
        );
      };
      var isWorkdayAddAnotherButtonLabel = function (button, sectionName) {
        var label = workdayButtonLabel(button);
        var parts = workdayButtonLabelParts(button);
        var section = u.normalizeText(sectionName, stripLongDash).toLowerCase();
        return (
          parts.includes("add another") ||
          label.includes("add another") ||
          label.includes("add another " + section)
        );
      };
      var elementIsEmpty = function (el) {
        if (!el) {
          return true;
        }
        if (el.tagName === "SELECT") {
          return isPlaceholderText(
            el.options?.[el.selectedIndex]?.text || el.value || "",
          );
        }
        if (el.tagName === "BUTTON") {
          return isPlaceholderText(getButtonValueText(el));
        }
        if (el.isContentEditable || el.getAttribute("role") === "textbox") {
          return !u.normalizeText(el.textContent || "", stripLongDash);
        }
        return !u.normalizeText(el.value || "", stripLongDash);
      };
      var firstText = function (values) {
        for (var idx = 0; idx < values.length; idx++) {
          var text = u.normalizeText(values[idx], stripLongDash);
          if (text) {
            return text;
          }
        }
        return "";
      };
      var listFromProfileAliases = function (aliases) {
        var combined = [];
        aliases.forEach(function (alias) {
          var value = profile?.[alias];
          if (Array.isArray(value)) {
            combined = combined.concat(value);
          } else if (value && typeof value === "object") {
            combined.push(value);
          } else if (value) {
            combined = combined.concat(normalizeProfileList(value));
          }
        });
        return combined;
      };
      var normalizeWorkExperienceEntry = function (entry) {
        if (!entry) {
          return null;
        }
        if (typeof entry === "string") {
          var parts = u
            .normalizeText(entry, stripLongDash)
            .split(/\s+(?:at|@|-|--)\s+/i)
            .map(function (part) {
              return part.trim();
            })
            .filter(Boolean);
          return {
            jobTitle: parts.length > 1 ? parts[0] : "",
            company: parts.length > 1 ? parts.slice(1).join(" ") : parts[0],
            location: "",
            startMonth: "",
            startYear: "",
            endMonth: "",
            endYear: "",
            current: false,
            description: "",
          };
        }
        return {
          jobTitle: firstText([
            entry.jobTitle,
            entry.title,
            entry.positionTitle,
            entry.position,
            entry.role,
            entry.businessTitle,
          ]),
          company: firstText([
            entry.company,
            entry.employer,
            entry.organization,
            entry.organisation,
            entry.companyName,
          ]),
          location: firstText([entry.location, entry.city, entry.workLocation]),
          startMonth: firstText([entry.startMonth, entry.fromMonth]),
          startYear: firstText([entry.startYear, entry.fromYear]),
          endMonth: firstText([entry.endMonth, entry.toMonth]),
          endYear: firstText([entry.endYear, entry.toYear]),
          current: Boolean(entry.current || entry.isCurrent),
          description: firstText([
            entry.description,
            entry.responsibilities,
            entry.summary,
            entry.notes,
          ]),
        };
      };
      var normalizeEducationEntry = function (entry) {
        if (!entry) {
          return null;
        }
        if (typeof entry === "string") {
          return {
            school: u.normalizeText(entry, stripLongDash),
            degree: "",
            degreeLevel: "",
            fieldOfStudy: "",
            startMonth: "",
            startYear: "",
            endMonth: "",
            endYear: "",
            overallResult: "",
          };
        }
        return {
          school: firstText([
            entry.school,
            entry.university,
            entry.institution,
            entry.institutionName,
            entry.schoolName,
          ]),
          degree: firstText([
            entry.degree,
            entry.degreeName,
            entry.credential,
            entry.qualification,
          ]),
          degreeLevel: firstText([
            entry.degreeLevel,
            entry.educationLevel,
            entry.level,
          ]),
          fieldOfStudy: firstText([
            entry.fieldOfStudy,
            entry.major,
            entry.areaOfStudy,
            entry.discipline,
          ]),
          startMonth: firstText([entry.startMonth, entry.fromMonth]),
          startYear: firstText([entry.startYear, entry.fromYear]),
          endMonth: firstText([entry.endMonth, entry.toMonth]),
          endYear: firstText([entry.endYear, entry.toYear]),
          overallResult: firstText([
            entry.overallResult,
            entry.gpa,
            entry.grade,
            entry.result,
          ]),
        };
      };
      var normalizeLanguageEntry = function (entry) {
        if (!entry) {
          return null;
        }
        if (typeof entry === "string") {
          var languageParts = u
            .normalizeText(entry, stripLongDash)
            .split(/\s+(?:-|--|:|,)\s+/)
            .map(function (part) {
              return part.trim();
            })
            .filter(Boolean);
          return {
            language: languageParts[0] || "",
            proficiency: languageParts.slice(1).join(" "),
          };
        }
        return {
          language: firstText([
            entry.language,
            entry.name,
            entry.languageName,
            entry.spokenLanguage,
          ]),
          proficiency: firstText([
            entry.proficiency,
            entry.level,
            entry.fluency,
            entry.ability,
          ]),
        };
      };
      var hasAnyEntryValue = function (entry) {
        return Object.entries(entry || {}).some(function (pair) {
          return pair[0] !== "current" && Boolean(pair[1]);
        });
      };
      var dedupeEntries = function (entries, keyFor) {
        var seen = new Set();
        return entries.filter(function (entry) {
          if (!entry || !hasAnyEntryValue(entry)) {
            return false;
          }
          var key = u.normalizeText(keyFor(entry), stripLongDash).toLowerCase();
          if (!key || seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });
      };
      var profileWorkExperience = dedupeEntries(
        listFromProfileAliases([
          "workExperience",
          "workExperiences",
          "experience",
          "experiences",
          "pastJobs",
          "jobs",
          "employment",
          "employmentHistory",
          "workHistory",
        ])
          .map(normalizeWorkExperienceEntry)
          .filter(Boolean),
        function (entry) {
          return [entry.jobTitle, entry.company].filter(Boolean).join("|");
        },
      );
      var profileEducation = dedupeEntries(
        listFromProfileAliases([
          "education",
          "educations",
          "educationHistory",
          "schools",
          "degrees",
          "academicHistory",
        ])
          .map(normalizeEducationEntry)
          .filter(Boolean),
        function (entry) {
          return [
            entry.school,
            entry.degreeLevel,
            entry.degree,
            entry.fieldOfStudy,
          ]
            .filter(Boolean)
            .join("|");
        },
      );
      var profileLanguages = dedupeEntries(
        listFromProfileAliases([
          "languages",
          "languageSkills",
          "spokenLanguages",
          "languageProficiencies",
        ])
          .map(normalizeLanguageEntry)
          .filter(Boolean),
        function (entry) {
          return [entry.language, entry.proficiency].filter(Boolean).join("|");
        },
      );
      var profileSkills = normalizeProfileList(
        listFromProfileAliases([
          "skills",
          "skillList",
          "technicalSkills",
          "technologies",
          "tools",
        ]),
      );
      var profileWebsiteEntries = normalizeProfileList(
        [
          profile.websiteUrl,
          profile.website,
          profile.portfolioUrl,
          profile.portfolio,
          profile.personalWebsite,
          profile.linkedinUrl,
          profile.linkedInUrl,
          profile.githubUrl,
          profile.gitHubUrl,
        ].concat(
          listFromProfileAliases([
            "websites",
            "websiteUrls",
            "links",
            "profiles",
            "portfolioLinks",
          ]),
        ),
      );
      var sectionNames = [
        "Work Experience",
        "Education",
        "Languages",
        "Skills",
        "Resume/CV",
        "Websites",
      ];
      var workdayDebugMark = function (event, detail) {
        try {
          window.__huntWorkdayFillDebug = window.__huntWorkdayFillDebug || [];
          window.__huntWorkdayFillDebug.push({
            event: event,
            detail: detail || {},
            at: Date.now(),
          });
          if (window.__huntWorkdayFillDebug.length > 80) {
            window.__huntWorkdayFillDebug.shift();
          }
        } catch (_error) {
          // Debug markers must never affect filling.
        }
      };
      var headingCandidates = function () {
        var candidates = Array.from(
          document.querySelectorAll('h1,h2,h3,h4,[role="heading"]'),
        ).filter(visibleElement);
        if (!candidates.length) {
          candidates = Array.from(document.querySelectorAll("body *")).filter(
            function (el) {
              var text = textOf(el);
              return visibleElement(el) && sectionNames.includes(text);
            },
          );
        }
        return candidates
          .map(function (el) {
            return {
              el: el,
              text: textOf(el),
              rect: el.getBoundingClientRect(),
            };
          })
          .filter(function (entry) {
            return sectionNames.includes(entry.text);
          })
          .sort(function (a, b) {
            return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
          });
      };
      var sectionBounds = function (name) {
        var headings = headingCandidates();
        var heading = headings.find(function (entry) {
          return entry.text === name;
        });
        if (!heading) {
          return null;
        }
        var next = headings.find(function (entry) {
          return entry.rect.top > heading.rect.top + 4;
        });
        return {
          top: heading.rect.top,
          bottom: next ? next.rect.top : Number.POSITIVE_INFINITY,
          rect: heading.rect,
        };
      };
      var visibleInSection = function (name, selector) {
        var bounds = sectionBounds(name);
        if (!bounds) {
          return [];
        }
        return visibleWithin(document, selector).filter(function (el) {
          var rect = el.getBoundingClientRect();
          return rect.top >= bounds.top && rect.top < bounds.bottom;
        });
      };
      var sectionFillTargetCount = function (name) {
        return visibleInSection(
          name,
          'input:not([type="hidden"]):not([type="file"]), textarea, select, button[aria-haspopup="listbox"]',
        ).length;
      };
      var waitForSectionFieldCountIncrease = async function (
        name,
        beforeCount,
      ) {
        for (var attempt = 0; attempt < 12; attempt++) {
          if (activeDialog() || sectionFillTargetCount(name) > beforeCount) {
            return;
          }
          await sleep(150);
        }
      };
      var sectionText = function (name) {
        var bounds = sectionBounds(name);
        if (!bounds) {
          return "";
        }
        return u.normalizeText(
          Array.from(document.querySelectorAll("body *"))
            .filter(visibleElement)
            .filter(function (el) {
              var rect = el.getBoundingClientRect();
              return rect.top >= bounds.top && rect.top < bounds.bottom;
            })
            .map(textOf)
            .filter(Boolean)
            .join(" "),
          stripLongDash,
        );
      };
      var sectionSearchText = function (name) {
        var bounds = sectionBounds(name);
        if (!bounds) {
          return "";
        }
        var controlText = Array.from(
          document.querySelectorAll(
            'input, textarea, select, button, [role="button"], [role="textbox"]',
          ),
        )
          .filter(function (el) {
            var rect = el.getBoundingClientRect();
            return rect.top >= bounds.top && rect.top < bounds.bottom;
          })
          .map(function (el) {
            return u.normalizeText(
              [
                el.value,
                el.innerText,
                el.textContent,
                el.getAttribute?.("aria-label"),
                el.getAttribute?.("title"),
              ]
                .filter(Boolean)
                .join(" "),
              stripLongDash,
            );
          })
          .filter(Boolean)
          .join(" ");
        return u.normalizeText([sectionText(name), controlText].join(" "));
      };
      var baseName = function (value) {
        var text = u.normalizeText(value || "", stripLongDash);
        return text.split(/[\\/]/).filter(Boolean).pop() || text;
      };
      var resumeFileNameCandidates = function () {
        return normalizeProfileList([
          activeApplyContext.selectedResumeName,
          activeApplyContext.selectedResumePath
            ? baseName(activeApplyContext.selectedResumePath)
            : "",
          defaultResume.pdfFileName,
          defaultResume.pdfPath ? baseName(defaultResume.pdfPath) : "",
          defaultResume.label,
        ]);
      };
      var hasExistingResumeUpload = function () {
        var text = (
          sectionText("Resume/CV") ||
          u.normalizeText(
            document.body ? document.body.innerText : "",
            stripLongDash,
          )
        ).toLowerCase();
        if (
          !text ||
          !(
            text.includes("successfully uploaded") ||
            text.includes("uploaded") ||
            text.includes(".pdf")
          )
        ) {
          return false;
        }
        var names = resumeFileNameCandidates();
        if (!names.length) {
          return text.includes(".pdf") && text.includes("uploaded");
        }
        return (
          names.some(function (name) {
            return text.includes(name.toLowerCase());
          }) ||
          (text.includes(".pdf") && text.includes("uploaded"))
        );
      };
      var sectionHasValues = function (name, values) {
        var text = sectionSearchText(name).toLowerCase();
        return values
          .map(function (value) {
            return u.normalizeText(value, stripLongDash).toLowerCase();
          })
          .filter(Boolean)
          .every(function (value) {
            return text.includes(value);
          });
      };
      var structuredRowText = function (controls) {
        return u.normalizeText(
          controls
            .map(function (el) {
              return [
                el.value,
                el.innerText,
                el.textContent,
                el.getAttribute?.("aria-label"),
                el.getAttribute?.("title"),
              ]
                .filter(Boolean)
                .join(" ");
            })
            .filter(Boolean)
            .join(" "),
          stripLongDash,
        );
      };
      var structuredControlGroupsForSection = function (section, kind) {
        var prefix =
          kind === "work"
            ? "workExperience"
            : kind === "language"
              ? "language"
              : "education";
        var rowsByKey = new Map();
        var selector =
          'input, textarea, select, button, [role="button"], [role="textbox"]';
        Array.from(document.querySelectorAll(selector))
          .filter(visibleElement)
          .forEach(function (el) {
            var id = el.id || "";
            var marker = prefix + "-";
            if (!id.startsWith(marker) || !id.includes("--")) {
              return;
            }
            var rowKey = id.slice(0, id.indexOf("--"));
            if (!rowKey) {
              return;
            }
            if (!rowsByKey.has(rowKey)) {
              rowsByKey.set(rowKey, []);
            }
            rowsByKey.get(rowKey).push(el);
          });
        var groups = Array.from(rowsByKey.values());
        if (groups.length) {
          return groups;
        }
        var bounds = sectionBounds(section);
        if (!bounds) {
          return [];
        }
        return Array.from(document.querySelectorAll(selector))
          .filter(visibleElement)
          .filter(function (el) {
            var rect = el.getBoundingClientRect();
            return rect.top >= bounds.top && rect.top < bounds.bottom;
          })
          .map(function (el) {
            return [el];
          });
      };
      var structuredRowsForSection = function (section, kind) {
        return structuredControlGroupsForSection(section, kind)
          .map(function (controls) {
            return structuredRowText(controls).toLowerCase();
          })
          .filter(Boolean);
      };
      var structuredGroupKey = function (controls) {
        for (var idx = 0; idx < controls.length; idx++) {
          var id = controls[idx].id || "";
          if (id.includes("--")) {
            return id.slice(0, id.indexOf("--"));
          }
        }
        return controls
          .map(function (el) {
            return el.id || el.name || getDescriptor(el).slice(0, 80);
          })
          .filter(Boolean)
          .join("|");
      };
      var structuredGroupHasUserValue = function (controls) {
        return controls.some(function (control) {
          if (
            control.matches?.('input[type="checkbox"], input[type="radio"]')
          ) {
            return false;
          }
          if (
            control.matches?.(
              'input[type="hidden"], input[type="file"], button:not([aria-haspopup="listbox"])',
            )
          ) {
            return false;
          }
          return !elementIsEmpty(control);
        });
      };
      var structuredGroupHasFillableControl = function (controls) {
        return controls.some(function (control) {
          if (
            control.matches?.(
              'input:not([type="hidden"]):not([type="file"]), textarea, select, [role="textbox"], [contenteditable="true"], button[aria-haspopup="listbox"]',
            )
          ) {
            return true;
          }
          return false;
        });
      };
      var emptyStructuredControlGroupsForSection = function (
        section,
        kind,
        usedKeys,
      ) {
        return structuredControlGroupsForSection(section, kind).filter(
          function (controls) {
            var key = structuredGroupKey(controls);
            return (
              key &&
              !usedKeys.has(key) &&
              structuredGroupHasFillableControl(controls) &&
              !structuredGroupHasUserValue(controls)
            );
          },
        );
      };
      var controlGroupRect = function (controls) {
        var rects = controls
          .map(function (control) {
            return control.getBoundingClientRect();
          })
          .filter(function (rect) {
            return rect.width > 0 && rect.height > 0;
          });
        if (!rects.length) {
          return { top: 0, bottom: 0, left: 0, right: 0 };
        }
        return {
          top: Math.min.apply(
            null,
            rects.map(function (rect) {
              return rect.top;
            }),
          ),
          bottom: Math.max.apply(
            null,
            rects.map(function (rect) {
              return rect.bottom;
            }),
          ),
          left: Math.min.apply(
            null,
            rects.map(function (rect) {
              return rect.left;
            }),
          ),
          right: Math.max.apply(
            null,
            rects.map(function (rect) {
              return rect.right;
            }),
          ),
        };
      };
      var isDeleteRowButton = function (button) {
        var label = u
          .normalizeText(
            [
              textOf(button),
              button.getAttribute?.("aria-label"),
              button.getAttribute?.("title"),
              button.getAttribute?.("data-automation-id"),
              button.className?.baseVal || button.className,
            ]
              .filter(Boolean)
              .join(" "),
            stripLongDash,
          )
          .toLowerCase();
        return (
          label.includes("delete") ||
          label.includes("remove") ||
          label.includes("trash")
        );
      };
      var findDeleteButtonNearRect = function (section, rect) {
        var bounds = sectionBounds(section);
        if (!bounds) {
          return null;
        }
        return visibleWithin(document, 'button, [role="button"], a, [tabindex]')
          .filter(function (button) {
            if (!isDeleteRowButton(button)) {
              return false;
            }
            var buttonRect = button.getBoundingClientRect();
            var centerY = buttonRect.top + buttonRect.height / 2;
            return (
              buttonRect.top >= bounds.top &&
              buttonRect.top < bounds.bottom &&
              centerY >= rect.top - 120 &&
              centerY <= rect.bottom + 60
            );
          })
          .sort(function (a, b) {
            var aRect = a.getBoundingClientRect();
            var bRect = b.getBoundingClientRect();
            return (
              Math.abs(aRect.top - rect.top) - Math.abs(bRect.top - rect.top) ||
              bRect.left - aRect.left
            );
          })[0];
      };
      var removeSurplusEmptyStructuredRows = async function (section, kind) {
        var removed = 0;
        var groups = emptyStructuredControlGroupsForSection(
          section,
          kind,
          new Set(),
        );
        for (var idx = 0; idx < groups.length; idx++) {
          var controls = groups[idx];
          var key = structuredGroupKey(controls);
          var deleteButton = findDeleteButtonNearRect(
            section,
            controlGroupRect(controls),
          );
          if (!deleteButton) {
            continue;
          }
          traceInteraction("section_remove_empty_row", deleteButton, {
            reason: "remove_surplus_empty_workday_repeatable_row",
            fieldName: section,
            currentValue: key,
          });
          realisticClick(deleteButton, "remove_surplus_empty_workday_row");
          await sleep(300);
          removed += 1;
        }
        return removed;
      };
      var removeDuplicateStructuredRows = async function (
        section,
        kind,
        entries,
        duplicateValues,
      ) {
        var removed = 0;
        var seenGroupKeys = new Set();
        for (var entryIdx = 0; entryIdx < entries.length; entryIdx++) {
          var wanted = duplicateValues(entries[entryIdx] || {})
            .map(function (value) {
              return u.normalizeText(value, stripLongDash).toLowerCase();
            })
            .filter(Boolean);
          if (!wanted.length) {
            continue;
          }
          var matchingGroups = structuredControlGroupsForSection(section, kind)
            .filter(function (controls) {
              var key = structuredGroupKey(controls);
              if (seenGroupKeys.has(key)) {
                return false;
              }
              var rowText = structuredRowText(controls).toLowerCase();
              return wanted.every(function (value) {
                return rowText.includes(value);
              });
            })
            .sort(function (a, b) {
              return controlGroupRect(a).top - controlGroupRect(b).top;
            });
          if (matchingGroups.length) {
            seenGroupKeys.add(structuredGroupKey(matchingGroups[0]));
          }
          for (var groupIdx = 1; groupIdx < matchingGroups.length; groupIdx++) {
            var controls = matchingGroups[groupIdx];
            var key = structuredGroupKey(controls);
            var deleteButton = findDeleteButtonNearRect(
              section,
              controlGroupRect(controls),
            );
            if (!deleteButton) {
              continue;
            }
            traceInteraction("section_remove_duplicate_row", deleteButton, {
              reason: "remove_duplicate_workday_repeatable_row",
              fieldName: section,
              currentValue: key,
            });
            realisticClick(deleteButton, "remove_duplicate_workday_row");
            await sleep(300);
            removed += 1;
          }
        }
        return removed;
      };
      var sectionHasStructuredEntry = function (section, kind, values) {
        var wanted = values
          .map(function (value) {
            return u.normalizeText(value, stripLongDash).toLowerCase();
          })
          .filter(Boolean);
        if (!wanted.length) {
          return false;
        }
        var rows = structuredRowsForSection(section, kind);
        if (rows.length) {
          return rows.some(function (rowText) {
            return wanted.every(function (value) {
              return rowText.includes(value);
            });
          });
        }
        return sectionHasValues(section, wanted);
      };
      var findSectionAddButton = function (name, preferAddAnother) {
        var bounds = sectionBounds(name);
        if (!bounds) {
          return null;
        }
        return visibleWithin(document, 'button, [role="button"], a, [tabindex]')
          .filter(function (button) {
            var rect = button.getBoundingClientRect();
            return (
              isWorkdayAddButtonLabel(button, name) &&
              rect.top >= bounds.top &&
              rect.top < bounds.bottom
            );
          })
          .sort(function (a, b) {
            var aAddAnother = isWorkdayAddAnotherButtonLabel(a, name) ? 0 : 1;
            var bAddAnother = isWorkdayAddAnotherButtonLabel(b, name) ? 0 : 1;
            if (preferAddAnother && aAddAnother !== bAddAnother) {
              return aAddAnother - bAddAnother;
            }
            return (
              a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
              a.getBoundingClientRect().left - b.getBoundingClientRect().left
            );
          })[0];
      };
      var sectionInventory = function (section, filled, reason, valueSource) {
        var bounds = sectionBounds(section) || {
          rect: { top: 0, left: 0, width: 0, height: 0 },
        };
        var entry = {
          kind: "workdaySection",
          tagName: "SECTION",
          type: "",
          name: section,
          id: "",
          descriptor: section.toLowerCase(),
          questionHash: u.buildQuestionHash(section),
          required: false,
          filled: Boolean(filled),
          skippedReason: reason || "",
          valueSource: valueSource || "",
          options: [],
          rect: rectSummary(bounds.rect),
        };
        fieldInventory.push(entry);
        traceFieldEvent("field_consider", entry, document.body, {
          reason: "workday_section",
        });
        if (filled) {
          traceFieldEvent("field_filled", entry, document.body, {
            reason: "workday_section_filled",
          });
        } else {
          traceFieldEvent("field_skipped", entry, document.body, {
            reason: reason || "workday_section_not_filled",
          });
        }
      };
      var activeDialog = function () {
        var dialogs = visibleWithin(document, '[role="dialog"]').sort(
          function (a, b) {
            return (
              b.getBoundingClientRect().width *
                b.getBoundingClientRect().height -
              a.getBoundingClientRect().width * a.getBoundingClientRect().height
            );
          },
        );
        return dialogs[0] || null;
      };
      var waitForActiveDialog = async function () {
        for (var attempt = 0; attempt < 12; attempt++) {
          var dialog = activeDialog();
          if (dialog) {
            return dialog;
          }
          await sleep(150);
        }
        return null;
      };
      var findActionButton = function (root, labels) {
        var wanted = labels.map(function (label) {
          return label.toLowerCase();
        });
        return visibleWithin(root || document, "button")
          .filter(function (button) {
            return wanted.includes(textOf(button).toLowerCase());
          })
          .filter(function (button) {
            return button.getAttribute("aria-disabled") !== "true";
          })[0];
      };
      var choiceFromText = function (text, source) {
        var normalized = u.normalizeText(text, stripLongDash);
        if (!normalized) {
          return null;
        }
        return {
          text: normalized,
          source: source,
          aliases: [normalized],
          requireOptionMatch: true,
        };
      };
      var fillSelectWithChoice = function (select, value, source) {
        var choice = choiceFromText(value, source);
        if (!choice) {
          return false;
        }
        var selected = Array.from(select.options || [])
          .map(function (option) {
            return {
              option: option,
              score: optionScore(option.text, option.value, choice),
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          })[0]?.option;
        if (!selected) {
          return false;
        }
        select.value = selected.value;
        u.dispatchInputEvents(select);
        return true;
      };
      var fillWorkdayButtonDropdownWithChoice = async function (
        button,
        value,
        source,
      ) {
        if (fillBudgetExceeded()) {
          return { filled: false, reason: "fill_budget_exceeded" };
        }
        var choice = choiceFromText(value, source);
        traceInteraction("dropdown_fill_start", button, {
          reason: "workday_entry_dropdown",
          currentValue: getButtonValueText(button),
          intendedValue: value || "",
          valueSource: source || "",
        });
        if (!choice) {
          traceInteraction("dropdown_select_failed", button, {
            reason: "empty_choice",
            intendedValue: value || "",
            valueSource: source || "",
          });
          return { filled: false, reason: "empty_choice" };
        }
        if (buttonValueMatchesChoice(button, choice)) {
          traceInteraction("already_filled", button, {
            reason: "workday_entry_button_matches_choice",
            currentValue: getButtonValueText(button),
            intendedValue: value || "",
          });
        }
        var fastCommit = await fastSelectWorkdayButtonChoice(
          button,
          choice,
          "",
          "open_workday_entry_dropdown_fast",
        );
        if (fastCommit.filled) {
          return { filled: true, valueSource: source };
        }
        if (buttonValueMatchesChoice(button, choice)) {
          return {
            filled: false,
            reason: "already_filled",
            valueSource: source || "existing_value",
          };
        }
        await closeOpenMenus();
        traceInteraction("dropdown_select_failed", button, {
          reason: fastCommit.reason || "fast_commit_failed",
          currentValue: getButtonValueText(button),
          intendedValue: value || "",
          valueSource: source || "",
        });
        return { filled: false, reason: fastCommit.reason || "commit_failed" };
      };
      var workdayMonthValue = function (value) {
        var month = u.normalizeText(value, stripLongDash);
        if (!month) {
          return "";
        }
        if (/^\d{1,2}$/.test(month)) {
          return month.padStart(2, "0");
        }
        var key = month.toLowerCase().slice(0, 3);
        var months = {
          jan: "01",
          feb: "02",
          mar: "03",
          apr: "04",
          may: "05",
          jun: "06",
          jul: "07",
          aug: "08",
          sep: "09",
          oct: "10",
          nov: "11",
          dec: "12",
        };
        return months[key] || month;
      };
      var monthYearValue = function (entry, prefix, descriptor) {
        var month = u.normalizeText(entry[prefix + "Month"], stripLongDash);
        var year = u.normalizeText(entry[prefix + "Year"], stripLongDash);
        if (descriptor.includes("month")) {
          return workdayMonthValue(month);
        }
        if (descriptor.includes("year")) {
          return year;
        }
        if (descriptor.includes("date")) {
          return [workdayMonthValue(month), year].filter(Boolean).join("/");
        }
        return "";
      };
      var workdayDegreeValue = function (value) {
        var text = u.normalizeText(value, stripLongDash);
        var lower = text.toLowerCase();
        if (!text) {
          return "";
        }
        if (/\b(phd|doctor|doctorate)\b/.test(lower)) {
          return "Doctorate";
        }
        if (/\b(masters?|m\.?sc|m\.?a|mba)\b/.test(lower)) {
          return "Masters";
        }
        if (/\b(bachelors?|bachelor|bsc|b\.?sc|ba|b\.?a)\b/.test(lower)) {
          return "Bachelors";
        }
        if (/\b(associate|associates)\b/.test(lower)) {
          return "Associates";
        }
        if (/\b(high school)\b/.test(lower)) {
          return "High School Diploma";
        }
        if (/\b(diploma)\b/.test(lower)) {
          return "Diploma";
        }
        return text;
      };
      var fieldSignal = function (el) {
        return u
          .normalizeText(
            [
              el?.id,
              el?.name,
              el?.getAttribute?.("aria-label"),
              el?.getAttribute?.("placeholder"),
              el?.getAttribute?.("data-automation-id"),
            ]
              .filter(Boolean)
              .join(" "),
            stripLongDash,
          )
          .toLowerCase();
      };
      var workExperienceValue = function (descriptor, entry, el) {
        var signal = fieldSignal(el);
        if (
          signal.includes("jobtitle") ||
          signal.includes("job title") ||
          signal.includes("positiontitle") ||
          signal.includes("business title")
        ) {
          return entry.jobTitle;
        }
        if (
          signal.includes("companyname") ||
          signal.includes("company") ||
          signal.includes("employer")
        ) {
          return entry.company;
        }
        if (signal.includes("location") || signal.includes("city")) {
          return entry.location;
        }
        if (
          signal.includes("roledescription") ||
          signal.includes("role description") ||
          signal.includes("description") ||
          signal.includes("responsibilities")
        ) {
          return sanitizeWorkdayStructuredText(entry.description);
        }
        if (signal.includes("startdate") || signal.includes("start date")) {
          return monthYearValue(entry, "start", signal);
        }
        if (
          !entry.current &&
          (signal.includes("enddate") || signal.includes("end date"))
        ) {
          return monthYearValue(entry, "end", signal);
        }
        var desc = u.normalizeText(descriptor).toLowerCase();
        if (
          desc.includes("job title") ||
          desc.includes("position title") ||
          desc.includes("business title")
        ) {
          return entry.jobTitle;
        }
        if (desc.includes("company") || desc.includes("employer")) {
          return entry.company;
        }
        if (desc.includes("location") || desc.includes("city")) {
          return entry.location;
        }
        if (
          desc.includes("role description") ||
          desc.includes("description") ||
          desc.includes("responsibilities")
        ) {
          return sanitizeWorkdayStructuredText(entry.description);
        }
        if (desc.includes("start") || desc.includes("from")) {
          return monthYearValue(entry, "start", desc);
        }
        if (!entry.current && (desc.includes("end") || desc.includes("to"))) {
          return monthYearValue(entry, "end", desc);
        }
        return "";
      };
      var educationValue = function (descriptor, entry, el) {
        var signal = fieldSignal(el);
        if (
          signal.includes("schoolname") ||
          signal.includes("school") ||
          signal.includes("university") ||
          signal.includes("institution")
        ) {
          return entry.school;
        }
        if (signal.includes("degree")) {
          return workdayDegreeValue(entry.degreeLevel || entry.degree);
        }
        if (
          signal.includes("fieldofstudy") ||
          signal.includes("field of study") ||
          signal.includes("major") ||
          signal.includes("areaofstudy")
        ) {
          return entry.fieldOfStudy;
        }
        if (
          signal.includes("gradeaverage") ||
          signal.includes("overall result") ||
          signal.includes("gpa") ||
          signal.includes("grade")
        ) {
          return entry.overallResult;
        }
        if (signal.includes("startdate") || signal.includes("start date")) {
          return monthYearValue(entry, "start", signal);
        }
        if (signal.includes("enddate") || signal.includes("end date")) {
          return monthYearValue(entry, "end", signal);
        }
        var desc = u.normalizeText(descriptor).toLowerCase();
        if (
          desc.includes("school") ||
          desc.includes("university") ||
          desc.includes("institution")
        ) {
          return entry.school;
        }
        if (desc.includes("degree")) {
          return workdayDegreeValue(entry.degreeLevel || entry.degree);
        }
        if (
          desc.includes("field of study") ||
          desc.includes("major") ||
          desc.includes("area of study")
        ) {
          return entry.fieldOfStudy;
        }
        if (
          desc.includes("overall result") ||
          desc.includes("gpa") ||
          desc.includes("grade")
        ) {
          return entry.overallResult;
        }
        if (desc.includes("start") || desc.includes("from")) {
          return monthYearValue(entry, "start", desc);
        }
        if (desc.includes("end") || desc.includes("to")) {
          return monthYearValue(entry, "end", desc);
        }
        return "";
      };
      var languageValue = function (descriptor, entry, el) {
        var signal = fieldSignal(el);
        var desc = u.normalizeText(descriptor).toLowerCase();
        if (
          signal.includes("language") ||
          desc.includes("language") ||
          desc.includes("spoken")
        ) {
          return entry.language;
        }
        if (
          signal.includes("proficiency") ||
          signal.includes("fluency") ||
          signal.includes("level") ||
          signal.includes("ability") ||
          desc.includes("proficiency") ||
          desc.includes("fluency") ||
          desc.includes("level") ||
          desc.includes("ability")
        ) {
          return entry.proficiency;
        }
        return "";
      };
      var structuredValueFor = function (kind, descriptor, entry, el) {
        if (kind === "work") {
          return workExperienceValue(descriptor, entry, el);
        }
        if (kind === "language") {
          return languageValue(descriptor, entry, el);
        }
        return educationValue(descriptor, entry, el);
      };
      var structuredSourceFor = function (kind) {
        if (kind === "work") {
          return "profile:workExperience";
        }
        if (kind === "language") {
          return "profile:languages";
        }
        return "profile:education";
      };
      var fillEntryDialog = async function (
        entry,
        kind,
        section,
        targetControls,
      ) {
        workdayDebugMark("fill_entry_start", {
          kind: kind,
          section: section,
          hasTargetControls: Boolean(targetControls?.length),
        });
        var root = targetControls?.length ? null : await waitForActiveDialog();
        workdayDebugMark("fill_entry_root", {
          kind: kind,
          section: section,
          hasRoot: Boolean(root),
          targetControlCount: targetControls?.length || 0,
        });
        var valueFor = function (descriptor, el) {
          return structuredValueFor(kind, descriptor, entry, el);
        };
        var sourcePrefix = structuredSourceFor(kind);
        var filledCount = 0;

        var fieldSelector =
          'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea';
        var fields = targetControls?.length
          ? targetControls.filter(function (control) {
              return (
                control.matches?.(fieldSelector) && visibleElement(control)
              );
            })
          : root
            ? visibleWithin(root, fieldSelector)
            : [];
        if (!root) {
          fields = fields.filter(elementIsEmpty);
        }
        workdayDebugMark("fill_entry_fields", {
          kind: kind,
          section: section,
          count: fields.length,
          ids: fields.slice(0, 12).map(function (field) {
            return field.id || field.name || getDescriptor(field).slice(0, 80);
          }),
        });
        for (var idx = 0; idx < fields.length; idx++) {
          var field = fields[idx];
          var descriptor = getDescriptor(field);
          var value = valueFor(descriptor, field);
          workdayDebugMark("fill_entry_field_value", {
            kind: kind,
            section: section,
            id: field.id || field.name || "",
            hasValue: Boolean(value),
          });
          if (value && setStructuredTextValue(field, value)) {
            filledCount += 1;
          }
        }
        workdayDebugMark("fill_entry_after_text", {
          kind: kind,
          section: section,
          filledCount: filledCount,
        });

        var selects = targetControls?.length
          ? targetControls.filter(function (control) {
              return control.matches?.("select") && visibleElement(control);
            })
          : root
            ? visibleWithin(root, "select")
            : [];
        if (!root) {
          selects = selects.filter(elementIsEmpty);
        }
        workdayDebugMark("fill_entry_selects", {
          kind: kind,
          section: section,
          count: selects.length,
        });
        for (var selectIdx = 0; selectIdx < selects.length; selectIdx++) {
          var select = selects[selectIdx];
          var selectValue = valueFor(getDescriptor(select), select);
          if (fillSelectWithChoice(select, selectValue, sourcePrefix)) {
            filledCount += 1;
          }
        }

        var listboxButtons = targetControls?.length
          ? targetControls.filter(function (control) {
              return (
                control.matches?.('button[aria-haspopup="listbox"]') &&
                visibleElement(control)
              );
            })
          : root
            ? visibleWithin(root, 'button[aria-haspopup="listbox"]')
            : [];
        if (!root) {
          listboxButtons = listboxButtons.filter(elementIsEmpty);
        }
        workdayDebugMark("fill_entry_listboxes", {
          kind: kind,
          section: section,
          count: listboxButtons.length,
        });
        for (
          var buttonIdx = 0;
          buttonIdx < listboxButtons.length;
          buttonIdx++
        ) {
          var listboxButton = listboxButtons[buttonIdx];
          var buttonValue = valueFor(
            getDescriptor(listboxButton),
            listboxButton,
          );
          var buttonResult = await fillWorkdayButtonDropdownWithChoice(
            listboxButton,
            buttonValue,
            sourcePrefix,
          );
          if (buttonResult.filled) {
            filledCount += 1;
          }
        }

        if (kind === "work" && entry.current) {
          var checkboxes = targetControls?.length
            ? targetControls.filter(function (control) {
                return (
                  control.matches?.('input[type="checkbox"]') &&
                  visibleElement(control)
                );
              })
            : root
              ? visibleWithin(root, 'input[type="checkbox"]')
              : [];
          for (
            var checkboxIdx = 0;
            checkboxIdx < checkboxes.length;
            checkboxIdx++
          ) {
            var checkbox = checkboxes[checkboxIdx];
            var desc = getDescriptor(checkbox);
            if (desc.includes("current")) {
              if (await setCheckboxChecked(checkbox)) {
                filledCount += 1;
              }
            }
          }
        }

        workdayDebugMark("fill_entry_before_save", {
          kind: kind,
          section: section,
          filledCount: filledCount,
        });
        var saveButton =
          (root ? findActionButton(root, ["Save", "Done", "OK"]) : null) ||
          findActionButton(document, ["Save", "Done", "OK"]);
        if (saveButton) {
          realisticClick(saveButton, "save_workday_entry_dialog");
          await sleep(600);
        }
        return {
          filled: filledCount > 0,
          saved: Boolean(saveButton),
          filledCount: filledCount,
        };
      };
      var repairExistingStructuredEntry = async function (
        section,
        entry,
        kind,
        duplicateValues,
      ) {
        var wanted = duplicateValues(entry)
          .map(function (value) {
            return u.normalizeText(value, stripLongDash).toLowerCase();
          })
          .filter(Boolean);
        if (!wanted.length) {
          return 0;
        }
        var groups = structuredControlGroupsForSection(section, kind).filter(
          function (controls) {
            var rowText = structuredRowText(controls).toLowerCase();
            return wanted.every(function (value) {
              return rowText.includes(value);
            });
          },
        );
        var valueFor = function (descriptor, el) {
          return structuredValueFor(kind, descriptor, entry, el);
        };
        var sourcePrefix = structuredSourceFor(kind);
        var repaired = 0;
        for (var groupIdx = 0; groupIdx < groups.length; groupIdx++) {
          var controls = groups[groupIdx];
          for (var controlIdx = 0; controlIdx < controls.length; controlIdx++) {
            var control = controls[controlIdx];
            var descriptor = getDescriptor(control);
            var value = valueFor(descriptor, control);
            var signal = fieldSignal(control) + " " + descriptor;
            if (
              kind === "education" &&
              !value &&
              (signal.includes("gradeaverage") ||
                signal.includes("overall result") ||
                signal.includes("gpa") ||
                signal.includes("grade")) &&
              (control.value || control.textContent)
            ) {
              if (clearStructuredTextValue(control)) {
                repaired += 1;
              }
              continue;
            }
            if (!value) {
              continue;
            }
            if (
              control.matches?.('button[aria-haspopup="listbox"]') ||
              control.tagName === "BUTTON"
            ) {
              var buttonResult = await fillWorkdayButtonDropdownWithChoice(
                control,
                value,
                sourcePrefix,
              );
              if (buttonResult.filled) {
                repaired += 1;
              }
              continue;
            }
            if (
              control.matches?.('input[type="checkbox"]') &&
              kind === "work" &&
              entry.current &&
              descriptor.includes("current")
            ) {
              if (await setCheckboxChecked(control)) {
                repaired += 1;
              }
              continue;
            }
            if (
              control.matches?.(
                'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea',
              ) &&
              setStructuredTextValue(control, value)
            ) {
              repaired += 1;
            }
          }
        }
        return repaired;
      };
      var fillStructuredControls = async function (controls, entry, kind) {
        var valueFor = function (descriptor, el) {
          return structuredValueFor(kind, descriptor, entry, el);
        };
        var sourcePrefix = structuredSourceFor(kind);
        var filledCount = 0;
        for (var controlIdx = 0; controlIdx < controls.length; controlIdx++) {
          var control = controls[controlIdx];
          var descriptor = getDescriptor(control);
          var value = valueFor(descriptor, control);
          if (!value) {
            continue;
          }
          if (
            control.matches?.('button[aria-haspopup="listbox"]') ||
            control.tagName === "BUTTON"
          ) {
            var buttonResult = await fillWorkdayButtonDropdownWithChoice(
              control,
              value,
              sourcePrefix,
            );
            if (buttonResult.filled) {
              filledCount += 1;
            }
            continue;
          }
          if (
            control.matches?.('input[type="checkbox"]') &&
            kind === "work" &&
            entry.current &&
            descriptor.includes("current")
          ) {
            if (await setCheckboxChecked(control)) {
              filledCount += 1;
            }
            continue;
          }
          if (
            control.matches?.(
              'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea',
            ) &&
            setStructuredTextValue(control, value)
          ) {
            filledCount += 1;
          }
        }
        return filledCount;
      };
      var addStructuredEntries = async function (
        section,
        entries,
        kind,
        minimumValues,
        duplicateValues,
      ) {
        if (!entries.length) {
          if (sectionBounds(section)) {
            var removedEmptyNoProfileRows =
              await removeSurplusEmptyStructuredRows(section, kind);
            sectionInventory(
              section,
              removedEmptyNoProfileRows > 0,
              removedEmptyNoProfileRows > 0 ? "" : "missing_profile_entries",
              structuredSourceFor(kind),
            );
            if (removedEmptyNoProfileRows > 0) {
              pushFilledField(
                section + " empty entries",
                structuredSourceFor(kind),
                null,
                document.body,
                {
                  reason:
                    "removed_surplus_empty_repeatable_rows_without_profile",
                },
              );
              traceInteraction(
                "section_remove_empty_rows_complete",
                document.body,
                {
                  reason:
                    "removed_surplus_empty_repeatable_rows_without_profile",
                  fieldName: section,
                  currentValue: String(removedEmptyNoProfileRows),
                },
              );
            }
            traceInteraction("section_no_profile_entries", document.body, {
              reason: "missing_profile_entries",
              fieldName: section,
              currentValue:
                "removed_empty=" + String(removedEmptyNoProfileRows),
            });
          }
          return;
        }
        var usedEmptyGroupKeys = new Set();
        for (var idx = 0; idx < entries.length; idx++) {
          if (fillBudgetExceeded()) {
            pushManualReviewReason(
              section.toLowerCase().replace(/\s+/g, "_") +
                ":fill_budget_exceeded",
            );
            return;
          }
          var entry = entries[idx] || {};
          var requiredValues = minimumValues(entry).filter(Boolean);
          if (!requiredValues.length) {
            sectionInventory(section, false, "missing_profile_fact", "");
            pushManualReviewReason(
              section.toLowerCase().replace(/\s+/g, "_") +
                ":missing_profile_fact",
            );
            continue;
          }
          if (
            sectionHasStructuredEntry(section, kind, duplicateValues(entry))
          ) {
            var repaired = await repairExistingStructuredEntry(
              section,
              entry,
              kind,
              duplicateValues,
            );
            if (repaired > 0) {
              pushFilledField(
                section + " entry",
                structuredSourceFor(kind),
                null,
                document.body,
                { reason: "workday_structured_entry_repaired" },
              );
            }
            sectionInventory(section, false, "already_filled", "");
            continue;
          }
          var emptyGroup = emptyStructuredControlGroupsForSection(
            section,
            kind,
            usedEmptyGroupKeys,
          )[0];
          if (emptyGroup) {
            var emptyGroupKey = structuredGroupKey(emptyGroup);
            usedEmptyGroupKeys.add(emptyGroupKey);
            traceInteraction("section_reuse_empty_row", document.body, {
              reason: "reuse_empty_workday_repeatable_row",
              fieldName: section,
              valueSource: structuredSourceFor(kind),
              currentValue: emptyGroupKey,
            });
            var reused = await fillStructuredControls(emptyGroup, entry, kind);
            sectionInventory(
              section,
              reused > 0,
              reused > 0 ? "" : "empty_row_fill_failed",
              structuredSourceFor(kind),
            );
            if (reused > 0) {
              pushFilledField(
                section + " entry",
                structuredSourceFor(kind),
                null,
                document.body,
                { reason: "workday_structured_entry_reused_empty_row" },
              );
              await sleep(250);
              continue;
            }
            pushManualReviewReason(
              section.toLowerCase().replace(/\s+/g, "_") +
                ":empty_row_fill_failed",
            );
            return;
          }
          var addButton = findSectionAddButton(section, idx > 0);
          if (!addButton) {
            sectionInventory(section, false, "add_button_not_found", "");
            pushManualReviewReason(
              section.toLowerCase().replace(/\s+/g, "_") +
                ":add_button_not_found",
            );
            return;
          }
          var beforeGroupKeys = new Set(
            structuredControlGroupsForSection(section, kind).map(
              structuredGroupKey,
            ),
          );
          var beforeFieldCount = sectionFillTargetCount(section);
          workdayDebugMark("structured_add_before_click", {
            section: section,
            kind: kind,
            beforeFieldCount: beforeFieldCount,
          });
          realisticClick(addButton, "open_workday_" + kind + "_dialog");
          await waitForSectionFieldCountIncrease(section, beforeFieldCount);
          await sleep(250);
          workdayDebugMark("structured_add_after_click", {
            section: section,
            kind: kind,
            fieldCount: sectionFillTargetCount(section),
            hasDialog: Boolean(activeDialog()),
          });
          var result;
          if (!activeDialog()) {
            var inlineGroup =
              emptyStructuredControlGroupsForSection(
                section,
                kind,
                usedEmptyGroupKeys,
              )
                .filter(function (controls) {
                  return !beforeGroupKeys.has(structuredGroupKey(controls));
                })
                .sort(function (a, b) {
                  return (
                    controlGroupRect(b).top - controlGroupRect(a).top ||
                    controlGroupRect(b).left - controlGroupRect(a).left
                  );
                })[0] ||
              emptyStructuredControlGroupsForSection(
                section,
                kind,
                usedEmptyGroupKeys,
              )[0];
            if (inlineGroup) {
              var inlineGroupKey = structuredGroupKey(inlineGroup);
              usedEmptyGroupKeys.add(inlineGroupKey);
              traceInteraction("section_fill_inline_new_row", document.body, {
                reason: "fill_one_new_workday_repeatable_row",
                fieldName: section,
                valueSource: structuredSourceFor(kind),
                currentValue: inlineGroupKey,
              });
              result = await fillEntryDialog(entry, kind, section, inlineGroup);
            } else {
              result = { filled: false, saved: false, filledCount: 0 };
            }
          } else {
            result = await fillEntryDialog(entry, kind, section);
          }
          sectionInventory(
            section,
            result.filled,
            result.filled ? "" : "entry_fill_failed",
            structuredSourceFor(kind),
          );
          if (result.filled) {
            pushFilledField(
              section + " entry",
              structuredSourceFor(kind),
              null,
              document.body,
              {
                reason: result.saved
                  ? "workday_structured_entry"
                  : "workday_structured_entry_inline_row",
              },
            );
            await sleep(400);
          } else {
            pushManualReviewReason(
              section.toLowerCase().replace(/\s+/g, "_") + ":entry_fill_failed",
            );
          }
        }
        var removedEmptyRows = await removeSurplusEmptyStructuredRows(
          section,
          kind,
        );
        var removedDuplicateRows = await removeDuplicateStructuredRows(
          section,
          kind,
          entries,
          duplicateValues,
        );
        if (removedEmptyRows > 0 || removedDuplicateRows > 0) {
          sectionInventory(section, true, "", structuredSourceFor(kind));
          traceInteraction(
            "section_remove_empty_rows_complete",
            document.body,
            {
              reason: "removed_surplus_empty_repeatable_rows",
              fieldName: section,
              currentValue:
                "empty=" +
                String(removedEmptyRows) +
                "; duplicate=" +
                String(removedDuplicateRows),
            },
          );
        }
      };
      var addWorkExperienceEntries = async function () {
        await addStructuredEntries(
          "Work Experience",
          profileWorkExperience,
          "work",
          function (entry) {
            return [entry.jobTitle, entry.company];
          },
          function (entry) {
            return [entry.jobTitle, entry.company];
          },
        );
      };
      var addEducationEntries = async function () {
        await addStructuredEntries(
          "Education",
          profileEducation,
          "education",
          function (entry) {
            return [entry.school];
          },
          function (entry) {
            return [entry.school, entry.degree];
          },
        );
      };
      var addLanguageEntries = async function () {
        await addStructuredEntries(
          "Languages",
          profileLanguages,
          "language",
          function (entry) {
            return [entry.language];
          },
          function (entry) {
            return [entry.language, entry.proficiency];
          },
        );
      };
      var fillWorkdaySkills = async function () {
        if (!profileSkills.length) {
          if (sectionBounds("Skills")) {
            sectionInventory("Skills", false, "missing_profile_entries", "");
          }
          return;
        }
        var skillInput = visibleWithin(
          document,
          'input:not([type="hidden"]):not([type="file"])',
        ).find(function (input) {
          return getDescriptor(input).includes("skills");
        });
        if (!skillInput) {
          sectionInventory("Skills", false, "skills_input_not_found", "");
          return;
        }
        var isWorkdaySkillOptionChecked = function (option, checkbox) {
          if (checkbox) {
            return (
              checkbox.checked ||
              checkbox.getAttribute("aria-checked") === "true" ||
              checkbox.getAttribute("data-checked") === "true"
            );
          }
          return (
            option?.getAttribute?.("aria-selected") === "true" ||
            option?.getAttribute?.("aria-checked") === "true"
          );
        };
        var findWorkdaySkillCheckbox = function (option) {
          var checkTargets = visibleWithin(
            option,
            [
              'input[type="checkbox"]',
              '[role="checkbox"]',
              "[aria-checked]",
              '[data-automation-id*="checkbox" i]',
              '[class*="checkbox" i]',
            ].join(", "),
          );
          if (checkTargets.length) {
            return checkTargets[0];
          }
          var optionRect = option?.getBoundingClientRect?.();
          return (
            visibleWithin(option, "button, span, div, svg").find(
              function (candidate) {
                var rect = candidate.getBoundingClientRect();
                var text = textOf(candidate);
                return (
                  optionRect &&
                  rect.left <= optionRect.left + 56 &&
                  rect.width >= 10 &&
                  rect.width <= 34 &&
                  rect.height >= 10 &&
                  rect.height <= 34 &&
                  !text
                );
              },
            ) || null
          );
        };
        var selectWorkdaySkillOption = async function (option, skill) {
          var checkbox = findWorkdaySkillCheckbox(option);
          traceInteraction("dropdown_select_attempt", checkbox || option, {
            reason: checkbox
              ? "select_workday_skill_checkbox"
              : "select_workday_skill_option",
            optionText: textOf(option).slice(0, 160),
            intendedValue: skill,
            valueSource: "profile:skills",
          });
          realisticClick(
            checkbox || option,
            checkbox
              ? "select_workday_skill_checkbox"
              : "select_workday_skill_option",
          );
          await sleep(180);
          if (!isWorkdaySkillOptionChecked(option, checkbox)) {
            realisticClick(option, "select_workday_skill_option_row");
            await sleep(120);
          }
          if (!isWorkdaySkillOptionChecked(option, checkbox)) {
            keyOn(
              checkbox || option,
              " ",
              "select_workday_skill_checkbox_space",
            );
            await sleep(120);
          }
          traceInteraction("dropdown_select_result", checkbox || option, {
            reason: isWorkdaySkillOptionChecked(option, checkbox)
              ? "select_workday_skill_checkbox_committed"
              : "select_workday_skill_checkbox_failed",
            optionText: textOf(option).slice(0, 160),
            intendedValue: skill,
            valueSource: "profile:skills",
          });
        };
        var scoreSkillOptions = function (skillOptions, skill) {
          var choice = choiceFromText(skill, "profile:skills");
          return skillOptions
            .map(function (candidate) {
              return {
                option: candidate,
                score: optionScore(textOf(candidate), "", choice),
              };
            })
            .filter(function (candidate) {
              return candidate.score > 0;
            })
            .sort(function (a, b) {
              return b.score - a.score;
            });
        };
        var added = 0;
        var alreadyPresent = 0;
        for (var idx = 0; idx < profileSkills.length; idx++) {
          if (fillBudgetExceeded()) {
            pushManualReviewReason("skills:fill_budget_exceeded");
            break;
          }
          var skill = profileSkills[idx];
          if (sectionHasValues("Skills", [skill])) {
            alreadyPresent += 1;
            continue;
          }
          skillInput.focus();
          u.setElementValue(skillInput, skill, stripLongDash);
          await sleep(200);
          var skillOptions = await waitForVisibleOptions(1);
          if (!skillOptions.length) {
            keyOn(skillInput, "ArrowDown", "open_workday_skill_options");
            skillOptions = await waitForVisibleOptions(1);
          }
          var scoredSkillOptions = scoreSkillOptions(skillOptions, skill);
          traceInteraction("dropdown_options_scored", skillInput, {
            reason: "score_workday_skill_options",
            optionCount: skillOptions.length,
            matchingOptionCount: scoredSkillOptions.length,
            topOptionText: textOf(scoredSkillOptions[0]?.option).slice(0, 160),
            topScore: scoredSkillOptions[0]?.score || 0,
            intendedValue: skill,
            valueSource: "profile:skills",
          });
          var option = scoredSkillOptions[0]?.option;
          if (option) {
            await selectWorkdaySkillOption(option, skill);
          } else {
            traceInteraction("dropdown_select_fallback_enter", skillInput, {
              reason: "open_workday_skill_results_with_enter",
              intendedValue: skill,
              valueSource: "profile:skills",
            });
            keyOn(skillInput, "Enter", "commit_workday_skill_text");
            await sleep(240);
            skillOptions = await waitForVisibleOptions(1);
            scoredSkillOptions = scoreSkillOptions(skillOptions, skill);
            option = scoredSkillOptions[0]?.option;
            if (option) {
              await selectWorkdaySkillOption(option, skill);
            }
          }
          await sleep(350);
          await closeOpenMenus();
          if (sectionHasValues("Skills", [skill])) {
            added += 1;
          }
        }
        sectionInventory(
          "Skills",
          added > 0 || alreadyPresent > 0,
          added > 0 || alreadyPresent > 0 ? "" : "skills_not_committed",
          "profile:skills",
        );
        if (added > 0 || alreadyPresent > 0) {
          pushFilledField("Skills", "profile:skills", null, skillInput, {
            reason:
              added > 0 ? "workday_skills" : "workday_skills_already_present",
          });
        } else {
          traceInteraction("field_skipped", skillInput, {
            reason: "skills_not_committed",
            valueSource: "profile:skills",
          });
        }
      };
      var websiteTypeForUrl = function (url) {
        var lowered = u.normalizeText(url).toLowerCase();
        if (lowered.includes("linkedin.com")) {
          return "LinkedIn";
        }
        if (lowered.includes("github.com")) {
          return "GitHub";
        }
        return "Personal Website";
      };
      var fillWebsiteDialog = async function (url, preferExistingRow) {
        var root = preferExistingRow
          ? activeDialog()
          : await waitForActiveDialog();
        var filled = false;
        var inputSelector =
          'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea';
        var inputs = root
          ? visibleWithin(root, inputSelector)
          : visibleInSection("Websites", inputSelector);
        var urlInputs = inputs.filter(function (input) {
          var desc = getDescriptor(input);
          return desc.includes("url") || desc.includes("website");
        });
        var emptyUrlInputs = urlInputs.filter(elementIsEmpty);
        var target =
          emptyUrlInputs[0] ||
          urlInputs.find(function (input) {
            return (
              u
                .normalizeText(
                  input.value || input.textContent || "",
                  stripLongDash,
                )
                .toLowerCase() === url.toLowerCase()
            );
          }) ||
          inputs.filter(elementIsEmpty)[0];
        if (!target) {
          return false;
        }
        var currentValue = u
          .normalizeText(
            target.value || target.textContent || "",
            stripLongDash,
          )
          .toLowerCase();
        if (currentValue === url.toLowerCase()) {
          filled = true;
        } else if (currentValue) {
          return false;
        } else if (u.setElementValue(target, url, stripLongDash)) {
          filled = true;
        }
        var typeButtons = root
          ? visibleWithin(root, 'button[aria-haspopup="listbox"]')
          : visibleInSection("Websites", 'button[aria-haspopup="listbox"]');
        var typeButton = typeButtons
          .filter(elementIsEmpty)
          .find(function (button) {
            var desc = getDescriptor(button);
            return desc.includes("type") || desc.includes("category");
          });
        if (typeButton) {
          await fillWorkdayButtonDropdownWithChoice(
            typeButton,
            websiteTypeForUrl(url),
            "profile:websites",
          );
        }
        var saveButton =
          (root
            ? findActionButton(root, ["Save", "Done", "OK"])
            : findActionButton(document, ["Save", "Done", "OK"])) ||
          findActionButton(document, ["Save", "Done", "OK"]);
        if (saveButton) {
          realisticClick(saveButton, "save_workday_website_dialog");
          await sleep(500);
        }
        return filled;
      };
      var removeSurplusEmptyWebsiteRows = async function () {
        var bounds = sectionBounds("Websites");
        if (!bounds) {
          return 0;
        }
        var inputSelector =
          'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea';
        var blankUrlInputs = visibleInSection("Websites", inputSelector)
          .filter(function (input) {
            var desc = getDescriptor(input);
            return desc.includes("url") || desc.includes("website");
          })
          .filter(elementIsEmpty);
        var removed = 0;
        for (var idx = 0; idx < blankUrlInputs.length; idx++) {
          var input = blankUrlInputs[idx];
          var rect = input.getBoundingClientRect();
          var deleteButton = findDeleteButtonNearRect("Websites", {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
          });
          if (!deleteButton) {
            continue;
          }
          traceInteraction("section_remove_empty_row", deleteButton, {
            reason: "remove_surplus_empty_website_row",
            fieldName: "Websites",
            currentValue: input.id || input.name || "",
          });
          realisticClick(deleteButton, "remove_surplus_empty_website_row");
          await sleep(250);
          removed += 1;
        }
        return removed;
      };
      var addWebsiteEntries = async function () {
        if (!profileWebsiteEntries.length) {
          if (sectionBounds("Websites")) {
            sectionInventory("Websites", false, "missing_profile_entries", "");
          }
          return;
        }
        var added = 0;
        for (var idx = 0; idx < profileWebsiteEntries.length; idx++) {
          if (fillBudgetExceeded()) {
            pushManualReviewReason("websites:fill_budget_exceeded");
            break;
          }
          var url = profileWebsiteEntries[idx];
          if (sectionHasValues("Websites", [url])) {
            continue;
          }
          var existingWebsiteFilled = await fillWebsiteDialog(url, true);
          if (existingWebsiteFilled) {
            added += 1;
            continue;
          }
          var addButton = findSectionAddButton("Websites");
          if (!addButton) {
            sectionInventory("Websites", false, "add_button_not_found", "");
            return;
          }
          var beforeWebsiteFieldCount = sectionFillTargetCount("Websites");
          realisticClick(addButton, "open_workday_website_dialog");
          await waitForSectionFieldCountIncrease(
            "Websites",
            beforeWebsiteFieldCount,
          );
          await sleep(250);
          var websiteFilled = await fillWebsiteDialog(url);
          if (websiteFilled) {
            added += 1;
          } else {
            sectionInventory("Websites", false, "website_fill_failed", "");
            pushManualReviewReason("websites:website_fill_failed");
            break;
          }
        }
        var removedEmptyWebsites = await removeSurplusEmptyWebsiteRows();
        sectionInventory(
          "Websites",
          added > 0 || removedEmptyWebsites > 0,
          added > 0 || removedEmptyWebsites > 0 ? "" : "website_fill_failed",
          "profile:websites",
        );
        if (added > 0 || removedEmptyWebsites > 0) {
          pushFilledField("Websites", "profile:websites", null, document.body, {
            reason:
              removedEmptyWebsites > 0
                ? "workday_websites_removed_empty_rows"
                : "workday_websites",
          });
        }
      };
      var processResumeFileInputs = async function () {
        if (existingResumeUploadDetected || hasExistingResumeUpload()) {
          existingResumeUploadDetected = true;
          resumeUploadDone = true;
          return;
        }
        if (resumeUploadDone || !hasResumeData) {
          return;
        }
        var inputs = Array.from(
          document.querySelectorAll('input[type="file"]'),
        ).filter(function (el) {
          return !el.disabled && isResumeFileInput(getDescriptor(el));
        });
        for (var idx = 0; idx < inputs.length; idx++) {
          var input = inputs[idx];
          var attachment = await u.attachResumeToFileInput(
            input,
            activeApplyContext,
            defaultResume,
          );
          if (attachment.attached) {
            resumeUploadDone = true;
            pushFilledField(
              getDescriptor(input) || "resume_upload",
              "resume_upload",
              null,
              input,
              { reason: "resume_file_attached_before_sections" },
            );
            await sleep(perUploadDelayMs);
            return;
          }
          pushManualReviewReason("resume_upload:" + attachment.reason);
        }
      };
      var processMyExperienceSections = async function () {
        var visibleHeadingTexts = Array.from(
          document.querySelectorAll('h1,h2,[role="heading"]'),
        )
          .filter(visibleElement)
          .map(textOf)
          .filter(Boolean);
        var onReviewPage =
          document.querySelector(
            '[data-automation-id="bottomNavigationSubmitButton"], [data-automation-id="submitButton"], button[aria-label*="Submit Application"]',
          ) !== null ||
          Array.from(document.querySelectorAll("button")).some(function (b) {
            return /^\s*submit\s*$/i.test(b.textContent || "");
          }) ||
          visibleHeadingTexts.some(function (h) {
            return /\breview\b/i.test(h);
          });
        if (onReviewPage) {
          return;
        }
        if (
          !sectionBounds("Work Experience") &&
          !sectionBounds("Education") &&
          !sectionBounds("Languages") &&
          !sectionBounds("Websites")
        ) {
          return;
        }
        traceInteraction("inspect", document.body, {
          reason: "workday_my_experience_profile_counts",
          currentValue:
            "work=" +
            String(profileWorkExperience.length) +
            "; education=" +
            String(profileEducation.length) +
            "; languages=" +
            String(profileLanguages.length) +
            "; skills=" +
            String(profileSkills.length) +
            "; websites=" +
            String(profileWebsiteEntries.length),
        });
        await addWorkExperienceEntries();
        await addEducationEntries();
        await addLanguageEntries();
        await addWebsiteEntries();
        await fillWorkdaySkills();
      };

      var existingResumeUploadDetected = hasExistingResumeUpload();
      if (existingResumeUploadDetected) {
        resumeUploadDone = true;
        traceInteraction("already_filled", document.body, {
          reason: "existing_resume_upload_detected",
          currentValue: resumeFileNameCandidates().join(", "),
          intendedValue: "resume_upload",
        });
      }

      if (
        activeApplyContext.jobId &&
        activeApplyContext.selectedResumeReadyForC3 === false
      ) {
        pushManualReviewReason("resume_not_ready_for_c3");
      }
      if (
        !hasResumeData &&
        !existingResumeUploadDetected &&
        pageLooksLikeResumeUpload()
      ) {
        pushManualReviewReason("resume_upload:missing_resume_data");
      }

      await waitForInitialWorkdayHydration();
      workdayDebugMark("after_initial_hydration", {
        url: window.location.href,
      });
      await primeCountryDependentFields();
      workdayDebugMark("after_prime_country", {});
      await processResumeFileInputs();
      workdayDebugMark("after_resume_file_inputs", {
        resumeUploadDone: resumeUploadDone,
      });
      if (currentStepHeadingMatches("My Experience")) {
        await processMyExperienceSections();
      }
      workdayDebugMark("after_my_experience_sections", {});
      await waitForCurrentStepFillableControls();
      workdayDebugMark("after_fillable_controls_wait", {
        snapshot: meaningfulFillableControlsSnapshot(),
      });

      // Setup and Workday hydration can be slow on some tenants. The fill budget
      // should protect the actual field loop, not expire before it starts.
      fillStartedAt = Date.now();

      // Collect every visible fillable element on the current step.
      var textInputs = u.getVisibleElements(
        'input:not([type="hidden"]):not([type="file"])',
      );
      var textareas = u.getVisibleElements("textarea");
      var selects = u.getVisibleElements("select");
      var buttonDropdowns = u.getVisibleElements(
        'button[aria-haspopup="listbox"]',
      );
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
      var flatEls = textInputs.concat(
        textareas,
        selects,
        buttonDropdowns,
        fileInputs,
      );
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
      workdayDebugMark("candidate_loop_start", {
        count: sorted.length,
      });
      traceInteraction("candidate_loop_start", document.body, {
        reason: "workday_candidate_collection",
        textInputCount: textInputs.length,
        textareaCount: textareas.length,
        selectCount: selects.length,
        buttonDropdownCount: buttonDropdowns.length,
        fileInputCount: fileInputs.length,
        radioCount: radios.length,
        candidateCount: sorted.length,
      });

      for (var k = 0; k < sorted.length; k++) {
        if (fillBudgetExceeded()) {
          pushManualReviewReason("workday_fill_budget_exceeded");
          break;
        }
        var candidate = sorted[k];
        workdayDebugMark("candidate_start", {
          index: k,
          kind: candidate.kind,
          id: candidate.element?.id || candidate.radios?.[0]?.id || "",
          tagName: candidate.element?.tagName || "",
          type: candidate.element?.type || "",
        });

        if (candidate.kind === "radioGroup") {
          var descriptor = candidate.radios
            .map(function (r) {
              return [
                r.id,
                r.name,
                r.value,
                r.getAttribute?.("aria-label"),
                getDescriptor(r),
              ]
                .filter(Boolean)
                .join(" ");
            })
            .join(" ")
            .toLowerCase();
          var radioInventory = inventoryEntry(candidate, descriptor);
          fieldInventory.push(radioInventory);
          traceFieldEvent(
            "field_consider",
            radioInventory,
            candidate.radios[0],
            {
              reason: "radio_group_candidate",
            },
          );
          if (
            fillRequiredOnly &&
            !radioInventory.required &&
            !isKnownWorkdayRadioGroup(descriptor)
          ) {
            markFieldSkipped(
              radioInventory,
              candidate.radios[0],
              "not_required",
            );
            continue;
          }
          if (
            u.fillRadioGroup(
              candidate.radios,
              descriptor,
              profile,
              containerSelectors,
            )
          ) {
            var selectedRadio =
              candidate.radios.find(function (radio) {
                return radio.checked;
              }) || candidate.radios[0];
            markFieldFilled(radioInventory, selectedRadio, "radio_rule");
            pushFilledField(
              descriptor,
              "radio_rule",
              radioInventory,
              selectedRadio,
            );
            await sleep(perFieldDelayMs);
          } else {
            var isKnownSingletonAlternative =
              candidate.radios.length === 1 &&
              (descriptor.includes("candidateispreviousworker") ||
                (/\byes\b/.test(descriptor) && /\bno\b/.test(descriptor)));
            markFieldSkipped(
              radioInventory,
              candidate.radios[0],
              isKnownSingletonAlternative ? "not_required" : "no_known_match",
            );
          }
          continue;
        }

        var elem = candidate.element;
        var desc = getDescriptor(elem);
        workdayDebugMark("candidate_descriptor", {
          index: k,
          id: elem.id || elem.name || "",
          tagName: elem.tagName || "",
          type: elem.type || "",
          descriptor: desc.slice(0, 160),
        });
        var elementInventory = inventoryEntry(candidate, desc);
        fieldInventory.push(elementInventory);
        traceFieldEvent("field_consider", elementInventory, elem, {
          reason: "element_candidate",
        });
        if (!desc) {
          markFieldSkipped(elementInventory, elem, "missing_descriptor");
          continue;
        }

        if (
          (sectionBounds("Work Experience") ||
            sectionBounds("Education") ||
            sectionBounds("Websites")) &&
          descriptorHasAny(desc, [
            "work experience",
            "education",
            "websites",
            "web addresses",
          ])
        ) {
          markFieldAlreadyFilled(elementInventory, elem, "workday_section", {
            reason: "handled_workday_section",
          });
          continue;
        }

        if (elem.tagName === "INPUT" && elem.type === "file") {
          if (existingResumeUploadDetected || hasExistingResumeUpload()) {
            existingResumeUploadDetected = true;
            resumeUploadDone = true;
            markFieldAlreadyFilled(
              elementInventory,
              elem,
              "resume_upload_existing",
              { reason: "existing_resume_upload_detected" },
            );
            traceInteraction("already_filled", elem, {
              reason: "existing_resume_upload_detected",
              currentValue: resumeFileNameCandidates().join(", "),
              intendedValue: "resume_upload",
            });
            continue;
          }
          if (resumeUploadDone) {
            markFieldSkipped(elementInventory, elem, "resume_already_uploaded");
            continue;
          }
          if (!isResumeFileInput(desc)) {
            markFieldSkipped(elementInventory, elem, "not_resume_input");
            continue;
          }
          var attachment = await u.attachResumeToFileInput(
            elem,
            activeApplyContext,
            defaultResume,
          );
          if (attachment.attached) {
            markFieldFilled(elementInventory, elem, "resume_upload", {
              reason: "resume_file_attached",
            });
            resumeUploadDone = true;
            pushFilledField(
              getDescriptor(elem) || "resume_upload",
              "resume_upload",
              elementInventory,
              elem,
            );
            await sleep(perUploadDelayMs);
          } else {
            markFieldSkipped(
              elementInventory,
              elem,
              "resume_upload:" + attachment.reason,
            );
            pushManualReviewReason("resume_upload:" + attachment.reason);
          }
          continue;
        }

        if (
          fillRequiredOnly &&
          !elementInventory.required &&
          !isWorkdayDatePartField(elem, desc)
        ) {
          markFieldSkipped(elementInventory, elem, "not_required");
          continue;
        }

        if (
          elem.tagName === "INPUT" &&
          elem.type !== "file" &&
          shouldSkipProfileFill(elem, desc)
        ) {
          markFieldSkipped(elementInventory, elem, "unsafe_profile_context");
          continue;
        }

        if (
          elem.tagName === "INPUT" &&
          elem.type !== "file" &&
          isApplicationSourceField(elem, desc)
        ) {
          var sourceText = sourceChoiceText();
          var sourceResult = await fillWorkdaySearchInputChoice(
            elem,
            desc,
            sourceText,
            "activeApplyContext:source",
          );
          if (sourceResult.filled || sourceResult.reason === "already_filled") {
            if (sourceResult.filled) {
              markFieldFilled(
                elementInventory,
                elem,
                sourceResult.valueSource || "activeApplyContext:source",
              );
              pushFilledField(
                desc,
                elementInventory.valueSource,
                elementInventory,
                elem,
              );
            } else {
              markFieldAlreadyFilled(
                elementInventory,
                elem,
                sourceResult.valueSource || "activeApplyContext:source",
                { reason: "workday_search_input_matches_choice" },
              );
            }
            await sleep(perFieldDelayMs);
          } else {
            markFieldSkipped(
              elementInventory,
              elem,
              sourceResult.reason || "no_known_match",
            );
          }
          continue;
        }

        if (
          elem.tagName === "INPUT" &&
          elem.type !== "file" &&
          isWorkdaySearchInputField(elem) &&
          !isPhoneCountryCodeField(elem, desc) &&
          !/citizenship\s*status|citizenshipstatus/i.test(desc)
        ) {
          var structuredSearchChoice = u.chooseStructuredChoice
            ? u.chooseStructuredChoice(desc, profileWithContext, stripLongDash)
            : null;
          if (structuredSearchChoice?.text) {
            var structuredSearchResult = await fillWorkdaySearchInputChoice(
              elem,
              desc,
              structuredSearchChoice.text,
              structuredSearchChoice.source || "structured_search_choice",
            );
            if (
              structuredSearchResult.filled ||
              structuredSearchResult.reason === "already_filled"
            ) {
              if (structuredSearchResult.filled) {
                markFieldFilled(
                  elementInventory,
                  elem,
                  structuredSearchResult.valueSource ||
                    structuredSearchChoice.source ||
                    "structured_search_choice",
                );
                pushFilledField(
                  desc,
                  elementInventory.valueSource,
                  elementInventory,
                  elem,
                );
              } else {
                markFieldAlreadyFilled(
                  elementInventory,
                  elem,
                  structuredSearchResult.valueSource ||
                    structuredSearchChoice.source ||
                    "structured_search_choice",
                  { reason: "workday_search_input_matches_choice" },
                );
              }
              await sleep(perFieldDelayMs);
            } else {
              markFieldSkipped(
                elementInventory,
                elem,
                structuredSearchResult.reason || "no_known_match",
              );
            }
            continue;
          }
        }

        if (
          elem.tagName === "INPUT" &&
          elem.type !== "file" &&
          isPhoneCountryCodeField(elem, desc)
        ) {
          var phoneCountryResult = await fillPhoneCountryCode(elem, desc);
          if (
            phoneCountryResult.filled ||
            phoneCountryResult.reason === "already_filled"
          ) {
            if (phoneCountryResult.filled) {
              markFieldFilled(
                elementInventory,
                elem,
                phoneCountryResult.valueSource || "phone_country_code",
              );
            } else {
              markFieldAlreadyFilled(
                elementInventory,
                elem,
                phoneCountryResult.valueSource || "phone_country_code",
                { reason: "phone_country_code_matches_choice" },
              );
            }
            if (phoneCountryResult.filled) {
              pushFilledField(
                desc,
                elementInventory.valueSource,
                elementInventory,
                elem,
              );
            }
            await sleep(perFieldDelayMs);
          } else {
            markFieldSkipped(
              elementInventory,
              elem,
              phoneCountryResult.reason || "no_known_match",
            );
          }
          continue;
        }

        if (elem.tagName === "INPUT" && elem.type === "checkbox") {
          if (shouldCheckRequiredCheckbox(elem, desc)) {
            var checked = await setCheckboxChecked(elem);
            if (checked) {
              markFieldFilled(
                elementInventory,
                elem,
                "required_terms_checkbox",
              );
              pushFilledField(
                desc,
                elementInventory.valueSource,
                elementInventory,
                elem,
              );
              await sleep(perFieldDelayMs);
            } else {
              markFieldSkipped(
                elementInventory,
                elem,
                "checkbox_commit_failed",
              );
            }
          } else {
            markFieldSkipped(elementInventory, elem, "unsupported_checkbox");
          }
          continue;
        }

        if (
          elem.tagName === "BUTTON" &&
          elem.getAttribute("aria-haspopup") === "listbox"
        ) {
          var buttonResult = await fillWorkdayButtonDropdown(elem, desc);
          if (
            Array.isArray(buttonResult.options) &&
            buttonResult.options.length
          ) {
            elementInventory.options = buttonResult.options;
          }
          if (buttonResult.filled || buttonResult.reason === "already_filled") {
            if (buttonResult.filled) {
              markFieldFilled(
                elementInventory,
                elem,
                buttonResult.valueSource || "button_rule",
                {
                  bestEffortWarning: buttonResult.bestEffortWarning || "",
                  defaultSelectedOption:
                    buttonResult.defaultSelectedOption || "",
                },
              );
            } else {
              markFieldAlreadyFilled(
                elementInventory,
                elem,
                buttonResult.valueSource || "button_rule",
                { reason: "workday_button_matches_choice" },
              );
            }
            if (buttonResult.filled) {
              pushFilledField(
                desc,
                elementInventory.valueSource,
                elementInventory,
                elem,
                {
                  bestEffortWarning: buttonResult.bestEffortWarning || "",
                  defaultSelectedOption:
                    buttonResult.defaultSelectedOption || "",
                },
              );
            }
            await sleep(perFieldDelayMs);
          } else {
            markFieldSkipped(
              elementInventory,
              elem,
              buttonResult.reason || "no_known_match",
            );
          }
          continue;
        }

        if (elem.tagName === "TEXTAREA") {
          if (shouldSkipGeneratedAnswer(desc)) {
            if (elementInventory.required) {
              var fallbackText = "Not applicable.";
              if (await setWorkdayTextValue(elem, desc, fallbackText)) {
                var textareaWarning =
                  "best_effort_default:unsafe_generated_answer_context:" +
                  u.normalizeText(desc || "").slice(0, 160) +
                  " -> " +
                  fallbackText;
                markFieldFilled(
                  elementInventory,
                  elem,
                  "best_effort:default_text",
                  {
                    answerLength: fallbackText.length,
                    bestEffortWarning: textareaWarning,
                  },
                );
                var fallbackHash = u.buildQuestionHash(desc);
                generatedAnswers.push({
                  questionHash: fallbackHash,
                  questionText: desc,
                  answerText: fallbackText,
                  answerSource: "best_effort:default_text",
                  confidence: "low",
                  manualReviewRequired: true,
                });
                pushFilledField(
                  desc,
                  "best_effort:default_text",
                  elementInventory,
                  elem,
                  { bestEffortWarning: textareaWarning },
                );
                await sleep(perFieldDelayMs);
                continue;
              }
            }
            markFieldSkipped(
              elementInventory,
              elem,
              "unsafe_generated_answer_context",
            );
            continue;
          }
          // Skip already-filled or generation-disabled.
          if (elem.value || settings.allowGeneratedAnswers === false) {
            if (elem.value) {
              markFieldAlreadyFilled(elementInventory, elem, "existing_value", {
                reason: "textarea_has_existing_value",
              });
            } else {
              markFieldSkipped(
                elementInventory,
                elem,
                "generated_answers_disabled",
              );
            }
            continue;
          }
          var answer = u.generateAnswer(
            desc,
            profile,
            activeApplyContext,
            stripLongDash,
          );
          if (u.setElementValue(elem, answer.answerText, stripLongDash)) {
            markFieldFilled(elementInventory, elem, "generated_answer", {
              answerLength: answer.answerText.length,
              manualReviewRequired: answer.manualReviewRequired,
            });
            var qHash = u.buildQuestionHash(desc);
            generatedAnswers.push({
              questionHash: qHash,
              questionText: desc,
              answerText: answer.answerText,
              answerSource: "generated",
              confidence: answer.confidence,
              manualReviewRequired: answer.manualReviewRequired,
            });
            pushFilledField(desc, "generated_answer", elementInventory, elem);
            if (
              settings.flagLowConfidenceAnswers !== false &&
              answer.manualReviewRequired
            ) {
              pushBestEffortWarning("low_confidence_answer:" + qHash);
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
            markFieldFilled(
              elementInventory,
              elem,
              selectResult.valueSource || "select_rule",
              { bestEffortWarning: selectResult.bestEffortWarning || "" },
            );
            pushFilledField(
              desc,
              elementInventory.valueSource,
              elementInventory,
              elem,
              { bestEffortWarning: selectResult.bestEffortWarning || "" },
            );
            await sleep(perFieldDelayMs);
          } else {
            markFieldSkipped(
              elementInventory,
              elem,
              selectResult.reason || "no_known_match",
            );
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
            markFieldFilled(
              elementInventory,
              elem,
              comboResult.valueSource || "combobox_rule",
            );
            pushFilledField(
              desc,
              elementInventory.valueSource,
              elementInventory,
              elem,
            );
            await sleep(perFieldDelayMs);
          } else {
            markFieldSkipped(
              elementInventory,
              elem,
              comboResult.reason || "no_known_match",
            );
          }
          continue;
        }

        // Plain text input - map descriptor to profile value.
        if (shouldSkipProfileFill(elem, desc)) {
          markFieldSkipped(elementInventory, elem, "unsafe_profile_context");
          continue;
        }
        if (isExactCityField(elem, desc) && profile.location) {
          var cityValue = u
            .normalizeText(profile.location)
            .split(",")[0]
            .trim();
          if (
            cityValue &&
            markTextInputAlreadyFilled(
              elementInventory,
              elem,
              desc,
              cityValue,
              "profile:location",
            )
          ) {
            continue;
          }
          if (cityValue && u.setElementValue(elem, cityValue, stripLongDash)) {
            markFieldFilled(elementInventory, elem, "profile:location");
            pushFilledField(
              desc,
              elementInventory.valueSource,
              elementInventory,
              elem,
            );
            await sleep(perFieldDelayMs);
            continue;
          }
        }
        var exactProfileMatch = chooseExactWorkdayTextProfileMatch(elem);
        if (exactProfileMatch && !exactProfileMatch.value) {
          markFieldSkipped(elementInventory, elem, "no_known_match");
          continue;
        }
        var profileMatch = exactProfileMatch
          ? exactProfileMatch
          : u.chooseProfileMatch
            ? u.chooseProfileMatch(desc, profile)
            : null;
        var profileValue = profileMatch
          ? profileMatch.value
          : u.chooseProfileValue(desc, profile);
        profileValue = workdayPhoneTextValue(elem, desc, profileValue);
        profileValue = workdayDatePartValue(elem, desc, profileValue);
        if (
          profileValue &&
          markTextInputAlreadyFilled(
            elementInventory,
            elem,
            desc,
            profileValue,
            profileMatch ? profileMatch.key : "profile",
          )
        ) {
          continue;
        }
        if (
          profileValue &&
          (await setWorkdayTextValue(elem, desc, profileValue))
        ) {
          markFieldFilled(
            elementInventory,
            elem,
            profileMatch ? profileMatch.key : "profile",
          );
          pushFilledField(
            desc,
            elementInventory.valueSource,
            elementInventory,
            elem,
          );
          await sleep(perFieldDelayMs);
        } else {
          markFieldSkipped(elementInventory, elem, "no_known_match");
        }
      }

      finalizeRequiredFieldReview();

      if (fillCancelled()) {
        pushManualReviewReason("user_cancelled");
      }
      var resultPayload = {
        ok: !fillCancelled(),
        cancelled: fillCancelled(),
        reason: fillCancelled() ? "user_cancelled" : "",
        message: fillCancelled() ? "Fill canceled." : "",
        atsType: "workday",
        frameUrl: window.location.href,
        authState: u.detectAuthState(),
        filledFieldCount: filledFields.length,
        generatedAnswerCount: generatedAnswers.length,
        manualReviewRequired: manualReviewReasons.length > 0,
        manualReviewReasons: manualReviewReasons,
        bestEffortWarnings: bestEffortWarnings,
        filledFields: filledFields,
        fieldInventory: fieldInventory,
        interactionTrace: interactionTrace,
        traceInteractionLimit: traceInteractionLimit,
        traceTruncated: traceTruncated,
        generatedAnswers: generatedAnswers,
        htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000),
      };
      return resultPayload;
    } catch (error) {
      return {
        ok: false,
        reason: "workday_adapter_exception",
        message: error?.message || String(error),
        stack: String(error?.stack || "").slice(0, 4000),
        atsType: "workday",
        frameUrl: window.location.href,
        authState: u.detectAuthState ? u.detectAuthState() : "unknown",
        filledFieldCount: filledFields.length,
        generatedAnswerCount: generatedAnswers.length,
        manualReviewRequired: true,
        manualReviewReasons: ["workday_adapter_exception"],
        bestEffortWarnings: bestEffortWarnings,
        filledFields: filledFields,
        fieldInventory: fieldInventory,
        interactionTrace: interactionTrace,
        traceInteractionLimit: traceInteractionLimit,
        traceTruncated: traceTruncated,
        generatedAnswers: generatedAnswers,
        htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000),
      };
    } finally {
      u.traceInteraction = previousTraceInteraction || function () {};
    }
  };
}
