// Content script injected into ordinary pages so C3 can notice likely signup,
// application, and ATS pages. It asks before filling; actual fill still runs in
// the background so manual popup fill and detected-page fill share one path.
(async () => {
  const PROMPT_ID = "hunt-apply-detected-page-prompt";
  const LLM_PROMPT_ID = "hunt-apply-llm-fill-prompt";
  const FILL_PROGRESS_ID = "hunt-apply-fill-progress";
  const FILL_SUMMARY_ID = "hunt-apply-fill-summary";
  const TOAST_CONTAINER_ID = "hunt-apply-page-toasts";
  const PROMPT_SUPPRESS_AFTER_FILL_MS = 45000;
  const PROMPT_AUTO_DISMISS_MS = 5000;
  const PROMPT_FILL_REQUEST_TIMEOUT_MS = 65000;
  let lastPromptSignature = "";
  const dismissedPromptSignatures = new Set();
  let promptCheckTimer = null;
  let promptAutoDismissTimer = null;
  let cachedStateResponse = null;
  let lastFillCompletedAt = 0;
  let lastFillCompletedUrl = "";
  let lastFillCompletedStep = "";
  let lastPageContextKey = "";
  let activeFillRequestId = "";
  const ATS_HOST_PATTERNS = [
    "workday.com",
    "myworkdayjobs.com",
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
    "app.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
    "ashbyhq.com",
    "jobs.smartrecruiters.com",
    "apply.workable.com",
    "workable.com",
    "icims.com",
    "bamboohr.com",
    "jobvite.com",
    "taleo.net",
    "oraclecloud.com",
    "workforcenow.adp.com",
    "ultipro.com",
    "ukg.com",
    "breezy.hr",
    "applytojob.com",
    "jazzhr.com",
    "recruitee.com",
    "pinpointhq.com",
  ];
  const EMBEDDED_ATS_SELECTORS = [
    "#grnhse_app",
    'iframe[src*="greenhouse.io"]',
    'iframe[src*="ashbyhq.com"]',
    'iframe[src*="jobs.lever.co"]',
  ];
  const SIGNUP_TERMS = [
    "create account",
    "sign up",
    "signup",
    "register",
    "registration",
    "email verification",
  ];
  const APPLICATION_TERMS = [
    "apply",
    "application",
    "applicant",
    "candidate",
    "resume",
    "cv",
    "cover letter",
    "work authorization",
    "sponsorship",
  ];

  function visibleInputCount() {
    return Array.from(
      document.querySelectorAll("input, textarea, select"),
    ).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    }).length;
  }

  function pageText() {
    return [
      document.title,
      document.body?.innerText || "",
      Array.from(document.querySelectorAll("input, textarea, select"))
        .slice(0, 80)
        .map((element) =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
            element.getAttribute("name"),
            element.id,
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join(" "),
    ]
      .join(" ")
      .toLowerCase();
  }

  function detectPageKind() {
    const host = window.location.hostname.toLowerCase();
    const text = pageText();
    const inputCount = visibleInputCount();
    const isAts = ATS_HOST_PATTERNS.some((pattern) => host.includes(pattern));
    const hasEmbeddedAts = EMBEDDED_ATS_SELECTORS.some((selector) =>
      document.querySelector(selector),
    );
    const hasSignupSignal = SIGNUP_TERMS.some((term) => text.includes(term));
    const hasApplicationSignal = APPLICATION_TERMS.some((term) =>
      text.includes(term),
    );
    if (isAts || hasEmbeddedAts) {
      return { kind: "ats", inputCount };
    }
    if (inputCount >= 2 && hasSignupSignal) {
      return { kind: "signup", inputCount };
    }
    if (inputCount >= 3 && hasApplicationSignal) {
      return { kind: "application", inputCount };
    }
    return { kind: "ordinary", inputCount };
  }

  function promptTitle(kind) {
    if (kind === "ats") {
      return "Hunt detected an application page.";
    }
    if (kind === "signup") {
      return "Hunt detected a signup form.";
    }
    return "Hunt detected a form it may be able to fill.";
  }

  function removePrompt() {
    if (promptAutoDismissTimer) {
      clearTimeout(promptAutoDismissTimer);
      promptAutoDismissTimer = null;
    }
    document.getElementById(PROMPT_ID)?.remove();
  }

  function removeToasts() {
    document.getElementById(TOAST_CONTAINER_ID)?.remove();
  }

  function removeLlmPrompt() {
    document.getElementById(LLM_PROMPT_ID)?.remove();
  }

  function removeFillSummary() {
    document.getElementById(FILL_SUMMARY_ID)?.remove();
  }

  function hideFillProgress() {
    const existing = document.getElementById(FILL_PROGRESS_ID);
    if (existing) {
      logPageUiEvent("ui.fill_progress.hide", "Hid fill progress indicator.");
      existing.remove();
    }
  }

  function logPageUiEvent(action, summary, details = {}, status = "ok") {
    try {
      chrome.runtime
        .sendMessage({
          type: "hunt.apply.log_activity",
          payload: {
            action,
            summary,
            status,
            details: {
              url: window.location.href,
              title: document.title,
              ...details,
            },
          },
        })
        .catch(() => {});
    } catch {
      // Extension reloads can invalidate chrome.runtime in existing page handlers.
    }
  }

  function runtimeMessageWithTimeout(message, timeoutMs, timeoutReason) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          timedOut: true,
          reason: timeoutReason,
          message:
            "Hunt is still waiting for the fill result. Open the popup and use Fill Current Page if the page does not change.",
        });
      }, timeoutMs);
    });
    let runtimeMessage = null;
    try {
      runtimeMessage = chrome.runtime.sendMessage(message);
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }
      return Promise.resolve({
        ok: false,
        reason: "runtime_message_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return Promise.race([runtimeMessage, timeout])
      .catch((error) => ({
        ok: false,
        reason: "runtime_message_failed",
        message: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
  }

  function dismissTransientUi() {
    logPageUiEvent("ui.transient.dismiss", "Dismissed transient page UI.", {
      hadDetectedPrompt: Boolean(document.getElementById(PROMPT_ID)),
      hadLlmPrompt: Boolean(document.getElementById(LLM_PROMPT_ID)),
      hadToasts: Boolean(document.getElementById(TOAST_CONTAINER_ID)),
      hadFillProgress: Boolean(document.getElementById(FILL_PROGRESS_ID)),
    });
    removePrompt();
    removeLlmPrompt();
    removeFillSummary();
    removeToasts();
    hideFillProgress();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function summaryStatusLabel(status) {
    if (status === "success") {
      return "Success";
    }
    if (status === "review") {
      return "Review";
    }
    if (status === "failed") {
      return "Failed";
    }
    return "Stopped";
  }

  function summaryRow(label, value) {
    if (value === undefined || value === null || value === "" || value === 0) {
      return "";
    }
    return `<div class="row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function showFillSummary(payload) {
    removeFillSummary();
    const status = String(payload?.status || "stopped");
    const failedPageNumber = Number(payload?.failedPageNumber || 0);
    const successfulPageCount = Number(payload?.successfulPageCount || 0);
    const lastPageNumber = Number(payload?.lastPageNumber || 0);
    const reviewIssueCount = Number(payload?.reviewIssueCount || 0);
    const issueLabels = Array.isArray(payload?.reviewIssueLabels)
      ? payload.reviewIssueLabels.slice(0, 3)
      : [];
    const host = document.createElement("div");
    host.id = FILL_SUMMARY_ID;
    host.style.position = "fixed";
    host.style.right = "18px";
    host.style.bottom = "18px";
    host.style.zIndex = "2147483647";
    host.style.maxWidth = "430px";
    host.style.fontFamily = "Segoe UI, system-ui, sans-serif";
    host.attachShadow({ mode: "open" });
    host.shadowRoot.innerHTML = `
      <style>
        .card {
          background: #0b1510;
          border: 1px solid #3a5a3a;
          border-left: 4px solid #59a96a;
          border-radius: 10px;
          box-shadow: 0 10px 34px rgba(0, 0, 0, 0.42);
          color: #d4f0dc;
          overflow: hidden;
          min-width: 310px;
        }
        .card.failed,
        .card.stopped {
          border-color: #7a4b22;
          border-left-color: #f0b429;
        }
        .head {
          align-items: flex-start;
          display: flex;
          gap: 12px;
          justify-content: space-between;
          padding: 13px 14px 8px;
        }
        .copy {
          display: grid;
          gap: 5px;
          min-width: 0;
        }
        .eyebrow {
          color: #9bdeac;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .title {
          color: #f2fff5;
          font-size: 15px;
          font-weight: 800;
          line-height: 1.25;
        }
        .badge {
          background: #1e3a26;
          border: 1px solid #59a96a;
          border-radius: 999px;
          color: #b4e7ce;
          flex: 0 0 auto;
          font-size: 11px;
          font-weight: 800;
          line-height: 1;
          padding: 5px 8px;
        }
        .badge.failed,
        .badge.stopped {
          background: #2d2410;
          border-color: #f0b429;
          color: #f8d98a;
        }
        .body {
          display: grid;
          gap: 10px;
          padding: 0 14px 14px;
        }
        .message {
          color: #d4f0dc;
          font-size: 13px;
          font-weight: 650;
          line-height: 1.4;
        }
        .grid {
          display: grid;
          gap: 6px;
        }
        .row {
          align-items: baseline;
          background: #122118;
          border: 1px solid #263c2a;
          border-radius: 7px;
          display: flex;
          gap: 12px;
          justify-content: space-between;
          padding: 7px 9px;
        }
        .row span {
          color: #9bb69f;
          font-size: 11px;
          font-weight: 750;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .row strong {
          color: #f2fff5;
          font-size: 13px;
          font-weight: 800;
          max-width: 240px;
          overflow-wrap: anywhere;
          text-align: right;
        }
        .issues {
          color: #9bb69f;
          display: grid;
          font-size: 12px;
          gap: 4px;
          line-height: 1.35;
        }
        .actions {
          border-top: 1px solid #263c2a;
          display: flex;
          justify-content: flex-end;
          padding: 10px 14px;
        }
        button {
          background: #59a96a;
          border: 1px solid #6fc77d;
          border-radius: 7px;
          color: #07100a;
          cursor: pointer;
          font: 800 12px Segoe UI, system-ui, sans-serif;
          min-height: 30px;
          min-width: 86px;
          padding: 6px 10px;
        }
      </style>
      <div class="card ${escapeHtml(status)}" role="dialog" aria-live="polite" aria-label="Hunt fill summary">
        <div class="head">
          <div class="copy">
            <div class="eyebrow">Fill summary</div>
            <div class="title">${escapeHtml(payload?.title || "Fill summary")}</div>
          </div>
          <div class="badge ${escapeHtml(status)}">${escapeHtml(summaryStatusLabel(status))}</div>
        </div>
        <div class="body">
          <div class="message">${escapeHtml(payload?.message || "Fill finished.")}</div>
          <div class="grid">
            ${summaryRow("Failed page", failedPageNumber)}
            ${summaryRow("Pages completed", successfulPageCount)}
            ${summaryRow("Last page", lastPageNumber)}
            ${summaryRow("Stop reason", payload?.stoppedReason || "")}
            ${summaryRow("Review items", reviewIssueCount)}
          </div>
          ${
            issueLabels.length
              ? `<div class="issues">${issueLabels
                  .map((issue) => `<div>${escapeHtml(issue)}</div>`)
                  .join("")}</div>`
              : ""
          }
        </div>
        <div class="actions">
          <button id="hunt-apply-fill-summary-close" type="button">Done</button>
        </div>
      </div>
    `;
    host.shadowRoot
      .getElementById("hunt-apply-fill-summary-close")
      ?.addEventListener("click", () => {
        removeFillSummary();
        logPageUiEvent(
          "ui.fill_summary.dismiss",
          "Dismissed fill summary popup.",
          { status },
        );
      });
    document.documentElement.appendChild(host);
    logPageUiEvent("ui.fill_summary.show", "Showed fill summary popup.", {
      status,
      failedPageNumber,
      successfulPageCount,
      lastPageNumber,
      stoppedReason: payload?.stoppedReason || "",
      reviewIssueCount,
    });
  }

  function showFillProgress({ message, fillRunId } = {}) {
    removePrompt();
    removeFillSummary();
    var existing = document.getElementById(FILL_PROGRESS_ID);
    if (existing?.shadowRoot) {
      var existingText = existing.shadowRoot.getElementById(
        "hunt-apply-fill-progress-message",
      );
      if (existingText) {
        existingText.textContent = message || "Filling page";
        logPageUiEvent(
          "ui.fill_progress.update",
          "Updated fill progress indicator.",
          { message: message || "Filling page" },
        );
      }
      return;
    }
    fillRunId = fillRunId || "";
    const host = document.createElement("div");
    host.id = FILL_PROGRESS_ID;
    host.style.position = "fixed";
    host.style.right = "18px";
    host.style.top = "18px";
    host.style.zIndex = "2147483647";
    host.style.maxWidth = "360px";
    host.style.fontFamily = "Segoe UI, system-ui, sans-serif";
    host.attachShadow({ mode: "open" });
    host.shadowRoot.innerHTML = `
      <style>
        @keyframes huntApplySpin {
          to { transform: rotate(360deg); }
        }
        .panel {
          align-items: center;
          background: #111b17;
          border: 1px solid #31583d;
          border-left: 4px solid #59a96a;
          border-radius: 8px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34);
          color: #d4f0dc;
          display: flex;
          gap: 10px;
          min-width: 230px;
          padding: 10px 12px;
        }
        #hunt-apply-fill-progress-spinner {
          animation: huntApplySpin 760ms linear infinite;
          border: 2px solid rgba(212, 240, 220, 0.24);
          border-radius: 999px;
          border-top-color: #7ad987;
          box-sizing: border-box;
          flex: 0 0 auto;
          height: 18px;
          width: 18px;
        }
        .copy {
          display: grid;
          gap: 2px;
          min-width: 0;
        }
        .title {
          font-size: 13px;
          font-weight: 750;
          line-height: 1.2;
        }
        .meta {
          color: #9bb69f;
          font-size: 11px;
          font-weight: 600;
          line-height: 1.25;
        }
        .cancel {
          background: #2d2410;
          border: 1px solid #f0b429;
          border-radius: 6px;
          color: #f8d98a;
          cursor: pointer;
          flex: 0 0 auto;
          font: 750 12px Segoe UI, system-ui, sans-serif;
          min-height: 28px;
          padding: 5px 9px;
        }
        .cancel:disabled {
          cursor: default;
          opacity: 0.72;
        }
      </style>
      <div class="panel" role="status" aria-live="polite">
        <div id="hunt-apply-fill-progress-spinner" aria-hidden="true"></div>
        <div class="copy">
          <div class="title" id="hunt-apply-fill-progress-message">${message || "Filling page"}</div>
          <div class="meta">Hunt is working through the visible fields.</div>
        </div>
        <button class="cancel" id="hunt-apply-fill-progress-cancel" type="button">Cancel</button>
      </div>
    `;
    document.documentElement.appendChild(host);
    host.shadowRoot
      .getElementById("hunt-apply-fill-progress-cancel")
      ?.addEventListener("click", () => {
        window.__huntApplyCancelAllFills = true;
        if (fillRunId) {
          window.__huntApplyCancelFillRunId = fillRunId;
        }
        const button = host.shadowRoot.getElementById(
          "hunt-apply-fill-progress-cancel",
        );
        const text = host.shadowRoot.getElementById(
          "hunt-apply-fill-progress-message",
        );
        if (button) {
          button.disabled = true;
          button.textContent = "Canceling";
        }
        if (text) {
          text.textContent = "Canceling fill";
        }
        logPageUiEvent(
          "ui.fill_progress.cancel_click",
          "Cancel fill clicked.",
          {
            fillRunId,
          },
        );
        chrome.runtime
          .sendMessage({
            type: "hunt.apply.cancel_fill",
            payload: { fillRunId },
          })
          .catch(() => {});
      });
    logPageUiEvent("ui.fill_progress.show", "Showed fill progress indicator.", {
      message: message || "Filling page",
      fillRunId,
    });
  }

  function showExtensionToast(message, tone) {
    var container = document.getElementById(TOAST_CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = TOAST_CONTAINER_ID;
      container.style.position = "fixed";
      container.style.right = "18px";
      container.style.top = "18px";
      container.style.zIndex = "2147483647";
      container.style.display = "grid";
      container.style.gap = "8px";
      container.style.maxWidth = "380px";
      container.style.fontFamily = "Segoe UI, system-ui, sans-serif";
      document.documentElement.appendChild(container);
    }
    var toast = document.createElement("div");
    toast.textContent = message;
    toast.style.background = tone === "warn" ? "#2d2410" : "#172212";
    toast.style.border =
      tone === "warn" ? "1px solid #f0b429" : "1px solid #3a5a3a";
    toast.style.borderLeft =
      tone === "warn" ? "4px solid #f0b429" : "4px solid #59a96a";
    toast.style.borderRadius = "8px";
    toast.style.boxShadow = "0 8px 28px rgba(0, 0, 0, 0.35)";
    toast.style.color = tone === "warn" ? "#f0b429" : "#d4f0dc";
    toast.style.font = "600 13px Segoe UI, system-ui, sans-serif";
    toast.style.lineHeight = "1.35";
    toast.style.padding = "10px 12px";
    container.appendChild(toast);
    logPageUiEvent("ui.toast.show", "Showed page toast.", {
      message,
      tone: tone || "info",
    });
    setTimeout(
      function () {
        toast.remove();
      },
      tone === "warn" ? 7000 : 4200,
    );
  }

  function showPrompt({ kind, inputCount }) {
    if (document.getElementById(PROMPT_ID)) {
      return;
    }
    const host = document.createElement("div");
    host.id = PROMPT_ID;
    host.style.position = "fixed";
    host.style.right = "18px";
    host.style.bottom = "18px";
    host.style.zIndex = "2147483647";
    host.style.maxWidth = "360px";
    host.style.fontFamily = "Segoe UI, system-ui, sans-serif";
    host.attachShadow({ mode: "open" });
    host.shadowRoot.innerHTML = `
      <style>
        .card {
          background: #172212;
          border: 1px solid #3a5a3a;
          border-radius: 8px;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
          color: #d4f0dc;
          overflow: hidden;
        }
        .body {
          display: grid;
          gap: 8px;
          padding: 12px;
        }
        .title {
          font-size: 13px;
          font-weight: 750;
          line-height: 1.3;
        }
        .meta {
          color: #9bb69f;
          font-size: 11px;
          line-height: 1.35;
        }
        .actions {
          display: flex;
          gap: 8px;
          padding: 0 12px 12px;
        }
        button {
          background: #1d2b18;
          border: 1px solid #2a3f2a;
          border-radius: 6px;
          color: #d4f0dc;
          cursor: pointer;
          flex: 1;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          min-height: 30px;
          padding: 6px 8px;
        }
        button.primary {
          background: #59a96a;
          color: #07100a;
        }
      </style>
      <div class="card">
        <div class="body">
          <div class="title">${promptTitle(kind)}</div>
          <div class="meta">Fill only known fields from your Hunt profile/resume. Unknown and optional fields stay for review.</div>
          <div class="meta">${inputCount} visible form controls found.</div>
        </div>
        <div class="actions">
          <button class="primary" id="fill" type="button">Fill known fields</button>
          <button id="dismiss" type="button">Not now</button>
        </div>
      </div>
    `;
    host.shadowRoot.getElementById("dismiss").addEventListener("click", () => {
      dismissedPromptSignatures.add(promptSignature({ kind, inputCount }));
      removePrompt();
      logPageUiEvent(
        "ui.detect_prompt.dismiss",
        "Dismissed detected-page prompt.",
        {
          kind,
          inputCount,
        },
      );
    });
    host.shadowRoot
      .getElementById("fill")
      .addEventListener("click", async () => {
        if (promptAutoDismissTimer) {
          clearTimeout(promptAutoDismissTimer);
          promptAutoDismissTimer = null;
        }
        const button = host.shadowRoot.getElementById("fill");
        button.textContent = "Filling...";
        button.disabled = true;
        const fillRequestId = `detected_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        activeFillRequestId = fillRequestId;
        removeToasts();
        showFillProgress({ message: "Filling page" });
        logPageUiEvent(
          "ui.detect_prompt.fill_click",
          "Clicked detected-page fill.",
          {
            kind,
            inputCount,
          },
        );
        const response = await runtimeMessageWithTimeout(
          {
            type: "hunt.apply.fill_current_page",
            payload: {
              pageKind: kind,
              triggeredBy: "detected_page_prompt",
              fillRequestId,
            },
          },
          PROMPT_FILL_REQUEST_TIMEOUT_MS,
          "detected_prompt_fill_timeout",
        );
        if (activeFillRequestId !== fillRequestId) {
          logPageUiEvent(
            "ui.detect_prompt.stale_fill_response",
            "Ignored stale detected-page fill response.",
            {
              kind,
              inputCount,
              fillRequestId,
              activeFillRequestId,
            },
            "warn",
          );
          return;
        }
        logPageUiEvent(
          "ui.detect_prompt.fill_response",
          response?.ok
            ? "Detected-page fill returned."
            : "Detected-page fill did not return a successful response.",
          {
            kind,
            inputCount,
            ok: Boolean(response?.ok),
            reason: response?.reason || "",
            timedOut: Boolean(response?.timedOut),
            message: response?.message || "",
          },
          response?.ok ? "ok" : "warn",
        );
        if (response?.timedOut) {
          showFillProgress({ message: "Still waiting for fill result" });
          showExtensionToast(response.message, "warn");
          return;
        }
        hideFillProgress();
        if (!response?.ok) {
          showExtensionToast(
            response?.message ||
              "Fill did not start. Open the popup and try Fill Current Page.",
            "warn",
          );
        }
        button.textContent = response?.ok ? "Filled" : "Needs review";
        setTimeout(removePrompt, 1400);
      });
    document.documentElement.appendChild(host);
    promptAutoDismissTimer = setTimeout(() => {
      if (!host.isConnected) {
        return;
      }
      dismissedPromptSignatures.add(promptSignature({ kind, inputCount }));
      removePrompt();
      logPageUiEvent(
        "ui.detect_prompt.auto_dismiss",
        "Auto-dismissed detected-page prompt.",
        {
          kind,
          inputCount,
          timeoutMs: PROMPT_AUTO_DISMISS_MS,
        },
      );
    }, PROMPT_AUTO_DISMISS_MS);
    logPageUiEvent("ui.detect_prompt.show", "Showed detected-page prompt.", {
      kind,
      inputCount,
      step: currentStepText(),
    });
  }

  function showLlmPrompt({ fieldCount, filledFieldCount }) {
    removeLlmPrompt();
    const host = document.createElement("div");
    host.id = LLM_PROMPT_ID;
    host.style.position = "fixed";
    host.style.right = "18px";
    host.style.bottom = "18px";
    host.style.zIndex = "2147483647";
    host.style.maxWidth = "390px";
    host.style.fontFamily = "Segoe UI, system-ui, sans-serif";
    host.attachShadow({ mode: "open" });
    host.shadowRoot.innerHTML = `
      <style>
        .card {
          background: #172212;
          border: 1px solid #3a5a3a;
          border-radius: 8px;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
          color: #d4f0dc;
          overflow: hidden;
        }
        .body {
          display: grid;
          gap: 8px;
          padding: 12px;
        }
        .title {
          font-size: 13px;
          font-weight: 750;
          line-height: 1.3;
        }
        .meta {
          color: #9bb69f;
          font-size: 11px;
          line-height: 1.35;
        }
        .actions {
          display: flex;
          gap: 8px;
          padding: 0 12px 12px;
        }
        button {
          background: #1d2b18;
          border: 1px solid #2a3f2a;
          border-radius: 6px;
          color: #d4f0dc;
          cursor: pointer;
          flex: 1;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          min-height: 30px;
          padding: 6px 8px;
        }
        button.primary {
          background: #59a96a;
          color: #07100a;
        }
      </style>
      <div class="card">
        <div class="body">
          <div class="title">Use LLM help for the remaining questions?</div>
          <div class="meta">Hunt filled ${Number(filledFieldCount || 0)} deterministic field${Number(filledFieldCount || 0) === 1 ? "" : "s"}.</div>
          <div class="meta">${Number(fieldCount || 0)} required question${Number(fieldCount || 0) === 1 ? "" : "s"} still need judgement. Hunt will send only those normalized questions/options plus profile context to the local backend.</div>
        </div>
        <div class="actions">
          <button class="primary" id="use-llm" type="button">Use LLM</button>
          <button id="dismiss" type="button">Leave blank</button>
        </div>
      </div>
    `;
    host.shadowRoot.getElementById("dismiss").addEventListener("click", () => {
      logPageUiEvent("ui.llm_prompt.dismiss", "Dismissed LLM prompt.", {
        fieldCount: Number(fieldCount || 0),
        filledFieldCount: Number(filledFieldCount || 0),
      });
      removeLlmPrompt();
    });
    host.shadowRoot
      .getElementById("use-llm")
      .addEventListener("click", async () => {
        const button = host.shadowRoot.getElementById("use-llm");
        button.textContent = "Thinking...";
        button.disabled = true;
        logPageUiEvent("ui.llm_prompt.use_click", "Clicked LLM prompt.", {
          fieldCount: Number(fieldCount || 0),
          filledFieldCount: Number(filledFieldCount || 0),
        });
        const response = await chrome.runtime.sendMessage({
          type: "hunt.apply.fill_remaining_with_llm",
          payload: { triggeredBy: "llm_prompt" },
        });
        button.textContent = response?.ok ? "Filled" : "Needs review";
        setTimeout(removeLlmPrompt, 1400);
      });
    document.documentElement.appendChild(host);
    logPageUiEvent("ui.llm_prompt.show", "Showed LLM prompt.", {
      fieldCount: Number(fieldCount || 0),
      filledFieldCount: Number(filledFieldCount || 0),
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "hunt.apply.dismiss_transient_ui") {
      dismissTransientUi();
    }
    if (message?.type === "hunt.apply.show_toast") {
      showExtensionToast(
        message.message || "Hunt Apply update.",
        message.tone || "info",
      );
    }
    if (message?.type === "hunt.apply.show_fill_progress") {
      showFillProgress({
        message: message.message || "Filling page",
        fillRunId: message.fillRunId || "",
      });
    }
    if (message?.type === "hunt.apply.hide_fill_progress") {
      hideFillProgress();
    }
    if (message?.type === "hunt.apply.show_fill_summary") {
      showFillSummary(message);
    }
    if (message?.type === "hunt.apply.note_fill_completed") {
      lastFillCompletedAt = Date.now();
      lastFillCompletedUrl = window.location.href;
      lastFillCompletedStep = currentStepText();
      logPageUiEvent(
        "ui.fill_completed_note.receive",
        "Started post-fill prompt cooldown.",
        {
          trigger: message.triggeredBy || "",
          cooldownMs: PROMPT_SUPPRESS_AFTER_FILL_MS,
          step: lastFillCompletedStep,
        },
      );
    }
    if (message?.type === "hunt.apply.show_llm_prompt") {
      showLlmPrompt({
        fieldCount: message.fieldCount || 0,
        filledFieldCount: message.filledFieldCount || 0,
      });
    }
  });

  const stateResponse = await chrome.runtime.sendMessage({
    type: "hunt.apply.get_state",
  });
  cachedStateResponse = stateResponse;

  function currentStepText() {
    const text = document.body?.innerText || "";
    const match = text.match(/current step\s+\d+\s+of\s+\d+\s*\n([^\n]+)/i);
    return (match?.[1] || document.title || "").trim();
  }

  function promptSignature(detection) {
    return [window.location.href, currentStepText(), detection.kind].join("|");
  }

  function pageContextKey() {
    return [window.location.href, currentStepText()].join("|");
  }

  function handlePageContextChange(reason) {
    const nextKey = pageContextKey();
    if (!lastPageContextKey) {
      lastPageContextKey = nextKey;
      return false;
    }
    if (nextKey === lastPageContextKey) {
      return false;
    }
    const previousKey = lastPageContextKey;
    lastPageContextKey = nextKey;
    lastPromptSignature = "";
    if (currentStepText() !== lastFillCompletedStep) {
      lastFillCompletedAt = 0;
    }
    if (
      document.getElementById(PROMPT_ID) ||
      document.getElementById(LLM_PROMPT_ID) ||
      document.getElementById(TOAST_CONTAINER_ID)
    ) {
      logPageUiEvent(
        "ui.transient.dismiss_on_page_change",
        "Dismissed transient page UI after same-tab navigation.",
        {
          reason,
          previousKey,
          nextKey,
        },
      );
    }
    removePrompt();
    removeLlmPrompt();
    removeToasts();
    return true;
  }

  function canPrompt(response, detection) {
    const fillCooldownActive =
      lastFillCompletedUrl === window.location.href &&
      lastFillCompletedStep === currentStepText() &&
      Date.now() - lastFillCompletedAt < PROMPT_SUPPRESS_AFTER_FILL_MS;
    return (
      response?.ok &&
      response?.settings?.autoPromptEnabled &&
      response?.settings?.manualFillEnabled &&
      detection.inputCount > 0 &&
      !fillCooldownActive &&
      ["ats", "signup", "application"].includes(detection.kind)
    );
  }

  async function maybeShowPrompt(reason) {
    handlePageContextChange(reason);
    const detection = detectPageKind();
    if (!canPrompt(cachedStateResponse, detection)) {
      return;
    }
    const signature = promptSignature(detection);
    if (
      signature === lastPromptSignature ||
      dismissedPromptSignatures.has(signature) ||
      document.getElementById(PROMPT_ID) ||
      document.getElementById(FILL_PROGRESS_ID)
    ) {
      return;
    }
    lastPromptSignature = signature;
    showPrompt(detection);
    await chrome.runtime.sendMessage({
      type: "hunt.apply.log_activity",
      payload: {
        action: "detect.prompt",
        summary: `Detected ${detection.kind} page and showed fill prompt.`,
        details: {
          url: window.location.href,
          kind: detection.kind,
          inputCount: detection.inputCount,
          step: currentStepText(),
          reason,
        },
      },
    });
  }

  function schedulePromptCheck(reason) {
    handlePageContextChange(reason);
    clearTimeout(promptCheckTimer);
    promptCheckTimer = setTimeout(() => {
      maybeShowPrompt(reason).catch(() => {});
    }, 800);
  }

  function scheduleSettledPromptCheck(reason, delayMs) {
    setTimeout(() => {
      handlePageContextChange(reason);
      maybeShowPrompt(reason).catch(() => {});
    }, delayMs);
  }

  function installNavigationWatchers() {
    ["pushState", "replaceState"].forEach((methodName) => {
      const original = history[methodName];
      if (typeof original !== "function") {
        return;
      }
      history[methodName] = function (...args) {
        const result = original.apply(this, args);
        schedulePromptCheck(`history_${methodName}`);
        scheduleSettledPromptCheck(`history_${methodName}_settled`, 1200);
        return result;
      };
    });
    window.addEventListener("popstate", () => {
      schedulePromptCheck("popstate");
      scheduleSettledPromptCheck("popstate_settled", 1200);
    });
    window.addEventListener("hashchange", () => {
      schedulePromptCheck("hashchange");
      scheduleSettledPromptCheck("hashchange_settled", 1200);
    });
  }

  function watchPageReadinessForPrompt() {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => schedulePromptCheck("dom_content_loaded"),
        { once: true },
      );
    } else {
      schedulePromptCheck(`ready_state_${document.readyState}`);
    }
    document.addEventListener("readystatechange", () => {
      if (["interactive", "complete"].includes(document.readyState)) {
        schedulePromptCheck(`ready_state_${document.readyState}`);
      }
    });
    window.addEventListener("load", () => schedulePromptCheck("window_load"), {
      once: true,
    });
    window.addEventListener("pageshow", () => schedulePromptCheck("pageshow"), {
      once: true,
    });
    scheduleSettledPromptCheck("post_bootstrap_soon", 1200);
    scheduleSettledPromptCheck("post_bootstrap_late", 3000);
    scheduleSettledPromptCheck("post_bootstrap_settled", 6000);
  }

  const detection = detectPageKind();

  console.log("Hunt Apply content bootstrap loaded.", {
    ok: stateResponse?.ok,
    url: window.location.href,
    autofillOnLoad: stateResponse?.settings?.autofillOnLoad,
    autoPromptEnabled: stateResponse?.settings?.autoPromptEnabled,
    detectedPageKind: detection.kind,
    activeJobId: stateResponse?.activeApplyContext?.jobId || "",
  });

  await maybeShowPrompt("initial_load");
  installNavigationWatchers();
  watchPageReadinessForPrompt();

  document.addEventListener(
    "click",
    (event) => {
      const path = event.composedPath?.() || [];
      if (
        path.some(
          (node) =>
            node?.id === PROMPT_ID ||
            node?.id === LLM_PROMPT_ID ||
            node?.id === TOAST_CONTAINER_ID,
        )
      ) {
        return;
      }
      const text = String(
        event.target?.innerText || event.target?.textContent || "",
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (["next", "continue", "review", "back", "previous"].includes(text)) {
        handlePageContextChange("navigation_click");
        schedulePromptCheck("navigation_click");
        scheduleSettledPromptCheck("navigation_click_settled", 1200);
      }
    },
    true,
  );

  const observer = new MutationObserver(() => {
    schedulePromptCheck("dom_change");
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  if (
    stateResponse?.ok &&
    stateResponse?.settings?.autofillOnLoad &&
    (stateResponse?.activeApplyContext?.selectedResumeDataUrl ||
      stateResponse?.defaultResume?.pdfDataUrl)
  ) {
    console.log("Autofill on load is enabled for this page.");
    // Actual fill is triggered by the tabs.onUpdated listener in background/index.js.
  }
})();
