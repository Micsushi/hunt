// OneClick renders each suggestion in a dropdown item's shadow root and slots its full location label.
export function smartRecruitersCityChoices(fallback, form, deepQuery, composedClosest, visible) {
  if (!form) return fallback;
  const selector = 'input[role=combobox][aria-autocomplete=list]';
  const city = input => {
    if (!input.matches(selector)) return null;
    const widget = composedClosest(input,'spl-autocomplete[data-test=location-autocomplete]');
    const owner = widget && composedClosest(widget,'oc-location-autocomplete');
    if (!owner || form.region(input) !== form.owner) return null;
    const menuId = input.getAttribute('aria-controls');
    const lists = menuId ? deepQuery(widget,'[role=listbox]').filter(list => list.id === menuId) : [];
    const result = {kind:'smartrecruiters_city', widget, owner, widgetId:widget.id, input, root:widget,
      query:input.value, labels:[], pills:[], options:[], popup:null, popupStatus:'closed', empty:false, valid:false};
    if (!form.current() || deepQuery(owner,'spl-autocomplete[data-test=location-autocomplete]').length !== 1 ||
        deepQuery(widget,selector).length !== 1 || lists.length !== 1) return {...result,reason:'ambiguous_location_widget'};
    const expanded = input.getAttribute('aria-expanded') === 'true';
    const committed = widget.hasAttribute('value');
    if (committed) {
      const clear = deepQuery(widget,'spl-icon[role=button][aria-label]').filter(node =>
        node.getAttribute('aria-label') === 'Clear '+widget.getAttribute('label')+' value' && visible(node) &&
        node.getAttribute('aria-disabled') !== 'true');
      if (!input.value.trim() || clear.length !== 1 || input.getAttribute('aria-invalid') !== 'false') {
        return {...result,reason:'location_selection_unconfirmed'};
      }
      result.labels.push(input.value);
      result.pills.push({remove:clear[0]});
    }
    if (expanded && visible(lists[0])) {
      result.popup = lists[0];
      result.popupStatus = 'ready';
      for (const item of deepQuery(widget,'spl-dropdown-item').filter(visible)) {
        const options = [...item.shadowRoot?.querySelectorAll('[role=option]')??[]];
        if (options.length !== 1 || !visible(options[0])) continue;
        let ancestor = item;
        while (ancestor && ancestor !== lists[0]) ancestor = ancestor.assignedSlot || ancestor.parentNode || ancestor.host;
        if (!ancestor) continue;
        const labels = item.querySelectorAll('.c-spl-autocomplete-default-option [data-sr-id$="-content"] spl-truncate[title]');
        if (labels.length === 1 && labels[0].title.trim()) {
          result.options.push({node:options[0],label:labels[0].title.trim(),disabled:options[0].getAttribute('aria-disabled')==='true'});
        }
      }
    }
    result.empty = !committed;
    result.valid = true;
    return result;
  };
  return {
    sharedChoice: input => city(input) ?? fallback.sharedChoice(input),
    candidates: region => [...fallback.candidates(region),...deepQuery(region,selector)],
    boundChoice: change => {
      const original = change.choiceWidget;
      if (original.kind !== 'smartrecruiters_city') return fallback.boundChoice(change);
      const current = original.input.isConnected && city(original.input);
      return current?.valid && current.widget === original.widget && current.owner === original.owner &&
        form.region(current.input) === change.region ? current : null;
    }
  };
}
