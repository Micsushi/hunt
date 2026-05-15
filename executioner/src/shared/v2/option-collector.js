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

  function collectOptions(field) {
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
        var siblingLabel = (function () {
          var parent = radio.parentElement;
          if (!parent) return "";
          var labelEl =
            parent.querySelector?.(
              "label, [data-automation-id*='label'], [data-automation-id*='Label']",
            ) || (parent.tagName === "LABEL" ? parent : null);
          return labelEl && labelEl !== radio
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
    if (field.uiModel === "checkbox") {
      var label = window.__huntApplyUtils?.getDescriptor
        ? window.__huntApplyUtils.getDescriptor(
            field.element,
            root.uiInspector?.containerSelectors || [],
          )
        : field.element.value || field.element.id || "";
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
      return Array.from(
        document.querySelectorAll(
          '[role="option"], .select__option, [class*="__option"], [id*="-option-"]',
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
    return [];
  }

  root.optionCollector = {
    collectOptions: collectOptions,
  };
})();
