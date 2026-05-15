(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  async function runHuntV2Clear(context) {
    var audit = root.audit.createRunAudit({
      fillRunId: context.fillRunId,
      atsType: context.atsType || "generic",
      mode: "clear",
    });
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
    root.audit.complete(audit);
    return {
      ok: true,
      clearedFieldCount: cleared.length,
      clearedFields: cleared,
      v2Audit: audit,
    };
  }

  root.clearPipeline = {
    runHuntV2Clear: runHuntV2Clear,
  };
})();
