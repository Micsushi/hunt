(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisibleEnabled(el) {
    if (!el || el.disabled || el.getAttribute?.("aria-disabled") === "true") {
      return false;
    }
    var rect = el.getBoundingClientRect?.();
    var style = window.getComputedStyle?.(el);
    return Boolean(
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      style &&
      style.visibility !== "hidden" &&
      style.display !== "none",
    );
  }

  function controlLabel(el) {
    return normalizeText(
      [
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("title"),
        el.getAttribute?.("data-automation-id"),
        el.innerText,
        el.textContent,
        el.className?.baseVal || el.className,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function containsUploadText(text) {
    var normalized = normalizeText(text).toLowerCase();
    return (
      normalized.includes("upload") ||
      normalized.includes("drop files") ||
      normalized.includes("select files") ||
      normalized.includes("application documents") ||
      normalized.includes("supporting documents") ||
      normalized.includes("attachment") ||
      normalized.includes("resume") ||
      normalized.includes("cv") ||
      normalized.includes("cover letter") ||
      normalized.includes("successfully uploaded")
    );
  }

  function containsUploadedFileText(text) {
    var normalized = normalizeText(text).toLowerCase();
    return (
      normalized.includes("successfully uploaded") ||
      normalized.includes(".pdf") ||
      normalized.includes(".doc") ||
      normalized.includes(".docx") ||
      normalized.includes(".rtf") ||
      normalized.includes(".txt")
    );
  }

  function collectUploadedFileNodes() {
    return Array.from(document.querySelectorAll("body *"))
      .filter(isVisibleEnabled)
      .map(function (node) {
        return {
          text: normalizeText(node.innerText || node.textContent || ""),
          rect: node.getBoundingClientRect(),
        };
      })
      .filter(function (item) {
        return containsUploadedFileText(item.text);
      });
  }

  function nearestUploadedFileText(el, uploadedFileNodes) {
    var rect = el?.getBoundingClientRect?.();
    if (!rect) {
      return "";
    }
    return (
      (uploadedFileNodes || collectUploadedFileNodes())
        .filter(function (item) {
          var verticalDistance = Math.abs(
            item.rect.top + item.rect.height / 2 - (rect.top + rect.height / 2),
          );
          var horizontalDistance =
            item.rect.left > rect.right
              ? item.rect.left - rect.right
              : rect.left > item.rect.right
                ? rect.left - item.rect.right
                : 0;
          return verticalDistance <= 180 && horizontalDistance <= 1200;
        })
        .sort(function (a, b) {
          return (
            Math.abs(a.rect.top - rect.top) - Math.abs(b.rect.top - rect.top)
          );
        })[0]?.text || ""
    );
  }

  function uploadedFileContextFor(el) {
    var uploadedFileNodes = collectUploadedFileNodes();
    var parts = [
      controlLabel(el),
      nearestUploadedFileText(el, uploadedFileNodes),
    ];
    var node = el;
    var depth = 0;
    while (node && node !== document.body && depth < 8) {
      var nodeText = normalizeText(node.innerText || node.textContent || "");
      if (nodeText.length <= 1600 || containsUploadedFileText(nodeText)) {
        parts.push(nodeText);
      }
      parts.push(node.className?.baseVal || node.className);
      node = node.parentElement;
      depth += 1;
    }
    return normalizeText(parts.filter(Boolean).join(" "));
  }

  function isUploadedFileDeleteControl(el) {
    var label = controlLabel(el).toLowerCase();
    var removeAttachment = label.includes("remove attachment:");
    var looksLikeDelete =
      removeAttachment ||
      label.includes("trash") ||
      label.includes("delete") ||
      label.includes("remove") ||
      label.includes("clear") ||
      label === "x" ||
      label === "\u00d7" ||
      Boolean(
        el.querySelector?.("svg, [data-icon*='trash'], [class*='trash']"),
      );
    if (!looksLikeDelete) {
      return false;
    }
    var context = uploadedFileContextFor(el);
    return (
      removeAttachment ||
      (containsUploadText(context) && containsUploadedFileText(context))
    );
  }

  function clearControlTarget(el) {
    return (
      el.closest?.(
        "button, [role='button'], a, [aria-label], [title], [class*='clear'], [class*='remove'], [class*='delete'], [class*='trash']",
      ) || el
    );
  }

  function selectedControlContextFor(el) {
    return (
      el.closest?.(
        [
          "[role='combobox']",
          "[aria-haspopup='listbox']",
          "[aria-haspopup='grid']",
          ".select__container",
          ".custom-select",
          ".cx-select",
          "[class*='select']",
          "[class*='combo']",
          "[class*='dropdown']",
          "[class*='field']",
          "[class*='input']",
          "label",
          "fieldset",
        ].join(", "),
      ) || el.parentElement
    );
  }

  function isGenericClearIconControl(el) {
    var label = controlLabel(el).toLowerCase();
    var className = String(el.className?.baseVal || el.className || "")
      .toLowerCase()
      .replace(/[_-]/g, " ");
    var ariaOrTitle = normalizeText(
      [el.getAttribute?.("aria-label"), el.getAttribute?.("title")]
        .filter(Boolean)
        .join(" "),
    ).toLowerCase();
    var iconText = normalizeText(el.innerText || el.textContent || "");
    var isIconText = iconText === "x" || iconText === "\u00d7";
    var looksLikeClear =
      isIconText ||
      ariaOrTitle.includes("clear") ||
      ariaOrTitle.includes("remove") ||
      ariaOrTitle.includes("delete") ||
      ariaOrTitle.includes("trash") ||
      className.includes("clear") ||
      className.includes("remove") ||
      className.includes("delete") ||
      className.includes("trash") ||
      label === "x" ||
      label === "\u00d7" ||
      Boolean(
        el.querySelector?.("svg, [data-icon*='trash'], [class*='trash']"),
      );
    if (!looksLikeClear) {
      return false;
    }
    if (
      label.includes("cancel") ||
      label.includes("close window") ||
      label.includes("close dialog") ||
      label.includes("apply") ||
      label.includes("next") ||
      label.includes("submit")
    ) {
      return false;
    }
    var context = selectedControlContextFor(el);
    var contextText = normalizeText(
      context?.innerText || context?.textContent || "",
    );
    if (
      containsUploadedFileText(contextText) ||
      label.includes("remove attachment:")
    ) {
      return false;
    }
    var contextClass = String(
      context?.className?.baseVal || context?.className || "",
    )
      .toLowerCase()
      .replace(/[_-]/g, " ");
    return Boolean(
      context &&
      (containsUploadText(contextText) ||
        containsUploadedFileText(contextText) ||
        context.querySelector?.("input, textarea, select, [role='combobox']") ||
        context.matches?.(
          "[role='combobox'], [aria-haspopup='listbox'], [aria-haspopup='grid']",
        ) ||
        contextClass.includes("select") ||
        contextClass.includes("combo") ||
        contextClass.includes("dropdown") ||
        contextClass.includes("field") ||
        contextClass.includes("input")),
    );
  }

  async function clearGenericIconControls(audit) {
    var clearedControls = 0;
    var seen = new Set();
    var candidates = Array.from(
      document.querySelectorAll(
        [
          "button",
          "[role='button']",
          "a[aria-label]",
          "[aria-label]",
          "[title]",
          "[class*='clear']",
          "[class*='remove']",
          "[class*='delete']",
          "[class*='trash']",
          "svg",
        ].join(", "),
      ),
    )
      .map(clearControlTarget)
      .filter(function (candidate) {
        if (!candidate || seen.has(candidate)) {
          return false;
        }
        seen.add(candidate);
        return (
          isVisibleEnabled(candidate) && isGenericClearIconControl(candidate)
        );
      });

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var context = selectedControlContextFor(candidate);
      var beforeText = normalizeText(
        context?.innerText || context?.textContent || controlLabel(candidate),
      );
      root.fieldDrivers?.clickLikeUser?.(candidate);
      candidate.click?.();
      await sleep(180);
      await clickVisibleUploadConfirmButton();
      await sleep(220);
      var afterText = normalizeText(
        context?.innerText || context?.textContent || "",
      );
      if (!afterText || afterText !== beforeText) {
        clearedControls += 1;
        root.audit?.pushEvent?.(audit, {
          action: "generic_clear_icon_result",
          step: "clear.generic_icon",
          status: "ok",
          reason: "clear_icon_clicked",
          label: controlLabel(candidate).slice(0, 160),
          before: beforeText.slice(0, 240),
        });
      }
    }
    return clearedControls;
  }

  async function clickVisibleUploadConfirmButton() {
    var dialog = Array.from(
      document.querySelectorAll(
        [
          "[role='dialog']",
          "[aria-modal='true']",
          "[data-automation-id*='modal']",
          "[data-automation-id*='popup']",
          ".modal",
        ].join(", "),
      ),
    ).find(isVisibleEnabled);
    if (!dialog) {
      return false;
    }
    var confirm = Array.from(dialog.querySelectorAll('button, [role="button"]'))
      .filter(isVisibleEnabled)
      .find(function (button) {
        var text = controlLabel(button).toLowerCase();
        return (
          text === "delete" ||
          text === "remove" ||
          text === "yes" ||
          text === "ok" ||
          text === "confirm"
        );
      });
    if (!confirm) {
      return false;
    }
    root.fieldDrivers?.clickLikeUser?.(confirm);
    confirm.click?.();
    await sleep(180);
    return true;
  }

  async function clearUploadedFileControls(audit) {
    var clearedFiles = 0;
    var uploadedFileNodes = collectUploadedFileNodes();
    var candidates = Array.from(
      document.querySelectorAll(
        [
          "button",
          "[role='button']",
          "a[aria-label]",
          "[data-automation-id*='delete']",
          "[data-automation-id*='remove']",
          "[class*='delete']",
          "[class*='remove']",
          "[class*='trash']",
          ".attachment-upload-button__bottom-button",
        ].join(", "),
      ),
    )
      .filter(isVisibleEnabled)
      .filter(isUploadedFileDeleteControl);

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var beforeUploadedText = nearestUploadedFileText(
        candidate,
        uploadedFileNodes,
      );
      if (
        !beforeUploadedText &&
        !controlLabel(candidate).toLowerCase().includes("remove attachment:")
      ) {
        continue;
      }
      root.fieldDrivers?.clickLikeUser?.(candidate);
      candidate.click?.();
      await sleep(260);
      await clickVisibleUploadConfirmButton();
      await sleep(420);
      uploadedFileNodes = collectUploadedFileNodes();
      var afterUploadedText = nearestUploadedFileText(
        candidate,
        uploadedFileNodes,
      );
      if (!afterUploadedText || afterUploadedText !== beforeUploadedText) {
        clearedFiles += 1;
        root.audit?.pushEvent?.(audit, {
          action: "uploaded_file_clear_result",
          step: "clear.uploaded_file",
          status: "ok",
          reason: "uploaded_file_removed",
          label: controlLabel(candidate).slice(0, 160),
          before: beforeUploadedText.slice(0, 240),
        });
      }
    }
    return clearedFiles;
  }

  async function runHuntV2Clear(context) {
    var audit = root.audit.createRunAudit({
      fillRunId: context.fillRunId,
      atsType: context.atsType || "generic",
      mode: "clear",
    });
    var genericIconClears = await clearGenericIconControls(audit);
    await sleep(180);
    var fields = root.uiInspector.collectCandidates();
    var cleared = [];
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var fieldAudit = root.audit.createFieldAudit(audit, field);
      fieldAudit.beforeState = root.fieldState.readFieldState(field);
      var result = await root.fieldDrivers.clearField(field, audit, fieldAudit);
      fieldAudit.afterState =
        result.afterState || root.fieldState.readFieldState(field);
      fieldAudit.cleared = Boolean(result.ok);
      root.audit.pushFieldStep(audit, fieldAudit, {
        action: "field_clear_result",
        step: "driver.clear",
        status: result.ok ? "ok" : "warn",
        reason:
          result.reason || (result.ok ? "clear_verified" : "clear_failed"),
      });
      if (result.ok) {
        cleared.push({
          field: field.descriptor,
          questionHash: field.questionHash,
        });
      } else {
        root.audit.pushIssue(audit, fieldAudit, {
          kind: "field_clear_failed",
          severity: "warn",
          failedStep: "driver.clear",
          reason: result.reason || "clear_failed",
        });
      }
    }
    var uploadedFileClears = await clearUploadedFileControls(audit);
    await sleep(250);
    uploadedFileClears += await clearUploadedFileControls(audit);
    root.audit.complete(audit);
    return {
      ok: true,
      clearedFieldCount: cleared.length,
      clearedFields: cleared,
      genericIconClears: genericIconClears,
      uploadedFileClears: uploadedFileClears,
      v2Audit: audit,
    };
  }

  root.clearPipeline = {
    clearGenericIconControls: clearGenericIconControls,
    clearUploadedFileControls: clearUploadedFileControls,
    runHuntV2Clear: runHuntV2Clear,
  };
})();
