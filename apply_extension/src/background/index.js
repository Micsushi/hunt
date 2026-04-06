import {
  appendAttempt,
  appendQuestionAnswers,
  clearActiveApplyContext,
  ensureStageOneState,
  getExtensionState,
  saveActiveApplyContext,
  saveDefaultResume,
  saveProfile,
  saveSettings
} from "../shared/storage.js";

function isWorkdayUrl(url = "") {
  return url.includes("workday.com") || url.includes("myworkdayjobs.com");
}

function buildQuestionHash(value = "") {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `q_${hash.toString(16)}`;
}

function createWorkdayFillFunction() {
  return async ({ profile, settings, activeApplyContext, defaultResume }) => {
    function normalizeText(value) {
      let normalized = String(value || "");
      if (settings.stripLongDash !== false) {
        normalized = normalized
          .replace(/\u2014/g, "-")
          .replace(/\u2013/g, "-");
      }

      return normalized
        .replace(/\s+/g, " ")
        .trim();
    }

    function getVisibleElements(selector) {
      return Array.from(document.querySelectorAll(selector)).filter((element) => {
        const styles = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          styles.display !== "none" &&
          styles.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          !element.disabled
        );
      });
    }

    function dispatchInputEvents(element) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    function setElementValue(element, value) {
      const normalized = normalizeText(value);
      if (!normalized) {
        return false;
      }

      element.focus();
      element.value = normalized;
      dispatchInputEvents(element);
      return true;
    }

    function getContainerText(element) {
      const container =
        element.closest("label") ||
        element.closest('[data-automation-id="formField"]') ||
        element.closest('[role="group"]') ||
        element.parentElement;
      return normalizeText(container?.innerText || "");
    }

    function getDescriptor(element) {
      return normalizeText(
        [
          element.name,
          element.id,
          element.getAttribute("aria-label"),
          element.getAttribute("placeholder"),
          getContainerText(element)
        ]
          .filter(Boolean)
          .join(" ")
      ).toLowerCase();
    }

    function chooseProfileValue(descriptor) {
      const mapping = [
        [["first name", "given name"], profile.fullName.split(" ")[0] || ""],
        [["last name", "family name", "surname"], profile.fullName.split(" ").slice(1).join(" ") || ""],
        [["full name", "legal name", "name"], profile.fullName],
        [["email", "e-mail"], profile.email],
        [["phone", "mobile"], profile.phone],
        [["city", "location", "address"], profile.location],
        [["linkedin"], profile.linkedinUrl],
        [["github"], profile.githubUrl],
        [["website", "portfolio", "personal site"], profile.websiteUrl]
      ];

      for (const [keywords, value] of mapping) {
        if (keywords.some((keyword) => descriptor.includes(keyword)) && normalizeText(value)) {
          return normalizeText(value);
        }
      }

      return "";
    }

    function extractDescriptionTerms(text, maxTerms = 3) {
      const stopWords = new Set([
        "about",
        "across",
        "ability",
        "candidate",
        "company",
        "customer",
        "deliver",
        "experience",
        "including",
        "looking",
        "opportunity",
        "preferred",
        "required",
        "responsible",
        "strong",
        "team",
        "their",
        "using",
        "with",
        "work"
      ]);
      const counts = new Map();
      const tokens = normalizeText(text)
        .toLowerCase()
        .match(/[a-z][a-z0-9+#/-]{3,}/g) || [];
      for (const token of tokens) {
        if (stopWords.has(token)) {
          continue;
        }
        counts.set(token, (counts.get(token) || 0) + 1);
      }
      return Array.from(counts.entries())
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, maxTerms)
        .map(([token]) => token);
    }

    function generateAnswer(questionText) {
      const question = normalizeText(questionText).toLowerCase();
      const notes = normalizeText(profile.notes);
      const jobTitle = normalizeText(activeApplyContext.title);
      const companyName = normalizeText(activeApplyContext.company);
      const descriptionTerms = extractDescriptionTerms(activeApplyContext.description);
      const resumeSummary = normalizeText(activeApplyContext.selectedResumeSummary);
      const resumeTerms = extractDescriptionTerms(resumeSummary, 2);
      const focusArea = descriptionTerms.slice(0, 2).join(" and ");
      const resumeFocus = resumeTerms.join(" and ");
      const contextualRole = [jobTitle, companyName ? `at ${companyName}` : ""]
        .filter(Boolean)
        .join(" ");
      const weakContext = (activeApplyContext.concernFlags || []).includes("weak_description");

      if (question.includes("sponsor")) {
        return {
          answerText: profile.sponsorshipRequired ? "Yes." : "No.",
          confidence: "high",
          manualReviewRequired: false
        };
      }

      if (question.includes("relocat")) {
        return {
          answerText: profile.willingToRelocate ? "Yes." : "No.",
          confidence: "high",
          manualReviewRequired: false
        };
      }

      if (question.includes("salary")) {
        return {
          answerText: profile.salaryFlexible
            ? "I am flexible and open to discussing compensation based on the role and overall package."
            : "I am open to discussing compensation based on the role and overall package.",
          confidence: "medium",
          manualReviewRequired: false
        };
      }

      if (question.includes("authorized") || question.includes("legally")) {
        return {
          answerText: profile.workAuthorized ? "Yes." : "No.",
          confidence: "high",
          manualReviewRequired: false
        };
      }

      if (question.includes("why") || question.includes("interest")) {
        const contextualAnswer = contextualRole
          ? `I am interested in the ${contextualRole} opportunity because it aligns well with my background${focusArea ? ` in ${focusArea}` : ""}${resumeFocus ? ` and with experience around ${resumeFocus}` : ""} and would let me contribute quickly while continuing to grow.`
          : "";
        return {
          answerText:
            notes ||
            contextualAnswer ||
            "I am interested in the role because it aligns well with my background and I believe I can contribute quickly while continuing to grow with the team.",
          confidence: notes ? "medium" : contextualAnswer && !weakContext ? "medium" : "low",
          manualReviewRequired: !notes && (!contextualAnswer || weakContext)
        };
      }

      const contextualFallback =
        contextualRole && (focusArea || resumeFocus)
          ? `I believe my background is a strong fit for the ${contextualRole} opportunity, especially around ${focusArea || resumeFocus}${focusArea && resumeFocus ? `, with experience in ${resumeFocus}` : ""}.`
          : contextualRole
            ? `I believe my background is a strong fit for the ${contextualRole} opportunity and I would be excited to contribute while continuing to grow in the role.`
            : "";
      return {
        answerText:
          contextualFallback ||
          "I believe my background is a strong fit for this opportunity, and I would be excited to contribute while continuing to grow in the role.",
        confidence: contextualFallback && !weakContext ? "medium" : "low",
        manualReviewRequired: !contextualFallback || weakContext
      };
    }

    function fillSelectElement(element, descriptor) {
      const options = Array.from(element.options || []);
      const yesValues = ["yes", "true", "authorized", "i am authorized"];
      const noValues = ["no", "false", "not authorized", "i am not authorized"];

      const chooseOption = (candidates) =>
        options.find((option) => candidates.some((candidate) => normalizeText(option.text).toLowerCase() === candidate));

      let selectedOption = null;

      if (descriptor.includes("sponsor")) {
        selectedOption = profile.sponsorshipRequired ? chooseOption(yesValues) : chooseOption(noValues);
      } else if (descriptor.includes("authorized") || descriptor.includes("legally")) {
        selectedOption = profile.workAuthorized ? chooseOption(yesValues) : chooseOption(noValues);
      } else if (descriptor.includes("relocat")) {
        selectedOption = profile.willingToRelocate ? chooseOption(yesValues) : chooseOption(noValues);
      } else if (descriptor.includes("linkedin") && profile.linkedinUrl) {
        return setElementValue(element, profile.linkedinUrl);
      }

      if (!selectedOption) {
        return false;
      }

      element.value = selectedOption.value;
      dispatchInputEvents(element);
      return true;
    }

    function fillRadioGroup(radios, descriptor) {
      const lowered = descriptor.toLowerCase();
      let choice = null;

      if (lowered.includes("sponsor")) {
        choice = profile.sponsorshipRequired ? "yes" : "no";
      } else if (lowered.includes("authorized") || lowered.includes("legally")) {
        choice = profile.workAuthorized ? "yes" : "no";
      } else if (lowered.includes("relocat")) {
        choice = profile.willingToRelocate ? "yes" : "no";
      }

      if (!choice) {
        return false;
      }

      const target = radios.find((radio) => getDescriptor(radio).includes(choice));
      if (!target) {
        return false;
      }

      target.click();
      dispatchInputEvents(target);
      return true;
    }

    async function attachResumeToFileInput(fileInput) {
      const resumeDataUrl =
        activeApplyContext.selectedResumeDataUrl || defaultResume.pdfDataUrl;
      const resumeName =
        activeApplyContext.selectedResumeName ||
        defaultResume.pdfFileName ||
        "resume.pdf";
      const mimeType =
        activeApplyContext.selectedResumeMimeType ||
        defaultResume.pdfMimeType ||
        "application/pdf";

      if (!resumeDataUrl) {
        return { attached: false, reason: "missing_resume_data" };
      }

      const response = await fetch(resumeDataUrl);
      const blob = await response.blob();
      const file = new File([blob], resumeName, { type: mimeType });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      dispatchInputEvents(fileInput);
      return { attached: true, fileName: resumeName };
    }

    function detectAuthState() {
      const text = normalizeText(document.body?.innerText || "").toLowerCase();
      if (text.includes("sign in") || text.includes("create account")) {
        return "signed_out_or_unknown";
      }
      return "signed_in_or_unknown";
    }

    const filledFields = [];
    const generatedAnswers = [];
    const manualReviewReasons = [];
    if (
      activeApplyContext.jobId &&
      activeApplyContext.selectedResumeReadyForC3 === false
    ) {
      manualReviewReasons.push("resume_not_ready_for_c3");
    }

    const textInputs = getVisibleElements('input:not([type="hidden"]):not([type="file"])');
    for (const input of textInputs) {
      const descriptor = getDescriptor(input);
      if (!descriptor) {
        continue;
      }

      const profileValue = chooseProfileValue(descriptor);
      if (profileValue && setElementValue(input, profileValue)) {
        filledFields.push({ field: descriptor, valueSource: "profile" });
      }
    }

    const textareas = getVisibleElements("textarea");
    for (const textarea of textareas) {
      const descriptor = getDescriptor(textarea);
      if (!descriptor || textarea.value || settings.allowGeneratedAnswers === false) {
        continue;
      }

      const answer = generateAnswer(descriptor);
      if (setElementValue(textarea, answer.answerText)) {
        const questionText = descriptor;
        const questionHash = buildQuestionHash(questionText);
        generatedAnswers.push({
          questionHash,
          questionText,
          answerText: answer.answerText,
          answerSource: "generated",
          confidence: answer.confidence,
          manualReviewRequired: answer.manualReviewRequired
        });
        filledFields.push({ field: descriptor, valueSource: "generated_answer" });
        if (settings.flagLowConfidenceAnswers !== false && answer.manualReviewRequired) {
          manualReviewReasons.push(`low_confidence_answer:${questionHash}`);
        }
      }
    }

    const selects = getVisibleElements("select");
    for (const select of selects) {
      const descriptor = getDescriptor(select);
      if (descriptor && fillSelectElement(select, descriptor)) {
        filledFields.push({ field: descriptor, valueSource: "select_rule" });
      }
    }

    const radios = getVisibleElements('input[type="radio"]');
    const radiosByName = new Map();
    for (const radio of radios) {
      const name = radio.name || radio.id || Math.random().toString(36);
      if (!radiosByName.has(name)) {
        radiosByName.set(name, []);
      }
      radiosByName.get(name).push(radio);
    }

    for (const radioGroup of radiosByName.values()) {
      const descriptor = radioGroup.map((radio) => getDescriptor(radio)).join(" ").toLowerCase();
      if (fillRadioGroup(radioGroup, descriptor)) {
        filledFields.push({ field: descriptor, valueSource: "radio_rule" });
      }
    }

    const fileInputs = getVisibleElements('input[type="file"]');
    for (const fileInput of fileInputs) {
      const attachment = await attachResumeToFileInput(fileInput);
      if (attachment.attached) {
        filledFields.push({
          field: getDescriptor(fileInput) || "resume_upload",
          valueSource: "resume_upload"
        });
      } else {
        manualReviewReasons.push(`resume_upload:${attachment.reason}`);
      }
    }

    return {
      ok: true,
      atsType: "workday",
      authState: detectAuthState(),
      filledFieldCount: filledFields.length,
      generatedAnswerCount: generatedAnswers.length,
      manualReviewRequired: manualReviewReasons.length > 0,
      manualReviewReasons,
      filledFields,
      generatedAnswers,
      htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000)
    };
  };
}

