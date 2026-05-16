(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});
  function _huntLog(tag, data) {
    var entry = Object.assign({ _tag: tag, _ts: Date.now() }, data);
    (window.__huntC3Logs = window.__huntC3Logs || []).push(entry);
    console.log("[HUNT:C3] " + tag, data);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function clean(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function norm(value) {
    return clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9+]+/g, " ")
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
      style.pointerEvents !== "none" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function keyOn(target, keyName) {
    if (!target || typeof target.dispatchEvent !== "function") {
      return;
    }
    var keyCodes = {
      Enter: 13,
      Escape: 27,
      ArrowDown: 40,
      Backspace: 8,
      Delete: 46,
    };
    var code = keyCodes[keyName] || 0;
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: keyName,
        code: keyName,
        keyCode: code,
        which: code,
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: keyName,
        code: keyName,
        keyCode: code,
        which: code,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function clickLikeUser(el) {
    if (!el) {
      return;
    }
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", inline: "nearest" });
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
      var Ctor =
        window.PointerEvent && type.startsWith("pointer")
          ? window.PointerEvent
          : MouseEvent;
      el.dispatchEvent(
        new Ctor(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 0,
          buttons: type.includes("down") ? 1 : 0,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
        }),
      );
    });
  }

  function printableKeyOn(target, char) {
    if (!target || typeof target.dispatchEvent !== "function" || !char) {
      return;
    }
    var code = char.length === 1 ? char.toUpperCase().charCodeAt(0) : 0;
    var base = {
      key: char,
      code: char.length === 1 ? "Key" + char.toUpperCase() : char,
      keyCode: code,
      which: code,
      charCode: code,
      bubbles: true,
      cancelable: true,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", base));
    target.dispatchEvent(new KeyboardEvent("keypress", base));
    target.dispatchEvent(new KeyboardEvent("keyup", base));
  }

  async function typeaheadOn(target, text) {
    var value = clean(text || "");
    if (!target || !value) {
      return;
    }
    try {
      target.focus({ preventScroll: true });
    } catch (_error) {
      target.focus?.();
    }
    for (var idx = 0; idx < value.length; idx++) {
      printableKeyOn(target, value[idx]);
      await sleep(25);
    }
  }

  function triggerReactClickHandler(el) {
    try {
      var fiberKey = Object.keys(el || {}).find(function (key) {
        return (
          key.startsWith("__reactFiber$") ||
          key.startsWith("__reactInternalInstance$")
        );
      });
      if (!fiberKey) {
        return false;
      }
      var node = el[fiberKey];
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
  }

  function triggerReactClickDeep(el) {
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
    for (var idx = 0; idx < candidates.length; idx++) {
      if (triggerReactClickHandler(candidates[idx])) {
        return true;
      }
    }
    return false;
  }

  function setValue(el, value) {
    if (!el) {
      return false;
    }
    if (window.__huntApplyUtils?.setElementValue) {
      return window.__huntApplyUtils.setElementValue(el, value, true);
    }
    if ("value" in el) {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }

  function optionLabel(el) {
    var seen = {};
    return clean(
      [
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("title"),
        el?.innerText,
        el?.textContent,
      ]
        .map(clean)
        .filter(function (piece) {
          var key = norm(piece);
          if (!key || seen[key]) {
            return false;
          }
          seen[key] = true;
          return true;
        })
        .join(" "),
    );
  }

  function isApplicationSourceField(el, descriptor) {
    var key = [
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("placeholder"),
      descriptor,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    return (
      key.includes("how did you hear about us") ||
      key.includes("source--source") ||
      /\bsource\b/.test(key)
    );
  }

  function visibleWorkdayOptions() {
    var options = [];
    var seen = new Set();
    Array.from(
      document.querySelectorAll(
        [
          '[role="option"]',
          '[data-automation-id="promptOption"]',
          '[data-automation-id="promptOptionContent"]',
          '[data-automation-id="menuItem"]',
          '[data-automation-id="selectOption"]',
          "[aria-selected]",
          ".gwt-SuggestBoxPopup .item",
        ].join(", "),
      ),
    )
      .filter(visible)
      .forEach(function (el) {
        var target =
          el.closest?.('[role="option"]') ||
          el.closest?.('[data-automation-id="promptOption"]') ||
          el;
        if (
          target.closest?.('[data-automation-id="selectedItemList"]') ||
          target.matches?.('[data-automation-id="selectedItem"]') ||
          target.querySelector?.('[data-automation-id="selectedItem"]')
        ) {
          return;
        }
        var label = optionLabel(target);
        if (lowerPressDelete(label)) {
          return;
        }
        var key =
          label +
          "::" +
          (target.id ||
            target.getAttribute("data-automation-id") ||
            options.length);
        if (!label || seen.has(key)) {
          return;
        }
        seen.add(key);
        options.push({
          label: label,
          value: label,
          element: target,
          placeholder: false,
        });
      });
    return options;
  }

  function visibleOptionCandidates() {
    return Array.from(
      document.querySelectorAll(
        [
          '[role="option"]',
          '[data-automation-id="menuItem"]',
          '[data-automation-id="promptOption"]',
        ].join(", "),
      ),
    ).filter(function (option) {
      var style = window.getComputedStyle(option);
      var rect = option.getBoundingClientRect();
      var listbox = option.closest?.('[role="listbox"]');
      var listRect = listbox?.getBoundingClientRect?.();
      var intersectsListbox =
        !listbox ||
        !listRect ||
        listRect.width <= 0 ||
        listRect.height <= 0 ||
        (rect.bottom > listRect.top &&
          rect.top < listRect.bottom &&
          rect.right > listRect.left &&
          rect.left < listRect.right);
      return (
        option.getAttribute("aria-disabled") !== "true" &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        intersectsListbox
      );
    });
  }

  function workdayActiveListboxFor(input) {
    var multiSelectId = input?.getAttribute?.("data-uxi-multiselect-id") || "";
    var visibleListboxes = Array.from(
      document.querySelectorAll(
        [
          '[data-automation-id="activeListContainer"]',
          '[data-automation-id="promptSearchResultList"]',
          '[data-uxi-widget-type="multiselectlist"]',
          '[role="listbox"]',
        ].join(", "),
      ),
    )
      .filter(function (listbox) {
        var style = window.getComputedStyle(listbox);
        var rect = listbox.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .sort(function (a, b) {
        var aScrollable = Math.max(0, a.scrollHeight - a.clientHeight);
        var bScrollable = Math.max(0, b.scrollHeight - b.clientHeight);
        var aAssoc =
          multiSelectId &&
          [
            a.id,
            a.getAttribute("aria-labelledby"),
            a.getAttribute("data-uxi-multiselect-id"),
            a.getAttribute("data-automation-id"),
          ]
            .join(" ")
            .includes(multiSelectId)
            ? 100000
            : 0;
        var bAssoc =
          multiSelectId &&
          [
            b.id,
            b.getAttribute("aria-labelledby"),
            b.getAttribute("data-uxi-multiselect-id"),
            b.getAttribute("data-automation-id"),
          ]
            .join(" ")
            .includes(multiSelectId)
            ? 100000
            : 0;
        return (
          bAssoc - aAssoc ||
          bScrollable - aScrollable ||
          b.getBoundingClientRect().height - a.getBoundingClientRect().height
        );
      });
    return visibleListboxes[0] || null;
  }

  function workdayOptionRadioTarget(option) {
    return (
      option?.querySelector?.(
        [
          'input[data-automation-id="radioBtn"]',
          'input[type="radio"]',
          '[role="radio"]',
          '[data-automation-id="checkboxPanel"]',
        ].join(", "),
      ) || option
    );
  }

  function workdayClickOptionCommitTarget(option) {
    var target = workdayOptionRadioTarget(option);
    clickLikeUser(target || option);
    if (target !== option) {
      clickLikeUser(option);
    }
    triggerReactClickDeep(target || option);
    if (target !== option) {
      triggerReactClickDeep(option);
    }
  }

  async function scrollWorkdayListboxUntil(input, findMatch, maxAttempts) {
    var listbox = workdayActiveListboxFor(input);
    var attempts = 0;
    var match = findMatch();
    while (
      !match &&
      listbox &&
      attempts < (maxAttempts || 80) &&
      listbox.scrollHeight > listbox.clientHeight + 2 &&
      !window.__huntApplyCancelAllFills &&
      !window.__huntApplyCancelFillRunId
    ) {
      attempts += 1;
      listbox.scrollTop += 260;
      listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(30);
      match = findMatch();
    }
    return { match: match, listbox: listbox, attempts: attempts };
  }

  function lowerPressDelete(label) {
    return norm(label).includes("press delete to clear value");
  }

  function optionMatches(option, expected) {
    var label = norm(option?.label);
    var target = norm(expected);
    if (!label || !target) {
      return false;
    }
    return (
      label === target ||
      label.includes(target) ||
      target.includes(label) ||
      (target.includes("+1") && label.includes("canada")) ||
      (target.includes("canada") && label.includes("+1"))
    );
  }

  function committedStateMatches(state, answer, option) {
    var label = clean(state?.text || state?.rawValue || "");
    if (!state?.selected || !label) {
      return false;
    }
    return (
      option?.committed ||
      optionMatches({ label: label }, answer?.value) ||
      optionMatches({ label: label }, option?.label)
    );
  }

  function firstRealOption(options) {
    return (
      root.optionMatcher?.realOptions?.(options || [])[0] ||
      (options || []).find(function (option) {
        return option.label;
      }) ||
      null
    );
  }

  function insertTextOrSet(input, text) {
    setValue(input, "");
    var inserted = false;
    if (document.execCommand) {
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch (_error) {
        inserted = false;
      }
    }
    if (!inserted || clean(input.value) !== clean(text)) {
      setValue(input, text);
    }
  }

  async function openPopup(field, searchText) {
    var el = field.element;
    var sourceField = isApplicationSourceField(el, field.descriptor);
    _huntLog("openPopup", {
      descriptor: String(field.descriptor || "").slice(0, 120),
      uiModel: field.uiModel || "",
      workdayKind: field.workday?.kind || "",
      searchText: String(searchText || "").slice(0, 80),
      elTag: el?.tagName || "none",
      elId: el?.id || el?.getAttribute?.("data-automation-id") || "",
    });
    if (!el) {
      return false;
    }
    var container = root.workdayUi?.nearestWorkdayField(el);
    var siblingInput =
      el.tagName === "BUTTON" && container
        ? container.querySelector(
            'input[type="text"]:not([type="hidden"]), input[role="combobox"], input[data-automation-id]',
          )
        : null;
    if (siblingInput && searchText) {
      try {
        siblingInput.focus({ preventScroll: true });
      } catch (_error) {
        siblingInput.focus?.();
      }
      clickLikeUser(siblingInput);
      await sleep(80);
      if (sourceField) {
        insertTextOrSet(siblingInput, searchText);
      } else {
        setValue(siblingInput, searchText);
      }
      await sleep(260);
      return true;
    }
    try {
      el.focus({ preventScroll: true });
    } catch (_error) {
      el.focus?.();
    }
    clickLikeUser(el.closest?.('[role="combobox"]') || el);
    await sleep(120);
    if (searchText && field.uiModel === "combobox") {
      if (sourceField) {
        insertTextOrSet(el, searchText);
      } else {
        setValue(el, searchText);
      }
      await sleep(220);
    } else {
      keyOn(el, "ArrowDown");
      await sleep(160);
    }
    return true;
  }

  async function closePopup(field) {
    var el = field.element;
    keyOn(el, "Escape");
    keyOn(document.body, "Escape");
    keyOn(document, "Escape");
    if (el?.blur) {
      el.blur();
    }
    await sleep(60);
  }

  async function collectWorkdayOptions(field, context) {
    var answer = context?.answer || {};
    var committedState = workdayCommittedState(field);
    var committedLabel = clean(
      committedState.text || committedState.rawValue || "",
    );
    if (
      committedState.selected &&
      committedLabel &&
      (field.workday?.kind === "phone_country_code" ||
        optionMatches({ label: committedLabel }, answer.value))
    ) {
      root.audit?.pushFieldStep(context?.audit, context?.fieldAudit, {
        action: "workday_preselected_option_detected",
        step: "workday.option.collect",
        status: "ok",
        reason: "committed_workday_selection",
        selectedOption: committedLabel,
        detail: {
          workdayKind: field.workday?.kind || "",
          committedText: committedLabel,
        },
      });
      return [
        {
          label: committedLabel,
          value: committedLabel,
          element: field.element,
          placeholder: false,
          committed: true,
        },
      ];
    }
    // For phone_country_code we need to type to filter the long country-dial list.
    // For all other combobox/button_listbox fields, typing the answer text into
    // Workday's live-search input triggers external API calls (e.g.
    // namedefinition?country=Canada) that can return 500 and crash the page.
    // Open the popup without typing and match against whatever options appear.
    var sourceField = isApplicationSourceField(field.element, field.descriptor);
    var safeOpenOnly =
      field.workday?.kind !== "phone_country_code" && !sourceField;
    var searchText = safeOpenOnly ? "" : answer.value || "Canada (+1)";
    _huntLog("collectWorkdayOptions_start", {
      descriptor: String(field.descriptor || "").slice(0, 120),
      uiModel: field.uiModel || "",
      workdayKind: field.workday?.kind || "",
      searchText: String(searchText || "").slice(0, 80),
    });
    await closePopup(field);
    await sleep(40);
    await openPopup(field, searchText);
    var options = visibleWorkdayOptions();
    _huntLog("collectWorkdayOptions_after_popup", {
      descriptor: String(field.descriptor || "").slice(0, 120),
      optionCount: options.length,
      options: options.slice(0, 8).map(function (o) {
        return o.label;
      }),
      siteError: Boolean(
        document.body?.innerText
          ?.toLowerCase()
          .includes("something went wrong"),
      ),
    });
    root.audit?.pushFieldStep(context?.audit, context?.fieldAudit, {
      action: "workday_options_collected",
      step: "workday.option.collect",
      status: options.length ? "ok" : "warn",
      reason: options.length
        ? "visible_workday_options"
        : "no_visible_workday_options",
      detail: {
        workdayKind: field.workday?.kind || "",
        optionCount: options.length,
        options: options.map(function (option) {
          return option.label;
        }),
      },
    });
    if (!options.length) {
      var postPopupState = workdayCommittedState(field);
      var postPopupLabel = clean(
        postPopupState.text || postPopupState.rawValue || "",
      );
      if (committedStateMatches(postPopupState, answer, null)) {
        return [
          {
            label: postPopupLabel,
            value: postPopupLabel,
            element: field.element,
            placeholder: false,
            committed: true,
            committedReason: "popup_empty_already_committed",
          },
        ];
      }
    }
    return options;
  }

  function preferredWorkdayOption(options, option, answer) {
    if (option) {
      var exact = options.find(function (candidate) {
        return optionMatches(candidate, option.label);
      });
      if (exact) {
        return exact;
      }
    }
    var answerText = answer?.value || "";
    var answerMatch = options.find(function (candidate) {
      return optionMatches(candidate, answerText);
    });
    if (answerMatch) {
      return answerMatch;
    }
    return firstRealOption(options);
  }

  async function clickWorkdayOption(option) {
    var el = option?.element;
    if (!el) {
      return false;
    }
    var nested =
      el.querySelector?.(
        'input:not([type="hidden"]), button, [role="radio"], [role="checkbox"]',
      ) || null;
    clickLikeUser(nested || el);
    if (typeof (nested || el).click === "function") {
      (nested || el).click();
    }
    await sleep(250);
    return true;
  }

  function scorePhoneCountryOption(option, answerText) {
    var label = optionLabel(option);
    var lowered = norm(label);
    var answer = norm(answerText || "Canada (+1)");
    var score = 0;
    if (!label || lowerPressDelete(label)) {
      return { option: option, label: label, score: 0 };
    }
    if (lowered === answer) {
      score += 200;
    }
    if (lowered.includes(answer) || answer.includes(lowered)) {
      score += 120;
    }
    if (lowered.includes("canada")) {
      score += 100;
    }
    if (lowered.includes("+1") && answer.includes("+1")) {
      score += 20;
    }
    return { option: option, label: label, score: score };
  }

  function bestVisiblePhoneCountryOption(answerText) {
    return visibleOptionCandidates()
      .map(function (candidate) {
        return scorePhoneCountryOption(candidate, answerText);
      })
      .filter(function (candidate) {
        return (
          candidate.score >= 100 && norm(candidate.label).includes("canada")
        );
      })
      .sort(function (a, b) {
        return b.score - a.score;
      })[0];
  }

  function workdayCommittedState(field) {
    var state = root.fieldState.readFieldState(field);
    var container = root.workdayUi?.nearestWorkdayField(field.element);
    var selectedText = clean(
      Array.from(
        container?.querySelectorAll?.(
          [
            '[data-automation-id="selectedItem"]',
            '[id^="pill-"]',
            '[aria-label*="press delete to clear value"]',
            '[aria-selected="true"]',
          ].join(", "),
        ) || [],
      )
        .map(function (el) {
          return optionLabel(el);
        })
        .filter(Boolean)
        .join(" "),
    );
    if (selectedText) {
      return {
        rawValue: selectedText,
        text: selectedText,
        selected: true,
      };
    }
    if (field.element?.tagName === "BUTTON" && container) {
      var siblingInput = container.querySelector(
        'input[type="text"]:not([type="hidden"]), input[role="combobox"], input[data-automation-id]',
      );
      if (siblingInput) {
        var inputVal = clean(siblingInput.value);
        if (inputVal) {
          return { rawValue: inputVal, text: inputVal, selected: true };
        }
      }
    }
    return state;
  }

  async function fillWorkdayPopup({
    field,
    answer,
    option,
    audit,
    fieldAudit,
  }) {
    _huntLog("fillWorkdayPopup_entry", {
      descriptor: String(field.descriptor || "").slice(0, 120),
      uiModel: field.uiModel || "",
      workdayKind: field.workday?.kind || "",
      answerValue: String(answer?.value ?? "").slice(0, 80),
      optionLabel: option?.label || null,
    });
    var committedState = workdayCommittedState(field);
    var committedLabel = clean(
      committedState.text || committedState.rawValue || "",
    );
    if (
      committedLabel &&
      committedStateMatches(committedState, answer, option)
    ) {
      return {
        ok: true,
        reason: option?.committedReason || "committed_workday_selection",
        afterState: committedState,
        selectedOption: committedLabel,
        valueSource: fieldAudit?.valueSource || answer?.source || "",
        answerText: committedLabel,
      };
    }
    var options = (field.options || []).filter(function (candidate) {
      return visible(candidate.element);
    });
    var target = preferredWorkdayOption(options, option, answer);
    if (!target) {
      options = await collectWorkdayOptions(field, {
        answer: answer,
        audit: audit,
        fieldAudit: fieldAudit,
      });
      target = preferredWorkdayOption(options, option, answer);
    }
    if (!target) {
      var postPopupState = workdayCommittedState(field);
      var postPopupLabel = clean(
        postPopupState.text || postPopupState.rawValue || "",
      );
      if (committedStateMatches(postPopupState, answer, option)) {
        await closePopup(field);
        return {
          ok: true,
          reason: "popup_empty_already_committed",
          afterState: postPopupState,
          selectedOption: postPopupLabel,
          valueSource: fieldAudit?.valueSource || answer?.source || "",
          answerText: postPopupLabel,
        };
      }
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "workday_popup_options_missing",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.fill",
        reason: "Workday popup opened but no selectable option was visible.",
        options: [],
      });
      await closePopup(field);
      return {
        ok: false,
        reason: "workday_popup_options_missing",
        afterState: workdayCommittedState(field),
      };
    }
    root.audit?.pushFieldStep(audit, fieldAudit, {
      action: "workday_option_click",
      step: "workday.driver.fill",
      status: "info",
      reason: "click_visible_workday_option",
      selectedOption: target.label,
      detail: {
        workdayKind: field.workday?.kind || "",
        optionElement: root.audit?.summarizeElement(target.element) || {},
      },
    });
    await clickWorkdayOption(target);
    var state = workdayCommittedState(field);
    var ok =
      optionMatches({ label: state.text }, target.label) ||
      optionMatches({ label: state.rawValue }, target.label) ||
      Boolean(state.selected && clean(state.text || state.rawValue));
    await closePopup(field);
    if (!ok) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "workday_commit_not_verified",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.verify",
        reason: "Clicked Workday option but committed value did not match.",
        options: options.map(function (candidate) {
          return candidate.label;
        }),
      });
    }
    return {
      ok: ok,
      reason: ok ? "" : "workday_commit_not_verified",
      afterState: state,
      selectedOption: target.label,
      valueSource:
        fieldAudit?.valueSource ||
        (option?.label
          ? "workday:option_match"
          : "fallback:workday_first_option"),
      answerText: target.label,
    };
  }

  async function fillPhoneCountryCode({
    field,
    answer,
    option,
    audit,
    fieldAudit,
  }) {
    var input = field.element;
    var answerText = answer?.value || option?.label || "Canada (+1)";
    var committedState = workdayCommittedState(field);
    var committedLabel = clean(
      committedState.text || committedState.rawValue || "",
    );
    if (
      committedLabel &&
      (optionMatches({ label: committedLabel }, answerText) ||
        (norm(answerText).includes("canada") &&
          norm(committedLabel).includes("canada")))
    ) {
      return {
        ok: true,
        reason: "committed_workday_selection",
        afterState: committedState,
        selectedOption: committedLabel,
        valueSource: fieldAudit?.valueSource || answer?.source || "",
        answerText: committedLabel,
      };
    }
    clearSelectedItems(field, audit, fieldAudit);
    await closePopup(field);
    await openPopup(field, "");
    var listbox = workdayActiveListboxFor(input);
    if (listbox) {
      listbox.scrollTop = 0;
      listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(120);
    }
    var best = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      best = bestVisiblePhoneCountryOption(answerText);
      if (best) {
        break;
      }
      await sleep(60);
    }
    if (!best) {
      var searchText = norm(answerText).includes("canada")
        ? "Canada"
        : answerText;
      setValue(input, searchText);
      await typeaheadOn(input, searchText);
      await sleep(250);
      best = bestVisiblePhoneCountryOption(answerText);
    }
    var scrollResult = { attempts: 0, match: best || null };
    if (!best) {
      scrollResult = await scrollWorkdayListboxUntil(
        input,
        function () {
          return bestVisiblePhoneCountryOption(answerText);
        },
        80,
      );
      best = scrollResult.match;
    }
    if (!best) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "workday_phone_country_code_missing",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.fill",
        reason: "Could not find the requested phone country code option.",
        options: visibleOptionCandidates().map(function (candidate) {
          return optionLabel(candidate);
        }),
      });
      await closePopup(field);
      return {
        ok: false,
        reason: "workday_phone_country_code_missing",
        afterState: workdayCommittedState(field),
      };
    }
    root.audit?.pushFieldStep(audit, fieldAudit, {
      action: "workday_phone_country_code_option",
      step: "workday.driver.fill",
      status: "info",
      reason: "select_virtualized_phone_country_code",
      selectedOption: best.label,
      detail: {
        scrollAttemptCount: scrollResult.attempts || 0,
        listboxScrollTop: Math.round(
          (scrollResult.listbox || workdayActiveListboxFor(input))?.scrollTop ||
            0,
        ),
      },
    });
    workdayClickOptionCommitTarget(best.option);
    await sleep(350);
    input?.blur?.();
    await sleep(250);
    var state = workdayCommittedState(field);
    var ok =
      optionMatches({ label: state.text }, best.label) ||
      optionMatches({ label: state.rawValue }, best.label) ||
      Boolean(state.selected && clean(state.text || state.rawValue));
    await closePopup(field);
    if (!ok) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "workday_phone_country_code_commit_failed",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.verify",
        reason:
          "Clicked phone country code but Workday did not commit the selected pill.",
        options: [best.label],
      });
    }
    return {
      ok: ok,
      reason: ok ? "" : "workday_phone_country_code_commit_failed",
      afterState: state,
      selectedOption: best.label,
      valueSource: fieldAudit?.valueSource || answer?.source || "",
      answerText: best.label,
    };
  }

  function clearSelectedItems(field, audit, fieldAudit) {
    var container = root.workdayUi?.nearestWorkdayField(field.element);
    var selected = Array.from(
      container?.querySelectorAll?.(
        [
          '[data-automation-id="selectedItem"]',
          '[id^="pill-"]',
          '[aria-label*="press delete to clear value"]',
        ].join(", "),
      ) || [],
    ).filter(visible);
    var changed = false;
    selected.forEach(function (item) {
      try {
        item.focus({ preventScroll: true });
      } catch (_error) {
        item.focus?.();
      }
      keyOn(item, "Delete");
      keyOn(item, "Backspace");
      changed = true;
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "workday_selected_item_clear",
        step: "workday.driver.clear",
        status: "info",
        reason: "delete_selected_item",
        element: root.audit?.summarizeElement(item) || {},
      });
    });
    Array.from(
      container?.querySelectorAll?.(
        [
          'button[aria-label*="Remove"]',
          'button[aria-label*="Clear"]',
          '[role="button"][aria-label*="Remove"]',
          '[role="button"][aria-label*="Clear"]',
        ].join(", "),
      ) || [],
    )
      .filter(visible)
      .forEach(function (button) {
        clickLikeUser(button);
        changed = true;
      });
    return changed;
  }

  async function clearWorkdayField(field, audit, fieldAudit) {
    var changed = clearSelectedItems(field, audit, fieldAudit);
    if (field.element && "value" in field.element && field.element.value) {
      setValue(field.element, "");
      changed = true;
    }
    if (field.uiModel === "button_listbox") {
      await openPopup(field, "");
      var placeholder = visibleWorkdayOptions().find(function (candidate) {
        var label = norm(candidate.label);
        return (
          label === "select one" ||
          label === "select" ||
          label === "none" ||
          label === "clear"
        );
      });
      if (placeholder) {
        await clickWorkdayOption(placeholder);
        changed = true;
      }
      await closePopup(field);
    }
    await sleep(120);
    var state = workdayCommittedState(field);
    var ok = root.fieldState.isEmptyState(state) || !clean(state.text);
    if (!ok && !changed) {
      return {
        ok: false,
        reason: "workday_clear_no_clear_control",
        afterState: state,
      };
    }
    return {
      ok: ok || changed,
      reason: ok ? "" : "workday_clear_unverified",
      afterState: state,
    };
  }

  if (!root.optionCollector?.collectOptions || !root.fieldDrivers?.fillField) {
    return;
  }

  if (!root.optionCollector._workdayBaseCollectOptions) {
    root.optionCollector._workdayBaseCollectOptions =
      root.optionCollector.collectOptions;
  }
  root.optionCollector.collectOptions = async function workdayCollectOptions(
    field,
    context,
  ) {
    if (
      field?.workday?.kind &&
      ["combobox", "button_listbox"].includes(field.uiModel)
    ) {
      return collectWorkdayOptions(field, context || {});
    }
    return root.optionCollector._workdayBaseCollectOptions(field, context);
  };

  if (!root.fieldDrivers._workdayBaseFillField) {
    root.fieldDrivers._workdayBaseFillField = root.fieldDrivers.fillField;
  }
  if (!root.fieldDrivers._workdayBaseClearField) {
    root.fieldDrivers._workdayBaseClearField = root.fieldDrivers.clearField;
  }

  root.fieldDrivers.fillField = async function workdayFillField(args) {
    var field = args?.field;
    if (
      field?.workday?.kind &&
      ["combobox", "button_listbox"].includes(field.uiModel)
    ) {
      if (field.workday.kind === "phone_country_code") {
        return fillPhoneCountryCode(args);
      }
      return fillWorkdayPopup(args);
    }
    return root.fieldDrivers._workdayBaseFillField(args);
  };

  root.fieldDrivers.clearField = async function workdayClearField(
    field,
    audit,
    fieldAudit,
  ) {
    if (
      field?.workday?.kind &&
      ["combobox", "button_listbox"].includes(field.uiModel)
    ) {
      return clearWorkdayField(field, audit, fieldAudit);
    }
    return root.fieldDrivers._workdayBaseClearField(field, audit, fieldAudit);
  };

  root.workdayDrivers = {
    collectWorkdayOptions: collectWorkdayOptions,
    fillPhoneCountryCode: fillPhoneCountryCode,
    fillWorkdayPopup: fillWorkdayPopup,
    clearWorkdayField: clearWorkdayField,
    visibleWorkdayOptions: visibleWorkdayOptions,
  };
})();
