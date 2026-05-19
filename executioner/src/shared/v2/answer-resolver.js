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
      if (path === "firstName" && direct === names.fullName) {
        direct = "";
      }
      if (
        path === "lastName" &&
        names.fullName &&
        names.lastName &&
        (direct === names.fullName ||
          direct === names.firstName + " " + names.lastName)
      ) {
        direct = "";
      }
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

  function datePartName(field) {
    var el = field.element || field.anchor;
    var text = clean(
      [
        field.fieldId,
        el?.id,
        el?.name,
        el?.getAttribute?.("data-automation-id"),
        el?.getAttribute?.("aria-label"),
        field.descriptor,
      ].join(" "),
    ).toLowerCase();
    if (
      text.includes("datesectionmonth") ||
      text.includes("date section month") ||
      /\bmonth\b/.test(text)
    ) {
      return "month";
    }
    if (
      text.includes("datesectionday") ||
      text.includes("date section day") ||
      /\bday\b/.test(text)
    ) {
      return "day";
    }
    if (
      text.includes("datesectionyear") ||
      text.includes("date section year") ||
      /\byear\b/.test(text)
    ) {
      return "year";
    }
    return "";
  }

  function parseIsoLikeDate(value) {
    var text = clean(value);
    var iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      return {
        year: iso[1],
        month: iso[2].padStart(2, "0"),
        day: iso[3].padStart(2, "0"),
      };
    }
    var slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      return {
        month: slash[1].padStart(2, "0"),
        day: slash[2].padStart(2, "0"),
        year: slash[3],
      };
    }
    return null;
  }

  function todayDateParts() {
    var now = new Date();
    return {
      year: String(now.getFullYear()),
      month: String(now.getMonth() + 1).padStart(2, "0"),
      day: String(now.getDate()).padStart(2, "0"),
    };
  }

  function dateAnswerForEntry(entry, field, profile) {
    var raw = "";
    for (var i = 0; i < (entry.profilePaths || []).length; i++) {
      raw = clean(profile[entry.profilePaths[i]]);
      if (raw) {
        break;
      }
    }
    raw = raw || clean(entry.defaultValue);
    var parts = parseIsoLikeDate(raw);
    var part = datePartName(field);
    if (parts && part) {
      return {
        value: parts[part],
        source:
          raw === clean(entry.defaultValue)
            ? "default:" + entry.id + ":" + part
            : "profile:" + (entry.profilePaths || [entry.id])[0] + ":" + part,
        answerType: "text",
        confidence: raw === clean(entry.defaultValue) ? 0.72 : 0.96,
      };
    }
    if (parts) {
      return {
        value: parts.month + "/" + parts.day + "/" + parts.year,
        source:
          raw === clean(entry.defaultValue)
            ? "default:" + entry.id
            : "profile:" + (entry.profilePaths || [entry.id])[0],
        answerType: "text",
        confidence: raw === clean(entry.defaultValue) ? 0.72 : 0.96,
      };
    }
    return {
      value: raw,
      source:
        raw === clean(entry.defaultValue)
          ? "default:" + entry.id
          : "profile:" + (entry.profilePaths || [entry.id])[0],
      answerType: "text",
      confidence: raw === clean(entry.defaultValue) ? 0.72 : 0.96,
    };
  }

  function currentDateAnswerForEntry(entry, field) {
    var parts = todayDateParts();
    var part = datePartName(field);
    if (part) {
      return {
        value: parts[part],
        source: "default:" + entry.id + ":" + part,
        answerType: "text",
        confidence: 0.96,
      };
    }
    return {
      value: parts.month + "/" + parts.day + "/" + parts.year,
      source: "default:" + entry.id,
      answerType: "text",
      confidence: 0.96,
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

    if (entry.id === "desired_start_date") {
      var dateAnswer = dateAnswerForEntry(entry, field, profile);
      if (dateAnswer.source.startsWith("default:")) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "default_answer_used",
          severity: "warn",
          failedStep: "answer.resolve",
          reason:
            "Used desired start date default because profile desiredStartDate was blank.",
          questionType: question.type,
        });
      }
      return dateAnswer;
    }

    if (entry.id === "current_date") {
      return currentDateAnswerForEntry(entry, field);
    }

    if (entry.id === "address_line_2" && field.required) {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "default_answer_used",
        severity: "warn",
        failedStep: "answer.resolve",
        reason:
          "Used N/A for required address line 2 because profile addressLine2 was blank.",
        questionType: question.type,
      });
      return {
        value: "N/A",
        source: "default:required_address_line_2",
        answerType: entry.answerType || "text",
        confidence: 0.72,
        optionAliases: entry.optionAliases || {},
      };
    }

    if (entry.id === "application_source") {
      var sourceCategory = clean(profile.applicationSourceCategory);
      var source = clean(profile.applicationSource);
      var sourceDetail = clean(profile.applicationSourceDetail);
      var sourceValue =
        sourceCategory || source || sourceDetail || clean(entry.defaultValue);
      var sourceAliases = [
        source,
        sourceDetail,
        sourceCategory,
        source && source.toLowerCase().includes("linkedin") ? "LinkedIn" : "",
        source && source.toLowerCase().includes("linkedin")
          ? "Social Media"
          : "",
        sourceCategory &&
        sourceCategory.toLowerCase().includes("job") &&
        sourceCategory.toLowerCase().includes("board")
          ? "Job Sites"
          : "",
        sourceCategory &&
        sourceCategory.toLowerCase().includes("job") &&
        sourceCategory.toLowerCase().includes("board")
          ? "Career Websites"
          : "",
      ].filter(Boolean);
      var sourceAliasMap = {};
      sourceAliasMap[sourceValue] = Array.from(new Set(sourceAliases));
      if (!sourceCategory && !source && !sourceDetail) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "default_answer_used",
          severity: "warn",
          failedStep: "answer.resolve",
          reason:
            "Used application source default because profile source fields were blank.",
          questionType: question.type,
        });
      }
      return {
        value: sourceValue,
        source:
          sourceValue === sourceCategory
            ? "profile:applicationSourceCategory"
            : sourceValue === source
              ? "profile:applicationSource"
              : sourceValue === sourceDetail
                ? "profile:applicationSourceDetail"
                : "default:" + entry.id,
        answerType: entry.answerType || "text",
        confidence: sourceValue === clean(entry.defaultValue) ? 0.72 : 0.96,
        optionAliases: Object.assign(
          {},
          entry.optionAliases || {},
          sourceAliasMap,
        ),
      };
    }

    if (entry.id === "email") {
      var bodyText = clean(document.body?.innerText || "").toLowerCase();
      var descriptorText = clean(field.descriptor || "").toLowerCase();
      var isAuthEmail =
        /create account|sign in|log in|login|register|forgot your password|already have an account|don't have an account/i.test(
          bodyText,
        ) ||
        /login email|account email|username|user name|user id/i.test(
          descriptorText,
        );
      var authEmail = clean(profile.accountEmail);
      if (isAuthEmail && authEmail) {
        return {
          value: authEmail,
          source: "profile:accountEmail",
          answerType: entry.answerType || "text",
          confidence: 0.97,
          optionAliases: entry.optionAliases || {},
        };
      }
    }

    for (var i = 0; i < (entry.profilePaths || []).length; i++) {
      var path = entry.profilePaths[i];
      var result = profileValue(profile, path);
      var allValues = null;
      if (entry.id === "technical_skills" && Array.isArray(result.value)) {
        allValues = result.value.map(clean).filter(Boolean);
        result.value = allValues[0] || "";
      }
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
          allValues: allValues || undefined,
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
