(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function clean(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function nameParts(profile) {
    var full = clean(profile.fullName);
    var pieces = full.split(" ").filter(Boolean);
    return {
      firstName: pieces[0] || "",
      lastName: pieces.slice(1).join(" "),
      fullName: full,
    };
  }

  function locationParts(profile) {
    var raw = clean(profile.location);
    var pieces = raw.split(",").map(clean).filter(Boolean);
    return {
      city: clean(profile.city) || pieces[0] || "",
      province: clean(profile.province) || pieces[1] || "",
      country: clean(profile.country) || pieces[2] || "Canada",
    };
  }

  function profileValue(profile, path) {
    var names = nameParts(profile);
    var loc = locationParts(profile);
    var derived = {
      firstName: names.firstName,
      lastName: names.lastName,
      city: loc.city,
      province: loc.province,
      country: loc.country,
    };
    if (Object.prototype.hasOwnProperty.call(derived, path)) {
      var direct = clean(profile[path]);
      return {
        value: direct || derived[path],
        derived: !direct && Boolean(derived[path]),
        source: direct ? "profile:" + path : "derived:" + path,
      };
    }
    return {
      value: profile[path],
      derived: false,
      source: "profile:" + path,
    };
  }

  function normalizeYesNoValue(value) {
    if (value === true) {
      return "Yes";
    }
    if (value === false) {
      return "No";
    }
    var text = clean(value).toLowerCase();
    if (["yes", "y", "true"].includes(text)) {
      return "Yes";
    }
    if (["no", "n", "false"].includes(text)) {
      return "No";
    }
    return value;
  }

  function answerValueForEntry(entry, value) {
    if (entry.answerType === "yes_no") {
      return normalizeYesNoValue(value);
    }
    return value;
  }

  function salaryTextAnswer(field, profile) {
    var descriptor = clean(field.descriptor || field.label || "").toLowerCase();
    var asksAnnualAmount =
      descriptor.includes("annual") ||
      descriptor.includes("yearly") ||
      descriptor.includes("amount") ||
      /\be\.g\.\s*\d+/i.test(descriptor);
    var point = clean(profile.salaryExpectation);
    var range = clean(profile.salaryExpectationRange);
    if (asksAnnualAmount && point) {
      return {
        value: point,
        source: "profile:salaryExpectation",
        confidence: 0.96,
      };
    }
    if (range || point) {
      return {
        value: range || point,
        source: range
          ? "profile:salaryExpectationRange"
          : "profile:salaryExpectation",
        confidence: 0.96,
      };
    }
    return {
      value: asksAnnualAmount ? "95000" : "90,000 - 105,000",
      source: asksAnnualAmount
        ? "default:salaryExpectation"
        : "default:salaryExpectationRange",
      confidence: 0.72,
    };
  }

  function resolveAnswer({ question, field, profile, audit, fieldAudit }) {
    var entry = question.entry;
    if (!entry) {
      return {
        value: "",
        source: "unknown",
        answerType: "unknown",
        confidence: 0,
        needsGeneratedText:
          field.required && root.uiInspector?.isTextual(field),
      };
    }

    if (entry.answerType === "exact_previous_employer") {
      var previous = clean(profile.previousEmployers).toLowerCase();
      var descriptor = clean(field.descriptor).toLowerCase();
      var yes = previous
        .split(/[;,]/)
        .map(clean)
        .filter(Boolean)
        .some(function (employer) {
          return employer && descriptor.includes(employer.toLowerCase());
        });
      return {
        value: yes ? "Yes" : "No",
        source: "profile.previousEmployers:exact_name_only",
        answerType: "yes_no",
        confidence: 0.92,
      };
    }

    if (entry.answerType === "file") {
      return {
        value: entry.defaultValue || "resume_upload",
        source: "default:" + entry.id,
        answerType: "file",
        confidence: 1,
        optionAliases: entry.optionAliases || {},
      };
    }

    if (entry.id === "salary_expectation") {
      var salaryAnswer = salaryTextAnswer(field, profile);
      if (salaryAnswer.source.startsWith("default:")) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "default_answer_used",
          severity: "warn",
          failedStep: "answer.resolve",
          reason:
            "Used salary default because profile salary fields were blank.",
          questionType: question.type,
        });
      }
      return {
        value: salaryAnswer.value,
        source: salaryAnswer.source,
        answerType: entry.answerType || "text",
        confidence: salaryAnswer.confidence,
        optionAliases: entry.optionAliases || {},
      };
    }

    for (var i = 0; i < (entry.profilePaths || []).length; i++) {
      var path = entry.profilePaths[i];
      var result = profileValue(profile, path);
      if (
        result.value !== undefined &&
        result.value !== null &&
        result.value !== ""
      ) {
        if (result.derived) {
          root.audit?.pushIssue(audit, fieldAudit, {
            kind: "derived_profile_pairing",
            severity: "info",
            failedStep: "answer.resolve",
            reason: "Profile value derived from another saved field.",
            questionType: question.type,
          });
        }
        return {
          value: answerValueForEntry(entry, result.value),
          source: result.source,
          answerType: entry.answerType || "text",
          confidence: result.derived ? 0.8 : 0.96,
          optionAliases: entry.optionAliases || {},
        };
      }
    }

    if (entry.defaultValue !== "") {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind:
          entry.answerType === "non_disclosure"
            ? "neutral_disclosure_default"
            : "default_answer_used",
        severity: "warn",
        failedStep: "answer.resolve",
        reason: "Used catalog default because profile field was blank.",
        questionType: question.type,
      });
      return {
        value: answerValueForEntry(entry, entry.defaultValue),
        source: "default:" + entry.id,
        answerType: entry.answerType || "text",
        confidence: 0.72,
        optionAliases: entry.optionAliases || {},
      };
    }

    return {
      value: "",
      source: "missing_profile_value",
      answerType: entry.answerType || "text",
      confidence: 0,
      needsGeneratedText: field.required && root.uiInspector?.isTextual(field),
    };
  }

  root.answerResolver = {
    resolveAnswer: resolveAnswer,
  };
})();