async function captureScreenshotForTab(tabId) {
  try {
    return await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
  } catch (_error) {
    return "";
  }
}

async function runFillForTab(tabId, extensionState) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = tabId || tab?.id;
  if (!activeTabId) {
    return {
      ok: false,
      reason: "missing_tab",
      message: "No active tab is available for fill."
    };
  }

  const tabInfo = await chrome.tabs.get(activeTabId);
  if (!isWorkdayUrl(tabInfo.url || "")) {
    return {
      ok: false,
      reason: "unsupported_url",
      message: "Current tab is not a supported Workday application page."
    };
  }

  const [injectionResult] = await chrome.scripting.executeScript({
    target: { tabId: activeTabId },
    func: createWorkdayFillFunction(),
    args: [
      {
        profile: extensionState.profile,
        settings: extensionState.settings,
        activeApplyContext: extensionState.activeApplyContext,
        defaultResume: extensionState.defaultResume
      }
    ]
  });

  const result = injectionResult?.result || {
    ok: false,
    reason: "missing_result",
    message: "No fill result was returned."
  };

  const screenshotDataUrl = await captureScreenshotForTab(activeTabId);
  const attemptId = crypto.randomUUID();
  const attempt = await appendAttempt({
    id: attemptId,
    sourceMode: extensionState.activeApplyContext.jobId ? "c4_or_queue" : "manual",
    jobId: extensionState.activeApplyContext.jobId,
    applyUrl: extensionState.activeApplyContext.applyUrl || tabInfo.url || "",
    atsType: result.atsType || "workday",
    status: result.ok ? "filled" : "failed",
    authState: result.authState || "unknown",
    selectedResumeVersionId:
      extensionState.activeApplyContext.selectedResumeVersionId ||
      extensionState.defaultResume.versionId,
    selectedResumePath:
      extensionState.activeApplyContext.selectedResumePath ||
      extensionState.defaultResume.pdfPath,
    filledFieldCount: result.filledFieldCount || 0,
    generatedAnswerCount: result.generatedAnswerCount || 0,
    manualReviewRequired: Boolean(result.manualReviewRequired),
    manualReviewReasons: result.manualReviewReasons || [],
    htmlSnapshot: result.htmlSnapshot || "",
    screenshotDataUrl,
    resultSummary: result.ok
      ? `Filled ${result.filledFieldCount || 0} fields on a Workday page.`
      : result.message || result.reason || "Fill failed."
  });

  const answerEntries = (result.generatedAnswers || []).map((entry) => ({
    id: crypto.randomUUID(),
    applicationAttemptId: attempt.id,
    jobId: extensionState.activeApplyContext.jobId,
    questionHash: entry.questionHash,
    questionText: entry.questionText,
    answerText: entry.answerText,
    answerSource: entry.answerSource,
    confidence: entry.confidence,
    manualReviewRequired: entry.manualReviewRequired
  }));
  await appendQuestionAnswers(answerEntries);

  return {
    ok: result.ok,
    message: result.ok
      ? `Filled ${result.filledFieldCount || 0} fields and logged ${result.generatedAnswerCount || 0} generated answers.`
      : result.message || "Fill failed.",
    attempt,
    generatedAnswers: answerEntries,
    result
  };
}

