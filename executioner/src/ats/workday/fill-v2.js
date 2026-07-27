// Workday V2 uses the shared field pipeline plus Workday-only inspectors and
// drivers injected from separate files before this serialized function runs.
export function createWorkdayFillV2Function() {
  return async function workdayFillV2(context) {
    if (!window.__huntV2?.fieldPipeline) {
      return {
        ok: false,
        reason: "missing_v2_pipeline",
        message: "C3 V2 shared pipeline scripts were not injected.",
      };
    }
    const fillContext = {
      ...context,
      atsType: "workday",
    };
    const timeoutMs = Number(
      context?.settings?.workdayFillReturnTimeoutMs || 60000,
    );
    const evidenceText = (value, maxLength) =>
      String(value || "")
        .replace(
          /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
          "[redacted-email]",
        )
        .replace(
          /\b(password|passwd|token|secret|authorization)\b\s*[:=]\s*\S+/gi,
          "$1=[redacted]",
        )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
    const evidenceIso = (value) => {
      const parsed = Date.parse(String(value || ""));
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
    };
    const evidenceField = (field) => ({
      id: evidenceText(field?.id || "", 160),
      label: evidenceText(field?.label || "", 240),
      type: evidenceText(field?.type || "", 80),
    });
    const evidenceCommittedState = (state) => ({
      committed: Boolean(state?.committed),
      selected: Boolean(state?.selected),
      checked: Boolean(state?.checked),
      empty: Boolean(state?.empty),
      validationVisible: Boolean(state?.validationVisible),
      reason: evidenceText(state?.reason || "", 160),
    });
    const evidencePopupOwner = (owner) => ({
      id: evidenceText(owner?.id || "", 160),
      role: evidenceText(owner?.role || "", 80),
      automationId: evidenceText(owner?.automationId || "", 160),
      controls: evidenceText(owner?.controls || "", 160),
    });
    const evidenceIsSourceField = (field) =>
      /\bsource\b|how did you hear|hear about us/.test(
        [field?.id, field?.label, field?.type].join(" ").toLowerCase(),
      );
    const evidenceIntendedOption = (option, field) => ({
      label: evidenceIsSourceField(field)
        ? evidenceText(option?.label || "", 160)
        : "",
    });
    const evidenceAction = (action) => ({
      method: evidenceText(action?.method || "", 80),
      result: evidenceText(action?.result || "", 80),
      reason: evidenceText(action?.reason || "", 160),
    });
    const evidenceCommitVerification = (verification) => ({
      verified: Boolean(verification?.verified),
      selectedPillPresent: Boolean(verification?.selectedPillPresent),
      backingValuePresent: Boolean(verification?.backingValuePresent),
      validationVisible: Boolean(verification?.validationVisible),
      reason: evidenceText(verification?.reason || "", 160),
    });
    const sanitizeDriverEvidence = (raw) => {
      raw = raw && typeof raw === "object" ? raw : {};
      const startedAt = evidenceIso(raw.startedAt);
      const capturedAt = new Date().toISOString();
      const measuredElapsed = startedAt
        ? Math.max(0, Date.now() - Date.parse(startedAt))
        : 0;
      const elapsedMs = Math.max(
        0,
        Number.isFinite(Number(raw.elapsedMs)) ? Number(raw.elapsedMs) : 0,
        measuredElapsed,
      );
      const sanitizeMechanism = (entry) => {
        const field = evidenceField(entry?.field);
        return {
          field,
          popupOwner: evidencePopupOwner(entry?.popupOwner),
          intendedOption: evidenceIntendedOption(entry?.intendedOption, field),
          action: evidenceAction(entry?.action),
          commitVerification: evidenceCommitVerification(
            entry?.commitVerification,
          ),
          lastCommittedState: evidenceCommittedState(entry?.lastCommittedState),
        };
      };
      const sanitizeBreadcrumb = (entry) => ({
        at: evidenceIso(entry?.at),
        elapsedMs: Math.max(
          0,
          Number.isFinite(Number(entry?.elapsedMs))
            ? Number(entry.elapsedMs)
            : 0,
        ),
        phase: evidenceText(entry?.phase || "idle", 80),
        waitClass: evidenceText(entry?.waitClass || "idle", 80),
        awaitedOperation: evidenceText(entry?.awaitedOperation || "", 160),
        ...sanitizeMechanism(entry),
      });
      const sanitizeOutcome = (entry) => ({
        at: evidenceIso(entry?.at),
        phase: evidenceText(entry?.phase || "", 80),
        ...sanitizeMechanism(entry),
      });
      const currentMechanism = sanitizeMechanism(raw);
      return {
        active: Boolean(raw.active),
        fillRunId: evidenceText(raw.fillRunId || "", 120),
        operationId: evidenceText(raw.operationId || "", 120),
        phase: evidenceText(raw.phase || "idle", 80),
        waitClass: evidenceText(raw.waitClass || "idle", 80),
        awaitedOperation: evidenceText(raw.awaitedOperation || "", 160),
        startedAt,
        lastProgressAt: evidenceIso(raw.lastProgressAt),
        capturedAt,
        elapsedMs,
        ...currentMechanism,
        breadcrumbs: Array.isArray(raw.breadcrumbs)
          ? raw.breadcrumbs.slice(-16).map(sanitizeBreadcrumb)
          : [],
        recentFieldOutcomes: Array.isArray(raw.recentFieldOutcomes)
          ? raw.recentFieldOutcomes.slice(-12).map(sanitizeOutcome)
          : [],
      };
    };
    let timeoutHandle = null;
    const timeoutResult = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        const clean = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();
        const visible = (element) => {
          if (!element) {
            return false;
          }
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const errors = Array.from(
          document.querySelectorAll(
            [
              '[role="alert"]',
              '[data-automation-id="inputAlert"]',
              '[data-automation-id="errorMessage"]',
              '[aria-invalid="true"]',
            ].join(", "),
          ),
        )
          .filter(visible)
          .map((node) => clean(node.innerText || node.textContent || ""))
          .filter(Boolean)
          .filter((text) => !/successfully uploaded/i.test(text));
        const filledFields = [];
        const fieldInventory = [];
        Array.from(
          document.querySelectorAll("input, textarea, button"),
        ).forEach((el) => {
          if (!visible(el)) {
            return;
          }
          const tagName = el.tagName || "";
          const type = String(el.type || "").toLowerCase();
          if (
            tagName === "INPUT" &&
            /^(hidden|submit|button|reset|file)$/i.test(type)
          ) {
            return;
          }
          const label = clean(
            [
              el.getAttribute?.("aria-label"),
              el.id,
              el.name,
              el.innerText,
              el.textContent,
            ]
              .filter(Boolean)
              .join(" "),
          );
          const value =
            type === "checkbox" || type === "radio"
              ? el.checked
                ? el.value || "checked"
                : ""
              : clean(el.value || el.innerText || el.textContent || "");
          const filled =
            Boolean(value) &&
            !/^select one$/i.test(value) &&
            !/^(english|settings|save and continue)$/i.test(value);
          if (!label && !filled) {
            return;
          }
          const entry = {
            kind: tagName.toLowerCase(),
            tagName,
            type,
            id: el.id || "",
            name: el.name || "",
            descriptor: label.slice(0, 240),
            required:
              el.required ||
              /required/i.test(el.getAttribute?.("aria-label") || ""),
            filled,
            skippedReason: filled ? "" : "workday_timeout_dom_recovery",
            valueSource: filled ? "dom:workday_timeout_recovery" : "",
            bestEffortWarning: "",
            options: [],
          };
          fieldInventory.push(entry);
          if (filled) {
            filledFields.push({
              field: entry.descriptor,
              valueSource: entry.valueSource,
              questionHash: entry.id || entry.name || entry.descriptor,
            });
          }
        });
        let rawDriverEvidence = {};
        try {
          rawDriverEvidence =
            window.__huntV2?.driverEvidence?.snapshot?.() || {};
        } catch (_error) {
          rawDriverEvidence = {};
        }
        const driverInFlight = sanitizeDriverEvidence(rawDriverEvidence);
        const documentReadyState = evidenceText(
          document.readyState || "unknown",
          32,
        );
        const pageTransitionObserved = documentReadyState !== "complete";
        const timeoutEvidence = {
          reason: "workday_fill_return_timeout",
          capturedAt: new Date().toISOString(),
          timeoutMs,
          documentReadyState,
          pageTransitionObserved,
          observedWaitState: pageTransitionObserved
            ? "page_transition"
            : driverInFlight.waitClass || "idle",
          driverInFlight,
        };
        resolve({
          ok: errors.length === 0 && filledFields.length > 0,
          atsType: "workday",
          adapterBackedByGeneric: false,
          frameUrl: window.location.href,
          authState: window.__huntApplyUtils?.detectAuthState
            ? window.__huntApplyUtils.detectAuthState()
            : "unknown",
          filledFieldCount: filledFields.length,
          generatedAnswerCount: 0,
          manualReviewRequired: errors.length > 0,
          manualReviewReasons: errors.length
            ? ["workday_fill_return_timeout_validation_visible"]
            : ["workday_fill_return_timeout_recovered"],
          bestEffortWarnings: ["workday_fill_return_timeout_recovered"],
          filledFields,
          fieldInventory,
          generatedAnswers: [],
          timeoutEvidence,
          htmlSnapshot: document.documentElement.outerHTML.slice(0, 50000),
          interactionTrace: [
            {
              action: "workday_fill_return_timeout_recovered",
              step: "adapter.timeout",
              status: errors.length ? "warn" : "ok",
              reason:
                "Workday adapter returned DOM recovery result after page-side fill did not resolve.",
              detail: {
                timeoutMs,
                errors: errors.slice(0, 10),
                timeoutEvidence,
              },
            },
          ],
          traceTruncated: false,
          v2Audit: {
            summary: { fieldCount: fieldInventory.length },
            permanentIssues: errors.length
              ? [
                  {
                    kind: "workday_fill_return_timeout_validation_visible",
                    severity: "warn",
                    failedStep: "adapter.timeout",
                    reason: errors.slice(0, 3).join(" | "),
                  },
                ]
              : [],
            events: [],
          },
        });
      }, timeoutMs);
    });
    const fillPromise =
      window.__huntV2.fieldPipeline.runHuntV2Fill(fillContext);
    const first = await Promise.race([
      fillPromise.then((result) => ({ kind: "fill", result })),
      timeoutResult.then((result) => ({ kind: "timeout", result })),
    ]);
    if (first.kind === "fill") {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      return first.result;
    }

    const reason = "workday_fill_return_timeout";
    const fillRunId = context?.fillRunId || "";
    const cancelledIds = Array.isArray(window.__huntApplyCancelledFillRunIds)
      ? window.__huntApplyCancelledFillRunIds
      : [];
    if (fillRunId && !cancelledIds.includes(fillRunId)) {
      cancelledIds.push(fillRunId);
    }
    window.__huntApplyCancelledFillRunIds = cancelledIds.slice(-25);
    window.__huntApplyCancelFillRunId = fillRunId;
    window.__huntApplyFillCancelReasons = Object.assign(
      {},
      window.__huntApplyFillCancelReasons || {},
      fillRunId ? { [fillRunId]: reason } : {},
    );
    try {
      chrome?.runtime?.sendMessage?.({
        type: "hunt.apply.cancel_fill",
        payload: { fillRunId, reason },
      });
    } catch (_error) {
      // Page-side cancellation still prevents further Workday mutations.
    }
    fillPromise.catch(() => null);
    return first.result;
  };
}
