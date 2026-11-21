export function ripplingLocationChoices(fallback, state, regionFor, visible) {
  if (location.hostname !== 'ats.rippling.com' || !/\/jobs\/[^/]+\/apply\/?$/.test(location.pathname)) return fallback;
  const selector = '[data-testid=location] input[aria-autocomplete=list][aria-haspopup=listbox]';
  const receipts = state.ripplingLocations ??= new WeakMap();
  const locationChoice = input => {
    if (!input.matches(selector)) return null;
    const widget = input.closest('[data-testid=location]'), root = input.getRootNode(), owner = regionFor(input);
    const result = {kind:'rippling_location', input, widget, owner, root, widgetId:input.id, labels:[], pills:[], options:[],
      popup:null, popupStatus:'closed', query:input.value, empty:true, valid:false};
    const labelId = input.getAttribute('aria-labelledby'), label = labelId && root.getElementById(labelId);
    if (!input.id || widget.querySelectorAll('input').length !== 1 || !label ||
        labelId !== input.id+'-label' || label.textContent.trim().replace(/\s*\*$/, '') !== 'Location') {
      return {...result,reason:'ambiguous_location_widget'};
    }
    const menuId = input.getAttribute('aria-controls');
    const lists = menuId ? root.querySelectorAll('[id="'+CSS.escape(menuId)+'"]') : [];
    if (widget.querySelectorAll('[role=listbox]').length > lists.length || lists.length > 1) return {...result,reason:'ambiguous_location_menu'};
    // The closed widget can retain aria-controls after the results have unmounted.
    if (lists.length) {
      if (!widget.contains(lists[0]) || !lists[0].matches('ul[role=listbox][data-testid=menuList]') ||
          lists[0].getAttribute('aria-labelledby') !== labelId) return {...result,reason:'ambiguous_location_menu'};
      if (visible(lists[0])) {
        result.popup=lists[0];result.popupStatus=lists[0].getAttribute('aria-busy')==='true'?'loading':'ready';
        for (const node of lists[0].querySelectorAll('li[role=option][data-selectable=true]')) {
          const labels=node.querySelectorAll('[data-testid=menuListLabel]');
          if (visible(node) && labels.length===1) result.options.push({node,label:labels[0].textContent.trim(),disabled:node.getAttribute('aria-disabled')==='true'});
        }
      }
    }
    const receipt=receipts.get(input);
    if (receipt && receipt.widget===widget && receipt.value===input.value) {
      result.labels=[receipt.value];result.query='';result.empty=false;
      result.clear = write => write(input,'');
    }
    result.confirmClick = async (value, pause) => {
      // Rippling exposes no persisted selected-row marker. Require the actual option click, the closed menu and blur.
      for(let attempt=0;attempt<20;attempt++) {
        await pause();
        if (!input.isConnected || regionFor(input)!==owner || input.closest('[data-testid=location]')!==widget) return;
        const current=locationChoice(input);
        if (input.value===value && current?.valid && !current.popup) break;
      }
      const clicked=locationChoice(input);
      if(input.value!==value || !clicked?.valid || clicked.popup)return;
      if(root.activeElement===input)input.blur();
      await pause();
      if(!input.isConnected || input.closest('[data-testid=location]')!==widget || regionFor(input)!==owner ||
          input.value!==value || !locationChoice(input)?.valid || locationChoice(input)?.popup || input.getAttribute('aria-invalid')==='true' || !input.validity.valid)return;
      receipts.set(input,{widget,value});
      input.addEventListener('input',()=>receipts.delete(input),{once:true});
    };
    return {...result,valid:true};
  };
  return {
    sharedChoice: input=>locationChoice(input)??fallback.sharedChoice(input),
    candidates: region=>[...fallback.candidates(region),...region.querySelectorAll(selector)],
    boundChoice: change=>{
      const old=change.choiceWidget;
      if(old.kind!=='rippling_location')return fallback.boundChoice(change);
      const current=old.input.isConnected && locationChoice(old.input);
      return current?.valid && current.widget===old.widget && current.owner===change.region ? current : null;
    },
  };
}
