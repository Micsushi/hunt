(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function dispatchTextEvents(el, value) {
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
      return true;
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

  async function fillText(field, value) {
    var el = field.element;
    var ok = setValue(el, value);
    await sleep(350);
    var state = root.fieldState.readFieldState(field);
    return {
      ok:
        ok && (state.rawValue === value || state.text === String(value).trim()),
      afterState: state,
      reason: ok ? "" : "set_value_failed",
    };
  }

  async function fillTextWithFallbacks(field, audit, fieldAudit) {
    var candidates = [" ", "\u200b", "Not applicable."];
    for (var i = 0; i < candidates.length; i++) {
      var value = candidates[i];
      var result = await fillText(field, value);
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
              ? "fallback:space"
              : i === 1
                ? "fallback:zero_width_space"
                : "fallback:not_applicable",
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

  async function fillSelect(field, option) {
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

  async function fillRadioGroup(field, option) {
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

  async function fillCheckbox(field, option) {
    var el = field.element;
    if (!el.checked) {
      clickLikeUser(el);
      el.checked = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await sleep(80);
    return {
      ok: Boolean(el.checked),
      afterState: root.fieldState.readFieldState(field),
      selectedOption: option?.label || "checked",
      reason: "",
    };
  }

  async function fillPopupOption(field, option) {
    var el = field.element;
    clickLikeUser(el);
    await sleep(160);
    if (field.uiModel === "combobox") {
      setValue(el, option.label);
      await sleep(220);
    }
    var options = await root.optionCollector.collectOptions(field, {
      answer: { value: option.label },
      audit: null,
      fieldAudit: null,
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
    if (!input) {
      return {
        ok: false,
        reason: "resume_file_input_not_found",
        afterState: root.fieldState.readFieldState(field),
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
    if (["text", "textarea"].includes(field.uiModel)) {
      if (answer.value !== "" && answer.value !== undefined) {
        return await fillText(field, String(answer.value));
      }
      if (field.required) {
        return await fillTextWithFallbacks(field, audit, fieldAudit);
      }
      return { ok: false, reason: "missing_text_answer" };
    }
    if (field.uiModel === "select") {
      return await fillSelect(field, option);
    }
    if (field.uiModel === "radio_group") {
      return await fillRadioGroup(field, option);
    }
    if (field.uiModel === "checkbox") {
      return await fillCheckbox(field, option);
    }
    if (["combobox", "button_listbox"].includes(field.uiModel)) {
      return await fillPopupOption(field, option);
    }
    if (field.uiModel === "file") {
      return await fillFileField({
        field: field,
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
