"use strict";

const { js, sleep } = require("./c3_cdp");

class GoogleSignInManager {
  constructor({ cdpPort = 9222, email = "", password = "" } = {}) {
    this.cdpPort = cdpPort;
    this.email = email;
    this.password = password;
  }

  async cdpClick(pageClient, x, y) {
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    }, 5000);
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    }, 5000);
    await sleep(60);
    await pageClient.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    }, 5000);
  }

  async pressEnter(pageClient) {
    await pageClient.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    }, 5000);
    await pageClient.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    }, 5000);
  }

  async clickGoogleEntry(pageClient) {
    const result = await pageClient.evaluate(
      `(() => {
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const textOf = (el) => [
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.innerText,
          el.textContent
        ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
        const clickReal = (target) => {
          target.scrollIntoView({ block: "center", inline: "center" });
          const rect = target.getBoundingClientRect();
          const init = {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            buttons: 1,
            clientX: Math.round(rect.left + rect.width / 2),
            clientY: Math.round(rect.top + rect.height / 2)
          };
          ["mouseover", "mousemove", "pointerdown", "mousedown"].forEach((type) => target.dispatchEvent(new PointerEvent(type, init)));
          target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
          target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
          target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
        };
        const candidates = [...document.querySelectorAll("button, [role='button'], a")]
          .filter(visible)
          .map((el) => ({
            el,
            text: textOf(el),
            disabled: el.disabled || el.getAttribute("aria-disabled") === "true"
          }))
          .filter((item) => item.text && !item.disabled);
        const candidate = candidates.find((item) => /sign\\s*in\\s*with\\s*google|continue\\s*with\\s*google|google/i.test(item.text));
        if (!candidate) {
          return {
            ok: false,
            reason: "google_entry_not_found",
            buttons: candidates.map((item) => item.text).slice(0, 20),
            href: location.href
          };
        }
        clickReal(candidate.el);
        return {
          ok: true,
          clicked: true,
          label: candidate.text,
          href: location.href
        };
      })()`,
    );
    await sleep(3000);
    return result;
  }

  async fillGoogleAccountPage(pageClient) {
    const result = await pageClient.evaluate(
      `(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && (rect.width > 0 || rect.height > 0 || el.offsetParent !== null);
        };
        const setValue = (input, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          if (setter) {
            setter.call(input, value);
          } else {
            input.value = value;
          }
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const nextTarget = () => {
          const textOf = (el) => [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.innerText,
            el.textContent
          ].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
          const next = [...document.querySelectorAll("button, [role='button'], a")]
            .filter(visible)
            .find((el) => /^(next|continue)$/i.test(textOf(el)) || /identifierNext|passwordNext/i.test(el.id || ""));
          if (!next) {
            return null;
          }
          next.scrollIntoView({ block: "center", inline: "center" });
          const rect = next.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            text: textOf(next)
          };
        };
        const text = document.body ? document.body.innerText.replace(/\\s+/g, " ").trim() : "";
        if (/2-step verification|verification code|google authenticator|try another way/i.test(text)) {
          return {
            ok: false,
            manualRequired: true,
            reason: "google_totp_required",
            href: location.href,
            textHead: text.slice(0, 800)
          };
        }
        const emailInput =
          document.querySelector("input[type='email']") ||
          document.querySelector("input[name='identifier']");
        const passwordInput =
          document.querySelector("input[type='password']") ||
          document.querySelector("input[name='Passwd']");
        if (emailInput && visible(emailInput)) {
          emailInput.focus();
          setValue(emailInput, ${js(this.email)});
          await sleep(200);
          const next = nextTarget();
          return {
            ok: true,
            stage: "email_filled",
            nextTarget: next,
            href: location.href,
            textHead: text.slice(0, 500)
          };
        }
        if (passwordInput && visible(passwordInput) && ${js(Boolean(this.password))}) {
          passwordInput.focus();
          setValue(passwordInput, ${js(this.password)});
          await sleep(200);
          const next = nextTarget();
          return {
            ok: true,
            stage: "password_filled",
            nextTarget: next,
            href: location.href,
            textHead: text.slice(0, 500)
          };
        }
        const account = [...document.querySelectorAll("[data-identifier], [role='link'], [role='button'], button, div")]
          .filter(visible)
          .find((el) => (el.getAttribute("data-identifier") || el.innerText || "").toLowerCase().includes(${js(this.email.toLowerCase())}));
        if (account) {
          account.click();
          await sleep(500);
          return {
            ok: true,
            stage: "account_clicked",
            href: location.href,
            textHead: text.slice(0, 500)
          };
        }
        return {
          ok: false,
          reason: "google_account_page_not_actionable",
          href: location.href,
          textHead: text.slice(0, 800)
        };
      })()`,
      10000,
    );
    if (result?.nextTarget) {
      try {
        await this.cdpClick(pageClient, result.nextTarget.x, result.nextTarget.y);
        result.nextClicked = true;
      } catch (error) {
        result.nextClicked = false;
        result.nextClickError = error.message || String(error);
      }
      await sleep(1500);
    } else if (
      result?.ok &&
      ["email_filled", "password_filled"].includes(result.stage)
    ) {
      try {
        await this.pressEnter(pageClient);
        result.enterPressed = true;
      } catch (error) {
        result.enterPressed = false;
        result.enterPressError = error.message || String(error);
      }
      await sleep(2500);
    }
    await sleep(1500);
    return result;
  }
}

module.exports = {
  GoogleSignInManager,
};
