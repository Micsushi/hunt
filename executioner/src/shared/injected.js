// Hunt Apply - shared fill utilities.
// Injected into application pages via chrome.scripting.executeScript files:[].
// Must be a plain IIFE — no ES module syntax, no imports.
// Sets up window.__huntApplyUtils consumed by every ATS adapter fill function.
(function () {
  "use strict";

  var u = {};

  // --- text ----------------------------------------------------------------

  // Strip em/en dashes and collapse whitespace.
  // stripLongDash defaults to true; pass false to disable.
  u.normalizeText = function (value, stripLongDash) {
    var s = String(value == null ? "" : value);
    if (stripLongDash !== false) {
      s = s.replace(/\u2014/g, "-").replace(/\u2013/g, "-");
    }
    return s.replace(/\s+/g, " ").trim();
  };

  // Cheap deterministic hash for a question string (used as storage key).
  u.buildQuestionHash = function (value) {
    var hash = 0;
    var s = String(value || "");
    for (var i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    }
    return "q_" + hash.toString(16);
  };

  // --- DOM -----------------------------------------------------------------

  // Returns all visible, enabled elements matching selector.
  u.getVisibleElements = function (selector) {
    return Array.from(document.querySelectorAll(selector)).filter(function (el) {
      var s = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return (
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        r.width > 0 &&
        r.height > 0 &&
        !el.disabled
      );
    });
  };

  // Fire the events frameworks listen for to pick up programmatic value changes.
  u.dispatchInputEvents = function (el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  };

  // Set a field value and fire framework events.
  // stripLongDash: pass true/false explicitly from caller settings.
  u.setElementValue = function (el, value, stripLongDash) {
    var normalized = u.normalizeText(value, stripLongDash);
    if (!normalized) {
      return false;
    }
    el.focus();
    el.value = normalized;
    u.dispatchInputEvents(el);
    return true;
  };

  // Walk up the DOM looking for a label-like container to extract question text.
  // containerSelectors: ATS-specific list, e.g. ['label', '[data-automation-id="formField"]'].
  u.getContainerText = function (el, containerSelectors) {
    var selectors = containerSelectors || ["label", '[role="group"]'];
    var container = null;
    for (var i = 0; i < selectors.length; i++) {
      container = el.closest(selectors[i]);
      if (container) {
        break;
      }
    }
    container = container || el.parentElement;
    return u.normalizeText(container ? container.innerText : "");
  };

  // Build a lowercase descriptor string for a field used to match profile keys.
  u.getDescriptor = function (el, containerSelectors) {
    return u.normalizeText(
      [
        el.name,
        el.id,
        el.getAttribute("aria-label"),
        el.getAttribute("placeholder"),
        u.getContainerText(el, containerSelectors)
      ]
        .filter(Boolean)
        .join(" ")
    ).toLowerCase();
  };

  // Sort fill candidates top-to-bottom, left-to-right by bounding rect.
  u.sortCandidatesByPosition = function (candidates) {
    return candidates.slice().sort(function (a, b) {
      if (a.rect.top !== b.rect.top) {
        return a.rect.top - b.rect.top;
      }
      return a.rect.left - b.rect.left;
    });
  };

  // --- profile mapping -----------------------------------------------------

  // Map a field descriptor to the right profile value.
  // Returns an empty string if no match.
  u.chooseProfileValue = function (descriptor, profile) {
    var mapping = [
      [["first name", "given name"], (profile.fullName.split(" ")[0] || "")],
      [["last name", "family name", "surname"], (profile.fullName.split(" ").slice(1).join(" ") || "")],
      [["full name", "legal name", "name"], profile.fullName],
      [["email", "e-mail"], profile.email],
      [["phone", "mobile"], profile.phone],
      [["city", "location", "address"], profile.location],
      [["linkedin"], profile.linkedinUrl],
      [["github"], profile.githubUrl],
      [["website", "portfolio", "personal site"], profile.websiteUrl]
    ];
    for (var i = 0; i < mapping.length; i++) {
      var keywords = mapping[i][0];
      var value = mapping[i][1];
      if (keywords.some(function (k) { return descriptor.includes(k); }) && u.normalizeText(value)) {
        return u.normalizeText(value);
      }
    }
    return "";
  };

  // --- answer generation ---------------------------------------------------

  var STOP_WORDS = new Set([
    "about", "across", "ability", "candidate", "company", "customer",
    "deliver", "experience", "including", "looking", "opportunity",
    "preferred", "required", "responsible", "strong", "team",
    "their", "using", "with", "work"
  ]);

  // Return the top-N highest-frequency meaningful tokens from a text blob.
  u.extractDescriptionTerms = function (text, maxTerms) {
    var max = maxTerms || 3;
    var counts = new Map();
    var tokens = u.normalizeText(text).toLowerCase().match(/[a-z][a-z0-9+#/-]{3,}/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!STOP_WORDS.has(t)) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); })
      .slice(0, max)
      .map(function (pair) { return pair[0]; });
  };

  // Generate a heuristic answer for a free-text question.
  // Returns { answerText, confidence, manualReviewRequired }.
  u.generateAnswer = function (questionText, profile, applyContext, stripLongDash) {
    var q = u.normalizeText(questionText).toLowerCase();
    var notes = u.normalizeText(profile.notes, stripLongDash);
    var jobTitle = u.normalizeText(applyContext.title, stripLongDash);
    var company = u.normalizeText(applyContext.company, stripLongDash);
    var descTerms = u.extractDescriptionTerms(applyContext.description);
    var resumeTerms = u.extractDescriptionTerms(u.normalizeText(applyContext.selectedResumeSummary), 2);
    var focusArea = descTerms.slice(0, 2).join(" and ");
    var resumeFocus = resumeTerms.join(" and ");
    var contextRole = [jobTitle, company ? "at " + company : ""].filter(Boolean).join(" ");
    var weakContext = (applyContext.concernFlags || []).includes("weak_description");

    if (q.includes("sponsor")) {
      return { answerText: profile.sponsorshipRequired ? "Yes." : "No.", confidence: "high", manualReviewRequired: false };
    }

    if (q.includes("relocat")) {
      return { answerText: profile.willingToRelocate ? "Yes." : "No.", confidence: "high", manualReviewRequired: false };
    }

    if (q.includes("salary")) {
      return {
        answerText: profile.salaryFlexible
          ? "I am flexible and open to discussing compensation based on the role and overall package."
          : "I am open to discussing compensation based on the role and overall package.",
        confidence: "medium",
        manualReviewRequired: false
      };
    }

    if (q.includes("authorized") || q.includes("legally")) {
      return { answerText: profile.workAuthorized ? "Yes." : "No.", confidence: "high", manualReviewRequired: false };
    }

    if (q.includes("why") || q.includes("interest")) {
      var whyAnswer = contextRole
        ? "I am interested in the " + contextRole + " opportunity because it aligns well with my background" +
          (focusArea ? " in " + focusArea : "") +
          (resumeFocus ? " and with experience around " + resumeFocus : "") +
          " and would let me contribute quickly while continuing to grow."
        : "";
      return {
        answerText: notes || whyAnswer ||
          "I am interested in the role because it aligns well with my background and I believe I can contribute quickly while continuing to grow with the team.",
        confidence: notes ? "medium" : (whyAnswer && !weakContext ? "medium" : "low"),
        manualReviewRequired: !notes && (!whyAnswer || weakContext)
      };
    }

    var fallback = contextRole && (focusArea || resumeFocus)
      ? "I believe my background is a strong fit for the " + contextRole + " opportunity, especially around " +
        (focusArea || resumeFocus) +
        (focusArea && resumeFocus ? ", with experience in " + resumeFocus : "") + "."
      : contextRole
        ? "I believe my background is a strong fit for the " + contextRole +
          " opportunity and I would be excited to contribute while continuing to grow in the role."
        : "";
    return {
      answerText: fallback ||
        "I believe my background is a strong fit for this opportunity, and I would be excited to contribute while continuing to grow in the role.",
      confidence: fallback && !weakContext ? "medium" : "low",
      manualReviewRequired: !fallback || weakContext
    };
  };

  // --- element fillers -----------------------------------------------------

  // Fill a <select> element based on the field descriptor and profile flags.
  u.fillSelectElement = function (el, descriptor, profile, stripLongDash) {
    var options = Array.from(el.options || []);
    var yesValues = ["yes", "true", "authorized", "i am authorized"];
    var noValues = ["no", "false", "not authorized", "i am not authorized"];
    var chooseOption = function (candidates) {
      return options.find(function (o) {
        return candidates.some(function (c) { return u.normalizeText(o.text).toLowerCase() === c; });
      });
    };

    var selectedOption = null;

    if (descriptor.includes("sponsor")) {
      selectedOption = profile.sponsorshipRequired ? chooseOption(yesValues) : chooseOption(noValues);
    } else if (descriptor.includes("authorized") || descriptor.includes("legally")) {
      selectedOption = profile.workAuthorized ? chooseOption(yesValues) : chooseOption(noValues);
    } else if (descriptor.includes("relocat")) {
      selectedOption = profile.willingToRelocate ? chooseOption(yesValues) : chooseOption(noValues);
    } else if (descriptor.includes("linkedin") && profile.linkedinUrl) {
      return u.setElementValue(el, profile.linkedinUrl, stripLongDash);
    }

    if (!selectedOption) {
      return false;
    }
    el.value = selectedOption.value;
    u.dispatchInputEvents(el);
    return true;
  };

  // Click the correct radio in a group based on the descriptor and profile flags.
  // containerSelectors: passed through to getDescriptor for individual radios.
  u.fillRadioGroup = function (radios, descriptor, profile, containerSelectors) {
    var lowered = descriptor.toLowerCase();
    var choice = null;

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
    var target = radios.find(function (r) {
      return u.getDescriptor(r, containerSelectors).includes(choice);
    });
    if (!target) {
      return false;
    }
    target.click();
    u.dispatchInputEvents(target);
    return true;
  };

  // Attach the active resume PDF to a file input via DataTransfer.
  u.attachResumeToFileInput = async function (fileInput, applyContext, defaultResume) {
    var dataUrl = applyContext.selectedResumeDataUrl || defaultResume.pdfDataUrl;
    var fileName = applyContext.selectedResumeName || defaultResume.pdfFileName || "resume.pdf";
    var mimeType = applyContext.selectedResumeMimeType || defaultResume.pdfMimeType || "application/pdf";

    if (!dataUrl) {
      return { attached: false, reason: "missing_resume_data" };
    }

    var response = await fetch(dataUrl);
    var blob = await response.blob();
    var file = new File([blob], fileName, { type: mimeType });
    var transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    u.dispatchInputEvents(fileInput);
    return { attached: true, fileName: fileName };
  };

  // --- auth ----------------------------------------------------------------

  // Coarse page-text scan to detect signed-out state.
  u.detectAuthState = function () {
    var text = u.normalizeText(document.body ? document.body.innerText : "").toLowerCase();
    if (text.includes("sign in") || text.includes("create account")) {
      return "signed_out_or_unknown";
    }
    return "signed_in_or_unknown";
  };

  window.__huntApplyUtils = u;
})();
