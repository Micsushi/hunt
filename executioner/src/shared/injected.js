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
    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: " ",
        }),
      );
    } catch (_error) {
      // Older pages may not support constructable InputEvent.
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: "",
        }),
      );
    } catch (_error) {
      // Plain input/change events above still cover older pages.
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    try {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    } catch (_error) {
      el.dispatchEvent(new Event("focusout", { bubbles: true }));
    }
  };

  u.traceInteraction = function () {};

  function traceInteraction(action, target, detail) {
    if (typeof u.traceInteraction === "function") {
      u.traceInteraction(action, target, detail || {});
    }
  }

  function traceHoverAndClick(target, reason) {
    traceInteraction("hover", target, { reason: reason || "" });
    traceInteraction("click", target, { reason: reason || "" });
  }

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
      if (setter && el instanceof HTMLTextAreaElement) {
        setter.call(el, normalized);
        u.dispatchInputEvents(el);
      } else if (setter) {
        setter.call(el, "");
        u.dispatchInputEvents(el);
        var nextValue = "";
        normalized.split("").forEach(function (char) {
          nextValue += char;
          el.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: char,
              bubbles: true,
              cancelable: true,
            }),
          );
          setter.call(el, nextValue);
          try {
            el.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                cancelable: true,
                inputType: "insertText",
                data: char,
              }),
            );
          } catch (_error) {
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          el.dispatchEvent(
            new KeyboardEvent("keyup", {
              key: char,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
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

  u.getCandidateOptions = function (el) {
    if (!el) {
      return [];
    }
    var seen = new Set();
    var options = [];
    var add = function (value) {
      var text = u.normalizeText(value);
      var key = text.toLowerCase();
      if (key === "no options" || key === "no results") {
        return;
      }
      if (text && !seen.has(key)) {
        seen.add(key);
        options.push(text);
      }
    };
    if (el.tagName === "SELECT") {
      Array.from(el.options || []).forEach(function (option) {
        add(option.text || option.value);
      });
      return options;
    }
    var controls = el.getAttribute("aria-controls") || "";
    var controlledListbox = controls ? document.getElementById(controls) : null;
    if (controlledListbox) {
      Array.from(
        controlledListbox.querySelectorAll(
          '[role="option"], option, .option, .select__option, [class*="__option"], [class*="-option"]',
        ),
      ).forEach(function (option) {
        add(option.innerText || option.textContent || option.value);
      });
      return options.slice(0, 80);
    }
    var containers = [
      el.closest(".custom-select"),
      el.closest(".application-field"),
      el.closest(".select__container"),
      el.closest('[role="group"]'),
      el.parentElement,
    ].filter(Boolean);
    containers.forEach(function (container) {
      Array.from(
        container.querySelectorAll(
          '[role="option"], option, .option, .select__option, [class*="__option"], [class*="-option"]',
        ),
      ).forEach(function (option) {
        add(option.innerText || option.textContent || option.value);
      });
    });
    if (el.getAttribute("aria-expanded") !== "true") {
      return options.slice(0, 80);
    }
    Array.from(
      document.querySelectorAll(
        '[role="option"], .select__option, [class*="__option"], [class*="-option"]',
      ),
    ).forEach(function (option) {
      var rect = option.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        add(option.innerText || option.textContent || option.value);
      }
    });
    return options.slice(0, 80);
  };

  // --- profile mapping -----------------------------------------------------

  function phraseInDescriptor(descriptor, phrase) {
    var escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^a-z0-9])" + escaped + "([^a-z0-9]|$)").test(
      descriptor,
    );
  }

  function locationParts(location) {
    var raw = u.normalizeText(location);
    var lowered = raw.toLowerCase();
    var provinceMap = {
      ab: "Alberta",
      alberta: "Alberta",
      bc: "British Columbia",
      "b.c.": "British Columbia",
      "british columbia": "British Columbia",
      mb: "Manitoba",
      manitoba: "Manitoba",
      nb: "New Brunswick",
      "new brunswick": "New Brunswick",
      nl: "Newfoundland and Labrador",
      "newfoundland and labrador": "Newfoundland and Labrador",
      ns: "Nova Scotia",
      "nova scotia": "Nova Scotia",
      nt: "Northwest Territories",
      "northwest territories": "Northwest Territories",
      nu: "Nunavut",
      nunavut: "Nunavut",
      on: "Ontario",
      ontario: "Ontario",
      pe: "Prince Edward Island",
      pei: "Prince Edward Island",
      "prince edward island": "Prince Edward Island",
      qc: "Quebec",
      quebec: "Quebec",
      sk: "Saskatchewan",
      saskatchewan: "Saskatchewan",
      yt: "Yukon",
      yukon: "Yukon",
    };
    var pieces = lowered
      .split(/[,\s/]+/)
      .map(function (piece) {
        return piece.trim();
      })
      .filter(Boolean);
    var province = "";
    pieces.forEach(function (piece) {
      if (!province && provinceMap[piece]) {
        province = provinceMap[piece];
      }
    });
    return {
      full: raw,
      city: raw.split(",")[0].trim(),
      province: province,
      country: raw ? "Canada" : "",
    };
  }

  function locationTextForDescriptor(descriptor, profile, stripLongDash) {
    var lowered = u.normalizeText(descriptor).toLowerCase();
    if (/\b(phone|telephone|mobile)\b/.test(lowered)) {
      return "";
    }
    var parts = locationParts(profile.location);
    if (!parts.full) {
      return "";
    }
    var asksProvince =
      lowered.includes("province") || lowered.includes("territory");
    var asksCity = lowered.includes("city");
    if (asksCity && asksProvince) {
      return parts.full;
    }
    if (asksProvince && parts.province) {
      return parts.province;
    }
    if (asksCity && parts.city) {
      return parts.city;
    }
    if (
      lowered.includes("located in") ||
      lowered.includes("current location") ||
      phraseInDescriptor(lowered, "location")
    ) {
      return parts.full;
    }
    return "";
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
    var middleName = u.normalizeText(profile.middleName);
    var accountEmail =
      u.normalizeText(profile.accountEmail) || u.normalizeText(profile.email);
    var accountPassword = u.normalizeText(profile.accountPassword);
    var isUnsafePasswordField =
      desc.includes("current password") ||
      desc.includes("old password") ||
      desc.includes("existing password") ||
      desc.includes("temporary password");
    if (
      phraseInDescriptor(desc, "middle name") ||
      desc.includes("middlename")
    ) {
      return middleName
        ? { value: middleName, key: "profile:middleName" }
        : null;
    }
    if (
      accountPassword &&
      desc.includes("password") &&
      !isUnsafePasswordField
    ) {
      return {
        value: accountPassword,
        key: "profile:accountPassword",
      };
    }
    if (
      accountEmail &&
      (phraseInDescriptor(desc, "username") ||
        phraseInDescriptor(desc, "user name") ||
        phraseInDescriptor(desc, "user id") ||
        phraseInDescriptor(desc, "login id") ||
        phraseInDescriptor(desc, "login email") ||
        phraseInDescriptor(desc, "account email"))
    ) {
      return {
        value: accountEmail,
        key: "profile:accountEmail",
      };
    }
    if (
      (desc.includes("addressline1") ||
        desc.includes("address line 1") ||
        desc.includes("street address")) &&
      u.normalizeText(profile.addressLine1)
    ) {
      return {
        value: u.normalizeText(profile.addressLine1),
        key: "profile:addressLine1",
      };
    }
    if (
      (desc.includes("addressline2") ||
        desc.includes("address line 2") ||
        desc.includes("apartment") ||
        desc.includes("suite")) &&
      u.normalizeText(profile.addressLine2)
    ) {
      return {
        value: u.normalizeText(profile.addressLine2),
        key: "profile:addressLine2",
      };
    }
    if (
      (desc.includes("postal code") ||
        desc.includes("postalcode") ||
        desc.includes("zip code") ||
        desc.includes("zip")) &&
      u.normalizeText(profile.postalCode)
    ) {
      return {
        value: u.normalizeText(profile.postalCode),
        key: "profile:postalCode",
      };
    }
    if (
      (desc.includes("expiry date") || desc.includes("expiration date")) &&
      u.normalizeText(profile.sinExpiryDate)
    ) {
      return {
        value: u.normalizeText(profile.sinExpiryDate),
        key: "profile:sinExpiryDate",
      };
    }
    if (desc.includes("salary") || desc.includes("compensation")) {
      var asksAnnualAmount =
        desc.includes("annual") ||
        desc.includes("yearly") ||
        desc.includes("amount") ||
        /\be\.g\.\s*\d+/i.test(desc);
      var salaryText = u.normalizeText(
        asksAnnualAmount
          ? profile.salaryExpectation
          : profile.salaryExpectation || profile.salaryExpectationRange,
      );
      if (salaryText) {
        return {
          value: salaryText,
          key: profile.salaryExpectation
            ? "profile:salaryExpectation"
            : "profile:salaryExpectationRange",
        };
      }
      return { value: "95000", key: "default:salaryExpectation" };
    }
    if (
      desc.includes("desired start date") ||
      desc.includes("available start date") ||
      desc.includes("start date")
    ) {
      var desiredStartDate = u.normalizeText(profile.desiredStartDate);
      if (desiredStartDate) {
        return {
          value: desiredStartDate,
          key: "profile:desiredStartDate",
        };
      }
      return { value: "2026-05-25", key: "default:desiredStartDate" };
    }
    var locationText = isLegalWorkQuestion
      ? ""
      : locationTextForDescriptor(desc, profile, true);
    if (locationText) {
      return { value: locationText, key: "profile:location" };
    }
    var mapping = [
      [
        [
          "login email",
          "account email",
          "create account email",
          "sign in email",
          "email address*",
        ],
        accountEmail,
        "profile:accountEmail",
        4,
      ],
      [["email", "e-mail"], profile.email, "profile:email", 10],
      [
        ["phone", "phone number", "mobile", "telephone"],
        profile.phone,
        "profile:phone",
        10,
      ],
      [
        ["address line 1", "addressline1", "street address"],
        profile.addressLine1,
        "profile:addressLine1",
        10,
      ],
      [
        ["address line 2", "addressline2", "apartment", "suite"],
        profile.addressLine2,
        "profile:addressLine2",
        10,
      ],
      [
        ["postal code", "postalcode", "zip code", "zip"],
        profile.postalCode,
        "profile:postalCode",
        10,
      ],
      [
        ["expiry date", "expiration date"],
        profile.sinExpiryDate,
        "profile:sinExpiryDate",
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
    var initialsFromProfile = function () {
      var fullName = u.normalizeText(profile.fullName || profile.name);
      var initials = fullName
        .split(/\s+/)
        .filter(Boolean)
        .map(function (part) {
          return part.charAt(0).toUpperCase();
        })
        .join("");
      return initials || "MS";
    };

    var inferWorkdayLocationFromApplyContext = function () {
      var rawUrl =
        applyContext.jobUrl || applyContext.applyUrl || applyContext.url || "";
      try {
        var parsed = new URL(rawUrl);
        var parts = parsed.pathname
          .split("/")
          .map(function (part) {
            try {
              return decodeURIComponent(part);
            } catch (_error) {
              return part;
            }
          })
          .filter(Boolean);
        var jobIndex = parts.indexOf("job");
        if (jobIndex >= 0 && parts[jobIndex + 1]) {
          return parts[jobIndex + 1]
            .replace(/---/g, " - ")
            .replace(/--/g, ", ")
            .replace(/-/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
      } catch (_error) {
        return "";
      }
      return "";
    };

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

    if (q.includes("salary") || q.includes("compensation")) {
      var expectedCompensation = u.normalizeText(
        profile.salaryExpectationRange || profile.salaryExpectation,
      );
      return {
        answerText:
          expectedCompensation ||
          (profile.salaryFlexible
            ? "I am flexible and open to discussing compensation based on the role and overall package."
            : "I am open to discussing compensation based on the role and overall package."),
        confidence: "medium",
        manualReviewRequired: false,
      };
    }

    if (q.includes("initials")) {
      return {
        answerText: initialsFromProfile(),
        confidence: "medium",
        manualReviewRequired: false,
      };
    }

    if (
      q.includes("location") &&
      (q.includes("preference") || q.includes("preferred") || q.includes("top"))
    ) {
      var inferredLocation = inferWorkdayLocationFromApplyContext();
      var preferredLocation =
        inferredLocation || u.normalizeText(profile.location, stripLongDash);
      return {
        answerText: preferredLocation,
        confidence: inferredLocation ? "medium" : "low",
        manualReviewRequired: !preferredLocation,
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

  function locationOptionLayers(location) {
    var parts = locationParts(location);
    var layers = [];
    if (parts.city) {
      layers.push({ kind: "city", terms: [parts.city], score: 120 });
    }
    if (parts.province) {
      var provinceTerms = [parts.province];
      var rawPieces = u
        .normalizeText(location)
        .split(/[,\s/]+/)
        .map(function (piece) {
          return piece.trim();
        })
        .filter(Boolean);
      rawPieces.forEach(function (piece) {
        if (
          piece.length <= 3 &&
          u.normalizeText(piece).toLowerCase() !==
            u.normalizeText(parts.city).toLowerCase()
        ) {
          provinceTerms.push(piece);
        }
      });
      layers.push({ kind: "province", terms: provinceTerms, score: 100 });
    }
    if (parts.country) {
      layers.push({ kind: "country", terms: [parts.country], score: 80 });
    }
    return layers;
  }

  function chooseStructuredChoice(descriptor, profile, stripLongDash) {
    var lowered = u.normalizeText(descriptor).toLowerCase();
    var loweredCompacted = lowered.replace(/\s+/g, "");
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
    var nonDisclosureChoice = function (source) {
      return {
        text: "I choose not to disclose",
        source: source || "default:notDisclosed",
        aliases: [
          "I choose not to disclose",
          "I choo e not to di clo e",
          "Choose not to disclose",
          "Choo e not to di clo e",
          "I prefer not to respond",
          "I prefer not to re pond",
          "Prefer not to respond",
          "Prefer not to re pond",
          "I prefer not to disclose",
          "Prefer not to disclose",
          "Prefer not to di clo e",
          "I prefer not to answer",
          "Prefer not to answer",
          "I'd rather not say",
          "I'd rather not answer",
          "Do not wish to disclose",
          "Do not wi h to di clo e",
          "I do not wish to self-identify",
          "I do not wi h to self-identify",
          "I do not wi h to elf-identify",
          "I do not wish to identify",
          "Do not wish to self-identify",
          "Decline to answer",
          "Decline to identify",
          "Decline to self-identify",
          "Not disclosed",
          "Not di clo ed",
        ],
      };
    };

    if (lowered.includes("salary")) {
      var salaryExpectation = u.normalizeText(
        profile.salaryExpectationRange || profile.salaryExpectation,
      );
      var salaryPoint = u.normalizeText(profile.salaryExpectation);
      var salaryAliases = [
        salaryExpectation,
        salaryPoint,
        salaryPoint ? "$" + salaryPoint : "",
        salaryPoint
          ? "$" + salaryPoint.replace(/(\d)(?=(\d{3})+$)/g, "$1,")
          : "",
        "90,000 - 105,000",
        "90000 - 105000",
        "90k - 105k",
        "$95000 - $105000",
        "$95,000 - $105,000",
        "95000 - 105000",
        "95,000 - 105,000",
      ].filter(Boolean);
      if (salaryExpectation) {
        return {
          text: salaryExpectation,
          source: profile.salaryExpectationRange
            ? "profile:salaryExpectationRange"
            : "profile:salaryExpectation",
          aliases: salaryAliases,
        };
      }
      return {
        text: "90,000 - 105,000",
        source: "default:salaryExpectationRange",
        aliases: salaryAliases,
      };
    }

    if (
      lowered.includes("background security check") ||
      lowered.includes("criminal record and references") ||
      lowered.includes("reference check")
    ) {
      return {
        text: "Yes",
        source: "default:backgroundSecurityCheckConsent",
      };
    }

    if (
      lowered.includes("artificial intelligence enabled tools") ||
      lowered.includes("ai-enabled tools") ||
      lowered.includes("use of ai")
    ) {
      return {
        text: "Yes",
        source: "default:aiRecruitingToolsConsent",
      };
    }

    if (!isLegalWorkQuestion && lowered.includes("sponsor")) {
      return {
        text: profile.sponsorshipRequired ? "Yes" : "No",
        source: "profile:sponsorshipRequired",
      };
    }
    if (
      lowered.includes("criminal offence") ||
      lowered.includes("criminal offense") ||
      lowered.includes("convicted")
    ) {
      return yesNoChoice(
        profile.criminalConvictionUnpardoned || "no",
        profile.criminalConvictionUnpardoned
          ? "profile:criminalConvictionUnpardoned"
          : "default:noUnpardonedCriminalConviction",
      );
    }
    if (lowered.includes("open work permit")) {
      return yesNoChoice(
        profile.openWorkPermit || "no",
        profile.openWorkPermit
          ? "profile:openWorkPermit"
          : "default:noOpenWorkPermit",
      );
    }
    if (
      lowered.includes("previously been employed") ||
      lowered.includes("previously worked") ||
      (lowered.includes("student at") && lowered.includes("previous"))
    ) {
      return {
        text: "No",
        source: "default:noPreviousInstitution",
      };
    }
    if (
      lowered.includes("relatives currently employed") ||
      lowered.includes("relative currently employed") ||
      lowered.includes("domestic partner") ||
      lowered.includes("family member employed") ||
      lowered.includes("relative of") ||
      lowered.includes("are you a relative") ||
      lowered.includes("family member")
    ) {
      var familyMemberAtCompany =
        u.normalizeText(profile.familyMemberAtCompany) || "No";
      return {
        text: familyMemberAtCompany,
        source: profile.familyMemberAtCompany
          ? "profile:familyMemberAtCompany"
          : "default:noRelativesAtCompany",
        aliases: [familyMemberAtCompany, "No"],
      };
    }
    if (
      lowered.includes("citizenship status") ||
      lowered.includes("citizenshipstatus")
    ) {
      return {
        text: "Canada",
        source: "profile:canadianCitizenOrPermanentResident",
        aliases: ["Canada", "Canadian"],
      };
    }
    if (
      lowered.includes("canadian citizen") ||
      lowered.includes("permanent resident")
    ) {
      return yesNoChoice(
        profile.canadianCitizenOrPermanentResident,
        "profile:canadianCitizenOrPermanentResident",
      );
    }
    if (isLegalWorkQuestion) {
      if (
        lowered.includes("all employers") ||
        lowered.includes("current employer")
      ) {
        return {
          text: profile.workAuthorized
            ? "All Canada Employers"
            : "Current Employer Only",
          source: "profile:workAuthorized",
          aliases: profile.workAuthorized
            ? [
                "All Canada Employers",
                "All Employers",
                "All Canadian Employers",
              ]
            : ["Current Employer Only"],
        };
      }
      if (lowered.includes("canada")) {
        var canadaStatus = u
          .normalizeText(profile.canadianCitizenOrPermanentResident)
          .toLowerCase();
        if (["yes", "true", "1"].includes(canadaStatus)) {
          return {
            text: "Yes, I am a citizen or permanent resident of Canada",
            source: "profile:canadianCitizenOrPermanentResident",
            aliases: [
              "Yes, I am a citizen or permanent resident of Canada",
              "citizen or permanent resident of Canada",
              "permanent resident of Canada",
            ],
          };
        }
        if (profile.workAuthorized) {
          return {
            text: "Yes, I possess a temporary work permit",
            source: "profile:workAuthorized",
            aliases: [
              "Yes, I possess a temporary work permit",
              "temporary work permit",
            ],
          };
        }
      }
      return {
        text: profile.workAuthorized ? "Yes" : "No",
        source: "profile:workAuthorized",
      };
    }
    if (
      lowered.includes("reliability status clearance") ||
      lowered.includes("lived or traveled outside") ||
      lowered.includes("lived or travelled outside") ||
      lowered.includes("6-consecutive months") ||
      lowered.includes("6 consecutive months")
    ) {
      var reliabilityStatusClearance =
        u.normalizeText(profile.reliabilityStatusClearance) ||
        "Yes, I meet the requirements to obtain Reliability Status Clearance.";
      return {
        text: reliabilityStatusClearance,
        source: profile.reliabilityStatusClearance
          ? "profile:reliabilityStatusClearance"
          : "default:reliabilityStatusClearance",
        aliases: [
          reliabilityStatusClearance,
          "Yes, I meet the requirements",
          "Yes",
        ],
      };
    }
    if (
      lowered.includes("ernst & young") ||
      lowered.includes("ernst and young") ||
      lowered.includes("deloitte")
    ) {
      var previousDeloitteErnstYoung =
        u.normalizeText(profile.previousDeloitteErnstYoung) ||
        u.normalizeText(profile.previousEyDeloitteEmployment);
      if (
        ["", "no", "false", "0"].includes(
          previousDeloitteErnstYoung.toLowerCase(),
        )
      ) {
        previousDeloitteErnstYoung =
          "No, I have not worked at either Deloitte LLP or Ernst & Young.";
      }
      return {
        text: previousDeloitteErnstYoung,
        source: profile.previousDeloitteErnstYoung
          ? "profile:previousDeloitteErnstYoung"
          : "default:noDeloitteErnstYoung",
        aliases: [
          previousDeloitteErnstYoung,
          "No, I have not worked at either Deloitte LLP or Ernst & Young.",
          "No",
        ],
      };
    }
    if (
      lowered.includes("social insurance number") ||
      lowered.includes(" sin ") ||
      lowered.includes("(sin)")
    ) {
      if (lowered.includes("begins with") || lowered.includes("starts with")) {
        return yesNoChoice(
          profile.sinStartsWithNine,
          "profile:sinStartsWithNine",
        );
      }
      var sinExpiry = u.normalizeText(profile.sinExpiryDate);
      if (
        sinExpiry &&
        (lowered.includes("expiry") || lowered.includes("expiration"))
      ) {
        return {
          text: sinExpiry,
          source: "profile:sinExpiryDate",
        };
      }
    }
    if (
      lowered.includes("expiry date") ||
      lowered.includes("expiration date")
    ) {
      var expiryDate = u.normalizeText(profile.sinExpiryDate);
      if (expiryDate) {
        return {
          text: expiryDate,
          source: "profile:sinExpiryDate",
        };
      }
    }
    if (
      lowered.includes("temporary") ||
      lowered.includes("short-contract") ||
      lowered.includes("short contract")
    ) {
      return yesNoChoice(
        profile.interestedTemporaryShortContract || "yes",
        "profile:interestedTemporaryShortContract",
      );
    }
    if (
      lowered.includes("employment status desired") ||
      lowered.includes("desired employment status")
    ) {
      return {
        text: "Temporary",
        source: "default:employmentStatusDesired",
        aliases: ["Temporary", "Intern", "Internship", "Student"],
      };
    }
    if (lowered.includes("relocat")) {
      return {
        text: profile.willingToRelocate ? "Yes" : "No",
        source: "profile:willingToRelocate",
      };
    }
    if (
      lowered.includes("language skills") ||
      lowered.includes("describes your language") ||
      lowered.includes("describe your language") ||
      lowered.includes("professional proficiency") ||
      (lowered.includes("fluent") && lowered.includes("both languages"))
    ) {
      var languageSkill = u.normalizeText(
        profile.languageSkillsStatement || profile.languageSkillStatement,
      );
      return {
        text: languageSkill || "English only",
        source: languageSkill
          ? "profile:languageSkillsStatement"
          : "default:languageSkillsStatement",
        aliases: [
          languageSkill,
          "English only",
          "Fluent in English only",
          "English",
          "I am fluent in English",
          "I am fluent in English only",
        ],
      };
    }
    if (lowered.includes("preferred language")) {
      var preferredLanguage = u.normalizeText(
        profile.preferredLanguage || profile.languagePreference,
      );
      return {
        text: preferredLanguage || "English",
        source: preferredLanguage
          ? "profile:preferredLanguage"
          : "default:preferredLanguage",
        aliases: [preferredLanguage, "English", "Engli h"].filter(Boolean),
      };
    }
    if (
      lowered.includes("how did you hear") ||
      lowered.includes("where did you hear") ||
      lowered.includes("source")
    ) {
      var applicationSource = u.normalizeText(profile.applicationSource);
      var normalizedApplicationSource = applicationSource
        .toLowerCase()
        .replace(/[_-]+/g, " ");
      var isLinkedInSource =
        /\blinked\s*in\b/.test(normalizedApplicationSource) ||
        /\blinkedin\b/.test(normalizedApplicationSource);
      var applicationSourceCategory = u.normalizeText(
        profile.applicationSourceCategory,
      );
      var applicationSourceDetail = u.normalizeText(
        profile.applicationSourceDetail,
      );
      if (applicationSource) {
        var sourceText =
          applicationSourceCategory ||
          (isLinkedInSource ? "Job Board" : applicationSource);
        return {
          text: sourceText,
          source: "profile:applicationSource",
          aliases: [
            sourceText,
            applicationSource,
            applicationSourceCategory,
            applicationSourceDetail,
            isLinkedInSource ? "LinkedIn" : applicationSource,
            isLinkedInSource ? "Job Board" : "",
            isLinkedInSource ? "Social Media" : "",
          ],
        };
      }
    }
    if (lowered.includes("phone device type")) {
      return {
        text: profile.phoneDeviceType || "Mobile",
        source: profile.phoneDeviceType
          ? "profile:phoneDeviceType"
          : "default:phoneDeviceType",
      };
    }
    if (
      lowered.includes("gender") ||
      lowered.includes("trans experience") ||
      lowered.includes("sexual orientation") ||
      lowered.includes("lesbian") ||
      lowered.includes("gay") ||
      lowered.includes("bisexual") ||
      lowered.includes("queer") ||
      lowered.includes("disabil") ||
      lowered.includes("di abil") ||
      lowered.includes("di abl") ||
      loweredCompacted.includes("disabledperson") ||
      loweredCompacted.includes("diabledperon") ||
      lowered.includes("visible minorit") ||
      lowered.includes("vi ible minorit") ||
      lowered.includes("racial") ||
      lowered.includes("ethnic") ||
      lowered.includes("indigenous") ||
      lowered.includes("indigenou") ||
      lowered.includes("aboriginal") ||
      lowered.includes("veteran") ||
      lowered.includes("diversity") ||
      lowered.includes("self-identif") ||
      lowered.includes("designated group") ||
      lowered.includes("not to disclose") ||
      lowered.includes("prefer not")
    ) {
      return nonDisclosureChoice("default:notDisclosed");
    }
    if (
      !isLegalWorkQuestion &&
      lowered.includes("country") &&
      !lowered.includes("province") &&
      !lowered.includes("territory") &&
      !lowered.includes("countryregion") &&
      !lowered.includes("phone")
    ) {
      var countryParts = locationParts(profile.location);
      if (countryParts.country) {
        return {
          text: countryParts.country,
          source: "profile:location",
          aliases: [countryParts.country],
          requireOptionMatch: true,
        };
      }
    }
    if (
      !isLegalWorkQuestion &&
      lowered.includes("city") &&
      !lowered.includes("countryregion") &&
      (lowered.includes("province") || lowered.includes("territory"))
    ) {
      var combinedLocation = u.normalizeText(profile.location, stripLongDash);
      if (combinedLocation) {
        return {
          text: combinedLocation,
          source: "profile:location",
          aliases: Array.from(locationAliases(combinedLocation)),
          locationLayers: locationOptionLayers(combinedLocation),
          requireOptionMatch: true,
        };
      }
    }
    if (lowered.includes("province") || lowered.includes("territory")) {
      var provinceAliases = locationAliases(profile.location);
      var knownProvinces = [
        "alberta",
        "british columbia",
        "manitoba",
        "new brunswick",
        "newfoundland and labrador",
        "nova scotia",
        "northwest territories",
        "nunavut",
        "ontario",
        "prince edward island",
        "quebec",
        "saskatchewan",
        "yukon",
      ];
      var provinceText = knownProvinces.find(function (province) {
        return provinceAliases.has(province);
      });
      if (provinceText) {
        return {
          text: provinceText,
          source: "profile:location",
          aliases: Array.from(provinceAliases),
          locationLayers: locationOptionLayers(profile.location),
          requireOptionMatch: true,
        };
      }
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
          locationLayers: locationOptionLayers(location),
          requireOptionMatch: true,
        };
      }
    }
    if (lowered.includes("co-op") || lowered.includes("coop")) {
      var terms = u.normalizeText(profile.coOpTermsCompleted);
      if (terms) {
        var numericTerms = terms.match(/^\d+$/) ? terms : "";
        var completedTermsText = numericTerms
          ? numericTerms +
            (numericTerms === "1" ? " term completed" : " terms completed")
          : terms;
        return {
          text: completedTermsText,
          source: "profile:coOpTermsCompleted",
          aliases: numericTerms
            ? [
                numericTerms + " terms",
                numericTerms + " term",
                completedTermsText,
              ]
            : [terms + " terms", terms + " term"],
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
    if (lowered.includes("gender")) {
      var disclosureGender = u.normalizeText(profile.disclosureGender);
      if (disclosureGender) {
        return {
          text: disclosureGender,
          source: "profile:disclosureGender",
        };
      }
    }
    if (lowered.includes("trans experience")) {
      var disclosureTransExperience = u.normalizeText(
        profile.disclosureTransExperience,
      );
      if (disclosureTransExperience) {
        return {
          text: disclosureTransExperience,
          source: "profile:disclosureTransExperience",
        };
      }
    }
    if (
      lowered.includes("lesbian") ||
      lowered.includes("gay") ||
      lowered.includes("bisexual") ||
      lowered.includes("queer") ||
      lowered.includes("sexual orientation")
    ) {
      var disclosureLgbq = u.normalizeText(profile.disclosureLgbqIdentity);
      if (disclosureLgbq) {
        return {
          text: disclosureLgbq,
          source: "profile:disclosureLgbqIdentity",
        };
      }
    }
    if (lowered.includes("disabil")) {
      var disclosureDisability = u.normalizeText(profile.disclosureDisability);
      if (disclosureDisability) {
        return {
          text: disclosureDisability,
          source: "profile:disclosureDisability",
        };
      }
    }
    if (lowered.includes("indigenous") || lowered.includes("aboriginal")) {
      var disclosureIndigenous = u.normalizeText(
        profile.disclosureIndigenousIdentity,
      );
      if (disclosureIndigenous) {
        return {
          text: disclosureIndigenous,
          source: "profile:disclosureIndigenousIdentity",
        };
      }
    }
    if (lowered.includes("visible minorit")) {
      var disclosureVisibleMinority = u.normalizeText(
        profile.disclosureVisibleMinority,
      );
      if (disclosureVisibleMinority) {
        return {
          text: disclosureVisibleMinority,
          source: "profile:disclosureVisibleMinority",
        };
      }
    }
    if (lowered.includes("veteran")) {
      var disclosureVeteran = u.normalizeText(profile.disclosureVeteranStatus);
      if (disclosureVeteran) {
        return {
          text: disclosureVeteran,
          source: "profile:disclosureVeteranStatus",
        };
      }
    }
    if (
      lowered.includes("gender") ||
      lowered.includes("trans experience") ||
      lowered.includes("sexual orientation") ||
      lowered.includes("lesbian") ||
      lowered.includes("gay") ||
      lowered.includes("bisexual") ||
      lowered.includes("queer") ||
      lowered.includes("disabil") ||
      lowered.includes("di abil") ||
      lowered.includes("di abl") ||
      loweredCompacted.includes("disabledperson") ||
      loweredCompacted.includes("diabledperon") ||
      lowered.includes("visible minorit") ||
      lowered.includes("vi ible minorit") ||
      lowered.includes("racial") ||
      lowered.includes("ethnic") ||
      lowered.includes("indigenous") ||
      lowered.includes("indigenou") ||
      lowered.includes("aboriginal") ||
      lowered.includes("veteran") ||
      lowered.includes("diversity") ||
      lowered.includes("self-identif") ||
      lowered.includes("designated group") ||
      lowered.includes("not to disclose") ||
      lowered.includes("prefer not")
    ) {
      return nonDisclosureChoice("default:notDisclosed");
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
      if (employer || previous) {
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
      return option === target ||
        option.startsWith(target + " ") ||
        option.startsWith(target + ",")
        ? 100
        : 0;
    }
    if (choice.locationLayers) {
      if (/(^|[^a-z0-9])not([^a-z0-9]|$)/.test(option)) {
        return 0;
      }
      for (
        var layerIndex = 0;
        layerIndex < choice.locationLayers.length;
        layerIndex++
      ) {
        var layer = choice.locationLayers[layerIndex];
        var terms = layer.terms || (layer.text ? [layer.text] : []);
        for (var termIndex = 0; termIndex < terms.length; termIndex++) {
          var layerText = u
            .normalizeText(terms[termIndex], stripLongDash)
            .toLowerCase();
          if (!layerText) {
            continue;
          }
          if (layer.kind === "other") {
            if (option === layerText) {
              return layer.score;
            }
            continue;
          }
          if (option.includes(layerText)) {
            return layer.score;
          }
        }
      }
      return 0;
    }
    if (option === target) {
      return 100;
    }
    var targetNumber =
      /^\d[\d,]*$/.test(target) && Number(target.replace(/,/g, ""));
    if (targetNumber) {
      var optionNumbers = (option.match(/\d[\d,]*/g) || [])
        .map(function (match) {
          return Number(match.replace(/,/g, ""));
        })
        .filter(function (number) {
          return Number.isFinite(number);
        });
      if (optionNumbers.length >= 2) {
        var low = Math.min(optionNumbers[0], optionNumbers[1]);
        var high = Math.max(optionNumbers[0], optionNumbers[1]);
        if (targetNumber >= low && targetNumber <= high) {
          if (targetNumber === low) {
            return 95;
          }
          if (targetNumber === high) {
            return 86;
          }
          return 90;
        }
      }
    }
    if (option.includes(target) || target.includes(option)) {
      return 80;
    }
    var aliases = choice.aliases || [];
    for (var i = 0; i < aliases.length; i++) {
      var alias = u.normalizeText(aliases[i], stripLongDash).toLowerCase();
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

  u.chooseStructuredChoice = chooseStructuredChoice;
  u.optionScoreForChoice = optionScoreForChoice;

  u.fillSelectElement = function (el, descriptor, profile, stripLongDash) {
    var options = Array.from(el.options || []);
    var choice = chooseStructuredChoice(descriptor, profile, stripLongDash);
    if (!choice) {
      var fallbackOption = options.find(function (option) {
        var text = u.normalizeText(option.text || option.value, stripLongDash);
        return (
          text &&
          !["select one", "select", "choose", "choose one"].includes(
            text.toLowerCase(),
          ) &&
          !/^[-*]+$/.test(text)
        );
      });
      if (!fallbackOption) {
        return { filled: false, reason: "no_known_choice" };
      }
      traceInteraction("set_value", el, {
        reason: "select_native_best_effort_no_choice",
        currentValue: fallbackOption.text || fallbackOption.value || "",
      });
      el.value = fallbackOption.value;
      u.dispatchInputEvents(el);
      return {
        filled: true,
        valueSource: "best_effort:default_option",
        bestEffortWarning:
          "best_effort_default:no_known_choice:" +
          u.normalizeText(descriptor || "").slice(0, 160) +
          " -> " +
          u
            .normalizeText(fallbackOption.text || fallbackOption.value)
            .slice(0, 120),
      };
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
      var defaultOption = options.find(function (option) {
        var text = u.normalizeText(option.text || option.value, stripLongDash);
        return (
          text &&
          !["select one", "select", "choose", "choose one"].includes(
            text.toLowerCase(),
          ) &&
          !/^[-*]+$/.test(text)
        );
      });
      if (!defaultOption) {
        return { filled: false, reason: "no_matching_option" };
      }
      traceInteraction("set_value", el, {
        reason: "select_native_best_effort_no_match",
        intendedValue: choice.text || "",
        currentValue: defaultOption.text || defaultOption.value || "",
      });
      el.value = defaultOption.value;
      u.dispatchInputEvents(el);
      return {
        filled: true,
        valueSource: "best_effort:default_option",
        bestEffortWarning:
          "best_effort_default:no_matching_option:" +
          u.normalizeText(descriptor || "").slice(0, 160) +
          " intended " +
          u.normalizeText(choice.text || "").slice(0, 80) +
          " -> " +
          u
            .normalizeText(defaultOption.text || defaultOption.value)
            .slice(0, 120),
      };
    }
    traceInteraction("set_value", el, {
      reason: "select_native_option",
      intendedValue: choice.text || "",
      currentValue: selectedOption.text || selectedOption.value || "",
    });
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
    var requireOptionMatch =
      choice.requireOptionMatch ||
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-autocomplete") === "list" ||
      Boolean(el.closest(".select__container"));

    var sleep = function (ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    };
    var optionScore = function (option) {
      var text = u.normalizeText(
        option.innerText || option.textContent,
        stripLongDash,
      );
      if (["no options", "no results"].includes(text.toLowerCase())) {
        return 0;
      }
      return optionScoreForChoice(text, "", choice, stripLongDash);
    };
    var keyDetails = function (keyName) {
      var map = {
        Enter: { code: "Enter", keyCode: 13 },
        Escape: { code: "Escape", keyCode: 27 },
        Tab: { code: "Tab", keyCode: 9 },
        ArrowDown: { code: "ArrowDown", keyCode: 40 },
        ArrowUp: { code: "ArrowUp", keyCode: 38 },
      };
      return map[keyName] || { code: keyName, keyCode: 0 };
    };
    var keyOn = function (target, keyName) {
      var details = keyDetails(keyName);
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: keyName,
          code: details.code,
          keyCode: details.keyCode,
          which: details.keyCode,
          bubbles: true,
          cancelable: true,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: keyName,
          code: details.code,
          keyCode: details.keyCode,
          which: details.keyCode,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    var key = function (keyName) {
      keyOn(el, keyName);
    };
    var optionTextFor = function (option) {
      return u.normalizeText(
        option ? option.innerText || option.textContent : "",
        stripLongDash,
      );
    };
    var committedState = function () {
      var container = el.closest(".select__container") || el.parentElement;
      var field = el.closest(".custom-select, .application-field");
      var datasetSelected = u.normalizeText(
        field?.dataset?.selected || el.dataset?.selected || "",
        stripLongDash,
      );
      if (datasetSelected) {
        return { text: datasetSelected, source: "dataset" };
      }
      var selected = container?.querySelector(
        '.select__single-value, [class*="single-value"]',
      );
      var selectedText = u.normalizeText(
        selected ? selected.innerText || selected.textContent : "",
        stripLongDash,
      );
      if (selectedText) {
        return { text: selectedText, source: "single_value" };
      }
      var inputText = u.normalizeText(el.value, stripLongDash);
      return { text: inputText, source: inputText ? "input" : "" };
    };
    var committedText = function () {
      return committedState().text;
    };
    var optionLooksSelected = function (option) {
      if (!option) {
        return false;
      }
      var selectedAttr = u
        .normalizeText(
          [
            option.getAttribute("aria-selected"),
            option.getAttribute("data-selected"),
            option.getAttribute("data-state"),
          ]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      var className = u.normalizeText(option.className || "").toLowerCase();
      return (
        selectedAttr.includes("true") ||
        selectedAttr.includes("selected") ||
        className.includes("selected") ||
        className.includes("is-focused")
      );
    };
    var trackNativeCommitEvents = function () {
      var changed = false;
      var mark = function () {
        changed = true;
      };
      el.addEventListener("change", mark, true);
      el.addEventListener("input", mark, true);
      return {
        changed: function () {
          return changed;
        },
        stop: function () {
          el.removeEventListener("change", mark, true);
          el.removeEventListener("input", mark, true);
        },
      };
    };
    var looksCommitted = function (
      clickedOption,
      beforeCommit,
      changedByClick,
    ) {
      var clickedText = optionTextFor(clickedOption);
      var state = committedState();
      var committed = state.text;
      var beforeState =
        typeof beforeCommit === "string"
          ? { text: beforeCommit, source: "" }
          : beforeCommit || { text: "", source: "" };
      if (clickedText && committed === clickedText) {
        if (!beforeState.text || committed !== beforeState.text) {
          return true;
        }
        if (
          state.source &&
          state.source !== beforeState.source &&
          state.source !== "input"
        ) {
          return true;
        }
        if (changedByClick || optionLooksSelected(clickedOption)) {
          return true;
        }
        return false;
      }
      if (
        beforeState.text &&
        committed === beforeState.text &&
        state.source === beforeState.source
      ) {
        return false;
      }
      if (
        committed &&
        optionScoreForChoice(committed, "", choice, stripLongDash) > 0
      ) {
        return true;
      }
      var container = el.closest(".select__container") || el.parentElement;
      var text = u
        .normalizeText(container ? container.innerText : "", stripLongDash)
        .toLowerCase();
      var target = targetText.toLowerCase();
      var inputValue = u.normalizeText(el.value, stripLongDash).toLowerCase();
      return inputValue === target && text.includes(target);
    };
    var currentCommitMatchesChoice = function () {
      var state = committedState();
      var committed = state.text;
      if (requireOptionMatch && state.source === "input") {
        return false;
      }
      return (
        committed &&
        optionScoreForChoice(committed, "", choice, stripLongDash) > 0
      );
    };
    var optionScope = function (option) {
      var container = el.closest(".select__container, .custom-select");
      if (container && container.contains(option)) {
        return 4;
      }
      var controls = el.getAttribute("aria-controls") || "";
      var listbox = controls
        ? option.closest("#" + CSS.escape(controls))
        : null;
      if (listbox) {
        return 5;
      }
      if (el.id && option.id && option.id.includes(el.id)) {
        return 5;
      }
      return 1;
    };
    var candidateOptionElements = function () {
      var controls = el.getAttribute("aria-controls") || "";
      var listbox = controls ? document.getElementById(controls) : null;
      if (listbox) {
        return Array.from(
          listbox.querySelectorAll(
            '[role="option"], [id*="-option-"], .select__option, [class*="__option"], [class*="-option"]',
          ),
        );
      }
      return Array.from(
        document.querySelectorAll(
          '[role="option"], [id*="-option-"], .select__option, [class*="__option"], [class*="-option"]',
        ),
      );
    };
    var findVisibleOption = function () {
      var candidates = candidateOptionElements()
        .map(function (option) {
          var style = window.getComputedStyle(option);
          var rect = option.getBoundingClientRect();
          var visible =
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0;
          return {
            option: option,
            scope: visible ? optionScope(option) : 0,
            score: visible ? optionScore(option) : 0,
          };
        })
        .filter(function (candidate) {
          return candidate.score > 0;
        });
      var bestScope = candidates.reduce(function (best, candidate) {
        return Math.max(best, candidate.scope);
      }, 0);
      return (
        candidates
          .filter(function (candidate) {
            return candidate.scope === bestScope;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          })[0]?.option || null
      );
    };
    var setSearchValue = function (value) {
      el.focus();
      var proto =
        el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
      var setter = proto
        ? Object.getOwnPropertyDescriptor(proto, "value")?.set
        : null;
      if (setter) {
        setter.call(el, u.normalizeText(value, stripLongDash));
      } else {
        el.value = u.normalizeText(value, stripLongDash);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    var clearTypedSearch = function () {
      setSearchValue("");
      key("Escape");
    };
    var pointerEvent = function (target, type, rect) {
      var init = {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: type.includes("down") ? 1 : 0,
        clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + rect.height / 2),
      };
      var EventCtor =
        window.PointerEvent && type.startsWith("pointer")
          ? window.PointerEvent
          : MouseEvent;
      target.dispatchEvent(new EventCtor(type, init));
    };
    var realisticOptionClick = function (option) {
      if (!option) {
        return;
      }
      if (typeof option.scrollIntoView === "function") {
        option.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      var rect = option.getBoundingClientRect();
      traceHoverAndClick(option, "select_combobox_option");
      [
        "mouseover",
        "mousemove",
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ].forEach(function (type) {
        pointerEvent(option, type, rect);
      });
    };
    var clickOutsideMenu = function () {
      var target = document.body || document.documentElement;
      if (!target) {
        return;
      }
      ["pointerdown", "mousedown", "mouseup", "click"].forEach(function (type) {
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
      });
    };
    var closeOpenMenus = async function () {
      var active = document.activeElement;
      if (active) {
        keyOn(active, "Escape");
      }
      if (document.body) {
        keyOn(document.body, "Escape");
      }
      keyOn(document, "Escape");
      keyOn(window, "Escape");
      clickOutsideMenu();
      await sleep(80);
    };
    var closeMenu = async function () {
      var control = el.closest(".select__control") || el;
      key("Escape");
      if (control && control !== el) {
        keyOn(control, "Escape");
      }
      if (document.body) {
        keyOn(document.body, "Escape");
      }
      keyOn(document, "Escape");
      keyOn(window, "Escape");
      el.blur();
      clickOutsideMenu();
      await sleep(80);
      keyOn(document, "Escape");
      keyOn(window, "Escape");
    };
    var openMenu = async function () {
      var control = el.closest(".select__control") || el;
      var toggle = el
        .closest(".select__container")
        ?.querySelector(
          '.select__indicators button[aria-label*="Toggle"], .select__indicators button',
        );
      el.focus();
      traceHoverAndClick(control, "open_combobox_menu");
      control.click();
      await sleep(180);
      var option = findVisibleOption();
      if (option) {
        return option;
      }
      if (toggle) {
        traceHoverAndClick(toggle, "toggle_combobox_menu");
        toggle.click();
        await sleep(180);
        option = findVisibleOption();
        if (option) {
          return option;
        }
      }
      key("ArrowDown");
      await sleep(180);
      return findVisibleOption();
    };
    var searchTerms = function () {
      if (choice.locationLayers) {
        return choice.locationLayers
          .filter(function (layer) {
            return layer.kind !== "other";
          })
          .flatMap(function (layer) {
            return (layer.terms || [])
              .map(function (term) {
                return u.normalizeText(term, stripLongDash);
              })
              .filter(Boolean);
          });
      }
      return [targetText];
    };
    var findOptionBySearching = async function () {
      var terms = searchTerms();
      for (var i = 0; i < terms.length; i++) {
        setSearchValue(terms[i]);
        await sleep(450);
        var option = findVisibleOption();
        if (option) {
          return option;
        }
      }
      clearTypedSearch();
      await sleep(120);
      return null;
    };
    var commitOption = async function (option, beforeCommit) {
      var clickTracker = trackNativeCommitEvents();
      realisticOptionClick(option);
      await sleep(180);
      var changedByClick = clickTracker.changed();
      clickTracker.stop();
      u.dispatchInputEvents(el);
      if (looksCommitted(option, beforeCommit, changedByClick)) {
        await closeMenu();
        return true;
      }

      var beforeEnterCommit = committedState();
      var enterTracker = trackNativeCommitEvents();
      key("Enter");
      await sleep(180);
      var changedByEnter = enterTracker.changed();
      enterTracker.stop();
      u.dispatchInputEvents(el);
      if (
        looksCommitted(option, beforeEnterCommit, changedByEnter) ||
        looksCommitted(option, beforeCommit, changedByEnter)
      ) {
        await closeMenu();
        return true;
      }
      return false;
    };

    await closeOpenMenus();
    if (currentCommitMatchesChoice()) {
      traceInteraction("already_filled", el, {
        reason: "combobox_matches_choice",
        currentValue: committedText(),
        intendedValue: targetText,
      });
      await closeMenu();
      return { filled: true, valueSource: choice.source };
    }
    var option = await openMenu();
    if (option) {
      var beforeCommit = committedState();
      if (await commitOption(option, beforeCommit)) {
        return { filled: true, valueSource: choice.source };
      }
    }

    if (requireOptionMatch) {
      option = await findOptionBySearching();
      if (option) {
        var beforeSearchCommit = committedState();
        if (await commitOption(option, beforeSearchCommit)) {
          return { filled: true, valueSource: choice.source };
        }
      }
      clearTypedSearch();
      return { filled: false, reason: "no_matching_option" };
    }

    u.setElementValue(el, targetText, stripLongDash);
    key(targetText.length === 1 ? targetText : targetText[0] || "");
    await sleep(450);

    option = findVisibleOption();
    if (!option) {
      key("ArrowDown");
      await sleep(120);
      option = findVisibleOption();
    }
    if (option) {
      var beforeFallbackCommit = committedState();
      if (await commitOption(option, beforeFallbackCommit)) {
        return { filled: true, valueSource: choice.source };
      }
    }

    key("Enter");
    await sleep(180);
    key("Tab");
    await sleep(120);
    u.dispatchInputEvents(el);
    if (looksCommitted(null, "")) {
      await closeMenu();
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

    var structuredChoice = chooseStructuredChoice(descriptor, profile, false);
    if (
      structuredChoice &&
      /^(yes|no)$/i.test(u.normalizeText(structuredChoice.text))
    ) {
      choice = u.normalizeText(structuredChoice.text).toLowerCase();
    } else if (
      lowered.includes("candidateispreviousworker") ||
      lowered.includes("previously been employed") ||
      (lowered.includes("student at") && lowered.includes("previous"))
    ) {
      choice = "no";
    } else if (lowered.includes("sponsor")) {
      choice = profile.sponsorshipRequired ? "yes" : "no";
    } else if (lowered.includes("authorized") || lowered.includes("legally")) {
      choice = profile.workAuthorized ? "yes" : "no";
    } else if (lowered.includes("relocat")) {
      choice = profile.willingToRelocate ? "yes" : "no";
    }

    if (!choice) {
      return false;
    }
    var radioChoiceScore = function (radio) {
      var directText = u
        .normalizeText(
          [
            radio.value,
            radio.getAttribute("aria-label"),
            radio.id
              ? document.querySelector(
                  'label[for="' + CSS.escape(radio.id) + '"]',
                )?.innerText
              : "",
            radio.closest("label")?.innerText,
          ]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      if (choice === "yes" && /\b(true|yes)\b/.test(directText)) {
        return 100;
      }
      if (choice === "no" && /\b(false|no)\b/.test(directText)) {
        return 100;
      }
      var radioDescriptor = u
        .normalizeText(u.getDescriptor(radio, containerSelectors))
        .toLowerCase();
      if (radioDescriptor === choice) {
        return 80;
      }
      if (new RegExp("\\b" + choice + "\\b").test(radioDescriptor)) {
        return 40;
      }
      return 0;
    };
    var target = radios
      .map(function (radio) {
        return { radio: radio, score: radioChoiceScore(radio) };
      })
      .filter(function (candidate) {
        return candidate.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      })[0]?.radio;
    if (!target) {
      return false;
    }
    traceHoverAndClick(target, "select_radio_option");
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
