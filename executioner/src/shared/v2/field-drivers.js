(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function dispatchTextEvents(el, value) {
    var pieces =
      value && String(value).length > 1
        ? String(value).split("")
        : [String(value || "")];
    if (pieces.length > 1) {
      pieces.forEach(function (piece) {
        dispatchTextEvents(el, piece);
      });
      return;
    }
    value = pieces[0];
    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: value,
        }),
      );
    } catch (_error) {
      // InputEvent is not constructable in every embedded browser.
    }
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: value,
        }),
      );
    } catch (_error) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchBlurEvents(el) {
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    try {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    } catch (_error) {
      el.dispatchEvent(new Event("focusout", { bubbles: true }));
    }
  }

  function nativeValueSetter(el) {
    var proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    return proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
  }

  function forceFrameworkValueChange(el, value) {
    var tracker = el?._valueTracker;
    if (tracker && typeof tracker.setValue === "function") {
      tracker.setValue(value === "" ? "__hunt_empty_before_fill__" : "");
    }
  }

  function setValue(el, value) {
    var u = window.__huntApplyUtils;
    var text = String(value ?? "");
    if (value === undefined || value === null) {
      return false;
    }
    if (
      el instanceof HTMLInputElement &&
      String(el.type || "").toLowerCase() === "password"
    ) {
      el.setAttribute("autocomplete", "new-password");
      el.setAttribute("data-hunt-password-manager-suppressed", "true");
      var form = el.closest("form");
      if (form) {
        form.setAttribute("autocomplete", "off");
        form.setAttribute("data-hunt-password-manager-suppressed", "true");
      }
    }
    try {
      el.focus?.();
    } catch (_error) {
      // Some detached nodes reject focus. The setter still has a chance.
    }
    if ("value" in el) {
      var setter = nativeValueSetter(el);
      if (setter) {
        setter.call(el, "");
        forceFrameworkValueChange(el, "");
        dispatchTextEvents(el, "");
        setter.call(el, text);
      } else {
        el.value = "";
        dispatchTextEvents(el, "");
        el.value = text;
      }
      forceFrameworkValueChange(el, text);
      dispatchTextEvents(el, text);
      dispatchBlurEvents(el);
      if (String(el.value || "") === text) {
        return true;
      }
      if (text && u?.setElementValue) {
        var injectedOk = u.setElementValue(el, text, true);
        dispatchBlurEvents(el);
        return Boolean(injectedOk);
      }
      return false;
    }
    if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
      el.textContent = text;
      dispatchTextEvents(el, text);
      dispatchBlurEvents(el);
      return true;
    }
    if (u?.setElementValue) {
      return u.setElementValue(el, text, true);
    }
    return false;
  }

  function clickLikeUser(el) {
    if (!el) {
      return;
    }
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    }
    var rect = el.getBoundingClientRect();
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
      function (type) {
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
      },
    );
  }

  function matchesText(value, expected) {
    return (
      root.optionMatcher?.norm(value || "") ===
      root.optionMatcher?.norm(expected || "")
    );
  }

  function answerAliases(answer) {
    var aliases = [];
    var map = answer?.optionAliases || {};
    Object.keys(map).forEach(function (key) {
      if (matchesText(key, answer?.value)) {
        aliases = aliases.concat(map[key] || []);
      }
    });
    return aliases;
  }

  function stateSatisfiesAnswer(state, answer) {
    var current = state?.rawValue || state?.text || "";
    if (!current || answer?.value === undefined || answer?.value === null) {
      return false;
    }
    if (matchesText(current, answer.value)) {
      return true;
    }
    return answerAliases(answer).some(function (alias) {
      return matchesText(current, alias);
    });
  }

  function dateSectionKind(field) {
    var value = [
      field?.fieldId,
      field?.id,
      field?.name,
      field?.descriptor,
      field?.element?.id,
      field?.element?.name,
      field?.element?.getAttribute?.("data-automation-id"),
      field?.element?.getAttribute?.("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
    if (/dateSectionMonth/i.test(value)) {
      return "month";
    }
    if (/dateSectionDay/i.test(value)) {
      return "day";
    }
    if (/dateSectionYear/i.test(value)) {
      return "year";
    }
    return "";
  }

  function dateSectionCommitMatches(field, expected, committed) {
    var kind = dateSectionKind(field);
    if (!kind) {
      return false;
    }
    if (dateSectionHasValidationError(field)) {
      return false;
    }
    var expectedText = String(expected || "").trim();
    var committedText = String(committed || "").trim();
    if (!expectedText || !committedText) {
      return false;
    }
    if (!/^\d+$/.test(expectedText) || !/^\d+$/.test(committedText)) {
      return false;
    }
    if (kind === "year") {
      return expectedText === committedText;
    }
    return Number(expectedText) === Number(committedText);
  }

  function dateSectionHasValidationError(field) {
    if (!dateSectionKind(field)) {
      return false;
    }
    var el = field?.element;
    if (el?.getAttribute?.("aria-invalid") === "true") {
      return true;
    }
    var container = el?.closest?.(
      '[data-automation-id^="formField"], [role="group"], fieldset',
    );
    return Boolean(
      container?.querySelector?.(
        '[aria-invalid="true"], [data-automation-id="inputAlert"]',
      ),
    );
  }

  async function commitDatePartWithKeyboard(field) {
    var el = field?.element;
    if (!el || !dateSectionKind(field)) {
      return false;
    }
    try {
      el.focus?.();
      ["Enter", "Tab"].forEach(function (key) {
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key,
          }),
        );
        el.dispatchEvent(
          new KeyboardEvent("keyup", {
            bubbles: true,
            cancelable: true,
            key,
          }),
        );
      });
      dispatchBlurEvents(el);
      await sleep(180);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function fillText(field, value, audit, fieldAudit) {
    var el = field.element;
    root.audit?.emitEvent(
      audit,
      "field.focus",
      root.audit.fieldPayload(field, {
        status: "info",
        reason: "text_driver_focus",
      }),
    );
    var ok = setValue(el, value);
    await sleep(350);
    var state = root.fieldState.readFieldState(field);
    var expected = String(value);
    var committed = String(state.rawValue || state.text || "");
    var type = String(el?.type || "").toLowerCase();
    var digitMatch =
      type === "tel" &&
      expected.replace(/\D+/g, "") &&
      expected.replace(/\D+/g, "") === committed.replace(/\D+/g, "");
    var datePartMatch = dateSectionCommitMatches(field, expected, committed);
    var datePartKeyboardCommit = false;
    if (ok && dateSectionKind(field) && !datePartMatch) {
      datePartKeyboardCommit = await commitDatePartWithKeyboard(field);
      state = root.fieldState.readFieldState(field);
      committed = String(state.rawValue || state.text || "");
      datePartMatch = dateSectionCommitMatches(field, expected, committed);
    }
    var textMatch =
      state.rawValue === value ||
      state.text === expected.trim() ||
      digitMatch ||
      datePartMatch;
    var retriedTextCommit = false;
    if (
      ok &&
      !textMatch &&
      ["text", "email", "tel", "url", "search", ""].includes(type)
    ) {
      retriedTextCommit = true;
      ok = setValue(el, value);
      await sleep(350);
      state = root.fieldState.readFieldState(field);
      committed = String(state.rawValue || state.text || "");
      digitMatch =
        type === "tel" &&
        expected.replace(/\D+/g, "") &&
        expected.replace(/\D+/g, "") === committed.replace(/\D+/g, "");
      datePartMatch = dateSectionCommitMatches(field, expected, committed);
      textMatch =
        state.rawValue === value ||
        state.text === expected.trim() ||
        digitMatch ||
        datePartMatch;
    }
    return {
      ok: ok && textMatch,
      afterState: state,
      reason: !ok
        ? "set_value_failed"
        : datePartKeyboardCommit
          ? "date_part_keyboard_commit"
          : retriedTextCommit
            ? "text_commit_retry"
            : "",
    };
  }

  async function fillTextWithFallbacks(field, audit, fieldAudit) {
    var candidates = ["Not applicable.", "N/A", "\u200b"];
    for (var i = 0; i < candidates.length; i++) {
      var value = candidates[i];
      var result = await fillText(field, value, audit, fieldAudit);
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "textbox_fallback_attempt",
        step: "driver.text.fallback",
        status: result.ok ? "ok" : "warn",
        reason: result.ok ? "fallback_committed" : "fallback_not_committed",
        detail: { fallbackIndex: i, valuePreview: value || "[space]" },
      });
      if (result.ok) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "generated_or_placeholder_text_fallback",
          severity: "warn",
          failedStep: "driver.text.fallback",
          reason: "Filled required unknown textbox with fallback text.",
        });
        return Object.assign(result, {
          valueSource:
            i === 0
              ? "fallback:not_applicable"
              : i === 1
                ? "fallback:na"
                : "fallback:zero_width_space",
          answerText: value,
          manualReviewRequired: true,
        });
      }
    }
    return {
      ok: false,
      reason: "text_fallback_not_committed",
      afterState: root.fieldState.readFieldState(field),
    };
  }

  async function fillSelect(field, option, audit) {
    var el = field.element;
    var target = Array.from(el.options || []).find(function (candidate) {
      return (
        matchesText(candidate.text || candidate.value, option.label) ||
        matchesText(candidate.value, option.value)
      );
    });
    if (!target) {
      return { ok: false, reason: "option_not_found" };
    }
    root.audit?.emitEvent(
      audit,
      "option.clicked",
      root.audit.fieldPayload(field, {
        status: "info",
        reason: "native_select_option_selected",
        selectedOption: option.label || "",
        optionValue: option.value || "",
      }),
    );
    el.value = target.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(80);
    var state = root.fieldState.readFieldState(field);
    return {
      ok: matchesText(state.text, option.label) || el.value === target.value,
      afterState: state,
      selectedOption: option.label,
      reason: "",
    };
  }

  async function fillRadioGroup(field, option, audit) {
    var target =
      option?.element && (field.radios || []).includes(option.element)
        ? option.element
        : null;
    target =
      target ||
      (field.radios || []).find(function (radio) {
        var descriptor = window.__huntApplyUtils?.getDescriptor
          ? window.__huntApplyUtils.getDescriptor(
              radio,
              root.uiInspector?.containerSelectors || [],
            )
          : radio.value || radio.id || "";
        return (
          matchesText(descriptor, option.label) ||
          matchesText(radio.value, option.value) ||
          descriptor.toLowerCase().includes(String(option.label).toLowerCase())
        );
      });
    if (!target) {
      return { ok: false, reason: "radio_not_found" };
    }
    root.audit?.emitEvent(
      audit,
      "option.clicked",
      root.audit.fieldPayload(field, {
        status: "info",
        reason: "radio_option_clicked",
        selectedOption: option.label || "",
      }),
    );
    clickLikeUser(target);
    target.checked = true;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(80);
    return {
      ok: Boolean(target.checked),
      afterState: root.fieldState.readFieldState(field),
      selectedOption: option.label,
      reason: "",
    };
  }

  async function fillSegmentedButtonGroup(field, option, audit) {
    var target =
      option?.element && (field.buttons || []).includes(option.element)
        ? option.element
        : null;
    target =
      target ||
      (field.buttons || []).find(function (button) {
        var label = button.innerText || button.textContent || "";
        return (
          matchesText(label, option.label) || matchesText(label, option.value)
        );
      });
    if (!target) {
      return { ok: false, reason: "segmented_button_not_found" };
    }
    root.audit?.emitEvent(
      audit,
      "option.clicked",
      root.audit.fieldPayload(field, {
        status: "info",
        reason: "segmented_button_clicked",
        selectedOption: option.label || "",
      }),
    );
    clickLikeUser(target);
    await sleep(160);
    var state = root.fieldState.readFieldState(field);
    var ok =
      matchesText(state.text, option.label) ||
      state.selected ||
      target.getAttribute?.("aria-pressed") === "true" ||
      target.getAttribute?.("aria-checked") === "true";
    return {
      ok: Boolean(ok),
      afterState: state,
      selectedOption: option.label,
      reason: "",
    };
  }

  async function fillCheckbox(field, option, audit) {
    var el = field.element;
    function checkboxOn() {
      return (
        Boolean(el.checked) ||
        el.getAttribute?.("aria-checked") === "true" ||
        el.closest?.('[aria-checked="true"]')
      );
    }
    function setNativeChecked() {
      try {
        var descriptor = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "checked",
        );
        if (descriptor?.set) {
          descriptor.set.call(el, true);
        } else {
          el.checked = true;
        }
      } catch (_error) {
        el.checked = true;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (!checkboxOn()) {
      var labelFor =
        el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      var targets = [
        el,
        labelFor,
        el.closest?.("label"),
        el.closest?.('[role="checkbox"], [data-automation-id*="checkbox" i]'),
        el.parentElement,
      ].filter(Boolean);
      for (var i = 0; i < targets.length && !checkboxOn(); i++) {
        root.audit?.emitEvent(
          audit,
          "option.clicked",
          root.audit.fieldPayload(field, {
            status: "info",
            reason: "checkbox_target_clicked",
            selectedOption: option?.label || "checked",
            clickIndex: i + 1,
          }),
        );
        clickLikeUser(targets[i]);
        await sleep(120);
      }
      if (!checkboxOn()) {
        setNativeChecked();
      }
      await sleep(250);
      if (!checkboxOn()) {
        setNativeChecked();
        await sleep(120);
      }
    }
    var state = root.fieldState.readFieldState(field);
    return {
      ok: Boolean(checkboxOn() || state.checked || state.selected),
      afterState: state,
      selectedOption: option?.label || "checked",
      reason: "",
    };
  }

  async function fillPopupOption(field, option, audit, fieldAudit) {
    var el = field.element;
    root.audit?.emitEvent(
      audit,
      "field.focus",
      root.audit.fieldPayload(field, {
        status: "info",
        reason: "popup_opener_focus",
      }),
    );
    clickLikeUser(el);
    await sleep(160);
    if (field.uiModel === "combobox") {
      setValue(el, option.label);
      await sleep(220);
    }
    var options = await root.optionCollector.collectOptions(field, {
      answer: { value: option.label },
      audit: audit,
      fieldAudit: fieldAudit,
    });
    var target = options.find(function (candidate) {
      return matchesText(candidate.label, option.label);
    });
    if (!target) {
      return {
        ok: false,
        reason: "popup_option_not_found",
        afterState: root.fieldState.readFieldState(field),
      };
    }
    root.audit?.emitEvent(
      audit,
      "option.clicked",
      root.audit.fieldPayload(field, {
        status: "info",
        reason: "popup_option_clicked",
        selectedOption: target.label || option.label || "",
        optionElement: root.audit?.summarizeElement(target.element) || {},
      }),
    );
    clickLikeUser(target.element);
    await sleep(180);
    var state = root.fieldState.readFieldState(field);
    return {
      ok: matchesText(state.text, option.label) || state.selected,
      afterState: state,
      selectedOption: option.label,
      reason: "",
    };
  }

  async function fillFileField({
    field,
    answer,
    activeApplyContext,
    defaultResume,
    audit,
    fieldAudit,
  }) {
    var u = window.__huntApplyUtils;
    var el = field.element;
    var input =
      (el?.tagName === "INPUT" && el.type === "file" ? el : null) ||
      field.fileInput ||
      el
        ?.closest?.('[data-automation-id^="formField"], [role="group"], body')
        ?.querySelector?.('input[type="file"]') ||
      document.querySelector('input[type="file"]');
    if (!u?.attachResumeToFileInput) {
      return {
        ok: false,
        reason: "resume_upload_helper_missing",
        afterState: root.fieldState.readFieldState(field),
      };
    }
    if (
      answer?.answerType !== "file" ||
      String(answer?.value || "") !== "resume_upload"
    ) {
      return {
        ok: false,
        reason: "not_resume_input",
        afterState: root.fieldState.readFieldState(field),
      };
    }
    if (!input) {
      return {
        ok: false,
        reason: "resume_file_input_not_found",
        afterState: root.fieldState.readFieldState(field),
      };
    }
    var container =
      el?.closest?.(
        '[data-automation-id^="formField"], [role="group"], form',
      ) || document.body;
    var uploadedText = String(
      container.innerText || container.textContent || "",
    )
      .replace(/\s+/g, " ")
      .trim();
    if (
      uploadedText.toLowerCase().includes("successfully uploaded") ||
      (uploadedText.toLowerCase().includes(".pdf") &&
        uploadedText.toLowerCase().includes("uploaded"))
    ) {
      return {
        ok: true,
        reason: "resume_already_uploaded",
        afterState: {
          rawValue: "uploaded",
          text: "uploaded",
          checked: false,
          selected: true,
        },
        valueSource: "resume_upload",
        answerText: "resume_already_uploaded",
      };
    }
    root.audit?.pushFieldStep(audit, fieldAudit, {
      action: "resume_file_input_selected",
      step: "driver.file.input",
      status: "info",
      reason: "hidden_file_input",
      element: root.audit?.summarizeElement(input) || {},
    });
    var attachment = await u.attachResumeToFileInput(
      input,
      activeApplyContext || {},
      defaultResume || {},
    );
    if (!attachment.attached) {
      return {
        ok: false,
        reason: "resume_upload:" + attachment.reason,
        afterState: root.fieldState.readFieldState(field),
      };
    }
    await sleep(800);
    return {
      ok: true,
      reason: "resume_file_attached",
      afterState: {
        rawValue: attachment.fileName || "",
        text: attachment.fileName || "",
        checked: false,
        selected: true,
      },
      valueSource: "resume_upload",
      answerText: attachment.fileName || "resume_upload",
    };
  }

  async function clearField(field) {
    var el = field.element;
    var beforeState = root.fieldState.readFieldState(field);
    if (root.fieldState.isEmptyState(beforeState)) {
      return {
        ok: true,
        reason: "already_clear",
        afterState: beforeState,
      };
    }
    if (["text", "textarea", "combobox"].includes(field.uiModel)) {
      setValue(el, "");
      await sleep(80);
      return {
        ok: root.fieldState.isEmptyState(root.fieldState.readFieldState(field)),
        afterState: root.fieldState.readFieldState(field),
      };
    }
    if (field.uiModel === "checkbox") {
      if (el.checked) {
        clickLikeUser(el);
      }
      el.checked = false;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(80);
      return {
        ok: !el.checked,
        afterState: root.fieldState.readFieldState(field),
      };
    }
    if (field.uiModel === "select") {
      var placeholder = Array.from(el.options || []).find(function (option) {
        return option.value === "" || option.disabled;
      });
      if (!placeholder) {
        return {
          ok: false,
          reason: "select_placeholder_not_found",
          afterState: root.fieldState.readFieldState(field),
        };
      }
      el.value = placeholder.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(80);
      return {
        ok: el.value === placeholder.value,
        afterState: root.fieldState.readFieldState(field),
      };
    }
    if (field.uiModel === "button_listbox") {
      return {
        ok: root.fieldState.isEmptyState(root.fieldState.readFieldState(field)),
        reason: "button_listbox_clear_icon_required",
        afterState: root.fieldState.readFieldState(field),
      };
    }
    if (field.uiModel === "segmented_button_group") {
      return {
        ok: root.fieldState.isEmptyState(root.fieldState.readFieldState(field)),
        reason: "segmented_button_clear_not_supported",
        afterState: root.fieldState.readFieldState(field),
      };
    }
    return {
      ok: false,
      reason: "unsupported_clear_ui",
      afterState: root.fieldState.readFieldState(field),
    };
  }

  async function fillField({
    field,
    answer,
    option,
    audit,
    fieldAudit,
    activeApplyContext,
    defaultResume,
  }) {
    root.audit?.emitEvent(
      audit,
      "field.focus",
      root.audit.fieldPayload(field, {
        status: "info",
        reason: "driver_fill_started",
      }),
    );
    var result = null;
    if (["text", "textarea"].includes(field.uiModel)) {
      if (answer.value !== "" && answer.value !== undefined) {
        result = await fillText(field, String(answer.value), audit, fieldAudit);
        return result;
      }
      if (field.required && answer.answerType === "unknown") {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "unknown_text_defaulted",
          severity: "warn",
          failedStep: "driver.text",
          reason:
            "Required unknown text question has no mapping/profile answer, so C3 used placeholder text fallback.",
        });
        result = await fillTextWithFallbacks(field, audit, fieldAudit);
        return result;
      }
      if (field.required) {
        result = await fillTextWithFallbacks(field, audit, fieldAudit);
        return result;
      }
      return { ok: false, reason: "missing_text_answer" };
    }
    if (field.uiModel === "select") {
      result = await fillSelect(field, option, audit);
      root.audit?.emitEvent(
        audit,
        "option.committed",
        root.audit.fieldPayload(field, {
          status: result.ok ? "ok" : "warn",
          reason:
            result.reason ||
            (result.ok ? "select_commit_verified" : "select_commit_failed"),
          selectedOption: result.selectedOption || option?.label || "",
        }),
      );
      return result;
    }
    if (field.uiModel === "radio_group") {
      result = await fillRadioGroup(field, option, audit);
      root.audit?.emitEvent(
        audit,
        "option.committed",
        root.audit.fieldPayload(field, {
          status: result.ok ? "ok" : "warn",
          reason:
            result.reason ||
            (result.ok ? "radio_commit_verified" : "radio_commit_failed"),
          selectedOption: result.selectedOption || option?.label || "",
        }),
      );
      return result;
    }
    if (field.uiModel === "segmented_button_group") {
      result = await fillSegmentedButtonGroup(field, option, audit);
      root.audit?.emitEvent(
        audit,
        "option.committed",
        root.audit.fieldPayload(field, {
          status: result.ok ? "ok" : "warn",
          reason:
            result.reason ||
            (result.ok
              ? "segmented_commit_verified"
              : "segmented_commit_failed"),
          selectedOption: result.selectedOption || option?.label || "",
        }),
      );
      return result;
    }
    if (field.uiModel === "checkbox") {
      result = await fillCheckbox(field, option, audit);
      root.audit?.emitEvent(
        audit,
        "option.committed",
        root.audit.fieldPayload(field, {
          status: result.ok ? "ok" : "warn",
          reason:
            result.reason ||
            (result.ok ? "checkbox_commit_verified" : "checkbox_commit_failed"),
          selectedOption: result.selectedOption || option?.label || "checked",
        }),
      );
      return result;
    }
    if (["combobox", "button_listbox"].includes(field.uiModel)) {
      var currentState = root.fieldState.readFieldState(field);
      if (
        option &&
        currentState.selected &&
        stateSatisfiesAnswer(currentState, {
          value: option.label || option.value || "",
          optionAliases: {},
        })
      ) {
        return {
          ok: true,
          reason: "already_filled",
          afterState: currentState,
          selectedOption: currentState.text || currentState.rawValue,
        };
      }
      result = await fillPopupOption(field, option, audit, fieldAudit);
      root.audit?.emitEvent(
        audit,
        "option.committed",
        root.audit.fieldPayload(field, {
          status: result.ok ? "ok" : "warn",
          reason:
            result.reason ||
            (result.ok ? "popup_commit_verified" : "popup_commit_failed"),
          selectedOption: result.selectedOption || option?.label || "",
        }),
      );
      return result;
    }
    if (field.uiModel === "file") {
      return await fillFileField({
        field: field,
        answer: answer,
        activeApplyContext: activeApplyContext,
        defaultResume: defaultResume,
        audit: audit,
        fieldAudit: fieldAudit,
      });
    }
    return { ok: false, reason: "unsupported_fill_ui" };
  }

  root.fieldDrivers = {
    fillField: fillField,
    clearField: clearField,
    clickLikeUser: clickLikeUser,
  };
})();
