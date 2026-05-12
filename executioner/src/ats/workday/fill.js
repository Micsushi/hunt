// Workday ATS adapter.
// Exports createWorkdayFillFunction() - a factory that returns a self-contained
// async function suitable for chrome.scripting.executeScript func:.
// The returned function must not close over any module-scope variables because
// Chrome serialises it via Function.prototype.toString() before injection.
// All shared logic lives in window.__huntApplyUtils (injected.js).
export function createWorkdayFillFunction() {
  return async function workdayFill({
    profile,
    settings,
    activeApplyContext,
    defaultResume,
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

    var perFieldDelayMs = 25;
    var perUploadDelayMs = 75;
    var sleep = function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    };
    var stripLongDash = settings.stripLongDash !== false;
    var fillRequiredOnly = settings.fillRequiredOnly !== false;

    // Workday uses data-automation-id="formField" as the canonical field container.
    var containerSelectors = [
      "label",
      '[data-automation-id="formField"]',
      '[role="group"]',
    ];
    var getDescriptor = function (el) {
      return u.getDescriptor(el, containerSelectors);
    };
    var descriptorHasAny = function (descriptor, phrases) {
      var desc = u.normalizeText(descriptor).toLowerCase();
      return phrases.some(function (phrase) {
        return desc.includes(phrase);
      });
    };
    var requiredTextFor = function (el, descriptor) {
      return u
        .normalizeText(
          [
            descriptor,
            el?.getAttribute?.("aria-label"),
            el?.getAttribute?.("placeholder"),
            el?.getAttribute?.("data-required"),
            u.getContainerText
              ? u.getContainerText(el, containerSelectors)
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
    };
    var isRequiredField = function (el, descriptor) {
      if (el?.required || el?.getAttribute?.("aria-required") === "true") {
        return true;
      }
      var dataRequired = u
        .normalizeText(el?.getAttribute?.("data-required") || "")
        .toLowerCase();
      if (
        dataRequired === "true" ||
        dataRequired === "required" ||
        dataRequired === "yes"
      ) {
        return true;
      }
      return requiredTextFor(el, descriptor).includes("*");
    };
    var isExactCityField = function (el, descriptor) {
      var key = u
        .normalizeText(
          [el?.name, el?.id, el?.getAttribute?.("aria-label")]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      var desc = u.normalizeText(descriptor).toLowerCase();
      return (
        key === "city" ||
        key.endsWith("--city") ||
        key.includes(" address--city") ||
        (desc.includes("city*") && !desc.includes("postal code"))
      );
    };
    var isExactProvinceField = function (el, descriptor) {
      var key = u
        .normalizeText(
          [el?.name, el?.id, el?.getAttribute?.("aria-label")]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      var desc = u.normalizeText(descriptor).toLowerCase();
      return (
        key.includes("province") ||
        key.includes("territory") ||
        desc.includes("province or territory")
      );
    };
    var shouldSkipProfileFill = function (el, descriptor) {
      var key = u
        .normalizeText(
          [el?.name, el?.id, el?.getAttribute?.("aria-label")]
            .filter(Boolean)
            .join(" "),
        )
        .toLowerCase();
      if (
        key.includes("addressline") ||
        key.includes("address line") ||
        key.includes("postalcode") ||
        key.includes("postal code") ||
        key.includes("zip") ||
        key === "extension" ||
        key.endsWith("--extension") ||
        key.includes("phone extension")
      ) {
        return true;
      }
      if (
        isExactCityField(el, descriptor) ||
        isExactProvinceField(el, descriptor)
      ) {
        return false;
      }
      return descriptorHasAny(descriptor, [
        "address line",
        "addressline",
        "postal code",
        "postalcode",
        "zip code",
        "work experience",
        "job title",
        "company",
        "role description",
        "education",
        "school or university",
        "degree",
        "field of study",
        "overall result",
        "gpa",
      ]);
    };
    var shouldSkipGeneratedAnswer = function (descriptor) {
      return descriptorHasAny(descriptor, [
        "work experience",
        "role description",
        "education",
        "school or university",
        "cover letter",
        "if yes",
        "referral",
        "referred",
        "employee who referred",
        "known this person",
      ]);
    };
    var isResumeFileInput = function (descriptor) {
      if (descriptorHasAny(descriptor, ["cover letter"])) {
        return false;
      }
      return (
        descriptorHasAny(descriptor, ["resume", "cv", "curriculum vitae"]) ||
        (pageLooksLikeResumeUpload() &&
          descriptorHasAny(descriptor, [
            "drop file",
            "select file",
            "upload",
            "file-upload",
          ]))
      );
    };
    var getApplicationSource = function () {
      var explicitSource = u.normalizeText(activeApplyContext.source);
      if (explicitSource) {
        return explicitSource;
      }
      var url = new URL(window.location.href);
      var source = u.normalizeText(url.searchParams.get("source"));
      if (source) {
        return source;
      }
      var src = u.normalizeText(url.searchParams.get("src"));
      if (src) {
        return src;
      }
      return "";
    };
    var profileWithContext = Object.assign({}, profile, {
      applicationSource: getApplicationSource(),
    });

    var filledFields = [];
    var generatedAnswers = [];
    var manualReviewReasons = [];
    var fieldInventory = [];
    var interactionTrace = [];
    var traceTruncated = false;
    var resumeUploadDone = false;
    var pushManualReviewReason = function (reason) {
      if (reason && !manualReviewReasons.includes(reason)) {
        manualReviewReasons.push(reason);
      }
    };
    var finalizeRequiredFieldReview = function () {
      fieldInventory.forEach(function (entry) {
        if (
          !entry.required ||
          entry.filled ||
          entry.skippedReason === "not_required"
        ) {
          return;
        }
        pushManualReviewReason(
          "required_field_unresolved:" + (entry.skippedReason || "not_filled"),
        );
      });
    };
    var rectSummary = function (rect) {
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    var inventoryEntry = function (candidate, descriptor, extra) {
      var el =
        candidate.kind === "radioGroup"
          ? candidate.radios[0]
          : candidate.element;
      return Object.assign(
        {
          kind: candidate.kind,
          tagName: el?.tagName || "",
          type: el?.type || "",
          name: el?.name || "",
          id: el?.id || "",
          descriptor: descriptor || "",
          questionHash: u.buildQuestionHash(descriptor || ""),
          required: Boolean(isRequiredField(el, descriptor)),
          filled: false,
          skippedReason: "",
          valueSource: "",
          options: [],
          rect: rectSummary(candidate.rect),
        },
        extra || {},
      );
    };
    var elementTraceSummary = function (target) {
      if (!target || !target.getBoundingClientRect) {
        return {
          tagName: "",
          type: "",
          id: "",
          name: "",
          text: "",
          ariaLabel: "",
          rect: { top: 0, left: 0, width: 0, height: 0 },
        };
      }
      var rect = target.getBoundingClientRect();
      return {
        tagName: target.tagName || "",
        type: target.type || "",
        id: target.id || "",
        name: target.name || "",
        text: u
          .normalizeText(target.innerText || target.textContent || "")
          .slice(0, 160),
        ariaLabel: u
          .normalizeText(target.getAttribute?.("aria-label") || "")
          .slice(0, 160),
        rect: rectSummary(rect),
      };
    };
    var traceInteraction = function (action, target, detail) {
      if (interactionTrace.length >= 250) {
        traceTruncated = true;
        return;
      }
      interactionTrace.push(
        Object.assign(
          {
            index: interactionTrace.length + 1,
            action: action,
            target: elementTraceSummary(target),
          },
          detail || {},
        ),
      );
    };
    var previousTraceInteraction = u.traceInteraction;
    u.traceInteraction = traceInteraction;
    try {
      var hasResumeData = Boolean(
        activeApplyContext.selectedResumeDataUrl || defaultResume.pdfDataUrl,
      );
      var pageLooksLikeResumeUpload = function () {
        var text = u
          .normalizeText(document.body ? document.body.innerText : "")
          .toLowerCase();
        return (
          text.includes("resume") ||
          text.includes("cv") ||
          text.includes("drop file") ||
          text.includes("select file") ||
          text.includes("upload")
        );
      };
      var keyDetails = function (keyName) {
        var map = {
          Backspace: { code: "Backspace", keyCode: 8 },
          Delete: { code: "Delete", keyCode: 46 },
          Enter: { code: "Enter", keyCode: 13 },
          Escape: { code: "Escape", keyCode: 27 },
        };
        return map[keyName] || { code: keyName, keyCode: 0 };
      };
      var keyOn = function (target, keyName, reason) {
        if (!target || typeof target.dispatchEvent !== "function") {
          return;
        }
        traceInteraction("key", target, { key: keyName, reason: reason || "" });
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
      var realisticClick = function (target, reason) {
        if (!target) {
          return;
        }
        if (typeof target.scrollIntoView === "function") {
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        var rect = target.getBoundingClientRect();
        traceInteraction("hover", target, { reason: reason || "" });
        traceInteraction("click", target, { reason: reason || "" });
        [
          "mouseover",
          "mousemove",
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ].forEach(function (type) {
          pointerEvent(target, type, rect);
        });
      };
      var closeOpenMenus = async function () {
        keyOn(document.activeElement, "Escape", "close_open_menus");
        keyOn(document.body, "Escape", "close_open_menus");
        keyOn(document, "Escape", "close_open_menus");
        keyOn(window, "Escape", "close_open_menus");
        Array.from(
          document.querySelectorAll('[aria-expanded="true"], [role="listbox"]'),
        ).forEach(function (el) {
          keyOn(el, "Escape", "close_open_menus");
          if (el.hasAttribute && el.hasAttribute("aria-expanded")) {
            el.setAttribute("aria-expanded", "false");
          }
          if (el.getAttribute && el.getAttribute("role") === "listbox") {
            el.setAttribute("aria-hidden", "true");
            el.hidden = true;
            el.style.display = "none";
            el.style.visibility = "hidden";
            el.style.pointerEvents = "none";
          }
          if (typeof el.blur === "function") {
            el.blur();
          }
        });
        if (
          document.activeElement &&
          typeof document.activeElement.blur === "function"
        ) {
          document.activeElement.blur();
        }
        var outside = document.body || document.documentElement;
        if (outside) {
          ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(
            function (type) {
              outside.dispatchEvent(
                new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  clientX: 4,
                  clientY: 4,
                }),
              );
            },
          );
        }
        await sleep(80);
      };
      var visibleOptionCandidates = function () {
        return Array.from(document.querySelectorAll('[role="option"]')).filter(
          function (option) {
            var style = window.getComputedStyle(option);
            var rect = option.getBoundingClientRect();
            return (
              option.getAttribute("aria-disabled") !== "true" &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          },
        );
      };
      var isPlaceholderText = function (value) {
        var text = u.normalizeText(value).toLowerCase();
        return !text || text === "select one" || text === "select...";
      };
      var optionScore = function (text, value, choice) {
        return u.optionScoreForChoice
          ? u.optionScoreForChoice(text, value || "", choice, stripLongDash)
          : 0;
      };
      var getButtonValueText = function (button) {
        return u.normalizeText(
          button.innerText ||
            button.textContent ||
            button.getAttribute("value"),
          stripLongDash,
        );
      };
      var buttonValueMatchesChoice = function (button, choice) {
        var current = getButtonValueText(button);
        return (
          !isPlaceholderText(current) && optionScore(current, "", choice) > 0
        );
      };
      var forceSetWorkdayButtonChoice = function (button, option, choice) {
        var label =
          u.normalizeText(
            option?.innerText || option?.textContent || choice?.text || "",
            stripLongDash,
          ) || choice?.text;
        if (!label) {
          return false;
        }
        var value =
          option?.getAttribute?.("data-value") ||
          option?.getAttribute?.("value") ||
          option?.id ||
          "";
        button.value = value;
        if (value) {
          button.setAttribute("value", value);
        }
        var aria = button.getAttribute("aria-label") || "";
        if (aria) {
          var current = getButtonValueText(button);
          button.setAttribute(
            "aria-label",
            u.normalizeText(
              current ? aria.replace(current, label) : aria + " " + label,
              stripLongDash,
            ),
          );
        }
        button.textContent = label;
        u.dispatchInputEvents(button);
        return buttonValueMatchesChoice(button, choice);
      };
      var clearWorkdayButtonSelection = async function (button) {
        await closeOpenMenus();
        realisticClick(button, "clear_existing_workday_button");
        await sleep(250);
        var placeholder = visibleOptionCandidates().find(function (option) {
          return isPlaceholderText(
            option.innerText || option.textContent || "",
          );
        });
        if (!placeholder) {
          await closeOpenMenus();
          return false;
        }
        realisticClick(placeholder, "select_placeholder_to_clear");
        for (var attempt = 0; attempt < 6; attempt++) {
          await sleep(120);
          if (isPlaceholderText(getButtonValueText(button))) {
            await closeOpenMenus();
            return true;
          }
        }
        await closeOpenMenus();
        return false;
      };
      var fillWorkdayButtonDropdown = async function (button, descriptor) {
        var choice = u.chooseStructuredChoice
          ? u.chooseStructuredChoice(
              descriptor,
              profileWithContext,
              stripLongDash,
            )
          : null;
        if (!choice) {
          return { filled: false, reason: "no_known_choice" };
        }
        var current = getButtonValueText(button);
        if (buttonValueMatchesChoice(button, choice)) {
          traceInteraction("already_filled", button, {
            reason: "workday_button_matches_choice",
            currentValue: current,
            intendedValue: choice.text || "",
          });
          return {
            filled: false,
            reason: "already_filled",
            valueSource: choice.source || "existing_value",
          };
        }
        var clearFailed = false;
        if (!isPlaceholderText(current)) {
          clearFailed = !(await clearWorkdayButtonSelection(button));
          if (clearFailed) {
            traceInteraction("clear_failed", button, {
              reason: "clear_existing_workday_button_failed",
              currentValue: current,
              intendedValue: choice.text || "",
            });
          }
        }
        await closeOpenMenus();
        realisticClick(button, "open_workday_button_dropdown");
        await sleep(250);
        var scored = visibleOptionCandidates()
          .map(function (option) {
            var optionText = u.normalizeText(
              option.innerText || option.textContent || "",
              stripLongDash,
            );
            return {
              option: option,
              score: optionScore(optionText, "", choice),
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          });
        var best = scored[0]?.option || null;
        if (!best) {
          await closeOpenMenus();
          return {
            filled: false,
            reason: clearFailed
              ? "clear_failed_no_matching_option"
              : "no_matching_option",
          };
        }
        realisticClick(best, "select_workday_button_option");
        await sleep(250);
        u.dispatchInputEvents(button);
        var committed = "";
        var committedScore = 0;
        for (var verifyAttempt = 0; verifyAttempt < 20; verifyAttempt++) {
          committed = u.normalizeText(
            button.innerText ||
              button.textContent ||
              button.getAttribute("value"),
            stripLongDash,
          );
          committedScore = optionScore(committed, "", choice);
          if (committedScore > 0) {
            break;
          }
          await sleep(150);
        }
        if (committedScore <= 0) {
          best.focus();
          keyOn(best, "Enter", "fallback_select_workday_button_option");
          for (var enterAttempt = 0; enterAttempt < 10; enterAttempt++) {
            await sleep(150);
            committed = u.normalizeText(
              button.innerText ||
                button.textContent ||
                button.getAttribute("value"),
              stripLongDash,
            );
            committedScore = optionScore(committed, "", choice);
            if (committedScore > 0) {
              break;
            }
          }
        }
        await closeOpenMenus();
        if (committedScore > 0) {
          return { filled: true, valueSource: choice.source || "button_rule" };
        }
        if (forceSetWorkdayButtonChoice(button, best, choice)) {
          traceInteraction("force_commit", button, {
            reason: "workday_button_force_commit_after_click",
            currentValue: getButtonValueText(button),
            intendedValue: choice.text || "",
          });
          return { filled: true, valueSource: choice.source || "button_rule" };
        }
        return {
          filled: false,
          reason: clearFailed
            ? "clear_failed_commit_not_verified"
            : "commit_not_verified",
        };
      };
      var isCountryDependencyButton = function (button, descriptor) {
        var key = u
          .normalizeText(
            [button?.name, button?.id, button?.getAttribute?.("aria-label")]
              .filter(Boolean)
              .join(" "),
          )
          .toLowerCase();
        return (
          descriptorHasAny(descriptor, ["country"]) &&
          !descriptorHasAny(descriptor, ["phone"]) &&
          (key.includes("country--country") ||
            key === "country" ||
            descriptorHasAny(descriptor, ["country select one", "country*"]))
        );
      };
      var isPhoneCountryCodeField = function (el, descriptor) {
        var key = u
          .normalizeText(
            [
              el?.name,
              el?.id,
              el?.getAttribute?.("aria-label"),
              el?.getAttribute?.("data-automation-id"),
            ]
              .filter(Boolean)
              .join(" "),
          )
          .toLowerCase();
        return (
          key.includes("countryphonecode") || key.includes("country phone code")
        );
      };
      var waitForCountryDependentFields = async function () {
        for (var attempt = 0; attempt < 10; attempt++) {
          if (
            document.getElementById("name--legalName--firstName") ||
            document.getElementById("address--city") ||
            document.getElementById("phoneNumber--phoneNumber")
          ) {
            return;
          }
          await sleep(400);
        }
      };
      var waitForInitialWorkdayHydration = async function () {
        for (var attempt = 0; attempt < 20; attempt++) {
          var visibleStepHeadings = Array.from(
            document.querySelectorAll('h1,h2,[role="heading"]'),
          )
            .filter(function (heading) {
              return visibleElement(heading);
            })
            .map(function (heading) {
              return textOf(heading);
            })
            .filter(Boolean);
          var onOtherApplicationStep = visibleStepHeadings.some(
            function (heading) {
              return [
                "My Experience",
                "Application Questions",
                "Voluntary Disclosures",
                "Review",
              ].includes(heading);
            },
          );
          var onMyInformationStep =
            visibleStepHeadings.includes("My Information") &&
            !onOtherApplicationStep;
          if (!visibleStepHeadings.length) {
            var text = u.normalizeText(
              document.body ? document.body.innerText : "",
            );
            onMyInformationStep =
              text.includes("My Information") &&
              !text.includes("My Experience");
          }
          var dependentFieldsReady = Boolean(
            document.getElementById("name--legalName--firstName") ||
            document.getElementById("address--city") ||
            document.getElementById("phoneNumber--phoneNumber"),
          );
          if (!onMyInformationStep || dependentFieldsReady) {
            return;
          }
          await sleep(500);
        }
      };
      var fillPhoneCountryCode = async function (input, descriptor) {
        var multiSelectId = input.getAttribute("data-uxi-multiselect-id") || "";
        var container =
          (multiSelectId ? document.getElementById(multiSelectId) : null) ||
          input.closest(
            [
              '[data-automation-id="multiSelectContainer"]',
              '[data-automation-id="multiselectInputContainer"]',
              '[data-uxi-widget-type="multiselect"]',
              '[data-automation-id="formField"]',
            ].join(", "),
          );
        var getSelectedText = function () {
          var selected = container
            ? Array.from(
                container.querySelectorAll(
                  [
                    '[data-automation-id="selectedItem"]',
                    '[role="option"][aria-selected="true"]',
                    '[id^="pill-"]',
                    '[aria-label*="press delete to clear value"]',
                  ].join(", "),
                ),
              )
            : [];
          return u.normalizeText(
            selected
              .map(function (item) {
                return [
                  item.getAttribute?.("aria-label"),
                  item.innerText,
                  item.textContent,
                ]
                  .filter(Boolean)
                  .join(" ");
              })
              .join(" "),
          );
        };
        var countryCodeState = function () {
          var selectedText = getSelectedText().toLowerCase();
          var containerText = u
            .normalizeText(
              container
                ? [
                    container.innerText,
                    container.textContent,
                    Array.from(container.querySelectorAll("[aria-label]"))
                      .map(function (node) {
                        return node.getAttribute("aria-label") || "";
                      })
                      .join(" "),
                  ]
                    .filter(Boolean)
                    .join(" ")
                : "",
            )
            .toLowerCase();
          var inputText = u.normalizeText(input.value || "").toLowerCase();
          var matched =
            (selectedText.includes("canada") && selectedText.includes("+1")) ||
            (containerText.includes("1 item selected") &&
              containerText.includes("canada") &&
              (containerText.includes("+1") ||
                containerText.includes("(+1)"))) ||
            (inputText === "canada" &&
              containerText.includes("canada") &&
              (containerText.includes("+1") || containerText.includes("(+1)")));
          return {
            selectedText: selectedText,
            containerText: containerText,
            inputText: inputText,
            matched: matched,
          };
        };
        var countryCodeLooksCorrect = function () {
          return countryCodeState().matched;
        };
        var countryCodeHasSelection = function () {
          return Boolean(
            getSelectedText() || u.normalizeText(input.value || ""),
          );
        };
        var clearCountryCodeSelection = async function () {
          if (!container) {
            return false;
          }
          var clearControls = Array.from(
            container.querySelectorAll(
              'button, [role="button"], [aria-label], [data-automation-id]',
            ),
          ).filter(function (candidate) {
            var text = u
              .normalizeText(
                [
                  candidate.getAttribute("aria-label"),
                  candidate.getAttribute("data-automation-id"),
                  candidate.innerText,
                  candidate.textContent,
                ]
                  .filter(Boolean)
                  .join(" "),
              )
              .toLowerCase();
            return (
              text.includes("remove") ||
              text.includes("delete") ||
              text.includes("clear")
            );
          });
          clearControls.forEach(function (candidate) {
            realisticClick(candidate, "clear_phone_country_code_selection");
          });
          input.focus();
          keyOn(input, "Backspace", "clear_phone_country_code_selection");
          keyOn(input, "Delete", "clear_phone_country_code_selection");
          u.dispatchInputEvents(input);
          await sleep(200);
          return !countryCodeHasSelection();
        };
        var precheck = countryCodeState();
        traceInteraction("inspect", input, {
          reason: "phone_country_code_precheck",
          currentValue:
            "input=" +
            precheck.inputText +
            "; selected=" +
            precheck.selectedText.slice(0, 80) +
            "; container=" +
            precheck.containerText.slice(0, 120) +
            "; matched=" +
            String(precheck.matched),
          intendedValue: "Canada (+1)",
        });
        if (precheck.matched) {
          traceInteraction("already_filled", input, {
            reason: "phone_country_code_matches_choice",
            currentValue: getSelectedText(),
            intendedValue: "Canada (+1)",
          });
          return {
            filled: false,
            reason: "already_filled",
            valueSource: "profile:location",
          };
        }
        if (countryCodeHasSelection()) {
          await clearCountryCodeSelection();
        }
        realisticClick(input, "open_phone_country_code_picker");
        await sleep(120);
        u.setElementValue(input, "Canada", stripLongDash);
        await sleep(350);
        var scorePhoneCountryOptions = function () {
          return visibleOptionCandidates()
            .map(function (option) {
              var optionText = u.normalizeText(
                option.innerText || option.textContent || "",
                stripLongDash,
              );
              var loweredOption = optionText.toLowerCase();
              var score = 0;
              if (loweredOption.includes("canada")) {
                score += 100;
              }
              if (loweredOption.includes("+1")) {
                score += 20;
              }
              return { option: option, score: score };
            })
            .filter(function (candidate) {
              return candidate.score > 0;
            })
            .sort(function (a, b) {
              return b.score - a.score;
            });
        };
        var scored = scorePhoneCountryOptions();
        var listbox = document.querySelector('[role="listbox"]');
        for (
          var scrollAttempt = 0;
          !scored.length && listbox && scrollAttempt < 80;
          scrollAttempt++
        ) {
          listbox.scrollTop += 260;
          listbox.dispatchEvent(new Event("scroll", { bubbles: true }));
          await sleep(50);
          scored = scorePhoneCountryOptions();
        }
        var best = scored[0]?.option || null;
        if (!best) {
          await closeOpenMenus();
          return { filled: false, reason: "no_matching_country_code" };
        }
        realisticClick(best, "select_phone_country_code_option");
        await sleep(250);
        u.dispatchInputEvents(input);
        await closeOpenMenus();
        return { filled: true, valueSource: "profile:location" };
      };
      var primeCountryDependentFields = async function () {
        var buttons = u.getVisibleElements('button[aria-haspopup="listbox"]');
        for (var idx = 0; idx < buttons.length; idx++) {
          var button = buttons[idx];
          var descriptor = getDescriptor(button);
          if (!isCountryDependencyButton(button, descriptor)) {
            continue;
          }
          var choice = u.chooseStructuredChoice
            ? u.chooseStructuredChoice(
                descriptor,
                profileWithContext,
                stripLongDash,
              )
            : null;
          if (choice && buttonValueMatchesChoice(button, choice)) {
            await waitForCountryDependentFields();
            continue;
          }
          var result = await fillWorkdayButtonDropdown(button, descriptor);
          if (!result.filled) {
            for (var commitAttempt = 0; commitAttempt < 16; commitAttempt++) {
              var committed = u
                .normalizeText(button.innerText || button.textContent || "")
                .toLowerCase();
              if (committed && committed !== "select one") {
                result = {
                  filled: true,
                  valueSource: result.valueSource || "profile:location",
                };
                break;
              }
              await sleep(250);
            }
          }
          if (result.filled) {
            filledFields.push({
              field: descriptor,
              valueSource: result.valueSource || "button_rule",
            });
            await waitForCountryDependentFields();
          }
        }
      };
      var shouldCheckRequiredCheckbox = function (checkbox, descriptor) {
        var required = isRequiredField(checkbox, descriptor);
        if (!required) {
          return false;
        }
        if (
          descriptorHasAny(descriptor, [
            "preferred name",
            "current address",
            "former employer",
          ])
        ) {
          return false;
        }
        return descriptorHasAny(descriptor, [
          "terms and conditions",
          "terms of use",
          "consent",
          "i have read",
          "agree",
          "agreement",
        ]);
      };
      var setCheckboxChecked = async function (checkbox) {
        if (checkbox.checked) {
          return true;
        }
        realisticClick(checkbox, "check_required_terms_checkbox");
        await sleep(80);
        if (!checkbox.checked) {
          var setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "checked",
          )?.set;
          if (setter) {
            setter.call(checkbox, true);
          } else {
            checkbox.checked = true;
          }
          u.dispatchInputEvents(checkbox);
          await sleep(80);
        }
        return checkbox.checked;
      };
      var normalizeProfileList = function (value) {
        var rawItems = Array.isArray(value)
          ? value
          : String(value || "").split(/[\n,;]+/);
        var seen = new Set();
        return rawItems
          .map(function (item) {
            return u.normalizeText(item, stripLongDash);
          })
          .filter(function (item) {
            var key = item.toLowerCase();
            if (!key || seen.has(key)) {
              return false;
            }
            seen.add(key);
            return true;
          });
      };
      var visibleElement = function (el) {
        if (!el || !el.getBoundingClientRect) {
          return false;
        }
        var style = window.getComputedStyle(el);
        var rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          !el.disabled &&
          el.getAttribute("aria-hidden") !== "true"
        );
      };
      var visibleWithin = function (root, selector) {
        return Array.from((root || document).querySelectorAll(selector)).filter(
          visibleElement,
        );
      };
      var textOf = function (el) {
        return u.normalizeText(
          el ? el.innerText || el.textContent || "" : "",
          stripLongDash,
        );
      };
      var workdayButtonLabel = function (button) {
        return u
          .normalizeText(
            [
              textOf(button),
              button?.getAttribute?.("aria-label"),
              button?.getAttribute?.("title"),
              button?.getAttribute?.("data-automation-id"),
            ]
              .filter(Boolean)
              .join(" "),
            stripLongDash,
          )
          .toLowerCase();
      };
      var isWorkdayAddButtonLabel = function (button, sectionName) {
        var label = workdayButtonLabel(button);
        var section = u.normalizeText(sectionName, stripLongDash).toLowerCase();
        return (
          label === "add" ||
          label === "add another" ||
          label.includes("add " + section) ||
          label.includes("add another " + section)
        );
      };
      var elementIsEmpty = function (el) {
        if (!el) {
          return true;
        }
        if (el.tagName === "SELECT") {
          return isPlaceholderText(
            el.options?.[el.selectedIndex]?.text || el.value || "",
          );
        }
        if (el.tagName === "BUTTON") {
          return isPlaceholderText(getButtonValueText(el));
        }
        if (el.isContentEditable || el.getAttribute("role") === "textbox") {
          return !u.normalizeText(el.textContent || "", stripLongDash);
        }
        return !u.normalizeText(el.value || "", stripLongDash);
      };
      var profileWorkExperience = Array.isArray(profile.workExperience)
        ? profile.workExperience
        : [];
      var profileEducation = Array.isArray(profile.education)
        ? profile.education
        : [];
      var profileSkills = normalizeProfileList(profile.skills);
      var profileWebsiteEntries = normalizeProfileList([
        profile.websiteUrl,
        profile.linkedinUrl,
        profile.githubUrl,
      ]);
      var sectionNames = [
        "Work Experience",
        "Education",
        "Languages",
        "Skills",
        "Resume/CV",
        "Websites",
      ];
      var headingCandidates = function () {
        var candidates = Array.from(
          document.querySelectorAll('h1,h2,h3,h4,[role="heading"]'),
        ).filter(visibleElement);
        if (!candidates.length) {
          candidates = Array.from(document.querySelectorAll("body *")).filter(
            function (el) {
              var text = textOf(el);
              return visibleElement(el) && sectionNames.includes(text);
            },
          );
        }
        return candidates
          .map(function (el) {
            return {
              el: el,
              text: textOf(el),
              rect: el.getBoundingClientRect(),
            };
          })
          .filter(function (entry) {
            return sectionNames.includes(entry.text);
          })
          .sort(function (a, b) {
            return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
          });
      };
      var sectionBounds = function (name) {
        var headings = headingCandidates();
        var heading = headings.find(function (entry) {
          return entry.text === name;
        });
        if (!heading) {
          return null;
        }
        var next = headings.find(function (entry) {
          return entry.rect.top > heading.rect.top + 4;
        });
        return {
          top: heading.rect.top,
          bottom: next ? next.rect.top : Number.POSITIVE_INFINITY,
          rect: heading.rect,
        };
      };
      var visibleInSection = function (name, selector) {
        var bounds = sectionBounds(name);
        if (!bounds) {
          return [];
        }
        return visibleWithin(document, selector).filter(function (el) {
          var rect = el.getBoundingClientRect();
          return rect.top >= bounds.top && rect.top < bounds.bottom;
        });
      };
      var sectionFillTargetCount = function (name) {
        return visibleInSection(
          name,
          'input:not([type="hidden"]):not([type="file"]), textarea, select, button[aria-haspopup="listbox"]',
        ).length;
      };
      var waitForSectionFieldCountIncrease = async function (
        name,
        beforeCount,
      ) {
        for (var attempt = 0; attempt < 12; attempt++) {
          if (activeDialog() || sectionFillTargetCount(name) > beforeCount) {
            return;
          }
          await sleep(150);
        }
      };
      var sectionText = function (name) {
        var bounds = sectionBounds(name);
        if (!bounds) {
          return "";
        }
        return u.normalizeText(
          Array.from(document.querySelectorAll("body *"))
            .filter(visibleElement)
            .filter(function (el) {
              var rect = el.getBoundingClientRect();
              return rect.top >= bounds.top && rect.top < bounds.bottom;
            })
            .map(textOf)
            .filter(Boolean)
            .join(" "),
          stripLongDash,
        );
      };
      var baseName = function (value) {
        var text = u.normalizeText(value || "", stripLongDash);
        return text.split(/[\\/]/).filter(Boolean).pop() || text;
      };
      var resumeFileNameCandidates = function () {
        return normalizeProfileList([
          activeApplyContext.selectedResumeName,
          activeApplyContext.selectedResumePath
            ? baseName(activeApplyContext.selectedResumePath)
            : "",
          defaultResume.pdfFileName,
          defaultResume.pdfPath ? baseName(defaultResume.pdfPath) : "",
          defaultResume.label,
        ]);
      };
      var hasExistingResumeUpload = function () {
        var text = (
          sectionText("Resume/CV") ||
          u.normalizeText(
            document.body ? document.body.innerText : "",
            stripLongDash,
          )
        ).toLowerCase();
        if (
          !text ||
          !(
            text.includes("successfully uploaded") ||
            text.includes("uploaded") ||
            text.includes(".pdf")
          )
        ) {
          return false;
        }
        var names = resumeFileNameCandidates();
        if (!names.length) {
          return text.includes(".pdf") && text.includes("uploaded");
        }
        return (
          names.some(function (name) {
            return text.includes(name.toLowerCase());
          }) ||
          (text.includes(".pdf") && text.includes("uploaded"))
        );
      };
      var sectionHasValues = function (name, values) {
        var text = sectionText(name).toLowerCase();
        return values
          .map(function (value) {
            return u.normalizeText(value, stripLongDash).toLowerCase();
          })
          .filter(Boolean)
          .every(function (value) {
            return text.includes(value);
          });
      };
      var findSectionAddButton = function (name) {
        var bounds = sectionBounds(name);
        if (!bounds) {
          return null;
        }
        return visibleWithin(document, 'button, [role="button"], a, [tabindex]')
          .filter(function (button) {
            var rect = button.getBoundingClientRect();
            return (
              isWorkdayAddButtonLabel(button, name) &&
              rect.top >= bounds.top &&
              rect.top < bounds.bottom
            );
          })
          .sort(function (a, b) {
            return (
              a.getBoundingClientRect().top - b.getBoundingClientRect().top ||
              a.getBoundingClientRect().left - b.getBoundingClientRect().left
            );
          })[0];
      };
      var sectionInventory = function (section, filled, reason, valueSource) {
        var bounds = sectionBounds(section) || {
          rect: { top: 0, left: 0, width: 0, height: 0 },
        };
        fieldInventory.push({
          kind: "workdaySection",
          tagName: "SECTION",
          type: "",
          name: section,
          id: "",
          descriptor: section.toLowerCase(),
          questionHash: u.buildQuestionHash(section),
          required: false,
          filled: Boolean(filled),
          skippedReason: reason || "",
          valueSource: valueSource || "",
          options: [],
          rect: rectSummary(bounds.rect),
        });
      };
      var activeDialog = function () {
        var dialogs = visibleWithin(document, '[role="dialog"]').sort(
          function (a, b) {
            return (
              b.getBoundingClientRect().width *
                b.getBoundingClientRect().height -
              a.getBoundingClientRect().width * a.getBoundingClientRect().height
            );
          },
        );
        return dialogs[0] || null;
      };
      var waitForActiveDialog = async function () {
        for (var attempt = 0; attempt < 12; attempt++) {
          var dialog = activeDialog();
          if (dialog) {
            return dialog;
          }
          await sleep(150);
        }
        return null;
      };
      var findActionButton = function (root, labels) {
        var wanted = labels.map(function (label) {
          return label.toLowerCase();
        });
        return visibleWithin(root || document, "button")
          .filter(function (button) {
            return wanted.includes(textOf(button).toLowerCase());
          })
          .filter(function (button) {
            return button.getAttribute("aria-disabled") !== "true";
          })[0];
      };
      var choiceFromText = function (text, source) {
        var normalized = u.normalizeText(text, stripLongDash);
        if (!normalized) {
          return null;
        }
        return {
          text: normalized,
          source: source,
          aliases: [normalized],
          requireOptionMatch: true,
        };
      };
      var fillSelectWithChoice = function (select, value, source) {
        var choice = choiceFromText(value, source);
        if (!choice) {
          return false;
        }
        var selected = Array.from(select.options || [])
          .map(function (option) {
            return {
              option: option,
              score: optionScore(option.text, option.value, choice),
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          })[0]?.option;
        if (!selected) {
          return false;
        }
        select.value = selected.value;
        u.dispatchInputEvents(select);
        return true;
      };
      var fillWorkdayButtonDropdownWithChoice = async function (
        button,
        value,
        source,
      ) {
        var choice = choiceFromText(value, source);
        if (!choice) {
          return { filled: false, reason: "empty_choice" };
        }
        if (buttonValueMatchesChoice(button, choice)) {
          return {
            filled: false,
            reason: "already_filled",
            valueSource: source || "existing_value",
          };
        }
        await closeOpenMenus();
        realisticClick(button, "open_workday_entry_dropdown");
        await sleep(250);
        var best = visibleOptionCandidates()
          .map(function (option) {
            return {
              option: option,
              score: optionScore(textOf(option), "", choice),
            };
          })
          .filter(function (candidate) {
            return candidate.score > 0;
          })
          .sort(function (a, b) {
            return b.score - a.score;
          })[0]?.option;
        if (!best) {
          await closeOpenMenus();
          return { filled: false, reason: "no_matching_option" };
        }
        realisticClick(best, "select_workday_entry_dropdown_option");
        for (var attempt = 0; attempt < 10; attempt++) {
          await sleep(150);
          if (buttonValueMatchesChoice(button, choice)) {
            await closeOpenMenus();
            return { filled: true, valueSource: source };
          }
        }
        await closeOpenMenus();
        return { filled: false, reason: "commit_not_verified" };
      };
      var monthYearValue = function (entry, prefix, descriptor) {
        var month = u.normalizeText(entry[prefix + "Month"], stripLongDash);
        var year = u.normalizeText(entry[prefix + "Year"], stripLongDash);
        if (descriptor.includes("month")) {
          return month;
        }
        if (descriptor.includes("year")) {
          return year;
        }
        if (descriptor.includes("date")) {
          return [month, year].filter(Boolean).join(" ");
        }
        return "";
      };
      var workExperienceValue = function (descriptor, entry) {
        var desc = u.normalizeText(descriptor).toLowerCase();
        if (
          desc.includes("job title") ||
          desc.includes("position title") ||
          desc.includes("business title")
        ) {
          return entry.jobTitle;
        }
        if (desc.includes("company") || desc.includes("employer")) {
          return entry.company;
        }
        if (desc.includes("location") || desc.includes("city")) {
          return entry.location;
        }
        if (
          desc.includes("role description") ||
          desc.includes("description") ||
          desc.includes("responsibilities")
        ) {
          return entry.description;
        }
        if (desc.includes("start") || desc.includes("from")) {
          return monthYearValue(entry, "start", desc);
        }
        if (!entry.current && (desc.includes("end") || desc.includes("to"))) {
          return monthYearValue(entry, "end", desc);
        }
        return "";
      };
      var educationValue = function (descriptor, entry) {
        var desc = u.normalizeText(descriptor).toLowerCase();
        if (
          desc.includes("school") ||
          desc.includes("university") ||
          desc.includes("institution")
        ) {
          return entry.school;
        }
        if (desc.includes("degree")) {
          return entry.degree;
        }
        if (
          desc.includes("field of study") ||
          desc.includes("major") ||
          desc.includes("area of study")
        ) {
          return entry.fieldOfStudy;
        }
        if (
          desc.includes("overall result") ||
          desc.includes("gpa") ||
          desc.includes("grade")
        ) {
          return entry.overallResult;
        }
        if (desc.includes("start") || desc.includes("from")) {
          return monthYearValue(entry, "start", desc);
        }
        if (desc.includes("end") || desc.includes("to")) {
          return monthYearValue(entry, "end", desc);
        }
        return "";
      };
      var fillEntryDialog = async function (entry, kind, section) {
        var root = await waitForActiveDialog();
        var valueFor =
          kind === "work"
            ? function (descriptor) {
                return workExperienceValue(descriptor, entry);
              }
            : function (descriptor) {
                return educationValue(descriptor, entry);
              };
        var sourcePrefix =
          kind === "work" ? "profile:workExperience" : "profile:education";
        var filledCount = 0;

        var fieldSelector =
          'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea';
        var fields = root
          ? visibleWithin(root, fieldSelector)
          : visibleInSection(section, fieldSelector);
        if (!root) {
          fields = fields.filter(elementIsEmpty);
        }
        for (var idx = 0; idx < fields.length; idx++) {
          var field = fields[idx];
          var descriptor = getDescriptor(field);
          var value = valueFor(descriptor);
          if (value && u.setElementValue(field, value, stripLongDash)) {
            filledCount += 1;
          }
        }

        var selects = root
          ? visibleWithin(root, "select")
          : visibleInSection(section, "select").filter(elementIsEmpty);
        for (var selectIdx = 0; selectIdx < selects.length; selectIdx++) {
          var select = selects[selectIdx];
          var selectValue = valueFor(getDescriptor(select));
          if (fillSelectWithChoice(select, selectValue, sourcePrefix)) {
            filledCount += 1;
          }
        }

        var listboxButtons = root
          ? visibleWithin(root, 'button[aria-haspopup="listbox"]')
          : visibleInSection(section, 'button[aria-haspopup="listbox"]').filter(
              elementIsEmpty,
            );
        for (
          var buttonIdx = 0;
          buttonIdx < listboxButtons.length;
          buttonIdx++
        ) {
          var listboxButton = listboxButtons[buttonIdx];
          var buttonValue = valueFor(getDescriptor(listboxButton));
          var buttonResult = await fillWorkdayButtonDropdownWithChoice(
            listboxButton,
            buttonValue,
            sourcePrefix,
          );
          if (buttonResult.filled) {
            filledCount += 1;
          }
        }

        if (kind === "work" && entry.current) {
          var checkboxes = root
            ? visibleWithin(root, 'input[type="checkbox"]')
            : visibleInSection(section, 'input[type="checkbox"]');
          for (
            var checkboxIdx = 0;
            checkboxIdx < checkboxes.length;
            checkboxIdx++
          ) {
            var checkbox = checkboxes[checkboxIdx];
            var desc = getDescriptor(checkbox);
            if (desc.includes("current")) {
              if (await setCheckboxChecked(checkbox)) {
                filledCount += 1;
              }
            }
          }
        }

        var saveButton =
          (root
            ? findActionButton(root, ["Save", "Done", "OK"])
            : findActionButton(document, ["Save", "Done", "OK"])) ||
          findActionButton(document, ["Save", "Done", "OK"]);
        if (saveButton) {
          realisticClick(saveButton, "save_workday_entry_dialog");
          await sleep(600);
        }
        return {
          filled: filledCount > 0,
          saved: Boolean(saveButton),
          filledCount: filledCount,
        };
      };
      var addStructuredEntries = async function (
        section,
        entries,
        kind,
        minimumValues,
        duplicateValues,
      ) {
        if (!entries.length) {
          if (sectionBounds(section)) {
            sectionInventory(section, false, "missing_profile_entries", "");
          }
          return;
        }
        for (var idx = 0; idx < entries.length; idx++) {
          var entry = entries[idx] || {};
          var requiredValues = minimumValues(entry).filter(Boolean);
          if (!requiredValues.length) {
            sectionInventory(section, false, "missing_profile_fact", "");
            pushManualReviewReason(
              section.toLowerCase().replace(/\s+/g, "_") +
                ":missing_profile_fact",
            );
            continue;
          }
          if (sectionHasValues(section, duplicateValues(entry))) {
            sectionInventory(section, false, "already_filled", "");
            continue;
          }
          var addButton = findSectionAddButton(section);
          if (!addButton) {
            sectionInventory(section, false, "add_button_not_found", "");
            pushManualReviewReason(
              section.toLowerCase().replace(/\s+/g, "_") +
                ":add_button_not_found",
            );
            return;
          }
          var beforeFieldCount = sectionFillTargetCount(section);
          realisticClick(addButton, "open_workday_" + kind + "_dialog");
          await waitForSectionFieldCountIncrease(section, beforeFieldCount);
          await sleep(250);
          var result = await fillEntryDialog(entry, kind, section);
          sectionInventory(
            section,
            result.filled,
            result.filled ? "" : "entry_fill_failed",
            kind === "work" ? "profile:workExperience" : "profile:education",
          );
          if (result.filled) {
            filledFields.push({
              field: section + " entry",
              valueSource:
                kind === "work"
                  ? "profile:workExperience"
                  : "profile:education",
            });
            await sleep(400);
          } else {
            pushManualReviewReason(
              section.toLowerCase().replace(/\s+/g, "_") + ":entry_fill_failed",
            );
          }
        }
      };
      var addWorkExperienceEntries = async function () {
        await addStructuredEntries(
          "Work Experience",
          profileWorkExperience,
          "work",
          function (entry) {
            return [entry.jobTitle, entry.company];
          },
          function (entry) {
            return [entry.jobTitle, entry.company];
          },
        );
      };
      var addEducationEntries = async function () {
        await addStructuredEntries(
          "Education",
          profileEducation,
          "education",
          function (entry) {
            return [entry.school];
          },
          function (entry) {
            return [entry.school, entry.degree];
          },
        );
      };
      var fillWorkdaySkills = async function () {
        if (!profileSkills.length) {
          if (sectionBounds("Skills")) {
            sectionInventory("Skills", false, "missing_profile_entries", "");
          }
          return;
        }
        var skillInput = visibleWithin(
          document,
          'input:not([type="hidden"]):not([type="file"])',
        ).find(function (input) {
          return getDescriptor(input).includes("skills");
        });
        if (!skillInput) {
          sectionInventory("Skills", false, "skills_input_not_found", "");
          return;
        }
        var added = 0;
        for (var idx = 0; idx < profileSkills.length; idx++) {
          var skill = profileSkills[idx];
          if (sectionHasValues("Skills", [skill])) {
            continue;
          }
          skillInput.focus();
          u.setElementValue(skillInput, skill, stripLongDash);
          await sleep(350);
          var choice = choiceFromText(skill, "profile:skills");
          var option = visibleOptionCandidates()
            .map(function (candidate) {
              return {
                option: candidate,
                score: optionScore(textOf(candidate), "", choice),
              };
            })
            .filter(function (candidate) {
              return candidate.score > 0;
            })
            .sort(function (a, b) {
              return b.score - a.score;
            })[0]?.option;
          if (option) {
            realisticClick(option, "select_workday_skill_option");
          } else {
            keyOn(skillInput, "Enter", "commit_workday_skill_text");
          }
          await sleep(250);
          await closeOpenMenus();
          if (sectionHasValues("Skills", [skill])) {
            added += 1;
          }
        }
        sectionInventory(
          "Skills",
          added > 0,
          added > 0 ? "" : "skills_not_committed",
          "profile:skills",
        );
        if (added > 0) {
          filledFields.push({
            field: "Skills",
            valueSource: "profile:skills",
          });
        }
      };
      var websiteTypeForUrl = function (url) {
        var lowered = u.normalizeText(url).toLowerCase();
        if (lowered.includes("linkedin.com")) {
          return "LinkedIn";
        }
        if (lowered.includes("github.com")) {
          return "GitHub";
        }
        return "Personal Website";
      };
      var fillWebsiteDialog = async function (url) {
        var root = await waitForActiveDialog();
        var filled = false;
        var inputSelector =
          'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea';
        var inputs = root
          ? visibleWithin(root, inputSelector)
          : visibleInSection("Websites", inputSelector);
        var urlInputs = inputs.filter(function (input) {
          var desc = getDescriptor(input);
          return desc.includes("url") || desc.includes("website");
        });
        var emptyUrlInputs = urlInputs.filter(elementIsEmpty);
        var target =
          emptyUrlInputs[0] ||
          urlInputs.find(function (input) {
            return (
              u
                .normalizeText(
                  input.value || input.textContent || "",
                  stripLongDash,
                )
                .toLowerCase() === url.toLowerCase()
            );
          }) ||
          inputs.filter(elementIsEmpty)[0];
        if (!target) {
          return false;
        }
        var currentValue = u
          .normalizeText(
            target.value || target.textContent || "",
            stripLongDash,
          )
          .toLowerCase();
        if (currentValue === url.toLowerCase()) {
          filled = true;
        } else if (currentValue) {
          return false;
        } else if (u.setElementValue(target, url, stripLongDash)) {
          filled = true;
        }
        var typeButtons = root
          ? visibleWithin(root, 'button[aria-haspopup="listbox"]')
          : visibleInSection("Websites", 'button[aria-haspopup="listbox"]');
        var typeButton = typeButtons
          .filter(elementIsEmpty)
          .find(function (button) {
            var desc = getDescriptor(button);
            return desc.includes("type") || desc.includes("category");
          });
        if (typeButton) {
          await fillWorkdayButtonDropdownWithChoice(
            typeButton,
            websiteTypeForUrl(url),
            "profile:websites",
          );
        }
        var saveButton =
          (root
            ? findActionButton(root, ["Save", "Done", "OK"])
            : findActionButton(document, ["Save", "Done", "OK"])) ||
          findActionButton(document, ["Save", "Done", "OK"]);
        if (saveButton) {
          realisticClick(saveButton, "save_workday_website_dialog");
          await sleep(500);
        }
        return filled;
      };
      var addWebsiteEntries = async function () {
        if (!profileWebsiteEntries.length) {
          if (sectionBounds("Websites")) {
            sectionInventory("Websites", false, "missing_profile_entries", "");
          }
          return;
        }
        var added = 0;
        for (var idx = 0; idx < profileWebsiteEntries.length; idx++) {
          var url = profileWebsiteEntries[idx];
          if (sectionHasValues("Websites", [url])) {
            continue;
          }
          var addButton = findSectionAddButton("Websites");
          if (!addButton) {
            sectionInventory("Websites", false, "add_button_not_found", "");
            return;
          }
          var beforeWebsiteFieldCount = sectionFillTargetCount("Websites");
          realisticClick(addButton, "open_workday_website_dialog");
          await waitForSectionFieldCountIncrease(
            "Websites",
            beforeWebsiteFieldCount,
          );
          await sleep(250);
          if (await fillWebsiteDialog(url)) {
            added += 1;
          }
        }
        sectionInventory(
          "Websites",
          added > 0,
          added > 0 ? "" : "website_fill_failed",
          "profile:websites",
        );
        if (added > 0) {
          filledFields.push({
            field: "Websites",
            valueSource: "profile:websites",
          });
        }
      };
      var processMyExperienceSections = async function () {
        if (!sectionBounds("Work Experience") && !sectionBounds("Websites")) {
          return;
        }
        traceInteraction("inspect", document.body, {
          reason: "workday_my_experience_profile_counts",
          currentValue:
            "work=" +
            String(profileWorkExperience.length) +
            "; education=" +
            String(profileEducation.length) +
            "; skills=" +
            String(profileSkills.length) +
            "; websites=" +
            String(profileWebsiteEntries.length),
        });
        await addWorkExperienceEntries();
        await addEducationEntries();
        await fillWorkdaySkills();
        await addWebsiteEntries();
      };

      var existingResumeUploadDetected = hasExistingResumeUpload();
      if (existingResumeUploadDetected) {
        resumeUploadDone = true;
        traceInteraction("already_filled", document.body, {
          reason: "existing_resume_upload_detected",
          currentValue: resumeFileNameCandidates().join(", "),
          intendedValue: "resume_upload",
        });
      }

      if (
        activeApplyContext.jobId &&
        activeApplyContext.selectedResumeReadyForC3 === false
      ) {
        pushManualReviewReason("resume_not_ready_for_c3");
      }
      if (
        !hasResumeData &&
        !existingResumeUploadDetected &&
        pageLooksLikeResumeUpload()
      ) {
        pushManualReviewReason("resume_upload:missing_resume_data");
      }

      await waitForInitialWorkdayHydration();
      await primeCountryDependentFields();
      await processMyExperienceSections();

      // Collect every visible fillable element on the current step.
      var textInputs = u.getVisibleElements(
        'input:not([type="hidden"]):not([type="file"])',
      );
      var textareas = u.getVisibleElements("textarea");
      var selects = u.getVisibleElements("select");
      var buttonDropdowns = u.getVisibleElements(
        'button[aria-haspopup="listbox"]',
      );
      var fileInputs = Array.from(
        document.querySelectorAll('input[type="file"]'),
      ).filter(function (el) {
        return !el.disabled;
      });
      var radios = u.getVisibleElements('input[type="radio"]');

      // Group radios by name so yes/no pairs are handled together.
      var radiosByName = new Map();
      for (var i = 0; i < radios.length; i++) {
        var radio = radios[i];
        var key = radio.name || radio.id || Math.random().toString(36);
        if (!radiosByName.has(key)) {
          radiosByName.set(key, []);
        }
        radiosByName.get(key).push(radio);
      }

      // Build a unified candidate list with DOM position for top-down ordering.
      var candidates = [];
      var flatEls = textInputs.concat(
        textareas,
        selects,
        buttonDropdowns,
        fileInputs,
      );
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
          var descriptor = candidate.radios
            .map(function (r) {
              return getDescriptor(r);
            })
            .join(" ")
            .toLowerCase();
          var radioInventory = inventoryEntry(candidate, descriptor);
          fieldInventory.push(radioInventory);
          if (fillRequiredOnly && !radioInventory.required) {
            radioInventory.skippedReason = "not_required";
            continue;
          }
          if (
            u.fillRadioGroup(
              candidate.radios,
              descriptor,
              profile,
              containerSelectors,
            )
          ) {
            radioInventory.filled = true;
            radioInventory.valueSource = "radio_rule";
            filledFields.push({ field: descriptor, valueSource: "radio_rule" });
            await sleep(perFieldDelayMs);
          } else {
            radioInventory.skippedReason = "no_known_match";
          }
          continue;
        }

        var elem = candidate.element;
        var desc = getDescriptor(elem);
        var elementInventory = inventoryEntry(candidate, desc);
        fieldInventory.push(elementInventory);
        if (!desc) {
          elementInventory.skippedReason = "missing_descriptor";
          continue;
        }

        if (elem.tagName === "INPUT" && elem.type === "file") {
          if (existingResumeUploadDetected || hasExistingResumeUpload()) {
            existingResumeUploadDetected = true;
            resumeUploadDone = true;
            elementInventory.filled = true;
            elementInventory.valueSource = "resume_upload_existing";
            traceInteraction("already_filled", elem, {
              reason: "existing_resume_upload_detected",
              currentValue: resumeFileNameCandidates().join(", "),
              intendedValue: "resume_upload",
            });
            continue;
          }
          if (resumeUploadDone) {
            elementInventory.skippedReason = "resume_already_uploaded";
            continue;
          }
          if (!isResumeFileInput(desc)) {
            elementInventory.skippedReason = "not_resume_input";
            continue;
          }
          var attachment = await u.attachResumeToFileInput(
            elem,
            activeApplyContext,
            defaultResume,
          );
          if (attachment.attached) {
            elementInventory.filled = true;
            elementInventory.valueSource = "resume_upload";
            resumeUploadDone = true;
            filledFields.push({
              field: getDescriptor(elem) || "resume_upload",
              valueSource: "resume_upload",
            });
            await sleep(perUploadDelayMs);
          } else {
            elementInventory.skippedReason =
              "resume_upload:" + attachment.reason;
            pushManualReviewReason("resume_upload:" + attachment.reason);
          }
          continue;
        }

        if (fillRequiredOnly && !elementInventory.required) {
          elementInventory.skippedReason = "not_required";
          continue;
        }

        if (
          elem.tagName === "INPUT" &&
          elem.type !== "file" &&
          shouldSkipProfileFill(elem, desc)
        ) {
          elementInventory.skippedReason = "unsafe_profile_context";
          continue;
        }

        if (
          elem.tagName === "INPUT" &&
          elem.type !== "file" &&
          isPhoneCountryCodeField(elem, desc)
        ) {
          var phoneCountryResult = await fillPhoneCountryCode(elem, desc);
          if (
            phoneCountryResult.filled ||
            phoneCountryResult.reason === "already_filled"
          ) {
            elementInventory.filled = true;
            elementInventory.valueSource =
              phoneCountryResult.valueSource || "phone_country_code";
            if (phoneCountryResult.filled) {
              filledFields.push({
                field: desc,
                valueSource: elementInventory.valueSource,
              });
            }
            await sleep(perFieldDelayMs);
          } else {
            elementInventory.skippedReason =
              phoneCountryResult.reason || "no_known_match";
          }
          continue;
        }

        if (elem.tagName === "INPUT" && elem.type === "checkbox") {
          if (shouldCheckRequiredCheckbox(elem, desc)) {
            var checked = await setCheckboxChecked(elem);
            if (checked) {
              elementInventory.filled = true;
              elementInventory.valueSource = "required_terms_checkbox";
              filledFields.push({
                field: desc,
                valueSource: elementInventory.valueSource,
              });
              await sleep(perFieldDelayMs);
            } else {
              elementInventory.skippedReason = "checkbox_commit_failed";
            }
          } else {
            elementInventory.skippedReason = "unsupported_checkbox";
          }
          continue;
        }

        if (
          elem.tagName === "BUTTON" &&
          elem.getAttribute("aria-haspopup") === "listbox"
        ) {
          var buttonResult = await fillWorkdayButtonDropdown(elem, desc);
          if (buttonResult.filled || buttonResult.reason === "already_filled") {
            elementInventory.filled = true;
            elementInventory.valueSource =
              buttonResult.valueSource || "button_rule";
            if (buttonResult.filled) {
              filledFields.push({
                field: desc,
                valueSource: elementInventory.valueSource,
              });
            }
            await sleep(perFieldDelayMs);
          } else {
            elementInventory.skippedReason =
              buttonResult.reason || "no_known_match";
          }
          continue;
        }

        if (elem.tagName === "TEXTAREA") {
          if (shouldSkipGeneratedAnswer(desc)) {
            elementInventory.skippedReason = "unsafe_generated_answer_context";
            continue;
          }
          // Skip already-filled or generation-disabled.
          if (elem.value || settings.allowGeneratedAnswers === false) {
            elementInventory.skippedReason = elem.value
              ? "already_filled"
              : "generated_answers_disabled";
            continue;
          }
          var answer = u.generateAnswer(
            desc,
            profile,
            activeApplyContext,
            stripLongDash,
          );
          if (u.setElementValue(elem, answer.answerText, stripLongDash)) {
            elementInventory.filled = true;
            elementInventory.valueSource = "generated_answer";
            var qHash = u.buildQuestionHash(desc);
            generatedAnswers.push({
              questionHash: qHash,
              questionText: desc,
              answerText: answer.answerText,
              answerSource: "generated",
              confidence: answer.confidence,
              manualReviewRequired: answer.manualReviewRequired,
            });
            filledFields.push({ field: desc, valueSource: "generated_answer" });
            if (
              settings.flagLowConfidenceAnswers !== false &&
              answer.manualReviewRequired
            ) {
              pushManualReviewReason("low_confidence_answer:" + qHash);
            }
            await sleep(perFieldDelayMs);
          }
          continue;
        }

        if (elem.tagName === "SELECT") {
          var selectResult = u.fillSelectElement(
            elem,
            desc,
            profileWithContext,
            stripLongDash,
          );
          if (selectResult.filled) {
            elementInventory.filled = true;
            elementInventory.valueSource =
              selectResult.valueSource || "select_rule";
            filledFields.push({
              field: desc,
              valueSource: elementInventory.valueSource,
            });
            await sleep(perFieldDelayMs);
          } else {
            elementInventory.skippedReason =
              selectResult.reason || "no_known_match";
          }
          continue;
        }

        if (
          elem.getAttribute("role") === "combobox" ||
          elem.getAttribute("aria-haspopup") === "listbox" ||
          elem.getAttribute("aria-autocomplete") === "list" ||
          elem.closest(".select__container")
        ) {
          var comboResult = await u.fillComboboxElement(
            elem,
            desc,
            profileWithContext,
            stripLongDash,
          );
          if (comboResult.filled) {
            elementInventory.filled = true;
            elementInventory.valueSource =
              comboResult.valueSource || "combobox_rule";
            filledFields.push({
              field: desc,
              valueSource: elementInventory.valueSource,
            });
            await sleep(perFieldDelayMs);
          } else {
            elementInventory.skippedReason =
              comboResult.reason || "no_known_match";
          }
          continue;
        }

        // Plain text input - map descriptor to profile value.
        if (shouldSkipProfileFill(elem, desc)) {
          elementInventory.skippedReason = "unsafe_profile_context";
          continue;
        }
        if (isExactCityField(elem, desc) && profile.location) {
          var cityValue = u
            .normalizeText(profile.location)
            .split(",")[0]
            .trim();
          if (cityValue && u.setElementValue(elem, cityValue, stripLongDash)) {
            elementInventory.filled = true;
            elementInventory.valueSource = "profile:location";
            filledFields.push({
              field: desc,
              valueSource: elementInventory.valueSource,
            });
            await sleep(perFieldDelayMs);
            continue;
          }
        }
        var profileMatch = u.chooseProfileMatch
          ? u.chooseProfileMatch(desc, profile)
          : null;
        var profileValue = profileMatch
          ? profileMatch.value
          : u.chooseProfileValue(desc, profile);
        if (
          profileValue &&
          u.setElementValue(elem, profileValue, stripLongDash)
        ) {
          elementInventory.filled = true;
          elementInventory.valueSource = profileMatch
            ? profileMatch.key
            : "profile";
          filledFields.push({
            field: desc,
            valueSource: elementInventory.valueSource,
          });
          await sleep(perFieldDelayMs);
        } else {
          elementInventory.skippedReason = "no_known_match";
        }
      }

      finalizeRequiredFieldReview();

      var resultPayload = {
        ok: true,
        atsType: "workday",
        frameUrl: window.location.href,
        authState: u.detectAuthState(),
        filledFieldCount: filledFields.length,
        generatedAnswerCount: generatedAnswers.length,
        manualReviewRequired: manualReviewReasons.length > 0,
        manualReviewReasons: manualReviewReasons,
        filledFields: filledFields,
        fieldInventory: fieldInventory,
        interactionTrace: interactionTrace,
        traceTruncated: traceTruncated,
        generatedAnswers: generatedAnswers,
        htmlSnapshot: document.documentElement.outerHTML.slice(0, 200000),
      };
      return resultPayload;
    } finally {
      u.traceInteraction = previousTraceInteraction || function () {};
    }
  };
}
