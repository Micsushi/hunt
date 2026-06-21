(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function shortHash(value) {
    var text = String(value ?? "");
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16).padStart(8, "0").slice(0, 12);
  }

  function looksSensitiveText(value) {
    var text = String(value || "");
    return (
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
      /\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/.test(
        text,
      ) ||
      /\b(password|token|cookie|authorization|bearer|secret)\b/i.test(text)
    );
  }

  function sensitiveKey(key) {
    return /\b(password|token|cookie|authorization|secret|rawvalue|currentvalue|intendedvalue|answerpreview|resume|email|phone)\b/i.test(
      String(key || "").replace(/[_-]/g, ""),
    );
  }

  function valueSummary(value) {
    var text = String(value ?? "");
    return {
      redacted: true,
      valueClass: text ? "text" : "empty",
      length: text.length,
      sha256Prefix: shortHash(text),
    };
  }

  function redactDetail(value, key, rules) {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === "string") {
      if (sensitiveKey(key) || looksSensitiveText(value)) {
        rules.push("sensitive_text");
        return valueSummary(value);
      }
      return value.length > 500 ? value.slice(0, 500) : value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 40).map(function (item) {
        return redactDetail(item, key, rules);
      });
    }
    if (typeof value === "object") {
      var output = {};
      Object.keys(value)
        .slice(0, 80)
        .forEach(function (childKey) {
          output[childKey] = redactDetail(value[childKey], childKey, rules);
        });
      return output;
    }
    return value;
  }

  function redactionFor(payload) {
    var rules = [];
    var redacted = redactDetail(payload || {}, "", rules);
    return {
      payload: redacted,
      redaction: {
        applied: true,
        rules: Array.from(new Set(rules)),
      },
    };
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (value !== undefined && value !== null && String(value).trim()) {
        return String(value);
      }
    }
    return "";
  }

  function auditContext(context) {
    var settings = context?.settings || {};
    var commandContext =
      context?.commandContext ||
      context?.ledgerContext ||
      settings.commandContext ||
      settings.ledgerContext ||
      {};
    var actor =
      commandContext.actor ||
      context?.actor ||
      settings.actor ||
      (settings.actorId
        ? {
            type: settings.actorType || "agent",
            id: settings.actorId,
            surface: settings.actorSurface || "unknown",
          }
        : null);
    return {
      actor: actor || null,
      agent_id: firstString(
        commandContext.agent_id,
        commandContext.agentId,
        context?.agent_id,
        context?.agentId,
        settings.agent_id,
        settings.agentId,
      ),
      lane_id: firstString(
        commandContext.lane_id,
        commandContext.laneId,
        context?.lane_id,
        context?.laneId,
        settings.lane_id,
        settings.laneId,
      ),
      session_id: firstString(
        commandContext.session_id,
        commandContext.sessionId,
        context?.session_id,
        context?.sessionId,
        settings.session_id,
        settings.sessionId,
      ),
      lease_id: firstString(
        commandContext.lease_id,
        commandContext.leaseId,
        context?.lease_id,
        context?.leaseId,
        settings.lease_id,
        settings.leaseId,
      ),
      command_id: firstString(
        commandContext.command_id,
        commandContext.commandId,
        context?.command_id,
        context?.commandId,
        settings.command_id,
        settings.commandId,
      ),
      trace_id: firstString(
        commandContext.trace_id,
        commandContext.traceId,
        context?.trace_id,
        context?.traceId,
        settings.trace_id,
        settings.traceId,
      ),
    };
  }

  function safeCss(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value || ""));
    }
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function rectSummary(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") {
      return { top: 0, left: 0, width: 0, height: 0 };
    }
    var rect = target.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function selectorPath(target) {
    if (!target || !target.tagName) {
      return "";
    }
    var parts = [];
    var current = target;
    while (current && current.nodeType === 1 && parts.length < 8) {
      var piece = current.tagName.toLowerCase();
      if (current.id) {
        piece += "#" + safeCss(current.id);
        parts.unshift(piece);
        break;
      }
      if (current.name) {
        piece += '[name="' + safeCss(current.name) + '"]';
      }
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function (sibling) {
          return sibling.tagName === current.tagName;
        });
        if (siblings.length > 1) {
          piece += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(piece);
      current = parent;
    }
    return parts.join(" > ");
  }

  function htmlClip(target) {
    if (!target || !target.outerHTML) {
      return "";
    }
    return normalizeText(target.outerHTML).slice(0, 2400);
  }

  function summarizeElement(target) {
    if (!target) {
      return {};
    }
    return {
      tagName: target.tagName || "",
      type: target.type || "",
      id: target.id || "",
      name: target.name || "",
      role: target.getAttribute?.("role") || "",
      ariaLabel: target.getAttribute?.("aria-label") || "",
      text: normalizeText(target.innerText || target.textContent || "").slice(
        0,
        300,
      ),
      selectorPath: selectorPath(target),
      rect: rectSummary(target),
      htmlClip: htmlClip(target),
    };
  }

  function visibleValidationErrors() {
    var seen = {};
    return Array.from(
      document.querySelectorAll(
        [
          '[role="alert"]',
          '[data-automation-id*="error" i]',
          '[id*="error" i]',
          '[aria-invalid="true"]',
        ].join(", "),
      ),
    )
      .map(function (element) {
        return normalizeText(element.innerText || element.textContent || "");
      })
      .filter(function (text) {
        var key = text.toLowerCase();
        if (!text || seen[key]) {
          return false;
        }
        seen[key] = true;
        return true;
      })
      .slice(0, 20);
  }

  function detectWorkdayRuntimeError() {
    var bodyText = normalizeText(document.body?.innerText || "");
    var lower = bodyText.toLowerCase();
    return (
      lower.includes("something went wrong") &&
      lower.includes("please refresh the page and then try again")
    );
  }

  function siteState(extra) {
    return Object.assign(
      {
        href: window.location.href,
        title: document.title || "",
        readyState: document.readyState || "",
        workdayRuntimeError: detectWorkdayRuntimeError(),
        validationErrors: visibleValidationErrors(),
        bodyHead: normalizeText(document.body?.innerText || "").slice(0, 500),
      },
      extra || {},
    );
  }

  function createRunAudit(context) {
    var runId =
      context.fillRunId ||
      "c3_v2_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    return {
      schemaVersion: "c3-v2-audit-1",
      runId: runId,
      startedAt: nowIso(),
      completedAt: "",
      atsType: context.atsType || "generic",
      pageUrl: window.location.href,
      mode: context.mode || "fill",
      summary: {
        fieldCount: 0,
        filledCount: 0,
        clearedCount: 0,
        issueCount: 0,
        generatedCount: 0,
        fallbackCount: 0,
      },
      page: {},
      fields: [],
      events: [],
      permanentIssues: [],
      eventContext: auditContext(context || {}),
      eventSink: context.eventSink || context.auditEventSink || null,
      traceTruncated: false,
      eventCounts: {},
    };
  }

  function pushEvent(audit, event) {
    if (!audit || !Array.isArray(audit.events)) {
      return event;
    }
    if (audit.events.length >= 1000) {
      if (!audit.traceTruncated) {
        audit.traceTruncated = true;
        audit.events.push({
          index: audit.events.length + 1,
          at: nowIso(),
          action: "trace_truncated",
          step: "audit.cap",
          status: "warn",
          reason: "event_limit_reached",
        });
      }
      return event;
    }
    var redacted = redactionFor(event || {});
    var entry = Object.assign(
      {
        index: audit.events.length + 1,
        at: nowIso(),
        action: "",
        step: "",
        status: "info",
        reason: "",
      },
      redacted.payload,
    );
    if (redacted.redaction.rules.length) {
      entry.redaction = redacted.redaction;
    }
    audit.events.push(entry);
    return entry;
  }

  function emitEvent(audit, eventType, payload) {
    if (!audit || !eventType) {
      return null;
    }
    audit.eventCounts = audit.eventCounts || {};
    var count = audit.eventCounts[eventType] || 0;
    var cap = eventType === "repair.loop" ? 20 : 120;
    if (count >= cap) {
      if (count === cap) {
        audit.eventCounts[eventType] += 1;
        return pushEvent(audit, {
          action: eventType,
          event_type: eventType,
          eventType: eventType,
          step: "audit.event_cap",
          status: "warn",
          reason: "event_type_cap_reached",
          detail: { cappedEventType: eventType, cap: cap },
        });
      }
      audit.eventCounts[eventType] += 1;
      return null;
    }
    audit.eventCounts[eventType] = count + 1;
    var redacted = redactionFor(payload || {});
    var context = audit.eventContext || {};
    var entry = pushEvent(audit, {
      action: eventType,
      event_type: eventType,
      eventType: eventType,
      component: "c3",
      status: payload?.status || "info",
      reason: payload?.reason || "",
      fieldId: payload?.fieldId || "",
      questionHash: payload?.questionHash || "",
      questionType: payload?.questionType || "",
      uiModel: payload?.uiModel || "",
      selectedOption: payload?.selectedOption || "",
      command_id: context.command_id || "",
      session_id: context.session_id || "",
      lane_id: context.lane_id || "",
      agent_id: context.agent_id || "",
      lease_id: context.lease_id || "",
      trace_id: context.trace_id || "",
      actor: context.actor || null,
      payload: redacted.payload,
      detail: redacted.payload,
      redaction: redacted.redaction,
    });
    try {
      var logEntry = Object.assign({ _tag: eventType, _ts: Date.now() }, entry);
      (window.__huntC3Logs = window.__huntC3Logs || []).push(logEntry);
    } catch (_error) {}
    try {
      if (typeof audit.eventSink === "function") {
        audit.eventSink(entry);
      } else if (typeof window.__huntC3EventSink === "function") {
        window.__huntC3EventSink(entry);
      } else if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        chrome.runtime.sendMessage({
          type: "hunt.apply.audit_event",
          payload: entry,
        });
      }
    } catch (_error) {
      // Optional package 05 integration: the local audit remains source of proof.
    }
    return entry;
  }

  function fieldPayload(field, extra) {
    var el = field?.element || field?.anchor;
    return Object.assign(
      {
        fieldId: field?.fieldId || "",
        questionHash: field?.questionHash || "",
        questionType: field?.questionType || "",
        uiModel: field?.uiModel || "",
        required: Boolean(field?.required),
        descriptor: String(field?.descriptor || "").slice(0, 240),
        workdayKind: field?.workday?.kind || "",
        frameId: window.__huntFrameId || "",
        element: summarizeElement(el),
      },
      extra || {},
    );
  }

  function createFieldAudit(audit, field) {
    var entry = {
      fieldId: field.fieldId || "",
      questionHash: field.questionHash || "",
      descriptor: field.descriptor || "",
      questionType: "",
      uiModel: field.uiModel || "",
      element: summarizeElement(field.element || field.anchor),
      required: Boolean(field.required),
      filled: false,
      cleared: false,
      valueSource: "",
      selectedOption: "",
      answerPreview: "",
      beforeState: {},
      afterState: {},
      steps: [],
      issues: [],
    };
    audit.fields.push(entry);
    audit.summary.fieldCount = audit.fields.length;
    return entry;
  }

  function pushFieldStep(audit, fieldAudit, step) {
    var entry = pushEvent(
      audit,
      Object.assign(
        {
          fieldId: fieldAudit.fieldId,
          questionHash: fieldAudit.questionHash,
          questionType: fieldAudit.questionType,
          uiModel: fieldAudit.uiModel,
        },
        step || {},
      ),
    );
    fieldAudit.steps.push(entry);
    return entry;
  }

  function pushIssue(audit, fieldAudit, issue) {
    if (!audit) {
      return null;
    }
    var entry = Object.assign(
      {
        kind: "c3_v2_issue",
        severity: "info",
        questionHash: fieldAudit?.questionHash || "",
        questionType: fieldAudit?.questionType || "",
        uiModel: fieldAudit?.uiModel || "",
        failedStep: "",
        reason: "",
        selectorPath: fieldAudit?.element?.selectorPath || "",
        fieldName: fieldAudit?.element?.name || "",
        elementType: fieldAudit?.element?.type || "",
        descriptor: fieldAudit?.descriptor || "",
        options: [],
        rect: fieldAudit?.element?.rect || {},
        htmlClip: fieldAudit?.element?.htmlClip || "",
      },
      issue || {},
    );
    if (fieldAudit) {
      fieldAudit.issues.push(entry);
    }
    audit.permanentIssues.push(entry);
    audit.summary.issueCount = audit.permanentIssues.length;
    if (entry.kind && entry.kind.includes("fallback")) {
      audit.summary.fallbackCount += 1;
    }
    if (entry.kind && entry.kind.includes("generated")) {
      audit.summary.generatedCount += 1;
    }
    pushEvent(audit, {
      action: "permanent_issue",
      step: entry.failedStep,
      status: entry.severity,
      reason: entry.reason,
      fieldId: fieldAudit?.fieldId || "",
      questionHash: entry.questionHash,
      questionType: entry.questionType,
      uiModel: entry.uiModel,
      detail: {
        kind: entry.kind,
        selectorPath: entry.selectorPath,
        fieldName: entry.fieldName,
      },
    });
    return entry;
  }

  function complete(audit) {
    audit.completedAt = nowIso();
    audit.summary.fieldCount = audit.fields.length;
    audit.summary.filledCount = audit.fields.filter(function (field) {
      return field.filled;
    }).length;
    audit.summary.clearedCount = audit.fields.filter(function (field) {
      return field.cleared;
    }).length;
    audit.summary.issueCount = audit.permanentIssues.length;
    return audit;
  }

  root.audit = {
    createRunAudit: createRunAudit,
    createFieldAudit: createFieldAudit,
    pushEvent: pushEvent,
    pushFieldStep: pushFieldStep,
    pushIssue: pushIssue,
    complete: complete,
    emitEvent: emitEvent,
    fieldPayload: fieldPayload,
    redactionFor: redactionFor,
    valueSummary: valueSummary,
    summarizeElement: summarizeElement,
    selectorPath: selectorPath,
    rectSummary: rectSummary,
    htmlClip: htmlClip,
    normalizeText: normalizeText,
    siteState: siteState,
  };
})();
