export function createControlInteraction({ state, checkDeadline, boundChoice, editable, visible, choiceState }) {
  // select.value exposes only the first selected option. Journal the whole set
  // so an additional owner selection prevents a subsequent undo.
  const optionKey = option => JSON.stringify([option.value, option.label.trim()]);
  const selection = select => JSON.stringify([...select.selectedOptions].map(optionKey).sort());
  const write = (e, value) => {
    if (e.type === 'file') {
      const transfer = new DataTransfer();
      if (value instanceof File) transfer.items.add(value);
      let observed=false;
      const capture=event=> {
        if(observed || event.composedPath()[0]!==e || !e.files?.length)return;
        observed=true;state.fileEvents??=new WeakMap();state.fileEvents.set(e,e.files.length===1?e.files[0]:null);
        if(state.resumeAttempt?.element===e && state.resumeAttempt.file===value)state.resumeAttempt.selectedFileAccepted=e.files.length===1 && e.files[0]===value;
      };
      state.fileEvents??=new WeakMap();state.fileEvents.delete(e);
      document.addEventListener('input',capture,true);document.addEventListener('change',capture,true);
      try {
        e.files = transfer.files;
        e.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      } finally {document.removeEventListener('input',capture,true);document.removeEventListener('change',capture,true);}
      return;
    }
    if (e.type === 'select-multiple') {
      const wanted = JSON.parse(value);
      const options = [...e.options];
      if (!Array.isArray(wanted) || wanted.some(key => {
        const matches = options.filter(option => optionKey(option) === key);
        return matches.length !== 1 || matches[0].matches(':disabled') || matches[0].closest('[hidden]') ||
          options.filter(option => option.value === matches[0].value).length !== 1;
      })) {
        throw new Error('The website changed the available choices.');
      }
      for (const option of options) option.selected = wanted.includes(optionKey(option));
    } else {
      const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, typeof value === 'boolean' ? 'checked' : 'value').set.call(e, value);
    }
    e.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const choicePause = async () => {await new Promise(resolve=>setTimeout(resolve,50));checkDeadline();};
  const choiceKey = (input,key) => {
    for(const type of ['keydown','keyup']) input.dispatchEvent(new KeyboardEvent(type,{key,code:key,bubbles:true,cancelable:true}));
  };
  const closeChoice = change => {
    const current=boundChoice(change);
    if(current?.popup) choiceKey(current.input,'Escape');
  };
  const queryChoice = async (change,query) => {
    let current=boundChoice(change);
    if(!current || !editable(current.input) || current.labels.length)throw new Error('The search selection changed.');
    const form=current.input.form;
    // Search Enter is allowed only on this structurally owned search input.
    // Its default form submission is blocked while the search is dispatched.
    const preventSubmit=event=>{event.preventDefault();event.stopImmediatePropagation();};
    form?.addEventListener('submit',preventSubmit,true);
    try {
      current.input.focus();write(current.input,query);
      current=boundChoice(change);
      if(!current || current.query!==query)throw new Error('The search query was not retained.');
      if(current.input.getAttribute('enterkeyhint')==='search')choiceKey(current.input,'Enter');
      const started=Date.now();
      do {
        await choicePause();current=boundChoice(change);
        if(!current || !editable(current.input))throw new Error('The search selection lost its owner.');
        if(current.labels.length || current.popupStatus==='ready' && current.options.length)break;
      }while(Date.now()-started<1800);
      return current;
    } finally {form?.removeEventListener('submit',preventSubmit,true);}
  };
  const choiceClick = node => {
    const action=node.closest('button,input,a[href]');
    if(action && (action.matches('a[href],input[type=submit],input[type=image]') || action.tagName==='BUTTON' && action.type==='submit' && action.form))throw new Error('The choice action could submit or navigate.');
    node.click();
  };
  const selectChoice = async (change,label) => {
    let current=boundChoice(change);
    if(!current || current.labels.length)throw new Error('An existing selection was preserved.');
    if(current.popupStatus!=='ready' || !current.options.some(option=>option.label===label)) {
      current=await queryChoice(change,change.searchQuery||label);
    }
    if(current.labels.length) {
      if(current.labels.length!==1 || current.labels[0]!==label)throw new Error('The search committed a different selection.');
    } else {
      const matches=current.options.filter(option=>!option.disabled && option.label===label);
      if(current.popupStatus!=='ready' || matches.length!==1 || !visible(matches[0].node))throw new Error('The owned choice is not unique.');
      checkDeadline();choiceClick(matches[0].node);
      const started=Date.now();
      do {await choicePause();current=boundChoice(change);if(!current || current.labels.length)break;}while(Date.now()-started<1800);
    }
    if(!current || current.labels.length!==1 || current.labels[0]!==label || current.pills.length!==1 || !current.pills[0].remove)throw new Error('The selection or its reset was not confirmed.');
    closeChoice(change);await choicePause();
    current=boundChoice(change);
    if(!current || current.labels.length!==1 || current.labels[0]!==label || !current.pills[0]?.remove || current.input.validity?.valid===false || current.input.getAttribute('aria-invalid')==='true')throw new Error('The selected item changed or was rejected.');
    return choiceState(current);
  };
  const restoreChoice = async (change,value) => {
    const desired=JSON.parse(value);let current=boundChoice(change);
    if(!current || !editable(current.input))throw new Error('The selection owner changed.');
    if(desired.labels.length===0) {
      if(current.labels.length) {
        if(current.labels.length!==1 || current.pills.length!==1 || !current.pills[0].remove || !visible(current.pills[0].remove))throw new Error('The selection cannot be safely removed.');
        choiceClick(current.pills[0].remove);await choicePause();current=boundChoice(change);
        if(!current || !current.empty)throw new Error('The website did not remove the selection.');
      }
      write(current.input,desired.query);await choicePause();closeChoice(change);
    } else {
      if(desired.labels.length!==1)throw new Error('The saved selection is ambiguous.');
      await selectChoice(change,desired.labels[0]);current=boundChoice(change);
      if(!current || current.query!==desired.query) {
        if(!current)throw new Error('The selection owner changed.');
        write(current.input,desired.query);await choicePause();closeChoice(change);
      }
    }
    if(choiceState(boundChoice(change))!==value)throw new Error('The website did not keep the restored selection.');
  };
  return { write, queryChoice, closeChoice, selectChoice, restoreChoice, choicePause, optionKey, selection };
}
