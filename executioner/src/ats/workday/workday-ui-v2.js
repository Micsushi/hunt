(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function clean(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function lower(value) {
    return clean(value).toLowerCase();
  }

  function visible(el) {
    if (!el || el.disabled) {
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

  function nearestWorkdayField(el) {
    return (
      el?.closest?.(
        [
          '[data-automation-id^="formField-"]',
          '[data-automation-id="formField"]',
          '[data-automation-id="formField-feedbackWrapper"]',
        ].join(", "),
      ) ||
      el?.closest?.(
        [
          '[data-automation-id*="phone"]',
          "[data-uxi-widget-type]",
          "[data-uxi-widget-id]",
          "[data-uxi-multiselect-id]",
          "[data-testid*='form']",
          "[role='group']",
        ].join(", "),
      ) ||
      null
    );
  }

  function workdayFieldLabel(el) {
    var field = nearestWorkdayField(el);
    return clean(
      [
        field?.innerText,
        field?.textContent,
        field?.getAttribute?.("aria-label"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function workdayContextText(field) {
    var el = field.element || field.anchor;
    var container = nearestWorkdayField(el);
    var fieldLabel = workdayFieldLabel(el);
    var pieces = [
      fieldLabel,
      field.descriptor,
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("aria-labelledby"),
      el?.getAttribute?.("placeholder"),
      el?.getAttribute?.("data-automation-id"),
      el?.getAttribute?.("data-uxi-widget-type"),
      el?.getAttribute?.("data-uxi-widget-id"),
      container?.getAttribute?.("data-automation-id"),
      container?.getAttribute?.("data-uxi-widget-type"),
      container?.innerText,
      container?.textContent,
    ];
    return clean(pieces.filter(Boolean).join(" "));
  }

  function looksLikeAiConsentText(text) {
    var value = lower(text);
    return (
      (value.includes("ai") ||
        value.includes("artificial intelligence") ||
        value.includes("automated tools") ||
        value.includes("automated decision") ||
        value.includes("ai-enabled") ||
        value.includes("ai enabled")) &&
      (value.includes("consent") ||
        value.includes("processed by these tools") ||
        value.includes("support review of your application") ||
        value.includes("recruiting tools") ||
        value.includes("opt-out") ||
        value.includes("opt out"))
    );
  }

  function looksLikeTechnicalSkillsField(field) {
    var el = field.element || field.anchor;
    var text = lower(
      [
        field.fieldId,
        field.descriptor,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("placeholder"),
        el?.getAttribute?.("data-automation-id"),
        el?.getAttribute?.("data-uxi-widget-type"),
        workdayFieldLabel(el),
      ]
        .filter(Boolean)
        .join(" "),
    );
    return (
      text.includes("type to add skills") ||
      text.includes("formfield skills") ||
      text.includes("skills skills") ||
      /\bskills\b/.test(text)
    );
  }

  function hasDirectRequiredSignal(el, container) {
    var directText = lower(
      [
        el?.required ? "required" : "",
        el?.getAttribute?.("aria-required"),
        el?.getAttribute?.("data-required"),
        el?.getAttribute?.("aria-invalid"),
        el?.getAttribute?.("aria-describedby"),
        el?.getAttribute?.("placeholder"),
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (
      el?.required ||
      el?.getAttribute?.("aria-required") === "true" ||
      directText.includes("required") ||
      directText.includes("true")
    ) {
      return true;
    }
    var validationText = lower(
      Array.from(
        container?.querySelectorAll?.(
          [
            '[role="alert"]',
            '[data-automation-id="inputAlert"]',
            '[data-automation-id*="error" i]',
            '[id*="error" i]',
          ].join(", "),
        ) || [],
      )
        .map(function (node) {
          return node.innerText || node.textContent || "";
        })
        .join(" "),
    );
    return /required|must have a value|please select|please enter|cannot be blank|is invalid|error/i.test(
      validationText,
    );
  }

  function workdayWidgetKind(field) {
    var el = field.element || field.anchor;
    var fieldLabel = workdayFieldLabel(el);
    var ownText = lower(
      [
        fieldLabel,
        field.fieldId,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("placeholder"),
      ]
        .filter(Boolean)
        .join(" "),
    );
    var text = lower(workdayContextText(field));
    var automationId = lower(el?.getAttribute?.("data-automation-id"));
    var widgetType = lower(el?.getAttribute?.("data-uxi-widget-type"));
    var role = lower(el?.getAttribute?.("role"));
    var popup = lower(el?.getAttribute?.("aria-haspopup"));
    if (
      !looksLikeAiConsentText([ownText, text].join(" ")) &&
      (automationId.includes("select-files") ||
        automationId.includes("file-upload") ||
        ownText.includes("upload a file") ||
        ownText.includes("drop files") ||
        ownText.includes("resume/cv") ||
        ownText.includes("resume cv"))
    ) {
      return "resume_file";
    }
    if (
      ownText.includes("country / territory phone code") ||
      ownText.includes("country territory phone code") ||
      ownText.includes("phone code") ||
      ownText.includes("country phone code") ||
      ownText.includes("phone country")
    ) {
      return "phone_country_code";
    }
    if (
      ownText.includes("phone device type") ||
      ownText.includes("phone type")
    ) {
      return "workday_search_select";
    }
    if (
      ownText.includes("how did you hear about us") ||
      ownText.includes("how did you hear") ||
      ownText.includes("source")
    ) {
      return "workday_search_select";
    }
    if (
      widgetType.includes("multiselect") ||
      automationId.includes("multiselect") ||
      ownText.includes("press delete to clear value")
    ) {
      return "workday_multiselect";
    }
    if (
      role === "combobox" ||
      popup === "listbox" ||
      widgetType.includes("select") ||
      automationId.includes("prompt") ||
      automationId.includes("select")
    ) {
      return "workday_search_select";
    }
    if (
      ["BUTTON", "SELECT"].includes(el?.tagName || "") &&
      (text.includes("phone code") || text.includes("country phone code"))
    ) {
      return "workday_search_select";
    }
    return "";
  }

  function refineUiModel(field, kind) {
    if (!kind) {
      return field.uiModel;
    }
    if (kind === "phone_country_code" || kind === "workday_multiselect") {
      return "combobox";
    }
    if (kind === "resume_file") {
      return "file";
    }
    if (field.element?.tagName === "BUTTON") {
      return "button_listbox";
    }
    if (kind === "workday_search_select" && field.uiModel === "text") {
      return "combobox";
    }
    return field.uiModel;
  }

  function classify(field) {
    var el = field.element || field.anchor;
    if (!el) {
      return field;
    }
    var kind = workdayWidgetKind(field);
    var container = nearestWorkdayField(el);
    var fieldLabel = workdayFieldLabel(el);
    var contextText = workdayContextText(field);
    field.workday = {
      kind: kind,
      fieldLabel: fieldLabel,
      contextText: contextText.slice(0, 1200),
      container: root.audit?.summarizeElement(container) || {},
      automationId: el.getAttribute?.("data-automation-id") || "",
      widgetType: el.getAttribute?.("data-uxi-widget-type") || "",
    };
    if (fieldLabel) {
      field.descriptor = clean(
        [
          fieldLabel,
          el.id,
          el.name,
          el.getAttribute?.("aria-label"),
          el.getAttribute?.("placeholder"),
          field.descriptor,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    if (kind) {
      field.uiModel = refineUiModel(field, kind);
    }
    if (kind === "resume_file") {
      field.fileInput =
        container?.querySelector?.('input[type="file"]') ||
        document.querySelector('input[type="file"]') ||
        null;
    }
    if (kind === "phone_country_code" && !field.descriptor) {
      field.descriptor = "Country / Territory Phone Code";
    }
    if (
      looksLikeTechnicalSkillsField(field) &&
      !hasDirectRequiredSignal(el, container)
    ) {
      field.required = false;
    } else if (el.getAttribute?.("aria-required") === "false" && !el.required) {
      field.required = false;
    } else if (!field.required && container) {
      var requiredText = lower(
        [
          container.innerText,
          container.textContent,
          container.getAttribute?.("aria-required"),
          el.getAttribute?.("aria-required"),
        ]
          .filter(Boolean)
          .join(" "),
      );
      field.required =
        requiredText.includes("required") ||
        requiredText.includes("*") ||
        el.getAttribute?.("aria-required") === "true";
    }
    field.rect = root.audit?.rectSummary(el) || field.rect || {};
    return field;
  }

  function sectionNameForField(field) {
    var el = field.element || field.anchor;
    var own = lower(
      [
        field.fieldId,
        el?.id,
        el?.name,
        field.workday?.fieldLabel,
        field.descriptor,
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (
      own.includes("legal name") ||
      own.includes("preferred name") ||
      own.includes("first name") ||
      own.includes("last name")
    ) {
      return "Legal Name";
    }
    if (
      own.includes("address") ||
      own.includes("city") ||
      own.includes("province") ||
      own.includes("territory") ||
      own.includes("postal")
    ) {
      return "Address";
    }
    if (own.includes("email")) {
      return "Email Address";
    }
    if (own.includes("phone")) {
      return "Phone";
    }
    if (own.includes("source") || own.includes("how did you hear")) {
      return "Source";
    }
    var groupText = clean(el?.closest?.("[role='group']")?.innerText || "");
    return groupText.split(/\n/).map(clean).filter(Boolean)[0] || "Other";
  }

  function detectWorkdayStep() {
    var page = document.querySelector("[data-automation-id^='applyFlow']");
    var automationId = page?.getAttribute?.("data-automation-id") || "";
    var raw = automationId
      .replace(/^applyFlow/, "")
      .replace(/Page$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    var heading = Array.from(
      document.querySelectorAll("h1,h2,h3,[role='heading']"),
    )
      .map(function (el) {
        return clean(el.innerText || el.textContent || "");
      })
      .filter(Boolean)
      .find(function (text) {
        return !/^Junior AI Software Engineer$/i.test(text);
      });
    return clean(raw || heading || document.title || "Workday");
  }

  function describeWorkdayPage(fields) {
    var stepLabel = detectWorkdayStep();
    var sectionMap = new Map();
    (fields || []).forEach(function (field) {
      var sectionName = sectionNameForField(field);
      if (!sectionMap.has(sectionName)) {
        sectionMap.set(sectionName, {
          name: sectionName,
          fieldCount: 0,
          requiredCount: 0,
          fields: [],
        });
      }
      var section = sectionMap.get(sectionName);
      section.fieldCount += 1;
      if (field.required) {
        section.requiredCount += 1;
      }
      section.fields.push({
        fieldId: field.fieldId || "",
        label: field.workday?.fieldLabel || "",
        uiModel: field.uiModel || "",
        required: Boolean(field.required),
        workdayKind: field.workday?.kind || "",
        descriptor: clean(field.descriptor || "").slice(0, 240),
      });
    });
    return {
      kind: "workday",
      title: document.title || "",
      url: window.location.href,
      signature: clean(
        ["workday", stepLabel, window.location.pathname].join(" | "),
      ),
      stepLabel: stepLabel,
      sections: Array.from(sectionMap.values()),
      fieldCount: fields.length,
      requiredCount: fields.filter(function (field) {
        return field.required;
      }).length,
    };
  }

  function collectExtraWorkdayButtons(existing) {
    var seen = new Set(
      existing
        .map(function (field) {
          return field.element || field.anchor;
        })
        .filter(Boolean),
    );
    var extras = [];
    Array.from(
      document.querySelectorAll(
        [
          'button[aria-haspopup="listbox"]',
          'button[data-automation-id*="prompt"]',
          'button[data-automation-id*="select-files"]',
          'button[data-automation-id*="select"]',
          '[role="combobox"][aria-haspopup="listbox"]',
        ].join(", "),
      ),
    )
      .filter(visible)
      .forEach(function (el, index) {
        if (seen.has(el)) {
          return;
        }
        var descriptor = window.__huntApplyUtils?.getDescriptor
          ? window.__huntApplyUtils.getDescriptor(
              el,
              root.uiInspector?.containerSelectors || [],
            )
          : workdayContextText({ element: el, anchor: el, descriptor: "" });
        var kind = workdayWidgetKind({
          element: el,
          anchor: el,
          descriptor: descriptor || "",
        });
        extras.push(
          classify({
            kind: "element",
            element: el,
            anchor: el,
            fieldId: el.id || el.name || "workday_extra_" + index,
            descriptor: descriptor || "",
            questionHash: window.__huntApplyUtils?.buildQuestionHash
              ? window.__huntApplyUtils.buildQuestionHash(descriptor || "")
              : "workday_extra_" + index,
            uiModel:
              kind === "resume_file"
                ? "file"
                : el.tagName === "BUTTON"
                  ? "button_listbox"
                  : "combobox",
            required: root.uiInspector?.isRequired
              ? root.uiInspector.isRequired(el, descriptor)
              : false,
            rect: root.audit?.rectSummary(el) || {},
          }),
        );
      });
    return extras;
  }

  if (!root.uiInspector?.collectCandidates) {
    return;
  }
  if (!root.uiInspector._workdayBaseCollectCandidates) {
    root.uiInspector._workdayBaseCollectCandidates =
      root.uiInspector.collectCandidates;
  }

  root.uiInspector.collectCandidates = function collectWorkdayCandidates() {
    var base = root.uiInspector._workdayBaseCollectCandidates();
    var refined = base.map(classify);
    return refined
      .concat(collectExtraWorkdayButtons(refined))
      .filter(function (field, index, fields) {
        var el = field.element || field.anchor;
        if (!el) {
          return false;
        }
        return (
          fields.findIndex(function (candidate) {
            return (candidate.element || candidate.anchor) === el;
          }) === index
        );
      })
      .sort(function (a, b) {
        if (a.rect.top !== b.rect.top) {
          return a.rect.top - b.rect.top;
        }
        return a.rect.left - b.rect.left;
      });
  };

  root.workdayUi = {
    classify: classify,
    describePage: describeWorkdayPage,
    nearestWorkdayField: nearestWorkdayField,
    workdayContextText: workdayContextText,
  };
  root.uiInspector.describePage = describeWorkdayPage;
})();
