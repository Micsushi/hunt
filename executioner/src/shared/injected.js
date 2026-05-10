// Hunt Apply - shared fill utilities.
// Injected into application pages via chrome.scripting.executeScript files:[].
// Must be a plain IIFE - no ES module syntax, no imports.
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
    return Array.from(document.querySelectorAll(selector)).filter(
      function (el) {
        var s = window.getComputedStyle(el);
        var r = el.getBoundingClientRect();
        return (
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          r.width > 0 &&
          r.height > 0 &&
          !el.disabled
        );
      },
    );
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
    if (el.isContentEditable || el.getAttribute("role") === "textbox") {
      el.textContent = normalized;
    } else {
      var proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null;
      var setter = proto
        ? Object.getOwnPropertyDescriptor(proto, "value")?.set
        : null;
      if (setter) {
        setter.call(el, normalized);
      } else {
        el.value = normalized;
      }
    }
    u.dispatchInputEvents(el);
    return true;
  };

  function pushUnique(parts, value) {
    var text = u.normalizeText(value);
    if (text && !parts.includes(text)) {
      parts.push(text);
    }
  }

  function visibleText(el) {
    if (!el) {
      return "";
    }
    var style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") {
      return "";
    }
    return u.normalizeText(el.innerText || el.textContent || "");
  }

  // Collect label-like text even when sites use divs instead of real labels.
  u.getAssociatedText = function (el, containerSelectors) {
    var parts = [];
    var labelledBy = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean);
    labelledBy.forEach(function (id) {
      pushUnique(parts, visibleText(document.getElementById(id)));
    });

    if (el.id) {
      Array.from(
        document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]'),
      ).forEach(function (label) {
        pushUnique(parts, visibleText(label));
      });
    }

    var closestLabel = el.closest("label");
    if (closestLabel) {
      pushUnique(parts, visibleText(closestLabel));
    }

    var selectors = containerSelectors || [];
    for (var i = 0; i < selectors.length; i++) {
      var container = el.closest(selectors[i]);
      if (container) {
        var containerText = visibleText(container);
        if (containerText.length <= 300) {
          pushUnique(parts, containerText);
        }
      }
    }
    if (parts.length > 0) {
      return u.normalizeText(parts.join(" "));
    }

    var current = el;
    for (
      var depth = 0;
      depth < 4 && current && current.parentElement;
      depth++
    ) {
      var prev = current.previousElementSibling;
      var siblingCount = 0;
      var foundSiblingText = false;
      while (prev && siblingCount < 3) {
        var prevText = visibleText(prev);
        if (prevText.length <= 180) {
          pushUnique(parts, prevText);
          foundSiblingText = true;
        }
        prev = prev.previousElementSibling;
        siblingCount++;
      }
      if (foundSiblingText) {
        break;
      }

      var parent = current.parentElement;
      if (parent.matches && parent.matches("form, body, html")) {
        break;
      }
      var parentText = visibleText(parent);
      if (parentText.length <= 220) {
        pushUnique(parts, parentText);
      }
      current = parent;
    }

    return u.normalizeText(parts.join(" "));
  };

  // Walk up the DOM looking for a label-like container to extract question text.
  // containerSelectors: ATS-specific list, e.g. ['label', '[data-automation-id="formField"]'].
  u.getContainerText = function (el, containerSelectors) {
    return u.getAssociatedText(
      el,
      containerSelectors || ["label", '[role="group"]'],
    );
  };

  // Build a lowercase descriptor string for a field used to match profile keys.
  u.getDescriptor = function (el, containerSelectors) {
    return u
      .normalizeText(
        [
          el.type,
          el.getAttribute("autocomplete"),
          el.getAttribute("data-testid"),
          el.getAttribute("data-automation-id"),
          el.name,
          el.id,
          el.getAttribute("aria-label"),
          el.getAttribute("placeholder"),
          u.getContainerText(el, containerSelectors),
        ]
          .filter(Boolean)
          .join(" "),
      )
      .toLowerCase();
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

  function phraseInDescriptor(descriptor, phrase) {
    var escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^a-z0-9])" + escaped + "([^a-z0-9]|$)").test(
      descriptor,
    );
  }

  // Map a field descriptor to the right profile value.
  // Returns { value, key } for logging/debugging, or null if no match.
  u.chooseProfileMatch = function (descriptor, profile) {
    var desc = u.normalizeText(descriptor).toLowerCase();
    var isLegalWorkQuestion =
      desc.includes("legally") ||
      desc.includes("authorized") ||
      desc.includes("eligible to work") ||
      desc.includes("work authorization");
    var fullName = u.normalizeText(profile.fullName);
    var nameParts = fullName.split(" ").filter(Boolean);
    var firstName = nameParts[0] || "";
    var lastName = nameParts.slice(1).join(" ");
    var mapping = [
      [["email", "e-mail"], profile.email, "profile:email", 10],
      [
        ["phone", "phone number", "mobile", "telephone"],
        profile.phone,
        "profile:phone",
        10,
      ],
      [["linkedin"], profile.linkedinUrl, "profile:linkedinUrl", 10],
      [["github"], profile.githubUrl, "profile:githubUrl", 10],
      [
        ["website", "portfolio", "personal site"],
        profile.websiteUrl,
        "profile:websiteUrl",
        10,
      ],
      [
        ["last name", "family name", "surname"],
        lastName,
        "profile:lastName",
        20,
      ],
      [["first name", "given name"], firstName, "profile:firstName", 20],
      [
        ["full name", "legal name", "candidate name"],
        fullName,
        "profile:fullName",
        30,
      ],
      [["city", "location"], profile.location, "profile:location", 40],
    ];
    var matches = [];
    for (var i = 0; i < mapping.length; i++) {
      var keywords = mapping[i][0];
      var value = mapping[i][1];
      var key = mapping[i][2];
      var priority = mapping[i][3];
      var normalizedValue = u.normalizeText(value);
      if (!normalizedValue) {
        continue;
      }
      if (key === "profile:location" && isLegalWorkQuestion) {
        continue;
      }
      keywords.forEach(function (keyword) {
        if (!phraseInDescriptor(desc, keyword)) {
          return;
        }
        var index = desc.indexOf(keyword);
        matches.push({
          value: normalizedValue,
          key: key,
          index: index < 0 ? 9999 : index,
          priority: priority,
        });
      });
    }
    matches.sort(function (a, b) {
      return a.index - b.index || a.priority - b.priority;
    });
    if (matches[0]) {
      return { value: matches[0].value, key: matches[0].key };
    }
    if (phraseInDescriptor(desc, "name") && fullName) {
      return { value: fullName, key: "profile:fullName" };
    }
    return null;
  };

  // Backward-compatible helper for adapters that only need the value.
  u.chooseProfileValue = function (descriptor, profile) {
    var match = u.chooseProfileMatch(descriptor, profile);
    if (match) {
      return match.value;
    }
    return "";
  };

  // --- answer generation ---------------------------------------------------

  var STOP_WORDS = new Set([
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
    "work",
  ]);

  // Return the top-N highest-frequency meaningful tokens from a text blob.
  u.extractDescriptionTerms = function (text, maxTerms) {
    var max = maxTerms || 3;
    var counts = new Map();
    var tokens =
      u
        .normalizeText(text)
        .toLowerCase()
        .match(/[a-z][a-z0-9+#/-]{3,}/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!STOP_WORDS.has(t)) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort(function (a, b) {
        return b[1] - a[1] || a[0].localeCompare(b[0]);
      })
      .slice(0, max)
      .map(function (pair) {
        return pair[0];
      });
  };

  // Generate a heuristic answer for a free-text question.
  // Returns { answerText, confidence, manualReviewRequired }.
  u.generateAnswer = function (
    questionText,
    profile,
    applyContext,
    stripLongDash,
  ) {
    var q = u.normalizeText(questionText).toLowerCase();
    var notes = u.normalizeText(profile.notes, stripLongDash);
    var jobTitle = u.normalizeText(applyContext.title, stripLongDash);
    var company = u.normalizeText(applyContext.company, stripLongDash);
    var descTerms = u.extractDescriptionTerms(applyContext.description);
    var resumeTerms = u.extractDescriptionTerms(
      u.normalizeText(applyContext.selectedResumeSummary),
      2,
    );
    var focusArea = descTerms.slice(0, 2).join(" and ");
    var resumeFocus = resumeTerms.join(" and ");
    var contextRole = [jobTitle, company ? "at " + company : ""]
      .filter(Boolean)
      .join(" ");
    var weakContext = (applyContext.concernFlags || []).includes(
      "weak_description",
    );

    if (q.includes("sponsor")) {
      return {
        answerText: profile.sponsorshipRequired ? "Yes." : "No.",
        confidence: "high",
        manualReviewRequired: false,
      };
    }

    if (q.includes("relocat")) {
      return {
        answerText: profile.willingToRelocate ? "Yes." : "No.",
        confidence: "high",
        manualReviewRequired: false,
      };
    }

    if (q.includes("salary")) {
      return {
        answerText: profile.salaryFlexible
          ? "I am flexible and open to discussing compensation based on the role and overall package."
          : "I am open to discussing compensation based on the role and overall package.",
        confidence: "medium",
        manualReviewRequired: false,
      };
    }

    if (q.includes("authorized") || q.includes("legally")) {
      return {
        answerText: profile.workAuthorized ? "Yes." : "No.",
        confidence: "high",
        manualReviewRequired: false,
      };
    }

    if (q.includes("why") || q.includes("interest")) {
      var whyAnswer = contextRole
        ? "I am interested in the " +
          contextRole +
          " opportunity because it aligns well with my background" +
          (focusArea ? " in " + focusArea : "") +
          (resumeFocus ? " and with experience around " + resumeFocus : "") +
          " and would let me contribute quickly while continuing to grow."
        : "";
      return {
        answerText:
          notes ||
          whyAnswer ||
          "I am interested in the role because it aligns well with my background and I believe I can contribute quickly while continuing to grow with the team.",
        confidence: notes
          ? "medium"
          : whyAnswer && !weakContext
            ? "medium"
            : "low",
        manualReviewRequired: !notes && (!whyAnswer || weakContext),
      };
    }

    var fallback =
      contextRole && (focusArea || resumeFocus)
        ? "I believe my background is a strong fit for the " +
          contextRole +
          " opportunity, especially around " +
          (focusArea || resumeFocus) +
          (focusArea && resumeFocus
            ? ", with experience in " + resumeFocus
            : "") +
          "."
        : contextRole
          ? "I believe my background is a strong fit for the " +
            contextRole +
            " opportunity and I would be excited to contribute while continuing to grow in the role."
          : "";
    return {
      answerText:
        fallback ||
        "I believe my background is a strong fit for this opportunity, and I would be excited to contribute while continuing to grow in the role.",
      confidence: fallback && !weakContext ? "medium" : "low",
      manualReviewRequired: !fallback || weakContext,
    };
  };

  // --- element fillers -----------------------------------------------------

  // Fill a <select> element based on the field descriptor and profile flags.
  function locationAliases(location) {
    var raw = u.normalizeText(location).toLowerCase();
    var aliases = new Set();
    if (!raw) {
      return aliases;
    }
    aliases.add(raw);
    var city = raw.split(",")[0].trim();
    if (city) {
      aliases.add(city);
    }
    var provinceMap = {
      ab: "alberta",
      alberta: "alberta",
      bc: "british columbia",
      "b.c.": "british columbia",
      "british columbia": "british columbia",
      mb: "manitoba",
      manitoba: "manitoba",
      nb: "new brunswick",
      "new brunswick": "new brunswick",
      nl: "newfoundland and labrador",
      "newfoundland and labrador": "newfoundland and labrador",
      ns: "nova scotia",
      "nova scotia": "nova scotia",
      nt: "northwest territories",
      "northwest territories": "northwest territories",
      nu: "nunavut",
      nunavut: "nunavut",
      on: "ontario",
      ontario: "ontario",
      pe: "prince edward island",
      pei: "prince edward island",
      "prince edward island": "prince edward island",
      qc: "quebec",
      quebec: "quebec",
      sk: "saskatchewan",
      saskatchewan: "saskatchewan",
      yt: "yukon",
      yukon: "yukon",
    };
    var pieces = raw
      .split(/[,\s/]+/)
      .map(function (piece) {
        return piece.trim();
      })
      .filter(Boolean);
    pieces.forEach(function (piece) {
      if (provinceMap[piece]) {
        aliases.add(provinceMap[piece]);
      }
    });
    aliases.add("canada");
    aliases.add("elsewhere in canada");
    return aliases;
  }

  function chooseStructuredChoice(descriptor, profile, stripLongDash) {
    var lowered = u.normalizeText(descriptor).toLowerCase();
    var isLegalWorkQuestion =
      lowered.includes("legally") ||
      lowered.includes("authorized") ||
      lowered.includes("eligible to work") ||
      lowered.includes("work authorization");
    var yesNoChoice = function (value, source) {
      var normalized = u.normalizeText(value).toLowerCase();
      if (!normalized) {
        return null;
      }
      if (["yes", "true", "1"].includes(normalized)) {
        return { text: "Yes", source: source };
      }
      if (["no", "false", "0"].includes(normalized)) {
        return { text: "No", source: source };
      }
      return null;
    };

    if (lowered.includes("sponsor")) {
      return {
        text: profile.sponsorshipRequired ? "Yes" : "No",
        source: "profile:sponsorshipRequired",
      };
    }
    if (isLegalWorkQuestion) {
      return {
        text: profile.workAuthorized ? "Yes" : "No",
        source: "profile:workAuthorized",
      };
    }
    if (lowered.includes("relocat")) {
      return {
        text: profile.willingToRelocate ? "Yes" : "No",
        source: "profile:willingToRelocate",
      };
    }
    if (lowered.includes("salary")) {
      return {
        text: profile.salaryFlexible ? "Yes" : "No",
        source: "profile:salaryFlexible",
      };
    }
    if (
      !isLegalWorkQuestion &&
      (lowered.includes("city") ||
        lowered.includes("located in") ||
        lowered.includes("current location"))
    ) {
      var location = u.normalizeText(profile.location, stripLongDash);
      if (location) {
        return {
          text: location,
          source: "profile:location",
          aliases: Array.from(locationAliases(location)),
        };
      }
    }
    if (lowered.includes("co-op") || lowered.includes("coop")) {
      var terms = u.normalizeText(profile.coOpTermsCompleted);
      if (terms) {
        return {
          text: terms,
          source: "profile:coOpTermsCompleted",
          aliases: [terms + " terms", terms + " term"],
        };
      }
    }
    if (
      lowered.includes("summer 2026") ||
      lowered.includes("available for the summer") ||
      lowered.includes("available for this term")
    ) {
      return yesNoChoice(
        profile.availableSummer2026,
        "profile:availableSummer2026",
      );
    }
    if (lowered.includes("interview") && lowered.includes("available")) {
      return yesNoChoice(
        profile.availableInterviewWindow,
        "profile:availableInterviewWindow",
      );
    }
    if (lowered.includes("graduation")) {
      var graduationYear = u.normalizeText(profile.expectedGraduationYear);
      if (graduationYear) {
        return {
          text: graduationYear,
          source: "profile:expectedGraduationYear",
        };
      }
    }
    if (
      lowered.includes("previously worked at") ||
      lowered.includes("worked at")
    ) {
      var match = lowered.match(/worked at ([a-z0-9 .&'-]+)/);
      var employer = match ? u.normalizeText(match[1]).toLowerCase() : "";
      var previous = u.normalizeText(profile.previousEmployers).toLowerCase();
      if (previous) {
        return {
          text: employer && previous.includes(employer) ? "Yes" : "No",
          source: "profile:previousEmployers",
        };
      }
    }
    return null;
  }

  function optionScoreForChoice(
    optionText,
    optionValue,
    choice,
    stripLongDash,
  ) {
    var option = u
      .normalizeText(
        [optionText, optionValue].filter(Boolean).join(" "),
        stripLongDash,
      )
      .toLowerCase();
    var target = u.normalizeText(choice.text, stripLongDash).toLowerCase();
    if (!option) {
      return 0;
    }
    if (target === "yes" || target === "no") {
      return option === target || option.startsWith(target + " ") ? 100 : 0;
    }
    if (option === target) {
      return 100;
    }
    if (option.includes(target) || target.includes(option)) {
      return 80;
    }
    var aliases = choice.aliases || [];
    for (var i = 0; i < aliases.length; i++) {
      var alias = aliases[i];
      if (!alias) {
        continue;
      }
      if (option === alias) {
        return alias === "elsewhere in canada" ? 70 : 90;
      }
      if (option.includes(alias) || alias.includes(option)) {
        return alias === "elsewhere in canada" ? 70 : 85;
      }
    }
    if (
      aliases.includes("canada") &&
      option.includes("elsewhere") &&
      option.includes("canada")
    ) {
      return 70;
    }
    if (option === "other") {
      return 20;
    }
    return 0;
  }

  u.fillSelectElement = function (el, descriptor, profile, stripLongDash) {
    var options = Array.from(el.options || []);
    var choice = chooseStructuredChoice(descriptor, profile, stripLongDash);
    if (!choice) {
      return { filled: false, reason: "no_known_choice" };
    }
    var selectedOption = options
      .map(function (o) {
        return {
          option: o,
          score: optionScoreForChoice(o.text, o.value, choice, stripLongDash),
        };
      })
      .filter(function (candidate) {
        return candidate.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      })[0]?.option;

    if (!selectedOption) {
      return { filled: false, reason: "no_matching_option" };
    }
    el.value = selectedOption.value;
    u.dispatchInputEvents(el);
    return { filled: true, valueSource: choice.source };
  };

  u.fillComboboxElement = async function (
    el,
    descriptor,
    profile,
    stripLongDash,
  ) {
    var choice = chooseStructuredChoice(descriptor, profile, stripLongDash);
    if (!choice) {
      return { filled: false, reason: "no_known_choice" };
    }

    var targetText = u.normalizeText(choice.text, stripLongDash);
    if (!targetText) {
      return { filled: false, reason: "empty_choice" };
    }

    var sleep = function (ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    };
    var optionMatches = function (option) {
      var text = u.normalizeText(
        option.innerText || option.textContent,
        stripLongDash,
      );
      return optionScoreForChoice(text, "", choice, stripLongDash) > 0;
    };
    var key = function (keyName) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: keyName, bubbles: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keyup", { key: keyName, bubbles: true }),
      );
    };
    var looksCommitted = function () {
      var container = el.closest(".select__container") || el.parentElement;
      var text = u
        .normalizeText(container ? container.innerText : "", stripLongDash)
        .toLowerCase();
      var target = targetText.toLowerCase();
      var inputValue = u.normalizeText(el.value, stripLongDash).toLowerCase();
      return inputValue === target && text.includes(target);
    };
    var findVisibleOption = function () {
      return Array.from(
        document.querySelectorAll(
          '[role="option"], [id*="-option-"], .select__option, [class*="__option"], [class*="-option"]',
        ),
      ).find(function (option) {
        var style = window.getComputedStyle(option);
        var rect = option.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          optionMatches(option)
        );
      });
    };

    el.focus();
    (el.closest(".select__control") || el).click();
    await sleep(120);
    u.setElementValue(el, targetText, stripLongDash);
    key(targetText.length === 1 ? targetText : targetText[0] || "");
    await sleep(450);

    var option = findVisibleOption();
    if (!option) {
      key("ArrowDown");
      await sleep(120);
      option = findVisibleOption();
    }
    if (option) {
      option.click();
      await sleep(120);
      u.dispatchInputEvents(el);
      return { filled: true, valueSource: choice.source };
    }

    key("Enter");
    await sleep(180);
    key("Tab");
    await sleep(120);
    u.dispatchInputEvents(el);
    if (looksCommitted()) {
      return { filled: true, valueSource: choice.source };
    }
    return { filled: false, reason: "no_matching_option" };
  };

  // Click the correct radio in a group based on the descriptor and profile flags.
  // containerSelectors: passed through to getDescriptor for individual radios.
  u.fillRadioGroup = function (
    radios,
    descriptor,
    profile,
    containerSelectors,
  ) {
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
  u.attachResumeToFileInput = async function (
    fileInput,
    applyContext,
    defaultResume,
  ) {
    var dataUrl =
      applyContext.selectedResumeDataUrl || defaultResume.pdfDataUrl;
    var fileName =
      applyContext.selectedResumeName ||
      defaultResume.pdfFileName ||
      "resume.pdf";
    var mimeType =
      applyContext.selectedResumeMimeType ||
      defaultResume.pdfMimeType ||
      "application/pdf";

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
    var text = u
      .normalizeText(document.body ? document.body.innerText : "")
      .toLowerCase();
    if (text.includes("sign in") || text.includes("create account")) {
      return "signed_out_or_unknown";
    }
    return "signed_in_or_unknown";
  };

  window.__huntApplyUtils = u;
})();
