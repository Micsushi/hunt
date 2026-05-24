"use strict";

function workdayPageKindExpression(authVerificationPatternSource) {
  return `(() => {
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => normalize([
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.innerText,
      el?.textContent
    ].filter(Boolean).join(" "));
    const actionText = (value) => {
      const parts = normalize(value).split(" ").filter(Boolean);
      return parts.filter((part, index) => index === 0 || part.toLowerCase() !== parts[index - 1].toLowerCase()).join(" ");
    };
    const text = document.body ? document.body.innerText : "";
    const normalizedText = normalize(text);
    const buttons = [...document.querySelectorAll("button, [role='button'], a")]
      .filter(visible)
      .map((el) => textOf(el))
      .filter(Boolean);
    const fields = [...document.querySelectorAll("input:not([type='hidden']), textarea, select")]
      .filter((el) => el.name !== "website" && visible(el))
      .map((el) => ({
        id: el.id || "",
        name: el.name || "",
        type: el.type || "",
        autocomplete: el.autocomplete || "",
        placeholder: el.placeholder || "",
        label: el.getAttribute("aria-label") || ""
      }));
    const fieldText = (field) => [field.id, field.name, field.type, field.autocomplete, field.placeholder, field.label].join(" ");
    const hasEmailField = fields.some((field) => /email|username|user/i.test(fieldText(field)));
    const passwordCount = fields.filter((field) => field.type === "password").length;
    const currentStepNode = document.querySelector('[data-automation-id="progressBarActiveStep"]');
    const currentStepText = normalize(currentStepNode?.innerText || currentStepNode?.textContent || "");
    const hasButton = (pattern) => buttons.some((label) => pattern.test(actionText(label)));
    const finalSubmitVisible = hasButton(/^submit$/i);
    const hasCreateAccount = /create account|sign up|signup|register|join today|verify new password|password requirements/i.test(normalizedText)
      || hasButton(/create account|sign up|signup|register|join today/i);
    const hasSignIn = /already have an account|sign in|log in|login/i.test(normalizedText)
      || hasButton(/sign in|log in|login/i);
    const authStepSignal = /create account|sign in|log in|login|register|sign up/i.test(currentStepText);
    const hasEmailSigninChoice = hasButton(/^sign in with email\\b/i) || hasButton(/sign\\s*in\\s*using\\s*email/i);
    const authFieldsReady = hasEmailField && passwordCount > 0;
    const authPageVisible =
      (hasEmailField && passwordCount > 0 && (hasCreateAccount || hasSignIn)) ||
      (authStepSignal && authFieldsReady);
    const needsEmailVerification = new RegExp(${JSON.stringify(authVerificationPatternSource)}, "i").test(normalizedText)
      || /verify your email|confirm your email|check your email|activation link|verification link/i.test(normalizedText);
    const loadingNodes = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-automation-id*="loading" i], [class*="loading" i], [class*="spinner" i]')]
      .filter(visible);
    const hasClassificationSignal =
      buttons.length > 0 || fields.length > 0 || Boolean(currentStepText) || normalizedText.length > 80;
    const blankWorkdayShell =
      document.readyState === "complete" &&
      /myworkdayjobs\\.com/i.test(location.href) &&
      /\\/apply\\//i.test(location.href) &&
      !hasClassificationSignal &&
      normalizedText.length < 20 &&
      fields.length === 0 &&
      buttons.length === 0 &&
      !currentStepText;
    const authShellStillSettling =
      authStepSignal &&
      !authFieldsReady &&
      !hasEmailSigninChoice &&
      (fields.length === 0 || loadingNodes.length > 0);
    const stillLoading =
      (document.readyState !== "complete" && !hasClassificationSignal) ||
      (!hasClassificationSignal && normalizedText.length < 20) ||
      (loadingNodes.length > 0 && fields.length === 0 && !currentStepText) ||
      authShellStillSettling;
    let pageKind = "unknown";
    if (stillLoading) pageKind = "loading";
    else if (/the page you are looking for (doesn't|does not) exist|page not found|job posting is no longer available|job is no longer available/i.test(normalizedText)) pageKind = "posting_not_found";
    else if (/workday is currently unavailable|service interruption/i.test(normalizedText) || /community\\.workday\\.com\\/maintenance-page/i.test(location.href)) pageKind = "maintenance";
    else if (/something went wrong/i.test(normalizedText) && /please refresh/i.test(normalizedText)) pageKind = "runtime_error";
    else if (authPageVisible && hasEmailField && passwordCount > 1) pageKind = "signup_form";
    else if (authPageVisible && hasEmailField && passwordCount === 1) pageKind = "signin_form";
    else if (hasEmailSigninChoice || hasButton(/sign\\s*in\\s*with\\s*(google|apple)/i)) pageKind = "signin_choice";
    else if (authStepSignal && authFieldsReady) pageKind = hasCreateAccount ? "signup_form" : "signin_form";
    else if (/review/i.test(currentStepText) || finalSubmitVisible) pageKind = "review";
    else if (/start your application/i.test(normalizedText) || hasButton(/^apply manually$/i) || hasButton(/^autofill with resume$/i)) pageKind = "apply_choice";
    else if (currentStepText && !/create account|sign in/i.test(currentStepText)) pageKind = "application_step";
    else if (/resume\\/cv|my information|my experience|application questions|voluntary disclosures|self identify|review/i.test(normalizedText)) pageKind = "application_step";
    else if (hasButton(/^apply\\b/i) || /job requisition id|posted on/i.test(normalizedText)) pageKind = "job_posting";
    let workflowPhase = "unknown";
    let authState = "unknown";
    let authUiState = "unknown";
    if (["signin_choice", "signin_form", "signup_form"].includes(pageKind) || needsEmailVerification) {
      workflowPhase = "auth";
      if (needsEmailVerification) {
        authState = "verify_email";
        authUiState = "email_link_verification";
      } else if (pageKind === "signup_form") {
        authState = "signup";
        authUiState = pageKind === "signup_form" ? "signup_form" : "landing_choice";
      } else {
        authState = "login";
        authUiState = pageKind === "signin_form" ? "credential_form" : "landing_choice";
      }
    } else if (["apply_choice", "job_posting"].includes(pageKind)) {
      workflowPhase = "apply_entry";
    } else if (pageKind === "application_step") {
      workflowPhase = "job_fill";
    } else if (["posting_not_found", "maintenance", "runtime_error", "review"].includes(pageKind)) {
      workflowPhase = "terminal";
    }
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      pageKind,
      workflowPhase,
      authState,
      authUiState,
      stillLoading,
      authShellStillSettling,
      blankWorkdayShell,
      fieldCount: fields.length,
      passwordCount,
      hasEmailField,
      hasCreateAccount,
      hasSignIn,
      finalSubmitVisible,
      needsEmailVerification,
      buttonCount: buttons.length,
      currentStepText,
      loadingNodeCount: loadingNodes.length,
      bodyHead: normalizedText.slice(0, 800)
    };
  })()`;
}

