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
    };
  }

  function pushEvent(audit, event) {
    if (!audit || !Array.isArray(audit.events)) {
      return event;
    }
    var entry = Object.assign(
      {
        index: audit.events.length + 1,
        at: nowIso(),
        action: "",
        step: "",
        status: "info",
        reason: "",
      },
      event || {},
    );
    audit.events.push(entry);
    return entry;
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
    summarizeElement: summarizeElement,
    selectorPath: selectorPath,
    rectSummary: rectSummary,
    htmlClip: htmlClip,
    normalizeText: normalizeText,
  };
})();
