export function canOfferSafeNextAfterFill(fillResponse = {}) {
  const result = fillResponse.result || {};
  const attempt = fillResponse.attempt || {};
  const pendingLlmFieldCount = Number(result.pendingLlmFieldCount || 0);
  const permanentIssues = [
    ...(Array.isArray(result.v2Audit?.permanentIssues)
      ? result.v2Audit.permanentIssues
      : []),
    ...(Array.isArray(attempt.v2Audit?.permanentIssues)
      ? attempt.v2Audit.permanentIssues
      : []),
  ];
  const hardBlockedIssue = permanentIssues.some((issue) =>
    ["blocked", "error"].includes(String(issue?.severity || "").toLowerCase()),
  );
  const filledFieldCount = Number(
    attempt.filledFieldCount ?? result.filledFieldCount ?? 0,
  );
  const cleanAlreadyFilled =
    attempt.status === "filled" || result.status === "filled";
  return Boolean(
    fillResponse.ok &&
    pendingLlmFieldCount === 0 &&
    (filledFieldCount > 0 || cleanAlreadyFilled) &&
    !hardBlockedIssue,
  );
}

export function chooseBestSafeNextFrame(scriptResults = []) {
  const frameResults = scriptResults.map((entry) => ({
    frameId: entry.frameId,
    result: entry.result || {},
  }));
  const candidates = frameResults.filter(
    (entry) => entry.result?.ok && entry.result?.found,
  );
  if (candidates.length) {
    candidates.sort((a, b) => {
      const aScore = Number(a.result.candidate?.score || 0);
      const bScore = Number(b.result.candidate?.score || 0);
      if (aScore !== bScore) {
        return bScore - aScore;
      }
      const aInputs = Number(a.result.inputCount || 0);
      const bInputs = Number(b.result.inputCount || 0);
      if (aInputs !== bInputs) {
        return bInputs - aInputs;
      }
      return Number(a.frameId || 0) - Number(b.frameId || 0);
    });
    return {
      ok: true,
      available: true,
      frameId: candidates[0].frameId,
      ...candidates[0].result,
    };
  }

  const blocked = frameResults.find(
    (entry) => entry.result?.reason === "final_submit_visible",
  );
  if (blocked) {
    return {
      ok: false,
      available: false,
      frameId: blocked.frameId,
      ...blocked.result,
    };
  }

  const stopped = frameResults.find(
    (entry) =>
      entry.result?.reason && entry.result.reason !== "no_safe_next_button",
  );
  if (stopped) {
    return {
      ok: false,
      available: false,
      frameId: stopped.frameId,
      ...stopped.result,
    };
  }

  return {
    ok: false,
    available: false,
    reason: "no_safe_next_button",
    message: "No safe Next or Continue button was found.",
  };
}

export function summarizeSafeNextResult(result = {}) {
  if (
    result.reason === "clicked_safe_next_recovered_workday_runtime_error" ||
    result.reason === "clicked_safe_next_workday_runtime_error_unrecovered"
  ) {
    return result.message || "Clicked Next and handled a Workday page error.";
  }
  if (result.clicked) {
    return `Clicked ${result.candidate?.label || "Next"}.`;
  }
  if (result.reason === "final_submit_visible") {
    return "Stopped before final submit.";
  }
  if (result.reason === "fill_not_ready_for_next") {
    return "Next skipped because fill still needs review.";
  }
  return result.message || "No safe Next button was clicked.";
}

