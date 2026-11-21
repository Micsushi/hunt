export function createFabricControl({
  regionFor, norm, state, deepQuery, visible, editable, checkDeadline, bambooValue
}) {
  const fabricWidget = e => {
    if(!e.matches('button.fab-SelectToggle[type=button][data-menu-id]'))return null;
    const region=regionFor(e),container=e.closest('.fab-Select[data-fabric-component=Select]');
    if(!region.matches?.('form,[role=form]') || !container || container.querySelectorAll('button.fab-SelectToggle[data-menu-id]').length!==1)return null;
    const inputs=[...container.querySelectorAll('select[aria-hidden=true][readonly]')];
    if(inputs.length!==1 || regionFor(inputs[0])!==region || inputs[0].disabled)return null;
    const backing=inputs[0],labels=[...backing.labels??[]].filter(label=>label.control===backing);
    if(labels.length!==1)return null;
    const label=labels[0].textContent.replace(/[✱*]/g,'').trim();
    if(!['country','province','state'].includes(norm(label)) || !bambooValue(e).startsWith(label+' '))return null;
    const countries=[...region.querySelectorAll('select')].filter(select=>
      [...select.labels??[]].some(label=>label.control===select && norm(label.textContent)==='country'));
    if(countries.length!==1)return null;
    return {input:e,region,container,backing,label,country:countries[0],countryValue:countries[0].value};
  };
  const fabricState = widget => {
    const selected=widget.input.querySelector('.fab-SelectToggle__content')?.textContent?.trim()??'';
    const blank=!!widget.input.querySelector('.fab-SelectToggle__placeholder');
    if(blank ? selected!=='' || widget.backing.value!=='' : !selected || !widget.backing.value || bambooValue(widget.input)!==widget.label+' '+selected)return null;
    return JSON.stringify({label:selected,value:widget.backing.value});
  };
  const pendingFabricChange = widget => {
    const pending=state.unconfirmedFabric?.get(widget.input);
    if(pending && pending.backing===widget.backing && fabricState(widget)===pending.before) {
      state.unconfirmedFabric.delete(widget.input);return null;
    }
    return pending??null;
  };
  const sameFabric = widget => {
    const current=fabricWidget(widget.input);
    return !!current && current.container===widget.container && current.backing===widget.backing &&
      current.region===widget.region && current.country===widget.country &&
      (widget.country===widget.backing || current.countryValue===widget.countryValue);
  };
  const fabricToggle = e => e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,detail:1}));
  const fabricClear = widget => {
    const buttons=[...widget.container.querySelectorAll('button.fab-SelectToggle__clearButton[type=button][aria-label="Clear Selection"]')].filter(editable);
    return buttons.length===1?buttons[0]:null;
  };
  const fabricMenu = async (widget,leaveOpen=false) => {
    const e=widget.input,before=fabricState(widget),id=e.getAttribute('data-menu-id');
    if(!sameFabric(widget) || before===null || !editable(e) || e.getAttribute('aria-expanded')==='true' ||
      !id || e.hasAttribute('aria-controls') && e.getAttribute('aria-controls')!==id)throw new Error('The dropdown is not ready for inspection.');
    checkDeadline();fabricToggle(e);
    try {
      const start=Date.now();let options=[];
      do {
        await new Promise(resolve=>setTimeout(resolve,50));checkDeadline();
        if(!sameFabric(widget) || fabricState(widget)!==before || e.getAttribute('data-menu-id')!==id)throw new Error('The dropdown changed during inspection.');
        const menus=deepQuery(e.getRootNode(),`[id="${CSS.escape(id)}"]`);
        if(menus.length>1)throw new Error('The dropdown menu is ambiguous.');
        if(menus.length===1 && menus[0].getAttribute('role')==='menu' && visible(menus[0]))options=[...menus[0].querySelectorAll('[role=menuitem]')].filter(option=>visible(option) && option.getAttribute('aria-disabled')!=='true');
      } while(!options.length && Date.now()-start<2000);
      if(!options.length)throw new Error('The dropdown did not expose its options.');
      if(leaveOpen)return options;
      fabricToggle(e);await new Promise(resolve=>setTimeout(resolve,50));
      if(!sameFabric(widget) || fabricState(widget)!==before || e.getAttribute('aria-expanded')==='true')throw new Error('The inspected dropdown did not close unchanged.');
      return options.map(option=>option.textContent.trim());
    } catch(error) {
      if(sameFabric(widget) && fabricState(widget)===before && e.getAttribute('aria-expanded')==='true')fabricToggle(e);
      throw error;
    }
  };
  const selectFabric = async (change,value) => {
    const widget=change.fabric,target=JSON.parse(value),before=fabricState(widget);
    if(!sameFabric(widget) || !editable(widget.input) || before===null)throw new Error('The dropdown changed. Your edits were preserved.');
    if(before===value)return before;
    if(target.label==='') {
      const clear=fabricClear(widget);if(!clear)throw new Error('The dropdown no longer exposes its reset.');
      checkDeadline();clear.click();
    } else {
      const options=await fabricMenu(widget,true),matches=options.filter(option=>option.textContent.trim()===target.label);
      if(matches.length!==1){fabricToggle(widget.input);throw new Error('The dropdown choice is not unique.');}
      checkDeadline();matches[0].click();
    }
    await new Promise(resolve=>setTimeout(resolve,100));
    const after=fabricState(widget),actual=after && JSON.parse(after);
    if(!sameFabric(widget) || !actual || actual.label!==target.label || target.value!==null && actual.value!==target.value ||
      target.label!=='' && (!widget.backing.validity.valid || !fabricClear(widget)))throw new Error('The dropdown selection, backing value or reset could not be verified.');
    return after;
  };
  return { fabricWidget, fabricState, pendingFabricChange, sameFabric, fabricClear, fabricMenu, selectFabric };
}
