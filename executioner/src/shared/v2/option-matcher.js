(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  var PLACEHOLDERS = new Set([
    "",
    "select",
    "select one",
    "select an option",
    "choose",
    "choose one",
    "none selected",
  ]);

  function norm(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normOptionLabel(value) {
    return norm(value)
      .replace(/\bnot checked\b/g, " ")
      .replace(/\bchecked\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPlaceholder(option) {
    return option.placeholder || PLACEHOLDERS.has(norm(option.label));
  }

  function realOptions(options) {
    return (options || []).filter(function (option) {
      return option.label && !isPlaceholder(option);
    });
  }

  function isNonAnswerOption(option) {
    var label = normOptionLabel(option?.label);
    var value = normOptionLabel(option?.value);
    return label === "not mapped" || value === "not mapped";
  }

  function optionAliases(answer) {
    var aliases = [];
    var map = answer.optionAliases || {};
    Object.keys(map).forEach(function (key) {
      if (norm(key) === norm(answer.value)) {
        aliases = aliases.concat(map[key] || []);
      }
    });
    return aliases;
  }

  function isStrictAliasMatch(option, alias) {
    var label = norm(option.label);
    var value = norm(option.value);
    if (alias.length <= 3) {
      return label === alias || value === alias;
    }
    return label === alias || value === alias || label.includes(alias);
  }

  function isProvinceField(field) {
    var el = field?.element || field?.anchor;
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
      ].join(" "),
    );
    return (
      text.includes("province") ||
      text.includes("territory") ||
      text.includes("region3")
    );
  }

  function isSalaryField(field, answer) {
    var el = field?.element || field?.anchor;
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        field?.workday?.fieldLabel,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
        answer?.source,
      ].join(" "),
    );
    if (
      text.includes("compensation history") ||
      text.includes("compensation offer") ||
      text.includes("creating a compensation offer") ||
      text.includes("factors bms should consider")
    ) {
      return false;
    }
    return (
      text.includes("salary") ||
      text.includes("compensation") ||
      text.includes("pay expectation") ||
      text.includes("salaryexpectation")
    );
  }

  function isPhoneCountryCodeField(field) {
    var el = field?.element || field?.anchor;
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        field?.workday?.fieldLabel,
        field?.workday?.kind,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
      ].join(" "),
    );
    return (
      text.includes("phone country code") ||
      text.includes("country phone code") ||
      text.includes("country territory phone code") ||
      text.includes("countryphonecode") ||
      text.includes("phone_country_code")
    );
  }

  function isPhoneDeviceTypeField(field) {
    var el = field?.element || field?.anchor;
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        field?.workday?.fieldLabel,
        field?.workday?.kind,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
      ].join(" "),
    );
    return (
      text.includes("phone device type") ||
      text.includes("phone type") ||
      text.includes("phone number phonetype") ||
      text.includes("phonenumber phonetype")
    );
  }

  function safePhoneDeviceTypeOption(options) {
    var real = realOptions(options);
    var preferred = ["mobile", "cell", "cell phone", "work", "telephone", "home"];
    for (var i = 0; i < preferred.length; i += 1) {
      var wanted = preferred[i];
      var found = real.find(function (option) {
        var label = normOptionLabel(option.label);
        return label === wanted || label.includes(wanted);
      });
      if (found) {
        return found;
      }
    }
    return null;
  }

  function phoneCountryCodeOption(options, answer) {
    var target = norm(answer?.value || "");
    if (!target) {
      return null;
    }
    return realOptions(options).find(function (option) {
      var label = normOptionLabel(option.label);
      var value = normOptionLabel(option.value);
      return (
        label === target ||
        value === target ||
        ((target === "1" || target === "01" || target.includes("1")) &&
          label.includes("canada") &&
          /\b1\b/.test(label)) ||
        (target.includes("canada") && label.includes("canada")) ||
        (target.includes("ca") && label.includes("canada"))
      );
    });
  }

  function isDeferredHierarchicalWorkdayField(field, answer) {
    var el = field?.element || field?.anchor;
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        field?.workday?.fieldLabel,
        field?.workday?.contextText,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
        answer?.source,
        answer?.value,
        answer?.questionType,
      ].join(" "),
    );
    return (
      text.includes("canadian citizenship status") ||
      text.includes("provide your canadian citizenship status") ||
      text.includes("citizenship status to assist")
    );
  }

  function isApplicationSourceField(field, answer) {
    var el = field?.element || field?.anchor;
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        field?.workday?.fieldLabel,
        field?.workday?.contextText,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
        answer?.source,
        answer?.questionType,
      ].join(" "),
    );
    return (
      text.includes("application source") ||
      text.includes("how did you hear") ||
      text.includes("source") ||
      text.includes("applicationsource")
    );
  }

  function shouldLeaveOptionalProfileFieldBlank(field, answer) {
    return (
      !field?.required &&
      answer?.source === "missing_profile_value" &&
      (answer?.answerType === "option" || answer?.answerType === "text")
    );
  }

  function safeApplicationSourceOption(options) {
    var blocked = [
      "select",
      "referral",
      "referred",
      "refer",
      "employee",
      "employ",
      "recruiter",
      "agency",
    ];
    var preferred = [
      "linkedin",
      "indeed",
      "naukri",
      "internet",
      "job board",
      "job site",
      "job sites",
      "career site",
      "career website",
      "careers website",
      "careers",
      "company website",
      "google",
      "glassdoor",
      "zip recruiter",
      "other job site",
      "other",
    ];
    var candidates = (options || []).filter(function (option) {
      var label = norm(option.label);
      return !blocked.some(function (word) {
        return label.includes(word);
      });
    });
    for (var i = 0; i < preferred.length; i += 1) {
      var needle = preferred[i];
      var match = candidates.find(function (option) {
        return norm(option.label).includes(needle);
      });
      if (match) {
        return match;
      }
    }
    return null;
  }

  function salaryNumbers(value) {
    var matches = String(value || "").match(/\d[\d,]*/g) || [];
    var numbers = matches
      .map(function (match) {
        return match.replace(/,/g, "");
      })
      .filter(function (match) {
        return match.length >= 4;
      });
    if (
      numbers.length % 2 === 0 &&
      numbers.slice(0, numbers.length / 2).every(function (value, idx) {
        return value === numbers[idx + numbers.length / 2];
      })
    ) {
      return numbers.slice(0, numbers.length / 2);
    }
    return numbers;
  }

  function salaryNumericMatch(option, answer) {
    var targetNumbers = salaryNumbers(answer.value);
    if (!targetNumbers.length) {
      return false;
    }
    var optionNumbers = salaryNumbers(
      [option.label, option.value].filter(Boolean).join(" "),
    );
    if (!optionNumbers.length) {
      return false;
    }
    if (
      targetNumbers.length === optionNumbers.length &&
      targetNumbers.every(function (value, idx) {
        return value === optionNumbers[idx];
      })
    ) {
      return true;
    }
    return (
      targetNumbers.length === 1 &&
      optionNumbers.length >= 2 &&
      Number(optionNumbers[0]) <= Number(targetNumbers[0]) &&
      Number(targetNumbers[0]) <= Number(optionNumbers[1])
    );
  }

  function salaryOptionDistance(option, answer) {
    var targetNumbers = salaryNumbers(answer.value);
    if (!targetNumbers.length) {
      return null;
    }
    var target = Number(targetNumbers[0]);
    if (!Number.isFinite(target)) {
      return null;
    }
    var optionNumbers = salaryNumbers(
      [option.label, option.value].filter(Boolean).join(" "),
    ).map(Number);
    if (!optionNumbers.length) {
      return null;
    }
    if (
      optionNumbers.length >= 2 &&
      Number.isFinite(optionNumbers[0]) &&
      Number.isFinite(optionNumbers[1])
    ) {
      var lower = Math.min(optionNumbers[0], optionNumbers[1]);
      var upper = Math.max(optionNumbers[0], optionNumbers[1]);
      if (lower <= target && target <= upper) {
        return 0;
      }
      return Math.min(Math.abs(target - lower), Math.abs(target - upper));
    }
    var numeric = optionNumbers.find(Number.isFinite);
    return Number.isFinite(numeric) ? Math.abs(target - numeric) : null;
  }

  function closestSalaryOption(options, answer) {
    return (options || [])
      .map(function (option, index) {
        return {
          option: option,
          index: index,
          distance: salaryOptionDistance(option, answer),
        };
      })
      .filter(function (candidate) {
        return candidate.distance !== null;
      })
      .sort(function (a, b) {
        return a.distance - b.distance || a.index - b.index;
      })[0]?.option;
  }

  function travelOptionScore(option, index) {
    var label = [option?.label, option?.value].filter(Boolean).join(" ");
    var numbers = (String(label).match(/\d+(?:\.\d+)?/g) || [])
      .map(Number)
      .filter(Number.isFinite);
    if (!numbers.length) {
      return null;
    }
    var max = Math.max.apply(null, numbers);
    var min = Math.min.apply(null, numbers);
    var normalized = norm(label);
    var openEnded =
      numbers.length === 1 ||
      normalized.includes("plus") ||
      normalized.includes("or more") ||
      normalized.includes("or greater") ||
      normalized.includes("and above") ||
      normalized.includes("above");
    return {
      option: option,
      index: index,
      max: max,
      min: min,
      openEnded: openEnded ? 1 : 0,
    };
  }

  function highestTravelOption(options) {
    return (options || [])
      .map(travelOptionScore)
      .filter(Boolean)
      .sort(function (a, b) {
        return (
          b.max - a.max ||
          b.openEnded - a.openEnded ||
          b.min - a.min ||
          a.index - b.index
        );
      })[0]?.option;
  }

  function yearRangeOption(options, answer) {
    var target = Number(String(answer?.value || "").match(/\d+/)?.[0] || "");
    if (!Number.isFinite(target) || target <= 0) {
      return null;
    }
    return options.find(function (option) {
      var label = normOptionLabel(option.label);
      var numbers = (label.match(/\d+/g) || [])
        .map(Number)
        .filter(function (number) {
          return Number.isFinite(number);
        });
      if (!numbers.length) {
        return false;
      }
      if (label.includes("more than") || label.includes("+")) {
        return target > numbers[0];
      }
      if (numbers.length >= 2) {
        return target >= numbers[0] && target <= numbers[1];
      }
      return target === numbers[0];
    });
  }

  function neutralOption(options) {
    var aliases = root.fieldCatalog?.nonDisclosureAliases || [];
    var neutralSubstrings = [
      "not to respond",
      "prefer not",
      "do not wish",
      "do not want",
      "don't wish",
      "don't want",
      "decline",
      "not disclosed",
      "not declared",
      "not specified",
      "not applicable",
      "n/a",
      "none of the above",
      "undisclosed",
      "undeclared",
      "choose not",
    ];
    var real = realOptions(options);
    var substringMatch = real.find(function (option) {
      var label = norm(option.label);
      return neutralSubstrings.some(function (needle) {
        return label.includes(needle);
      });
    });
    if (substringMatch) {
      return substringMatch;
    }
    for (var i = 0; i < aliases.length; i++) {
      var alias = norm(aliases[i]);
      var found = real.find(function (option) {
        var label = norm(option.label);
        if (label.length <= 3 || alias.length <= 3) {
          return label === alias;
        }
        return (
          label === alias || label.includes(alias) || alias.includes(label)
        );
      });
      if (found) {
        return found;
      }
    }
    return null;
  }

  function isVeteranDisclosureField(field, answer) {
    var el = field?.element || field?.anchor;
    var text = norm(
      [
        field?.fieldId,
        field?.descriptor,
        field?.workday?.fieldLabel,
        field?.workday?.contextText,
        el?.id,
        el?.name,
        el?.getAttribute?.("aria-label"),
        answer?.source,
      ].join(" "),
    );
    return (
      text.includes("veteran") &&
      (text.includes("disclosure") ||
        text.includes("protected") ||
        text.includes("classifications") ||
        text.includes("status"))
    );
  }

  function safeNotVeteranOption(options) {
    return realOptions(options).find(function (option) {
      var label = normOptionLabel(option.label);
      return (
        label.includes("not a veteran") ||
        label.includes("not protected veteran") ||
        (label.includes("i am not") && label.includes("veteran")) ||
        (label.includes("not one") && label.includes("veteran"))
      );
    });
  }

  function exactNoOption(options) {
    return realOptions(options).find(function (option) {
      var label = normOptionLabel(option.label);
      var value = normOptionLabel(option.value);
      return label === "no" || value === "no";
    });
  }

  function progressFallbackOption({
    real,
    audit,
    fieldAudit,
    field,
    kind,
    reason,
    neutralSource,
    noSource,
    firstSource,
  }) {
    var options = real.map(function (option) {
      return option.label;
    });
    var neutral = neutralOption(real);
    if (neutral) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: kind || "unknown_question_defaulted",
        severity: field?.required ? "warn" : "info",
        failedStep: "option.match",
        reason:
          (reason ? reason + " " : "") +
          "Selected neutral or non-disclosure fallback.",
        selectedOption: neutral.label,
        options,
      });
      return {
        option: neutral,
        source: neutralSource || "unknown_neutral_fallback",
        fallback: true,
      };
    }
    var no = exactNoOption(real);
    if (no) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: kind || "unknown_question_defaulted",
        severity: field?.required ? "warn" : "info",
        failedStep: "option.match",
        reason:
          (reason ? reason + " " : "") +
          "No neutral option was visible, so C3 selected No.",
        selectedOption: no.label,
        options,
      });
      return {
        option: no,
        source: noSource || "unknown_no_fallback",
        fallback: true,
      };
    }
    root.audit?.pushIssue(audit, fieldAudit, {
      kind: kind || "unknown_question_defaulted",
      severity: field?.required ? "warn" : "info",
      failedStep: "option.match",
      reason:
        (reason ? reason + " " : "") +
        "No neutral or No option was visible, so C3 selected the first real option.",
      selectedOption: real[0]?.label || "",
      options,
    });
    return {
      option: real[0],
      source: firstSource || "unknown_first_real_fallback",
      fallback: true,
    };
  }

  function matchOption({ options, answer, audit, fieldAudit, field }) {
    var real = realOptions(options);
    var target = norm(answer.value);
    if (answer?.source === "missing_profile_value" && !target) {
      if (shouldLeaveOptionalProfileFieldBlank(field, answer)) {
        return {
          option: null,
          source: "optional_profile_field_blank",
          fallback: false,
        };
      }
    }
    if (!real.length) {
      return { option: null, source: "no_options", fallback: false };
    }
    if (answer?.source === "missing_profile_value" && !target) {
      return progressFallbackOption({
        real,
        audit,
        fieldAudit,
        field,
        kind: "missing_profile_value_defaulted",
        reason:
          "Required option field had no saved profile value, so C3 used the progress-first fallback ladder.",
        neutralSource: "missing_profile_neutral_fallback",
        noSource: "missing_profile_no_fallback",
        firstSource: "missing_profile_first_real_fallback",
      });
    }
    if (answer.answerType === "travel_availability") {
      var travel = highestTravelOption(real);
      if (travel) {
        return {
          option: travel,
          source: "highest_travel_numeric",
          fallback: false,
        };
      }
    }
    if (answer.answerType === "year_range") {
      var yearRange = yearRangeOption(real, answer);
      if (yearRange) {
        return {
          option: yearRange,
          source: "year_range_contains_target",
          fallback: false,
        };
      }
    }
    var exact = real.find(function (option) {
      if (isNonAnswerOption(option)) {
        return false;
      }
      var label = normOptionLabel(option.label);
      var value = normOptionLabel(option.value);
      return target && (label === target || value === target);
    });
    if (exact) {
      return { option: exact, source: "exact", fallback: false };
    }
    if (
      field?.uiModel === "checkbox" &&
      answer.answerType === "yes_no" &&
      target === "yes" &&
      real.length === 1
    ) {
      return {
        option: real[0],
        source: "affirmative_checkbox",
        fallback: false,
      };
    }
    if (
      answer.answerType === "yes_no" &&
      (target === "yes" || target === "no")
    ) {
      var directYesNo = real.find(function (option) {
        var label = normOptionLabel(option.label);
        var value = normOptionLabel(option.value);
        return (
          label === target ||
          value === target ||
          label.startsWith(target + " ") ||
          label.startsWith(target + ",") ||
          value.startsWith(target + " ") ||
          value.startsWith(target + ",")
        );
      });
      if (directYesNo) {
        return {
          option: directYesNo,
          source: "yes_no_prefix",
          fallback: false,
        };
      }
    }
    if (
      field?.uiModel === "checkbox" &&
      answer.answerType === "non_disclosure"
    ) {
      var checkboxNeutral = neutralOption(real);
      if (checkboxNeutral) {
        return {
          option: checkboxNeutral,
          source: "neutral_disclosure_checkbox",
          fallback: false,
        };
      }
    }
    if (
      [
        "button_listbox",
        "combobox",
        "select",
        "segmented_button_group",
      ].includes(field?.uiModel) &&
      answer.answerType === "yes_no" &&
      target === "yes"
    ) {
      var affirmativeAgreement = real.find(function (option) {
        var label = normOptionLabel(option.label);
        return (
          (label.includes("agree") ||
            label.includes("accept") ||
            label.includes("consent")) &&
          !label.includes("do not") &&
          !label.includes("don t") &&
          !label.includes("decline")
        );
      });
      if (affirmativeAgreement) {
        return {
          option: affirmativeAgreement,
          source: "affirmative_agreement",
          fallback: false,
        };
      }
    }
    var aliases = optionAliases(answer);
    for (var i = 0; i < aliases.length; i++) {
      var alias = norm(aliases[i]);
      var aliasMatch = real.find(function (option) {
        if (isNonAnswerOption(option)) {
          return false;
        }
        return isStrictAliasMatch(option, alias);
      });
      if (aliasMatch) {
        return { option: aliasMatch, source: "alias", fallback: false };
      }
    }
    if (field?.uiModel === "checkbox") {
      if (field?.required) {
        return progressFallbackOption({
          real,
          audit,
          fieldAudit,
          field,
          kind: "checkbox_required_defaulted",
          reason:
            "Required checkbox had no exact safe match, so C3 used the progress-first fallback ladder.",
          neutralSource: "checkbox_neutral_fallback",
          noSource: "checkbox_no_fallback",
          firstSource: "checkbox_first_real_fallback",
        });
      }
      return {
        option: null,
        source: "checkbox_no_safe_match",
        fallback: false,
      };
    }
    if (isProvinceField(field)) {
      if (field?.required) {
        return progressFallbackOption({
          real,
          audit,
          fieldAudit,
          field,
          kind: "province_required_defaulted",
          reason:
            "Required province field had no exact safe match, so C3 used the progress-first fallback ladder.",
          neutralSource: "province_neutral_fallback",
          noSource: "province_no_fallback",
          firstSource: "province_first_real_fallback",
        });
      }
      return {
        option: null,
        source: "strict_province_no_match",
        fallback: false,
      };
    }
    var boundary = real.find(function (option) {
      if (isNonAnswerOption(option)) {
        return false;
      }
      var label = normOptionLabel(option.label);
      var value = normOptionLabel(option.value);
      return (
        target.length >= 4 &&
        (label.startsWith(target + " ") ||
          label.startsWith(target + ",") ||
          value.startsWith(target + " ") ||
          value.startsWith(target + ","))
      );
    });
    if (boundary) {
      return { option: boundary, source: "boundary", fallback: false };
    }
    var partial = real.find(function (option) {
      if (isNonAnswerOption(option)) {
        return false;
      }
      var label = normOptionLabel(option.label);
      var value = normOptionLabel(option.value);
      return (
        target.length >= 4 && (label.includes(target) || value.includes(target))
      );
    });
    if (partial) {
      return { option: partial, source: "partial", fallback: false };
    }
    if (isSalaryField(field, answer)) {
      var salaryMatch = real.find(function (option) {
        return salaryNumericMatch(option, answer);
      });
      if (salaryMatch) {
        return {
          option: salaryMatch,
          source: "salary_numeric_match",
          fallback: false,
        };
      }
      salaryMatch = closestSalaryOption(real, answer);
      if (salaryMatch) {
        return {
          option: salaryMatch,
          source: "salary_numeric_closest",
          fallback: false,
        };
      }
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "salary_option_no_safe_match",
        severity: field?.required ? "warn" : "info",
        failedStep: "option.match",
        reason:
          "Salary option did not match the profile salary value, so C3 used the progress-first fallback ladder.",
        options: real.map(function (option) {
          return option.label;
        }),
      });
      return progressFallbackOption({
        real,
        audit,
        fieldAudit,
        field,
        kind: "salary_option_defaulted",
        reason:
          "Salary option did not match the profile salary value, so C3 used the progress-first fallback ladder.",
        neutralSource: "salary_neutral_fallback",
        noSource: "salary_no_fallback",
        firstSource: "salary_first_real_fallback",
      });
    }
    if (isPhoneCountryCodeField(field)) {
      var phoneMatch = phoneCountryCodeOption(real, answer);
      if (phoneMatch) {
        return {
          option: phoneMatch,
          source: "phone_country_code_safe_match",
          fallback: false,
        };
      }
    }
    if (isPhoneDeviceTypeField(field)) {
      var safePhoneDevice = safePhoneDeviceTypeOption(real);
      if (safePhoneDevice) {
        return {
          option: safePhoneDevice,
          source: "phone_device_type_safe_option",
          fallback: false,
        };
      }
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "phone_device_type_no_mobile_option",
        severity: field?.required ? "warn" : "info",
        failedStep: "option.match",
        reason:
          "Phone device type did not offer a mobile or cell option, so C3 used the progress-first fallback ladder.",
        options: real.map(function (option) {
          return option.label;
        }),
      });
      return progressFallbackOption({
        real,
        audit,
        fieldAudit,
        field,
        kind: "phone_device_type_defaulted",
        reason:
          "Phone device type did not offer a mobile or cell option, so C3 used the progress-first fallback ladder.",
        neutralSource: "phone_device_neutral_fallback",
        noSource: "phone_device_no_fallback",
        firstSource: "phone_device_first_real_fallback",
      });
    }
    if (isDeferredHierarchicalWorkdayField(field, answer)) {
      return {
        option: null,
        source: "hierarchical_workday_deferred",
        fallback: false,
      };
    }
    if (shouldLeaveOptionalProfileFieldBlank(field, answer)) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "optional_profile_field_blank",
        severity: "info",
        failedStep: "option.match",
        reason:
          "Optional profile-backed field had no saved value, so C3 left it blank.",
        options: real.map(function (option) {
          return option.label;
        }),
      });
      return {
        option: null,
        source: "optional_profile_field_blank",
        fallback: false,
      };
    }
    if (isApplicationSourceField(field, answer)) {
      var sourceFallback = safeApplicationSourceOption(real);
      if (sourceFallback) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "application_source_safe_fallback",
          severity: "warn",
          failedStep: "option.match",
          reason:
            "Application source did not exactly match the profile value, so C3 selected a safe job-site style source instead of event/referral/recruiter options.",
          selectedOption: sourceFallback.label,
          options: real.map(function (option) {
            return option.label;
          }),
        });
        return {
          option: sourceFallback,
          source: "application_source_safe_fallback",
          fallback: true,
        };
      }
    }
    if (answer.answerType === "non_disclosure") {
      var neutral = neutralOption(options);
      if (neutral) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "max_progress_neutral_option",
          severity: "warn",
          failedStep: "option.match",
          reason: "Selected neutral or non-disclosure fallback.",
          selectedOption: neutral.label,
          options: real.map(function (option) {
            return option.label;
          }),
        });
        return { option: neutral, source: "neutral_fallback", fallback: true };
      }
    }
    if (answer.answerType === "non_disclosure") {
      if (isVeteranDisclosureField(field, answer)) {
        var notVeteran = safeNotVeteranOption(real);
        if (notVeteran) {
          root.audit?.pushIssue(audit, fieldAudit, {
            kind: "veteran_disclosure_profile_safe_fallback",
            severity: "warn",
            failedStep: "option.match",
            reason:
              "No neutral veteran disclosure option was visible, so C3 selected the profile-safe not-veteran option.",
            selectedOption: notVeteran.label,
            options: real.map(function (option) {
              return option.label;
            }),
          });
          return {
            option: notVeteran,
            source: "veteran_not_veteran_safe_fallback",
            fallback: true,
          };
        }
      }
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "non_disclosure_no_neutral_option",
        severity: field?.required ? "warn" : "info",
        failedStep: "option.match",
        reason:
          "No neutral or non-disclosure option was visible, so C3 used the progress-first fallback ladder.",
        options: real.map(function (option) {
          return option.label;
        }),
      });
      return progressFallbackOption({
        real,
        audit,
        fieldAudit,
        field,
        kind: "non_disclosure_defaulted",
        reason:
          "No neutral or non-disclosure option was visible, so C3 used the progress-first fallback ladder.",
        neutralSource: "non_disclosure_neutral_fallback",
        noSource: "non_disclosure_no_fallback",
        firstSource: "non_disclosure_first_real_fallback",
      });
    }
    if (answer.answerType === "unknown") {
      return progressFallbackOption({
        real,
        audit,
        fieldAudit,
        field,
        kind: "unknown_question_defaulted",
        reason:
          "Question was not recognized, so C3 used the progress-first fallback ladder.",
        neutralSource: "unknown_neutral_fallback",
        noSource: "unknown_no_fallback",
        firstSource: "unknown_first_real_fallback",
      });
    }
    return progressFallbackOption({
      real,
      audit,
      fieldAudit,
      field,
      kind: "max_progress_option_defaulted",
      reason:
        "No exact answer option matched, so C3 used the progress-first fallback ladder.",
      neutralSource: "neutral_fallback",
      noSource: "no_fallback",
      firstSource: "first_real_option",
    });
  }

  root.optionMatcher = {
    matchOption: matchOption,
    realOptions: realOptions,
    norm: norm,
  };
})();
