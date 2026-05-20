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
    return (
      text.includes("salary") ||
      text.includes("compensation") ||
      text.includes("pay expectation") ||
      text.includes("salaryexpectation")
    );
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

  function neutralOption(options) {
    var aliases = root.fieldCatalog?.nonDisclosureAliases || [];
    var real = realOptions(options);
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

  function matchOption({ options, answer, audit, fieldAudit, field }) {
    var real = realOptions(options);
    var target = norm(answer.value);
    if (!real.length) {
      return { option: null, source: "no_options", fallback: false };
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
    var exact = real.find(function (option) {
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
    if (answer.answerType === "yes_no" && (target === "yes" || target === "no")) {
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
    if (field?.uiModel === "checkbox" && answer.answerType === "non_disclosure") {
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
        return isStrictAliasMatch(option, alias);
      });
      if (aliasMatch) {
        return { option: aliasMatch, source: "alias", fallback: false };
      }
    }
    if (field?.uiModel === "checkbox") {
      return {
        option: null,
        source: "checkbox_no_safe_match",
        fallback: false,
      };
    }
    if (isProvinceField(field)) {
      return {
        option: null,
        source: "strict_province_no_match",
        fallback: false,
      };
    }
    var boundary = real.find(function (option) {
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
          "Salary option did not match the profile salary value, so no fallback option was selected.",
        options: real.map(function (option) {
          return option.label;
        }),
      });
      return {
        option: null,
        source: "salary_no_safe_match",
        fallback: false,
      };
    }
    if (isDeferredHierarchicalWorkdayField(field, answer)) {
      return {
        option: null,
        source: "hierarchical_workday_deferred",
        fallback: false,
      };
    }
    if (
      answer.answerType === "non_disclosure" ||
      answer.answerType === "unknown"
    ) {
      var neutral = neutralOption(options);
      if (neutral) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind:
            answer.answerType === "unknown"
              ? "unknown_question_default_option"
              : "max_progress_neutral_option",
          severity: "warn",
          failedStep: "option.match",
          reason:
            answer.answerType === "unknown"
              ? "Question was not recognized, so C3 selected the neutral or non-disclosure fallback."
              : "Selected neutral or non-disclosure fallback.",
          selectedOption: neutral.label,
          options: real.map(function (option) {
            return option.label;
          }),
        });
        return { option: neutral, source: "neutral_fallback", fallback: true };
      }
    }
    if (answer.answerType === "unknown") {
      var unknownNoOption = real.find(function (option) {
        var label = normOptionLabel(option.label);
        var value = normOptionLabel(option.value);
        return label === "no" || value === "no";
      });
      if (unknownNoOption) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "unknown_question_default_option",
          severity: "warn",
          failedStep: "option.match",
          reason:
            "Question was not recognized, so C3 selected No as the max-progress fallback.",
          selectedOption: unknownNoOption.label,
          options: real.map(function (option) {
            return option.label;
          }),
        });
        return {
          option: unknownNoOption,
          source: "unknown_no_fallback",
          fallback: true,
        };
      }
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "unknown_question_default_option",
        severity: "warn",
        failedStep: "option.match",
        reason:
          "Question was not recognized, so C3 selected the first real non-placeholder option.",
        selectedOption: real[0].label,
        options: real.map(function (option) {
          return option.label;
        }),
      });
      return {
        option: real[0],
        source: "unknown_first_real_option",
        fallback: true,
      };
    }
    var other = real.find(function (option) {
      var label = norm(option.label);
      return (
        label === "other" || label.includes("not applicable") || label === "n a"
      );
    });
    if (other) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "max_progress_other_option",
        severity: "warn",
        failedStep: "option.match",
        reason: "Selected Other or Not applicable fallback.",
        options: real.map(function (option) {
          return option.label;
        }),
      });
      return { option: other, source: "other_fallback", fallback: true };
    }
    var noOption = real.find(function (option) {
      var label = normOptionLabel(option.label);
      var value = normOptionLabel(option.value);
      return label === "no" || value === "no";
    });
    if (noOption) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "max_progress_no_option",
        severity: "warn",
        failedStep: "option.match",
        reason: "Selected No fallback before first real option.",
        options: real.map(function (option) {
          return option.label;
        }),
      });
      return { option: noOption, source: "no_fallback", fallback: true };
    }
    root.audit?.pushIssue(audit, fieldAudit, {
      kind: "max_progress_first_real_option",
      severity: "warn",
      failedStep: "option.match",
      reason: "Selected first real non-placeholder option.",
      options: real.map(function (option) {
        return option.label;
      }),
    });
    return { option: real[0], source: "first_real_option", fallback: true };
  }

  root.optionMatcher = {
    matchOption: matchOption,
    realOptions: realOptions,
    norm: norm,
  };
})();
