// Self-contained because both browser transports serialize this function.
// The query string is deliberately separate from committed selection labels.
export function inspectChoiceWidget(element, mode) {
  const readback = (owner) => {
    const fieldSelector = '[data-automation-id="formField"], [data-automation-id^="formField-"]';
    const itemOwnerSelector = [
      '[data-uxi-widget-type="selectinputlistitem"]',
      '[data-uxi-multiselect-id]',
      '[data-uxi-selectinputlistitem-index]',
    ].join("");
    const normalize = (value) => (value ?? "")
      .normalize("NFC").replace(/\s+/gu, " ").trim();
    const readItem = (item) => {
      const promptOptions = item.querySelectorAll('[data-automation-id="promptOption"]');
      if (promptOptions.length > 1) {
        throw new TypeError("Workday selected item has ambiguous semantic text");
      }
      const semantic = promptOptions[0] ?? item;
      const copy = semantic.cloneNode(true);
      copy.querySelectorAll('[data-automation-id="DELETE_charm"]')
        .forEach((affordance) => affordance.remove());
      return { node: item, canonical: promptOptions.length === 1, label: normalize(copy.textContent) };
    };
    const productionOwners = [...owner.querySelectorAll(itemOwnerSelector)]
      .filter((itemOwner) => itemOwner.closest(fieldSelector) === owner);
    const fieldSelectedItems = [...owner.querySelectorAll(
      '[data-automation-id="selectedItem"]',
    )].filter((item) => item.closest(fieldSelector) === owner);
    const ownerIds = new Set(productionOwners.map((itemOwner) =>
      itemOwner.getAttribute("data-uxi-multiselect-id")
    ));
    const ownerIndexes = productionOwners.map((itemOwner) =>
      itemOwner.getAttribute("data-uxi-selectinputlistitem-index")
    );
    if (productionOwners.length > 0 &&
        (ownerIds.size !== 1 || new Set(ownerIndexes).size !== ownerIndexes.length)) {
      throw new TypeError("Workday selected-item ownership is ambiguous");
    }
    const items = (productionOwners.length > 0
      ? productionOwners.map((itemOwner) => {
        const selectedItems = [...itemOwner.querySelectorAll(
          '[data-automation-id="selectedItem"]',
        )].filter((item) => item.closest(itemOwnerSelector) === itemOwner);
        if (selectedItems.length !== 1) {
          throw new TypeError("Workday selected-item owner is incomplete or ambiguous");
        }
        return readItem(selectedItems[0]);
      })
      : fieldSelectedItems.map(readItem))
      .filter(({ label }) => label !== "");

    // Production Workday pills expose their semantic text as promptOption.
    // Collapsed and visible presentation mirrors can coexist as selectedItem
    // nodes without that child, so never mix their aggregate text into a
    // canonical prompt-backed selection set.
    const canonical = items.filter((item) => item.canonical);
    const labels = (canonical.length > 0 ? canonical : items).map(({ label }) => label);

    // Workday can remount one semantic selection into both a collapsed list
    // and a visible token. Multi-select options are set members, so retain one
    // exact structural label for each normalized option instead of counting UI
    // mirrors as duplicate selections.
    const unique = new Map();
    for (const label of labels) {
      const key = label.toLocaleLowerCase("en-US");
      if (!unique.has(key)) unique.set(key, label);
    }
    const productionOwnerSet = new Set(productionOwners);
    const productionOwnedSelectedItemCount = fieldSelectedItems.filter((item) => {
      const itemOwner = item.closest(itemOwnerSelector);
      return itemOwner !== null && productionOwnerSet.has(itemOwner);
    }).length;
    return {
      labels: [...unique.values()],
      items: canonical.length > 0 ? canonical : items,
      ownerIds: [...ownerIds],
      diagnostics: {
        selectedItemCount: fieldSelectedItems.length,
        productionOwnerCount: productionOwners.length,
        productionOwnedSelectedItemCount,
        unownedSelectedItemCount: fieldSelectedItems.length - productionOwnedSelectedItemCount,
        canonicalItemCount: items.filter((item) => item.canonical).length,
        fallbackItemCount: items.filter((item) => !item.canonical).length,
        chosenItemCount: labels.length,
        chosenUniqueCount: unique.size,
        usedProductionOwners: productionOwners.length > 0,
      },
    };
  };
  if (mode === "readback") {
    const { labels, diagnostics } = readback(element);
    return { labels, diagnostics };
  }
  if (!(element instanceof HTMLInputElement) ||
      element.getAttribute("data-uxi-widget-type") !== "selectinput") return null;
  const input = element;
  const root = input.getRootNode();
  const fieldSelector = '[data-automation-id="formField"], [data-automation-id^="formField-"]';
  const widgetSelector = '[data-automation-id="multiSelectContainer"][data-uxi-widget-type="multiselect"]';
  const owner = input.closest(fieldSelector);
  const widget = input.closest(widgetSelector);
  const widgetId = input.getAttribute("data-uxi-multiselect-id") || "";
  const region = input.form || input.closest('[role="form"]') || root;
  const normalize = value => (value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const visible = node => node.isConnected && node.getClientRects().length > 0 &&
    !node.closest('[hidden],[aria-hidden="true"]') &&
    getComputedStyle(node).visibility !== "hidden";
  const enabled = node => !node.matches(':disabled,[aria-disabled="true"]') &&
    !node.closest('[inert],[aria-disabled="true"]');
  const result = {kind:"owned_search_choice", valid:false, reason:null,
    input, owner, widget, widgetId, root, region, query:input.value, labels:[],
    pills:[], popup:null, popupStatus:"closed", options:[], empty:false, multiple:null,
    diagnostics:null};
  const fail = reason => ({...result, valid:false, reason});
  if (!owner || !widget || !widgetId || widget.id !== widgetId ||
      widget.closest(fieldSelector) !== owner ||
      root.querySelectorAll(`[id="${CSS.escape(widgetId)}"]`).length !== 1 ||
      [...owner.querySelectorAll(widgetSelector)].filter(node => node.closest(fieldSelector) === owner).length !== 1 ||
      [...widget.querySelectorAll('input[data-uxi-widget-type="selectinput"]')]
        .filter(node => node.closest(widgetSelector) === widget).length !== 1) {
    return fail("choice_widget_ownership_ambiguous");
  }
  try {
    const observed = readback(owner);
    result.diagnostics = observed.diagnostics;
    if (observed.ownerIds.some(id => id !== widgetId)) return fail("choice_selection_owner_mismatch");
    result.labels = observed.labels;
    result.pills = observed.labels.map(label => {
      const matches = observed.items.filter(item => item.label.toLocaleLowerCase("en-US") === label.toLocaleLowerCase("en-US"));
      const visibleMatches = matches.filter(item => visible(item.node));
      const chosen = visibleMatches.length === 1 ? visibleMatches[0] : matches[0];
      const itemOwner = chosen.node.closest('[data-uxi-widget-type="selectinputlistitem"]') || chosen.node;
      const removes = [...itemOwner.querySelectorAll('[data-automation-id="DELETE_charm"]')]
        .filter(node => visible(node) && enabled(node));
      return {node:chosen.node,label,remove:visibleMatches.length <= 1 && removes.length === 1 ? removes[0] : null};
    });
    const selectionText = [...widget.querySelectorAll('[data-automation-id="promptSelectionLabel"]')]
      .map(node => normalize(node.textContent)).filter(Boolean);
    const instructions = [...widget.querySelectorAll('[data-automation-id="promptAriaInstruction"]')]
      .map(node => normalize(node.textContent));
    if (!result.labels.length && (selectionText.length || instructions.some(text => /^[1-9]\d*\s+items? selected$/iu.test(text)))) {
      return fail("choice_selection_backing_unavailable");
    }
    result.empty = result.labels.length === 0;
  } catch (error) { return fail(error instanceof Error ? error.message : "choice_selection_ambiguous"); }

  // Explicit ownership also supports portals. Never borrow a neighbouring list.
  const hints = [...new Set([input,widget].flatMap(node =>
    ["aria-controls","aria-owns"].flatMap(name => (node.getAttribute(name) || "").split(/\s+/u).filter(Boolean))))];
  const declared = [];
  for (const id of hints) {
    const found = [...root.querySelectorAll(`[id="${CSS.escape(id)}"]`)];
    if (found.length !== 1) return fail("choice_popup_ownership_ambiguous");
    if ((found[0].getAttribute("data-associated-widget") && found[0].getAttribute("data-associated-widget") !== widgetId) ||
        (found[0].closest(fieldSelector) && found[0].closest(fieldSelector) !== owner)) return fail("choice_popup_owner_mismatch");
    declared.push(found[0]);
  }
  const associated = [...root.querySelectorAll('[data-associated-widget]')]
    .filter(node => node.getAttribute("data-associated-widget") === widgetId);
  const local = [...owner.querySelectorAll('[role="listbox"],[data-automation-id="responsiveMonikerPrompt"]')]
    .filter(node => node.closest(fieldSelector) === owner && !node.closest('[data-automation-id="selectedItemList"]') &&
      (!node.getAttribute("data-associated-widget") || node.getAttribute("data-associated-widget") === widgetId));
  // Cardinality is a property of the bound widget, including its closed popup.
  const cardinalities = new Set([input,widget,...declared,...associated,...local]
    .map(node => node.getAttribute("aria-multiselectable"))
    .filter(value => value === "true" || value === "false"));
  if (cardinalities.size > 1) return fail("choice_cardinality_ambiguous");
  result.multiple = cardinalities.size ? cardinalities.has("true") : null;
  const candidates = [...new Set([...declared,...associated,...local].filter(visible))];
  // Nested listbox/prompt wrappers describe one popup, not multiple owners.
  const outer = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
  if (outer.length > 1 || declared.some(node => visible(node) && !outer.some(parent => parent === node || parent.contains(node)))) {
    return fail("choice_popup_ownership_ambiguous");
  }
  const popup = outer[0] || null;
  result.popup = popup;
  if (popup) {
    const associatedId = popup.getAttribute("data-associated-widget");
    if (popup.contains(input) || (associatedId && associatedId !== widgetId) || popup.closest('[data-automation-id="selectedItemList"]') ||
        (popup.closest(fieldSelector) && popup.closest(fieldSelector) !== owner)) return fail("choice_popup_owner_mismatch");
    result.popupStatus = popup.matches('[aria-busy="true"]') || popup.querySelector('[aria-busy="true"],[role="progressbar"]') ? "busy" : "ready";
    const selector = '[role="option"],[data-automation-id="promptOption"],[data-automation-id="promptLeafNode"]';
    const foreignBoundaries = [...popup.querySelectorAll('[data-associated-widget]')]
      .filter(boundary => boundary.getAttribute("data-associated-widget") !== widgetId);
    const nodes = [...popup.querySelectorAll(selector)].filter(node => visible(node) &&
      !node.closest('[data-automation-id="selectedItem"],[data-automation-id="selectedItemList"],[data-automation-id="promptCategory"]') &&
      (!node.closest(fieldSelector) || node.closest(fieldSelector) === owner) &&
      !foreignBoundaries.some(boundary => boundary.contains(node) || node.contains(boundary)));
    const tops = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
    for (const node of tops) {
      const semantic = node.matches('[data-automation-id="promptOption"]') ? [node] : [...node.querySelectorAll('[data-automation-id="promptOption"]')];
      if (semantic.length > 1) return fail("choice_option_label_ambiguous");
      const label = normalize((semantic[0] || node).textContent);
      const targets = [...node.querySelectorAll('input[type="radio"],[role="radio"],[data-automation-id="promptLeafNode"]')];
      const leaves = targets.filter(target => !targets.some(other => other !== target && target.contains(other)));
      if (leaves.length > 1) return fail("choice_option_target_ambiguous");
      const target = leaves[0] || node;
      if (label) result.options.push({node:target,label,disabled:!enabled(node) || !enabled(target)});
    }
  }
  result.valid = true;
  return result;
}
