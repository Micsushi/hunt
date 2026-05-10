// Content script injected into ordinary pages so C3 can notice likely signup,
// application, and ATS pages. It asks before filling; actual fill still runs in
// the background so manual popup fill and detected-page fill share one path.
(async () => {
  const PROMPT_ID = "hunt-apply-detected-page-prompt";
  const ATS_HOST_PATTERNS = [
    "workday.com",
    "myworkdayjobs.com",
    "boards.greenhouse.io",
    "app.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
    "jobs.smartrecruiters.com",
    "icims.com",
    "bamboohr.com",
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
    const hasSignupSignal = SIGNUP_TERMS.some((term) => text.includes(term));
    const hasApplicationSignal = APPLICATION_TERMS.some((term) =>
      text.includes(term),
    );
    if (isAts) {
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
    document.getElementById(PROMPT_ID)?.remove();
  }

  function showExtensionToast(message, tone) {
    var container = document.getElementById("hunt-apply-page-toasts");
    if (!container) {
      container = document.createElement("div");
      container.id = "hunt-apply-page-toasts";
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
      removePrompt();
    });
    host.shadowRoot
      .getElementById("fill")
      .addEventListener("click", async () => {
        const button = host.shadowRoot.getElementById("fill");
        button.textContent = "Filling...";
        button.disabled = true;
        const response = await chrome.runtime.sendMessage({
          type: "hunt.apply.fill_current_page",
          payload: { pageKind: kind, triggeredBy: "detected_page_prompt" },
        });
        button.textContent = response?.ok ? "Filled" : "Needs review";
        showExtensionToast(
          response?.message ||
            (response?.ok ? "Fill completed." : "Fill needs review."),
          response?.ok ? "info" : "warn",
        );
        setTimeout(removePrompt, 1400);
      });
    document.documentElement.appendChild(host);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "hunt.apply.show_toast") {
      showExtensionToast(
        message.message || "Hunt Apply update.",
        message.tone || "info",
      );
    }
  });

  const stateResponse = await chrome.runtime.sendMessage({
    type: "hunt.apply.get_state",
  });
  const detection = detectPageKind();

  console.log("Hunt Apply content bootstrap loaded.", {
    ok: stateResponse?.ok,
    url: window.location.href,
    autofillOnLoad: stateResponse?.settings?.autofillOnLoad,
    autoPromptEnabled: stateResponse?.settings?.autoPromptEnabled,
    detectedPageKind: detection.kind,
    activeJobId: stateResponse?.activeApplyContext?.jobId || "",
  });

  if (
    stateResponse?.ok &&
    stateResponse?.settings?.autoPromptEnabled &&
    stateResponse?.settings?.manualFillEnabled &&
    ["ats", "signup", "application"].includes(detection.kind)
  ) {
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
        },
      },
    });
  }

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
