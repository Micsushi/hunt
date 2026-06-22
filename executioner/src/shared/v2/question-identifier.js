(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function norm(value) {
    return String(value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9+#]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function includesAll(text, terms) {
    return (terms || []).every(function (term) {
      return text.includes(norm(term));
    });
  }

  function includesPhrase(text, phraseNorm) {
    if (!phraseNorm) {
      return false;
    }
    return (" " + text + " ").includes(" " + phraseNorm + " ");
  }

  function hasExcluded(text, entry) {
    return (entry.excludeKeywords || []).some(function (term) {
      return text.includes(norm(term));
    });
  }

  function compactTexts(values) {
    var seen = {};
    return values.map(norm).filter(function (piece) {
      if (!piece || seen[piece]) {
        return false;
      }
      seen[piece] = true;
      return true;
    });
  }

  function priorityTextGroups(field) {
    var el = field.element || field.anchor;
    return [
      compactTexts([field.workday?.fieldLabel]),
      compactTexts([el?.getAttribute?.("aria-label")]),
      compactTexts([field.fieldId, el?.id, el?.name]),
      compactTexts([
        el?.getAttribute?.("placeholder"),
        el?.getAttribute?.("data-automation-id"),
      ]),
      compactTexts([field.descriptor]),
    ];
  }

  function findExact(entries, texts) {
    for (var i = 0; i < texts.length; i++) {
      var text = texts[i];
      var exact = entries.find(function (entry) {
        return (entry.exactLabels || []).some(function (label) {
          return text === norm(label);
        });
      });
      if (exact && !hasExcluded(text, exact)) {
        return { entry: exact, text: text };
      }
    }
    return null;
  }

  function findAlias(entries, texts) {
    var best = null;
    for (var i = 0; i < texts.length; i++) {
      var text = texts[i];
      entries.forEach(function (entry) {
        if (hasExcluded(text, entry)) {
          return;
        }
        (entry.aliases || []).forEach(function (phrase) {
          var phraseNorm = norm(phrase);
          if (!includesPhrase(text, phraseNorm)) {
            return;
          }
          var position = (" " + text + " ").indexOf(" " + phraseNorm + " ");
          var score = phraseNorm.length * 10 - Math.max(position, 0);
          if (!best || score > best.score) {
            best = {
              entry: entry,
              text: text,
              score: score,
            };
          }
        });
      });
    }
    return best;
  }

  function findKeyword(entries, texts) {
    for (var i = 0; i < texts.length; i++) {
      var text = texts[i];
      var keyword = entries.find(function (entry) {
        return (
          (entry.includeKeywords || []).length > 0 &&
          !hasExcluded(text, entry) &&
          includesAll(text, entry.includeKeywords)
        );
      });
      if (keyword) {
        return { entry: keyword, text: text };
      }
    }
    return null;
  }

  function identifyQuestion(field, audit, fieldAudit) {
    var groups = priorityTextGroups(field);
    var texts = groups.flat();
    var entries = root.fieldCatalog?.entries || [];
    var exact = findExact(entries, texts);
    if (exact) {
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "question_identified",
        step: "question.exact",
        status: "ok",
        questionType: exact.entry.id,
        reason: "exact_label_match",
        detail: { matchedText: exact.text },
      });
      return {
        type: exact.entry.id,
        entry: exact.entry,
        source: "exact",
        confidence: 1,
      };
    }

    var alias = null;
    for (var groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      var groupAlias = findAlias(entries, groups[groupIndex]);
      if (
        groupAlias &&
        (!alias ||
          groupAlias.score > alias.score ||
          (groupAlias.score === alias.score &&
            groupIndex < alias.groupIndex))
      ) {
        alias = Object.assign({ groupIndex: groupIndex }, groupAlias);
      }
    }
    if (alias) {
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "question_identified",
        step: "question.alias",
        status: "ok",
        questionType: alias.entry.id,
        reason: "alias_or_phrase_match",
        detail: { matchedText: alias.text },
      });
      return {
        type: alias.entry.id,
        entry: alias.entry,
        source: "alias",
        confidence: 0.9,
      };
    }

    var keyword = findKeyword(entries, texts);
    if (keyword) {
      root.audit?.pushFieldStep(audit, fieldAudit, {
        action: "question_identified",
        step: "question.keyword",
        status: "ok",
        questionType: keyword.entry.id,
        reason: "keyword_match",
        detail: { matchedText: keyword.text },
      });
      return {
        type: keyword.entry.id,
        entry: keyword.entry,
        source: "keyword",
        confidence: 0.78,
      };
    }

    root.audit?.pushFieldStep(audit, fieldAudit, {
      action: "question_unresolved",
      step: "question.unknown",
      status: "warn",
      questionType: "unknown",
      reason: "no_catalog_match",
    });
    return { type: "unknown", entry: null, source: "unknown", confidence: 0 };
  }

  root.questionIdentifier = {
    identifyQuestion: identifyQuestion,
    norm: norm,
  };
})();
