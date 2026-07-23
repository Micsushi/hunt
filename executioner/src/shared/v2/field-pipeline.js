(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});
  window.__huntC3Logs = [];
  function _huntLog(tag, data) {
    var entry = Object.assign({ _tag: tag, _ts: Date.now() }, data);
    window.__huntC3Logs.push(entry);
    console.log("[HUNT:C3] " + tag, data);
  }

  function optionsNeeded(field) {
    return [
      "select",
      "radio_group",
      "segmented_button_group",
      "checkbox",
      "combobox",
      "button_listbox",
    ].includes(field.uiModel);
  }

  function fieldFillTimeoutMs(context) {
    var raw = Number(context?.settings?.fieldFillTimeoutMs);
    if (Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    return 15000;
  }

  async function withTimeout(
    promise,
    timeoutMs,
    fallbackFactory,
    onTimeout,
    onUnwindTimeout,
    unwindTimeoutMs,
    onLateSettlement,
  ) {
    var observed = Promise.resolve(promise).then(
      function (value) {
        return { kind: "settled", value: value };
      },
      function (error) {
        return { kind: "rejected", error: error };
      },
    );
    var timer = null;
    var first = await Promise.race([
      observed,
      new Promise(function (resolve) {
        timer = setTimeout(function () {
          resolve({ kind: "timeout" });
        }, timeoutMs);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (first.kind === "settled") {
      return first.value;
    }
    if (first.kind === "rejected") {
      throw first.error;
    }
    if (typeof onTimeout === "function") {
      onTimeout();
    }
    var unwindTimer = null;
    var unwind = await Promise.race([
      observed,
      new Promise(function (resolve) {
        unwindTimer = setTimeout(
          function () {
            resolve({ kind: "unwind_timeout" });
          },
          Math.max(100, Number(unwindTimeoutMs || 2000)),
        );
      }),
    ]);
    if (unwindTimer) {
      clearTimeout(unwindTimer);
    }
    if (
      unwind.kind === "unwind_timeout" &&
      typeof onUnwindTimeout === "function"
    ) {
      onUnwindTimeout();
    }
    if (unwind.kind === "unwind_timeout") {
      // Cancellation guards quarantine any late completion. Do not let a driver
      // that ignores cancellation hold the background command worker forever.
      observed.then(function () {
        if (typeof onLateSettlement === "function") {
          onLateSettlement();
        }
      });
    }
    return fallbackFactory({
      unwound: unwind.kind !== "unwind_timeout",
      unwindTimedOut: unwind.kind === "unwind_timeout",
    });
  }

  function captureFieldMutationState(field) {
    var element = field?.element || field?.anchor;
    if (!element) {
      return null;
    }
    return {
      element: element,
      value: "value" in element ? element.value : undefined,
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      selectedIndex:
        "selectedIndex" in element ? Number(element.selectedIndex) : undefined,
      innerHTML: element.isContentEditable ? element.innerHTML : undefined,
    };
  }

  function restoreFieldMutationState(snapshot) {
    var element = snapshot?.element;
    if (!element?.isConnected) {
      return;
    }
    try {
      if (snapshot.value !== undefined && element.value !== snapshot.value) {
        element.value = snapshot.value;
      }
      if (snapshot.checked !== undefined) {
        element.checked = snapshot.checked;
      }
      if (snapshot.selectedIndex !== undefined) {
        element.selectedIndex = snapshot.selectedIndex;
      }
      if (snapshot.innerHTML !== undefined) {
        element.innerHTML = snapshot.innerHTML;
      }
    } catch (_error) {
      // Best-effort rollback complements the permanent cancellation guard.
    }
  }

  function inventoryEntry(field, fieldAudit) {
    var failedIssue = (fieldAudit.issues || [])
      .slice()
      .reverse()
      .find(function (issue) {
        return issue.kind === "field_fill_failed" && issue.reason;
      });
    return {
      kind: field.kind,
      tagName: field.element?.tagName || "",
      type: field.element?.type || "",
      name: field.element?.name || "",
      id: field.element?.id || "",
      descriptor: field.descriptor || "",
      questionHash: field.questionHash || "",
      questionType: fieldAudit.questionType || "",
      uiModel: fieldAudit.uiModel || field.uiModel || "",
      required: Boolean(field.required),
      filled: Boolean(fieldAudit.filled),
      skippedReason: fieldAudit.filled
        ? ""
        : fieldAudit.afterState?.reason || failedIssue?.reason || "",
      valueSource: fieldAudit.valueSource || "",
      bestEffortWarning: fieldAudit.issues
        .map(function (issue) {
          return issue.kind + ":" + issue.reason;
        })
        .join(" | ")
        .slice(0, 500),
      options: (field.options || []).map(function (option) {
        return option.label;
      }),
      rect: field.rect || {},
    };
  }

  function fieldIdentityKey(field) {
    var stableElementId =
      field.element?.id ||
      field.element?.name ||
      field.element?.getAttribute?.("data-automation-id") ||
      "";
    var fieldId = field.fieldId || "";
    if (/^segmented_button_group_\d+$/.test(fieldId)) {
      fieldId = "";
    }
    return [
      fieldId,
      field.name || "",
      field.element?.id || "",
      field.element?.name || "",
      field.element?.getAttribute?.("data-automation-id") || "",
      field.selectorPath || "",
      stableElementId ? "" : field.questionHash || field.descriptor || "",
      field.uiModel || "",
    ]
      .filter(Boolean)
      .join("|");
  }

  function shouldSkipPasswordField(field, context) {
    if (field.element?.type !== "password") {
      return false;
    }
    var settings = context.settings || {};
    var profile = context.profile || {};
    var descriptor = String(field.descriptor || "").toLowerCase();
    var canUseAccountPassword =
      settings.autoAccountSignupLoginEnabled === true &&
      Boolean(profile.accountPassword) &&
      descriptor.includes("password") &&
      ![
        "current password",
        "old password",
        "existing password",
        "temporary password",
      ].some(function (term) {
        return descriptor.includes(term);
      });
    return !canUseAccountPassword;
  }

  function hasValidationState(field) {
    var el = field.element || field.anchor;
    if (!el) {
      return false;
    }
    if (el.getAttribute?.("aria-invalid") === "true") {
      return true;
    }
    var describedBy = String(el.getAttribute?.("aria-describedby") || "");
    if (
      describedBy &&
      describedBy.split(/\s+/).some(function (id) {
        var node = id ? document.getElementById(id) : null;
        return /error|required|invalid/i.test(
          String(node?.innerText || node?.textContent || ""),
        );
      })
    ) {
      return true;
    }
    var container = el.closest?.(
      [
        '[data-automation-id^="formField"]',
        ".application-field",
        ".application-question",
        ".input-row",
        "fieldset",
        "label",
      ].join(","),
    );
    if (
      !container ||
      !container.querySelector?.(
        '[aria-invalid="true"], [data-automation-id="inputAlert"]',
      )
    ) {
      return false;
    }
    var containerText = normalizedTokens(
      String(container.innerText || container.textContent || ""),
    );
    if (!/error|required|invalid/.test(containerText)) {
      return false;
    }
    var signals = [
      field.fieldId,
      field.name,
      field.descriptor,
      field.workday?.fieldLabel,
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("data-automation-id"),
    ]
      .filter(Boolean)
      .map(normalizedTokens)
      .filter(Boolean);
    return signals.some(function (signal) {
      return (
        signal.length >= 4 &&
        (containerText.includes(signal) || signal.includes(containerText))
      );
    });
  }

  function isResumeFileField(field) {
    if (field.uiModel !== "file") {
      return false;
    }
    var descriptor = String(field.descriptor || "").toLowerCase();
    return (
      (descriptor.includes("resume") || descriptor.includes("cv")) &&
      !descriptor.includes("cover letter")
    );
  }

  function normalizedTokens(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function repairFieldSignals(field) {
    var el = field.element || field.anchor;
    return [
      field.fieldId,
      field.name,
      field.descriptor,
      field.workday?.fieldLabel,
      field.questionType,
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("data-automation-id"),
    ]
      .filter(Boolean)
      .map(normalizedTokens)
      .filter(Boolean);
  }

  function normalizedRepairErrors(context) {
    return (
      Array.isArray(context.repairVisibleValidationErrors)
        ? context.repairVisibleValidationErrors
        : []
    )
      .map(function (error) {
        return normalizedTokens(
          typeof error === "string"
            ? error
            : [
                error.field,
                error.label,
                error.message,
                error.text,
                error.summary,
              ]
                .filter(Boolean)
                .join(" "),
        );
      })
      .filter(Boolean);
  }

  function fieldMatchesRepairError(field, context) {
    var errors = normalizedRepairErrors(context);
    if (!errors.length) {
      return true;
    }
    if (hasValidationState(field)) {
      return true;
    }
    var signals = repairFieldSignals(field);
    return errors.some(function (text) {
      return signals.some(function (signal) {
        return (
          signal.length >= 4 && (text.includes(signal) || signal.includes(text))
        );
      });
    });
  }

  function shouldFillOptionalProfileCorrection(field, context) {
    var profile = context.profile || {};
    var el = field.element || field.anchor;
    var signal = [
      field.fieldId,
      field.name,
      field.descriptor,
      field.workday?.fieldLabel,
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
    ]
      .join(" ")
      .toLowerCase();
    if (
      signal.includes("desired start date") ||
      signal.includes("available start date") ||
      signal.includes("available to start") ||
      signal.includes("earliest date") ||
      signal.includes("desired pay") ||
      signal.includes("desired salary") ||
      signal.includes("salary expectation") ||
      signal.includes("previously worked") ||
      signal.includes("previously employed")
    ) {
      return true;
    }
    if (!profile.country) {
      return false;
    }
    return (
      signal.includes("address--countryregion") ||
      signal.includes("country region")
    );
  }

  function authCheckboxSignal(field) {
    var el = field.element || field.anchor;
    return [
      field.fieldId,
      field.name,
      field.descriptor,
      field.workday?.fieldLabel,
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("data-automation-id"),
      el?.closest?.("label")?.innerText,
      el?.closest?.("[data-automation-id], section, div")?.innerText,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function shouldFillAuthConsentCheckbox(field) {
    if (field.uiModel !== "checkbox") {
      return false;
    }
    var body = String(document.body?.innerText || "").toLowerCase();
    var isAuthPage =
      /create account|sign in|log in|login|register|already have an account|don't have an account/.test(
        body,
      ) ||
      /\/login(?:\?|$)|\/apply\/applymanually/i.test(
        String(window.location?.href || ""),
      );
    if (!isAuthPage) {
      return false;
    }
    var signal = authCheckboxSignal(field);
    if (/do not|decline|unsubscribe|opt out|do not contact/i.test(signal)) {
      return false;
    }
    var looksLikeConsent =
      /privacy|terms|condition|consent|agree|acknowledg|candidate|create account|check the box|createaccountcheckbox/i.test(
        signal,
      );
    var visibleCheckboxes = Array.from(
      document.querySelectorAll('input[type="checkbox"]'),
    ).filter(function (checkbox) {
      if (!checkbox || typeof checkbox.getBoundingClientRect !== "function") {
        return false;
      }
      var rect = checkbox.getBoundingClientRect();
      var style = window.getComputedStyle(checkbox);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    return (
      visibleCheckboxes.includes(field.element) &&
      (looksLikeConsent || visibleCheckboxes.length === 1)
    );
  }

  function authConsentQuestion() {
    var entry = (root.fieldCatalog?.entries || []).find(function (candidate) {
      return candidate.id === "terms_acceptance";
    });
    if (!entry) {
      return null;
    }
    return {
      type: entry.id,
      entry: entry,
      source: "auth_checkbox",
      confidence: 0.94,
    };
  }

  function fillCancelled(context) {
    var fillRunId = context.fillRunId || "";
    var cancelledIds = Array.isArray(window.__huntApplyCancelledFillRunIds)
      ? window.__huntApplyCancelledFillRunIds
      : [];
    return Boolean(
      window.__huntApplyCancelAllFills ||
      (fillRunId && window.__huntApplyCancelFillRunId === fillRunId) ||
      (fillRunId &&
        window.__huntApplyActiveFillRunId &&
        window.__huntApplyActiveFillRunId !== fillRunId) ||
      (fillRunId && cancelledIds.includes(fillRunId)),
    );
  }

  function isPostSubmitSignatureRisk(field) {
    var descriptor = String(field?.descriptor || "").toLowerCase();
    var name = String(field?.element?.name || field?.element?.id || "")
      .toLowerCase()
      .replace(/[_-]/g, " ");
    var looksLikeSignature =
      descriptor.includes("e-signature") ||
      descriptor.includes("signature") ||
      name.includes("full name") ||
      name.includes("fullname");
    if (!looksLikeSignature) {
      return false;
    }
    var body = String(document.body?.innerText || "").toLowerCase();
    var hasSubmitValidationBanner =
      body.includes("before submitting your job application") ||
      body.includes("need to add or modify") ||
      body.includes("issues that need to be fixed");
    if (!hasSubmitValidationBanner) {
      return false;
    }
    return Array.from(
      document.querySelectorAll(
        "button, [role='button'], input[type='submit']",
      ),
    ).some(function (button) {
      var text = String(
        button.innerText || button.textContent || button.value || "",
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      var rect = button.getBoundingClientRect?.();
      return text === "submit" && rect && rect.width > 0 && rect.height > 0;
    });
  }

  function isConditionalYesFollowupText(field) {
    if (field.required) {
      return false;
    }
    if (!["text", "textarea"].includes(field.uiModel)) {
      return false;
    }
    var el = field.element || field.anchor;
    var signal = [
      field.fieldId,
      field.name,
      field.descriptor,
      field.workday?.fieldLabel,
      el?.id,
      el?.name,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("placeholder"),
    ]
      .join(" ")
      .toLowerCase();
    return (
      /\bif\s+yes\b/.test(signal) ||
      /\bif\s+you\s+answered\s+yes\b/.test(signal) ||
      /\bplease\s+explain\s+.*\byes\b/.test(signal)
    );
  }

  function emitSiteAction(context, payload) {
    try {
      if (
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        !chrome.runtime.sendMessage
      ) {
        return;
      }
      chrome.runtime.sendMessage({
        type: "hunt.apply.site_action_log",
        payload: {
          fillRunId: context.fillRunId || "",
          ...payload,
        },
      });
    } catch (_error) {
      // Best-effort live logging only. The returned V2 audit remains primary.
    }
  }

  function createFieldActionGuard(context, field) {
    var active = true;
    var stopReason = "";
    var terminalClaimed = false;
    function cancelRun(reason) {
      var runReason = String(reason || stopReason || "operation_cancelled");
      var fillRunId = context?.fillRunId || "";
      if (!fillRunId) {
        return;
      }
      var cancelledIds = Array.isArray(window.__huntApplyCancelledFillRunIds)
        ? window.__huntApplyCancelledFillRunIds
        : [];
      if (!cancelledIds.includes(fillRunId)) {
        cancelledIds.push(fillRunId);
      }
      window.__huntApplyCancelledFillRunIds = cancelledIds.slice(-25);
      window.__huntApplyCancelFillRunId = fillRunId;
      window.__huntApplyFillCancelReasons = Object.assign(
        {},
        window.__huntApplyFillCancelReasons || {},
        { [fillRunId]: runReason },
      );
      try {
        chrome?.runtime?.sendMessage?.({
          type: "hunt.apply.cancel_fill",
          payload: { fillRunId: fillRunId, reason: runReason },
        });
      } catch (_error) {
        // The page-side flag still prevents subsequent mutations.
      }
    }
    return {
      canMutate: function () {
        return active && !fillCancelled(context || {});
      },
      cancel: function (reason) {
        active = false;
        if (!stopReason) {
          stopReason = String(reason || "operation_cancelled");
        }
      },
      cancelRun: cancelRun,
      claimTerminal: function () {
        if (terminalClaimed) {
          return false;
        }
        terminalClaimed = true;
        return true;
      },
      terminalClaimed: function () {
        return terminalClaimed;
      },
      operationId:
        context?.operationId ||
        context?.operation_id ||
        context?.commandContext?.operationId ||
        context?.commandContext?.operation_id ||
        "",
      fillRunId: context?.fillRunId || "",
      reason: function () {
        if (stopReason) {
          return stopReason;
        }
        return fillCancelled(context || {})
          ? fillCancellationReason(context || {})
          : "";
      },
      fieldId: field?.fieldId || "",
    };
  }

  function structuredFieldTracePayload(audit, field, extra) {
    var el = field?.element || field?.anchor;
    return Object.assign(
      {
        operationId: audit?.operationId || "",
        runId: audit?.runId || "",
        fieldId: field?.fieldId || "",
        label: String(
          field?.descriptor || el?.getAttribute?.("aria-label") || "",
        ).slice(0, 240),
        kind:
          field?.workday?.kind || field?.uiModel || field?.kind || "unknown",
        required: Boolean(field?.required),
        attempt: 1,
        driver: field?.workday?.kind ? "workday-v2" : "field-driver-v2",
        action: "fill",
        elapsedMs: 0,
        reasonCode: "trace_checkpoint",
      },
      extra || {},
    );
  }

  function fillCancellationReason(context) {
    var fillRunId = context.fillRunId || "";
    var reasons = window.__huntApplyFillCancelReasons || {};
    return String(
      (fillRunId && reasons[fillRunId]) ||
        window.__huntApplyCancelReason ||
        "user_cancelled",
    );
  }

  function emitStructuredFieldTrace(audit, eventType, field, extra) {
    return root.audit.emitEvent(
      audit,
      eventType,
      structuredFieldTracePayload(audit, field, extra),
    );
  }

  function cancelledResult(
    context,
    audit,
    filledFields,
    fieldInventory,
    generatedAnswers,
  ) {
    var cancellationReason = fillCancellationReason(context);
    root.audit.pushEvent(audit, {
      action: "v2_fill_cancelled",
      step: "run.cancel",
      status: "warn",
      reason: cancellationReason,
      detail: {
        fillRunId: context.fillRunId || "",
        activeFillRunId: window.__huntApplyActiveFillRunId || "",
      },
    });
    root.audit.complete(audit);
    return {
      ok: false,
      cancelled: true,
      reason: cancellationReason,
      message: "Fill canceled.",
      atsType: context.atsType || context.fillRoute?.adapterName || "generic",
      adapterBackedByGeneric:
        context.fillRoute?.adapterBackedByGeneric || false,
      frameUrl: window.location.href,
      authState: window.__huntApplyUtils?.detectAuthState
        ? window.__huntApplyUtils.detectAuthState()
        : "unknown",
      filledFieldCount: filledFields.length,
      generatedAnswerCount: generatedAnswers.length,
      manualReviewRequired: true,
      manualReviewReasons: [cancellationReason],
      bestEffortWarnings: audit.permanentIssues.map(function (issue) {
        return issue.kind + ":" + issue.reason;
      }),
      filledFields: filledFields,
      fieldInventory: fieldInventory,
      generatedAnswers: generatedAnswers,
      htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000),
      interactionTrace: audit.events,
      traceTruncated: Boolean(audit.traceTruncated),
      v2Audit: audit,
    };
  }

  async function runField({
    field,
    profile,
    settings,
    audit,
    activeApplyContext,
    defaultResume,
    fillRunId,
    actionGuard,
  }) {
    var traceStartedAt = Date.now();
    var fieldAudit = root.audit.createFieldAudit(audit, field);
    fieldAudit.beforeState = root.fieldState.readFieldState(field);
    emitStructuredFieldTrace(audit, "field.attempt.started", field, {
      reasonCode: "field_attempt_started",
    });
    emitStructuredFieldTrace(audit, "field.action.started", field, {
      reasonCode: "field_action_started",
    });
    root.audit.pushFieldStep(audit, fieldAudit, {
      action: "field_start",
      step: "field.start",
      status: "info",
      uiModel: field.uiModel,
      element: root.audit.summarizeElement(field.element || field.anchor),
    });
    root.audit.emitEvent(
      audit,
      "field.focus",
      root.audit.fieldPayload(field, {
        status: "info",
        reason: "field_processing_started",
      }),
    );
    if (hasValidationState(field)) {
      root.audit.emitEvent(
        audit,
        "validation.visible",
        root.audit.fieldPayload(field, {
          status: "warn",
          reason: "validation_visible_before_fill",
        }),
      );
    }
    root.audit.pushFieldStep(audit, fieldAudit, {
      action: "site_state_before_field",
      step: "site.before_field",
      status: "info",
      reason: "before_field_action",
      detail: root.audit.siteState({
        fieldId: field.fieldId || "",
        descriptor: String(field.descriptor || "").slice(0, 240),
      }),
    });
    emitSiteAction(
      { fillRunId: fillRunId || "" },
      {
        action: "site_state_before_field",
        status: "info",
        reason: "before_field_action",
        fieldId: field.fieldId || "",
        descriptor: String(field.descriptor || "").slice(0, 240),
        uiModel: field.uiModel || "",
        siteState: root.audit.siteState(),
      },
    );

    var authConsentCheckbox = shouldFillAuthConsentCheckbox(field);
    var question = root.questionIdentifier.identifyQuestion(
      field,
      audit,
      fieldAudit,
    );
    if (question.type === "unknown" && authConsentCheckbox) {
      var consentQuestion = authConsentQuestion();
      if (consentQuestion) {
        question = consentQuestion;
        root.audit.pushFieldStep(audit, fieldAudit, {
          action: "question_identified",
          step: "question.auth_checkbox",
          status: "ok",
          questionType: question.type,
          reason: "auth_page_checkbox_consent",
        });
      }
    }
    fieldAudit.questionType = question.type;
    if (question.type === "unknown") {
      root.audit.pushIssue(audit, fieldAudit, {
        kind: field.required
          ? "unknown_question_defaulted"
          : "unknown_question_defaulted",
        severity: field.required ? "warn" : "info",
        failedStep: "question.identify",
        reason: field.required
          ? "C3 did not recognize this required question and will use progress-first fallback if the UI is usable."
          : "C3 did not recognize this optional question. Add a catalog entry or profile mapping before trusting any automatic answer.",
        questionType: "unknown",
      });
    }
    var resolverProfile = {
      ...(profile || {}),
      applicationCompany:
        activeApplyContext?.company || activeApplyContext?.companyName || "",
      applicationPosition:
        activeApplyContext?.title ||
        activeApplyContext?.jobTitle ||
        activeApplyContext?.position ||
        "",
    };
    var answer = root.answerResolver.resolveAnswer({
      question: question,
      field: field,
      profile: resolverProfile,
      audit: audit,
      fieldAudit: fieldAudit,
    });
    fieldAudit.valueSource = answer.source || "";
    fieldAudit.answerPreview = String(answer.value ?? "").slice(0, 160);
    root.audit.pushFieldStep(audit, fieldAudit, {
      action: "answer_resolved",
      step: "answer.resolve",
      status: answer.value || answer.needsGeneratedText ? "ok" : "warn",
      valueSource: answer.source,
      reason: answer.value ? "answer_available" : "missing_answer",
      detail: {
        answerType: answer.answerType,
        confidence: answer.confidence,
        answerPreview: fieldAudit.answerPreview,
      },
    });
    root.audit.emitEvent(
      audit,
      "field.answer.resolved",
      root.audit.fieldPayload(field, {
        status: answer.value || answer.needsGeneratedText ? "ok" : "warn",
        reason: answer.value ? "answer_available" : "missing_answer",
        valueSource: answer.source || "",
        payload: {
          answerType: answer.answerType || "",
          confidence: answer.confidence || "",
          answer: root.audit.valueSummary(answer.value ?? ""),
          needsGeneratedText: Boolean(answer.needsGeneratedText),
        },
      }),
    );

    var option = null;
    if (optionsNeeded(field)) {
      field.options = await root.optionCollector.collectOptions(field, {
        answer: answer,
        audit: audit,
        fieldAudit: fieldAudit,
        actionGuard: actionGuard,
      });
      root.audit.pushFieldStep(audit, fieldAudit, {
        action: "options_collected",
        step: "option.collect",
        status: field.options.length ? "ok" : "warn",
        reason: field.options.length ? "options_available" : "no_options",
        detail: {
          optionCount: field.options.length,
          options: field.options.map(function (candidate) {
            return candidate.label;
          }),
        },
      });
      var match = root.optionMatcher.matchOption({
        options: field.options,
        answer: answer,
        audit: audit,
        fieldAudit: fieldAudit,
        field: field,
      });
      option = match.option;
      fieldAudit.selectedOption = option?.label || "";
      if (
        question.type === "unknown" &&
        option &&
        !String(fieldAudit.answerPreview || "").trim()
      ) {
        fieldAudit.answerPreview = option.label || option.value || "";
      }
      fieldAudit.valueSource = match.fallback
        ? "fallback:" + match.source
        : answer.source || match.source;
      fieldAudit.noOptionReason = option ? "" : match.source;
      root.audit.pushFieldStep(audit, fieldAudit, {
        action: "option_resolved",
        step: "option.match",
        status: option ? "ok" : "warn",
        selectedOption: option?.label || "",
        valueSource: fieldAudit.valueSource,
        reason: match.source,
      });
      var quietOptionalCheckboxNoOption =
        !field.required &&
        field.uiModel === "checkbox" &&
        [
          "checkbox_no_safe_match",
          "no_options",
          "missing_profile_value",
        ].includes(match.source);
      var quietCommittedButtonNoOption =
        ["button_listbox", "combobox"].includes(field.uiModel) &&
        !option &&
        fieldAudit.beforeState?.selected &&
        String(answer.source || "").startsWith("profile:");
      if (
        !option &&
        match.source !== "hierarchical_workday_deferred" &&
        !quietOptionalCheckboxNoOption &&
        !quietCommittedButtonNoOption
      ) {
        root.audit.pushIssue(audit, fieldAudit, {
          kind: "unsupported_or_empty_option_set",
          severity: field.required ? "warn" : "info",
          failedStep: "option.match",
          reason: "No selectable option was available.",
        });
      }
    }

    _huntLog("field_decision", {
      descriptor: String(field.descriptor || "").slice(0, 120),
      fieldId: field.fieldId || "",
      uiModel: field.uiModel || "",
      workdayKind: field.workday?.kind || "",
      answerValue: String(answer.value ?? "").slice(0, 80),
      optionLabel: option?.label || null,
      optionsCount: (field.options || []).length,
      siteError: Boolean(root.audit?.siteState?.()?.workdayRuntimeError),
    });

    if (
      optionsNeeded(field) &&
      !option &&
      !(
        field.workday?.kind &&
        ["combobox", "button_listbox"].includes(field.uiModel)
      )
    ) {
      _huntLog("field_skipped_no_option", {
        descriptor: String(field.descriptor || "").slice(0, 120),
        uiModel: field.uiModel || "",
        workdayKind: field.workday?.kind || "",
      });
      fieldAudit.afterState = {
        ...root.fieldState.readFieldState(field),
        reason: fieldAudit.noOptionReason || "no_matching_option",
      };
      if (actionGuard?.terminalClaimed?.()) {
        return {
          filled: false,
          fieldAudit: fieldAudit,
          terminalSuppressed: true,
        };
      }
      actionGuard?.claimTerminal?.();
      var noOptionElapsedMs = Math.max(0, Date.now() - traceStartedAt);
      var noOptionReason = fieldAudit.noOptionReason || "no_matching_option";
      emitStructuredFieldTrace(audit, "field.commit.checked", field, {
        elapsedMs: noOptionElapsedMs,
        clicked: false,
        committed: false,
        reasonCode: noOptionReason,
      });
      emitStructuredFieldTrace(audit, "field.action.failed", field, {
        elapsedMs: noOptionElapsedMs,
        committed: false,
        reasonCode: noOptionReason,
      });
      return { filled: false, fieldAudit: fieldAudit };
    }

    var fillResult = await root.fieldDrivers.fillField({
      field: field,
      answer: answer,
      option: option,
      audit: audit,
      fieldAudit: fieldAudit,
      activeApplyContext: activeApplyContext || {},
      defaultResume: defaultResume || {},
      actionGuard: actionGuard,
    });
    if (actionGuard?.terminalClaimed?.()) {
      fieldAudit.afterState =
        fillResult.afterState || root.fieldState.readFieldState(field);
      fieldAudit.filled = false;
      return {
        filled: false,
        fieldAudit: fieldAudit,
        terminalSuppressed: true,
      };
    }
    actionGuard?.claimTerminal?.();
    fieldAudit.afterState =
      fillResult.afterState || root.fieldState.readFieldState(field);
    var actionStillCurrent = actionGuard?.canMutate?.() !== false;
    fieldAudit.filled = Boolean(fillResult.ok && actionStillCurrent);
    if (fillResult.valueSource) {
      fieldAudit.valueSource = fillResult.valueSource;
    }
    if (fillResult.answerText) {
      fieldAudit.answerPreview = String(fillResult.answerText).slice(0, 160);
    }
    var traceElapsedMs = Math.max(0, Date.now() - traceStartedAt);
    emitStructuredFieldTrace(audit, "field.commit.checked", field, {
      elapsedMs: traceElapsedMs,
      clicked: Boolean(fillResult.clicked),
      committed: Boolean(fillResult.ok && actionStillCurrent),
      reasonCode:
        fillResult.reason ||
        (fillResult.ok ? "commit_verified" : "commit_not_verified"),
    });
    var terminalTraceType =
      fillResult.ok && actionStillCurrent
        ? "field.action.completed"
        : fillResult.cancelled ||
            actionGuard?.canMutate?.() === false ||
            fillResult.reason === "operation_cancelled"
          ? "field.action.cancelled"
          : "field.action.failed";
    emitStructuredFieldTrace(audit, terminalTraceType, field, {
      elapsedMs: traceElapsedMs,
      committed: Boolean(fillResult.ok && actionStillCurrent),
      reasonCode:
        fillResult.reason ||
        (fillResult.ok ? "field_action_completed" : "field_action_failed"),
    });
    root.audit.pushFieldStep(audit, fieldAudit, {
      action: "field_fill_result",
      step: "driver.fill",
      status: fillResult.ok ? "ok" : "warn",
      reason:
        fillResult.reason ||
        (fillResult.ok ? "commit_verified" : "commit_failed"),
      selectedOption: fieldAudit.selectedOption,
      valueSource: fieldAudit.valueSource,
      detail: {
        afterText: fieldAudit.afterState.text,
        afterRawValue: fieldAudit.afterState.rawValue,
      },
    });
    if (!fillResult.ok) {
      root.audit.pushIssue(audit, fieldAudit, {
        kind: "field_fill_failed",
        severity: field.required ? "warn" : "info",
        failedStep: "driver.fill",
        reason: fillResult.reason || "commit_failed",
      });
    }
    root.audit.emitEvent(
      audit,
      "value.saved",
      root.audit.fieldPayload(field, {
        status: fillResult.ok ? "ok" : "warn",
        reason:
          fillResult.reason ||
          (fillResult.ok ? "commit_verified" : "commit_failed"),
        selectedOption:
          fieldAudit.selectedOption || fillResult.selectedOption || "",
        valueSource: fieldAudit.valueSource || "",
        payload: {
          afterState: {
            selected: Boolean(fieldAudit.afterState.selected),
            checked: Boolean(fieldAudit.afterState.checked),
            text: root.audit.valueSummary(fieldAudit.afterState.text || ""),
            rawValue: root.audit.valueSummary(
              fieldAudit.afterState.rawValue || "",
            ),
          },
        },
      }),
    );
    if (hasValidationState(field)) {
      root.audit.emitEvent(
        audit,
        "validation.visible",
        root.audit.fieldPayload(field, {
          status: "warn",
          reason: "validation_visible_after_fill",
        }),
      );
    } else if (fillResult.ok) {
      root.audit.emitEvent(
        audit,
        "validation.cleared",
        root.audit.fieldPayload(field, {
          status: "ok",
          reason: "no_validation_after_fill",
        }),
      );
    }
    var _siteAfter = root.audit.siteState();
    _huntLog("field_done", {
      descriptor: String(field.descriptor || "").slice(0, 120),
      uiModel: field.uiModel || "",
      workdayKind: field.workday?.kind || "",
      fillOk: Boolean(fillResult.ok),
      fillReason: fillResult.reason || "",
      siteError: Boolean(_siteAfter.workdayRuntimeError),
    });
    root.audit.pushFieldStep(audit, fieldAudit, {
      action: "site_state_after_field",
      step: "site.after_field",
      status: _siteAfter.workdayRuntimeError ? "error" : "info",
      reason: "after_field_action",
      detail: root.audit.siteState({
        fieldId: field.fieldId || "",
        descriptor: String(field.descriptor || "").slice(0, 240),
        filled: Boolean(fillResult.ok),
        fillReason: fillResult.reason || "",
        afterText: fieldAudit.afterState.text || "",
        afterRawValue: fieldAudit.afterState.rawValue || "",
      }),
    });
    emitSiteAction(
      { fillRunId: fillRunId || "" },
      {
        action: "site_state_after_field",
        status: root.audit.siteState().workdayRuntimeError ? "blocked" : "info",
        reason: "after_field_action",
        fieldId: field.fieldId || "",
        descriptor: String(field.descriptor || "").slice(0, 240),
        uiModel: field.uiModel || "",
        filled: Boolean(fillResult.ok),
        fillReason: fillResult.reason || "",
        afterText: fieldAudit.afterState.text || "",
        afterRawValue: fieldAudit.afterState.rawValue || "",
        siteState: root.audit.siteState(),
      },
    );
    return { filled: fieldAudit.filled, fieldAudit: fieldAudit };
  }

  async function runHuntV2Fill(context) {
    var audit = root.audit.createRunAudit({
      fillRunId: context.fillRunId,
      atsType: context.atsType || context.fillRoute?.adapterName || "generic",
      mode: "fill",
      settings: context.settings || {},
      commandContext: context.commandContext || context.ledgerContext || null,
      ledgerContext: context.ledgerContext || null,
      actor: context.actor || null,
      eventSink: context.eventSink || context.auditEventSink || null,
    });
    audit.operationId =
      context.operation_id ||
      context.operationId ||
      context.commandContext?.operation_id ||
      context.commandContext?.operationId ||
      context.ledgerContext?.operation_id ||
      context.ledgerContext?.operationId ||
      "";
    root.audit.pushEvent(audit, {
      action: "v2_fill_start",
      step: "run.start",
      status: "info",
      reason: "field_pipeline_v2",
      detail: {
        href: window.location.href,
        fillRunId: context.fillRunId || "",
      },
    });

    var fields = root.uiInspector.sortActionableFields
      ? root.uiInspector.sortActionableFields(
          root.uiInspector.collectCandidates(),
        )
      : root.uiInspector.collectCandidates();
    fields.forEach(function (field) {
      emitStructuredFieldTrace(audit, "field.discovered", field, {
        reasonCode: "field_discovered",
      });
    });
    root.audit.emitEvent(audit, "field.inventory", {
      status: "info",
      reason: "initial_field_inventory",
      fieldCount: fields.length,
      frameId: window.__huntFrameId || "",
      fields: fields.slice(0, 120).map(function (field) {
        return {
          fieldId: field.fieldId || "",
          questionHash: field.questionHash || "",
          uiModel: field.uiModel || "",
          required: Boolean(field.required),
          descriptor: String(field.descriptor || "").slice(0, 160),
          workdayKind: field.workday?.kind || "",
        };
      }),
    });
    audit.page = root.uiInspector.describePage
      ? root.uiInspector.describePage(fields)
      : {};
    root.audit.pushEvent(audit, {
      action: "page_profiled",
      step: "page.profile",
      status: "info",
      reason: audit.page?.signature || "page_signature_unavailable",
      detail: audit.page || {},
    });
    var filledFields = [];
    var fieldInventory = [];
    var generatedAnswers = [];
    var processedQuestionHashes = new Set();
    var processedFieldKeys = new Set();
    if (normalizedRepairErrors(context).length || context.repairMode) {
      root.audit.emitEvent(audit, "repair.started", {
        status: "info",
        reason: "repair_context_present",
        visibleValidationErrorCount: normalizedRepairErrors(context).length,
      });
    }
    if (fillCancelled(context)) {
      return cancelledResult(
        context,
        audit,
        filledFields,
        fieldInventory,
        generatedAnswers,
      );
    }
    for (var pass = 1; pass <= 3; pass++) {
      var passFilledCount = 0;
      root.audit.emitEvent(audit, "repair.loop", {
        status: "info",
        reason: pass === 1 ? "initial_pass" : "conditional_or_repair_pass",
        pass: pass,
        fieldCount: fields.length,
      });
      if (pass > 1) {
        fields = root.uiInspector.sortActionableFields
          ? root.uiInspector.sortActionableFields(
              root.uiInspector.collectCandidates(),
            )
          : root.uiInspector.collectCandidates();
        root.audit.pushEvent(audit, {
          action: "page_rescanned",
          step: "page.rescan",
          status: "info",
          reason: "conditional_fields_check",
          detail: {
            pass: pass,
            fieldCount: fields.length,
            pendingCount: fields.filter(function (field) {
              return (
                field.required &&
                !processedFieldKeys.has(fieldIdentityKey(field))
              );
            }).length,
          },
        });
      }
      for (var i = 0; i < fields.length; i++) {
        if (fillCancelled(context)) {
          return cancelledResult(
            context,
            audit,
            filledFields,
            fieldInventory,
            generatedAnswers,
          );
        }
        var field = fields[i];
        var fieldKey = fieldIdentityKey(field);
        if (fieldKey && processedFieldKeys.has(fieldKey)) {
          root.audit.pushEvent(audit, {
            action: "field_skipped",
            step: "field.identity_filter",
            status: "info",
            reason: "already_processed_field_identity",
            fieldId: field.fieldId,
            questionHash: field.questionHash,
            uiModel: field.uiModel,
          });
          continue;
        }
        if (
          context.settings?.fillRequiredOnly !== false &&
          !field.required &&
          !isResumeFileField(field) &&
          !hasValidationState(field) &&
          !shouldFillOptionalProfileCorrection(field, context) &&
          !shouldFillAuthConsentCheckbox(field)
        ) {
          var fieldAudit = root.audit.createFieldAudit(audit, field);
          fieldAudit.beforeState = root.fieldState.readFieldState(field);
          fieldAudit.afterState = {
            ...root.fieldState.readFieldState(field),
            reason: "not_required",
          };
          fieldAudit.filled = false;
          fieldAudit.valueSource = "skipped:not_required";
          root.audit.pushFieldStep(audit, fieldAudit, {
            action: "field_skipped",
            step: "field.required_filter",
            status: "info",
            reason: "not_required",
          });
          fieldInventory.push(inventoryEntry(field, fieldAudit));
          root.audit.pushEvent(audit, {
            action: "field_skipped",
            step: "field.required_filter",
            status: "info",
            reason: "not_required",
            fieldId: field.fieldId,
            questionHash: field.questionHash,
            uiModel: field.uiModel,
          });
          continue;
        }
        if (!fieldMatchesRepairError(field, context)) {
          root.audit.pushEvent(audit, {
            action: "field_skipped",
            step: "field.repair_scope",
            status: "info",
            reason: "not_in_visible_validation_errors",
            fieldId: field.fieldId,
            questionHash: field.questionHash,
            uiModel: field.uiModel,
          });
          continue;
        }
        if (normalizedRepairErrors(context).length || context.repairMode) {
          root.audit.emitEvent(
            audit,
            "repair.touched",
            root.audit.fieldPayload(field, {
              status: "info",
              reason: "field_in_repair_scope",
              pass: pass,
            }),
          );
        }
        if (shouldSkipPasswordField(field, context)) {
          root.audit.pushEvent(audit, {
            action: "field_skipped",
            step: "field.password_filter",
            status: "info",
            reason: "password_field_skipped",
            fieldId: field.fieldId,
            questionHash: field.questionHash,
            uiModel: field.uiModel,
          });
          continue;
        }
        if (isPostSubmitSignatureRisk(field)) {
          root.audit.pushEvent(audit, {
            action: "field_skipped",
            step: "field.post_submit_signature_guard",
            status: "warn",
            reason: "post_submit_validation_signature_guard",
            fieldId: field.fieldId,
            questionHash: field.questionHash,
            uiModel: field.uiModel,
          });
          root.audit.pushIssue(audit, null, {
            kind: "post_submit_signature_guard",
            severity: "warn",
            failedStep: "field.post_submit_signature_guard",
            reason:
              "Skipped final signature field because the page is already in post-submit validation mode.",
            descriptor: field.descriptor || "",
            uiModel: field.uiModel || "",
          });
          continue;
        }
        if (isConditionalYesFollowupText(field)) {
          var fieldAudit = root.audit.createFieldAudit(audit, field);
          fieldAudit.beforeState = root.fieldState.readFieldState(field);
          fieldAudit.afterState = {
            ...root.fieldState.readFieldState(field),
            reason: "conditional_yes_followup_left_blank",
          };
          fieldAudit.filled = false;
          fieldAudit.valueSource = "skipped:conditional_yes_followup";
          root.audit.pushFieldStep(audit, fieldAudit, {
            action: "field_skipped",
            step: "field.conditional_followup_guard",
            status: "info",
            reason: "conditional_yes_followup_left_blank",
          });
          fieldInventory.push(inventoryEntry(field, fieldAudit));
          root.audit.pushEvent(audit, {
            action: "field_skipped",
            step: "field.conditional_followup_guard",
            status: "info",
            reason: "conditional_yes_followup_left_blank",
            fieldId: field.fieldId,
            questionHash: field.questionHash,
            uiModel: field.uiModel,
          });
          continue;
        }
        var actionGuard = createFieldActionGuard(context, field);
        var mutationSnapshot = captureFieldMutationState(field);
        var result = await withTimeout(
          runField({
            field: field,
            profile: context.profile || {},
            settings: context.settings || {},
            audit: audit,
            activeApplyContext: context.activeApplyContext || {},
            defaultResume: context.defaultResume || {},
            fillRunId: context.fillRunId || "",
            actionGuard: actionGuard,
          }),
          fieldFillTimeoutMs(context),
          function () {
            var timeoutMs = fieldFillTimeoutMs(context);
            var fieldAudit = root.audit.createFieldAudit(audit, field);
            fieldAudit.beforeState = root.fieldState.readFieldState(field);
            fieldAudit.afterState = {
              ...root.fieldState.readFieldState(field),
              reason: "field_fill_timeout",
            };
            fieldAudit.filled = false;
            root.audit.pushIssue(audit, fieldAudit, {
              kind: "field_fill_timeout",
              severity: field.required ? "warn" : "info",
              failedStep: "field.timeout",
              reason:
                "Field fill exceeded the per-field timeout before completing.",
            });
            root.audit.pushEvent(audit, {
              action: "field_timeout",
              step: "field.timeout",
              status: field.required ? "warn" : "info",
              reason: "field_fill_timeout",
              fieldId: field.fieldId,
              questionHash: field.questionHash,
              uiModel: field.uiModel,
              detail: {
                descriptor: String(field.descriptor || "").slice(0, 240),
                timeoutMs: timeoutMs,
              },
            });
            emitStructuredFieldTrace(audit, "field.commit.checked", field, {
              elapsedMs: timeoutMs,
              committed: false,
              clicked: false,
              reasonCode: "field_fill_timeout",
            });
            emitStructuredFieldTrace(audit, "field.action.failed", field, {
              elapsedMs: timeoutMs,
              committed: false,
              reasonCode: "field_fill_timeout",
            });
            return { filled: false, fieldAudit: fieldAudit };
          },
          function () {
            actionGuard.cancel("field_fill_timeout");
            actionGuard.claimTerminal();
          },
          function () {
            actionGuard.cancelRun("field_driver_unwind_timeout");
          },
          Number(context?.settings?.fieldFillUnwindTimeoutMs || 2000),
          function () {
            restoreFieldMutationState(mutationSnapshot);
          },
        );
        if (fillCancelled(context)) {
          return cancelledResult(
            context,
            audit,
            filledFields,
            fieldInventory,
            generatedAnswers,
          );
        }
        fieldInventory.push(inventoryEntry(field, result.fieldAudit));
        if (result.filled) {
          processedQuestionHashes.add(field.questionHash);
          if (fieldKey) {
            processedFieldKeys.add(fieldKey);
          }
          passFilledCount += 1;
          filledFields.push({
            field: field.descriptor,
            valueSource: result.fieldAudit.valueSource,
            questionHash: field.questionHash,
          });
        }
        if (
          result.fieldAudit.valueSource &&
          result.fieldAudit.valueSource.startsWith("fallback:")
        ) {
          generatedAnswers.push({
            questionHash: field.questionHash,
            questionText: field.descriptor,
            answerText: result.fieldAudit.answerPreview,
            answerSource: result.fieldAudit.valueSource,
            confidence: "low",
            manualReviewRequired: true,
          });
        }
      }
      if (!passFilledCount) {
        break;
      }
    }
    root.audit.complete(audit);
    var manualReviewRequired = audit.permanentIssues.some(function (issue) {
      return ["warn", "blocked", "error"].includes(issue.severity);
    });
    return {
      ok: true,
      atsType: context.atsType || context.fillRoute?.adapterName || "generic",
      adapterBackedByGeneric:
        context.fillRoute?.adapterBackedByGeneric || false,
      frameUrl: window.location.href,
      authState: window.__huntApplyUtils?.detectAuthState
        ? window.__huntApplyUtils.detectAuthState()
        : "unknown",
      filledFieldCount: filledFields.length,
      generatedAnswerCount: generatedAnswers.length,
      manualReviewRequired: manualReviewRequired,
      manualReviewReasons: manualReviewRequired
        ? ["c3_v2_permanent_issues"]
        : [],
      bestEffortWarnings: audit.permanentIssues.map(function (issue) {
        return issue.kind + ":" + issue.reason;
      }),
      filledFields: filledFields,
      fieldInventory: fieldInventory,
      generatedAnswers: generatedAnswers,
      htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000),
      interactionTrace: audit.events,
      traceTruncated: Boolean(audit.traceTruncated),
      v2Audit: audit,
    };
  }

  root.fieldPipeline = {
    runField: runField,
    runHuntV2Fill: runHuntV2Fill,
  };
})();
