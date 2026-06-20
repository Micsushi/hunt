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
    const timeoutMs = Number(context?.settings?.workdayFillReturnTimeoutMs || 60000);
    const timeoutResult = new Promise((resolve) => {
      setTimeout(() => {
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
        Array.from(document.querySelectorAll("input, textarea, button")).forEach(
          (el) => {
            if (!visible(el)) {
              return;
            }
            const tagName = el.tagName || "";
            const type = String(el.type || "").toLowerCase();
            if (tagName === "INPUT" && /^(hidden|submit|button|reset|file)$/i.test(type)) {
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
          },
        );
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
          htmlSnapshot: document.documentElement.outerHTML.slice(0, 50000),
          interactionTrace: [
            {
              action: "workday_fill_return_timeout_recovered",
              step: "adapter.timeout",
              status: errors.length ? "warn" : "ok",
              reason: "Workday adapter returned DOM recovery result after page-side fill did not resolve.",
              detail: { timeoutMs, errors: errors.slice(0, 10) },
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
    return Promise.race([
      window.__huntV2.fieldPipeline.runHuntV2Fill(fillContext),
      timeoutResult,
    ]);
  };
}
