(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function clean(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function norm(value) {
    return clean(value)
      .toLowerCase()
      .replace(/[^a-z0-9+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function visible(el) {
    if (!el || el.disabled) {
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

  function clickLikeUser(el) {
    if (!el) {
      return;
    }
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    }
    var rect = el.getBoundingClientRect();
    var init = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    };
    ["mouseover", "mousemove", "pointerdown", "mousedown"].forEach(
      function (type) {
        var Ctor =
          window.PointerEvent && type.startsWith("pointer")
            ? window.PointerEvent
            : MouseEvent;
        el.dispatchEvent(new Ctor(type, init));
      },
    );
    el.dispatchEvent(
      new (window.PointerEvent || MouseEvent)("pointerup", {
        ...init,
        buttons: 0,
      }),
    );
    el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
  }

  function setValue(el, value) {
    if (!el || value === undefined || value === null) {
      return false;
    }
    var stringValue = String(value);
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    }
    if (typeof el.focus === "function") {
      el.focus();
    }
    if (el.isContentEditable || el.getAttribute("role") === "textbox") {
      el.textContent = stringValue;
      commitValue(el);
      return clean(el.textContent || "") === clean(stringValue);
    }
    if ("value" in el) {
      var proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null;
      var setter = proto
        ? Object.getOwnPropertyDescriptor(proto, "value")?.set
        : null;
      if (setter) {
        setter.call(el, stringValue);
      } else {
        el.value = stringValue;
      }
      commitValue(el);
      return clean(el.value || "") === clean(stringValue);
    }
    return false;
  }

  function commitValue(el) {
    if (!el) {
      return;
    }
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: "",
        }),
      );
    } catch (_error) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    try {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    } catch (_error) {
      el.dispatchEvent(new Event("focusout", { bubbles: true }));
    }
    var container =
      el.closest?.("[data-automation-id='formField']") ||
      el.closest?.("[data-uxi-widget-id]") ||
      el.closest?.("[role='group']");
    if (container && container !== el) {
      container.dispatchEvent(new Event("change", { bubbles: true }));
      container.dispatchEvent(new Event("blur", { bubbles: true }));
      try {
        container.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      } catch (_error) {
        container.dispatchEvent(new Event("focusout", { bubbles: true }));
      }
    }
  }

  function textOf(el) {
    return clean(
      [
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("title"),
        el?.innerText,
        el?.textContent,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function headings() {
    return Array.from(
      document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']"),
    )
      .filter(visible)
      .map(function (heading) {
        var tagMatch = String(heading.tagName || "").match(/^H([1-6])$/i);
        var ariaLevel = Number(heading.getAttribute?.("aria-level") || 0);
        return {
          element: heading,
          text: clean(heading.innerText || heading.textContent || ""),
          rect: heading.getBoundingClientRect(),
          level: tagMatch ? Number(tagMatch[1]) : ariaLevel || 6,
        };
      })
      .filter(function (heading) {
        return heading.text && heading.text.length <= 120;
      })
      .sort(function (a, b) {
        return a.rect.top - b.rect.top;
      });
  }

  function sectionBounds(name) {
    var target = norm(name);
    var all = headings();
    var heading = all.find(function (item) {
      var text = norm(item.text);
      return text === target || text.startsWith(target + " ");
    });
    if (!heading && target === "skills") {
      var skillInput = Array.from(
        document.querySelectorAll(
          [
            "input[id*='skills' i]",
            "input[name*='skills' i]",
            "input[data-uxi-multiselect-id]",
            "input[data-uxi-widget-type='selectinput']",
          ].join(","),
        ),
      )
        .filter(visible)
        .find(function (input) {
          return norm(descriptorFor(input)).includes("skills");
        });
      var group =
        skillInput?.closest?.("[data-automation-id='formField-skills']") ||
        null;
      var node = skillInput?.parentElement || null;
      while (!group && node && node !== document.body) {
        if (
          visible(node) &&
          (node.getAttribute?.("role") === "group" ||
            ["SECTION", "ARTICLE"].includes(node.tagName)) &&
          norm(textOf(node)).startsWith("skills ")
        ) {
          group = node;
          break;
        }
        node = node.parentElement;
      }
      if (group && visible(group)) {
        var groupRect = group.getBoundingClientRect();
        return {
          name: name,
          element: group,
          heading: group,
          top: groupRect.top - 6,
          bottom: groupRect.bottom + 6,
          rect: groupRect,
        };
      }
    }
    if (!heading) {
      return null;
    }
    var next = all.find(function (item) {
      var text = norm(item.text);
      return (
        item.rect.top > heading.rect.top + 8 &&
        item.level <= heading.level &&
        text !== target &&
        !text.match(new RegExp("^" + target + "\\s+\\d+$"))
      );
    });
    return {
      name: name,
      heading: heading.element,
      top: heading.rect.top - 6,
      bottom: next ? next.rect.top - 6 : Number.MAX_SAFE_INTEGER,
      rect: heading.rect,
    };
  }

  function inBounds(el, bounds) {
    if (!bounds) {
      return false;
    }
    var rect = el.getBoundingClientRect();
    var center = rect.top + rect.height / 2;
    return center >= bounds.top && center < bounds.bottom;
  }

  function visibleInSection(section, selector) {
    var bounds = sectionBounds(section);
    if (!bounds) {
      return [];
    }
    return Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .filter(function (el) {
        return inBounds(el, bounds);
      });
  }

  function isRepeatableElement(el) {
    if (!el) {
      return false;
    }
    if (
      !sectionBounds("Work Experience") &&
      !sectionBounds("Education") &&
      !sectionBounds("Websites") &&
      !sectionBounds("Social Network URLs")
    ) {
      return false;
    }
    var source = norm(
      [el.id, el.name, el.getAttribute?.("data-automation-id")]
        .filter(Boolean)
        .join(" "),
    );
    if (
      source.includes("workexperience") ||
      source.includes("work experience") ||
      source.includes("education") ||
      source.includes("webaddress") ||
      source.includes("web address") ||
      source.includes("socialnetwork") ||
      source.includes("social network")
    ) {
      return true;
    }
    // Radio buttons and grouped form controls are section-level questions,
    // not repeatable row controls. Never filter them out.
    if (
      el.type === "radio" ||
      el.closest?.('[role="radiogroup"]') ||
      el.closest?.('[role="group"][aria-labelledby]')
    ) {
      return false;
    }
    return [
      "Work Experience",
      "Education",
      "Websites",
      "Social Network URLs",
    ].some(function (section) {
      return inBounds(el, sectionBounds(section));
    });
  }

  function activeDialog() {
    return (
      Array.from(
        document.querySelectorAll(
          [
            "[role='dialog']",
            "[aria-modal='true']",
            "[data-automation-id*='modal']",
            "[data-automation-id*='popup']",
            ".modal",
          ].join(","),
        ),
      ).find(visible) || null
    );
  }

  function descriptorFor(el) {
    if (!el) {
      return "";
    }
    var descriptor = window.__huntApplyUtils?.getDescriptor
      ? window.__huntApplyUtils.getDescriptor(el, [
          "label",
          '[role="group"]',
          "[data-automation-id^='formField']",
          "[data-automation-id='formField']",
          "[data-uxi-widget-id]",
          "[data-testid]",
          "section",
          "div",
        ])
      : "";
    return clean(
      [
        descriptor,
        el.id,
        el.name,
        el.getAttribute?.("aria-label"),
        el.getAttribute?.("placeholder"),
        el.getAttribute?.("data-automation-id"),
        el.getAttribute?.("data-uxi-widget-type"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function rowKeyFor(el, section) {
    var source = [el.id, el.name, el.getAttribute?.("data-automation-id")]
      .filter(Boolean)
      .join(" ");
    var sectionPrefix =
      section === "Education"
        ? "(?:education|school)"
        : section === "Websites" || section === "Social Network URLs"
          ? "(?:webAddress|website|websites|socialNetwork|social|url)"
          : "(?:workExperience|work|experience|employment)";
    var match = source.match(new RegExp(sectionPrefix + "[-_]*(\\d+)", "i"));
    if (match) {
      return section + ":" + match[1];
    }
    var rect = el.getBoundingClientRect();
    return section + ":row:" + Math.round(rect.top / 180);
  }

  function rowControls(section) {
    var selector = [
      "input:not([type='hidden']):not([type='file'])",
      "textarea",
      "button[aria-haspopup='listbox']",
      "[role='combobox']",
    ].join(",");
    return visibleInSection(section, selector).filter(function (el) {
      var text = norm(textOf(el));
      var desc = norm(descriptorFor(el));
      return (
        !text.includes("add") &&
        !text.includes("delete") &&
        !desc.includes("type to add skills")
      );
    });
  }

  function groupRect(controls) {
    var rects = controls.map(function (control) {
      return control.getBoundingClientRect();
    });
    return {
      top: Math.min.apply(
        null,
        rects.map(function (rect) {
          return rect.top;
        }),
      ),
      bottom: Math.max.apply(
        null,
        rects.map(function (rect) {
          return rect.bottom;
        }),
      ),
      left: Math.min.apply(
        null,
        rects.map(function (rect) {
          return rect.left;
        }),
      ),
      right: Math.max.apply(
        null,
        rects.map(function (rect) {
          return rect.right;
        }),
      ),
    };
  }

  function controlGroups(section) {
    var groups = new Map();
    rowControls(section).forEach(function (control) {
      var key = rowKeyFor(control, section);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(control);
    });
    return Array.from(groups.entries())
      .map(function (entry) {
        return {
          key: entry[0],
          controls: entry[1].sort(function (a, b) {
            var ar = a.getBoundingClientRect();
            var br = b.getBoundingClientRect();
            return ar.top - br.top || ar.left - br.left;
          }),
        };
      })
      .filter(function (group) {
        return group.controls.length > 0;
      })
      .sort(function (a, b) {
        return groupRect(a.controls).top - groupRect(b.controls).top;
      });
  }

  function isDeleteButton(el) {
    var label = norm(textOf(el));
    return (
      label === "delete" ||
      label.startsWith("delete ") ||
      label.endsWith(" delete") ||
      label.includes(" delete ") ||
      label.includes("remove") ||
      label.startsWith("remove ") ||
      label.includes("trash")
    );
  }

  function findDeleteButtonNear(section, rect) {
    return visibleInSection(section, "button,[role='button'],a,[tabindex]")
      .filter(isDeleteButton)
      .filter(function (button) {
        var buttonRect = button.getBoundingClientRect();
        var center = buttonRect.top + buttonRect.height / 2;
        return center >= rect.top - 120 && center <= rect.bottom + 120;
      })
      .sort(function (a, b) {
        return b.getBoundingClientRect().left - a.getBoundingClientRect().left;
      })[0];
  }

  async function clickConfirmIfVisible() {
    var dialog = activeDialog();
    if (!dialog) {
      return false;
    }
    var button = Array.from(dialog.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .find(function (candidate) {
        var label = norm(textOf(candidate));
        return ["delete", "remove", "yes", "ok", "confirm"].includes(label);
      });
    if (!button) {
      return false;
    }
    clickLikeUser(button);
    await sleep(250);
    return true;
  }

  async function deleteGroup(section, group) {
    var button = findDeleteButtonNear(section, groupRect(group.controls));
    if (!button) {
      return false;
    }
    clickLikeUser(button);
    await sleep(260);
    await clickConfirmIfVisible();
    await sleep(360);
    return true;
  }

  function groupLooksBlank(group) {
    return !(group?.controls || []).some(function (control) {
      if (control.type === "checkbox") {
        return Boolean(control.checked);
      }
      return Boolean(clean(control.value || textOf(control)));
    });
  }

  async function deleteBlankRequiredRows(section) {
    var deleted = 0;
    for (var pass = 0; pass < 5; pass++) {
      var groups = controlGroups(section);
      var target = groups
        .slice()
        .reverse()
        .find(function (group) {
          return (
            groupLooksBlank(group) &&
            group.controls.some(function (control) {
              return controlLooksRequired(control);
            })
          );
        });
      if (!target || !(await deleteGroup(section, target))) {
        break;
      }
      deleted += 1;
    }
    return deleted;
  }

  function findAddButton(section, preferAddAnother) {
    return visibleInSection(section, "button,[role='button'],a,[tabindex]")
      .filter(function (button) {
        var label = norm(textOf(button));
        var automationId = norm(button.getAttribute?.("data-automation-id"));
        return (
          label === "add" ||
          label === "add another" ||
          automationId.includes("add button")
        );
      })
      .sort(function (a, b) {
        var aAnother = norm(textOf(a)) === "add another" ? 0 : 1;
        var bAnother = norm(textOf(b)) === "add another" ? 0 : 1;
        if (preferAddAnother && aAnother !== bAnother) {
          return aAnother - bAnother;
        }
        var ar = a.getBoundingClientRect();
        var br = b.getBoundingClientRect();
        return ar.top - br.top || ar.left - br.left;
      })[0];
  }

  function optionElements() {
    return Array.from(
      document.querySelectorAll(
        [
          "[role='option']",
          "[data-automation-id='promptOption']",
          "[data-automation-id='menuItem']",
          "[data-automation-id='selectOption']",
        ].join(","),
      ),
    ).filter(visible);
  }

  function keyOn(el, key) {
    if (!el) {
      return;
    }
    var keyCodes = {
      Enter: 13,
      Home: 36,
      ArrowDown: 40,
    };
    var code = key;
    var keyCode = keyCodes[key] || 0;
    ["keydown", "keyup"].forEach(function (type) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          bubbles: true,
          cancelable: true,
          key: key,
          code: code,
          keyCode: keyCode,
          which: keyCode,
        }),
      );
    });
  }

  function activeListboxFor(control) {
    var boxes = Array.from(
      document.querySelectorAll(
        [
          "[data-automation-id='activeListContainer']",
          "[data-automation-id='promptSearchResultList']",
          "[data-uxi-widget-type='multiselectlist']",
          "[role='listbox']",
        ].join(","),
      ),
    )
      .filter(function (box) {
        if (
          box.matches?.("[data-automation-id='selectedItemList']") ||
          box.closest?.("[data-automation-id='selectedItemList']")
        ) {
          return false;
        }
        return visible(box);
      })
      .sort(function (a, b) {
        var ar = a.getBoundingClientRect();
        var br = b.getBoundingClientRect();
        return br.height - ar.height || br.width - ar.width;
      });
    return boxes[0] || control;
  }

  function keyboardSequenceForChoice(targets) {
    var options = optionElements().filter(function (option) {
      return !option.closest?.("[data-automation-id='selectedItemList']");
    });
    var index = options.findIndex(function (candidate) {
      return targets.some(function (target) {
        return choiceMatches(textOf(candidate), target);
      });
    });
    if (index < 0) {
      return [];
    }
    var keys = [{ key: "Home", code: "Home", windowsVirtualKeyCode: 36 }];
    for (var idx = 0; idx < index; idx += 1) {
      keys.push({
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
      });
    }
    keys.push({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    return keys;
  }

  function requestTrustedKeySequence(keys) {
    if (
      !keys?.length ||
      typeof chrome === "undefined" ||
      !chrome.runtime?.sendMessage
    ) {
      return Promise.resolve({
        ok: false,
        reason: "trusted_input_unavailable",
      });
    }
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          {
            type: "hunt.apply.trusted_input",
            payload: {
              action: "key_sequence",
              keys: keys,
              purpose: "repeatable_choice_keyboard",
            },
          },
          function (response) {
            var error = chrome.runtime.lastError;
            if (error) {
              resolve({
                ok: false,
                reason: "trusted_input_message_failed",
                message: error.message,
              });
              return;
            }
            resolve(response || { ok: false, reason: "trusted_input_empty" });
          },
        );
      } catch (error) {
        resolve({
          ok: false,
          reason: "trusted_input_exception",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function requestTrustedMouseClick(el, purpose, label) {
    if (!el || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      return Promise.resolve({
        ok: false,
        reason: "trusted_input_unavailable",
      });
    }
    var rect = el.getBoundingClientRect?.();
    var x = rect ? Math.round(rect.left + rect.width / 2) : NaN;
    var y = rect ? Math.round(rect.top + rect.height / 2) : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return Promise.resolve({
        ok: false,
        reason: "trusted_input_missing_rect",
      });
    }
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          {
            type: "hunt.apply.trusted_input",
            payload: {
              action: "mouse_click",
              x: x,
              y: y,
              label: label || clean(textOf(el)),
              purpose: purpose || "repeatable_mouse_click",
            },
          },
          function (response) {
            var error = chrome.runtime.lastError;
            if (error) {
              resolve({
                ok: false,
                reason: "trusted_input_message_failed",
                message: error.message,
              });
              return;
            }
            resolve(response || { ok: false, reason: "trusted_input_empty" });
          },
        );
      } catch (error) {
        resolve({
          ok: false,
          reason: "trusted_input_exception",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async function keyboardSelectChoice(button, targets) {
    clickLikeUser(button);
    await sleep(220);
    var keys = keyboardSequenceForChoice(targets);
    if (!keys.length) {
      return { ok: false, reason: "keyboard_option_not_found" };
    }
    var trusted = await requestTrustedKeySequence(keys);
    if (!trusted?.ok) {
      var target = activeListboxFor(button);
      try {
        target?.focus?.({ preventScroll: true });
      } catch (_error) {
        target?.focus?.();
      }
      for (var idx = 0; idx < keys.length; idx += 1) {
        keyOn(target, keys[idx].key);
        await sleep(80);
      }
    }
    await sleep(650);
    var committed =
      targets.some(function (target) {
        return choiceMatches(textOf(button), target);
      }) || Boolean(button.value);
    return {
      ok: committed,
      reason: committed ? "" : "keyboard_choice_not_committed",
      trustedInput: trusted || null,
    };
  }

  function triggerReactClickHandler(el) {
    try {
      var fiberKey = Object.keys(el || {}).find(function (key) {
        return (
          key.startsWith("__reactFiber$") ||
          key.startsWith("__reactInternalInstance$")
        );
      });
      if (!fiberKey) {
        return false;
      }
      var node = el[fiberKey];
      while (node) {
        var props = node.memoizedProps || node.pendingProps;
        if (props) {
          var mockEvt = {
            type: "click",
            target: el,
            currentTarget: el,
            bubbles: true,
            preventDefault: function () {},
            stopPropagation: function () {},
            isPropagationStopped: function () {
              return false;
            },
            isDefaultPrevented: function () {
              return false;
            },
            nativeEvent: new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              detail: 1,
            }),
          };
          if (typeof props.onClick === "function") {
            props.onClick(mockEvt);
            return true;
          }
          if (typeof props.onMouseDown === "function") {
            mockEvt.type = "mousedown";
            props.onMouseDown(mockEvt);
            return true;
          }
        }
        node = node.return;
      }
    } catch (_error) {}
    return false;
  }

  function triggerReactClickDeep(el) {
    if (!el) {
      return false;
    }
    var candidates = [el].concat(
      Array.from(
        el.querySelectorAll?.(
          '[data-automation-id="checkboxPanel"], [data-automation-id="promptLeafNode"], [data-uxi-widget-type], input, span, div',
        ) || [],
      ).slice(0, 10),
    );
    for (var idx = 0; idx < candidates.length; idx++) {
      if (triggerReactClickHandler(candidates[idx])) {
        return true;
      }
    }
    return false;
  }

  function isSelectInputPrompt(control) {
    return (
      control?.getAttribute?.("data-uxi-widget-type") === "selectinput" ||
      Boolean(control?.getAttribute?.("data-uxi-multiselect-id"))
    );
  }

  function promptSelectedText(control) {
    var multiSelectId =
      control?.getAttribute?.("data-uxi-multiselect-id") || "";
    var container =
      (multiSelectId &&
        Array.from(document.querySelectorAll("[data-uxi-multiselect-id]")).find(
          function (candidate) {
            return (
              candidate !== control &&
              candidate.getAttribute("data-uxi-multiselect-id") ===
                multiSelectId &&
              visible(candidate)
            );
          },
        )) ||
      control?.closest?.("[data-automation-id='formField'], [role='group']");
    return clean(
      Array.from(
        (container || document).querySelectorAll?.(
          "[data-automation-id='selectedItem'], [data-automation-id='promptSelectionLabel']",
        ) || [],
      )
        .map(textOf)
        .filter(Boolean)
        .join(" "),
    );
  }

  function setSearchText(control, value) {
    if (!control) {
      return false;
    }
    if (typeof control.scrollIntoView === "function") {
      control.scrollIntoView({ block: "center", inline: "nearest" });
    }
    try {
      control.focus?.({ preventScroll: true });
    } catch (_error) {
      control.focus?.();
    }
    if (document.activeElement !== control) {
      clickLikeUser(control);
      try {
        control.focus?.({ preventScroll: true });
      } catch (_error) {
        control.focus?.();
      }
    }
    if (document.activeElement !== control) {
      return false;
    }
    var setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter) {
      setter.call(control, "");
    } else {
      control.value = "";
    }
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      }),
    );
    if (setter) {
      setter.call(control, value);
    } else {
      control.value = value;
    }
    control.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      }),
    );
    return (
      choiceMatches(control.value, value) ||
      control.value === String(value || "")
    );
  }

  async function typeSearchTextLikeUser(control, value) {
    if (!control) {
      return false;
    }
    if (!setSearchText(control, "")) {
      return false;
    }
    var text = String(value || "");
    var current = "";
    for (var index = 0; index < text.length; index++) {
      var char = text[index];
      if (
        document.activeElement !== control &&
        !setSearchText(control, current)
      ) {
        return false;
      }
      control.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: char,
          code: "Key" + char.toUpperCase(),
        }),
      );
      control.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: char,
        }),
      );
      current += char;
      if (!setSearchText(control, current)) {
        return false;
      }
      control.dispatchEvent(
        new KeyboardEvent("keyup", {
          bubbles: true,
          cancelable: true,
          key: char,
          code: "Key" + char.toUpperCase(),
        }),
      );
      await sleep(25);
    }
    return true;
  }

  async function waitForPromptTarget(previousLabels, value, timeoutMs) {
    var previousKey = (previousLabels || []).map(norm).join("|");
    var start = Date.now();
    var latestOptions = [];
    while (Date.now() - start < (timeoutMs || 4600)) {
      latestOptions = optionElements().filter(function (option) {
        return !option.closest?.("[data-automation-id='selectedItemList']");
      });
      var exactTarget = latestOptions.find(function (candidate) {
        return choiceMatches(textOf(candidate), value);
      });
      if (exactTarget) {
        return { target: exactTarget, expectedValue: value };
      }
      var key = latestOptions.map(textOf).map(norm).join("|");
      if (latestOptions.length && key !== previousKey) {
        await sleep(180);
      } else {
        await sleep(120);
      }
    }
    var otherTarget = latestOptions.find(function (candidate) {
      return choiceMatches(textOf(candidate), "Other");
    });
    return otherTarget
      ? { target: otherTarget, expectedValue: "Other" }
      : { target: null, expectedValue: "" };
  }

  function promptOptionCommitTarget(option) {
    return (
      option?.querySelector?.(
        [
          'input[data-automation-id="radioBtn"]',
          'input[type="radio"]',
          'input[type="checkbox"]',
          '[role="radio"]',
          '[role="checkbox"]',
        ].join(", "),
      ) || option
    );
  }

  async function clickPromptOption(option) {
    if (!option) {
      return;
    }
    var target = promptOptionCommitTarget(option);
    clickLikeUser(target || option);
    if (typeof (target || option).click === "function") {
      (target || option).click();
    }
    await sleep(600);
  }

  async function waitForPromptSelection(control, expectedValue, timeoutMs) {
    var start = Date.now();
    while (Date.now() - start < (timeoutMs || 1800)) {
      var selected = promptSelectedText(control);
      if (selected && choiceMatches(selected, expectedValue)) {
        return true;
      }
      await sleep(120);
    }
    return false;
  }

  async function fillSelectInputPrompt(control, value) {
    if (!control || !value) {
      return false;
    }
    if (choiceMatches(promptSelectedText(control), value)) {
      return true;
    }
    clickLikeUser(control);
    await sleep(160);
    var previousLabels = optionElements().map(textOf);
    setSearchText(control, value);
    keyOn(control, "Enter");
    var targetResult = await waitForPromptTarget(previousLabels, value, 4600);
    var target = targetResult.target;
    if (!target) {
      return false;
    }
    await clickPromptOption(target);
    return await waitForPromptSelection(control, targetResult.expectedValue);
  }

  function skillSelectedText() {
    var bounds = sectionBounds("Skills");
    var scope = bounds?.element || bounds?.heading?.parentElement || document;
    return clean(
      Array.from(
        scope.querySelectorAll(
          "[data-automation-id='selectedItem'], [data-automation-id='promptSelectionLabel']",
        ),
      )
        .map(textOf)
        .filter(Boolean)
        .join(" "),
    );
  }

  function selectedSkillKeys() {
    var bounds = sectionBounds("Skills");
    var scope = bounds?.element || bounds?.heading?.parentElement || document;
    return Array.from(
      scope.querySelectorAll(
        "[data-automation-id='selectedItem'], [data-automation-id='promptSelectionLabel']",
      ),
    )
      .map(textOf)
      .map(choiceKey)
      .filter(Boolean)
      .filter(function (key) {
        return !/^\d+\s+items?\s+selected$/.test(key);
      });
  }

  function selectedSkillMatches(skill) {
    var skillKey = choiceKey(skill);
    return Boolean(
      skillKey &&
      selectedSkillKeys().some(function (selectedKey) {
        return selectedKey === skillKey;
      }),
    );
  }

  function hasAnySelectedSkill() {
    return Boolean(skillSelectedText());
  }

  function hasSelectedSkill(skills) {
    return (skills || []).some(function (skill) {
      return selectedSkillMatches(skill);
    });
  }

  function findSkillInput() {
    return visibleInSection(
      "Skills",
      [
        "input[data-uxi-widget-type='selectinput']",
        "input[data-uxi-multiselect-id]",
        "input[data-automation-id='searchBox']",
        "input:not([type='hidden']):not([type='file'])",
      ].join(","),
    ).find(function (input) {
      var descriptor = norm(descriptorFor(input));
      var own = ownControlKey(input);
      return (
        own.includes("skills") ||
        descriptor.includes("type to add skills") ||
        descriptor.includes("skills")
      );
    });
  }

  function skillOptions() {
    return optionElements().filter(function (option) {
      return !option.closest?.("[data-automation-id='selectedItemList']");
    });
  }

  function skillOptionIsChecked(option) {
    var aria = norm(option?.getAttribute?.("aria-label"));
    return (
      (aria.includes("checked") && !aria.includes("not checked")) ||
      Boolean(
        option?.querySelector?.(
          "input[type='checkbox']:checked, input[data-automation-id='checkboxPanel']:checked",
        ),
      )
    );
  }

  function skillOptionCommitTarget(option) {
    return (
      option?.querySelector?.(
        [
          "input[data-automation-id='checkboxPanel']",
          "input[type='checkbox']",
          "[role='checkbox']",
          "[data-automation-id='checkbox']",
        ].join(","),
      ) || option
    );
  }

  function skillOptionText(option) {
    return clean(
      [option?.innerText, option?.textContent, option?.getAttribute?.("title")]
        .filter(Boolean)
        .join(" "),
    ).replace(/\b(not\s+)?checked\b/gi, "");
  }

  function clearSkillSearch(input) {
    if (!input) {
      return;
    }
    setValue(input, "");
    keyOn(input, "Escape");
    input.blur?.();
    commitValue(input);
  }

  function skillQueryCandidates(skill, allowFallback) {
    var values = [skill];
    var seen = {};
    return values
      .map(clean)
      .filter(Boolean)
      .filter(function (value) {
        var key = choiceKey(value);
        if (!key || seen[key]) {
          return false;
        }
        seen[key] = true;
        return true;
      });
  }

  function scoreSkillOption(option, skill) {
    var labelKey = choiceKey(skillOptionText(option));
    var skillKey = choiceKey(skill);
    if (!labelKey || !skillKey || skillOptionIsChecked(option)) {
      return 0;
    }
    if (labelKey === skillKey) {
      return 100;
    }
    return 0;
  }

  async function waitForSkillOption(skill, timeoutMs) {
    var start = Date.now();
    while (Date.now() - start < (timeoutMs || 5200)) {
      var best = skillOptions()
        .map(function (option) {
          return { option: option, score: scoreSkillOption(option, skill) };
        })
        .filter(function (entry) {
          return entry.score > 0;
        })
        .sort(function (a, b) {
          return b.score - a.score;
        })[0]?.option;
      if (best) {
        return best;
      }
      await sleep(150);
    }
    return null;
  }

  async function fillSkill(input, skill, allowFallback) {
    if (!input || !skill) {
      return false;
    }
    if (selectedSkillMatches(skill)) {
      return true;
    }
    var candidates = skillQueryCandidates(skill, allowFallback);
    for (var i = 0; i < candidates.length; i++) {
      var attemptStart = Date.now();
      var query = candidates[i];
      _huntLog("workday_skill_attempt_start", {
        skill: skill,
        query: query,
        candidateIndex: i,
      });
      clearSkillSearch(input);
      clickLikeUser(input);
      await sleep(140);
      await typeSearchTextLikeUser(input, query);
      keyOn(input, "Enter");
      await sleep(380);
      var option = await waitForSkillOption(query, 2200);
      if (!option) {
        _huntLog("workday_skill_attempt_result", {
          skill: skill,
          query: query,
          candidateIndex: i,
          found: false,
          committed: false,
          elapsedMs: Date.now() - attemptStart,
        });
        clearSkillSearch(input);
        await sleep(120);
        continue;
      }
      var target = skillOptionCommitTarget(option);
      triggerReactClickDeep(target || option);
      if (target !== option) {
        triggerReactClickDeep(option);
      }
      clickLikeUser(target || option);
      if (typeof (target || option).click === "function") {
        (target || option).click();
      }
      var start = Date.now();
      while (Date.now() - start < 2600) {
        if (selectedSkillMatches(query)) {
          _huntLog("workday_skill_attempt_result", {
            skill: skill,
            query: query,
            candidateIndex: i,
            found: true,
            committed: true,
            method: "click",
            elapsedMs: Date.now() - attemptStart,
          });
          clearSkillSearch(input);
          await sleep(180);
          return true;
        }
        await sleep(120);
      }
      await requestTrustedMouseClick(
        target || option,
        "repeatable_skill_option",
        query,
      );
      start = Date.now();
      while (Date.now() - start < 1800) {
        if (selectedSkillMatches(query)) {
          _huntLog("workday_skill_attempt_result", {
            skill: skill,
            query: query,
            candidateIndex: i,
            found: true,
            committed: true,
            method: "trusted_mouse",
            elapsedMs: Date.now() - attemptStart,
          });
          clearSkillSearch(input);
          await sleep(180);
          return true;
        }
        await sleep(120);
      }
      _huntLog("workday_skill_attempt_result", {
        skill: skill,
        query: query,
        candidateIndex: i,
        found: true,
        committed: false,
        elapsedMs: Date.now() - attemptStart,
      });
      clearSkillSearch(input);
    }
    return selectedSkillMatches(skill);
  }

  function choiceKey(value) {
    return norm(value)
      .replace(/\bbachelor s\b/g, "bachelors")
      .replace(/\bmaster s\b/g, "masters")
      .replace(/\bdoctor s\b/g, "doctors")
      .replace(/\s+/g, " ")
      .trim();
  }

  function choiceMatches(label, target) {
    var labelKey = choiceKey(label);
    var targetKey = choiceKey(target);
    if (!labelKey || !targetKey) {
      return false;
    }
    return (
      labelKey === targetKey ||
      labelKey.includes(targetKey) ||
      targetKey.includes(labelKey)
    );
  }

  function choiceTargets(target) {
    var values = [target];
    var targetKey = choiceKey(target);
    if (
      /\bbachelor of (science|engineering|commerce|arts|business management)\b/.test(
        targetKey,
      )
    ) {
      values.push(
        "Bachelors",
        "Bachelor's Degree",
        "Bachelors Degree",
        "Bachelors Degree or University",
        "Bachelor / Undergraduate Degree",
        "Undergraduate Degree",
        "University",
        "College/University",
      );
      if (targetKey.includes("science")) {
        values.push("BS", "BSc");
      }
      if (targetKey.includes("arts")) {
        values.push("BA");
      }
      if (targetKey.includes("engineering")) {
        values.push("BEng", "BE");
      }
      if (
        targetKey.includes("commerce") ||
        targetKey.includes("business management")
      ) {
        values.push("BCom", "BComm", "BBA");
      }
    } else if (targetKey === "bachelors" || targetKey === "bachelor degree") {
      values.push(
        "Bachelor's Degree",
        "Bachelors Degree",
        "Bachelors Degree or University",
        "Bachelor / Undergraduate Degree",
        "Undergraduate Degree",
        "University",
        "College/University",
        "Bachelor of Science",
        "Bachelor of Engineering",
        "Bachelor of Commerce",
        "Bachelor of Arts",
        "BS",
        "BA",
      );
    } else if (targetKey === "masters" || targetKey === "master degree") {
      values.push("Master of Science", "MS", "MA");
    } else if (targetKey === "master of science") {
      values.push("Masters", "MS");
    } else if (targetKey === "master of arts") {
      values.push("Masters", "MA");
    } else if (targetKey === "master of business administration") {
      values.push("Masters", "MBA");
    } else if (targetKey === "doctorate" || targetKey === "phd") {
      values.push("Doctorate", "PhD");
    }
    return values.filter(function (value, index) {
      return value && values.indexOf(value) === index;
    });
  }

  function firstRealChoiceOption() {
    return optionElements()
      .filter(function (option) {
        return !option.closest?.("[data-automation-id='selectedItemList']");
      })
      .find(function (option) {
        var text = choiceKey(textOf(option));
        return text && !text.includes("select one") && text !== "no items";
      });
  }

  async function fillButtonChoice(button, value) {
    if (!button || !value) {
      return { ok: false, reason: "missing_button_or_value" };
    }
    var targets = choiceTargets(value);
    if (
      targets.some(function (target) {
        return choiceMatches(textOf(button), target);
      })
    ) {
      return { ok: true, alreadyFilled: true };
    }
    clickLikeUser(button);
    await sleep(220);
    var option = optionElements().find(function (candidate) {
      return targets.some(function (target) {
        return choiceMatches(textOf(candidate), target);
      });
    });
    if (!option) {
      option = firstRealChoiceOption();
      if (!option) {
        return { ok: false, reason: "option_not_found" };
      }
      targets = [textOf(option)].concat(targets);
    }
    clickLikeUser(option);
    if (typeof option.click === "function") {
      option.click();
    }
    await sleep(240);
    var committed =
      targets.some(function (target) {
        return choiceMatches(textOf(button), target);
      }) || Boolean(button.value);
    if (!committed) {
      var keyboard = await keyboardSelectChoice(button, targets);
      committed = keyboard.ok;
    }
    return {
      ok: committed,
      alreadyFilled: false,
      reason: committed ? "" : "choice_not_committed",
    };
  }

  function firstText(values) {
    for (var i = 0; i < values.length; i++) {
      var raw = values[i];
      var value = Array.isArray(raw)
        ? raw.map(clean).filter(Boolean).join("\n")
        : clean(raw);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function educationDegreeAnswer(entry) {
    var rawDegree = firstText([entry.degreeLevel, entry.degree]);
    var degreeText = norm([entry.degreeLevel, entry.degree].join(" "));
    var studyText = norm(entry.fieldOfStudy);
    var broadBachelor =
      /\bbachelor/.test(degreeText) &&
      !/\bbachelor of\b|\bbsc\b|\bba\b|\bbcomm\b|\bbeng\b|\bbs\b/.test(
        degreeText,
      );
    if (!broadBachelor) {
      return rawDegree;
    }
    if (/\bengineer/.test(studyText)) {
      return "Bachelor of Engineering";
    }
    if (
      /\bbusiness\b|\bcommerce\b|\baccount|\bfinance|\bmarketing/.test(
        studyText,
      )
    ) {
      return "Bachelor of Commerce";
    }
    if (
      /\bcomputer\b|\bdata\b|\bscience\b|\bmath|\bstatistic/.test(studyText)
    ) {
      return "Bachelor of Science";
    }
    return rawDegree;
  }

  function boolValue(value) {
    if (typeof value === "boolean") {
      return value;
    }
    var text = norm(value);
    if (!text) {
      return false;
    }
    return ["1", "true", "yes", "y", "current", "present"].includes(text);
  }

  function asList(value) {
    if (Array.isArray(value)) {
      return value;
    }
    return value ? [value] : [];
  }

  function profileAliasList(profile, aliases) {
    var values = [];
    aliases.forEach(function (alias) {
      asList(profile?.[alias]).forEach(function (entry) {
        values.push(entry);
      });
    });
    return values;
  }

  function normalizeWork(entry) {
    if (!entry) {
      return null;
    }
    return {
      jobTitle: firstText([
        entry.jobTitle,
        entry.job_title,
        entry.title,
        entry.position,
        entry.positionTitle,
        entry.position_title,
        entry.role,
        entry.roleTitle,
        entry.role_title,
        entry.businessTitle,
        entry.business_title,
      ]),
      company: firstText([
        entry.company,
        entry.company_name,
        entry.employer,
        entry.employerName,
        entry.employer_name,
        entry.companyName,
        entry.organization,
        entry.organizationName,
        entry.organization_name,
      ]),
      location: firstText([
        entry.location,
        entry.city,
        entry.workLocation,
        entry.work_location,
      ]),
      startMonth: firstText([
        entry.startMonth,
        entry.start_month,
        entry.fromMonth,
        entry.from_month,
      ]),
      startYear: firstText([
        entry.startYear,
        entry.start_year,
        entry.fromYear,
        entry.from_year,
        entry.firstYearAttended,
        entry.first_year_attended,
      ]),
      endMonth: firstText([
        entry.endMonth,
        entry.end_month,
        entry.toMonth,
        entry.to_month,
      ]),
      endYear: firstText([
        entry.endYear,
        entry.end_year,
        entry.toYear,
        entry.to_year,
        entry.lastYearAttended,
        entry.last_year_attended,
      ]),
      current: boolValue(entry.current || entry.isCurrent || entry.is_current),
      description: firstText([
        entry.description,
        entry.roleDescription,
        entry.role_description,
        entry.responsibilities,
        entry.responsibility,
        entry.summary,
        entry.notes,
        entry.bullets,
      ]),
    };
  }

  function normalizeEducation(entry) {
    if (!entry) {
      return null;
    }
    return {
      school: firstText([
        entry.school,
        entry.university,
        entry.institution,
        entry.schoolName,
        entry.school_name,
        entry.institutionName,
        entry.institution_name,
      ]),
      degree: firstText([
        entry.degree,
        entry.degreeName,
        entry.degree_name,
        entry.credential,
        entry.qualification,
      ]),
      degreeLevel: firstText([
        entry.degreeLevel,
        entry.degree_level,
        entry.educationLevel,
        entry.education_level,
        entry.level,
      ]),
      fieldOfStudy: firstText([
        entry.fieldOfStudy,
        entry.field_of_study,
        entry.major,
        entry.areaOfStudy,
        entry.area_of_study,
      ]),
      startMonth: firstText([
        entry.startMonth,
        entry.start_month,
        entry.fromMonth,
        entry.from_month,
      ]),
      startYear: firstText([
        entry.startYear,
        entry.start_year,
        entry.fromYear,
        entry.from_year,
      ]),
      endMonth: firstText([
        entry.endMonth,
        entry.end_month,
        entry.toMonth,
        entry.to_month,
      ]),
      endYear: firstText([
        entry.endYear,
        entry.end_year,
        entry.toYear,
        entry.to_year,
      ]),
      overallResult: firstText([entry.overallResult, entry.gpa, entry.grade]),
    };
  }

  function normalizeWebsite(entry) {
    if (!entry) {
      return null;
    }
    if (typeof entry === "string") {
      return { url: canonicalWebsiteUrl(entry) };
    }
    return {
      url: canonicalWebsiteUrl(
        firstText([
          entry.url,
          entry.href,
          entry.link,
          entry.website,
          entry.websiteUrl,
          entry.portfolioUrl,
          entry.profileUrl,
        ]),
      ),
    };
  }

  function canonicalWebsiteUrl(value) {
    var url = clean(value);
    if (!url) {
      return "";
    }
    if (/^https?:\/\/linkedin\.com\/in\//i.test(url)) {
      url = url.replace(
        /^https?:\/\/linkedin\.com\//i,
        "https://www.linkedin.com/",
      );
    }
    if (/^https?:\/\/www\.linkedin\.com\/in\/[^/?#]+$/i.test(url)) {
      return url + "/";
    }
    return url;
  }

  function normUrl(value) {
    return norm(canonicalWebsiteUrl(value));
  }

  function hasAnyValue(entry) {
    return Object.keys(entry || {}).some(function (key) {
      return key !== "current" && Boolean(entry[key]);
    });
  }

  function uniqueEntries(entries, keyFn) {
    var seen = new Set();
    return entries.filter(function (entry) {
      if (!entry || !hasAnyValue(entry)) {
        return false;
      }
      var key = norm(keyFn(entry));
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function profileLists(profile) {
    var work = uniqueEntries(
      profileAliasList(profile, [
        "workExperience",
        "workExperiences",
        "experience",
        "experiences",
        "pastJobs",
        "jobs",
        "employment",
        "employmentHistory",
        "workHistory",
      ])
        .map(normalizeWork)
        .filter(Boolean),
      function (entry) {
        return [entry.jobTitle, entry.company].join("|");
      },
    );
    var education = uniqueEntries(
      profileAliasList(profile, [
        "education",
        "educations",
        "educationHistory",
        "schools",
        "degrees",
        "academicHistory",
      ])
        .map(normalizeEducation)
        .filter(Boolean),
      function (entry) {
        return [entry.school, entry.degreeLevel, entry.degree].join("|");
      },
    );
    var websites = uniqueEntries(
      [
        profile?.websiteUrl,
        profile?.website,
        profile?.portfolioUrl,
        profile?.portfolio,
        profile?.personalWebsite,
        profile?.linkedinUrl,
        profile?.linkedInUrl,
        profile?.githubUrl,
        profile?.gitHubUrl,
      ]
        .concat(
          profileAliasList(profile, [
            "websites",
            "websiteUrls",
            "links",
            "profiles",
            "portfolioLinks",
          ]),
        )
        .map(normalizeWebsite)
        .filter(Boolean),
      function (entry) {
        return entry.url;
      },
    );
    var socialWebsites = websites.filter(function (entry) {
      var url = normUrl(entry.url);
      return url.includes("linkedin") || url.includes("github");
    });
    var skills = profileAliasList(profile, [
      "skills",
      "skillList",
      "technicalSkills",
      "technical_skills",
    ])
      .map(clean)
      .filter(Boolean)
      .filter(function (skill, index, list) {
        var key = norm(skill);
        return (
          key &&
          list.findIndex(function (entry) {
            return norm(entry) === key;
          }) === index
        );
      });
    return { work, education, websites, socialWebsites, skills };
  }

  function websiteType(url) {
    var lowered = normUrl(url);
    if (lowered.includes("linkedin")) {
      return "LinkedIn";
    }
    if (lowered.includes("github")) {
      return "GitHub";
    }
    return "Personal Website";
  }

  function websiteNetwork(url) {
    var lowered = normUrl(url);
    if (lowered.includes("linkedin")) {
      return "linkedin";
    }
    if (lowered.includes("github")) {
      return "github";
    }
    if (lowered.includes("twitter") || lowered.includes("x.com")) {
      return "twitter";
    }
    if (lowered.includes("facebook")) {
      return "facebook";
    }
    return "";
  }

  function isSocialWebsite(entry) {
    var url = normUrl(entry?.url || entry || "");
    return url.includes("linkedin") || url.includes("github");
  }

  function websiteEntriesForSections(lists) {
    if (sectionBounds("Social Network URLs")) {
      return {
        websites: lists.websites.filter(function (entry) {
          return !isSocialWebsite(entry);
        }),
        socialWebsites: lists.socialWebsites,
      };
    }
    return {
      websites: lists.websites,
      socialWebsites: [],
    };
  }

  function isWebsiteTypeControl(control) {
    var own = ownControlKey(control);
    return (
      (own.includes("type") ||
        own.includes("category") ||
        own.includes("network")) &&
      !own.includes("account") &&
      !own.includes("profile") &&
      !own.includes("url") &&
      !own.includes("webaddress") &&
      !own.includes("web address")
    );
  }

  function dedicatedSocialUrlNetwork(control) {
    var own = ownControlKey(control);
    if (
      own.includes("socialnetwork") ||
      own.includes("social network") ||
      own.includes("account") ||
      own.includes("profile")
    ) {
      if (own.includes("linkedin")) {
        return "linkedin";
      }
      if (own.includes("github")) {
        return "github";
      }
      if (own.includes("twitter") || own.includes("xaccount")) {
        return "twitter";
      }
      if (own.includes("facebook")) {
        return "facebook";
      }
    }
    return "";
  }

  function workdayMonthValue(value) {
    var month = clean(value);
    if (!month) {
      return "";
    }
    if (/^\d{1,2}$/.test(month)) {
      return month.padStart(2, "0");
    }
    var key = month.toLowerCase().slice(0, 3);
    var months = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    return months[key] || month;
  }

  function datePartInfo(control) {
    var own = ownControlKey(control);
    if (!own.includes("datesection") && !own.includes("date section")) {
      return null;
    }
    var prefix = "";
    if (own.includes("startdate") || own.includes("start date")) {
      prefix = "start";
    } else if (own.includes("enddate") || own.includes("end date")) {
      prefix = "end";
    } else {
      return null;
    }
    var part = "";
    if (own.includes("month")) {
      part = "month";
    } else if (own.includes("year")) {
      part = "year";
    } else if (own.includes("day")) {
      part = "day";
    } else {
      return null;
    }
    return { prefix: prefix, part: part };
  }

  function datePartValue(kind, entry, prefix, part) {
    if (prefix === "end" && kind === "work" && entry.current) {
      return "";
    }
    if (part === "month") {
      return workdayMonthValue(entry[prefix + "Month"]);
    }
    if (part === "year") {
      return clean(entry[prefix + "Year"]);
    }
    return "";
  }

  async function fillDatePairs(controls, entry, kind) {
    var byPrefix = {};
    controls.forEach(function (control) {
      var info = datePartInfo(control);
      if (!info) {
        return;
      }
      byPrefix[info.prefix] = byPrefix[info.prefix] || {};
      byPrefix[info.prefix][info.part] = control;
    });

    var filled = 0;
    for (var index = 0; index < ["start", "end"].length; index++) {
      var prefix = ["start", "end"][index];
      var parts = byPrefix[prefix] || {};
      var monthValue = datePartValue(kind, entry, prefix, "month");
      var yearValue = datePartValue(kind, entry, prefix, "year");
      if (!monthValue && !yearValue) {
        continue;
      }
      if (parts.month && monthValue) {
        if (setValue(parts.month, monthValue)) {
          filled += 1;
        }
        await sleep(40);
      }
      if (parts.year && yearValue) {
        if (setValue(parts.year, yearValue)) {
          filled += 1;
        }
        await sleep(40);
      }
      [parts.month, parts.year].filter(Boolean).forEach(function (control) {
        commitValue(control);
      });
      if (parts.year?.focus) {
        parts.year.focus();
        parts.year.blur?.();
      } else if (parts.month?.focus) {
        parts.month.focus();
        parts.month.blur?.();
      }
      await sleep(160);
      [parts.month, parts.year].filter(Boolean).forEach(function (control) {
        commitValue(control);
      });
      if (parts.month && monthValue && !clean(parts.month.value || "")) {
        if (setValue(parts.month, monthValue)) {
          filled += 1;
        }
      }
      if (parts.year && yearValue && !clean(parts.year.value || "")) {
        if (setValue(parts.year, yearValue)) {
          filled += 1;
        }
      }
      [parts.month, parts.year].filter(Boolean).forEach(function (control) {
        commitValue(control);
      });
    }
    return filled;
  }

  function ownControlKey(control) {
    return norm(
      [
        control?.id,
        control?.name,
        control?.getAttribute?.("aria-label"),
        control?.getAttribute?.("placeholder"),
        control?.getAttribute?.("data-automation-id"),
        control?.getAttribute?.("data-uxi-widget-type"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function controlText(control) {
    return norm(
      [
        ownControlKey(control),
        clean(control?.closest?.("label")?.innerText || ""),
        descriptorFor(control),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function valueForControl(kind, entry, control) {
    var own = ownControlKey(control);
    var desc = controlText(control);
    if (kind === "website") {
      var dedicatedNetwork = dedicatedSocialUrlNetwork(control);
      if (dedicatedNetwork) {
        return websiteNetwork(entry.url) === dedicatedNetwork ? entry.url : "";
      }
      if (isWebsiteTypeControl(control)) {
        return websiteType(entry.url);
      }
      return entry.url;
    }
    if (kind === "work") {
      if (
        own.includes("jobtitle") ||
        own.includes("job title") ||
        own.includes("positiontitle") ||
        own.includes("position title") ||
        own.includes("business title") ||
        own.includes("role title") ||
        own === "title" ||
        own.endsWith(" title")
      ) {
        return entry.jobTitle;
      }
      if (
        own.includes("companyname") ||
        own.includes("company name") ||
        own.includes("company") ||
        own.includes("employer")
      ) {
        return entry.company;
      }
      if (own.includes("location")) {
        return entry.location;
      }
      if (
        own.includes("roledescription") ||
        own.includes("role description") ||
        own.includes("description") ||
        own.includes("responsibil")
      ) {
        return entry.description;
      }
      if (
        (own.includes("startdate") || own.includes("start date")) &&
        own.includes("month")
      ) {
        return workdayMonthValue(entry.startMonth);
      }
      if (
        (own.includes("startdate") || own.includes("start date")) &&
        own.includes("year")
      ) {
        return entry.startYear;
      }
      if (
        (own.includes("enddate") || own.includes("end date")) &&
        own.includes("month")
      ) {
        return entry.current ? "" : workdayMonthValue(entry.endMonth);
      }
      if (
        (own.includes("enddate") || own.includes("end date")) &&
        own.includes("year")
      ) {
        return entry.current ? "" : entry.endYear;
      }
      if (own.includes("current")) {
        return entry.current;
      }
      if (desc.includes("job title") || desc.includes("position")) {
        return entry.jobTitle;
      }
      if (desc.includes("company") || desc.includes("employer")) {
        return entry.company;
      }
      if (desc.includes("location")) {
        return entry.location;
      }
      if (desc.includes("description") || desc.includes("responsibil")) {
        return entry.description;
      }
    }
    if (kind === "education") {
      if (
        own.includes("schoolname") ||
        own.includes("school name") ||
        own.includes("school") ||
        own.includes("university") ||
        own.includes("institution")
      ) {
        return entry.school;
      }
      if (own.includes("degree") || own.includes("education level")) {
        return educationDegreeAnswer(entry);
      }
      if (
        own.includes("fieldofstudy") ||
        own.includes("field of study") ||
        own.includes("major") ||
        own.includes("study")
      ) {
        return entry.fieldOfStudy;
      }
      if (
        own.includes("gradeaverage") ||
        own.includes("grade average") ||
        own.includes("result") ||
        own.includes("gpa") ||
        own.includes("grade")
      ) {
        return entry.overallResult;
      }
      if (
        (own.includes("startdate") || own.includes("start date")) &&
        own.includes("month")
      ) {
        return workdayMonthValue(entry.startMonth);
      }
      if (
        (own.includes("startdate") || own.includes("start date")) &&
        own.includes("year")
      ) {
        return entry.startYear;
      }
      if (
        (own.includes("enddate") || own.includes("end date")) &&
        own.includes("month")
      ) {
        return workdayMonthValue(entry.endMonth);
      }
      if (
        (own.includes("enddate") || own.includes("end date")) &&
        own.includes("year")
      ) {
        return entry.endYear;
      }
      if (
        desc.includes("school") ||
        desc.includes("university") ||
        desc.includes("institution")
      ) {
        return entry.school;
      }
      if (desc.includes("degree") || desc.includes("education level")) {
        return educationDegreeAnswer(entry);
      }
    }
    return "";
  }

  function controlLooksFilled(control) {
    if (!control) {
      return false;
    }
    if (control.type === "checkbox") {
      return Boolean(control.checked);
    }
    if (isChoiceControl(control)) {
      var directText = clean(
        [control.value, control.innerText, control.textContent]
          .filter(Boolean)
          .join(" "),
      );
      var text = norm(directText || textOf(control));
      return Boolean(text && !text.includes("select one"));
    }
    return Boolean(clean(control.value || textOf(control)));
  }

  function controlLooksRequired(control) {
    if (!control) {
      return false;
    }
    var own = norm(ownControlKey(control));
    var desc = norm(descriptorFor(control));
    return (
      control.required ||
      control.getAttribute?.("aria-required") === "true" ||
      own.includes("required") ||
      desc.includes("required") ||
      /\*/.test(descriptorFor(control))
    );
  }

  function sectionHasMissingRequiredControls(section) {
    return controlGroups(section).some(function (group) {
      return group.controls.some(function (control) {
        return controlLooksRequired(control) && !controlLooksFilled(control);
      });
    });
  }

  function controlFilledKeys(controls) {
    return (controls || [])
      .map(function (control) {
        return choiceKey(
          [control.value, control.innerText, control.textContent, textOf(control)]
            .filter(Boolean)
            .join(" "),
        );
      })
      .filter(Boolean);
  }

  function liveControl(control) {
    if (!control) {
      return control;
    }
    var id = control.id;
    var live = id ? document.getElementById(id) : null;
    return live && visible(live) ? live : control;
  }

  function isChoiceControl(control) {
    return (
      control?.tagName === "BUTTON" ||
      control?.getAttribute?.("role") === "combobox"
    );
  }

  async function fillNonDateControls(controls, entry, kind, mode) {
    var filled = 0;
    for (var i = 0; i < controls.length; i++) {
      var control = liveControl(controls[i]);
      if (datePartInfo(control)) {
        continue;
      }
      var choice = isChoiceControl(control);
      if (mode === "choice" && !choice) {
        continue;
      }
      if (mode === "value" && choice) {
        continue;
      }
      var value = valueForControl(kind, entry, control);
      if (value === "" || value === undefined || value === null) {
        continue;
      }
      if (control.type === "checkbox") {
        if (Boolean(value) !== Boolean(control.checked)) {
          clickLikeUser(control);
          filled += 1;
        }
        continue;
      }
      if (isSelectInputPrompt(control)) {
        if (await fillSelectInputPrompt(control, value)) {
          filled += 1;
        }
        continue;
      }
      if (choice) {
        var choiceResult = await fillButtonChoice(control, value);
        if (choiceResult.ok) {
          filled += 1;
        }
        continue;
      }
      if (setValue(control, value)) {
        filled += 1;
        await sleep(60);
      }
    }
    return filled;
  }

  async function fillControls(controls, entry, kind) {
    var filled = await fillDatePairs(controls, entry, kind);
    filled += await fillNonDateControls(controls, entry, kind, "value");
    filled += await fillNonDateControls(controls, entry, kind, "choice");
    await sleep(180);
    filled += await fillNonDateControls(controls, entry, kind, "value");
    return filled;
  }

  async function repairMissingRequiredRows(section, kind, entries) {
    var repaired = 0;
    for (var pass = 0; pass < 2; pass++) {
      var groups = controlGroups(section);
      var passFilled = 0;
      for (
        var index = 0;
        index < groups.length && index < entries.length;
        index++
      ) {
        var group = groups[index];
        var missing = group.controls.filter(function (control) {
          return controlLooksRequired(control) && !controlLooksFilled(control);
        });
        if (!missing.length) {
          continue;
        }
        var beforeKeys = controlFilledKeys(group.controls);
        passFilled += await fillControls(group.controls, entries[index], kind);
        var afterKeys = controlFilledKeys(group.controls);
        missing.forEach(function (control) {
          var targetKey = choiceKey(valueForControl(kind, entries[index], control));
          if (targetKey && !afterKeys.includes(targetKey)) {
            return;
          }
          if (afterKeys.length > beforeKeys.length || controlLooksFilled(control)) {
            repaired += 1;
          }
        });
        await sleep(160);
      }
      if (!passFilled) {
        break;
      }
    }
    return repaired;
  }

  async function fillDialogEntry(entry, kind) {
    var dialog = activeDialog();
    if (!dialog) {
      return { filled: 0, saved: false };
    }
    var controls = Array.from(
      dialog.querySelectorAll(
        [
          "input:not([type='hidden']):not([type='file'])",
          "textarea",
          "button[aria-haspopup='listbox']",
          "[role='combobox']",
        ].join(","),
      ),
    ).filter(visible);
    var filled = await fillControls(controls, entry, kind);
    var save = Array.from(dialog.querySelectorAll("button,[role='button']"))
      .filter(visible)
      .find(function (button) {
        var label = norm(textOf(button));
        return ["save", "done", "ok"].includes(label);
      });
    if (save) {
      clickLikeUser(save);
      await sleep(600);
      return { filled: filled, saved: true };
    }
    return { filled: filled, saved: false };
  }

  async function fillWebsiteUrlInputs(section, entries) {
    var inputs = controlGroups(section)
      .map(function (group) {
        return group.controls.find(function (control) {
          var own = ownControlKey(control);
          return control.tagName !== "BUTTON" && own.includes("url");
        });
      })
      .filter(Boolean);
    var filled = 0;
    for (
      var index = 0;
      index < entries.length && index < inputs.length;
      index++
    ) {
      var input = inputs[index];
      var value = entries[index].url;
      if (!value) {
        continue;
      }
      if (clean(input.value) !== value && setValue(input, value)) {
        filled += 1;
        await sleep(120);
      }
    }
    return filled;
  }

  function groupUrlValue(group) {
    var control = (group?.controls || []).find(function (candidate) {
      return (
        candidate.tagName !== "BUTTON" &&
        ownControlKey(candidate).includes("url")
      );
    });
    return clean(control?.value || "");
  }

  function groupHasInvalidUrl(group) {
    return (group?.controls || []).some(function (candidate) {
      return (
        candidate.tagName !== "BUTTON" &&
        ownControlKey(candidate).includes("url") &&
        candidate.getAttribute?.("aria-invalid") === "true"
      );
    });
  }

  async function deleteInvalidWebsiteRows(section) {
    var deleted = 0;
    for (var pass = 0; pass < 5; pass++) {
      var seen = new Set();
      var groups = controlGroups(section);
      var target = null;
      for (var index = groups.length - 1; index >= 0; index--) {
        var group = groups[index];
        var url = groupUrlValue(group);
        var key = normUrl(url);
        var duplicate = Boolean(key && seen.has(key));
        if (key) {
          seen.add(key);
        }
        if (duplicate || groupHasInvalidUrl(group)) {
          target = group;
          break;
        }
      }
      if (!target || !(await deleteGroup(section, target))) {
        break;
      }
      deleted += 1;
      await sleep(220);
    }
    return deleted;
  }

  async function waitForGroupCount(section, count, timeoutMs) {
    var start = Date.now();
    while (Date.now() - start < (timeoutMs || 2500)) {
      if (controlGroups(section).length >= count) {
        return true;
      }
      await sleep(120);
    }
    return false;
  }

  async function syncSection(section, kind, entries) {
    var inventory = {
      kind: "workdaySection",
      tagName: "SECTION",
      type: "",
      name: section,
      id: "",
      descriptor: section.toLowerCase(),
      questionHash: window.__huntApplyUtils?.buildQuestionHash
        ? window.__huntApplyUtils.buildQuestionHash(section)
        : section.toLowerCase().replace(/\s+/g, "_"),
      required: false,
      filled: false,
      skippedReason: "",
      valueSource: "profile:" + kind,
      options: [],
      rect: root.audit?.rectSummary(sectionBounds(section)?.heading) || {},
    };
    if (!sectionBounds(section)) {
      inventory.skippedReason = "section_not_present";
      return { filledFieldCount: 0, deletedRowCount: 0, inventory: inventory };
    }
    var filledCount = 0;
    var deletedCount = 0;
    for (var index = 0; index < entries.length; index++) {
      var groups = controlGroups(section);
      var group = groups[index];
      if (!group) {
        var addButton = findAddButton(section, index > 0);
        if (!addButton) {
          inventory.skippedReason = "add_button_not_found";
          break;
        }
        clickLikeUser(addButton);
        if (await waitForGroupCount(section, index + 1, 2800)) {
          await sleep(180);
        } else {
          var dialogResult = await fillDialogEntry(entries[index], kind);
          if (dialogResult.filled) {
            filledCount += dialogResult.filled;
            await sleep(400);
          }
        }
      }
    }
    for (var fillIndex = 0; fillIndex < entries.length; fillIndex++) {
      var fillGroups = controlGroups(section);
      var fillGroup = fillGroups[fillIndex];
      if (fillGroup) {
        filledCount += await fillControls(
          fillGroup.controls,
          entries[fillIndex],
          kind,
        );
      }
    }
    filledCount += await repairMissingRequiredRows(section, kind, entries);
    if (kind === "website") {
      filledCount += await fillWebsiteUrlInputs(section, entries);
      deletedCount += await deleteInvalidWebsiteRows(section);
    }
    deletedCount += await deleteBlankRequiredRows(section);
    var finalGroups = controlGroups(section);
    for (var extra = finalGroups.length - 1; extra >= entries.length; extra--) {
      if (await deleteGroup(section, finalGroups[extra])) {
        deletedCount += 1;
      }
    }
    if (!entries.length && finalGroups.length) {
      inventory.skippedReason = deletedCount ? "" : "missing_profile_entries";
    }
    var missingRequiredControls = sectionHasMissingRequiredControls(section);
    inventory.filled =
      (filledCount > 0 || deletedCount > 0) && !missingRequiredControls;
    if (!inventory.filled && entries.length) {
      inventory.skippedReason = missingRequiredControls
        ? "missing_required_controls"
        : filledCount > 0 || deletedCount > 0
          ? "partial_fill_uncommitted_required_controls"
          : "already_filled";
    }
    return {
      filledFieldCount: inventory.filled ? 1 : 0,
      deletedRowCount: deletedCount,
      inventory: inventory,
      filledField: inventory.filled
        ? {
            field: section,
            valueSource: inventory.valueSource,
            questionHash: inventory.questionHash,
          }
        : null,
    };
  }

  async function syncSkills(skills) {
    var inventory = {
      kind: "workdaySection",
      tagName: "SECTION",
      type: "",
      name: "Skills",
      id: "",
      descriptor: "skills",
      questionHash: window.__huntApplyUtils?.buildQuestionHash
        ? window.__huntApplyUtils.buildQuestionHash("Skills")
        : "skills",
      required: false,
      filled: false,
      skippedReason: "",
      valueSource: "profile:skills",
      options: [],
      rect: root.audit?.rectSummary(sectionBounds("Skills")?.heading) || {},
    };
    if (!sectionBounds("Skills")) {
      inventory.skippedReason = "section_not_present";
      return { filledFieldCount: 0, deletedRowCount: 0, inventory: inventory };
    }
    if (!skills.length) {
      inventory.skippedReason = skillSelectedText()
        ? "already_filled"
        : "missing_profile_entries";
      return { filledFieldCount: 0, deletedRowCount: 0, inventory: inventory };
    }
    var input = findSkillInput();
    if (!input) {
      inventory.skippedReason = "skills_input_not_found";
      return { filledFieldCount: 0, deletedRowCount: 0, inventory: inventory };
    }
    var added = 0;
    var satisfied = 0;
    var skillsStart = Date.now();
    var skillsBudgetMs = 25000;
    for (var index = 0; index < skills.length; index++) {
      if (Date.now() - skillsStart > skillsBudgetMs) {
        _huntLog("workday_skills_time_budget_exceeded", {
          elapsedMs: Date.now() - skillsStart,
          skillsBudgetMs: skillsBudgetMs,
          attemptedCount: index,
          selectedSkills: selectedSkillKeys(),
        });
        clearSkillSearch(input);
        break;
      }
      var skill = skills[index];
      if (selectedSkillMatches(skill)) {
        satisfied += 1;
        continue;
      }
      if (await fillSkill(input, skill, !hasAnySelectedSkill())) {
        added += 1;
        satisfied += 1;
        if (hasAnySelectedSkill()) {
          break;
        }
        await sleep(180);
      }
    }
    var missingRequired =
      controlLooksRequired(input) &&
      !hasAnySelectedSkill() &&
      !clean(input.value || "");
    inventory.filled = satisfied > 0 && !missingRequired;
    if (!inventory.filled) {
      inventory.skippedReason = missingRequired
        ? "missing_required_controls"
        : added > 0
          ? "skills_not_committed"
          : "already_filled";
    }
    return {
      filledFieldCount: inventory.filled ? 1 : 0,
      deletedRowCount: 0,
      inventory: inventory,
      filledField: inventory.filled
        ? {
            field: "Skills",
            valueSource: inventory.valueSource,
            questionHash: inventory.questionHash,
          }
        : null,
    };
  }

  async function fillWorkdayRepeatables(context) {
    var lists = profileLists(context?.profile || {});
    var websiteSections = websiteEntriesForSections(lists);
    var sections = [
      await syncSection("Work Experience", "work", lists.work),
      await syncSection("Education", "education", lists.education),
      await syncSkills(lists.skills),
      await syncSection("Websites", "website", websiteSections.websites),
      await syncSection(
        "Social Network URLs",
        "website",
        websiteSections.socialWebsites,
      ),
    ];
    return {
      ok: true,
      filledFieldCount: sections.reduce(function (sum, section) {
        return sum + Number(section.filledFieldCount || 0);
      }, 0),
      deletedRowCount: sections.reduce(function (sum, section) {
        return sum + Number(section.deletedRowCount || 0);
      }, 0),
      fieldInventory: sections.map(function (section) {
        return section.inventory;
      }),
      filledFields: sections
        .map(function (section) {
          return section.filledField;
        })
        .filter(Boolean),
    };
  }

  async function deleteAllRows(section) {
    var deleted = 0;
    for (var pass = 0; pass < 20; pass++) {
      var groups = controlGroups(section);
      if (!groups.length) {
        break;
      }
      if (!(await deleteGroup(section, groups[groups.length - 1]))) {
        break;
      }
      deleted += 1;
    }
    return deleted;
  }

  function resumeUploadedText() {
    var bounds = sectionBounds("Resume/CV");
    var nodes = Array.from(document.querySelectorAll("body *"))
      .filter(visible)
      .filter(function (node) {
        return !bounds || inBounds(node, bounds);
      })
      .map(function (node) {
        return clean(node.innerText || node.textContent || "");
      })
      .filter(function (text) {
        return (
          /\.(pdf|docx?|rtf|txt)\b/i.test(text) ||
          /successfully uploaded/i.test(text)
        );
      });
    return nodes[0] || "";
  }

  async function clearResumeUpload() {
    if (!resumeUploadedText()) {
      return 0;
    }
    var buttons = visibleInSection(
      "Resume/CV",
      "button,[role='button'],a,[tabindex]",
    ).filter(isDeleteButton);
    var cleared = 0;
    for (var i = buttons.length - 1; i >= 0; i--) {
      if (!resumeUploadedText()) {
        break;
      }
      clickLikeUser(buttons[i]);
      await sleep(260);
      await clickConfirmIfVisible();
      await sleep(500);
      if (!resumeUploadedText()) {
        cleared += 1;
      }
    }
    return cleared;
  }

  async function clearWorkdayRepeatables() {
    var deletedWork = await deleteAllRows("Work Experience");
    var deletedEducation = await deleteAllRows("Education");
    var deletedWebsites = await deleteAllRows("Websites");
    var deletedSocialWebsites = await deleteAllRows("Social Network URLs");
    var deletedResume = await clearResumeUpload();
    var clearedFieldCount =
      deletedWork +
      deletedEducation +
      deletedWebsites +
      deletedSocialWebsites +
      deletedResume;
    return {
      ok: true,
      clearedFieldCount: clearedFieldCount,
      clearedFields: [
        deletedWork ? { field: "Work Experience rows" } : null,
        deletedEducation ? { field: "Education rows" } : null,
        deletedWebsites ? { field: "Website rows" } : null,
        deletedSocialWebsites ? { field: "Social Network URL rows" } : null,
        deletedResume ? { field: "Resume/CV upload" } : null,
      ].filter(Boolean),
      detail: {
        deletedWork,
        deletedEducation,
        deletedWebsites,
        deletedSocialWebsites,
        deletedResume,
      },
    };
  }

  function mergeFill(base, repeatables) {
    base.filledFieldCount =
      Number(base.filledFieldCount || 0) +
      Number(repeatables.filledFieldCount || 0);
    base.filledFields = (base.filledFields || []).concat(
      repeatables.filledFields || [],
    );
    base.fieldInventory = (base.fieldInventory || []).concat(
      repeatables.fieldInventory || [],
    );
    if (base.v2Audit) {
      root.audit?.pushEvent(base.v2Audit, {
        action: "workday_repeatables_fill",
        step: "workday.repeatables.fill",
        status: "ok",
        reason: "profile_repeatable_sections_synced",
        detail: repeatables,
      });
    }
    return base;
  }

  function mergeClear(base, repeatables) {
    base.clearedFieldCount =
      Number(base.clearedFieldCount || 0) +
      Number(repeatables.clearedFieldCount || 0);
    base.clearedFields = (base.clearedFields || []).concat(
      repeatables.clearedFields || [],
    );
    if (base.v2Audit) {
      root.audit?.pushEvent(base.v2Audit, {
        action: "workday_repeatables_clear",
        step: "workday.repeatables.clear",
        status: "ok",
        reason: "repeatable_rows_and_resume_deleted",
        detail: repeatables.detail || {},
      });
    }
    return base;
  }

  if (
    root.fieldPipeline?.runHuntV2Fill &&
    !root.fieldPipeline._workdayRepeatablesWrapped
  ) {
    var baseRunFill = root.fieldPipeline.runHuntV2Fill;
    root.fieldPipeline.runHuntV2Fill = async function workdayRepeatableFill(
      context,
    ) {
      var base = await baseRunFill(context);
      if ((context?.atsType || "") !== "workday") {
        return base;
      }
      var repeatables = await fillWorkdayRepeatables(context);
      return mergeFill(base, repeatables);
    };
    root.fieldPipeline._workdayRepeatablesWrapped = true;
  }

  if (
    root.clearPipeline?.runHuntV2Clear &&
    !root.clearPipeline._workdayRepeatablesWrapped
  ) {
    var baseRunClear = root.clearPipeline.runHuntV2Clear;
    root.clearPipeline.runHuntV2Clear = async function workdayRepeatableClear(
      context,
    ) {
      var base = await baseRunClear(context);
      if ((context?.atsType || "") !== "workday") {
        return base;
      }
      var repeatables = await clearWorkdayRepeatables();
      return mergeClear(base, repeatables);
    };
    root.clearPipeline._workdayRepeatablesWrapped = true;
  }

  if (
    root.uiInspector?.collectCandidates &&
    !root.uiInspector._workdayRepeatablesCandidateWrapped
  ) {
    var baseCollectCandidates = root.uiInspector.collectCandidates;
    root.uiInspector.collectCandidates =
      function collectNonRepeatableWorkdayCandidates() {
        return baseCollectCandidates().filter(function (field) {
          return !isRepeatableElement(field.element || field.anchor);
        });
      };
    root.uiInspector._workdayRepeatablesCandidateWrapped = true;
  }

  root.workdayRepeatables = {
    fillWorkdayRepeatables,
    clearWorkdayRepeatables,
    syncSection,
    controlGroups,
    isRepeatableElement,
  };
})();
