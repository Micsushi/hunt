(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  var CONTAINER_SELECTORS = [
    "label",
    "fieldset",
    '[role="group"]',
    "[data-testid]",
    ".form-group",
    ".field",
    ".form-field",
    ".input-group",
    ".application-field",
    ".application-question",
    '[class*="field"]',
    '[class*="Field"]',
    '[data-qa*="field"]',
    '[data-testid*="field"]',
  ];

  function visible(el) {
    if (!el || el.disabled) {
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

  function requiredText(el, descriptor) {
    return [
      el.required ? "required" : "",
      el.getAttribute?.("aria-required"),
      el.getAttribute?.("data-required"),
      el.getAttribute?.("placeholder"),
      descriptor,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function isRequired(el, descriptor) {
    if (el.getAttribute?.("aria-required") === "false" && !el.required) {
      return false;
    }
    var text = requiredText(el, descriptor);
    return (
      el.required ||
      el.getAttribute?.("aria-required") === "true" ||
      text.includes("*") ||
      text.includes("required") ||
      text.includes("mandatory")
    );
  }

  function uiModelFor(el) {
    var tag = el.tagName || "";
    var type = String(el.type || "").toLowerCase();
    var role = el.getAttribute?.("role") || "";
    var autocomplete = el.getAttribute?.("aria-autocomplete") || "";
    var popup = el.getAttribute?.("aria-haspopup") || "";
    if (tag === "SELECT") {
      return "select";
    }
    if (tag === "TEXTAREA") {
      return "textarea";
    }
    if (tag === "BUTTON" && popup === "listbox") {
      return "button_listbox";
    }
    if (type === "file") {
      return "file";
    }
    if (type === "checkbox") {
      return "checkbox";
    }
    if (type === "radio") {
      return "radio";
    }
    if (
      role === "combobox" ||
      autocomplete === "list" ||
      el.closest?.(".select__container")
    ) {
      return "combobox";
    }
    if (el.isContentEditable || role === "textbox") {
      return "text";
    }
    if (tag === "INPUT") {
      return "text";
    }
    return "unsupported";
  }

  function fieldIdFor(el, index) {
    return el.id || el.name || "field_" + index;
  }

  function collectCandidates() {
    var u = window.__huntApplyUtils;
    var elements = Array.from(
      document.querySelectorAll(
        [
          "select",
          "textarea",
          "button[aria-haspopup='listbox']",
          "input:not([type='hidden'])",
          "[contenteditable='true']",
          "[role='textbox']",
          "[role='combobox']",
          "[aria-autocomplete='list']",
        ].join(","),
      ),
    ).filter(visible);

    var radios = elements.filter(function (el) {
      return el.type === "radio";
    });
    var radioGroups = new Map();
    radios.forEach(function (radio) {
      var key = radio.name || radio.id || Math.random().toString(36);
      if (!radioGroups.has(key)) {
        radioGroups.set(key, []);
      }
      radioGroups.get(key).push(radio);
    });

    var radioSet = new Set(radios);
    var candidates = elements
      .filter(function (el) {
        return !radioSet.has(el);
      })
      .map(function (el, index) {
        var descriptor = u?.getDescriptor
          ? u.getDescriptor(el, CONTAINER_SELECTORS)
          : root.audit?.normalizeText(el.innerText || el.value || "");
        return {
          kind: "element",
          element: el,
          anchor: el,
          fieldId: fieldIdFor(el, index),
          descriptor: descriptor || "",
          questionHash: u?.buildQuestionHash
            ? u.buildQuestionHash(descriptor || "")
            : String(index),
          uiModel: uiModelFor(el),
          required: isRequired(el, descriptor),
          rect: root.audit?.rectSummary(el) || {},
        };
      });

    radioGroups.forEach(function (group, key) {
      var descriptor = group
        .map(function (radio) {
          return u?.getDescriptor
            ? u.getDescriptor(radio, CONTAINER_SELECTORS)
            : radio.value || radio.id || "";
        })
        .join(" ");
      candidates.push({
        kind: "radioGroup",
        element: group[0],
        anchor: group[0],
        radios: group,
        fieldId: key,
        descriptor: descriptor,
        questionHash: u?.buildQuestionHash
          ? u.buildQuestionHash(descriptor || "")
          : key,
        uiModel: "radio_group",
        required: group.some(function (radio) {
          return isRequired(radio, descriptor);
        }),
        rect: root.audit?.rectSummary(group[0]) || {},
      });
    });

    return candidates.sort(function (a, b) {
      if (a.rect.top !== b.rect.top) {
        return a.rect.top - b.rect.top;
      }
      return a.rect.left - b.rect.left;
    });
  }

  function isTextual(field) {
    return ["text", "textarea"].includes(field.uiModel);
  }

  function describePage(fields) {
    var headings = Array.from(
      document.querySelectorAll("h1,h2,h3,h4,[role='heading']"),
    )
      .map(function (heading) {
        return root.audit?.normalizeText(
          heading.innerText || heading.textContent || "",
        );
      })
      .filter(Boolean)
      .slice(0, 12);
    return {
      kind: "generic",
      title: document.title || "",
      url: window.location.href,
      signature: root.audit?.normalizeText(
        [headings[0] || document.title || "", window.location.pathname]
          .filter(Boolean)
          .join(" | "),
      ),
      headings: headings,
      sections: [],
      fieldCount: fields.length,
      requiredCount: fields.filter(function (field) {
        return field.required;
      }).length,
    };
  }

  root.uiInspector = {
    collectCandidates: collectCandidates,
    uiModelFor: uiModelFor,
    isRequired: isRequired,
    isTextual: isTextual,
    describePage: describePage,
    containerSelectors: CONTAINER_SELECTORS,
  };
})();
