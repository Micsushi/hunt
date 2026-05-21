"use strict";

class WorkdayAuthWorkflow {
  constructor({
    pageClient,
    cdpClick,
    inspectPage,
    js,
    sleep,
    authVerificationPattern,
    accountEmail = "",
    accountPassword = "",
  }) {
    this.pageClient = pageClient;
    this.cdpClick = cdpClick;
    this.inspectPage = inspectPage;
    this.js = js;
    this.sleep = sleep;
    this.authVerificationPattern = authVerificationPattern;
    this.accountEmail = accountEmail;
    this.accountPassword = accountPassword;
  }

  async clickPrimary(route = {}) {
    const result = await this.pageClient.evaluate(
      `(async () => {
        const route = ${this.js(route || {})};
        const desiredAuthState = String(route.authState || "").toLowerCase();
        const desiredAuthUiState = String(route.authUiState || "").toLowerCase();
        const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const visible = (el) => {
          if (!el) return false;
          if (String(el.getAttribute("aria-hidden") || "").toLowerCase() === "true") return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
        };
        const rectFor = (target) => {
          target.scrollIntoView({ block: "center", inline: "center" });
          try { target.focus?.(); } catch (_error) {}
          const rect = target.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        };
        const labelFor = (el) => normalize([
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.value,
          el.innerText,
          el.textContent,
        ].filter(Boolean).join(" "));
        const metadataFor = (el) => normalize([
          el.id,
          el.name,
          el.type,
          el.getAttribute("data-automation-id"),
          el.getAttribute("data-testid"),
          el.className,
        ].filter(Boolean).join(" "));
        const bodyText = normalize(document.body?.innerText || "");
        const verificationBlocked = new RegExp(${JSON.stringify(this.authVerificationPattern.source)}, "i").test(bodyText);
        if (verificationBlocked) {
          return {
            clicked: false,
            reason: "auth_verification_required",
            message: "Workday requires account verification before sign-in can continue.",
            href: location.href,
            title: document.title,
            bodyHead: bodyText.slice(0, 800),
          };
        }
        const currentStepNode = document.querySelector('[data-automation-id="progressBarActiveStep"]');
        const currentStepText = normalize(currentStepNode?.innerText || currentStepNode?.textContent || bodyText.match(/current\\s+s?tep\\s+\\d+\\s+of\\s+\\d+[^\\n]*/i)?.[0] || "");
        const isAuthStep = /create account|sign in|log in|login|register|sign up/i.test(currentStepText)
          || /create account|verify new password|already have an account|career privacy notice/i.test(bodyText);
        if (!isAuthStep) {
          return { clicked: false, reason: "not_auth_step", currentStepText };
        }
        const accountEmail = ${this.js(this.accountEmail || "")};
        const accountPassword = ${this.js(this.accountPassword || "")};
        const setNativeValue = (el, value) => {
          if (!el || value == null) return false;
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
          if (descriptor?.set) descriptor.set.call(el, value);
          else el.value = value;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          return true;
        };
        const authInputs = [...document.querySelectorAll('input:not([type="hidden"])')]
          .filter((el) => el.name !== "website" && visible(el));
        const authInputText = (el) => normalize([
          el.getAttribute("data-automation-id"),
          el.id,
          el.name,
          el.type,
          el.autocomplete,
          el.placeholder,
          el.getAttribute("aria-label"),
        ].filter(Boolean).join(" "));
        const emailInput = authInputs.find((el) => /email|username|user/i.test(authInputText(el)) && el.type !== "password");
        const passwordInputs = authInputs.filter((el) => el.type === "password");
        const filled = [];
        if ((desiredAuthState === "signup" || desiredAuthState === "login" || desiredAuthState === "signin") && accountEmail && emailInput) {
          setNativeValue(emailInput, accountEmail);
          filled.push({ field: "email", automationId: emailInput.getAttribute("data-automation-id") || "" });
        }
        if ((desiredAuthState === "signup" || desiredAuthState === "login" || desiredAuthState === "signin") && accountPassword && passwordInputs[0]) {
          setNativeValue(passwordInputs[0], accountPassword);
          filled.push({ field: "password", automationId: passwordInputs[0].getAttribute("data-automation-id") || "" });
        }
        if (desiredAuthState === "signup" && accountPassword && passwordInputs[1]) {
          setNativeValue(passwordInputs[1], accountPassword);
          filled.push({ field: "verifyPassword", automationId: passwordInputs[1].getAttribute("data-automation-id") || "" });
        }
        const checkboxCandidates = [...document.querySelectorAll('input[type="checkbox"]')]
          .filter(visible)
          .filter((checkbox) => {
            const text = normalize([
              labelFor(checkbox),
              metadataFor(checkbox),
              checkbox.closest("label")?.innerText,
              checkbox.closest('[data-automation-id], section, div')?.innerText,
            ].filter(Boolean).join(" "));
            return /privacy notice|terms|condition|consent|agree|acknowledge|continuing|create account|createAccountCheckbox/i.test(text);
          });
        const checked = [];
        for (const checkbox of checkboxCandidates) {
          const rect = rectFor(checkbox);
          checked.push({
            id: checkbox.id || "",
            automationId: checkbox.getAttribute("data-automation-id") || "",
            checked: Boolean(checkbox.checked),
            rect,
          });
        }
        const controls = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href]')]
          .filter(visible)
          .map((el) => {
            const label = labelFor(el);
            const metadata = metadataFor(el);
            const tag = String(el.tagName || "").toLowerCase();
            const type = String(el.getAttribute("type") || "").toLowerCase();
            let score = 0;
            const compactSignal = String(label + " " + metadata).toLowerCase().replace(/[^a-z0-9]+/g, "");
            const signupSignal = /^create account(?: create account)?$/i.test(label) || /\\b(create account|sign up|signup|register|join today)\\b/i.test(label + " " + metadata);
            const emailSigninSignal = compactSignal.includes("signinwithemailbutton") || /\\bsign in with email\\b|\\bsign in using email\\b|\\bemail sign in\\b/i.test(label);
            const signinSignal = /^sign in(?: sign in)?$/i.test(label) || /\\b(sign in|log in|login)\\b/i.test(label + " " + metadata);
            const submitSignal = /^submit$/i.test(label);
            if (desiredAuthState === "signup") {
              if (signupSignal) score += 170;
              else if (submitSignal && desiredAuthUiState === "signup_form") score += 130;
              else if (emailSigninSignal && desiredAuthUiState === "landing_choice") score += 95;
              else if (signinSignal) score -= 120;
            } else if (desiredAuthState === "login" || desiredAuthState === "signin") {
              if (emailSigninSignal && desiredAuthUiState === "landing_choice") score += 155;
              else if (signinSignal) score += 140;
              else if (submitSignal && desiredAuthUiState === "credential_form") score += 130;
              else if (signupSignal) score -= 80;
            } else if (signupSignal) score += 140;
            else if (emailSigninSignal) score += 135;
            else if (signinSignal) score += 120;
            else if (submitSignal) score += 110;
            if (tag === "button" || type === "submit") score += 30;
            if (/submitbutton/i.test(metadata)) score += 25;
            if (/click_filter/i.test(metadata)) score += 45;
            if (/utility|navigation|search for jobs|backtojobposting|forgotpassword/i.test(metadata)) score -= 80;
            return { el, label, metadata, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        if (!controls.length) {
          return { clicked: false, reason: "auth_primary_not_found", checked, currentStepText };
        }
        const target = controls[0];
        return {
          clicked: false,
          reason: "auth_primary_target_found",
          label: target.label,
          metadata: target.metadata,
          rect: rectFor(target.el),
          filled,
          checked,
          href: location.href,
          title: document.title,
          bodyHead: normalize(document.body?.innerText || "").slice(0, 800),
        };
      })()`,
      30000,
    );
    if (result?.rect) {
      for (const checkbox of result.checked || []) {
        if (!checkbox?.checked) {
          const checkboxRect = await this.pageClient.evaluate(
            `(() => {
              const id = ${this.js(checkbox.id || "")};
              const automationId = ${this.js(checkbox.automationId || "")};
              const visible = (el) => {
                if (!el) return false;
                if (String(el.getAttribute("aria-hidden") || "").toLowerCase() === "true") return false;
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
              };
              const candidates = [...document.querySelectorAll('input[type="checkbox"]')]
                .filter(visible)
                .filter((el) =>
                  (id && el.id === id) ||
                  (automationId && el.getAttribute("data-automation-id") === automationId)
                );
              const target = candidates[0];
              if (!target) return null;
              target.scrollIntoView({ block: "center", inline: "center" });
              try { target.focus?.(); } catch (_error) {}
              const rect = target.getBoundingClientRect();
              return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            })()`,
            10000,
          );
          if (checkboxRect) {
            await this.cdpClick(
              this.pageClient,
              checkboxRect.x,
              checkboxRect.y,
            );
          }
          await this.sleep(300);
        }
      }
      const currentTargetRect = await this.pageClient.evaluate(
        `(() => {
          const label = ${this.js(result.label || "")};
          const metadata = ${this.js(result.metadata || "")};
          const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
          const visible = (el) => {
            if (!el) return false;
            if (String(el.getAttribute("aria-hidden") || "").toLowerCase() === "true") return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
          };
          const labelFor = (el) => normalize([
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.value,
            el.innerText,
            el.textContent,
          ].filter(Boolean).join(" "));
          const metadataFor = (el) => normalize([
            el.id,
            el.name,
            el.type,
            el.getAttribute("data-automation-id"),
            el.getAttribute("data-testid"),
            el.className,
          ].filter(Boolean).join(" "));
          const target = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href]')]
            .filter(visible)
            .find((el) => labelFor(el) === label && metadataFor(el) === metadata);
          if (!target) return null;
          target.scrollIntoView({ block: "center", inline: "center" });
          try { target.focus?.(); } catch (_error) {}
          const rect = target.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          };
        })()`,
        10000,
      );
      if (currentTargetRect) {
        result.rect = currentTargetRect;
      }
      await this.cdpClick(this.pageClient, result.rect.x, result.rect.y);
      result.clicked = true;
      result.reason = "auth_primary_cdp_clicked";
    }
    await this.sleep(5500);
    await this.sleep(1200);
    const after = await this.inspectPage(this.pageClient);
    const afterText = String(after?.bodyHead || "");
    if (result?.clicked && this.authVerificationPattern.test(afterText)) {
      return {
        ...result,
        after,
        reason: "auth_verification_required",
        message: "Workday requires account verification before sign-in can continue.",
      };
    }
    return { ...result, after };
  }
}

module.exports = {
  WorkdayAuthWorkflow,
};
