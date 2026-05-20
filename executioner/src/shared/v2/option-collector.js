(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function visible(el) {
    if (!el) {
      return false;
    }
    var style = window.getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function optionText(el) {
    return root.audit?.normalizeText(el?.innerText || el?.textContent || "");
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

  function nativeValueSetter(el) {
    var proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    return proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
  }

  function setSearchValue(el, value) {
    if (!el || !("value" in el) || value === undefined || value === null) {
      return false;
    }
    var text = String(value);
    try {
      el.focus?.();
    } catch (_error) {
      // Best effort: some detached or covered nodes reject focus.
    }
    var inserted = false;
    try {
      document.execCommand("selectAll", false, null);
      inserted = document.execCommand("insertText", false, text);
    } catch (_error) {
      inserted = false;
    }
    if (!inserted || el.value !== text) {
      var setter = nativeValueSetter(el);
      if (setter) {
        setter.call(el, "");
        setter.call(el, text);
      } else {
        el.value = "";
        el.value = text;
      }
    }
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        }),
      );
    } catch (_error) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function popupOptionElements() {
    return Array.from(
      document.querySelectorAll(
        [
          '[role="option"]',
          '[role="gridcell"]',
          ".select__option",
          ".cx-select__list-item",
          '[class*="__option"]',
          '[id*="-option-"]',
          '[data-testid*="option"]',
        ].join(","),
      ),
    )
      .filter(visible)
      .map(function (option) {
        return {
          label: optionText(option),
          value: optionText(option),
          element: option,
          placeholder: false,
        };
      })
      .filter(function (option) {
        return option.label;
      });
  }

  function hasOptionMatch(options, answerText) {
    var target = root.optionMatcher?.norm
      ? root.optionMatcher.norm(answerText)
      : String(answerText || "")
          .toLowerCase()
          .trim();
    if (!target) {
      return true;
    }
    return (options || []).some(function (option) {
      var label = root.optionMatcher?.norm
        ? root.optionMatcher.norm(option.label)
        : String(option.label || "")
            .toLowerCase()
            .trim();
      return (
        label === target ||
        label.startsWith(target + " ") ||
        label.startsWith(target + ",") ||
        label.includes(target)
      );
    });
  }

  async function collectOptions(field, context) {
    if (field.uiModel === "select") {
      return Array.from(field.element.options || []).map(function (option) {
        return {
          label: root.audit?.normalizeText(option.text || option.value || ""),
          value: option.value,
          element: option,
          placeholder: option.disabled || option.value === "",
        };
      });
    }
    if (field.uiModel === "radio_group") {
      return (field.radios || []).map(function (radio) {
        var ariaLabel = radio.getAttribute?.("aria-label") || "";
        var associatedLabel = (function () {
          if (!radio.id) {
            return "";
          }
          try {
            var label = document.querySelector(
              'label[for="' + CSS.escape(radio.id) + '"]',
            );
            return label
              ? (label.innerText || label.textContent || "").trim()
              : "";
          } catch (_error) {
            return "";
          }
        })();
        var closestLabel = (function () {
          var label = radio.closest?.("label");
          return label
            ? (label.innerText || label.textContent || "").trim()
            : "";
        })();
        var siblingLabel = (function () {
          var labelEl = radio.nextElementSibling;
          if (
            !labelEl?.matches?.(
              "label, [data-automation-id*='label'], [data-automation-id*='Label']",
            )
          ) {
            labelEl = radio.previousElementSibling;
          }
          return labelEl?.matches?.(
            "label, [data-automation-id*='label'], [data-automation-id*='Label']",
          )
            ? (labelEl.innerText || labelEl.textContent || "").trim()
            : "";
        })();
        var descriptorLabel = window.__huntApplyUtils?.getDescriptor
          ? window.__huntApplyUtils.getDescriptor(
              radio,
              root.uiInspector?.containerSelectors || [],
            )
          : radio.value || radio.id || "";
        var label =
          ariaLabel ||
          associatedLabel ||
          closestLabel ||
          siblingLabel ||
          descriptorLabel ||
          radio.value ||
          radio.id ||
          "";
        return {
          label: root.audit?.normalizeText(label || radio.value || radio.id),
          value: radio.value,
          element: radio,
          placeholder: false,
        };
      });
    }
    if (field.uiModel === "segmented_button_group") {
      return (field.buttons || []).map(function (button) {
        var label = optionText(button);
        return {
          label: label,
          value: label,
          element: button,
          placeholder: false,
        };
      });
    }
    if (field.uiModel === "checkbox") {
      var labelFor =
        field.element.id &&
        document.querySelector(`label[for="${CSS.escape(field.element.id)}"]`);
      var rowLabel =
        field.element.closest?.('[role="row"], [role="cell"]')?.innerText ||
        field.element.closest?.("label")?.innerText ||
        field.element.closest?.("div")?.innerText ||
        "";
      var label =
        labelFor?.innerText ||
        labelFor?.textContent ||
        rowLabel ||
        (window.__huntApplyUtils?.getDescriptor
          ? window.__huntApplyUtils.getDescriptor(
              field.element,
              root.uiInspector?.containerSelectors || [],
            )
          : field.element.value || field.element.id || "");
      return [
        {
          label: root.audit?.normalizeText(label || "Yes"),
          value: field.element.value || "checked",
          element: field.element,
          placeholder: false,
        },
      ];
    }
    if (["combobox", "button_listbox"].includes(field.uiModel)) {
      var answerText = context?.answer?.value || "";
      var options = popupOptionElements();
      if (options.length && hasOptionMatch(options, answerText)) {
        return options;
      }
      var opener =
        field.element?.closest?.('[role="combobox"], [aria-haspopup]') ||
        field.element?.parentElement?.querySelector?.(
          "button, [role='button'], [aria-haspopup]",
        ) ||
        field.element;
      clickLikeUser(opener);
      await new Promise(function (resolve) {
        setTimeout(resolve, 180);
      });
      options = popupOptionElements();
      if (options.length && hasOptionMatch(options, answerText)) {
        return options;
      }
      if (field.uiModel === "combobox" && answerText) {
        setSearchValue(field.element, answerText);
        await new Promise(function (resolve) {
          setTimeout(resolve, 260);
        });
      }
      return popupOptionElements();
    }
    return [];
  }

  root.optionCollector = {
    collectOptions: collectOptions,
  };
})();
