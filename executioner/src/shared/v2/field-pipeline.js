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

  function inventoryEntry(field, fieldAudit) {
    return {
      kind: field.kind,
      tagName: field.element?.tagName || "",
      type: field.element?.type || "",
      name: field.element?.name || "",
      id: field.element?.id || "",
      descriptor: field.descriptor || "",
      questionHash: field.questionHash || "",
      required: Boolean(field.required),
      filled: Boolean(fieldAudit.filled),
      skippedReason: fieldAudit.filled
        ? ""
        : fieldAudit.afterState?.reason || "",
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

  function cancelledResult(
    context,
    audit,
    filledFields,
    fieldInventory,
    generatedAnswers,
  ) {
    root.audit.pushEvent(audit, {
      action: "v2_fill_cancelled",
      step: "run.cancel",
      status: "warn",
      reason: "user_cancelled",
      detail: {
        fillRunId: context.fillRunId || "",
        activeFillRunId: window.__huntApplyActiveFillRunId || "",
      },
    });
    root.audit.complete(audit);
    return {
      ok: false,
      cancelled: true,
      reason: "user_cancelled",
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
      manualReviewReasons: ["user_cancelled"],
      bestEffortWarnings: audit.permanentIssues.map(function (issue) {
        return issue.kind + ":" + issue.reason;
      }),
      filledFields: filledFields,
      fieldInventory: fieldInventory,
      generatedAnswers: generatedAnswers,
      htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000),
      interactionTrace: audit.events,
      traceTruncated: false,
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
  }) {
    var fieldAudit = root.audit.createFieldAudit(audit, field);
    fieldAudit.beforeState = root.fieldState.readFieldState(field);
    root.audit.pushFieldStep(audit, fieldAudit, {
      action: "field_start",
      step: "field.start",
      status: "info",
      uiModel: field.uiModel,
      element: root.audit.summarizeElement(field.element || field.anchor),
    });
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

    var question = root.questionIdentifier.identifyQuestion(
      field,
      audit,
      fieldAudit,
    );
    fieldAudit.questionType = question.type;
    var answer = root.answerResolver.resolveAnswer({
      question: question,
      field: field,
      profile: profile,
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

    var option = null;
    if (optionsNeeded(field)) {
      field.options = await root.optionCollector.collectOptions(field, {
        answer: answer,
        audit: audit,
        fieldAudit: fieldAudit,
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
      fieldAudit.valueSource = match.fallback
        ? "fallback:" + match.source
        : answer.source || match.source;
      root.audit.pushFieldStep(audit, fieldAudit, {
        action: "option_resolved",
        step: "option.match",
        status: option ? "ok" : "warn",
        selectedOption: option?.label || "",
        valueSource: fieldAudit.valueSource,
        reason: match.source,
      });
      if (!option) {
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
      fieldAudit.afterState = root.fieldState.readFieldState(field);
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
    });
    fieldAudit.afterState =
      fillResult.afterState || root.fieldState.readFieldState(field);
    fieldAudit.filled = Boolean(fillResult.ok);
    if (fillResult.valueSource) {
      fieldAudit.valueSource = fillResult.valueSource;
    }
    if (fillResult.answerText) {
      fieldAudit.answerPreview = String(fillResult.answerText).slice(0, 160);
    }
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
    });
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

    var fields = root.uiInspector.collectCandidates();
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
      if (pass > 1) {
        fields = root.uiInspector.collectCandidates();
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
                !processedQuestionHashes.has(field.questionHash)
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
        if (processedQuestionHashes.has(field.questionHash)) {
          continue;
        }
        if (context.settings?.fillRequiredOnly !== false && !field.required) {
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
        var result = await runField({
          field: field,
          profile: context.profile || {},
          settings: context.settings || {},
          audit: audit,
          activeApplyContext: context.activeApplyContext || {},
          defaultResume: context.defaultResume || {},
          fillRunId: context.fillRunId || "",
        });
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
      traceTruncated: false,
      v2Audit: audit,
    };
  }

  root.fieldPipeline = {
    runField: runField,
    runHuntV2Fill: runHuntV2Fill,
  };
})();
