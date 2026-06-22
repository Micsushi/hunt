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

  function labelFor(el) {
    if (!el?.id) {
      return null;
    }
    try {
      return document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    } catch (_error) {
      return null;
    }
  }

  function visibleOrFillable(el) {
    if (visible(el)) {
      return true;
    }
    var type = String(el?.type || "").toLowerCase();
    if (!["checkbox", "radio", "file"].includes(type)) {
      return false;
    }
    var label = labelFor(el) || el.closest?.("label");
    if (label && visible(label)) {
      return true;
    }
    var labelledBy = el.getAttribute?.("aria-labelledby") || "";
    if (labelledBy) {
      var labelled = labelledBy
        .split(/\s+/)
        .map(function (id) {
          try {
            return document.getElementById(id);
          } catch (_error) {
            return null;
          }
        })
        .filter(Boolean)
        .some(visible);
      if (labelled) {
        return true;
      }
    }
    if (type === "file") {
      var context = [
        el.id,
        el.name,
        el.getAttribute?.("accept"),
        el.closest?.("label, .resume-block, .application-field, [class*='field']")
          ?.innerText,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (
        (context.includes("resume") || context.includes("cv")) &&
        !context.includes("cover letter")
      ) {
        return true;
      }
    }
    return false;
  }

  function isHoneypot(el, descriptor) {
    var text = [
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("placeholder"),
      descriptor,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /\bhoney[-_\s]?pot\b/.test(text);
  }

  function isAuxiliaryComboInput(el) {
    if (String(el?.tagName || "").toUpperCase() !== "INPUT") {
      return false;
    }
    if (String(el.type || "").toLowerCase() !== "text") {
      return false;
    }
    var key = [
      el.id,
      el.name,
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("placeholder"),
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (key) {
      return false;
    }
    var group = el.closest?.('[role="group"], fieldset, .select__container');
    return Boolean(
      group?.querySelector?.(
        'input[role="combobox"], input[aria-autocomplete="list"], [role="combobox"] input',
      ),
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

  function validationText(el) {
    var describedBy = String(el?.getAttribute?.("aria-describedby") || "")
      .split(/\s+/)
      .map(function (id) {
        return id ? document.getElementById(id) : null;
      })
      .filter(Boolean)
      .map(function (node) {
        return node.innerText || node.textContent || "";
      });
    var container = el?.closest?.(
      [
        '[data-automation-id^="formField"]',
        '[data-automation-id*="checkbox" i]',
        ".application-field",
        ".application-question",
        ".input-row",
        "[role='group']",
        "fieldset",
        "label",
      ].join(", "),
    );
    var alerts = container
      ? Array.from(
          container.querySelectorAll(
            '[role="alert"], [aria-invalid="true"], [data-automation-id="inputAlert"], [data-automation-id*="error" i], [id*="error" i]',
          ),
        ).map(function (node) {
          return (
            node.innerText ||
            node.textContent ||
            node.getAttribute("aria-label") ||
            ""
          );
        })
      : [];
    return describedBy.concat(alerts).filter(Boolean).join(" ").toLowerCase();
  }

  function hasRequiredValidation(el) {
    if (el?.getAttribute?.("aria-invalid") === "true") {
      return true;
    }
    var text = validationText(el);
    return /required|must have a value|check the box|please select|please enter|cannot be blank|is invalid|error/i.test(
      text,
    );
  }

  function isRequired(el, descriptor) {
    if (el.getAttribute?.("aria-required") === "false" && !el.required) {
      return hasRequiredValidation(el);
    }
    var text = requiredText(el, descriptor);
    return (
      el.required ||
      el.getAttribute?.("aria-required") === "true" ||
      text.includes("*") ||
      text.includes("required") ||
      text.includes("mandatory") ||
      hasRequiredValidation(el)
    );
  }

  function isSegmentedGroupRequired(container, descriptor) {
    if (isRequired(container, descriptor)) {
      return true;
    }
    var wrapper = container.closest?.(
      [
        ".application-field",
        ".application-question",
        ".input-row",
        "[class*='question']",
        "[class*='Question']",
        "[class*='field']",
        "[class*='Field']",
        "[aria-required]",
      ].join(", "),
    );
    if (!wrapper || wrapper === container) {
      return false;
    }
    if (wrapper.getAttribute?.("aria-required") === "false") {
      return false;
    }
    var text = [
      requiredText(wrapper, descriptor),
      wrapper.innerText || wrapper.textContent || "",
      wrapper.querySelector?.('[role="alert"], [class*="error"]')?.innerText ||
        "",
      wrapper.className || "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      wrapper.getAttribute?.("aria-required") === "true" ||
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

  function buttonText(el) {
    return (
      root.audit?.normalizeText(el?.innerText || el?.textContent || "") || ""
    );
  }

  function isChoiceButton(el) {
    if (
      !visible(el) ||
      el.disabled ||
      el.getAttribute?.("aria-disabled") === "true"
    ) {
      return false;
    }
    var text = buttonText(el);
    if (!text || text.length > 80) {
      return false;
    }
    return !/^(next|back|cancel|apply|submit|verify|send new code|copy link|view more jobs)$/i.test(
      text,
    );
  }

  function selectedChoiceButtons(container, buttons) {
    return (buttons || []).filter(function (button) {
      var className = String(
        button.className?.baseVal || button.className || "",
      )
        .toLowerCase()
        .replace(/[_-]/g, " ");
      return (
        button.getAttribute?.("aria-pressed") === "true" ||
        button.getAttribute?.("aria-checked") === "true" ||
        button.getAttribute?.("data-selected") === "true" ||
        className.includes("selected") ||
        className.includes("active") ||
        container.getAttribute?.("data-selected") === buttonText(button)
      );
    });
  }

  function collectSegmentedButtonGroups(existingElements) {
    var existing = new Set(existingElements || []);
    var groups = [];
    var seen = new Set();
    function collectFromContainer(container) {
      if (seen.has(container)) {
        return;
      }
      var buttons = Array.from(container.querySelectorAll("button"))
        .filter(function (button) {
          return !existing.has(button) && isChoiceButton(button);
        })
        .slice(0, 8);
      if (buttons.length < 2 || buttons.length > 6) {
        return;
      }
      var labels = buttons.map(buttonText);
      var uniqueLabels = new Set(
        labels.map(function (label) {
          return label.toLowerCase();
        }),
      );
      var yesNoLike =
        uniqueLabels.has("yes") ||
        uniqueLabels.has("no") ||
        uniqueLabels.has("true") ||
        uniqueLabels.has("false");
      if (!yesNoLike || uniqueLabels.size !== labels.length) {
        return;
      }
      if (
        groups.some(function (group) {
          return (
            group.container.contains(container) ||
            container.contains(group.container)
          );
        })
      ) {
        return;
      }
      seen.add(container);
      groups.push({
        container: container,
        buttons: buttons,
        labels: labels,
      });
    }
    Array.from(
      document.querySelectorAll(
        [
          "ul.cx-select-pills-container",
          "[aria-label].cx-select-pills-container",
          "[aria-label][class*='select-pills']",
        ].join(", "),
      ),
    )
      .filter(visible)
      .forEach(collectFromContainer);
    Array.from(
      document.querySelectorAll(
        [
          "fieldset",
          '[role="group"]',
          ".field-wrapper",
          ".application-field",
          "[class*='question']",
          "[class*='field']",
          "section",
          "div",
        ].join(", "),
      ),
    )
      .filter(visible)
      .forEach(collectFromContainer);
    return groups;
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
    ).filter(visibleOrFillable);

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
      })
      .filter(function (field) {
        return (
          !isHoneypot(field.element, field.descriptor) &&
          !isAuxiliaryComboInput(field.element)
        );
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

    collectSegmentedButtonGroups(elements).forEach(function (group, index) {
      var descriptor = u?.getDescriptor
        ? u.getDescriptor(group.container, CONTAINER_SELECTORS)
        : root.audit?.normalizeText(group.container.innerText || "");
      var ariaLabel = group.container.getAttribute?.("aria-label") || "";
      descriptor = root.audit?.normalizeText(
        [ariaLabel, descriptor].filter(Boolean).join(" "),
      );
      candidates.push({
        kind: "segmentedButtonGroup",
        element: group.container,
        anchor: group.container,
        buttons: group.buttons,
        fieldId:
          group.container.id ||
          group.container.getAttribute?.("data-testid") ||
          "segmented_button_group_" + index,
        descriptor: descriptor || group.labels.join(" "),
        questionHash: u?.buildQuestionHash
          ? u.buildQuestionHash(descriptor || group.labels.join(" "))
          : "segmented_button_group_" + index,
        uiModel: "segmented_button_group",
        required: isSegmentedGroupRequired(group.container, descriptor),
        rect: root.audit?.rectSummary(group.container) || {},
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
    selectedChoiceButtons: selectedChoiceButtons,
  };
})();
