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
      preferredName: names.firstName,
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

  function dynamicOptionAliasesForEntry(entry, value, profile) {
    var aliases = Object.assign({}, entry.optionAliases || {});
    var key = clean(value);
    if (!key) {
      return aliases;
    }
    if (
      entry.id === "location" ||
      entry.id === "city" ||
      entry.id === "city_province_location"
    ) {
      var loc = locationParts(profile);
      var country = clean(loc.country).toLowerCase();
      var province = clean(loc.province).toLowerCase();
      var raw = clean(profile.location).toLowerCase();
      var canada =
        country === "canada" ||
        raw.includes("canada") ||
        /\b(ab|bc|b\.c\.|on|qc|mb|sk|ns|nb|nl|pe|pei|nt|nu|yt)\b/.test(
          province,
        );
      if (canada) {
        aliases[key] = Array.from(
          new Set([...(aliases[key] || []), "Elsewhere in Canada", "Canada"]),
        );
      }
    }
    return aliases;
  }

  function salaryTextAnswer(field, profile) {
    var fieldText = clean(
      [
        field?.descriptor,
        field?.fieldId,
        field?.element?.id,
        field?.element?.name,
      ].join(" "),
    ).toLowerCase();
    if (
      profile.salaryFlexible === true &&
      (field?.uiModel === "textarea" ||
        fieldText.includes("desired salary range") ||
        fieldText.includes("salary range"))
    ) {
      return {
        value:
          "I am flexible and open to discussing compensation based on the role and overall package.",
        source: "profile:salaryFlexible",
        confidence: 0.92,
      };
    }
    if (isHourlyCompensationField(field)) {
      var hourly = clean(profile.hourlyPayExpectation);
      if (hourly) {
        return {
          value: hourly,
          source: "profile:hourlyPayExpectation",
          confidence: 0.97,
        };
      }
      return {
        value: "25.00",
        source: "default:hourlyPayExpectation",
        confidence: 0.72,
      };
    }
    var point = clean(profile.salaryExpectation);
    var range = clean(profile.salaryExpectationRange);
    var target = salaryTargetNumber(point || range);
    if (target) {
      return {
        value: target,
        source: point
          ? "profile:salaryExpectation"
          : "profile:salaryExpectationRange",
        confidence: 0.96,
      };
    }
    return {
      value: "100000",
      source: "default:salaryExpectation",
      confidence: 0.72,
    };
  }

  function isHourlyCompensationField(field) {
    var text = clean(
      [
        field?.workday?.fieldLabel,
        field?.descriptor,
        field?.fieldId,
        field?.element?.id,
        field?.element?.name,
        field?.element?.getAttribute?.("aria-label"),
      ].join(" "),
    ).toLowerCase();
    return /\bhourly\b|\bwage\b/.test(text);
  }

  function hourlyFromAnnual(value) {
    var target = salaryTargetNumber(value);
    if (!target) {
      return "";
    }
    var annual = Number(String(target).replace(/,/g, ""));
    if (!Number.isFinite(annual) || annual <= 0) {
      return "";
    }
    return (annual / 2080).toFixed(2);
  }

  function salaryTargetNumber(value) {
    var numbers = String(value || "").match(/\d[\d,]*/g) || [];
    numbers = numbers
      .map(function (match) {
        return Number(match.replace(/,/g, ""));
      })
      .filter(function (number) {
        return Number.isFinite(number) && number >= 1000;
      });
    if (!numbers.length) {
      return "";
    }
    if (numbers.length >= 2) {
      return String(Math.round((numbers[0] + numbers[1]) / 2));
    }
    return String(numbers[0]);
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
    var usesDefaultToday = raw.toLowerCase() === "today";
    var parts = usesDefaultToday ? todayDateParts() : parseIsoLikeDate(raw);
    var part = datePartName(field);
    if (parts && part) {
      return {
        value: parts[part],
        source:
          raw === clean(entry.defaultValue)
            ? "default:" + entry.id + ":" + part
            : "profile:" + (entry.profilePaths || [entry.id])[0] + ":" + part,
        answerType: "text",
        confidence: raw === clean(entry.defaultValue) ? 0.96 : 0.96,
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
        confidence: raw === clean(entry.defaultValue) ? 0.96 : 0.96,
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

  function canadianCitizenshipStatusAnswer(entry, profile) {
    var status = clean(profile.canadianCitizenOrPermanentResident);
    var openPermit = clean(profile.openWorkPermit).toLowerCase();
    var country = clean(profile.country) || "Canada";
    var lowered = status.toLowerCase();
    if (
      lowered.includes("permanent") ||
      lowered === "pr" ||
      lowered.includes("resident")
    ) {
      return {
        value: "Permanent Resident (" + country + ")",
        source: "profile:canadianCitizenOrPermanentResident",
        confidence: 0.94,
      };
    }
    if (
      lowered === "yes" ||
      lowered === "true" ||
      lowered === "citizen" ||
      lowered.includes("citizen")
    ) {
      return {
        value: "Citizen (" + country + ")",
        source: "profile:canadianCitizenOrPermanentResident",
        confidence: 0.94,
      };
    }
    if (openPermit === "yes" || openPermit === "true") {
      return {
        value: "On Current Work Permit (" + country + ")",
        source: "profile:openWorkPermit",
        confidence: 0.88,
      };
    }
    return {
      value: clean(entry.defaultValue) || "Citizen (Canada)",
      source: "default:" + entry.id,
      confidence: 0.72,
    };
  }

  function educationAnswerForEntry(entry, profile) {
    var directPaths = entry.profilePaths || [];
    for (var i = 0; i < directPaths.length; i++) {
      var direct = clean(profile[directPaths[i]]);
      if (direct) {
        return {
          value: direct,
          source: "profile:" + directPaths[i],
          confidence: 0.96,
        };
      }
    }
    var education = Array.isArray(profile.education) ? profile.education : [];
    var preferredIndex = Number(profile.preferredEducationIndex || 0);
    var row = education[Number.isFinite(preferredIndex) ? preferredIndex : 0];
    if (!row && education.length) {
      row = education[0];
    }
    if (row) {
      var fromRow = clean(row.degree) || clean(row.degreeLevel);
      if (fromRow) {
        return {
          value: canonicalEducationAnswer(fromRow),
          source: clean(row.degree)
            ? "profile:education[0].degree"
            : "profile:education[0].degreeLevel",
          confidence: 0.9,
        };
      }
    }
    return null;
  }

  function canonicalEducationAnswer(value) {
    var text = clean(value);
    var lowered = text.toLowerCase();
    if (
      /\bbachelor/.test(lowered) ||
      /\bb\.?\s?s\.?\b/.test(lowered) ||
      /\bbsc\b/.test(lowered) ||
      /\bba\b/.test(lowered)
    ) {
      return "Bachelor's Degree";
    }
    if (
      /\bmaster/.test(lowered) ||
      /\bm\.?\s?s\.?\b/.test(lowered) ||
      /\bmsc\b/.test(lowered) ||
      /\bmba\b/.test(lowered) ||
      /\bph\.?\s?d\b/.test(lowered) ||
      /\bphd\b/.test(lowered)
    ) {
      return "Graduate School";
    }
    return text;
  }

  function educationRank(value) {
    var text = clean(value).toLowerCase();
    if (!text) {
      return 0;
    }
    if (
      /\bdoctor/.test(text) ||
      /\bph\.?\s?d\b/.test(text) ||
      /\bphd\b/.test(text)
    ) {
      return 5;
    }
    if (
      /\bmaster/.test(text) ||
      /\bm\.?\s?s\.?\b/.test(text) ||
      /\bmsc\b/.test(text) ||
      /\bmba\b/.test(text) ||
      /\bgraduate/.test(text)
    ) {
      return 4;
    }
    if (
      /\bbachelor/.test(text) ||
      /\bbachelors\b/.test(text) ||
      /\bb\.?\s?s\.?\b/.test(text) ||
      /\bbsc\b/.test(text) ||
      /\bba\b/.test(text) ||
      /\buniversity\b/.test(text)
    ) {
      return 3;
    }
    if (/\bassociate/.test(text) || /\bcollege\b/.test(text)) {
      return 2;
    }
    if (/\bhigh school\b/.test(text) || /\bged\b/.test(text)) {
      return 1;
    }
    return 0;
  }

  function educationLevelYesNoAnswer(entry, profile) {
    var candidates = [];
    (entry.profilePaths || []).forEach(function (path) {
      var value = clean(profile[path]);
      if (value) {
        candidates.push({ value: value, source: "profile:" + path });
      }
    });
    var education = Array.isArray(profile.education) ? profile.education : [];
    education.forEach(function (row, index) {
      var value = clean(row?.degreeLevel) || clean(row?.degree);
      if (value) {
        candidates.push({
          value: value,
          source: "profile:education[" + index + "]",
        });
      }
    });
    var requiredRank =
      entry.expectedEducationLevel === "bachelors"
        ? 3
        : entry.expectedEducationLevel === "high_school"
          ? 1
          : 0;
    var best = candidates
      .map(function (candidate) {
        return {
          value: candidate.value,
          source: candidate.source,
          rank: educationRank(candidate.value),
        };
      })
      .sort(function (a, b) {
        return b.rank - a.rank;
      })[0];
    var hasLevel = Boolean(best && requiredRank && best.rank >= requiredRank);
    return {
      value: hasLevel ? "Yes" : "No",
      source: best?.source || "default:" + entry.id,
      answerType: "yes_no",
      confidence: best ? 0.94 : 0.7,
      optionAliases: entry.optionAliases || {},
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

    if (entry.answerType === "education_level_yes_no") {
      return educationLevelYesNoAnswer(entry, profile);
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

    if (entry.id === "canadian_citizenship_status") {
      var citizenshipAnswer = canadianCitizenshipStatusAnswer(entry, profile);
      if (citizenshipAnswer.source.startsWith("default:")) {
        root.audit?.pushIssue(audit, fieldAudit, {
          kind: "default_answer_used",
          severity: "warn",
          failedStep: "answer.resolve",
          reason:
            "Used Canadian citizenship status default because profile citizenship fields were blank.",
          questionType: question.type,
        });
      }
      return {
        value: citizenshipAnswer.value,
        source: citizenshipAnswer.source,
        answerType: entry.answerType || "text",
        confidence: citizenshipAnswer.confidence,
        optionAliases: entry.optionAliases || {},
      };
    }

    if (entry.id === "highest_education" || entry.id === "degree_level") {
      var educationAnswer = educationAnswerForEntry(entry, profile);
      if (educationAnswer) {
        return {
          value: educationAnswer.value,
          source: educationAnswer.source,
          answerType: entry.answerType || "text",
          confidence: educationAnswer.confidence,
          optionAliases: entry.optionAliases || {},
        };
      }
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

    if (entry.answerType === "non_disclosure" && entry.defaultValue !== "") {
      root.audit?.pushIssue(audit, fieldAudit, {
        kind: "neutral_disclosure_default",
        severity: "warn",
        failedStep: "answer.resolve",
        reason: "Used catalog non-disclosure default for voluntary disclosure.",
        questionType: question.type,
      });
      return {
        value: answerValueForEntry(entry, entry.defaultValue),
        source: "default:" + entry.id,
        answerType: entry.answerType || "text",
        confidence: 0.9,
        optionAliases: entry.optionAliases || {},
      };
    }

    for (var i = 0; i < (entry.profilePaths || []).length; i++) {
      var path = entry.profilePaths[i];
      var result = profileValue(profile, path);
      var allValues = null;
      if (
        (entry.id === "technical_skills" || entry.id === "computer_programs") &&
        Array.isArray(result.value)
      ) {
        allValues = result.value.map(clean).filter(Boolean);
        result.value =
          entry.id === "computer_programs"
            ? allValues.join(", ")
            : allValues[0] || "";
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
          optionAliases: dynamicOptionAliasesForEntry(
            entry,
            result.value,
            profile,
          ),
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
