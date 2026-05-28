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
      Home: 36,
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

  function workdayFillCancelled() {
    return Boolean(
      window.__huntApplyCancelAllFills ||
      (window.__huntApplyCancelFillRunId &&
        window.__huntApplyCancelFillRunId ===
          window.__huntApplyActiveFillRunId),
    );
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

  function answerTexts(answer, option) {
    var texts = [answer?.value, option?.label, option?.value];
    var aliases = answer?.optionAliases || {};
    Object.keys(aliases).forEach(function (key) {
      if (!answer?.value || optionMatches({ label: key }, answer.value)) {
        texts = texts.concat(aliases[key] || []);
      }
    });
    return Array.from(
      new Set(
        texts
          .map(clean)
          .filter(Boolean)
          .filter(function (text) {
            return text.toLowerCase() !== "select one";
          }),
      ),
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

  function isNoItemsOption(label) {
    return norm(label) === "no items";
  }

  function isTechnicalSkillsField(field, answer) {
    var el = field?.element;
    var key = [
      field?.descriptor,
      field?.questionType,
      field?.fieldId,
      field?.workday?.kind,
      field?.uiModel,
      answer?.source,
      answer?.profilePath,
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("placeholder"),
      el?.getAttribute?.("data-uxi-multiselect-id"),
      el
        ?.closest?.('[data-automation-id="formField-skills"]')
        ?.getAttribute?.("data-automation-id"),
    ]
      .filter(Boolean)
      .join(" ");
    key = norm(key);
    return (
      key.includes("technical skills") ||
      key.includes("type to add skills") ||
      key.includes("profile skills") ||
      key.includes("formfield skills") ||
      key.includes("skills skills")
    );
  }

  function selectedTechnicalSkillLabels(field) {
    var el = field?.element;
    var container =
      el?.closest?.('[data-automation-id="formField-skills"]') ||
      root.workdayUi?.nearestWorkdayField?.(el) ||
      null;
    if (!container) {
      return [];
    }
    return Array.from(
      container.querySelectorAll(
        [
          '[data-automation-id="selectedItem"]',
          '[data-automation-id="selectedItemList"] [role="listitem"]',
          '[data-automation-id="selectedItemList"] button',
        ].join(", "),
      ),
    )
      .filter(visible)
      .map(optionLabel)
      .filter(Boolean);
  }

  function selectedTechnicalSkillMatches(field, target, answer) {
    var texts = answerTexts(answer, target);
    return selectedTechnicalSkillLabels(field).some(function (label) {
      return optionMatchesAny({ label: label }, texts);
    });
  }

  function clearWorkdaySearchText(field) {
    var el = field?.element;
    var container = root.workdayUi?.nearestWorkdayField?.(el);
    var inputs = Array.from(
      new Set(
        [el].concat(
          Array.from(
            container?.querySelectorAll?.(
              'input[type="text"]:not([type="hidden"]), input[role="combobox"], input[data-uxi-widget-type="selectinput"]',
            ) || [],
          ),
        ),
      ),
    ).filter(function (input) {
      return input && "value" in input && clean(input.value);
    });
    inputs.forEach(function (input) {
      setValue(input, "");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function fillTechnicalSkills({
    field,
    answer,
    option,
    audit,
    fieldAudit,
  }) {
    var genericSkillFallbacks = [
      "Customer Service",
      "Communication",
      "Microsoft Office",
      "Leadership",
      "Sales",
      "Analysis",
      "Project Management",
      "Problem Solving",
      "Python",
      "SQL",
    ];
    var skills = Array.isArray(answer?.allValues)
      ? answer.allValues
      : [answer?.value || option?.label || ""];
    skills = skills.map(clean).filter(Boolean);
    if (field.required) {
      var seenSkills = new Set(
        skills.map(function (skill) {
          return norm(skill);
        }),
      );
      genericSkillFallbacks.forEach(function (skill) {
        var key = norm(skill);
        if (key && !seenSkills.has(key)) {
          skills.push(skill);
          seenSkills.add(key);
        }
      });
    }
    if (!skills.length) {
      return {
        ok: false,
        reason: "technical_skills_missing_answer",
        afterState: workdayCommittedState(field),
      };
    }
    var selected = [];
    var missing = [];
    var maxSkillAttempts = field.required ? 10 : 5;
    var attempted = [];
    for (
      var index = 0;
      index < skills.length && attempted.length < maxSkillAttempts;
      index++
    ) {
      var skill = skills[index];
      var skillAnswer = Object.assign({}, answer, { value: skill });
      if (selectedTechnicalSkillMatches(field, null, skillAnswer)) {
        selected.push(skill);
        continue;
      }
      attempted.push(skill);
      var options = await collectWorkdayOptions(field, {
        answer: skillAnswer,
        audit: audit,
        fieldAudit: fieldAudit,
      });
      var flatOptions = options.filter(function (candidate) {
        return !candidate.isCategory;
      });
      var target =
        flatOptions.find(function (candidate) {
          return optionMatchesAny(candidate, answerTexts(skillAnswer, null));
        }) ||
        flatOptions.find(function (candidate) {
          return !candidate.isCategory && !isNoItemsOption(candidate.label);
        }) ||
        null;
      if (!target) {
        missing.push(skill);
        root.audit?.pushFieldStep(audit, fieldAudit, {
          action: "workday_skill_search_no_match",
          step: "workday.driver.fill",
          status: "warn",
          reason: "skill_option_not_loaded_within_2s",
          detail: {
            requestedSkill: skill,
            attempt: attempted.length,
            maxSkillAttempts: maxSkillAttempts,
            options: flatOptions.slice(0, 8).map(function (candidate) {
              return candidate.label;
            }),
          },
        });
        clearWorkdaySearchText(field);
        await closePopup(field);
        continue;
      }
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "workday_skill_checkbox_click",
        step: "workday.driver.fill",
        status: "info",
        reason: "click_matching_skill_checkbox",
        selectedOption: target.label,
        detail: {
          requestedSkill: skill,
          selectedPillsBefore: selectedTechnicalSkillLabels(field),
          optionElement: root.audit?.summarizeElement(target.element) || {},
        },
      });
      await clickWorkdayOption(target);
      var start = Date.now();
      while (
        Date.now() - start < 2600 &&
        !selectedTechnicalSkillMatches(field, target, skillAnswer)
      ) {
        await sleep(120);
      }
      if (selectedTechnicalSkillMatches(field, target, skillAnswer)) {
        selected.push(skill);
      } else {
        missing.push(skill);
      }
      clearWorkdaySearchText(field);
      await closePopup(field);
      await sleep(120);
    }
    if (!selected.length && attempted.length >= maxSkillAttempts) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: field.required
          ? "required_catalog_no_match"
          : "workday_skill_first_five_no_match",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.fill",
        reason: field.required
          ? "Required Workday Skills did not load selectable options for profile or generic fallback terms; C3 cannot commit this required catalog field without a selected pill."
          : "First five profile skills did not load selectable Workday options within 2 seconds each; skipping Skills for max progress.",
        attemptedSkills: attempted,
        missingSkills: missing,
        selectedPills: selectedTechnicalSkillLabels(field),
      });
    }
    var state = workdayCommittedState(field);
    var ok = selected.length > 0;
    if (missing.length) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: ok
          ? "workday_skill_partial_selection"
          : "workday_skill_checkbox_not_verified",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.verify",
        reason: ok
          ? "Some searched skills did not appear as selected pills, but at least one skill was committed so C3 continued for max progress."
          : "No searched skills appeared as selected pills.",
        options: selectedTechnicalSkillLabels(field),
        missingSkills: missing,
      });
    }
    return {
      ok: ok,
      reason: ok
        ? missing.length
          ? "technical_skills_partially_selected"
          : "technical_skills_selected"
        : "workday_skill_checkbox_not_verified",
      afterState: state,
      selectedOption: selectedTechnicalSkillLabels(field).join("; "),
      valueSource: fieldAudit?.valueSource || answer?.source || "",
      answerText: selected.join("; "),
    };
  }

  function optionBelongsToField(target, field) {
    if (!field?.element || !target) {
      return true;
    }
    var input = field.element;
    var multiSelectId = input?.getAttribute?.("data-uxi-multiselect-id") || "";
    var targetText = [
      target.getAttribute?.("data-uxi-multiselect-id"),
      target
        .querySelector?.("[data-uxi-multiselect-id]")
        ?.getAttribute?.("data-uxi-multiselect-id"),
      target
        .closest?.("[data-uxi-multiselect-id]")
        ?.getAttribute?.("data-uxi-multiselect-id"),
    ]
      .filter(Boolean)
      .join(" ");
    if (multiSelectId && targetText && targetText.includes(multiSelectId)) {
      return true;
    }
    var activeListbox = workdayActiveListboxFor(input);
    if (activeListbox && activeListbox.contains(target)) {
      return true;
    }
    var container = root.workdayUi?.nearestWorkdayField(input);
    return Boolean(container && container.contains(target));
  }

  function optionIntersectsVisibleArea(option, listbox) {
    if (!option?.getBoundingClientRect) {
      return false;
    }
    var rect = option.getBoundingClientRect();
    if (
      !rect ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= window.innerHeight ||
      rect.left >= window.innerWidth
    ) {
      return false;
    }
    if (!listbox?.getBoundingClientRect) {
      return true;
    }
    var listRect = listbox.getBoundingClientRect();
    if (!listRect || listRect.width <= 0 || listRect.height <= 0) {
      return true;
    }
    return (
      rect.bottom > listRect.top &&
      rect.top < listRect.bottom &&
      rect.right > listRect.left &&
      rect.left < listRect.right
    );
  }

  function visibleWorkdayOptions(field) {
    var options = [];
    var seen = new Set();
    var activeListbox = field?.element
      ? workdayActiveListboxFor(field.element)
      : null;
    var rootNode = activeListbox || document;
    Array.from(
      rootNode.querySelectorAll(
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
        if (!optionBelongsToField(target, field)) {
          return;
        }
        if (!optionIntersectsVisibleArea(target, activeListbox)) {
          return;
        }
        if (
          target.closest?.('[data-automation-id="selectedItemList"]') ||
          target.matches?.('[data-automation-id="selectedItem"]') ||
          target.querySelector?.('[data-automation-id="selectedItem"]')
        ) {
          return;
        }
        var label = optionLabel(target);
        if (lowerPressDelete(label) || isNoItemsOption(label)) {
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
          isCategory: isPromptCategoryOption(target, field),
        });
      });
    return options;
  }

  function isSourcePromptCategoryOption(option, field) {
    if (!isApplicationSourceField(field?.element, field?.descriptor)) {
      return false;
    }
    var label = norm(optionLabel(option));
    if (!label || lowerPressDelete(label) || isNoItemsOption(label)) {
      return false;
    }
    var automationId = norm(option.getAttribute?.("data-automation-id"));
    var uxiWidget = norm(option.getAttribute?.("data-uxi-widget-type"));
    var sourceLikeRow =
      automationId.includes("menuitem") ||
      automationId.includes("promptoption") ||
      automationId.includes("promptleafnode") ||
      uxiWidget.includes("multiselectlistitem");
    if (!sourceLikeRow) {
      return false;
    }
    var promptLeaf = option.matches?.('[data-automation-id="promptLeafNode"]')
      ? option
      : option.querySelector?.('[data-automation-id="promptLeafNode"]');
    var hasCategoryCue = Boolean(
      option.getAttribute?.("data-hunt-prompt-category") === "true" ||
      option.getAttribute?.("aria-haspopup") ||
      option.getAttribute?.("aria-expanded") ||
      promptLeaf?.getAttribute?.(
        "data-uxi-multiselectlistitem-hassidecharm",
      ) === "true" ||
      promptLeaf?.getAttribute?.("data-uxi-multiselectlistitem-type") === "2" ||
      option.querySelector?.("svg") ||
      option.querySelector?.('[data-automation-id*="chevron"]') ||
      option.querySelector?.('[data-automation-id*="drill"]'),
    );
    var sourceCategoryPattern =
      /\b(campus campaign|career websites?|career sites?|employee referral|event|job alert|job boards?|job sites?|social media|social referral|alumni)\b/;
    var sourceCategoryLabel = sourceCategoryPattern.test(label);
    if (hasCategoryCue) {
      return sourceCategoryLabel;
    }
    var listbox = option.closest?.(
      '[role="listbox"], [data-automation-id="activeListContainer"], [data-automation-id="promptSearchResultList"]',
    );
    var siblingCategoryCount = Array.from(
      listbox?.querySelectorAll?.(
        [
          '[role="option"]',
          '[data-automation-id="menuItem"]',
          '[data-automation-id="promptOption"]',
        ].join(", "),
      ) || [],
    )
      .filter(visible)
      .map(function (candidate) {
        return norm(optionLabel(candidate));
      })
      .filter(function (candidateLabel) {
        return sourceCategoryPattern.test(candidateLabel);
      }).length;
    return Boolean(sourceCategoryLabel && siblingCategoryCount >= 2);
  }

  function isPromptCategoryOption(option, field) {
    if (!option) {
      return false;
    }
    if (
      option.querySelector?.(
        [
          'input[type="radio"]',
          'input[type="checkbox"]',
          '[role="radio"]',
          '[role="checkbox"]',
          '[data-automation-id="radioBtn"]',
          '[data-automation-id="checkboxPanel"]',
        ].join(", "),
      )
    ) {
      return false;
    }
    var label = norm(optionLabel(option));
    if (!label || lowerPressDelete(label) || isNoItemsOption(label)) {
      return false;
    }
    if (isSourcePromptCategoryOption(option, field)) {
      return true;
    }
    var promptLeaf = option.matches?.('[data-automation-id="promptLeafNode"]')
      ? option
      : option.querySelector?.('[data-automation-id="promptLeafNode"]');
    return Boolean(
      option.getAttribute?.("aria-haspopup") ||
      option.getAttribute?.("aria-expanded") ||
      promptLeaf?.getAttribute?.(
        "data-uxi-multiselectlistitem-hassidecharm",
      ) === "true" ||
      promptLeaf?.getAttribute?.("data-uxi-multiselectlistitem-type") === "2" ||
      option.querySelector?.("svg") ||
      option.querySelector?.('[data-automation-id*="chevron"]') ||
      option.querySelector?.('[data-automation-id*="drill"]') ||
      option.getAttribute?.("data-hunt-prompt-category") === "true",
    );
  }

  function sourceOptionFailureKind(field) {
    if (isApplicationSourceField(field?.element, field?.descriptor)) {
      return "workday_source_options_unavailable";
    }
    return "workday_popup_options_missing";
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
    var controlledIds = [
      input?.getAttribute?.("aria-controls"),
      input?.getAttribute?.("aria-owns"),
    ]
      .join(" ")
      .split(/\s+/)
      .map(clean)
      .filter(Boolean);
    for (
      var controlledIndex = 0;
      controlledIndex < controlledIds.length;
      controlledIndex += 1
    ) {
      var controlled = document.getElementById(controlledIds[controlledIndex]);
      if (
        controlled &&
        controlled.matches?.(
          [
            '[data-automation-id="activeListContainer"]',
            '[data-automation-id="promptSearchResultList"]',
            '[data-uxi-widget-type="multiselectlist"]',
            '[role="listbox"]',
          ].join(", "),
        )
      ) {
        var controlledStyle = window.getComputedStyle(controlled);
        var controlledRect = controlled.getBoundingClientRect();
        if (
          controlledStyle.display !== "none" &&
          controlledStyle.visibility !== "hidden" &&
          controlledRect.width > 0 &&
          controlledRect.height > 0
        ) {
          return controlled;
        }
      }
    }
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
        if (
          listbox.matches?.('[data-automation-id="selectedItemList"]') ||
          listbox.closest?.('[data-automation-id="selectedItemList"]')
        ) {
          return false;
        }
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

  function workdayPromptLeafTarget(option) {
    return (
      option?.querySelector?.('[data-automation-id="promptLeafNode"]') || option
    );
  }

  function workdayOptionClickPoint(option, purpose) {
    if (option?._trustedClickPoint) {
      return option._trustedClickPoint;
    }
    var el = option?.element || option;
    if (!el?.getBoundingClientRect) {
      return null;
    }
    var rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    var x =
      purpose === "category"
        ? Math.max(rect.left + 1, rect.right - 24)
        : rect.left + rect.width / 2;
    return {
      x: Math.round(x),
      y: Math.round(rect.top + rect.height / 2),
      label: optionLabel(el),
    };
  }

  function requestTrustedWorkdayClick(option, purpose) {
    var point = workdayOptionClickPoint(option, purpose);
    if (
      !point ||
      typeof chrome === "undefined" ||
      !chrome.runtime?.sendMessage
    ) {
      return Promise.resolve({
        ok: false,
        reason: "trusted_input_unavailable",
      });
    }
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        finish({ ok: false, reason: "trusted_input_timeout" });
      }, 1500);
      function finish(result) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
      try {
        chrome.runtime.sendMessage(
          {
            type: "hunt.apply.trusted_input",
            payload: {
              action: "mouse_click",
              x: point.x,
              y: point.y,
              label: point.label,
              purpose: purpose || "option",
            },
          },
          function (response) {
            var error = chrome.runtime.lastError;
            if (error) {
              finish({
                ok: false,
                reason: "trusted_input_message_failed",
                message: error.message,
              });
              return;
            }
            finish(response || { ok: false, reason: "trusted_input_empty" });
          },
        );
      } catch (error) {
        finish({
          ok: false,
          reason: "trusted_input_exception",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function requestTrustedWorkdayKeys(keys, purpose) {
    if (
      !keys?.length ||
      typeof chrome === "undefined" ||
      !chrome.runtime?.sendMessage
    ) {
      return Promise.resolve({
        ok: false,
        reason: "trusted_input_unavailable",
      });
    }
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        finish({ ok: false, reason: "trusted_input_timeout" });
      }, 1500);
      function finish(result) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
      try {
        chrome.runtime.sendMessage(
          {
            type: "hunt.apply.trusted_input",
            payload: {
              action: "key_sequence",
              keys: keys,
              purpose: purpose || "option_keyboard",
            },
          },
          function (response) {
            var error = chrome.runtime.lastError;
            if (error) {
              finish({
                ok: false,
                reason: "trusted_input_message_failed",
                message: error.message,
              });
              return;
            }
            finish(response || { ok: false, reason: "trusted_input_empty" });
          },
        );
      } catch (error) {
        finish({
          ok: false,
          reason: "trusted_input_exception",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function trustedKeyboardSequenceForOption(option, field) {
    var el = option?.element;
    var pos = Number(el?.getAttribute?.("aria-posinset") || 0);
    if ((!Number.isFinite(pos) || pos < 1) && field) {
      var visibleOptions = visibleWorkdayOptions(field).filter(
        function (candidate) {
          return !candidate.isCategory;
        },
      );
      var index = visibleOptions.findIndex(function (candidate) {
        return (
          candidate.element === el ||
          optionMatches(candidate, option?.label) ||
          optionMatches(option, candidate?.label)
        );
      });
      if (index >= 0) {
        pos = index + 1;
      }
    }
    if (!Number.isFinite(pos) || pos < 1 || pos > 80) {
      return [];
    }
    var keys = [{ key: "Home", code: "Home", windowsVirtualKeyCode: 36 }];
    for (var idx = 1; idx < pos; idx++) {
      keys.push({
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
      });
    }
    keys.push({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    return keys;
  }

  async function dispatchWorkdayKeySequence(field, keys) {
    if (!keys?.length) {
      return { ok: false, reason: "empty_key_sequence" };
    }
    var target = workdayActiveListboxFor(field.element) || field.element;
    try {
      target?.focus?.({ preventScroll: true });
    } catch (_error) {
      target?.focus?.();
    }
    for (var idx = 0; idx < keys.length; idx += 1) {
      keyOn(target, keys[idx].key);
      await sleep(80);
    }
    return { ok: true, reason: "synthetic_key_sequence_dispatched" };
  }

  async function requestOrDispatchWorkdayKeys(field, keys, purpose) {
    if (!keys?.length) {
      return { ok: false, reason: "empty_key_sequence" };
    }
    var trusted = await requestTrustedWorkdayKeys(keys, purpose);
    if (trusted?.ok) {
      return trusted;
    }
    var synthetic = await dispatchWorkdayKeySequence(field, keys);
    return Object.assign({}, synthetic, { trustedInput: trusted || null });
  }

  function shouldTryTrustedKeyboardFirst(option, field) {
    var descriptor = norm(
      [
        field?.uiModel,
        field?.descriptor,
        field?.fieldId,
        field?.workday?.fieldLabel,
        field?.element?.id,
        field?.element?.name,
        field?.element?.getAttribute?.("aria-label"),
      ].join(" "),
    );
    if (
      isApplicationSourceField(field?.element, field?.descriptor) &&
      option?.element?.getAttribute?.("aria-posinset")
    ) {
      return true;
    }
    if (
      field?.uiModel === "button_listbox" &&
      option?.element?.getAttribute?.("aria-posinset") &&
      /\b(phone|device|degree|education level|citizenship|veteran|gender|sex|race|ethnic|disability|source)\b/.test(
        descriptor,
      )
    ) {
      return true;
    }
    return Boolean(
      option?.element?.getAttribute?.("aria-posinset") &&
      option.element.querySelector?.(
        '[data-automation-id="checkboxPanel"], input[type="checkbox"]',
      ),
    );
  }

  function workdayClickOptionCommitTarget(option) {
    var target = workdayOptionRadioTarget(option);
    clickLikeUser(target || option);
    if (target && typeof target.click === "function") {
      target.click();
    }
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
      !workdayFillCancelled()
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

  function optionMatchesAny(option, texts) {
    return (texts || []).some(function (text) {
      return optionMatches(option, text);
    });
  }

  function isSalaryField(field, answer) {
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        field?.workday?.fieldLabel,
        field?.element?.id,
        field?.element?.name,
        field?.element?.getAttribute?.("aria-label"),
        answer?.source,
      ].join(" "),
    );
    if (
      text.includes("compensation history") ||
      text.includes("compensation offer") ||
      text.includes("creating a compensation offer") ||
      text.includes("factors bms should consider")
    ) {
      return false;
    }
    return (
      text.includes("salary") ||
      text.includes("compensation") ||
      text.includes("pay expectation") ||
      text.includes("salaryexpectation")
    );
  }

  function isCanadianCitizenshipStatusField(field, answer) {
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        field?.workday?.fieldLabel,
        field?.workday?.contextText,
        answer?.source,
        answer?.value,
      ].join(" "),
    );
    return (
      text.includes("canadian citizenship status") ||
      text.includes("provide your canadian citizenship status") ||
      text.includes("citizenship status to assist")
    );
  }

  function citizenshipCountryFromAnswer(answer) {
    var match = String(answer?.value || "").match(/\(([^)]+)\)/);
    return clean(match?.[1] || "Canada");
  }

  function activeWorkdayOptionLabel(listbox) {
    var activeId = listbox?.getAttribute?.("aria-activedescendant") || "";
    var active = activeId ? document.getElementById(activeId) : null;
    return clean(
      active?.innerText ||
        active?.textContent ||
        active?.getAttribute?.("aria-label") ||
        "",
    );
  }

  async function keyboardOpenCitizenshipCountry(input, country) {
    var listbox = workdayActiveListboxFor(input);
    if (!listbox) {
      return { ok: false, reason: "missing_listbox", attempts: 0 };
    }
    listbox.focus?.();
    keyOn(listbox, "Home");
    await sleep(120);
    for (var attempt = 0; attempt < 90 && !workdayFillCancelled(); attempt++) {
      var activeLabel = activeWorkdayOptionLabel(listbox);
      if (optionMatches({ label: activeLabel }, country)) {
        keyOn(listbox, "Enter");
        await sleep(650);
        return {
          ok: true,
          reason: "keyboard_country_opened",
          attempts: attempt + 1,
          selectedOption: activeLabel,
        };
      }
      keyOn(listbox, "ArrowDown");
      await sleep(45);
    }
    return {
      ok: false,
      reason: "keyboard_country_missing",
      attempts: 90,
      selectedOption: activeWorkdayOptionLabel(listbox),
    };
  }

  async function openWorkdayPopupUntilOptions(field, searchText, maxAttempts) {
    var el = field.element;
    var container = root.workdayUi?.nearestWorkdayField(el);
    var targets = [
      el,
      el?.closest?.('[data-automation-id="monikerSearchBox"]'),
      el?.closest?.('[data-automation-id="multiSelectContainer"]'),
      container,
    ].filter(Boolean);
    for (var attempt = 0; attempt < (maxAttempts || 3); attempt++) {
      await openPopup(field, searchText || "");
      await sleep(180);
      var options = visibleWorkdayOptions(field);
      if (options.length) {
        return {
          ok: true,
          attempts: attempt + 1,
          options: options,
        };
      }
      var target = targets[attempt % targets.length];
      if (target) {
        clickLikeUser(target);
        keyOn(el, "ArrowDown");
      }
      await sleep(260);
      options = visibleWorkdayOptions(field);
      if (options.length) {
        return {
          ok: true,
          attempts: attempt + 1,
          options: options,
        };
      }
    }
    return {
      ok: false,
      attempts: maxAttempts || 3,
      options: visibleWorkdayOptions(field),
    };
  }

  async function waitForWorkdayOptions(previousLabels, timeoutMs, field) {
    var start = Date.now();
    var attempts = 0;
    var previousKey = (previousLabels || []).map(norm).join("|");
    var options = visibleWorkdayOptions(field);
    while (
      Date.now() - start < (timeoutMs || 2200) &&
      !workdayFillCancelled()
    ) {
      attempts += 1;
      options = visibleWorkdayOptions(field);
      var key = options
        .map(function (option) {
          return norm(option.label);
        })
        .join("|");
      if (options.length && key !== previousKey) {
        return {
          options: options,
          attempts: attempts,
          waitedMs: Date.now() - start,
        };
      }
      await sleep(120);
    }
    return {
      options: options,
      attempts: attempts,
      waitedMs: Date.now() - start,
    };
  }

  function sourceCategoryScore(option, texts) {
    var label = norm(option?.label);
    var combined = norm((texts || []).join(" "));
    if (!label) {
      return 0;
    }
    var score = 1;
    if (optionMatchesAny(option, texts)) {
      score += 100;
    }
    if (/linkedin|social/.test(combined) && label.includes("social media")) {
      score += 80;
    }
    if (
      /linkedin|job board|job site|job/.test(combined) &&
      (label.includes("job sites") || label.includes("career websites"))
    ) {
      score += 60;
    }
    if (label.includes("other")) {
      score += 5;
    }
    return score;
  }

  function isReferralSourceOption(option) {
    var label = norm(option?.label);
    return (
      !label ||
      label.includes("select") ||
      label.includes("employee") ||
      label.includes("employ") ||
      label.includes("recruiter") ||
      label.includes("agency") ||
      label.includes("employee referral") ||
      label.includes("social referral") ||
      label.includes("connection") ||
      label.includes("referred") ||
      label.includes("refer") ||
      label.includes("referral")
    );
  }

  function sourceFallbackScore(option, texts) {
    var label = norm(option?.label);
    if (!label || isReferralSourceOption(option)) {
      return -1000;
    }
    var combined = norm((texts || []).join(" "));
    var score = 1;
    if (optionMatchesAny(option, texts)) {
      score += 100;
    }
    if (label.includes("linkedin")) {
      score += 95;
    }
    if (label.includes("indeed")) {
      score += 92;
    }
    if (label.includes("naukri")) {
      score += 90;
    }
    if (label.includes("google")) {
      score += 88;
    }
    if (label.includes("zip recruiter") || label.includes("ziprecruiter")) {
      score += 82;
    }
    if (label.includes("glassdoor")) {
      score += 78;
    }
    if (label.includes("social media")) {
      score += 85;
    }
    if (label.includes("job sites") || label.includes("job board")) {
      score += 70;
    }
    if (label.includes("career websites") || label.includes("career site")) {
      score += 65;
    }
    if (label.includes("careers") || label.includes("company website")) {
      score += 60;
    }
    if (/linkedin|social/.test(combined) && label.includes("facebook")) {
      score += 40;
    }
    if (/linkedin|social/.test(combined) && label.includes("instagram")) {
      score += 35;
    }
    if (/linkedin|social/.test(combined) && label.includes("twitter")) {
      score += 30;
    }
    if (label.includes("other")) {
      score += label.includes("job") || label.includes("site") ? 70 : 5;
    }
    return score;
  }

  function preferredSourceFallbackOption(options, texts) {
    return (
      (options || [])
        .filter(function (candidate) {
          return (
            candidate?.label && sourceFallbackScore(candidate, texts) > -1000
          );
        })
        .sort(function (a, b) {
          return sourceFallbackScore(b, texts) - sourceFallbackScore(a, texts);
        })[0] || null
    );
  }

  function betterSourceFallbackOption(current, candidate, texts) {
    if (!candidate) {
      return current || null;
    }
    if (!current) {
      return candidate;
    }
    return sourceFallbackScore(candidate, texts) >
      sourceFallbackScore(current, texts)
      ? candidate
      : current;
  }

  function shouldScanForBetterSourceOption(field, answer, target, listbox) {
    if (
      !isApplicationSourceField(field?.element, field?.descriptor) ||
      !listbox ||
      listbox.scrollHeight <= listbox.clientHeight + 2
    ) {
      return false;
    }
    if (!target) {
      return true;
    }
    return sourceFallbackScore(target, answerTexts(answer, null)) < 80;
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

  function committedApplicationSourceMatches(state, answer, option) {
    var label = clean(state?.text || state?.rawValue || "");
    if (!state?.selected || !label) {
      return false;
    }
    if (committedStateMatches(state, answer, option)) {
      return true;
    }
    return (
      sourceFallbackScore({ label: label }, answerTexts(answer, option)) > -1000
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

  function markWorkdayProgressFallback(option, reason) {
    if (option && reason) {
      option.progressFallbackReason = reason;
    }
    return option || null;
  }

  function workdayFallbackValueSource(option) {
    return option?.progressFallbackReason
      ? "fallback:" + option.progressFallbackReason
      : "";
  }

  function canUseWorkdayProgressFallback(field, answer) {
    return Boolean(field?.required && !isSalaryField(field, answer));
  }

  function firstWorkdayProgressFallback(options, field, answer, reason) {
    if (!canUseWorkdayProgressFallback(field, answer)) {
      return null;
    }
    return markWorkdayProgressFallback(firstRealOption(options), reason);
  }

  function insertTextOrSet(input, text) {
    if (!input) {
      return false;
    }
    try {
      input.focus?.({ preventScroll: true });
    } catch (_error) {
      input.focus?.();
    }
    if (document.activeElement !== input) {
      clickLikeUser(input);
      try {
        input.focus?.({ preventScroll: true });
      } catch (_error) {
        input.focus?.();
      }
    }
    if (document.activeElement !== input) {
      return false;
    }
    setValue(input, "");
    input.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      }),
    );
    setValue(input, text);
    return clean(input.value) === clean(text);
  }

  async function typeSearchTextLikeUser(input, text) {
    if (!input) {
      return false;
    }
    try {
      input.focus?.({ preventScroll: true });
    } catch (_error) {
      input.focus?.();
    }
    if (document.activeElement !== input) {
      clickLikeUser(input);
      try {
        input.focus?.({ preventScroll: true });
      } catch (_error) {
        input.focus?.();
      }
    }
    if (document.activeElement !== input) {
      return false;
    }
    setValue(input, "");
    await sleep(40);
    var value = "";
    for (var index = 0; index < String(text || "").length; index++) {
      var char = String(text)[index];
      if (document.activeElement !== input) {
        return false;
      }
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: char,
          code: "Key" + char.toUpperCase(),
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: char,
        }),
      );
      value += char;
      setValue(input, value);
      input.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: char,
          code: "Key" + char.toUpperCase(),
          bubbles: true,
          cancelable: true,
        }),
      );
      await sleep(25);
    }
    return true;
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
    var skillSearch = isTechnicalSkillsField(field, { value: searchText });
    if (siblingInput && searchText) {
      try {
        siblingInput.focus({ preventScroll: true });
      } catch (_error) {
        siblingInput.focus?.();
      }
      clickLikeUser(siblingInput);
      await sleep(80);
      if (skillSearch) {
        await typeSearchTextLikeUser(siblingInput, searchText);
        keyOn(siblingInput, "Enter");
        await sleep(380);
      } else if (sourceField) {
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
      if (skillSearch) {
        await typeSearchTextLikeUser(el, searchText);
        keyOn(el, "Enter");
        await sleep(380);
      } else if (sourceField) {
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
    var isSkillsSearch = isTechnicalSkillsField(field, answer);
    var committedState = workdayCommittedState(field);
    var committedLabel = clean(
      committedState.text || committedState.rawValue || "",
    );
    var committedSelectionText = selectedWorkdayItemText(field);
    if (
      committedState.selected &&
      committedLabel &&
      (field.workday?.kind === "phone_country_code"
        ? committedSelectionText &&
          optionMatches({ label: committedSelectionText }, answer.value)
        : optionMatches({ label: committedLabel }, answer.value))
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
    // Most Workday combobox/listbox fields should be opened without typing because
    // source-style live search can crash Workday before its internal store is ready.
    // Skills multiselects are search-backed: opening them empty only yields "No Items."
    var shouldTypeSearch =
      field.workday?.kind === "phone_country_code" || isSkillsSearch;
    var searchText = shouldTypeSearch
      ? answer.value ||
        (field.workday?.kind === "phone_country_code" ? "Canada (+1)" : "")
      : "";
    _huntLog("collectWorkdayOptions_start", {
      descriptor: String(field.descriptor || "").slice(0, 120),
      uiModel: field.uiModel || "",
      workdayKind: field.workday?.kind || "",
      searchText: String(searchText || "").slice(0, 80),
    });
    await closePopup(field);
    await sleep(40);
    var previousLabels = searchText
      ? visibleWorkdayOptions(field).map(function (option) {
          return option.label;
        })
      : [];
    await openPopup(field, searchText);
    var waitResult = await waitForWorkdayOptions(
      previousLabels,
      isSkillsSearch ? 2000 : searchText ? 3400 : 2200,
      field,
    );
    var options = waitResult.options;
    if (!options.length && searchText && !isSkillsSearch) {
      keyOn(field.element, "Enter");
      await sleep(180);
      waitResult = await waitForWorkdayOptions([], 2600, field);
      options = waitResult.options;
    }
    if (options.length) {
      var scrollResult = await collectPreferredWorkdayOptionsWithScroll(
        field,
        answer,
        options,
      );
      if (scrollResult.options.length > options.length) {
        options = scrollResult.options;
      }
      waitResult.scrollAttempts = scrollResult.attempts || 0;
      waitResult.scrolledToPreferred = Boolean(scrollResult.target);
    }
    _huntLog("collectWorkdayOptions_after_popup", {
      descriptor: String(field.descriptor || "").slice(0, 120),
      optionCount: options.length,
      waitAttempts: waitResult.attempts,
      waitedMs: waitResult.waitedMs,
      scrollAttempts: waitResult.scrollAttempts || 0,
      scrolledToPreferred: Boolean(waitResult.scrolledToPreferred),
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
        waitAttempts: waitResult.attempts,
        waitedMs: waitResult.waitedMs,
        scrollAttempts: waitResult.scrollAttempts || 0,
        scrolledToPreferred: Boolean(waitResult.scrolledToPreferred),
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

  async function findHierarchicalWorkdayOption(
    field,
    answer,
    option,
    options,
    audit,
    fieldAudit,
  ) {
    var sourceField = isApplicationSourceField(
      field?.element,
      field?.descriptor,
    );
    var texts = answerTexts(answer, sourceField ? null : option);
    var categories = (options || [])
      .filter(function (candidate) {
        return candidate.isCategory;
      })
      .sort(function (a, b) {
        return sourceCategoryScore(b, texts) - sourceCategoryScore(a, texts);
      });
    if (!categories.length) {
      return null;
    }
    for (var idx = 0; idx < categories.length; idx++) {
      var category = categories[idx];
      var beforeLabels = visibleWorkdayOptions(field).map(function (candidate) {
        return candidate.label;
      });
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "workday_prompt_category_open",
        step: "workday.driver.fill",
        status: "info",
        reason: "open_prompt_category",
        selectedOption: category.label,
        detail: {
          categoryIndex: idx,
          categoryScore: sourceCategoryScore(category, texts),
        },
      });
      await clickWorkdayOption(category);
      var waitResult = await waitForWorkdayOptions(beforeLabels, 2600, field);
      var childOptions = waitResult.options.filter(function (candidate) {
        return !candidate.isCategory;
      });
      var trustedCategory = null;
      if (!childOptions.length) {
        trustedCategory = await requestTrustedWorkdayClick(
          category,
          "category",
        );
        if (trustedCategory?.ok) {
          waitResult = await waitForWorkdayOptions(beforeLabels, 2600, field);
          childOptions = waitResult.options.filter(function (candidate) {
            return !candidate.isCategory;
          });
        }
      }
      if (!childOptions.length) {
        trustedCategory = await requestOrDispatchWorkdayKeys(
          field,
          trustedKeyboardSequenceForOption(category, field),
          "source_category_keyboard",
        );
        if (trustedCategory?.ok) {
          waitResult = await waitForWorkdayOptions(beforeLabels, 2600, field);
          childOptions = waitResult.options.filter(function (candidate) {
            return !candidate.isCategory;
          });
        }
      }
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "workday_prompt_category_options",
        step: "workday.driver.fill",
        status: childOptions.length ? "ok" : "warn",
        reason: childOptions.length
          ? "prompt_category_children_visible"
          : "prompt_category_children_missing",
        selectedOption: category.label,
        detail: {
          waitAttempts: waitResult.attempts,
          waitedMs: waitResult.waitedMs,
          trustedInput: trustedCategory || null,
          options: childOptions.map(function (candidate) {
            return candidate.label;
          }),
        },
      });
      var childScrollResult = childOptions.length
        ? await collectPreferredWorkdayOptionsWithScroll(
            field,
            answer,
            childOptions,
          )
        : { options: childOptions, target: null, attempts: 0 };
      if (childScrollResult.options.length > childOptions.length) {
        childOptions = childScrollResult.options.filter(function (candidate) {
          return !candidate.isCategory;
        });
      }
      var target =
        childScrollResult.target ||
        preferredWorkdayOption(
          childOptions,
          sourceField ? null : option,
          answer,
          field,
        );
      if (target) {
        return target;
      }
      await closePopup(field);
      await sleep(80);
      await openPopup(field, "");
      await waitForWorkdayOptions([], 1600, field);
    }
    return null;
  }

  function preferredWorkdayOption(options, option, answer, field) {
    if (option) {
      var exact = options.find(function (candidate) {
        return optionMatches(candidate, option.label);
      });
      if (exact) {
        return exact;
      }
    }
    var aliasTexts = answerTexts(answer, option);
    var aliasMatch = options.find(function (candidate) {
      return optionMatchesAny(candidate, aliasTexts);
    });
    if (aliasMatch) {
      return aliasMatch;
    }
    var answerText = answer?.value || "";
    var answerMatch = options.find(function (candidate) {
      return optionMatches(candidate, answerText);
    });
    if (answerMatch) {
      return answerMatch;
    }
    if (isSalaryField(field, answer)) {
      return null;
    }
    if (isApplicationSourceField(field?.element, field?.descriptor)) {
      var sourceFallback = preferredSourceFallbackOption(options, aliasTexts);
      if (sourceFallback) {
        return markWorkdayProgressFallback(
          sourceFallback,
          "workday_source_safe_option",
        );
      }
    }
    if (
      !option &&
      answer?.answerType &&
      !["unknown", "non_disclosure"].includes(answer.answerType)
    ) {
      return firstWorkdayProgressFallback(
        options,
        field,
        answer,
        "workday_progress_required_first_option",
      );
    }
    if (
      !option &&
      ["unknown", "non_disclosure"].includes(answer?.answerType || "")
    ) {
      return firstWorkdayProgressFallback(
        options,
        field,
        answer,
        "workday_progress_required_first_option",
      );
    }
    var fallback = preferredSourceFallbackOption(options, aliasTexts);
    if (fallback) {
      return markWorkdayProgressFallback(fallback, "workday_safe_option");
    }
    return markWorkdayProgressFallback(
      firstRealOption(options),
      "workday_progress_first_option",
    );
  }

  function workdayOptionKey(option) {
    return [
      norm(option?.label),
      option?.element?.id || "",
      option?.element?.getAttribute?.("data-automation-id") || "",
    ].join("::");
  }

  function mergeWorkdayOptions(current, additions) {
    var seen = new Set((current || []).map(workdayOptionKey));
    var merged = (current || []).slice();
    (additions || []).forEach(function (option) {
      var key = workdayOptionKey(option);
      if (!norm(option?.label) || seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push(option);
    });
    return merged;
  }

  async function collectPreferredWorkdayOptionsWithScroll(
    field,
    answer,
    options,
  ) {
    var listbox = workdayActiveListboxFor(field.element);
    var sourceField = isApplicationSourceField(
      field?.element,
      field?.descriptor,
    );
    var sourceTexts = sourceField ? answerTexts(answer, null) : [];
    var allOptions = mergeWorkdayOptions([], options || []);
    var visibleTarget = preferredWorkdayOption(
      (options || []).filter(function (candidate) {
        return !candidate.isCategory;
      }),
      null,
      answer,
      field,
    );
    var bestTarget = visibleTarget;
    if (
      (visibleTarget &&
        !shouldScanForBetterSourceOption(
          field,
          answer,
          visibleTarget,
          listbox,
        )) ||
      !listbox ||
      listbox.scrollHeight <= listbox.clientHeight + 2
    ) {
      return {
        options: allOptions,
        target: visibleTarget || null,
        attempts: 0,
      };
    }
    listbox.scrollTop = 0;
    listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(80);
    for (var attempt = 0; attempt < 80 && !workdayFillCancelled(); attempt++) {
      var visibleOptions = visibleWorkdayOptions(field);
      allOptions = mergeWorkdayOptions(allOptions, visibleOptions);
      visibleTarget = preferredWorkdayOption(
        visibleOptions.filter(function (candidate) {
          return !candidate.isCategory;
        }),
        null,
        answer,
        field,
      );
      if (sourceField) {
        bestTarget = betterSourceFallbackOption(
          bestTarget,
          visibleTarget,
          sourceTexts,
        );
      } else if (visibleTarget) {
        bestTarget = visibleTarget;
      }
      if (visibleTarget) {
        if (
          shouldScanForBetterSourceOption(field, answer, visibleTarget, listbox)
        ) {
          await sleep(30);
        } else {
          return {
            options: mergeWorkdayOptions(allOptions, [visibleTarget]),
            target: visibleTarget,
            attempts: attempt + 1,
          };
        }
      }
      var before = listbox.scrollTop;
      listbox.scrollTop += 260;
      listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(90);
      if (Math.abs(listbox.scrollTop - before) < 1) {
        break;
      }
    }
    return {
      options: bestTarget
        ? mergeWorkdayOptions(allOptions, [bestTarget])
        : allOptions,
      target: bestTarget || null,
      attempts: 80,
    };
  }

  async function clickWorkdayOption(option) {
    var el = option?.element;
    if (!el) {
      return false;
    }
    option._trustedClickPoint = workdayOptionClickPoint(
      option,
      option?.isCategory ? "category" : "option",
    );
    if (!option?.isCategory) {
      var promptLeaf = workdayPromptLeafTarget(el);
      if (promptLeaf && promptLeaf !== el) {
        triggerReactClickDeep(promptLeaf);
        clickLikeUser(promptLeaf);
        if (typeof promptLeaf.click === "function") {
          promptLeaf.click();
        }
        await sleep(120);
      }
      workdayClickOptionCommitTarget(el);
      if (promptLeaf && promptLeaf !== el) {
        triggerReactClickDeep(el);
      }
      await sleep(350);
      return true;
    }
    if (option?.isCategory) {
      var rect = el.getBoundingClientRect?.();
      var sideTarget =
        rect && rect.width > 0 && rect.height > 0
          ? document.elementFromPoint(
              Math.max(rect.left + 1, rect.right - 24),
              rect.top + rect.height / 2,
            )
          : null;
      if (sideTarget && (sideTarget === el || el.contains(sideTarget))) {
        clickLikeUser(sideTarget);
        triggerReactClickDeep(sideTarget);
      }
    }
    var nested =
      el.querySelector?.(
        'input:not([type="hidden"]), button, [role="radio"], [role="checkbox"]',
      ) || null;
    // AMA-style Workday source prompts use a virtualized hierarchical prompt:
    // the outer menuItem row is hover-only, the category/leaf onClick lives on
    // promptLeafNode, and the visible radio onChange can be a no-op. Dispatch to
    // the prompt leaf first; only then use the native click fallback.
    var target = nested || workdayPromptLeafTarget(el);
    triggerReactClickDeep(target || el);
    if (target !== el) {
      triggerReactClickDeep(el);
    }
    clickLikeUser(target || el);
    if (typeof (target || el).click === "function") {
      (target || el).click();
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

  function selectedWorkdayItemText(field) {
    var container = root.workdayUi?.nearestWorkdayField(field.element);
    return clean(
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
  }

  function workdayFieldHasValidationError(field) {
    var el = field?.element;
    var container = root.workdayUi?.nearestWorkdayField?.(el);
    var alertText = clean(
      Array.from(
        container?.querySelectorAll?.(
          [
            '[data-automation-id="inputAlert"]',
            '[data-automation-id="errorMessage"]',
            '[role="alert"]',
          ].join(", "),
        ) || [],
      )
        .map(function (node) {
          return node.innerText || node.textContent || "";
        })
        .join(" "),
    );
    return Boolean(
      el?.getAttribute?.("aria-invalid") === "true" ||
      container?.querySelector?.(
        [
          '[aria-invalid="true"]',
          '[data-automation-id="inputAlert"]',
          '[data-automation-id="errorMessage"]',
          '[role="alert"]',
        ].join(", "),
      ) ||
      /\b(must have a value|invalid|error|errors found)\b/i.test(alertText) ||
      /^required$/i.test(alertText),
    );
  }

  async function settleWorkdayCommit(field, answer, option) {
    var state = workdayCommittedState(field);
    var sourceField = isApplicationSourceField(
      field?.element,
      field?.descriptor,
    );
    var ok =
      committedStateMatches(state, answer, option) ||
      (sourceField && committedApplicationSourceMatches(state, answer, option));
    if (ok && !workdayFieldHasValidationError(field)) {
      return { ok: true, state: state };
    }
    var el = field?.element;
    keyOn(el, "Enter");
    keyOn(el, "Escape");
    if (typeof el?.blur === "function") {
      el.blur();
    }
    await sleep(240);
    state = workdayCommittedState(field);
    ok =
      committedStateMatches(state, answer, option) ||
      (sourceField && committedApplicationSourceMatches(state, answer, option));
    if (ok && !workdayFieldHasValidationError(field)) {
      return { ok: true, state: state };
    }
    return {
      ok: false,
      state: state,
      reason: workdayFieldHasValidationError(field)
        ? "workday_validation_not_cleared"
        : "workday_commit_not_verified",
    };
  }

  function workdayCommittedState(field) {
    var state = root.fieldState.readFieldState(field);
    var container = root.workdayUi?.nearestWorkdayField(field.element);
    function hasHumanText(candidate) {
      var value = clean(candidate);
      return Boolean(
        value &&
        !/^[a-f0-9]{16,}$/i.test(value) &&
        !/^[-a-z0-9]{24,}$/i.test(value),
      );
    }
    var selectedText = selectedWorkdayItemText(field);
    if (selectedText) {
      return {
        rawValue: selectedText,
        text: selectedText,
        selected: true,
      };
    }
    if (field.element?.tagName === "BUTTON" && container) {
      var buttonText = clean(optionLabel(field.element) || state?.text);
      if (hasHumanText(buttonText)) {
        return {
          rawValue: buttonText,
          text: buttonText,
          selected: true,
        };
      }
      var siblingInput = container.querySelector(
        'input[type="text"]:not([type="hidden"]), input[role="combobox"], input[data-automation-id]',
      );
      if (siblingInput) {
        var inputVal = clean(siblingInput.value);
        if (hasHumanText(inputVal)) {
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
    if (isTechnicalSkillsField(field, answer)) {
      return fillTechnicalSkills({ field, answer, option, audit, fieldAudit });
    }
    var committedState = workdayCommittedState(field);
    var committedLabel = clean(
      committedState.text || committedState.rawValue || "",
    );
    if (
      committedLabel &&
      committedStateMatches(committedState, answer, option) &&
      !workdayFieldHasValidationError(field)
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
    if (
      isApplicationSourceField(field.element, field.descriptor) &&
      committedApplicationSourceMatches(committedState, answer, option) &&
      !workdayFieldHasValidationError(field)
    ) {
      return {
        ok: true,
        reason: "preselected_workday_source",
        afterState: committedState,
        selectedOption: committedLabel,
        valueSource: fieldAudit?.valueSource || answer?.source || "",
        answerText: committedLabel,
      };
    }
    var options = await collectWorkdayOptions(field, {
      answer: answer,
      audit: audit,
      fieldAudit: fieldAudit,
    });
    var flatOptions = options.filter(function (candidate) {
      return !candidate.isCategory;
    });
    var skillField = isTechnicalSkillsField(field, answer);
    var target = skillField
      ? flatOptions.find(function (candidate) {
          return optionMatchesAny(candidate, answerTexts(answer, null));
        }) || null
      : preferredWorkdayOption(flatOptions, option, answer, field);
    if (!target && !skillField) {
      target = await findHierarchicalWorkdayOption(
        field,
        answer,
        option,
        options,
        audit,
        fieldAudit,
      );
    }
    if (!target) {
      if (isSalaryField(field, answer) && committedLabel) {
        await clearWorkdayField(field, audit, fieldAudit);
      }
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
      var missingKind = sourceOptionFailureKind(field);
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: missingKind,
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.fill",
        reason:
          missingKind === "workday_source_options_unavailable"
            ? "Workday Source popup opened but no source options were visible to choose."
            : "Workday popup opened but no selectable option was visible.",
        options: [],
      });
      await closePopup(field);
      return {
        ok: false,
        reason: missingKind,
        afterState: workdayCommittedState(field),
      };
    }
    var fallbackValueSource = workdayFallbackValueSource(target);
    if (fallbackValueSource) {
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "workday_progress_fallback_target",
        step: "workday.driver.fill",
        status: /progress_required|progress_first/.test(fallbackValueSource)
          ? "warn"
          : "info",
        reason: target.progressFallbackReason,
        selectedOption: target.label,
        detail: {
          descriptor: field.descriptor || "",
          originalAnswer: answer?.value || "",
          sourceSafe: /source_safe|safe_option/.test(fallbackValueSource),
        },
      });
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
    var trustedOption = null;
    var trustedKeyboard = null;
    var state = workdayCommittedState(field);
    var ok = false;
    if (shouldTryTrustedKeyboardFirst(target, field)) {
      var initialListbox = workdayActiveListboxFor(field.element);
      try {
        initialListbox?.focus?.({ preventScroll: true });
      } catch (_error) {
        initialListbox?.focus?.();
      }
      trustedKeyboard = await requestOrDispatchWorkdayKeys(
        field,
        trustedKeyboardSequenceForOption(target, field),
        "option_keyboard",
      );
      if (trustedKeyboard?.ok) {
        await sleep(650);
        var settled = await settleWorkdayCommit(field, answer, target);
        state = settled.state;
        ok = skillField
          ? selectedTechnicalSkillMatches(field, target, answer)
          : settled.ok;
      }
    }
    if (!ok) {
      await clickWorkdayOption(target);
      var clickSettled = await settleWorkdayCommit(field, answer, target);
      state = clickSettled.state;
      ok = skillField
        ? selectedTechnicalSkillMatches(field, target, answer)
        : clickSettled.ok;
    }
    if (!ok) {
      trustedOption = await requestTrustedWorkdayClick(target, "option");
      if (trustedOption?.ok) {
        await sleep(550);
        var trustedSettled = await settleWorkdayCommit(field, answer, target);
        state = trustedSettled.state;
        ok = skillField
          ? selectedTechnicalSkillMatches(field, target, answer)
          : trustedSettled.ok;
      }
      if (!ok) {
        var listbox = workdayActiveListboxFor(field.element);
        try {
          listbox?.focus?.({ preventScroll: true });
        } catch (_error) {
          listbox?.focus?.();
        }
        trustedKeyboard = await requestOrDispatchWorkdayKeys(
          field,
          trustedKeyboardSequenceForOption(target, field),
          "option_keyboard",
        );
        if (trustedKeyboard?.ok) {
          await sleep(650);
          var keyboardSettled = await settleWorkdayCommit(
            field,
            answer,
            target,
          );
          state = keyboardSettled.state;
          ok = skillField
            ? selectedTechnicalSkillMatches(field, target, answer)
            : keyboardSettled.ok;
        }
      }
    }
    await closePopup(field);
    if (!ok) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "workday_commit_not_verified",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.verify",
        reason: workdayFieldHasValidationError(field)
          ? "Clicked Workday option but validation did not clear."
          : "Clicked Workday option but committed value did not match.",
        options: options.map(function (candidate) {
          return candidate.label;
        }),
        trustedInput: trustedOption || null,
        trustedKeyboard: trustedKeyboard || null,
      });
    }
    return {
      ok: ok,
      reason: ok ? "" : "workday_commit_not_verified",
      afterState: state,
      selectedOption: target.label,
      valueSource:
        fallbackValueSource ||
        fieldAudit?.valueSource ||
        (option?.label
          ? "workday:option_match"
          : "fallback:workday_first_option"),
      answerText: target.label,
    };
  }

  async function fillCanadianCitizenshipStatus({
    field,
    answer,
    option,
    audit,
    fieldAudit,
  }) {
    var input = field.element;
    var country = citizenshipCountryFromAnswer(answer);
    await closePopup(field);
    var openResult = await openWorkdayPopupUntilOptions(field, "", 4);
    var listbox = workdayActiveListboxFor(input);
    if (listbox) {
      listbox.scrollTop = 0;
      listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(120);
    }
    var keyboardCountry = await keyboardOpenCitizenshipCountry(input, country);
    var countryResult = { match: null, attempts: 0 };
    var countryOption = null;
    if (!keyboardCountry?.ok) {
      countryResult = await scrollWorkdayListboxUntil(
        input,
        function () {
          return visibleWorkdayOptions(field).find(function (candidate) {
            return optionMatches(candidate, country);
          });
        },
        80,
      );
      countryOption = countryResult.match;
    }
    if (!countryOption && !keyboardCountry?.ok) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "workday_citizenship_country_missing",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.fill",
        reason:
          "Could not find the citizenship country parent option in the Workday prompt.",
        options: visibleWorkdayOptions(field).map(function (candidate) {
          return candidate.label;
        }),
      });
      await closePopup(field);
      return {
        ok: false,
        reason: "workday_citizenship_country_missing",
        afterState: workdayCommittedState(field),
      };
    }
    root.audit?.pushFieldStep(audit, fieldAudit, {
      action: "workday_citizenship_country_open",
      step: "workday.driver.fill",
      status: "info",
      reason: "open_citizenship_country_parent",
      selectedOption: countryOption?.label || keyboardCountry?.selectedOption,
      detail: {
        openAttemptCount: openResult.attempts || 0,
        scrollAttemptCount: countryResult.attempts || 0,
        keyboardAttemptCount: keyboardCountry?.attempts || 0,
      },
    });
    if (countryOption) {
      await clickWorkdayOption(countryOption);
    }
    var childResult = await waitForWorkdayOptions([], 2600, field);
    var childOptions = childResult.options.filter(function (candidate) {
      return !candidate.isCategory;
    });
    var target =
      preferredWorkdayOption(childOptions, option, answer, field) ||
      childOptions.find(function (candidate) {
        return optionMatches(candidate, answer?.value);
      });
    if (!target) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "workday_citizenship_status_missing",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.fill",
        reason:
          "Opened the citizenship country but could not find a matching terminal status option.",
        options: childOptions.map(function (candidate) {
          return candidate.label;
        }),
      });
      await closePopup(field);
      return {
        ok: false,
        reason: "workday_citizenship_status_missing",
        afterState: workdayCommittedState(field),
      };
    }
    root.audit?.pushFieldStep(audit, fieldAudit, {
      action: "workday_citizenship_status_option",
      step: "workday.driver.fill",
      status: "info",
      reason: "select_citizenship_status_leaf",
      selectedOption: target.label,
      detail: {
        childOptionCount: childOptions.length,
        waitAttempts: childResult.attempts,
      },
    });
    await clickWorkdayOption(target);
    var childListbox = workdayActiveListboxFor(input);
    // Workday's terminal citizenship rows are checkbox-backed promptLeafNode
    // items. Direct checkbox/row clicks can only focus the row; Enter on the
    // active listbox is the path that runs Workday's real selection handler.
    if (
      childListbox &&
      target.element?.querySelector?.(
        '[data-automation-id="checkboxPanel"], input[type="checkbox"]',
      )
    ) {
      try {
        childListbox.focus?.({ preventScroll: true });
      } catch (_error) {
        childListbox.focus?.();
      }
      var statusKeyboard = await requestOrDispatchWorkdayKeys(
        field,
        trustedKeyboardSequenceForOption(target, field),
        "citizenship_status_keyboard",
      );
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "workday_citizenship_status_keyboard",
        step: "workday.driver.fill",
        status: statusKeyboard?.ok ? "ok" : "warn",
        reason: statusKeyboard?.reason || "",
        selectedOption: target.label,
        detail: statusKeyboard || {},
      });
    }
    await sleep(500);
    var state = workdayCommittedState(field);
    var invalid = field.element?.getAttribute?.("aria-invalid") === "true";
    var ok =
      !invalid &&
      (optionMatches({ label: state.text }, target.label) ||
        optionMatches({ label: state.rawValue }, target.label));
    await closePopup(field);
    if (!ok) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "workday_citizenship_status_commit_failed",
        severity: field.required ? "warn" : "info",
        failedStep: "workday.driver.verify",
        reason:
          "Clicked citizenship status but Workday did not clear the required validation state.",
        options: childOptions.map(function (candidate) {
          return candidate.label;
        }),
      });
    }
    return {
      ok: ok,
      reason: ok ? "" : "workday_citizenship_status_commit_failed",
      afterState: state,
      selectedOption: target.label,
      valueSource: fieldAudit?.valueSource || answer?.source || "",
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
    var answerText = option?.label || answer?.value || "Canada (+1)";
    var committedState = workdayCommittedState(field);
    var committedLabel = clean(
      committedState.text || committedState.rawValue || "",
    );
    var committedSelectionText = selectedWorkdayItemText(field);
    if (
      committedSelectionText &&
      (optionMatches({ label: committedSelectionText }, answerText) ||
        (norm(answerText).includes("canada") &&
          norm(committedSelectionText).includes("canada")))
    ) {
      return {
        ok: true,
        reason: "committed_workday_selection",
        afterState: committedState,
        selectedOption: committedSelectionText,
        valueSource: fieldAudit?.valueSource || answer?.source || "",
        answerText: committedSelectionText,
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
    var selectedText = selectedWorkdayItemText(field);
    var ok =
      optionMatches({ label: selectedText }, best.label) ||
      (selectedText &&
        (optionMatches({ label: state.text }, best.label) ||
          optionMatches({ label: state.rawValue }, best.label)));
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
      if (isCanadianCitizenshipStatusField(field, args?.answer)) {
        return fillCanadianCitizenshipStatus(args);
      }
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
    fillCanadianCitizenshipStatus: fillCanadianCitizenshipStatus,
    fillPhoneCountryCode: fillPhoneCountryCode,
    fillWorkdayPopup: fillWorkdayPopup,
    clearWorkdayField: clearWorkdayField,
    visibleWorkdayOptions: visibleWorkdayOptions,
  };
})();