class WorkdayWorkflowIdentifier {
  constructor({ pageClient, sleep, authVerificationPattern }) {
    this.pageClient = pageClient;
    this.sleep = sleep;
    this.authVerificationPattern = authVerificationPattern;
  }

  async inspectPageKind() {
    return this.pageClient.evaluate(
      workdayPageKindExpression(this.authVerificationPattern.source),
      30000,
    );
  }

  bestEffortState(state = {}) {
    if (!state || state.pageKind !== "loading") {
      return state || { pageKind: "unknown", workflowPhase: "unknown" };
    }
    const bodyHead = String(state.bodyHead || "");
    const currentStepText = String(state.currentStepText || "");
    const href = String(state.href || "");
    const hasAuthFields =
      Boolean(state.hasEmailField) || Number(state.passwordCount || 0) > 0;
    if (hasAuthFields || /sign in|log in|login|create account/i.test(bodyHead)) {
      return {
        ...state,
        pageKind: Number(state.passwordCount || 0) > 1
          ? "signup_form"
          : "signin_form",
        workflowPhase: "auth",
        authState: Number(state.passwordCount || 0) > 1 ? "signup" : "login",
        authUiState: Number(state.passwordCount || 0) > 0
          ? "credential_form"
          : "landing_choice",
        stillLoading: false,
        bestEffort: true,
      };
    }
    if (
      currentStepText ||
      /resume\/cv|my information|my experience|application questions|voluntary disclosures|self identify|review/i.test(
        bodyHead,
      )
    ) {
      return {
        ...state,
        pageKind: /review/i.test(currentStepText || bodyHead)
          ? "review"
          : "application_step",
        workflowPhase: /review/i.test(currentStepText || bodyHead)
          ? "terminal"
          : "job_fill",
        stillLoading: false,
        bestEffort: true,
      };
    }
    if (/start your application|apply manually|autofill with resume/i.test(bodyHead)) {
      return {
        ...state,
        pageKind: "apply_choice",
        workflowPhase: "apply_entry",
        stillLoading: false,
        bestEffort: true,
      };
    }
    if (/job requisition id|posted on|job description/i.test(bodyHead)) {
      return {
        ...state,
        pageKind: "job_posting",
        workflowPhase: "apply_entry",
        stillLoading: false,
        bestEffort: true,
      };
    }
    if (/myworkdayjobs\.com/i.test(href) && /\/apply\//i.test(href)) {
      return {
        ...state,
        pageKind: "application_step",
        workflowPhase: "job_fill",
        stillLoading: false,
        bestEffort: true,
      };
    }
    return {
      ...state,
      pageKind: "unknown",
      workflowPhase: "unknown",
      stillLoading: false,
      bestEffort: true,
    };
  }

