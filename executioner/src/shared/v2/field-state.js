(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function clean(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function selectedTextNear(el) {
    var container =
      el.closest?.(".select__container") ||
      el.closest?.(".custom-select") ||
      el.parentElement;
    var selected = container?.querySelector(
      '.select__single-value, [class*="single-value"], [id^="pill-"]',
    );
    return clean(selected?.innerText || selected?.textContent || "");
  }

  function readFieldState(field) {
    var el = field.element || field.anchor;
    if (!el) {
      return { rawValue: "", text: "", checked: false, selected: false };
    }
    if (field.uiModel === "radio_group") {
      var checked = (field.radios || []).find(function (radio) {
        return radio.checked;
      });
      return {
        rawValue: checked?.value || "",
        text: clean(checked?.value || checked?.id || ""),
        checked: Boolean(checked),
        selected: Boolean(checked),
      };
    }
    if (field.uiModel === "checkbox") {
      return {
        rawValue: el.checked ? "checked" : "",
        text: el.checked ? "checked" : "",
        checked: Boolean(el.checked),
        selected: Boolean(el.checked),
      };
    }
    if (field.uiModel === "select") {
      var option = el.options?.[el.selectedIndex];
      return {
        rawValue: el.value || "",
        text: clean(option?.text || el.value || ""),
        checked: false,
        selected: Boolean(el.value),
      };
    }
    if (field.uiModel === "button_listbox") {
      var rawValue = clean(el.innerText || el.textContent || "");
      var lowerValue = rawValue.toLowerCase();
      var isPlaceholder =
        !rawValue ||
        lowerValue === "select" ||
        lowerValue === "select one" ||
        lowerValue === "none" ||
        lowerValue.startsWith("0 items") ||
        lowerValue.startsWith("select ");
      return {
        rawValue: rawValue,
        text: rawValue,
        checked: false,
        selected: !isPlaceholder,
      };
    }
    if (field.uiModel === "combobox") {
      var selectedText = selectedTextNear(el);
      return {
        rawValue: el.value || selectedText,
        text: selectedText || clean(el.value || ""),
        checked: false,
        selected: Boolean(selectedText || el.value),
      };
    }
    if (el.isContentEditable || el.getAttribute?.("role") === "textbox") {
      return {
        rawValue: el.textContent || "",
        text: clean(el.textContent || ""),
        checked: false,
        selected: false,
      };
    }
    return {
      rawValue: el.value || "",
      text: clean(el.value || ""),
      checked: false,
      selected: false,
    };
  }

  function isEmptyState(state) {
    return !clean(state.rawValue) && !clean(state.text) && !state.checked;
  }

  root.fieldState = {
    readFieldState: readFieldState,
    isEmptyState: isEmptyState,
  };
})();