export function createSafeNextFunction() {
  return function safeNextAfterFill(options) {
    var click = Boolean(options && options.click);
    var forceWorkdayDomClickFallback = Boolean(
      options && options.forceWorkdayDomClickFallback,
    );
    var forceWorkdayEnterFallback = Boolean(
      options && options.forceWorkdayEnterFallback,
    );
    var forceWorkdaySpaceFallback = Boolean(
      options && options.forceWorkdaySpaceFallback,
    );

    function normalizeText(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function lower(value) {
      return normalizeText(value).toLowerCase();
    }

    function uniqueJoined(pieces) {
      var seen = {};
      return normalizeText(
        pieces
          .map(function (piece) {
            return normalizeText(piece);
          })
          .filter(function (piece) {
            var key = lower(piece);
            if (!piece || seen[key]) {
              return false;
            }
            seen[key] = true;
            return true;
          })
          .join(" "),
      );
    }

    function isVisibleEnabled(el) {
      if (!el || el.disabled) {
        return false;
      }
      if (
        el.getAttribute("aria-disabled") === "true" ||
        el.getAttribute("disabled") !== null
      ) {
        return false;
      }
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function isVisibleIgnoringDisabled(el) {
      if (!el) {
        return false;
      }
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function visibleLabel(el) {
      if (!el) {
        return "";
      }
      var tagName = String(el.tagName || "").toLowerCase();
      var pieces = [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        tagName === "input" ? el.value : "",
        el.innerText,
        el.textContent,
      ];
      return uniqueJoined(pieces);
    }

    function metadataLabel(el) {
      if (!el) {
        return "";
      }
      return normalizeText(
        [
          el.id,
          el.getAttribute("name"),
          el.getAttribute("data-automation-id"),
          el.getAttribute("data-testid"),
          el.getAttribute("data-qa"),
          el.getAttribute("class"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    function hasFinalSubmitTerms(text) {
      var value = lower(text);
      if (!value) {
        return false;
      }
      return /(^|\b)(submit|apply|finish|complete|send|finalize|done|register)(\b|$)/i.test(
        value,
      );
    }

    function hasBackwardTerms(text) {
      var value = lower(text);
      return /(^|\b)(back|previous|prev|cancel|close|dismiss)(\b|$)/i.test(
        value,
      );
    }

    function safeScore(visible, metadata, el) {
      var text = lower([visible, metadata].filter(Boolean).join(" "));
      var visibleText = lower(visible);
      if (!text || hasBackwardTerms(text) || hasFinalSubmitTerms(visibleText)) {
        return 0;
      }

      var score = 0;
      if (/^(next|next step|go next)$/.test(visibleText)) {
        score = 120;
      } else if (/(^|\b)next(\b|$)/.test(text)) {
        score = 110;
      } else if (
        /^(continue|save and continue|save & continue)$/.test(visibleText)
      ) {
        score = 100;
      } else if (/(^|\b)continue(\b|$)/.test(text)) {
        score = 92;
      } else if (/^(review|review application)$/.test(visibleText)) {
        score = 84;
      } else if (/(^|\b)review(\b|$)/.test(text)) {
        score = 76;
      }

      if (!score) {
        return 0;
      }
      if (
        /pageFooterNextButton|pageFooter|bottom-navigation-next-button|next-button|nextButton/i.test(
          metadata,
        )
      ) {
        score += 18;
      }
      var tagName = String(el.tagName || "").toLowerCase();
      var role = lower(el.getAttribute("role"));
      if (tagName === "button" || tagName === "input") {
        score += 14;
      } else if (role === "button") {
        score += 8;
      } else if (/pageFooter$/i.test(metadata)) {
        score -= 40;
      }
      if (el.closest("form")) {
        score += 8;
      }
      var rect = el.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.45) {
        score += 4;
      }
      if (String(el.tagName || "").toLowerCase() === "a") {
        score -= 6;
      }
      return score;
    }

    function dismissOpenWorkdayPopups() {
      try {
        var active = document.activeElement;
        if (active && typeof active.dispatchEvent === "function") {
          keyEvent(active, "Escape");
          active.blur?.();
        }
      } catch (_error) {}
      Array.from(
        document.querySelectorAll(
          "[role='listbox'], [role='dialog'], [data-uxi-widget-type='multiselectlist'], [data-automation-id*='popup'], [data-automation-id*='menu']",
        ),
      ).forEach(function (popup) {
        try {
          keyEvent(popup, "Escape");
        } catch (_error) {}
      });
    }

    function describeElement(el) {
      var parts = [String(el.tagName || "").toLowerCase()];
      if (el.id) {
        parts.push("#" + el.id);
      }
      var name = el.getAttribute("name");
      if (name) {
        parts.push("[name='" + name.slice(0, 60) + "']");
      }
      var automationId = el.getAttribute("data-automation-id");
      if (automationId) {
        parts.push("[data-automation-id='" + automationId.slice(0, 60) + "']");
      }
      return parts.join("");
    }

    function inputCount() {
      return Array.from(
        document.querySelectorAll("input, textarea, select, [role='textbox']"),
      ).filter(isVisibleEnabled).length;
    }

    function visibleValidationErrors() {
      return Array.from(
        document.querySelectorAll(
          [
            '[role="alert"]',
            '[data-automation-id*="error"]',
            '[id^="Error-"]',
            '[id^="error-"]',
            ".css-1iucqxd",
          ].join(", "),
        ),
      )
        .filter(function (el) {
          if (!el || !el.getBoundingClientRect) {
            return false;
          }
          var style = window.getComputedStyle(el);
          var rect = el.getBoundingClientRect();
          var text = normalizeText(el.innerText || el.textContent || "");
          return (
            text &&
            !/successfully uploaded/i.test(text) &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .map(function (el) {
          return normalizeText(el.innerText || el.textContent || "").slice(
            0,
            160,
          );
        });
    }

    function findBestCandidate() {
      var allElements = Array.from(
        document.querySelectorAll(
          [
            "button",
            "a[href]",
            "[role='button']",
            "[data-automation-id='pageFooterNextButton']",
            "[data-automation-id='bottom-navigation-next-button']",
            "[data-automation-id='nextButton']",
            "input[type='button']",
            "input[type='submit']",
          ].join(", "),
        ),
      );
      var elements = allElements.filter(isVisibleEnabled);
      var blockedFinalSubmitLabels = [];
      var candidates = [];
      var disabledFooterCandidates = [];

      allElements.forEach(function (el) {
        var visible = visibleLabel(el);
        var metadata = metadataLabel(el);
        var ariaDisabled = el.getAttribute("aria-disabled") === "true";
        if (
          ariaDisabled &&
          !el.disabled &&
          el.getAttribute("disabled") === null &&
          isVisibleIgnoringDisabled(el) &&
          /pageFooterNextButton|bottom-navigation-next-button|next-button|nextButton/i.test(
            metadata,
          )
        ) {
          var disabledScore = safeScore(visible, metadata, el);
          if (disabledScore) {
            var disabledRect = el.getBoundingClientRect();
            disabledFooterCandidates.push({
              element: el,
              label: (visible || metadata || "Next").slice(0, 120),
              metadata: metadata.slice(0, 160),
              selector: describeElement(el),
              score: disabledScore - 4,
              ariaDisabledBypass: true,
              rect: {
                top: Math.round(disabledRect.top),
                left: Math.round(disabledRect.left),
                width: Math.round(disabledRect.width),
                height: Math.round(disabledRect.height),
              },
            });
          }
        }
      });

      elements.forEach(function (el) {
        var visible = visibleLabel(el);
        var metadata = metadataLabel(el);
        if (hasFinalSubmitTerms(visible)) {
          blockedFinalSubmitLabels.push(visible.slice(0, 120));
          return;
        }
        var score = safeScore(visible, metadata, el);
        if (!score) {
          return;
        }
        var rect = el.getBoundingClientRect();
        candidates.push({
          element: el,
          label: (visible || metadata || "Next").slice(0, 120),
          metadata: metadata.slice(0, 160),
          selector: describeElement(el),
          score,
          rect: {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      });

      if (!candidates.length && disabledFooterCandidates.length) {
        candidates = disabledFooterCandidates.slice(0, 1);
      }

      candidates.sort(function (a, b) {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return b.rect.top - a.rect.top;
      });

      return {
        candidate: candidates[0] || null,
        candidateCount: candidates.length,
        topCandidates: candidates.slice(0, 8).map(publicCandidate),
        disabledFooterCandidates: disabledFooterCandidates
          .slice(0, 8)
          .map(publicCandidate),
        blockedFinalSubmitLabels: blockedFinalSubmitLabels.slice(0, 8),
      };
    }

    function visibleExternalAssessment() {
      var labels = Array.from(
        document.querySelectorAll(
          [
            "button",
            "a[href]",
            "[role='button']",
            "input[type='button']",
            "input[type='submit']",
          ].join(", "),
        ),
      )
        .filter(isVisibleEnabled)
        .map(function (el) {
          return visibleLabel(el) || metadataLabel(el);
        })
        .filter(Boolean);
      var label = labels.find(function (text) {
        return /take assessment|start assessment|assessment/i.test(text);
      });
      return label
        ? {
            found: true,
            label: label.slice(0, 160) || "Take Assessment",
          }
        : { found: false };
    }

    function publicCandidate(candidate) {
      if (!candidate) {
        return null;
      }
      var el = candidate.element;
      return {
        label: candidate.label,
        metadata: candidate.metadata,
        selector: candidate.selector,
        score: candidate.score,
        rect: candidate.rect,
        tagName: String(el?.tagName || "").toLowerCase(),
        role: el?.getAttribute?.("role") || "",
        automationId: el?.getAttribute?.("data-automation-id") || "",
        ariaDisabled: el?.getAttribute?.("aria-disabled") || "",
        disabled: Boolean(el?.disabled),
        ariaDisabledBypass: Boolean(candidate.ariaDisabledBypass),
      };
    }

    function pointerEvent(target, type, rect) {
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
    }

    function realisticClick(el) {
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center", inline: "center" });
      }
      if (typeof el.focus === "function") {
        try {
          el.focus({ preventScroll: true });
        } catch (_error) {
          el.focus();
        }
      }
      var rect = el.getBoundingClientRect();
      [
        "mouseover",
        "mousemove",
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup",
        "click",
      ].forEach(function (type) {
        pointerEvent(el, type, rect);
      });
    }

    function fallbackDomClick(el) {
      if (!forceWorkdayDomClickFallback || !el) {
        return false;
      }
      try {
        if (typeof el.click === "function") {
          el.click();
          return true;
        }
      } catch (_error) {
        return false;
      }
      return false;
    }

    function keyEvent(target, key) {
      var code = key === "Enter" ? "Enter" : key;
      var keyCode = key === "Enter" ? 13 : key === " " ? 32 : 0;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
          code,
          keyCode,
          which: keyCode,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          bubbles: true,
          cancelable: true,
          key,
          code,
          keyCode,
          which: keyCode,
        }),
      );
    }

    function fallbackFocusEnter(el) {
      if (!forceWorkdayEnterFallback || !el) {
        return false;
      }
      try {
        if (typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "center", inline: "center" });
        }
        if (typeof el.focus === "function") {
          el.focus({ preventScroll: true });
        }
        keyEvent(el, "Enter");
        return true;
      } catch (_error) {
        return false;
      }
    }

    function fallbackFocusSpace(el) {
      if (!forceWorkdaySpaceFallback || !el) {
        return false;
      }
      try {
        if (typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "center", inline: "center" });
        }
        if (typeof el.focus === "function") {
          el.focus({ preventScroll: true });
        }
        keyEvent(el, " ");
        return true;
      } catch (_error) {
        return false;
      }
    }

    var found = findBestCandidate();
    var count = inputCount();
    var errors = visibleValidationErrors();
    if (errors.length) {
      return {
        ok: false,
        found: false,
        clicked: false,
        reason: "visible_validation_errors",
        message: "Next skipped because visible validation errors are present.",
        candidateCount: found.candidateCount,
        blockedFinalSubmitLabels: found.blockedFinalSubmitLabels,
        disabledFooterCandidates: found.disabledFooterCandidates || [],
        topCandidates: found.topCandidates || [],
        visibleValidationErrors: errors.slice(0, 8),
        inputCount: count,
      };
    }
    if (!found.candidate) {
      var assessment = visibleExternalAssessment();
      if (assessment.found) {
        return {
          ok: false,
          found: false,
          clicked: false,
          reason: "external_assessment_required",
          message:
            "Stopped because Workday requires an external assessment before Review.",
          candidateCount: found.candidateCount,
          blockedFinalSubmitLabels: found.blockedFinalSubmitLabels,
          disabledFooterCandidates: found.disabledFooterCandidates || [],
          topCandidates: found.topCandidates || [],
          assessment,
          inputCount: count,
        };
      }
      var reason = found.blockedFinalSubmitLabels.length
        ? "final_submit_visible"
        : "no_safe_next_button";
      return {
        ok: false,
        found: false,
        clicked: false,
        reason,
        message:
          reason === "final_submit_visible"
            ? "Stopped because a final submit-style button is visible."
            : "No safe Next or Continue button was found.",
        candidateCount: found.candidateCount,
        blockedFinalSubmitLabels: found.blockedFinalSubmitLabels,
        disabledFooterCandidates: found.disabledFooterCandidates || [],
        topCandidates: found.topCandidates || [],
        inputCount: count,
      };
    }

    if (click) {
      dismissOpenWorkdayPopups();
      realisticClick(found.candidate.element);
      fallbackDomClick(found.candidate.element);
      fallbackFocusEnter(found.candidate.element);
      fallbackFocusSpace(found.candidate.element);
    }

    return {
      ok: true,
      found: true,
      clicked: click,
      reason: click
        ? forceWorkdayDomClickFallback
          ? "clicked_safe_next_dom_fallback"
          : forceWorkdayEnterFallback
            ? "clicked_safe_next_enter_fallback"
            : forceWorkdaySpaceFallback
              ? "clicked_safe_next_space_fallback"
              : "clicked_safe_next"
        : "safe_next_available",
      message: click
        ? "Clicked a safe Next or Continue button."
        : "A safe Next or Continue button is available.",
      candidate: publicCandidate(found.candidate),
      topCandidates: found.topCandidates || [publicCandidate(found.candidate)],
      candidateCount: found.candidateCount,
      disabledFooterCandidates: found.disabledFooterCandidates || [],
      blockedFinalSubmitLabels: found.blockedFinalSubmitLabels,
      inputCount: count,
    };
  };
}