  async waitForReady(timeoutMs = 45000) {
    const started = Date.now();
    const minWaitMs = 1000;
    const maxWaitMs = Math.max(Number(timeoutMs || 0), minWaitMs);
    let last = null;
    let stableSince = 0;
    let blankShellSince = 0;
    let blankShellReloaded = false;
    while (Date.now() - started < maxWaitMs) {
      const state = await this.inspectPageKind();
      const key = [
        state.href,
        state.pageKind,
        state.fieldCount,
        state.buttonCount,
        state.passwordCount,
        state.currentStepText,
        state.loadingNodeCount,
        String(state.bodyHead || "").slice(0, 160),
      ].join("|");
      if (state.blankWorkdayShell && !blankShellReloaded) {
        if (!blankShellSince) blankShellSince = Date.now();
        if (Date.now() - blankShellSince >= 2500) {
          blankShellReloaded = true;
          await this.pageClient.send("Page.reload", { ignoreCache: false });
          await this.sleep(3000);
          last = {
            key,
            state: { ...state, blankShellReloadAttempted: true },
          };
          continue;
        }
      } else if (!state.blankWorkdayShell) {
        blankShellSince = 0;
      }
      const minWaitSatisfied = Date.now() - started >= minWaitMs;
      if (minWaitSatisfied && !state.stillLoading && state.pageKind !== "loading") {
        if (key === last?.key) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= 250) {
            return {
              ...state,
              blankShellReloaded,
              waitedMs: Date.now() - started,
              minWaitMs,
              maxWaitMs,
            };
          }
        } else {
          stableSince = Date.now();
        }
      }
      last = { key, state };
      await this.sleep(500);
    }
    const bestEffort = this.bestEffortState(last?.state || {
      pageKind: "unknown",
      stillLoading: true,
    });
    return {
      ...bestEffort,
      blankShellReloaded,
      timedOut: true,
      waitedMs: Date.now() - started,
      minWaitMs,
      maxWaitMs,
    };
  }

  async identify(timeoutMs = 45000) {
    const state = await this.waitForReady(timeoutMs);
    return {
      ok: Boolean(
        state.bestEffort ||
          (!state.timedOut && !state.stillLoading && state.pageKind !== "loading"),
      ),
      phase: state.workflowPhase || "unknown",
      pageKind: state.pageKind || "unknown",
      authState: state.authState || "unknown",
      authUiState: state.authUiState || "unknown",
      state,
    };
  }
}

module.exports = {
  WorkdayWorkflowIdentifier,
  workdayPageKindExpression,
};
