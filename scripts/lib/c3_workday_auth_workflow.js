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
    allowForeground = false,
  }) {
    this.pageClient = pageClient;
    this.cdpClick = cdpClick;
    this.inspectPage = inspectPage;
    this.js = js;
    this.sleep = sleep;
    this.authVerificationPattern = authVerificationPattern;
    this.accountEmail = accountEmail;
    this.accountPassword = accountPassword;
    this.allowForeground = allowForeground === true;
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
        const titleText = normalize(document.title || "");
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
        const authTextPattern = /create account|sign[\\s_-]*in|log[\\s_-]*in|login|register|sign[\\s_-]*up|signup|signin/i;
        const isAuthStep = authTextPattern.test(currentStepText)
          || authTextPattern.test(titleText)
          || /create account|verify new password|already have an account|career privacy notice|email address\\*.*password\\*|forgot your password/i.test(bodyText);
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
        const checkboxCandidates = [
          ...document.querySelectorAll('input[type="checkbox"]'),
          ...document.querySelectorAll('[role="checkbox"]'),
          ...document.querySelectorAll('[data-uxi-widget-type*="checkbox" i]'),
        ]
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
        const selectorFor = (el) => {
          if (!el) return "";
          if (el.id) return "#" + CSS.escape(el.id);
          const automationId = el.getAttribute("data-automation-id");
          if (automationId) return '[data-automation-id="' + CSS.escape(automationId) + '"]';
          const name = el.getAttribute("name");
          if (name) return String(el.tagName || "").toLowerCase() + '[name="' + CSS.escape(name) + '"]';
          return "";
        };
        const checked = [];
        for (const checkbox of checkboxCandidates) {
          const label =
            (checkbox.id && document.querySelector('label[for="' + CSS.escape(checkbox.id) + '"]')) ||
            checkbox.closest("label") ||
            checkbox.closest('[data-automation-id*="checkbox"], [data-automation-id*="Checkbox"], [role="checkbox"], div, section');
          const proxy =
            checkbox.closest('[data-automation-id*="checkbox"], [data-automation-id*="Checkbox"], [role="checkbox"], [data-uxi-widget-type], label') ||
            label;
          const rect = rectFor(checkbox);
          const isRoleCheckbox = checkbox instanceof HTMLInputElement === false;
          checked.push({
            id: checkbox.id || "",
            automationId: checkbox.getAttribute("data-automation-id") || "",
            role: checkbox.getAttribute("role") || "",
            checked: isRoleCheckbox
              ? checkbox.getAttribute("aria-checked") === "true"
              : Boolean(checkbox.checked),
            rect,
            selector: selectorFor(checkbox),
            labelRect: label && visible(label) ? rectFor(label) : null,
            proxyRect: proxy && visible(proxy) ? rectFor(proxy) : null,
          });
        }
        const controlSelectors = [
          'button',
          '[role="button"]',
          'input[type="button"]',
          'input[type="submit"]',
          'a[href]',
        ];
        if (desiredAuthUiState === "landing_choice") {
          controlSelectors.push('[data-automation-id]', '[data-testid]', 'div', 'span');
        }
        const seenControls = new Set();
        const controls = [...document.querySelectorAll(controlSelectors.join(", "))]
          .filter(visible)
          .filter((el) => {
            if (seenControls.has(el)) return false;
            seenControls.add(el);
            return true;
          })
          .map((el) => {
            const label = labelFor(el);
            const metadata = metadataFor(el);
            const tag = String(el.tagName || "").toLowerCase();
            const type = String(el.getAttribute("type") || "").toLowerCase();
            let score = 0;
            const compactSignal = String(label + " " + metadata).toLowerCase().replace(/[^a-z0-9]+/g, "");
            const stableSignupSubmit = /createaccountsubmitbutton/i.test(metadata) || /wdres\\.auth\\.label\\.createaccount/i.test(label + " " + metadata);
            const stableSigninSubmit = /signinsubmitbutton/i.test(metadata) || /wdres\\.auth\\.label\\.signin/i.test(label + " " + metadata);
            const signupSignal = stableSignupSubmit || /^create account(?: create account)?$/i.test(label) || /\\b(create account|sign up|signup|register|join today)\\b/i.test(label + " " + metadata);
            const emailSigninSignal = compactSignal.includes("signinwithemailbutton") || /\\bsign in with email\\b|\\bsign in using email\\b|\\bemail sign in\\b/i.test(label);
            const signinSignal = stableSigninSubmit || /^sign in(?: sign in)?$/i.test(label) || /\\b(sign in|log in|login)\\b/i.test(label + " " + metadata);
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
            if (/submitbutton|signinsubmitbutton|createaccountsubmitbutton/i.test(metadata)) score += 25;
            if (/click_filter/i.test(metadata)) score += 45;
            if (/utility|navigation|search for jobs|backtojobposting|forgotpassword/i.test(metadata)) score -= 80;
            return { el, label, metadata, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        if ((desiredAuthState === "login" || desiredAuthState === "signin") && passwordInputs.length) {
          const form = passwordInputs[0].closest("form");
          const submit = form && [...form.querySelectorAll('button, input[type="submit"], [role="button"]')]
            .filter(visible)
            .find((el) => /^(sign in|log in|login|submit)$/i.test(labelFor(el)));
          if (submit) {
            controls.unshift({
              el: submit,
              label: labelFor(submit),
              metadata: metadataFor(submit) + " credential_form_submit",
              score: 999,
            });
          }
        }
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
          noCaptchaWrapper: (() => {
            const el = document.querySelector('[data-automation-id="noCaptchaWrapper"]');
            if (!el) return { present: false };
            const r = el.getBoundingClientRect();
            return {
              present: true,
              hasPasswordInput: Boolean(el.querySelector('input[type="password"]')),
              hasEmailInput: Boolean(el.querySelector('input[type="email"], input[type="text"]')),
              hasSubmitButton: Boolean(el.querySelector('[data-automation-id*="submit"], [data-automation-id*="Submit"], [data-automation-id*="signIn"], button[type="submit"]')),
              hasLandingChoiceButton: Boolean(el.querySelector('[data-automation-id="signIn"], [data-automation-id="createAccount"], [data-automation-id="signInWithEmail"]')),
              rect: { w: Math.round(r.width), h: Math.round(r.height) },
            };
          })(),
          noCaptchaWrapperPresent: Boolean(document.querySelector('[data-automation-id="noCaptchaWrapper"]')),
          href: location.href,
          title: document.title,
          bodyHead: normalize(document.body?.innerText || "").slice(0, 800),
        };
      })()`,
      30000,
    );
    if (result?.rect) {
      const readCheckboxState = async (checkbox) =>
        this.pageClient.evaluate(
          `(() => {
            const id = ${this.js(checkbox?.id || "")};
            const automationId = ${this.js(checkbox?.automationId || "")};
            const selector = ${this.js(checkbox?.selector || "")};
            const candidates = [
              selector ? document.querySelector(selector) : null,
              id ? document.getElementById(id) : null,
              automationId ? document.querySelector('[data-automation-id="' + CSS.escape(automationId) + '"]') : null,
            ].filter(Boolean);
            const target = candidates.find((el) => el.matches?.('input[type="checkbox"]')) || candidates[0];
            if (!target) return { found: false, checked: false };
            return {
              found: true,
              checked: Boolean(target.checked) || target.getAttribute("aria-checked") === "true",
              ariaChecked: target.getAttribute("aria-checked") || "",
              disabled: Boolean(target.disabled) || target.getAttribute("aria-disabled") === "true",
            };
          })()`,
          10000,
        );
      const forceCheckboxChecked = async (checkbox) =>
        this.pageClient.evaluate(
          `(() => {
            const id = ${this.js(checkbox?.id || "")};
            const automationId = ${this.js(checkbox?.automationId || "")};
            const selector = ${this.js(checkbox?.selector || "")};
            const candidates = [
              selector ? document.querySelector(selector) : null,
              id ? document.getElementById(id) : null,
              automationId ? document.querySelector('[data-automation-id="' + CSS.escape(automationId) + '"]') : null,
            ].filter(Boolean);
            const target = candidates.find((el) => el.matches?.('input[type="checkbox"]')) || candidates[0];
            if (!target) return { ok: false, reason: "checkbox_not_found" };
            target.scrollIntoView({ block: "center", inline: "center" });
            try { target.focus?.({ preventScroll: true }); } catch (_error) {}
            const isNativeCheckbox = target instanceof HTMLInputElement && target.type === "checkbox";
            let domClickAttempted = false;
            if (isNativeCheckbox) {
              if (!target.checked && typeof target.click === "function") {
                domClickAttempted = true;
                target.click();
              }
              if (!target.checked) {
                const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
                if (descriptor?.set) descriptor.set.call(target, true);
                else target.checked = true;
              }
            } else if (target.getAttribute("aria-checked") !== "true" && typeof target.click === "function") {
              domClickAttempted = true;
              target.click();
            }
            target.setAttribute("aria-checked", "true");
            target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertReplacementText", data: "true" }));
            target.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new Event("blur", { bubbles: true }));
            return {
              ok: (isNativeCheckbox ? Boolean(target.checked) : true) || target.getAttribute("aria-checked") === "true",
              checked: isNativeCheckbox ? Boolean(target.checked) : null,
              ariaChecked: target.getAttribute("aria-checked") || "",
              domClickAttempted,
            };
          })()`,
          10000,
        );
      result.checkboxCommitTrace = [];
      for (const checkbox of result.checked || []) {
        if (!checkbox?.checked) {
          const attempts = [
            { method: "input_cdp", rect: checkbox.rect },
            { method: "label_cdp", rect: checkbox.labelRect },
            { method: "proxy_cdp", rect: checkbox.proxyRect },
          ].filter((entry) => entry.rect);
          for (const attempt of attempts) {
            await this.cdpClick(this.pageClient, attempt.rect.x, attempt.rect.y);
            await this.sleep(250);
            const state = await readCheckboxState(checkbox);
            result.checkboxCommitTrace.push({ ...attempt, state });
            if (state?.checked) break;
          }
          const committed = await readCheckboxState(checkbox);
          const forced = await forceCheckboxChecked(checkbox);
          await this.sleep(250);
          const forcedState = await readCheckboxState(checkbox);
          result.checkboxCommitTrace.push({
            method: committed?.checked
              ? "native_checked_setter_after_checked_readback"
              : "native_checked_setter",
            forced,
            state: forcedState,
          });
          const finalState = await readCheckboxState(checkbox);
          if (!finalState?.checked) {
            return {
              ...result,
              clicked: false,
              ok: false,
              reason: "auth_checkbox_not_committed",
              message:
                "Workday auth consent checkbox did not commit after input, label, proxy, and native setter attempts.",
              checkboxCommitTrace: result.checkboxCommitTrace,
            };
          }
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
      const rectContainsPoint = (rect, point) =>
        Boolean(
          rect &&
            point &&
            Number.isFinite(Number(rect.x)) &&
            Number.isFinite(Number(rect.y)) &&
            Number.isFinite(Number(rect.width)) &&
            Number.isFinite(Number(rect.height)) &&
            Number(point.x) >= Number(rect.x) &&
            Number(point.x) <= Number(rect.x) + Number(rect.width) &&
            Number(point.y) >= Number(rect.y) &&
            Number(point.y) <= Number(rect.y) + Number(rect.height),
        );
      const targetOverlapsAuthCheckbox = (result.checked || []).some((checkbox) =>
        [checkbox.rect, checkbox.labelRect, checkbox.proxyRect].some((rect) =>
          rectContainsPoint(rect, result.rect),
        ),
      );
      const routeAuthUiState = String(route?.authUiState || "").toLowerCase();
      const shouldDeferPrimaryCdpClick =
        routeAuthUiState !== "landing_choice" &&
        (Boolean((result.filled || []).length) ||
          /click_filter|submitbutton|createaccount|signin|credential_form_submit/i.test(
            String(result.metadata || ""),
          ));
      const shouldBringAuthPageToFront =
        this.allowForeground === true &&
        shouldDeferPrimaryCdpClick &&
        Boolean(result.noCaptchaWrapperPresent || result.noCaptchaWrapper?.present);
      if (shouldBringAuthPageToFront) {
        try {
          await this.pageClient.send("Page.bringToFront");
          result.broughtToFrontBeforeAuthSubmit = true;
          await this.sleep(250);
        } catch (error) {
          result.broughtToFrontBeforeAuthSubmit = false;
          result.bringToFrontBeforeAuthSubmitError = String(error?.message || error);
        }
      }
      const shouldPrimeNoCaptchaSubmit =
        shouldDeferPrimaryCdpClick &&
        targetOverlapsAuthCheckbox &&
        Boolean(result.noCaptchaWrapperPresent || result.noCaptchaWrapper?.present);
      if (!shouldDeferPrimaryCdpClick || shouldPrimeNoCaptchaSubmit) {
        await this.cdpClick(this.pageClient, result.rect.x, result.rect.y);
        if (shouldPrimeNoCaptchaSubmit) {
          await this.sleep(1200);
          const refilledAfterPrime = await this.pageClient.evaluate(
            `(() => {
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
              const visible = (el) => {
                if (!el) return false;
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
              };
              const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
              const inputText = (el) => normalize([
                el.getAttribute("data-automation-id"),
                el.id,
                el.name,
                el.type,
                el.autocomplete,
                el.placeholder,
                el.getAttribute("aria-label"),
              ].filter(Boolean).join(" "));
              const inputs = [...document.querySelectorAll('input:not([type="hidden"])')]
                .filter((el) => el.name !== "website" && visible(el));
              const emailInput = inputs.find((el) => /email|username|user/i.test(inputText(el)) && el.type !== "password");
              const passwords = inputs.filter((el) => el.type === "password");
              const filled = [];
              if (emailInput && accountEmail) {
                setNativeValue(emailInput, accountEmail);
                filled.push("email");
              }
              if (passwords[0] && accountPassword) {
                setNativeValue(passwords[0], accountPassword);
                filled.push("password");
              }
              if (passwords[1] && accountPassword) {
                setNativeValue(passwords[1], accountPassword);
                filled.push("verifyPassword");
              }
              return { ok: true, filled };
            })()`,
            10000,
          ).catch((error) => ({
            ok: false,
            reason: "refill_after_nocaptcha_prime_error",
            message: String(error?.message || error),
          }));
          result.checkboxCommitTrace.push({
            method: "refill_credentials_after_nocaptcha_prime",
            result: refilledAfterPrime,
          });
          for (const checkbox of result.checked || []) {
            const forced = await forceCheckboxChecked(checkbox);
            await this.sleep(250);
            const state = await readCheckboxState(checkbox);
            result.checkboxCommitTrace.push({
              method: "native_checked_setter_after_nocaptcha_prime",
              forced,
              state,
            });
          }
        }
      }
      let hiddenSubmitResult = null;
      let afterHiddenSubmit = null;
      let hiddenSubmitChanged = false;
      const formSubmitResult = await this.pageClient.evaluate(
          `(() => {
          const label = ${this.js(result.label || "")};
          const metadata = ${this.js(result.metadata || "")};
          const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
          const visible = (el) => {
            if (!el) return false;
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
            .find((el) => labelFor(el) === label && (metadataFor(el) === metadata || ${this.js(result.metadata || "")}.includes("credential_form_submit")));
          if (!target) return { ok: false, reason: "target_not_found_for_form_submit" };
          const form = target.closest("form");
          if (form && typeof form.requestSubmit === "function") {
            try {
              form.requestSubmit(target.matches('button, input') ? target : undefined);
              return { ok: true, reason: "form_request_submit" };
            } catch (_error) {}
          }
          if (typeof target.click === "function") {
            target.click();
            return { ok: true, reason: "target_click" };
          }
          return { ok: false, reason: "no_submit_method" };
        })()`,
          10000,
        ).catch(() => null);
      const shouldSettleAfterFormRequestSubmit =
        Boolean(formSubmitResult?.ok) &&
        /request_submit|requestSubmit|form_request_submit/i.test(
          String(formSubmitResult?.reason || ""),
        ) &&
        Boolean(result.noCaptchaWrapperPresent || result.noCaptchaWrapper?.present);
      if (shouldSettleAfterFormRequestSubmit) {
        await this.sleep(3500);
      }
      const afterFormSubmit = await this.inspectPage(this.pageClient).catch(() => null);
      let formSubmitChanged =
        String(afterFormSubmit?.href || "") !== String(result.href || "") ||
        String(afterFormSubmit?.title || "") !== String(result.title || "") ||
        Boolean((afterFormSubmit?.errors || []).length) ||
        !/create account|sign[\s_-]*in|log[\s_-]*in|login|register|sign[\s_-]*up|signup|signin|auth/i.test(
          String(afterFormSubmit?.currentStep?.title || afterFormSubmit?.pageKind || afterFormSubmit?.title || afterFormSubmit?.bodyHead || ""),
        );
      if (!formSubmitChanged) {
        hiddenSubmitResult = await this.pageClient.evaluate(
          `(() => {
            const target =
              document.querySelector('[data-automation-id="createAccountSubmitButton"]') ||
              document.querySelector('[data-automation-id="signInSubmitButton"]');
            if (!target) return { ok: false, reason: "hidden_submit_not_found" };
            const form = target.closest("form");
            try {
              if (form && typeof form.requestSubmit === "function") {
                form.requestSubmit(target);
                return {
                  ok: true,
                  reason: "hidden_submit_request_submit_after_form_no_progress",
                  automationId: target.getAttribute("data-automation-id") || "",
                };
              }
              if (typeof target.click === "function") {
                target.click();
                return {
                  ok: true,
                  reason: "hidden_submit_click_after_form_no_progress",
                  automationId: target.getAttribute("data-automation-id") || "",
                };
              }
            } catch (error) {
              return { ok: false, reason: "hidden_submit_error", message: String(error?.message || error) };
            }
            return { ok: false, reason: "hidden_submit_no_method" };
          })()`,
          10000,
        ).catch((error) => ({
          ok: false,
          reason: "hidden_submit_probe_error",
          message: String(error?.message || error),
        }));
        afterHiddenSubmit = hiddenSubmitResult?.ok
          ? await this.inspectPage(this.pageClient).catch(() => null)
          : null;
        hiddenSubmitChanged =
          afterHiddenSubmit &&
          (String(afterHiddenSubmit?.href || "") !== String(result.href || "") ||
            String(afterHiddenSubmit?.title || "") !== String(result.title || "") ||
            Boolean((afterHiddenSubmit?.errors || []).length) ||
            !/create account|sign[\s_-]*in|log[\s_-]*in|login|register|sign[\s_-]*up|signup|signin|auth/i.test(
              String(afterHiddenSubmit?.currentStep?.title || afterHiddenSubmit?.pageKind || afterHiddenSubmit?.title || afterHiddenSubmit?.bodyHead || ""),
            ));
        formSubmitChanged = formSubmitChanged || Boolean(hiddenSubmitChanged);
      }
      const targetClickAfterNoProgress = formSubmitChanged
        || targetOverlapsAuthCheckbox
        ? null
        : await this.pageClient.evaluate(
            `(() => {
              const label = ${this.js(result.label || "")};
              const metadata = ${this.js(result.metadata || "")};
              const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
              const visible = (el) => {
                if (!el) return false;
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
              const target = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[href], [data-automation-id="click_filter"]')]
                .filter(visible)
                .find((el) => labelFor(el) === label && (metadataFor(el) === metadata || ${this.js(result.metadata || "")}.includes("credential_form_submit")));
              if (!target || typeof target.click !== "function") return { ok: false, reason: "target_not_found_for_click_fallback" };
              target.scrollIntoView({ block: "center", inline: "center" });
              target.click();
              return { ok: true, reason: "target_click_after_request_submit_no_progress" };
            })()`,
            10000,
          ).catch((error) => ({ ok: false, reason: "target_click_fallback_error", message: String(error?.message || error) }));
      const afterTargetClickFallback = targetClickAfterNoProgress?.ok
        ? await this.inspectPage(this.pageClient).catch(() => null)
        : null;
      const targetClickFallbackChanged =
        afterTargetClickFallback &&
        (String(afterTargetClickFallback?.href || "") !== String(result.href || "") ||
          String(afterTargetClickFallback?.title || "") !== String(result.title || "") ||
          Boolean((afterTargetClickFallback?.errors || []).length) ||
          !/create account|sign[\s_-]*in|log[\s_-]*in|login|register|sign[\s_-]*up|signup|signin|auth/i.test(
            String(afterTargetClickFallback?.currentStep?.title || afterTargetClickFallback?.pageKind || afterTargetClickFallback?.title || afterTargetClickFallback?.bodyHead || ""),
          ));
      let domPointerClickFilterResult = null;
      let afterDomPointerClickFilter = null;
      if (!formSubmitChanged && !targetClickFallbackChanged && !targetOverlapsAuthCheckbox && /click_filter|submitbutton|createaccount|signin/i.test(String(result.metadata || ""))) {
        domPointerClickFilterResult = await this.pageClient.evaluate(
          `(() => {
            const label = ${this.js(result.label || "")};
            const metadata = ${this.js(result.metadata || "")};
            const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
            const visible = (el) => {
              if (!el) return false;
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
            const clickFilters = [...document.querySelectorAll('[data-automation-id="click_filter"]')].filter(visible);
            const target =
              clickFilters.find((el) => labelFor(el) === label && metadataFor(el) === metadata) ||
              clickFilters.find((el) => /create account|sign in|submit/i.test(labelFor(el) + " " + metadataFor(el))) ||
              clickFilters[0];
            if (!target) return { ok: false, reason: "click_filter_not_found_for_dom_pointer" };
            target.scrollIntoView({ block: "center", inline: "center" });
            try { target.focus?.({ preventScroll: true }); } catch (_error) {}
            const rect = target.getBoundingClientRect();
            const init = {
              bubbles: true,
              cancelable: true,
              view: window,
              button: 0,
              buttons: 1,
              clientX: Math.round(rect.left + rect.width / 2),
              clientY: Math.round(rect.top + rect.height / 2),
            };
            for (const type of ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown"]) {
              const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
              target.dispatchEvent(new Ctor(type, init));
            }
            target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
            target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
            target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
            return {
              ok: true,
              reason: "dom_pointer_click_filter_after_no_progress",
              label: labelFor(target),
              metadata: metadataFor(target),
            };
          })()`,
          10000,
        ).catch((error) => ({
          ok: false,
          reason: "dom_pointer_click_filter_error",
          message: String(error?.message || error),
        }));
        if (domPointerClickFilterResult?.ok) {
          await this.sleep(1500);
          afterDomPointerClickFilter = await this.inspectPage(this.pageClient).catch(() => null);
        }
      }
      const domPointerClickFilterChanged =
        afterDomPointerClickFilter &&
        (String(afterDomPointerClickFilter?.href || "") !== String(result.href || "") ||
          String(afterDomPointerClickFilter?.title || "") !== String(result.title || "") ||
          Boolean((afterDomPointerClickFilter?.errors || []).length) ||
          !/create account|sign[\s_-]*in|log[\s_-]*in|login|register|sign[\s_-]*up|signup|signin|auth/i.test(
            String(afterDomPointerClickFilter?.currentStep?.title || afterDomPointerClickFilter?.pageKind || afterDomPointerClickFilter?.title || afterDomPointerClickFilter?.bodyHead || ""),
          ));
      let settledDomPointerClickFilterResult = null;
      let afterSettledDomPointerClickFilter = null;
      if (!formSubmitChanged && !targetClickFallbackChanged && !domPointerClickFilterChanged && !targetOverlapsAuthCheckbox && /click_filter|submitbutton|createaccount|signin/i.test(String(result.metadata || ""))) {
        await this.pageClient.evaluate(`document.activeElement?.blur?.()`, 5000).catch(() => false);
        await this.sleep(1800);
        settledDomPointerClickFilterResult = await this.pageClient.evaluate(
          `(() => {
            const label = ${this.js(result.label || "")};
            const metadata = ${this.js(result.metadata || "")};
            const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
            const visible = (el) => {
              if (!el) return false;
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
            const clickFilters = [...document.querySelectorAll('[data-automation-id="click_filter"]')].filter(visible);
            const target =
              clickFilters.find((el) => labelFor(el) === label && metadataFor(el) === metadata) ||
              clickFilters.find((el) => /create account|sign in|submit/i.test(labelFor(el) + " " + metadataFor(el))) ||
              clickFilters[0];
            if (!target) return { ok: false, reason: "click_filter_not_found_for_settled_dom_pointer" };
            target.scrollIntoView({ block: "center", inline: "center" });
            try { target.focus?.({ preventScroll: true }); } catch (_error) {}
            const rect = target.getBoundingClientRect();
            const init = {
              bubbles: true,
              cancelable: true,
              view: window,
              button: 0,
              buttons: 1,
              clientX: Math.round(rect.left + rect.width / 2),
              clientY: Math.round(rect.top + rect.height / 2),
            };
            for (const type of ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown"]) {
              const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
              target.dispatchEvent(new Ctor(type, init));
            }
            target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
            target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
            target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
            return {
              ok: true,
              reason: "blur_settle_dom_pointer_click_filter_after_no_progress",
              label: labelFor(target),
              metadata: metadataFor(target),
            };
          })()`,
          10000,
        ).catch((error) => ({
          ok: false,
          reason: "settled_dom_pointer_click_filter_error",
          message: String(error?.message || error),
        }));
        if (settledDomPointerClickFilterResult?.ok) {
          await this.sleep(1500);
          afterSettledDomPointerClickFilter = await this.inspectPage(this.pageClient).catch(() => null);
        }
      }
      const settledDomPointerClickFilterChanged =
        afterSettledDomPointerClickFilter &&
        (String(afterSettledDomPointerClickFilter?.href || "") !== String(result.href || "") ||
          String(afterSettledDomPointerClickFilter?.title || "") !== String(result.title || "") ||
          Boolean((afterSettledDomPointerClickFilter?.errors || []).length) ||
          !/create account|sign[\s_-]*in|log[\s_-]*in|login|register|sign[\s_-]*up|signup|signin|auth/i.test(
            String(afterSettledDomPointerClickFilter?.currentStep?.title || afterSettledDomPointerClickFilter?.pageKind || afterSettledDomPointerClickFilter?.title || afterSettledDomPointerClickFilter?.bodyHead || ""),
          ));
      let delayedClickFilterResult = null;
      let afterDelayedClickFilter = null;
      if (!formSubmitChanged && !targetClickFallbackChanged && !domPointerClickFilterChanged && !settledDomPointerClickFilterChanged && !targetOverlapsAuthCheckbox && /click_filter|submitbutton|createaccount|signin/i.test(String(result.metadata || ""))) {
        await this.sleep(650);
        delayedClickFilterResult = await this.pageClient.evaluate(
          `(() => {
            const label = ${this.js(result.label || "")};
            const metadata = ${this.js(result.metadata || "")};
            const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
            const visible = (el) => {
              if (!el) return false;
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
            const clickFilters = [...document.querySelectorAll('[data-automation-id="click_filter"]')].filter(visible);
            const target =
              clickFilters.find((el) => labelFor(el) === label && metadataFor(el) === metadata) ||
              clickFilters.find((el) => /create account|sign in|submit/i.test(labelFor(el) + " " + metadataFor(el))) ||
              clickFilters[0];
            if (!target) return { ok: false, reason: "click_filter_not_found_for_delayed_cdp" };
            target.scrollIntoView({ block: "center", inline: "center" });
            try { target.focus?.({ preventScroll: true }); } catch (_error) {}
            const rect = target.getBoundingClientRect();
            return {
              ok: true,
              reason: "delayed_click_filter_cdp_after_no_progress",
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              label: labelFor(target),
              metadata: metadataFor(target),
            };
          })()`,
          10000,
        ).catch((error) => ({
          ok: false,
          reason: "delayed_click_filter_probe_error",
          message: String(error?.message || error),
        }));
        if (delayedClickFilterResult?.ok) {
          await this.cdpClick(
            this.pageClient,
            delayedClickFilterResult.x,
            delayedClickFilterResult.y,
          );
          await this.sleep(1500);
          afterDelayedClickFilter = await this.inspectPage(this.pageClient).catch(() => null);
        }
      }
      if (/credential_form_submit/i.test(String(result.metadata || ""))) {
        await this.pageClient
          .evaluate(
            `(() => {
              const password = [...document.querySelectorAll('input[type="password"]')]
                .filter((el) => {
                  const style = getComputedStyle(el);
                  const rect = el.getBoundingClientRect();
                  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled;
                })[0];
              if (!password) return false;
              password.scrollIntoView({ block: "center", inline: "center" });
              password.focus?.({ preventScroll: true });
              return true;
            })()`,
            10000,
          )
          .catch(() => false);
        await this.pageClient.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await this.pageClient.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
      }
      result.authSubmitTrace = [];
      result.authSubmitTrace.push({
        method: "target_form_submit",
        result: formSubmitResult,
        stateBefore: { href: result.href || "" },
        stateAfter: afterFormSubmit
          ? {
              href: afterFormSubmit.href,
              title: afterFormSubmit.title,
              errors: afterFormSubmit.errors || [],
            }
          : null,
      });
      if (hiddenSubmitResult) {
        result.authSubmitTrace.push({
          method: "hidden_submit_after_form_no_progress",
          result: hiddenSubmitResult,
          stateBefore: afterFormSubmit
            ? {
                href: afterFormSubmit.href,
                title: afterFormSubmit.title,
                errors: afterFormSubmit.errors || [],
              }
            : null,
          stateAfter: afterHiddenSubmit
            ? {
                href: afterHiddenSubmit.href,
                title: afterHiddenSubmit.title,
                errors: afterHiddenSubmit.errors || [],
              }
            : null,
        });
      }
      if (targetClickAfterNoProgress) {
        result.authSubmitTrace.push({
          method: "target_click_after_request_submit_no_progress",
          result: targetClickAfterNoProgress,
          stateBefore: afterFormSubmit
            ? {
                href: afterFormSubmit.href,
                title: afterFormSubmit.title,
                errors: afterFormSubmit.errors || [],
              }
            : null,
          stateAfter: afterTargetClickFallback
            ? {
                href: afterTargetClickFallback.href,
                title: afterTargetClickFallback.title,
                errors: afterTargetClickFallback.errors || [],
              }
            : null,
        });
      }
      if (domPointerClickFilterResult) {
        result.authSubmitTrace.push({
          method: "dom_pointer_click_filter_after_no_progress",
          result: domPointerClickFilterResult,
          stateBefore: afterTargetClickFallback || afterFormSubmit
            ? {
                href: (afterTargetClickFallback || afterFormSubmit).href,
                title: (afterTargetClickFallback || afterFormSubmit).title,
                errors: (afterTargetClickFallback || afterFormSubmit).errors || [],
              }
            : null,
          stateAfter: afterDomPointerClickFilter
            ? {
                href: afterDomPointerClickFilter.href,
                title: afterDomPointerClickFilter.title,
              errors: afterDomPointerClickFilter.errors || [],
            }
            : null,
        });
      }
      if (settledDomPointerClickFilterResult) {
        result.authSubmitTrace.push({
          method: "blur_settle_dom_pointer_click_filter_after_no_progress",
          result: settledDomPointerClickFilterResult,
          stateBefore: afterDomPointerClickFilter || afterTargetClickFallback || afterFormSubmit
            ? {
                href: (afterDomPointerClickFilter || afterTargetClickFallback || afterFormSubmit).href,
                title: (afterDomPointerClickFilter || afterTargetClickFallback || afterFormSubmit).title,
                errors: (afterDomPointerClickFilter || afterTargetClickFallback || afterFormSubmit).errors || [],
              }
            : null,
          stateAfter: afterSettledDomPointerClickFilter
            ? {
                href: afterSettledDomPointerClickFilter.href,
                title: afterSettledDomPointerClickFilter.title,
                errors: afterSettledDomPointerClickFilter.errors || [],
              }
            : null,
        });
      }
      if (delayedClickFilterResult) {
        result.authSubmitTrace.push({
          method: "delayed_click_filter_cdp_after_no_progress",
          result: delayedClickFilterResult,
          stateBefore: afterSettledDomPointerClickFilter || afterTargetClickFallback || afterFormSubmit
            ? {
                href: (afterSettledDomPointerClickFilter || afterTargetClickFallback || afterFormSubmit).href,
                title: (afterSettledDomPointerClickFilter || afterTargetClickFallback || afterFormSubmit).title,
                errors: (afterSettledDomPointerClickFilter || afterTargetClickFallback || afterFormSubmit).errors || [],
              }
            : null,
          stateAfter: afterDelayedClickFilter
            ? {
                href: afterDelayedClickFilter.href,
                title: afterDelayedClickFilter.title,
                errors: afterDelayedClickFilter.errors || [],
              }
            : null,
        });
      }
      const targetMetadata = String(result.metadata || "");
      const targetLabel = String(result.label || "");
      const isCredentialFormSubmit = /credential_form_submit/i.test(targetMetadata);
      const isCreateAccountSubmit =
        /createaccountsubmitbutton|wdres\.auth\.label\.createaccount/i.test(targetMetadata) ||
        /^create account(?: create account)?$/i.test(targetLabel);
      const shouldTryNoCaptchaWrapper =
        (isCredentialFormSubmit || isCreateAccountSubmit) &&
        (result.noCaptchaWrapperPresent || result.noCaptchaWrapper?.present);
      if (shouldTryNoCaptchaWrapper) {
        const wrapperRect = await this.pageClient.evaluate(
          `(() => {
            const el = document.querySelector('[data-automation-id="noCaptchaWrapper"]');
            if (!el) return null;
            el.scrollIntoView({ block: "center", inline: "center" });
            try { el.focus?.(); } catch (_e) {}
            const rect = el.getBoundingClientRect();
            return rect.width > 0 ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
          })()`,
          5000,
        ).catch(() => null);
        const wrapperStateBefore = { href: result.href || "" };
        if (wrapperRect) {
          await this.cdpClick(this.pageClient, wrapperRect.x, wrapperRect.y);
          await this.sleep(1500);
          const afterCdp = await this.inspectPage(this.pageClient);
          result.authSubmitTrace.push({
            method: "nocaptcha_wrapper_cdp",
            stateBefore: wrapperStateBefore,
            stateAfter: { href: afterCdp?.href },
            elapsedMs: 1500,
          });
          if (afterCdp?.href === wrapperStateBefore.href) {
            await this.pageClient.evaluate(
              `(() => {
                const el = document.querySelector('[data-automation-id="noCaptchaWrapper"]');
                if (el && typeof el.click === "function") { el.click(); return true; }
                return false;
              })()`,
              5000,
            ).catch(() => false);
            await this.sleep(1000);
            const afterDom = await this.inspectPage(this.pageClient);
            result.authSubmitTrace.push({
              method: "nocaptcha_wrapper_dom_click",
              stateBefore: wrapperStateBefore,
              stateAfter: { href: afterDom?.href },
              elapsedMs: 1000,
            });
          }
        }
      }
      result.clicked = true;
      result.reason = "auth_primary_cdp_clicked";
    }
    const beforeState = route.state || {};
    const startedAt = Date.now();
    let after = await this.inspectPage(this.pageClient);
    let progressSignal = false;
    const isNoCaptchaAuthSubmit =
      Boolean(result?.noCaptchaWrapperPresent) &&
      (/credential_form_submit/i.test(String(result?.metadata || "")) ||
        /createaccountsubmitbutton|wdres\.auth\.label\.createaccount/i.test(String(result?.metadata || "")) ||
        /^create account(?: create account)?$/i.test(String(result?.label || "")) ||
        Boolean(result?.noCaptchaWrapper?.hasPasswordInput) ||
        (Array.isArray(result?.filled) && result.filled.length > 0));
    const maxWaitMs = isNoCaptchaAuthSubmit ? 22000 : 5000;
    const authTitleLike = (value) =>
      /create account|sign[\s_-]*in|log[\s_-]*in|login|register|sign[\s_-]*up|signup|signin|auth/i.test(
        String(value || ""),
      );
    const sameAuthUrl = (value) =>
      String(beforeState.href || "") === String(value || "");
    while (Date.now() - startedAt < maxWaitMs) {
      after = await this.inspectPage(this.pageClient);
      const afterText = String(after?.bodyHead || "");
      const afterHasCredentialFields =
        (after?.fields || []).some((field) => String(field?.type || "").toLowerCase() === "password") ||
        /email address\*.*password\*/i.test(afterText);
      const beforeHadCredentialFields =
        Number(beforeState.passwordCount || 0) > 0 ||
        /credential_form|signin_form|signup_form/i.test(String(beforeState.pageKind || ""));
      const credentialFieldsAppeared =
        afterHasCredentialFields && !beforeHadCredentialFields;
      const stillSameAuthScreen =
        sameAuthUrl(after?.href) &&
        authTitleLike(beforeState.currentStepText || beforeState.pageKind || beforeState.title) &&
        authTitleLike(after?.currentStep?.title || after?.pageKind || after?.title || afterText) &&
        !credentialFieldsAppeared &&
        !Boolean((after?.errors || []).length) &&
        !this.authVerificationPattern.test(afterText);
      progressSignal =
        !stillSameAuthScreen &&
        (credentialFieldsAppeared ||
        String(beforeState.href || "") !== String(after?.href || "") ||
        (String(beforeState.pageKind || "") !== String(after?.pageKind || "") &&
          !authTitleLike(beforeState.pageKind) &&
          !authTitleLike(after?.pageKind)) ||
        Boolean(after?.currentStep?.title && !authTitleLike(after.currentStep.title)) ||
        Boolean((after?.errors || []).length) ||
        this.authVerificationPattern.test(afterText));
      if (Date.now() - startedAt >= 1000 && progressSignal) {
        break;
      }
      await this.sleep(250);
    }
    const afterText = String(after?.bodyHead || "");
    if (result?.clicked && this.authVerificationPattern.test(afterText)) {
      return {
        ...result,
        after,
        reason: "auth_verification_required",
        message: "Workday requires account verification before sign-in can continue.",
      };
    }
    if (result?.clicked && !progressSignal) {
      const noCaptchaWrapperInfo =
        result.noCaptchaWrapper?.present
          ? result.noCaptchaWrapper
          : await this.pageClient
              .evaluate(
                `(() => {
                  const el = document.querySelector('[data-automation-id="noCaptchaWrapper"]');
                  if (!el) return { present: false };
                  const r = el.getBoundingClientRect();
                  return {
                    present: true,
                    hasPasswordInput: Boolean(el.querySelector('input[type="password"]')),
                    hasEmailInput: Boolean(el.querySelector('input[type="email"], input[type="text"]')),
                    hasSubmitButton: Boolean(el.querySelector('[data-automation-id*="submit"], [data-automation-id*="Submit"], [data-automation-id*="signIn"], button[type="submit"]')),
                    hasLandingChoiceButton: Boolean(el.querySelector('[data-automation-id="signIn"], [data-automation-id="createAccount"], [data-automation-id="signInWithEmail"]')),
                    rect: { w: Math.round(r.width), h: Math.round(r.height) },
                  };
                })()`,
                5000,
              )
              .catch(() => ({ present: false }));
      const noCaptchaWrapperPresent = Boolean(noCaptchaWrapperInfo?.present);
      const credentialsFilled = Array.isArray(result.filled) && result.filled.length > 0;
      const isCredentialFormSubmit = /credential_form_submit/i.test(String(result.metadata || ""));
      const isCreateAccountSubmit =
        /createaccountsubmitbutton|wdres\.auth\.label\.createaccount/i.test(String(result.metadata || "")) ||
        /^create account(?: create account)?$/i.test(String(result.label || ""));
      const wrapperWrapsCredentials = Boolean(
        noCaptchaWrapperInfo?.hasPasswordInput || noCaptchaWrapperInfo?.hasEmailInput,
      );
      const wrapperAttempted = (result.authSubmitTrace || []).some((entry) =>
        /^nocaptcha_wrapper_/.test(String(entry?.method || "")),
      );
      const isCredentialGate =
        noCaptchaWrapperPresent &&
        wrapperAttempted &&
        (credentialsFilled || isCredentialFormSubmit || isCreateAccountSubmit || wrapperWrapsCredentials) &&
        !noCaptchaWrapperInfo?.hasLandingChoiceButton;
      return {
        ...result,
        after,
        ok: false,
        noCaptchaWrapperPresent,
        noCaptchaWrapperInfo,
        reason: isCredentialGate ? "auth_no_captcha_gate" : "auth_no_progress",
        message: isCredentialGate
          ? "Clicked the Workday auth action, but the hidden noCaptcha wrapper kept the credential form on the same page with no visible errors."
          : noCaptchaWrapperPresent
            ? "Workday noCaptcha wrapper present but not on credential form — treating as no-progress to allow direct-login fallback."
            : "Clicked the Workday auth action, but URL, page kind, step, verification, and visible errors did not change.",
      };
    }
    return { ...result, after };
  }
}

module.exports = {
  WorkdayAuthWorkflow,
};
