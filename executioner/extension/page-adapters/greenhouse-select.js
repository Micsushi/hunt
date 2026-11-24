// Greenhouse controls its menu on keyup. Its country picker renders only a flag and dial code after selection.
export function greenhouseChoices(fallback, state, regionFor, visible) {
  if (!['job-boards.greenhouse.io','job-boards.eu.greenhouse.io','boards.greenhouse.io'].includes(location.hostname)) return fallback;
  const selector = '.select-shell .select__control input.select__input[role=combobox][aria-autocomplete=list]';
  const inventories = state.selectInventories ??= new WeakMap();
  const key = (input, value) => {
    for (const type of ['keydown','keyup']) input.dispatchEvent(new KeyboardEvent(type,{key:value,code:value,bubbles:true,cancelable:true}));
  };
  const countryCode = node => {
    const flags = node.querySelectorAll('.iti__flag');
    return flags.length === 1 && [...flags[0].classList].find(value=>/^iti__[a-z]{2}$/.test(value))?.slice(5);
  };
  const choice = input => {
    if (!input.matches(selector) || !input.id || !input.form) return null;
    const widget = input.closest('.select-shell'), root = input.getRootNode(), owner = regionFor(input);
    if (widget.querySelectorAll('[role=combobox]').length !== 1 || widget.querySelector('.select__value-container--is-multi,.select__multi-value')) return null;
    const result = {kind:'greenhouse_single',widget,input,owner,root,widgetId:input.id,query:input.value,labels:[],pills:[],options:[],
      valid:false,empty:true,popup:null,popupStatus:'closed'};
    const selected = widget.querySelectorAll('.select__control .select__single-value');
    const country = input.id==='country' && !!widget.closest('.phone-input__country');
    let inventory = inventories.get(input);
    if (!inventory) {inventory={labels:[],countries:new Map()};inventories.set(input,inventory);}
    if (selected.length>1) return {...result,reason:'ambiguous_choice_selection'};
    if (input.getAttribute('aria-expanded')==='true') {
      const id=input.getAttribute('aria-controls'),lists=id && root.querySelectorAll('[id="'+CSS.escape(id)+'"]');
      if (!lists || lists.length!==1 || !widget.contains(lists[0]) || !lists[0].matches('[role=listbox]') ||
          lists[0].getAttribute('aria-multiselectable')==='true') return {...result,reason:'ambiguous_choice_menu'};
      result.popup=lists[0];result.popupStatus='ready';
      for (const node of lists[0].querySelectorAll('[role=option]')) {
        if (node.closest('[role=listbox]')!==lists[0] || !visible(node)) continue;
        let label=node.textContent.trim();
        if (country) {
          const match=/^(.+?)\s*\+(\d{1,4})$/.exec(label), code=countryCode(node);
          if (!match || !code) continue;
          label=match[1].trim();inventory.countries.set(code,{label,dial:'+'+match[2]});
        }
        if (label) result.options.push({node,label,disabled:node.getAttribute('aria-disabled')==='true'});
      }
    }
    if (selected.length) {
      let label=selected[0].textContent.trim();
      if (country) {
        const code=countryCode(selected[0]), entry=inventory.countries.get(code);
        if (!code || !/^\+\d{1,4}$/.test(label) || entry && entry.dial!==label) return {...result,reason:'country_selection_unconfirmed'};
        label=entry?.label ?? new Intl.DisplayNames(['en'],{type:'region'}).of(code.toUpperCase());
      }
      if (!label) return {...result,reason:'choice_selection_unconfirmed'};
      result.labels=[label];result.empty=false;
      const clear=widget.querySelectorAll('.select__indicators button[type=button][data-testid=clear-selection]');
      if (clear.length===1 && !clear[0].disabled) result.clear=()=>key(clear[0],'Enter');
    }
    result.retainsSelectionOnUndo=country;
    result.cachedOptions=inventory.labels;
    result.prepareQuery=()=>{if (input.getAttribute('aria-expanded')!=='true') key(input,'ArrowDown');};
    result.inspectOptions = async pause => {
      // City and education searches need a profile term. Degrees have a short complete first page.
      if (inventory.labels.length || input.value || selected.length || result.popup || /^(?:candidate-location|(?:school|discipline)--\d+)$/.test(input.id)) return;
      const previous=root.activeElement;
      if (previous!==input && previous?.matches('[role=combobox][aria-expanded=true]')) return;
      try {
        input.focus({preventScroll:true});key(input,'ArrowDown');
        for (let attempt=0;attempt<16;attempt++) {
          await pause();
          const current=choice(input);
          if (!input.isConnected || regionFor(input)!==owner) break;
          // The server-rendered input can be visible before React handles its first key.
          if (attempt===4 && input.getAttribute('aria-expanded')==='false' && root.activeElement===input) key(input,'ArrowDown');
          if (current?.popup && current.options.length) {
            inventory.labels=current.options.filter(option=>!option.disabled).map(option=>option.label);
            break;
          }
        }
      } finally {
        if(input.isConnected && input.getAttribute('aria-expanded')==='true')key(input,'Escape');
        if(root.activeElement===input && previous!==input) {
          input.blur();if(previous?.isConnected)previous.focus({preventScroll:true});
        }
      }
    };
    return {...result,valid:true};
  };
  return {
    sharedChoice:input=>choice(input)??fallback.sharedChoice(input),
    candidates:region=>[...fallback.candidates(region),...region.querySelectorAll(selector)],
    boundChoice(change) {
      const old=change.choiceWidget;
      if (old.kind!=='greenhouse_single') return fallback.boundChoice(change);
      const current=old.input.isConnected && choice(old.input);
      return current?.valid && current.widget===old.widget && current.widgetId===old.widgetId && current.owner===change.region ? current : null;
    },
    fieldLabel(input) {
      const year=input.matches('.education--form input[type=number]') && /^(start|end)-year--\d+$/.exec(input.id);
      return year ? 'Education '+year[1]+' date year' : undefined;
    },
    pairedPhone(input) {
      if (!input.matches('.phone-input__phone input[type=tel]')) return null;
      const group=input.closest('fieldset.phone-input'), pickers=group?.querySelectorAll('.phone-input__country '+selector);
      if (!group || group.querySelectorAll('input[type=tel]').length!==1 || pickers.length!==1 || pickers[0].form!==input.form) return {country:null};
      const selected=choice(pickers[0]);
      const dial=selected?.widget.querySelector('.select__control .select__single-value')?.textContent.trim().replace(/^\+/,'');
      return {country:selected?.labels[0]??null,dial};
    },
  };
}
