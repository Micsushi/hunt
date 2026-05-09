// Generic form adapter for standalone manual fills.
// It fills required profile and resume fields one-by-one on pages without a
// dedicated ATS adapter. It intentionally skips optional and unknown fields.
export function createGenericFillFunction() {
  return async function genericFill({
    profile,
    settings,
    activeApplyContext,
    defaultResume,
    fieldRules,
  }) {
    var u = window.__huntApplyUtils;
    if (!u) {
      return {
        ok: false,
        reason: "missing_utils",
        message:
          "Shared fill utils (injected.js) were not injected before this adapter ran.",
      };
    }

    var rules = fieldRules || {};
    var perFieldDelayMs = 120;
    var perUploadDelayMs = 175;
    var sleep = function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    };
    var stripLongDash = settings.stripLongDash !== false;
    var containerSelectors = [
      "label",
      "fieldset",
      '[role="group"]',
      "[data-testid]",
      ".form-group",
      ".field",
      ".form-field",
      ".input-group",
    ];
    var getDescriptor = function (el) {
      return u.getDescriptor(el, containerSelectors);
    };
    var normalize = function (value) {
      return u.normalizeText(value, stripLongDash).toLowerCase();
    };
    var phraseMatches = function (descriptor, phrases) {
      var desc = normalize(descriptor);
      return (phrases || []).some(function (phrase) {
        return desc.includes(normalize(phrase));
      });
    };
    var hasExcludedPhrase = function (descriptor) {
      return phraseMatches(descriptor, rules.excludedPhrases || []);
    };
    var requiredTextFor = function (el) {
      return normalize(
        [
          el.getAttribute("aria-label"),
          el.getAttribute("placeholder"),
          el.getAttribute("data-required"),
          el.getAttribute("data-automation-id"),
          u.getContainerText(el, containerSelectors),
        ]
          .filter(Boolean)
          .join(" "),
      );
    };
    var isRequired = function (el) {
      if (el.required || el.getAttribute("aria-required") === "true") {
        return true;
      }
      var text = requiredTextFor(el);
      if (text.includes("*")) {
        return true;
      }
      return (rules.requiredIndicators || []).some(function (phrase) {
        return text.includes(normalize(phrase));
      });
    };
    var profileParts = function () {
      var fullName = u.normalizeText(profile.fullName, stripLongDash);
      var pieces = fullName.split(" ").filter(Boolean);
      return {
        fullName: fullName,
        firstName: pieces[0] || "",
        lastName: pieces.slice(1).join(" "),
      };
    };
    var profileValueForRule = function (rule) {
      var parts = profileParts();
      var valueMap = {
        firstName: parts.firstName,
        lastName: parts.lastName,
        fullName: parts.fullName,
        email: profile.email,
        phone: profile.phone,
        location: profile.location,
        linkedinUrl: profile.linkedinUrl,
        githubUrl: profile.githubUrl,
        websiteUrl: profile.websiteUrl,
      };
      return u.normalizeText(valueMap[rule.valueKey] || "", stripLongDash);
    };
    var contextValueForRule = function (rule) {
      var valueMap = {
        title: activeApplyContext.title,
        company: activeApplyContext.company,
        jobUrl: activeApplyContext.jobUrl,
        applyUrl: activeApplyContext.applyUrl,
      };
      return u.normalizeText(valueMap[rule.valueKey] || "", stripLongDash);
    };
    var chooseRequiredKnownValue = function (descriptor) {
      if (!descriptor || hasExcludedPhrase(descriptor)) {
        return null;
      }
      var profileFields = rules.profileFields || [];
      for (var i = 0; i < profileFields.length; i++) {
        var rule = profileFields[i];
        var value = profileValueForRule(rule);
        if (value && phraseMatches(descriptor, rule.phrases)) {
          return {
            value: value,
            key: "profile:" + rule.key,
          };
        }
      }
      var contextFields = rules.jobContextFields || [];
      for (var j = 0; j < contextFields.length; j++) {
        var contextRule = contextFields[j];
        var contextValue = contextValueForRule(contextRule);
        if (contextValue && phraseMatches(descriptor, contextRule.phrases)) {
          return {
            value: contextValue,
            key: "job:" + contextRule.key,
          };
        }
      }
      return null;
    };
    var isRequiredResumeInput = function (el, descriptor) {
      return (
        isRequired(el) &&
        !hasExcludedPhrase(descriptor) &&
        (phraseMatches(descriptor, rules.resumePhrases || []) ||
          el.accept.toLowerCase().includes("pdf") ||
          el.name.toLowerCase().includes("resume"))
      );
    };

    var filledFields = [];
    var manualReviewReasons = [];

    var textInputs = u.getVisibleElements(
      'input:not([type="hidden"]):not([type="file"])',
    );
    var textareas = u.getVisibleElements("textarea");
    var selects = u.getVisibleElements("select");
    var fileInputs = u.getVisibleElements('input[type="file"]');
    var radios = u.getVisibleElements('input[type="radio"]');

    var radiosByName = new Map();
    for (var i = 0; i < radios.length; i++) {
      var radio = radios[i];
      var key = radio.name || radio.id || Math.random().toString(36);
      if (!radiosByName.has(key)) {
        radiosByName.set(key, []);
      }
      radiosByName.get(key).push(radio);
    }

    var candidates = [];
    var flatEls = textInputs.concat(textareas, selects, fileInputs);
    for (var j = 0; j < flatEls.length; j++) {
      var el = flatEls[j];
      candidates.push({
        kind: "element",
        element: el,
        rect: el.getBoundingClientRect(),
      });
    }
    radiosByName.forEach(function (group) {
      var anchor = group[0];
      if (anchor) {
        candidates.push({
          kind: "radioGroup",
          radios: group,
          rect: anchor.getBoundingClientRect(),
        });
      }
    });

    var sorted = u.sortCandidatesByPosition(candidates);

    for (var k = 0; k < sorted.length; k++) {
      var candidate = sorted[k];

      if (candidate.kind === "radioGroup") {
        var radioDescriptor = candidate.radios
          .map(function (r) {
            return getDescriptor(r);
          })
          .join(" ")
          .toLowerCase();
        if (!candidate.radios.some(isRequired)) {
          continue;
        }
        if (
          !hasExcludedPhrase(radioDescriptor) &&
          u.fillRadioGroup(
            candidate.radios,
            radioDescriptor,
            profile,
            containerSelectors,
          )
        ) {
          filledFields.push({
            field: radioDescriptor,
            valueSource: "radio_rule",
          });
          await sleep(perFieldDelayMs);
        }
        continue;
      }

      var elem = candidate.element;
      var desc = getDescriptor(elem);
      if (!desc || !isRequired(elem)) {
        continue;
      }

      if (elem.tagName === "SELECT") {
        if (
          !hasExcludedPhrase(desc) &&
          u.fillSelectElement(elem, desc, profile, stripLongDash)
        ) {
          filledFields.push({ field: desc, valueSource: "select_rule" });
          await sleep(perFieldDelayMs);
        }
        continue;
      }

      if (elem.tagName === "INPUT" && elem.type === "file") {
        if (!isRequiredResumeInput(elem, desc)) {
          continue;
        }
        var attachment = await u.attachResumeToFileInput(
          elem,
          activeApplyContext,
          defaultResume,
        );
        if (attachment.attached) {
          filledFields.push({
            field: desc || "resume_upload",
            valueSource: "resume_upload",
          });
          await sleep(perUploadDelayMs);
        } else {
          manualReviewReasons.push("resume_upload:" + attachment.reason);
        }
        continue;
      }

      var match = chooseRequiredKnownValue(desc);
      if (match && u.setElementValue(elem, match.value, stripLongDash)) {
        filledFields.push({
          field: desc,
          valueSource: match.key,
        });
        await sleep(perFieldDelayMs);
      }
    }

    return {
      ok: true,
      atsType: "generic",
      authState: u.detectAuthState(),
      filledFieldCount: filledFields.length,
      generatedAnswerCount: 0,
      manualReviewRequired: manualReviewReasons.length > 0,
      manualReviewReasons: manualReviewReasons,
      filledFields: filledFields,
      generatedAnswers: [],
      htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000),
    };
  };
}
