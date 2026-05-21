"use strict";

const fs = require("node:fs");
const path = require("node:path");

function summarizeFill(fill) {
  const interactionTrace = fill.interactionTrace || [];
  const fieldInventory = Array.isArray(fill.fieldInventory)
    ? fill.fieldInventory
    : [];
  const v2Audit = fill.v2Audit || null;
  const v2SiteActions = Array.isArray(v2Audit?.events)
    ? v2Audit.events
        .filter((entry) =>
          [
            "site_state_before_field",
            "site_state_after_field",
            "workday_options_collected",
            "workday_option_click",
            "field_fill_result",
            "permanent_issue",
          ].includes(entry.action),
        )
        .map((entry) => ({
          index: entry.index,
          at: entry.at,
          action: entry.action,
          step: entry.step,
          status: entry.status,
          reason: entry.reason,
          fieldId: entry.fieldId || "",
          questionType: entry.questionType || "",
          uiModel: entry.uiModel || "",
          selectedOption: entry.selectedOption || "",
          detail: entry.detail || {},
        }))
    : [];
  const backgroundSiteActions = Array.isArray(fill.siteActions)
    ? fill.siteActions.map((entry) => ({
        at: entry.at || "",
        action: entry.action || "",
        status: entry.status || "",
        reason: entry.reason || "",
        siteState: entry.siteState || {},
      }))
    : [];
  const siteActions = [...backgroundSiteActions, ...v2SiteActions];
  const componentTrace = interactionTrace.filter((entry) =>
    ["hover", "click", "already_filled", "set_value"].includes(entry.action),
  );
  const phoneCountryCodeTrace = interactionTrace.filter((entry) => {
    const reason = String(entry.reason || "");
    const target = entry.target || {};
    return (
      reason.includes("phone_country_code") ||
      String(target.id || "").includes("countryPhoneCode") ||
      String(target.name || "").includes("countryPhoneCode") ||
      String(target.ariaLabel || "").includes("Country Phone Code")
    );
  });
  return {
    ok: fill.ok,
    error: fill.error,
    status: fill.status,
    summary: fill.summary,
    filledFieldCount: fill.filledFieldCount,
    pendingLlmFieldCount: fill.pendingLlmFieldCount,
    manualReviewReasons: fill.manualReviewReasons || [],
    bestEffortWarnings: fill.bestEffortWarnings || [],
    filledFields: (fill.filledFields || []).map((field) => ({
      field: field.field || "",
      descriptor: field.descriptor || field.field || "",
      id: field.id || "",
      name: field.name || "",
      tagName: field.tagName || "",
      type: field.type || "",
      value: field.value || "",
      selectedOption: field.selectedOption || "",
      valueSource: field.valueSource || "",
      bestEffortWarning: field.bestEffortWarning || "",
    })),
    generatedAnswers: (fill.generatedAnswers || []).map((answer) => ({
      questionHash: answer.questionHash || "",
      questionText: answer.questionText || "",
      answerText: answer.answerText || "",
      answerSource: answer.answerSource || "",
      confidence: answer.confidence || "",
      manualReviewRequired: Boolean(answer.manualReviewRequired),
    })),
    fieldInventory: fieldInventory.map((field) => ({
      kind: field.kind || "",
      tagName: field.tagName || "",
      type: field.type || "",
      id: field.id || "",
      name: field.name || "",
      descriptor: field.descriptor || "",
      required: Boolean(field.required),
      filled: Boolean(field.filled),
      skippedReason: field.skippedReason || "",
      valueSource: field.valueSource || "",
      bestEffortWarning: field.bestEffortWarning || "",
      options: field.options || [],
      questionHash: field.questionHash || "",
      questionType: field.questionType || "",
      uiModel: field.uiModel || "",
    })),
    nextAction: fill.nextAction || null,
    siteActions,
    v2AuditSummary: v2Audit
      ? {
          runId: v2Audit.runId || "",
          page: v2Audit.page || {},
          summary: v2Audit.summary || {},
          permanentIssues: v2Audit.permanentIssues || [],
        }
      : null,
    unfilledRequired: fieldInventory
      .filter((field) => field.required && !field.filled)
      .map((field) => ({
        tagName: field.tagName,
        type: field.type,
        id: field.id,
        name: field.name,
        descriptor: field.descriptor,
        skippedReason: field.skippedReason,
      }))
      .slice(0, 30),
    phoneCountryCodeTrace,
    interactionTrace: componentTrace.slice(0, 120),
  };
}

function buildFieldAudit(fillSummary) {
  const filledByKey = new Map();
  for (const field of fillSummary.filledFields || []) {
    const keys = [
      field.id && `id:${field.id}`,
      field.name && `name:${field.name}`,
      field.descriptor && `descriptor:${field.descriptor}`,
      field.field && `descriptor:${field.field}`,
    ].filter(Boolean);
    for (const key of keys) {
      if (!filledByKey.has(key)) {
        filledByKey.set(key, field);
      }
    }
  }
  return (fillSummary.fieldInventory || []).map((field) => {
    const filled =
      (field.id && filledByKey.get(`id:${field.id}`)) ||
      (field.name && filledByKey.get(`name:${field.name}`)) ||
      (field.descriptor && filledByKey.get(`descriptor:${field.descriptor}`)) ||
      null;
    return {
      id: field.id || "",
      name: field.name || "",
      tagName: field.tagName || "",
      type: field.type || "",
      kind: field.kind || "",
      descriptor: field.descriptor || filled?.descriptor || "",
      required: Boolean(field.required),
      filled: Boolean(field.filled),
      skippedReason: field.skippedReason || "",
      options: field.options || [],
      valuePut: filled?.value || "",
      selectedOption: filled?.selectedOption || filled?.value || "",
      valueSource: filled?.valueSource || field.valueSource || "",
      bestEffortWarning:
        filled?.bestEffortWarning || field.bestEffortWarning || "",
    };
  });
}

function buildFillAudit({
  pageIndex,
  fillIndex,
  before,
  afterFill,
  fillSummary,
}) {
  return {
    pageIndex,
    retryIndex: fillIndex,
    stepBefore: before.currentStep || null,
    stepAfter: afterFill.currentStep || null,
    hrefBefore: before.href || "",
    hrefAfter: afterFill.href || "",
    status: fillSummary.status || "",
    ok: Boolean(fillSummary.ok),
    filledFieldCount: fillSummary.filledFieldCount || 0,
    pendingLlmFieldCount: fillSummary.pendingLlmFieldCount || 0,
    manualReviewReasons: fillSummary.manualReviewReasons || [],
    bestEffortWarnings: fillSummary.bestEffortWarnings || [],
    fields: buildFieldAudit(fillSummary),
    generatedAnswers: fillSummary.generatedAnswers || [],
    filledFields: fillSummary.filledFields || [],
    afterErrors: afterFill.errors || [],
    suppressedErrors: afterFill.suppressedErrors || [],
    remainingValues: afterFill.remainingValues || {},
    nextAction: fillSummary.nextAction || null,
    v2AuditSummary: fillSummary.v2AuditSummary || null,
  };
}

function writeAuditJson(auditPath, audit) {
  if (!auditPath) {
    return null;
  }
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf-8");
  return auditPath;
}

module.exports = {
  buildFieldAudit,
  buildFillAudit,
  summarizeFill,
  writeAuditJson,
};
