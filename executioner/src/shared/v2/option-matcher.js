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

  function neutralOption(options) {
    var aliases = root.fieldCatalog?.nonDisclosureAliases || [];
    var real = realOptions(options);
    for (var i = 0; i < aliases.length; i++) {
      var alias = norm(aliases[i]);
      var found = real.find(function (option) {
        var label = norm(option.label);
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
    var exact = real.find(function (option) {
      var label = normOptionLabel(option.label);
      var value = normOptionLabel(option.value);
      return label === target || value === target;
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
    if (
      answer.answerType === "non_disclosure" ||
      answer.answerType === "unknown"
    ) {
      var neutral = neutralOption(options);
      if (neutral) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "max_progress_neutral_option",
          severity: "warn",
          failedStep: "option.match",
          reason: "Selected neutral or non-disclosure fallback.",
          options: real.map(function (option) {
            return option.label;
          }),
        });
        return { option: neutral, source: "neutral_fallback", fallback: true };
      }
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
