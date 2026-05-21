"use strict";

class WorkdayApplyEntryWorkflow {
  constructor({ pageClient, waitForReady, navigate, cdpClick }) {
    this.pageClient = pageClient;
    this.waitForReady = waitForReady;
    this.navigate = navigate;
    this.cdpClick = cdpClick;
  }

  async clickApplyManuallyEntry() {
    const readyState = await this.waitForReady();
    if (readyState.stillLoading || readyState.pageKind === "loading") {
      return {
        ok: false,
        phase: "apply_entry",
        reason: "workday_page_still_loading",
        readyState,
      };
    }
    if (readyState.pageKind === "posting_not_found") {
      return {
        ok: false,
        phase: "apply_entry",
        reason: "posting_not_found",
        message: "Workday says this job posting page does not exist.",
        readyState,
      };
    }
    const result = await this.pageClient.evaluate(
      `(async () => {
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const visible = (el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const bodyText = document.body ? document.body.innerText : "";
        const currentStep = document.querySelector('[data-automation-id="progressBarActiveStep"]')
          || bodyText.match(/current\\s+s?tep\\s+\\d+\\s+of\\s+\\d+[^\\n]*/i);
        const currentStepText = normalize(currentStep?.innerText || currentStep?.textContent || currentStep?.[0] || "");
        if (currentStep && !/create account|sign in|log in|login|register|sign up/i.test(currentStepText)) {
          return {
            ok: true,
            skipped: true,
            phase: "apply_entry",
            reason: "already_on_application_step",
            href: location.href,
          };
        }
        if (currentStep) {
          return {
            ok: true,
            skipped: true,
            phase: "apply_entry",
            reason: "already_on_auth_step",
            href: location.href,
            currentStep: currentStepText,
          };
        }
        if (!/Start Your Application/i.test(bodyText)) {
          return {
            ok: true,
            skipped: true,
            phase: "apply_entry",
            reason: "not_on_start_application_page",
            href: location.href,
          };
        }
        const candidates = [...document.querySelectorAll("a, button, [role='button']")]
          .filter(visible)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              el,
              text: normalize([el.getAttribute("aria-label"), el.innerText, el.textContent].filter(Boolean).join(" ")),
              href: el.href || "",
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            };
          });
        const candidate = candidates.find((item) => /^Apply Manually$/i.test(item.text))
          || candidates.find((item) => /\\/apply\\/applyManually/i.test(item.href));
        if (!candidate) {
          return {
            ok: false,
            phase: "apply_entry",
            reason: "apply_manually_not_found",
            href: location.href,
            candidates: candidates.map((item) => item.text || item.href).filter(Boolean).slice(0, 30),
          };
        }
        return {
          ok: true,
          phase: "apply_entry",
          clicked: true,
          label: candidate.text || "Apply Manually",
          href: candidate.href || "",
          x: candidate.x,
          y: candidate.y,
          reason: candidate.href ? "apply_manually_href_found" : "apply_manually_button_found",
        };
      })()`,
      30000,
    );
    if (result?.ok) {
      if (!result.skipped && result.href) {
        await this.navigate(result.href);
      } else if (!result.skipped && result.x != null && result.y != null) {
        await this.cdpClick(this.pageClient, result.x, result.y);
        await this.waitForReady();
      }
      if (result.skipped) {
        return result;
      }
      const after = await this.pageClient.evaluate(
        `(() => {
          const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
          const text = document.body ? document.body.innerText : "";
          const readCurrentStep = () => {
            const activeStep = document.querySelector('[data-automation-id="progressBarActiveStep"]');
            if (activeStep) {
              const steps = [...document.querySelectorAll('[data-automation-id^="progressBar"]')];
              const labels = [...activeStep.querySelectorAll("label")]
                .map((label) => normalize(label.innerText || label.textContent || ""))
                .filter(Boolean);
              const title = labels.at(-1)
                || normalize(activeStep.innerText || activeStep.textContent || "").split(/\\n/).map(normalize).filter(Boolean).at(-1)
                || "";
              if (title) {
                return {
                  current: Math.max(steps.indexOf(activeStep) + 1, 1),
                  total: steps.length || 1,
                  title
                };
              }
            }
            const stepMatch = text.match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s*\\n([^\\n]+)/i)
              || normalize(text).match(/current\\s+s?tep\\s+(\\d+)\\s+of\\s+(\\d+)\\s+(.+?)(?:\\s+s?tep\\s+\\d+\\s+of\\s+\\d+|$)/i);
            return stepMatch ? { current: Number(stepMatch[1]), total: Number(stepMatch[2]), title: normalize(stepMatch[3]) } : null;
          };
          const currentStep = readCurrentStep();
          return {
            href: location.href,
            currentStep,
          };
        })()`,
        10000,
      );
      return {
        ...result,
        ok: Boolean(after?.currentStep),
        href: after?.href || result.href || "",
        currentStep: after?.currentStep || null,
        reason: after?.currentStep
          ? "apply_manually_clicked"
          : "application_step_not_reached",
      };
    }
    return {
      ok: false,
      phase: "apply_entry",
      reason: "apply_entry_detection_failed",
      result,
    };
  }
}

module.exports = {
  WorkdayApplyEntryWorkflow,
};