async function maybeAutofillOnLoad(tabId, changeInfo, tab) {
  if (changeInfo.status !== "complete" || !isWorkdayUrl(tab?.url || "")) {
    return;
  }

  const state = await getExtensionState();
  if (
    !state.settings.autofillOnLoad ||
    !(
      state.activeApplyContext.selectedResumeDataUrl ||
      state.defaultResume.pdfDataUrl
    )
  ) {
    return;
  }

  await runFillForTab(tabId, state);
}

async function handleMessage(message) {
  switch (message?.type) {
    case "hunt.apply.ping":
      return { ok: true, source: "background" };
    case "hunt.apply.get_state":
      return { ok: true, ...(await getExtensionState()) };
    case "hunt.apply.save_settings":
      return { ok: true, settings: await saveSettings(message.payload || {}) };
    case "hunt.apply.save_profile":
      return { ok: true, profile: await saveProfile(message.payload || {}) };
    case "hunt.apply.save_default_resume":
      return {
        ok: true,
        defaultResume: await saveDefaultResume(message.payload || {})
      };
    case "hunt.apply.set_apply_context":
      return {
        ok: true,
        activeApplyContext: await saveActiveApplyContext(message.payload || {})
      };
    case "hunt.apply.clear_apply_context":
      return {
        ok: true,
        activeApplyContext: await clearActiveApplyContext()
      };
    case "hunt.apply.fill_current_page":
      {
        const state = await getExtensionState();
        if (!state.settings.manualFillEnabled) {
          return {
            ok: false,
            reason: "manual_fill_disabled",
            message: "Manual fill is currently disabled in extension settings."
          };
        }
        return runFillForTab(message.payload?.tabId, state);
      }
    default:
      return {
        ok: false,
        reason: "unknown_message",
        message: `Unknown message type: ${message?.type || "undefined"}`
      };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureStageOneState();
  console.log("Hunt Apply extension installed.");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureStageOneState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  maybeAutofillOnLoad(tabId, changeInfo, tab).catch((error) => {
    console.error("Autofill on load failed:", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) =>
      sendResponse({
        ok: false,
        reason: "background_error",
        message: error instanceof Error ? error.message : String(error)
      })
    );

  return true;
});
