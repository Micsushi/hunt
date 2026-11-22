export function ripplingLocationChoices(fallback, state, regionFor, visible) {
  if (location.hostname !== 'ats.rippling.com' || !/\/jobs\/[^/]+\/apply\/?$/.test(location.pathname)) return fallback;
  const selector = '[data-testid=location] input[aria-autocomplete=list][aria-haspopup=listbox]';
  const receipts = state.ripplingLocations ??= new WeakMap();
  const locationChoice = input => {
    if (!input.matches(selector)) return null;
    const widget = input.closest('[data-testid=location]'), root = input.getRootNode(), owner = regionFor(input);
    const result = {kind:'rippling_location', observation:{widget:'rippling-location', resumableProfileQuery:true}, input, widget, owner, root, widgetId:input.id, labels:[], pills:[], options:[],
      popup:null, popupStatus:'closed', query:input.value, empty:true, valid:false};
    const labelId = input.getAttribute('aria-labelledby'), label = labelId && root.getElementById(labelId);
    if (!input.id || widget.querySelectorAll('input').length !== 1 || !label ||
        labelId !== input.id+'-label' || label.textContent.trim().replace(/\s*\*$/, '') !== 'Location') {
      return {...result,reason:'ambiguous_location_widget'};
    }
    const form=input.form;
    const placeIds=form?.querySelectorAll('input[type=hidden][data-testid=input-externalPlaceId]');
    if (!form || form.querySelectorAll(selector).length!==1 || placeIds.length!==1 || placeIds[0].form!==form) {
      return {...result,reason:'ambiguous_location_backing'};
    }
    const placeId=placeIds[0];result.backingControl=placeId;
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
    if (placeId.value) {
      if (!input.value.trim() || result.popup) return {...result,reason:'location_selection_unconfirmed'};
      result.labels=[input.value];result.query='';result.empty=false;
      if (receipt?.widget===widget && receipt.value===input.value && receipt.placeId===placeId.value) {
        result.clear = write => write(input,'');
      }
    }
    result.prepareQuery = (query, write) => {
      if (result.query === query && !result.popup) write(input, '');
    };
    result.canResumeQuery = (plan, options, fact, norm) => {
      const query = result.query;
      if (query !== fact('city') || query.includes(',')) return false;
      if (query === plan.query) return true;
      if (plan.reason !== 'profile_answer' || typeof plan.answer !== 'string') return false;
      const parts = plan.answer.split(',');
      return parts.length === 3 && norm(parts[0]) === norm(query) && options.includes(plan.answer);
    };
    result.confirmClick = async (value, pause) => {
      // Rippling writes the chosen identifier into a separate field owned by the application form.
      const selected = () => {
        const current=input.isConnected && locationChoice(input);
        return current?.valid && current.owner===owner && current.widget===widget && current.backingControl===placeId &&
          current.labels[0]===value && input.validity.valid && input.getAttribute('aria-invalid')!=='true';
      };
      for(let attempt=0;attempt<20 && !selected();attempt++) await pause();
      if (!selected())return;
      if(root.activeElement===input)input.blur();
      await pause();
      if (!selected())return;
      receipts.set(input,{widget,value,placeId:placeId.value});
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
      return current?.valid && current.widget===old.widget && current.backingControl===old.backingControl && current.owner===change.region ? current : null;
    },
  };
}
