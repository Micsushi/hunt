/** Read-only candidate discovery shared by service and extension chooser interception. */
export function bambooResumeControl() {
  const state=globalThis.__huntC3PartialFill;
  if (state?.resumeAttempt || state?.busy) return null;
  const forms=[...document.querySelectorAll('form')].filter(form=>form.querySelector('input[type=email],input[type=text][name=email]') &&
    ![...form.querySelectorAll('input[type=password]')].some(e=>e.getClientRects().length));
  const norm=text=>String(text??'').replace(/[✱*]/g,'').trim().toLowerCase();
  const candidates=[];
  for (const form of forms) for (const input of form.querySelectorAll('input[type=file]')) {
    if (input.disabled || input.multiple || input.matches(':disabled') || input.closest('[inert],[aria-hidden=true]') || state?.nativeFileBindings?.has(input)) continue;
    const style=getComputedStyle(input);
    if (input.getClientRects().length && style.visibility!=='hidden' && Number(style.opacity)>0) continue;
    for (let group=input.parentElement,depth=0;group && group!==form && depth<5;group=group.parentElement,depth++) {
      if (group.querySelectorAll('input[type=file]').length!==1 || [...group.querySelectorAll('input,textarea,select')].some(e=>e!==input && !e.matches('input[type=hidden][name=resumeFileId]'))) break;
      const lines=(group.innerText??'').split('\n').map(norm).filter(Boolean);
      if (lines[0]!=='resume' && lines[0]!=='résumé') continue;
      if (/uploaded successfully|remove file/i.test(group.innerText)) break;
      const buttons=[...group.querySelectorAll('button[type=button]')].filter(button=>
        norm(button.textContent)==='choose file' && button.getClientRects().length>0 && getComputedStyle(button).visibility!=='hidden' &&
        !button.disabled && !button.closest('[inert],[aria-hidden=true]'));
      if (buttons.length===1) candidates.push({input,button:buttons[0],group,form});
      break;
    }
  }
  return candidates.length===1 ? candidates[0] : null;
}

/** Runs in the extension's isolated world. Keep self-contained for executeScript. */
export async function fillVisibleFields({ facts = [], action = 'fill', scope = 'application', expectedUrl, expiresAt, resume, replaceExistingResume = false, matchingPlans, matchingRunId } = {}) {
  const checkDeadline = () => { if (expiresAt !== undefined && Date.now() >= expiresAt) throw new Error('Field changes expired. Check the page and reopen C3 before retrying.'); };
  checkDeadline();
  if (expectedUrl !== undefined && location.href !== expectedUrl) throw new Error('The page changed. Reopen C3 on the application.');
  const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[✱*]/g, '').replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();
  const state = globalThis.__huntC3PartialFill ??= { undo: [], redo: [], busy: false };
  if (state.busy) throw new Error('A field fill is already running.');
  state.busy = true;
  const result = { status: 'partial', filled: [], skipped: [], canUndo: false, canRedo: false, matching: [],
    resume: /** @type {'verified'|'missing'|'unverified'|'optional'} */ ('missing') };
  const changes = [];
  const touchedChoices = new Set();
  const deepQuery = (root, selector) => {
    const matches = [...root.querySelectorAll(selector)];
    if (root.shadowRoot) matches.push(...deepQuery(root.shadowRoot,selector));
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) matches.push(...deepQuery(host.shadowRoot, selector));
    }
    return matches;
  };
  const composedClosest = (element, selector) => {
    for (let current = element; current; current = current.getRootNode().host) {
      const match = current.closest(selector);
      if (match) return match;
    }
    return null;
  };
  const composedParent = e => e.parentElement || e.getRootNode().host || null;
  const composedContains = (parent, child) => {
    for (let node=child; node; node=composedParent(node)) if (node===parent) return true;
    return false;
  };
  const jobviteProof = e => {
    const proof=state.nativeFileBindings?.get(e);
    if (proof?.kind!=='jobvite' || typeof proof.valid!=='function') return null;
    try {return proof.valid()?proof:null;} catch {return null;}
  };
  const regionFor = e => jobviteProof(e)?.region || e.form || composedClosest(e, 'form,[role=form]') || e.getRootNode();
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
  const bambooValue = e => e.getAttribute('aria-label') ?? '';
  const bambooProvinceContext = e => {
    const region=regionFor(e),container=e.parentElement;
    if (!location.hostname.endsWith('.bamboohr.com') || !region.matches?.('form#job-application-form') ||
        !e.matches('button.fab-SelectToggle[type=button][data-menu-id][aria-label^="Province "]') ||
        !container?.matches('.fab-SelectToggle__container') ||
        container.querySelectorAll('button.fab-SelectToggle[aria-label^="Province "]').length!==1) return null;
    const countries=[...region.querySelectorAll('button.fab-SelectToggle[aria-label="Country Canada"]')].filter(visible);
    if (countries.length!==1) return null;
    const contents=[...e.querySelectorAll('.fab-SelectToggle__content')];
    if (bambooValue(e)!=='Province –Select–' && (contents.length!==1 || norm(contents[0].textContent)!==norm(bambooValue(e).slice(9)))) return null;
    return {region,container,country:countries[0]};
  };
  const sameBambooContext = (e,expected) => {
    const current=bambooProvinceContext(e);
    return !!current && current.region===expected?.region && current.container===expected?.container && current.country===expected?.country;
  };
  const bambooClear = e => {
    if (!bambooProvinceContext(e)) return null;
    const matches = [...e.parentElement.querySelectorAll('button.fab-SelectToggle__clearButton[type=button][aria-label="Clear Selection"]')];
    return matches.length === 1 && editable(matches[0]) ? matches[0] : null;
  };
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const editable = e => visible(e) && !composedClosest(e, '[aria-hidden="true"],[inert]') && !e.disabled && !e.readOnly;
  const jazzAddressLabel = e => {
    const labels={'resumator-address-value':'Address','resumator-city-value':'City','resumator-state-value':'State/Province','resumator-postal-value':'Postal'};
    const expected=labels[e.id],group=e.closest('.form-group#resumator-address');
    if (!expected || !group || e.name!==e.id || e.type!=='text' || e.placeholder!==expected ||
        e.closest('.form-group')!==group || !group.querySelector('#resumator-address-field')?.contains(e)) return '';
    const heading=[...group.children].filter(child=>child.matches('label#resumator-address-label[for="resumator-address-value"]'));
    if (heading.length!==1 || norm(heading[0].textContent)!=='address' || heading[0].control?.id!=='resumator-address-value' ||
        e.getRootNode().querySelectorAll(`[id="${e.id}"]`).length!==1) return '';
    return expected==='Postal'?'Postal code':expected;
  };
  const semanticChoiceButton = e => e.tagName==='BUTTON' && (e.getAttribute('aria-haspopup')==='listbox' || e.getAttribute('role')==='combobox') && !fabricWidget(e);
  const rawLabelFor = element => {
    if(semanticChoiceButton(element)) {
      const owned=[...element.labels??[]].filter(label=>label.control===element);
      if(owned.length && element.id && deepQuery(element.getRootNode(),`[id="${CSS.escape(element.id)}"]`).length===1) {
        return owned.map(label=>{const copy=label.cloneNode(true);copy.querySelectorAll('button,input,select,textarea').forEach(node=>node.remove());return copy.textContent;}).join(' ').trim();
      }
    }
    const fabric=fabricWidget(element);
    if(fabric)return [...fabric.backing.labels??[]].map(label=>label.textContent).join(' ').trim();
    const ids=(element.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
    const labelled=ids.map(id=>[...element.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`)]);
    const refs=labelled.length && labelled.every(matches=>matches.length===1) ? labelled.filter(matches=>!semanticChoiceButton(element) || matches[0]!==element && !element.contains(matches[0])).map(matches=>matches[0].textContent??'').join(' ').trim() : '';
    return refs || element.getAttribute('aria-label') || [...element.labels ?? []].map(l => {
      const copy = l.cloneNode(true); copy.querySelectorAll('input,textarea,select,button').forEach(e => e.remove()); return copy.textContent;
    }).join(' ').trim() || jazzAddressLabel(element) || ({'given-name':'First name','family-name':'Last name',name:'Full name',email:'Email',tel:'Phone','address-line1':'Address line 1','address-line2':'Address line 2','address-level2':'City','address-level1':'State','postal-code':'Postal code','country-name':'Country'}[element.autocomplete]) || element.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ') || element.placeholder;
  };
  const labelFor = element => element.getAttribute('data-hunt-question-context') ?? rawLabelFor(element);
  const resumeLabel = text => /^(?:(?:upload|attach|add) )?(?:your )?(?:resume|résumé|cv|resume\s*\/\s*cv|cv or resume)$/i.test(norm(text));
  const otherAttachment = text => /\b(?:cover\s*letter|photo(?:graph)?|headshot|transcript|certificate|portfolio)\b/i.test(norm(text));
  const sharedChoice = e => {
    const recognized=e.matches?.('input[data-uxi-widget-type="selectinput"]');
    try {
      const result=globalThis.__huntC3ChoiceWidget?.(e);
      if(result)return result;
    }catch {}
    return recognized?{kind:'owned_search_choice',valid:false,reason:'choice_inspector_unavailable',input:e,query:e.value,labels:[],pills:[],options:[],popupStatus:'ambiguous',empty:false}:null;
  };
  const boundChoice = change => {
    const original=change.choiceWidget;
    if(!original?.widget?.isConnected || !original.owner?.isConnected)return null;
    const inputs=[...original.widget.querySelectorAll('input[data-uxi-widget-type="selectinput"]')].filter(input=>input.getAttribute('data-uxi-multiselect-id')===original.widgetId);
    const current=inputs.length===1?sharedChoice(inputs[0]):null;
    return current?.valid && current.widget===original.widget && current.owner===original.owner && current.widgetId===original.widgetId && regionFor(current.input)===change.region?current:null;
  };
  const choiceState = widget => widget?.valid?JSON.stringify({labels:widget.labels,query:widget.query}):null;
  const pendingChoice = widget => {
    if(!widget?.widget)return null;
    const pending=state.unconfirmedChoices?.get(widget.widget) || state.unconfirmedChoiceHistory?.find(change=>
      !change.choiceWidget.widget.isConnected && change.region?.isConnected && regionFor(widget.input)===change.region &&
      (change.choiceWidget.widgetId===widget.widgetId || change.choiceWidget.owner===widget.owner &&
        change.choiceWidget.input.id && change.choiceWidget.input.id===widget.input.id &&
        deepQuery(widget.root,`[id="${CSS.escape(widget.input.id)}"]`).length===1) && choiceState(widget)!==change.before);
    if(pending && choiceState(widget)===pending.before) {state.unconfirmedChoices.delete(widget.widget);return null;}
    return pending;
  };
  const fileBinding = e => {
    if (!e.isConnected || e.type !== 'file' || e.disabled || e.readOnly || e.matches(':disabled') || composedClosest(e,'[inert]')) return null;
    const wrappingLabel = e.closest('label');
    if (wrappingLabel && wrappingLabel.control !== e) return null;
    const labels = [...e.labels ?? []].filter(label=>label.control === e);
    const widgetVisible = node => visible(node) && Number(getComputedStyle(node).opacity) > 0;
    const nativeVisible = editable(e) && widgetVisible(e);
    const proven=state.nativeFileBindings?.get(e);
    if (proven?.kind==='jobvite') {
      const proof=jobviteProof(e);
      return proof && !e.multiple ? {label:'Resume',widget:proof.label} : null;
    }
    if (proven && regionFor(e)===proven.region &&
        proven.region.isConnected && proven.group.isConnected && proven.button.isConnected &&
        proven.group.contains(e) && proven.group.contains(proven.button) &&
        deepQuery(proven.group,'input[type=file]').length===1 && widgetVisible(proven.button) &&
        !composedClosest(proven.button,'[inert],[aria-hidden=true]') &&
        resumeLabel((proven.group.innerText??'').split('\n').find(line=>line.trim())??'') &&
        !proven.button.disabled && proven.button.type==='button' && norm(proven.button.textContent)==='choose file') {
      return {label:'Resume',widget:proven.button};
    }
    if ([e,...labels].some(node=>(node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .some(id=>node.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`).length>1))) return null;
    const refs = node => (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).flatMap(id => {
      const matches = [...node.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`)];
      return matches.length === 1 && matches[0] !== e && widgetVisible(matches[0]) ? matches : [];
    });
    const text = [e.getAttribute('aria-label') ?? '', ...refs(e).map(node=>node.textContent ?? ''),
      ...labels.flatMap(label=>[label.getAttribute('aria-label') ?? '', ...refs(label).map(node=>node.textContent ?? ''), label.textContent ?? ''])];
    if (text.some(otherAttachment)) return null;
    const boundLabels = labels.filter(label=>widgetVisible(label) && !composedClosest(label,'[aria-hidden="true"],[inert]') &&
      deepQuery(label,'input[type=file]').length <= 1);
    const uploadGroup=composedClosest(e,'[role=group][aria-labelledby]');
    if (uploadGroup && uploadGroup!==regionFor(e)) {
      const ids=(uploadGroup.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
      const names=ids.length===1 ? [...uploadGroup.getRootNode().querySelectorAll(`[id="${CSS.escape(ids[0])}"]`)] : [];
      if (names.length!==1 || !widgetVisible(names[0])) return null;
      const namedGroups=deepQuery(uploadGroup.getRootNode(),'[role=group][aria-labelledby]').filter(group=>
        (group.getAttribute('aria-labelledby')??'').split(/\s+/).includes(ids[0]));
      const labelGroup=names[0].closest('[role=group]');
      if(namedGroups.length!==1 || regionFor(names[0])!==regionFor(e) || labelGroup && labelGroup!==uploadGroup)return null;
      const name=names[0].textContent??'';
      if (otherAttachment(name)) return null;
      if (resumeLabel(name)) {
        if (!widgetVisible(uploadGroup) || composedClosest(uploadGroup,'[aria-hidden=true],[inert]') ||
            deepQuery(uploadGroup,'input,textarea,select').some(control=>control!==e)) return null;
        if (nativeVisible || boundLabels.length===1 && composedContains(uploadGroup,boundLabels[0])) return {label:'Resume',widget:uploadGroup};
        return null;
      }
    }
    if (text.some(resumeLabel)) {
      if (nativeVisible) return {label:'Resume', widget:e};
      if (boundLabels.length === 1) return {label:'Resume', widget:boundLabels[0]};
    }
    // Some native inputs have only a technical aria-label. Stay inside their
    // nearest small upload field, never a whole form or an unrelated heading.
    const region = regionFor(e);
    let group = composedParent(e);
    for (let depth=0; depth<6 && group && group !== region && group !== document.body; depth++,group=composedParent(group)) {
      if (deepQuery(group,'input[type=file]').length !== 1 ||
          deepQuery(group,'input,textarea,select').some(control=>control!==e && control.type!=='hidden')) return null;
      if (!widgetVisible(group) || composedClosest(group,'[aria-hidden="true"],[inert]')) continue;
      const lines=(group.innerText ?? '').split(/\n/).map(line=>line.trim()).filter(Boolean);
      if (lines.some(otherAttachment)) return null;
      const headings=[...group.children].filter(child=>child.matches('h1,h2,h3,h4,h5,h6,[role=heading],spl-typography-title[data-test="section-title"]'));
      if (!resumeLabel(lines[0] ?? '') && !(headings.length===1 && resumeLabel(headings[0].textContent))) continue;
      const visibleWidget=nativeVisible || boundLabels.some(label=>composedContains(group,label));
      if (visibleWidget) return {label:'Resume',widget:group};
    }
    return null;
  };
  const uploadOwner = e => {
    const proven=state.nativeFileBindings?.get(e)?.group;
    for(let group=proven??composedParent(e),depth=0;group && depth<6 && group!==regionFor(e) && group!==document.body;group=composedParent(group),depth++) {
      if(deepQuery(group,'input[type=file]').length>1 || deepQuery(group,'input,textarea,select').some(control=>control!==e && control.type!=='hidden'))return null;
      if(resumeLabel((group.innerText??'').split('\n').find(line=>line.trim())??''))return group;
    }
    return null;
  };
  const attachmentIds = group => [...group.querySelectorAll('input[type=hidden]')].filter(input=>
    /^(?:(?:resume|cv|attachment|upload|file)[_.-]?)*(?:file[_.-]?)?id$/i.test(input.name) && input.name.toLowerCase()!=='id');
  const uploadSuccess = (owner,fileName) => [...owner.querySelectorAll('[role=status],[aria-live]')].filter(node=>
    norm(node.textContent)===norm(`File ${fileName} uploaded successfully`));
  const uploadRemoveControls = (owner,fileName) => [...owner.querySelectorAll('button,[role=button]')].filter(button=> {
    if(button.disabled || button.getAttribute('aria-disabled')==='true')return false;
    const refs=(button.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
    const labels=refs.map(id=>[...owner.querySelectorAll(`[id="${CSS.escape(id)}"]`)]);
    const name=refs.length && labels.every(matches=>matches.length===1) ? labels.map(matches=>matches[0].textContent).join(' ') : button.getAttribute('aria-label')||button.textContent;
    return ['remove','delete','remove file','delete file','remove attachment','delete attachment',`remove ${fileName}`,`delete ${fileName}`].some(expected=>norm(name)===norm(expected));
  });
  const ownedUploadCompleted = receipt => {
    const group=receipt?.owner;
    if(!group?.isConnected || !receipt.region.isConnected || !receipt.region.contains(group) ||
       !receipt.selectedFileAccepted || state.fileEvents?.get(receipt.element)!==receipt.file || !receipt.fileSha256 || receipt.clientInvalidated || receipt.hadAttachmentId || receipt.hadUploadSuccess ||
       receipt.element.isConnected && (!group.contains(receipt.element) || regionFor(receipt.element)!==receipt.region))return false;
    const ids=attachmentIds(group).filter(input=>input.value);
    if(uploadRemoveControls(group,receipt.file.name).length!==1 || !group.textContent.includes(receipt.file.name) ||
       group.matches('[aria-busy=true],[aria-invalid=true]') || group.querySelector('[aria-busy=true],[role=progressbar],[aria-invalid=true]') ||
       /\b(?:uploading|upload failed|upload error|invalid file)\b/i.test(group.innerText??''))return false;
    if(ids.length===1) {
      const id=ids[0].name+':'+ids[0].value;
      if(receipt.attachmentId && receipt.attachmentId!==id)return false;
      receipt.attachmentId=id;return true;
    }
    if(ids.length || receipt.attachmentId)return false;
    if(receipt.clientOnly) {
      const heading=receipt.clientHeading,ids=(group.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
      const headings=ids.length===1?[...group.getRootNode().querySelectorAll(`[id="${CSS.escape(ids[0])}"]`)]:[];
      const filenames=[...group.querySelectorAll('p')].filter(node=>node.textContent.trim()===receipt.file.name);
      if(group.getAttribute('data-allow-s3')!=='false' || group.getAttribute('role')!=='group' || headings.length!==1 || headings[0]!==heading ||
         !resumeLabel(heading.textContent) || group.querySelector('input[type=file]') || filenames.length!==1 ||
         receipt.clientFilename && receipt.clientFilename!==filenames[0] || receipt.clientRemove && receipt.clientRemove!==uploadRemoveControls(group,receipt.file.name)[0])return false;
      receipt.clientFilename=filenames[0];
      if(!receipt.clientRemove) {
        receipt.clientRemove=uploadRemoveControls(group,receipt.file.name)[0];
        receipt.clientRemove.addEventListener('click',()=>{receipt.clientInvalidated=true;},{capture:true,once:true});
      }
      return true;
    }
    const success=uploadSuccess(group,receipt.file.name);
    if(success.length!==1 || receipt.successStatus && receipt.successStatus!==success[0])return false;
    receipt.successStatus=success[0];return true;
  };
  const ownedAttachmentPresent = e => {
    const proof=state.nativeFileBindings?.get(e),owner=uploadOwner(e)??proof?.group;
    const region=state.resumeAttempt?.element===e ? state.resumeAttempt.region : proof?.region??regionFor(e);
    return !!owner?.isConnected && !!region?.isConnected && region.contains(owner) &&
      (!e.isConnected || composedContains(owner, e) && regionFor(e)===region) && attachmentIds(owner).some(input=>input.value);
  };
  const externalAttachment = e => {
      if (state.nativeFileBindings?.get(e)?.kind==='jobvite' && !jobviteProof(e)) return true;
      if (ownedAttachmentPresent(e)) return true;
      for (let group=composedParent(e), depth=0; group && depth<6 && group!==regionFor(e) && group!==document.body; group=composedParent(group),depth++) {
        if (deepQuery(group,'input[type=file]').length>1) break;
        const text=group.innerText ?? '';
        if (/file .+\.pdf uploaded successfully/i.test(text)) return true;
      }
      return false;
    };
  const changeEditable = (e,change) => change.choiceWidget ? editable(e) && boundChoice(change)?.input===e : change.fabric ? editable(e) && e===change.fabric.input && sameFabric(change.fabric) && fabricState(change.fabric)!==null : change.phoneCountry
    ? editable(e) && e===change.phoneCountry.input && regionFor(e)===change.region && phoneState(change.phoneCountry)!==null
    : change.bambooProvince ? editable(e) && sameBambooContext(e,change.bambooProvince)
      : e.type === 'file' ? !!fileBinding(e) && !externalAttachment(e) && regionFor(e) === change.region : editable(e);
  const identity = e => JSON.stringify([e.tagName,e.type,e.id,e.name,norm(labelFor(e))]);
  const controlIdentity = e => {
    const region=regionFor(e);
    if (!region.matches?.('form,[role=form]') ||
        !e.matches('input:not([type=file]):not([type=hidden]):not([type=password]),textarea,select') ||
        !e.name && ![...e.labels ?? []].some(label=>label.control===e)) return null;
    return JSON.stringify([e.tagName,e.type,e.name,norm(rawLabelFor(e)),e.autocomplete??'',e.placeholder??'']);
  };
  const currentElement = change => {
    if(change.choiceWidget)return boundChoice(change)?.input??null;
    if (change.region && change.element.isConnected && regionFor(change.element)!==change.region) return null;
    if(change.element.isConnected && (!change.identity || identity(change.element)===change.identity))return change.element;
    if (change.controlIdentity && change.region?.isConnected) {
      const matches=deepQuery(change.region,'input,textarea,select').filter(e=>
        regionFor(e)===change.region && controlIdentity(e)===change.controlIdentity && editable(e));
      const found=matches.length===1?matches[0]:null;
      // A surviving explicit label also binds unnamed controls across generated
      // id changes. Otherwise require a stable name inside this same form.
      return found && (found.name || change.boundLabels?.some(label=>label.isConnected && label.control===found)) ? found : null;
    }
    if(change.element.type === 'file' || !change.element.id || !change.identity)return null;
    const matches=deepQuery(document, 'input,textarea,select').filter(e=>identity(e)===change.identity && (!change.region || regionFor(e)===change.region));
    return matches.length===1 ? matches[0] : null;
  };
  const read = e => e.matches('button.fab-SelectToggle[data-menu-id]') ? bambooValue(e) :
    e.type === 'file' ? e.files?.[0] ?? null : e.type === 'radio' || e.type === 'checkbox' ? e.checked : e.value;
  const pendingControlChange = e => {
    const pending=state.unconfirmedControls?.find(change=>regionFor(e)===change.region && currentElement(change)===e);
    if(pending && read(e)===pending.before) {
      state.unconfirmedControls=state.unconfirmedControls.filter(change=>change!==pending);return null;
    }
    return pending??null;
  };
  const orphanedControlChange = e => state.unconfirmedControls?.some(change=> {
    if(change.region!==regionFor(e) || currentElement(change))return false;
    const original=JSON.parse(change.identity),label=norm(rawLabelFor(e));
    return !!original[2] && e.id===original[2] || !!original[3] && e.name===original[3] ||
      !!label && (label===original[4] || label===norm(change.label)) ||
      e.type===change.element.type && change.after!=='' && change.after!==false && change.after!==null && read(e)===change.after;
  });
  const unchanged = (e, value) => read(e) === value && (e.type !== 'file' || e.files?.length === (value === null ? 0 : 1)) && !(e.type === 'radio' && value === false &&
    deepQuery(e.getRootNode(), 'input[type=radio]').some(other =>
      other !== e && other.name === e.name && other.form === e.form && other.checked));
  const syncUploadHistory = (items,next) => {
    for (const change of items) {
      if (!change.uploadReceipt || change.uploadReceipt.externalized || externalAttachment(change.element)) continue;
      if (next==='before' && state.resumeAttempt===change.uploadReceipt) delete state.resumeAttempt;
      if (next==='after') state.resumeAttempt=change.uploadReceipt;
    }
  };
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
    const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, typeof value === 'boolean' ? 'checked' : 'value').set.call(e, value);
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
  const phoneWidget = input => {
    if (!input.matches('input.iti__tel-input[data-intl-tel-input-id]')) return null;
    const group=input.closest('.iti'),id=input.getAttribute('data-intl-tel-input-id');
    if (!group || !/^\d+$/.test(id??'') || group.querySelectorAll('input.iti__tel-input').length!==1) return null;
    const buttons=[...group.querySelectorAll('button.iti__selected-country[type=button][role=combobox][aria-label="Selected country"]')];
    if (buttons.length!==1 || !editable(buttons[0])) return null;
    const button=buttons[0],menuId=button.getAttribute('aria-controls');
    if (menuId!==`iti-${id}__dropdown-content`) return null;
    const menus=[...input.getRootNode().querySelectorAll(`[id="${CSS.escape(menuId)}"]`)];
    if (menus.length!==1 || !group.contains(menus[0]) || menus[0].querySelectorAll('[role=listbox]').length!==1) return null;
    return {input,group,button,menu:menus[0]};
  };
  const phoneOptions = widget => [...widget.menu.querySelectorAll('.iti__country[role=option][data-country-code][data-dial-code]')]
    .filter(option=>option.getAttribute('aria-disabled')!=='true').map(element=>({element,
      code:element.getAttribute('data-country-code'),dial:element.getAttribute('data-dial-code'),
      name:element.querySelector('.iti__country-name')?.textContent?.trim()}));
  const phoneState = widget => {
    if (!widget.input.isConnected || !widget.group.isConnected || !widget.button.isConnected || !widget.menu.isConnected ||
        !widget.group.contains(widget.input) || !widget.group.contains(widget.button)) return null;
    const flags=[...widget.button.querySelectorAll('.iti__flag')],dials=[...widget.button.querySelectorAll('.iti__selected-dial-code')];
    if (flags.length!==1 || dials.length!==1) return null;
    const codes=[...flags[0].classList].filter(value=>/^iti__[a-z]{2}$/.test(value));
    const code=codes.length===1?codes[0].slice(5):'',dial=(dials[0].textContent??'').trim().replace(/^\+/,'');
    const options=phoneOptions(widget).filter(option=>option.code===code && option.dial===dial && norm(option.name)===norm(widget.button.title));
    return options.length===1 && /^[a-z]{2}$/.test(code) && /^\d+$/.test(dial)
      ? JSON.stringify({code,dial,number:widget.input.value}) : null;
  };
  const readChange = (e,change) => change.choiceWidget ? choiceState(boundChoice(change)) : change.fabric ? fabricState(change.fabric) : change.phoneCountry ? phoneState(change.phoneCountry) : read(e);
  const unchangedChange = (e,change,value) => change.choiceWidget || change.fabric || change.phoneCountry ? readChange(e,change)===value : unchanged(e,value);
  const selectPhone = async (change,value,rollback=true) => {
    const widget=change.phoneCountry,before=phoneState(widget),target=JSON.parse(value);
    if (!before || !changeEditable(widget.input,change)) throw new Error('The phone country control changed. Check the form.');
    const original=JSON.parse(before);
    let owned=before,opened=false;
    try {
      if (original.code!==target.code || original.dial!==target.dial) {
        const options=phoneOptions(widget).filter(option=>option.code===target.code && option.dial===target.dial);
        if (options.length!==1 || widget.button.getAttribute('aria-expanded')==='true') throw new Error('The phone country cannot be changed reversibly.');
        checkDeadline();widget.button.click();opened=true;await new Promise(resolve=>setTimeout(resolve,100));
        if (!changeEditable(widget.input,change) || phoneState(widget)!==owned || !visible(widget.menu) || !visible(options[0].element)) throw new Error('The phone country menu or number changed.');
        owned=JSON.stringify({code:target.code,dial:target.dial,number:original.number});
        checkDeadline();options[0].element.click();opened=false;await new Promise(resolve=>setTimeout(resolve,100));
        if (phoneState(widget)!==owned) throw new Error('The phone or country changed during selection. Your edits were preserved.');
      }
      if (phoneState(widget)!==owned) throw new Error('The phone or country changed. Your edits were preserved.');
      checkDeadline();const priorToNumber=owned;write(widget.input,target.number);
      const immediate=phoneState(widget);owned=immediate===priorToNumber ? priorToNumber : value;
      await new Promise(resolve=>setTimeout(resolve,100));
      if (phoneState(widget)!==value || value===change.after && (!widget.input.validity.valid || widget.input.getAttribute('aria-invalid')==='true')) throw new Error('The website did not keep the phone and country together.');
    } catch (error) {
      const current=phoneState(widget);
      if (opened && current===owned && widget.button.getAttribute('aria-expanded')==='true' && editable(widget.button)) widget.button.click();
      if (rollback && current===owned && current!==before) {
        await selectPhone(change,before,false).catch(()=>{});
      }
      throw error;
    }
  };
  const selectBamboo = async (change, value) => {
    const e=change.element,context=change.bambooProvince,before=bambooValue(e);
    // Fabric ignores the zero-detail click generated by HTMLElement.click().
    const toggle = () => e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,detail:1}));
    if (!changeEditable(e,change)) throw new Error('The province control changed. Check the form.');
    if (bambooValue(e) === value) return;
    if (value === 'Province –Select–') {
      const clear = bambooClear(e);
      if (!clear) throw new Error('The website no longer exposes the province reset.');
      checkDeadline();clear.click();
    } else {
      if (e.getAttribute('aria-expanded') === 'true') throw new Error('Close the province menu before retrying.');
      const id=e.getAttribute('data-menu-id'),controls=e.getAttribute('aria-controls');
      if (!id || controls && controls!==id) throw new Error('The province menu binding changed.');
      checkDeadline();toggle();
      const menuStarted=Date.now();let options=[];
      do {
        await new Promise(resolve => setTimeout(resolve, 50));checkDeadline();
        if (!sameBambooContext(e,context) || !editable(e) || bambooValue(e)!==before || e.getAttribute('data-menu-id')!==id) throw new Error('The province changed while its menu opened. Your edits were preserved.');
        const menus=[...e.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`)];
        if (menus.length>1) break;
        const menu=menus.length===1?menus[0]:null;
        options = menu?.getAttribute('role') === 'menu' && visible(menu) ? [...menu.querySelectorAll('[role=menuitem]')].filter(option =>
          visible(option) && option.getAttribute('aria-disabled') !== 'true' && norm(option.textContent) === norm(value.slice('Province '.length))
        ) : [];
      } while (!options.length && Date.now()-menuStarted<2000);
      if (options.length !== 1) {
        if (e.getAttribute('aria-expanded') === 'true' && bambooValue(e)===before && sameBambooContext(e,context)) toggle();
        throw new Error('The saved province is not uniquely available.');
      }
      checkDeadline();
      options[0].click();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!changeEditable(e,change) || bambooValue(e) !== value || (value !== 'Province –Select–' && !bambooClear(e))) {
      throw new Error('The website did not verify the province choice and reset.');
    }
  };
  const preserveRemoteUpload = change => {
    if(!change.uploadReceipt || !ownedUploadCompleted(change.uploadReceipt))return false;
    change.uploadReceipt.externalized=true;state.externalizedUploadHistory??=[];
    if(!state.externalizedUploadHistory.includes(change))state.externalizedUploadHistory.push(change);
    return true;
  };
  try {
    // Uploads can finish after a native file was journaled. Preserve the remote
    // attachment separately so it cannot prevent unrelated text from undoing.
    let preservedRemote=false;
    for(const history of [state.undo,state.redo]) for(let index=history.length-1;index>=0;index--) {
      history[index]=history[index].filter(change=> {
        if(!preserveRemoteUpload(change))return true;
        preservedRemote=true;return false;
      });
      if(!history[index].length)history.splice(index,1);
    }
    preservedRemote ||= state.externalizedUploadHistory?.some(change=>ownedUploadCompleted(change.uploadReceipt));
    if(preservedRemote && (action==='undo' || action==='redo')) {
      result.resume='verified';result.skipped.push({label:'Resume',reason:state.resumeAttempt?.clientOnly?'client_attachment_preserved':'remote_upload_preserved'});
    }
    if (action === 'undo' || action === 'redo') {
      const from = state[action], to = state[action === 'undo' ? 'redo' : 'undo'], entry = from.at(-1);
      if (!entry) return result;
      const changes=action==='undo'?[...entry].reverse():entry;
      const chronological=items=>action==='undo'?[...items].reverse():items;
      const previous = action === 'undo' ? 'after' : 'before', next = action === 'undo' ? 'before' : 'after';
      const current=changes.map(currentElement);
      if (current.some((e,i) => action==='redo' && changes[i].matchingDynamic && (!e || !changeEditable(e,changes[i])) ? false : !e || !changeEditable(e,changes[i]) || !unchangedChange(e,changes[i], changes[i][previous]))) throw new Error('Fields changed since C3 filled them. Your edits were preserved.');
      changes.forEach((c,i)=>{if(current[i])c.element=current[i];});
      let written = 0;
      try {
        for (const c of changes) {
          checkDeadline();
          if(action==='redo' && c.matchingDynamic)await new Promise(resolve=>setTimeout(resolve,100));
          const e=currentElement(c);
          if(!e || !changeEditable(e,c) || !unchangedChange(e,c,c[previous]))throw new Error('Fields changed since C3 filled them. Your edits were preserved.');
          c.element=e;
          if (c.choiceWidget) await restoreChoice(c,c[next]);
          else if (c.fabric) await selectFabric(c,c[next]);
          else if (c.phoneCountry) await selectPhone(c,c[next]);
          else if (c.bambooProvince) await selectBamboo(c,c[next]);
          else write(e,c[next]);
          written++;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        if (changes.some(c => {const e=currentElement(c);if(e)c.element=e;if(action==='undo' && c.matchingDynamic && (!e || !visible(e)) && (c[next]==='' || c[next]===false))return false;return !e || readChange(e,c)!==c[next];})) throw new Error('The website did not keep the restored values. Check the form.');
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 100));
        // Transfer only verified writes; the untouched remainder stays retryable.
        const applied = changes.slice(0, written).filter(c => {const e=currentElement(c);if(e)c.element=e;return e && readChange(e,c)===c[next];});
        if (applied.length) {
          syncUploadHistory(applied,next);
          const remaining = changes.filter(c => !applied.includes(c));
          from.pop();
          if (remaining.length) from.push(chronological(remaining));
          to.push(chronological(applied));
        }
        throw error;
      }
      syncUploadHistory(changes,next);
      from.pop(); to.push(chronological(changes)); result.filled = changes.map(c => c.label); return result;
    }
    if (action !== 'fill' && action !== 'status') throw new Error('Unknown field action.');
    const choiceAliases = {
      'will you now or in the future require sponsorship?': 'sponsorship_required',
      'do you require employment sponsorship now or in the future?': 'sponsorship_required',
      'how did you hear about us?': 'application_source',
    };
    const aliases = {
      'first name': 'given_name', 'given name': 'given_name', 'legal first name': 'given_name', 'prénom': 'given_name',
      'last name': 'family_name', 'family name': 'family_name', 'legal last name': 'family_name', 'nom de famille': 'family_name',
      'preferred name': 'preferred_name', 'preferred first name':'preferred_name', 'email': 'email_address', 'email address': 'email_address', 'e-mail': 'email_address', 'adresse e-mail': 'email_address',
      'phone': 'phone_number', 'phone number': 'phone_number', 'phone number?': 'phone_number', 'mobile phone': 'phone_number', 'téléphone': 'phone_number',
      'adresse courriel / email': 'email_address', 'numéro de téléphone / phone number': 'phone_number',
      'city': 'city', 'ville': 'city', 'postal code': 'postal_code', 'zip code': 'postal_code', 'code postal': 'postal_code',
      'country': 'country', 'pays': 'country', 'state': 'region', 'province': 'region', 'state/province': 'region',
      'current company': 'current_company', 'current title': 'current_title',
      'linkedin link':'linkedin_url', 'linkedin': 'linkedin_url', 'linkedin profile': 'linkedin_url', 'linkedin profile url': 'linkedin_url', 'linkedin url': 'linkedin_url',
      'github': 'github_url', 'github profile': 'github_url', 'github url': 'github_url', 'github profile url': 'github_url',
      'portfolio': 'portfolio_url', 'portfolio url': 'portfolio_url', 'portfolio website': 'portfolio_url',
      'website, blog or portfolio':'portfolio_url', 'website':'portfolio_url', 'confirm your email':'email_address',
      'address': 'address_line1', 'street address': 'address_line1', 'address line 1': 'address_line1', 'address line 2': 'address_line2',
      'when are you looking to start?': 'earliest_start_date', 'when are you available to start?': 'earliest_start_date',
      'earliest start date': 'earliest_start_date', 'available start date': 'earliest_start_date',
      'date available':'earliest_start_date', 'desired pay':'salary_expectations', 'desired salary':'salary_expectations',
      'what salary range are you targeting?': 'salary_expectations', 'salary expectations': 'salary_expectations',
      'what would be your salary expectations for the position?':'salary_expectations',
    };
    const fact = id => facts.find(f => f.factId === id)?.value;
    const canadaEligibility = label => {
      if (norm(label)!=='are you legally eligible to work in canada without sponsorship?') return undefined;
      const authorized=fact('work_authorization_canada'),sponsorship=fact('sponsorship_required_canada');
      return typeof authorized==='boolean' && typeof sponsorship==='boolean' ? authorized && !sponsorship : undefined;
    };
    const answer = label => {
      const key = norm(label);
      const eligible=canadaEligibility(label);
      if (eligible!==undefined) return eligible?'Yes':'No';
      if (key==='where are you located?') {
        const parts=['city','region','country'].map(fact);
        return parts.every(value=>typeof value==='string' && value.trim()) ? parts.join(', ') : undefined;
      }
      if (/^(full name|legal name|full legal name|name|first (?:&|and) last name|legal first and last name|nom complet|nom complet \/ name)$/.test(key)) {
        return typeof fact('given_name') === 'string' && typeof fact('family_name') === 'string' ? `${fact('given_name')} ${fact('family_name')}` : undefined;
      }
      if (key === 'full address') {
        const required = ['address_line1', 'city', 'region', 'postal_code', 'country'].map(fact);
        if (required.some(value => typeof value !== 'string' || !value.trim())) return undefined;
        const [street, city, region, postal, country] = required;
        return [street, fact('address_line2'), city, `${region} ${postal}`, country].filter(Boolean).join(', ');
      }
      return fact(aliases[key]);
    };
    const dialComposite = e => {
      if(e.getAttribute('role')!=='combobox' || !/^\+\d{1,4}\s+[A-Z]{2}$/.test(e.value??''))return false;
      for(let owner=composedParent(e);owner && owner!==regionFor(e);owner=composedParent(owner)) {
        const controls=deepQuery(owner,'input:not([type=hidden]),select,textarea').filter(visible);
        if(controls.length>2)return false;
        const phone=controls.filter(input=>input!==e && (input.type==='tel' || input.inputMode==='tel') && /phone|téléphone/i.test(rawLabelFor(input)));
        if(controls.length===2 && phone.length===1)return true;
      }
      return false;
    };
    const inspectCommittedChoice = async e => {
      const value=e.value,region=regionFor(e),wasOpen=e.getAttribute('aria-expanded')==='true';
      if(!value || e.getAttribute('role')!=='combobox' || e.getAttribute('aria-haspopup')!=='listbox')return null;
      const began=Date.now(),diagnostic={reason:'inspection_started',samples:[]};
      state.committedChoiceDiagnostics??=new WeakMap();state.committedChoiceDiagnostics.set(e,diagnostic);
      const menu=()=> {
        const id=e.getAttribute('aria-controls'),root=e.getRootNode();
        const menus=id?[...root.querySelectorAll(`[id="${CSS.escape(id)}"]`)]:[];
        const owners=id?[...root.querySelectorAll('[aria-controls]')].filter(node=>(node.getAttribute('aria-controls')??'').split(/\s+/).includes(id)):[];
        const list=menus.length===1?menus[0]:null;
        return {list:menus.length===1 && owners.length===1 && owners[0]===e && list.getAttribute('role')==='listbox' && list.getAttribute('aria-multiselectable')!=='true'?list:null,
          menuCount:menus.length,ownerCount:owners.length,ownsMenu:owners.length===1&&owners[0]===e,
          roleSupported:!!list&&list.getAttribute('role')==='listbox'&&list.getAttribute('aria-multiselectable')!=='true',
          busy:list?.getAttribute('aria-busy')==='true',visible:!!list&&visible(list)};
      };
      const renderDetails = list => {
        const dimensions=node=> {
          if(!node)return null;
          const rect=node.getBoundingClientRect();
          return {width:Math.round(rect.width),height:Math.round(rect.height),top:Math.round(rect.top),
            clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,scrollTop:Math.round(node.scrollTop)};
        };
        const range=values=>values.length?{min:Math.min(...values),max:Math.max(...values)}:null;
        const numbers=(nodes,attribute)=>nodes.map(node=>node.getAttribute(attribute)).filter(value=>value!==null && /^\d+(?:\.\d+)?$/.test(value)).map(Number);
        if(!list)return {documentVisible:document.visibilityState==='visible'};
        const options=[...list.querySelectorAll('[role=option]')],scrollers=[...list.querySelectorAll('[data-virtuoso-scroller]')];
        const scroller=scrollers.length===1?scrollers[0]:null;
        const viewports=scroller?[...scroller.querySelectorAll('[data-viewport-type]')]:[];
        const itemLists=scroller?[...scroller.querySelectorAll('[data-test-id=virtuoso-item-list]')]:[];
        const items=[...list.querySelectorAll('[data-known-size][data-item-index]')];
        const activeId=e.getAttribute('aria-activedescendant')||list.getAttribute('aria-activedescendant');
        const active=activeId?[...e.getRootNode().querySelectorAll(`[id="${CSS.escape(activeId)}"]`)]:[];
        const itemStyle=itemLists.length===1?getComputedStyle(itemLists[0]):null;
        const searchState=list.getAttribute('data-search-state');
        return {documentVisible:document.visibilityState==='visible',menuDimensions:dimensions(list),
          scrollerCount:scrollers.length,scrollerDimensions:dimensions(scroller),
          viewportCount:viewports.length,viewportDimensions:dimensions(viewports.length===1?viewports[0]:null),
          virtualItemListCount:itemLists.length,virtualItemCount:items.length,
          knownItemSize:range(numbers(items,'data-known-size')),renderedItemIndex:range(numbers(items,'data-item-index')),
          paddingTop:itemStyle?parseFloat(itemStyle.paddingTop)||0:null,paddingBottom:itemStyle?parseFloat(itemStyle.paddingBottom)||0:null,
          optionPosition:range(numbers(options,'aria-posinset')),optionSetSize:range(numbers(options,'aria-setsize')),
          selectableOptionCount:options.filter(option=>option.getAttribute('data-selectable')==='true').length,
          disabledOptionCount:options.filter(option=>option.getAttribute('aria-disabled')==='true').length,
          hasActiveDescendant:!!activeId,activeDescendantCount:active.length,
          activeDescendantOwned:active.length===1 && list.contains(active[0]),
          activeDescendantSelected:active.length===1 && list.contains(active[0]) && active[0].getAttribute('aria-selected')==='true',
          activeDescendantReferencesAgree:!e.hasAttribute('aria-activedescendant') || !list.hasAttribute('aria-activedescendant') || e.getAttribute('aria-activedescendant')===list.getAttribute('aria-activedescendant'),
          searchState:['settled','loading','pending','searching','idle','error'].includes(searchState)?searchState:searchState===null?'absent':'other',
          searchQueryPresent:!!list.getAttribute('data-search-query'),searchQueryMatchesValue:list.getAttribute('data-search-query')===value};
      };
      const sample=(stage,details={})=>diagnostic.samples.push({stage,elapsedMs:Date.now()-began,connected:e.isConnected,valueUnchanged:e.value===value,expanded:e.getAttribute('aria-expanded')==='true',...details});
      const previousFocus=document.activeElement;
      let proof=null;
      sample('before_open');
      try {
        if(!wasOpen){checkDeadline();e.focus();e.click();}
        sample('open_dispatched');
        const started=Date.now();
        do {
          await new Promise(resolve=>setTimeout(resolve,100));checkDeadline();
          if(!e.isConnected || regionFor(e)!==region || e.value!==value) {diagnostic.reason='field_changed_during_inspection';sample('field_changed');throw new Error('The choice changed during inspection.');}
          const ownership=menu(),list=ownership.list,options=list && list.getAttribute('aria-busy')!=='true'?[...list.querySelectorAll('[role=option]')].filter(option=>option.getAttribute('aria-disabled')!=='true'):[];
          const selected=options.filter(option=>option.getAttribute('aria-selected')==='true');
          const {list:ignored,...details}=ownership;
          diagnostic.reason=!ownership.menuCount?'menu_not_found':!ownership.ownsMenu?'menu_owner_not_unique':!ownership.roleSupported?'unsupported_menu':ownership.busy?'menu_busy':selected.length>1?'selected_option_ambiguous':'selected_option_missing';
          if(selected.length===1) {
            const labels=options.map(option=>option.textContent.replace(/\s+/g,' ').trim()),label=selected[0].textContent.replace(/\s+/g,' ').trim();
            const tokens=[selected[0],...selected[0].querySelectorAll('*')].filter(node=>node===selected[0] || !node.children.length).map(node=>norm(node.textContent));
            const labelUnique=labels.filter(text=>text===label).length===1,tokenMatches=tokens.includes(norm(value));
            if(labelUnique && tokenMatches)proof={value,selected:label,options:labels};
            diagnostic.reason=proof?'committed_selected_option':!labelUnique?'selected_label_ambiguous':'selected_value_token_mismatch';
            sample('selected_option',{...details,...renderDetails(list),optionCount:options.length,selectedCount:selected.length,labelUnique,tokenMatches});
            break;
          }
          sample('menu_observation',{...details,...renderDetails(list),optionCount:options.length,selectedCount:selected.length});
        }while(Date.now()-started<1200);
      } finally {
        if(!wasOpen && e.isConnected && regionFor(e)===region && e.value===value) {
          e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,composed:true}));
          await new Promise(resolve=>setTimeout(resolve,100));
          const closing=menu();
          if(e.getAttribute('aria-expanded')==='true' || closing.list && visible(closing.list)) {proof=null;diagnostic.reason='menu_not_dismissed';}
          const {list:ignored,...details}=closing;sample('after_close',details);
          if(previousFocus?.isConnected && previousFocus!==e && typeof previousFocus.focus==='function')previousFocus.focus();
        }
        sample('finished',{proofConfirmed:!!proof});
      }
      return proof;
    };
    const buttonChoiceObservation = e => {
      const id=e.getAttribute('aria-controls'),root=e.getRootNode();
      const menus=id?deepQuery(root,`[id="${CSS.escape(id)}"]`):[];
      const owners=id?deepQuery(root,'[aria-controls]').filter(owner=>(owner.getAttribute('aria-controls')??'').split(/\s+/).includes(id)):[];
      const menu=menus.length===1 && owners.length===1 && owners[0]===e && menus[0].getAttribute('role')==='listbox' && menus[0].getAttribute('aria-multiselectable')!=='true' && menus[0].getAttribute('aria-busy')!=='true' && visible(menus[0])?menus[0]:null;
      const options=menu?[...menu.querySelectorAll('[role=option]')].filter(option=>option.closest('[role=listbox]')===menu && option.getAttribute('aria-disabled')!=='true' && visible(option)):[];
      const selected=options.filter(option=>option.getAttribute('aria-selected')==='true');
      const labels=options.map(option=>option.textContent.replace(/\s+/g,' ').trim()),label=selected.length===1?selected[0].textContent.replace(/\s+/g,' ').trim():'';
      const confirmed=!!label && labels.filter(candidate=>candidate===label).length===1 && [e.value,e.textContent].some(value=>norm(value)===norm(label));
      return {options:labels,selected:confirmed?label:'',diagnostics:{reason:'button_choice_interaction_unsupported',
        listboxPopup:e.getAttribute('aria-haspopup')==='listbox',comboboxRole:e.getAttribute('role')==='combobox',
        expanded:e.getAttribute('aria-expanded')==='true',hasLabelReference:e.hasAttribute('aria-labelledby'),hasMenuReference:!!id,
        menuCount:menus.length,ownerCount:owners.length,ownedMenu:!!menu,optionCount:options.length,selectedCount:selected.length,selectionConfirmed:confirmed}};
    };
    const collectFields = () => deepQuery(document, 'input,textarea,select,button.fab-SelectToggle[data-menu-id],button[aria-haspopup="listbox"],button[role="combobox"]').filter(e => editable(e) && !['g-recaptcha-response','h-captcha-response'].includes(e.name) &&
      (fabricWidget(e) || semanticChoiceButton(e) || !['hidden', 'password', 'file', 'submit', 'button', 'reset'].includes(e.type))).map(element => {
      const label = dialComposite(element)?'Phone country code':labelFor(element);
      return { element, identity:identity(element), controlIdentity:controlIdentity(element), boundLabels:[...element.labels??[]], region:regionFor(element), label,
        expected:['desired salary','what would be your salary expectations for the position?'].includes(norm(label)) && element.type!=='text' ? undefined : answer(label), initialValue:element.value };
    });
    let fields = collectFields();
    // A newsletter or account form must not receive application data.
    const identifyApplicationRegions = fields => {
      const regions = new Set(fields.filter(f => /name|prénom|nom de famille/i.test(f.label) && f.expected !== undefined).map(f => f.region));
      return [...regions].filter(region => {
      const own = fields.filter(f => f.region === region);
      const candidates = [region];
      // Some employers split the resume upload and profile into sibling forms.
      let parent = region.parentElement ?? region.host?.parentElement;
      for (let depth = 0; depth < 3 && parent && parent !== document.body; depth++, parent = parent.parentElement) candidates.push(parent);
      return own.some(f => /e.?mail/i.test(f.label)) && ![...region.querySelectorAll('input[type=password]')].some(visible) &&
        (state.resumeAttempt?.url===location.href && state.resumeAttempt.region===region && (ownedUploadCompleted(state.resumeAttempt) || ownedAttachmentPresent(state.resumeAttempt.element)) ||
        candidates.some(container => deepQuery(container, 'input[type=file]').length || /submit application|apply for|job application|candidature/i.test(container.innerText ?? '')));
    });
    };
    let applicationRegions = identifyApplicationRegions(fields);
    const observe = (e, label) => {
      const fabric=fabricWidget(e),fabricRead=fabric && fabricState(fabric),committed=state.committedChoices?.get(e),searchChoice=sharedChoice(e),buttonChoice=semanticChoiceButton(e)?buttonChoiceObservation(e):null;
      const queryDraft=searchChoice?.widget && state.choiceDrafts?.get(searchChoice.widget);
      const cachedOptions=queryDraft && boundChoice(queryDraft.change) && choiceState(searchChoice)===queryDraft.change.after?queryDraft.options:[];
      const choice=committed?.value===e.value?committed:null;
      const group=e.type==='radio' ? composedClosest(e,'fieldset,[role=radiogroup]') : null;
      const node=group??e;
      state.matchingIds??=new WeakMap();
      if (!state.matchingIds.has(node)) state.matchingIds.set(node,crypto.randomUUID());
      const radios=group ? deepQuery(group,'input[type=radio]').filter(editable) : [];
      if (group) label=group.getAttribute('aria-label') || group.querySelector('legend')?.textContent || label;
      const control=group?'radio':searchChoice || buttonChoice?'listbox':fabric || e.getAttribute('role')==='combobox' || e.getAttribute('role')==='listbox'?'listbox':
        e.type==='checkbox'?'checkbox':e.tagName==='SELECT'?'select':e.tagName==='TEXTAREA'?'textarea':e.type==='date'?'date':'text';
      const menuId=e.getAttribute('aria-controls');
      const menus=menuId?deepQuery(e.getRootNode(),`[id="${CSS.escape(menuId)}"]`):[];
      const options=buttonChoice?buttonChoice.options:searchChoice?[...new Set([...searchChoice.labels,...(searchChoice.popupStatus==='ready'?searchChoice.options.filter(option=>!option.disabled).map(option=>option.label):cachedOptions)])]:fabric ? state.fabricOptions?.get(e)??[] : choice?choice.options:control==='select'?[...e.options].filter(o=>!o.disabled && o.value).map(o=>o.textContent.trim()):
        group?radios.map(labelFor):control==='listbox' && menus.length===1?[...menus[0].querySelectorAll('[role=option]')].filter(o=>o.getAttribute('aria-disabled')!=='true').map(o=>o.textContent.trim()):[];
      const selected=buttonChoice?buttonChoice.selected:searchChoice?searchChoice.labels.join('; '):fabric ? fabricRead?JSON.parse(fabricRead).label:'' : control==='select'?[...e.selectedOptions].filter(o=>!o.disabled && o.value).map(o=>o.textContent.trim()).join('; '):
        group?radios.filter(o=>o.checked).map(labelFor).join('; '):control==='checkbox'?e.checked:
        control==='listbox'?choice?.selected??e.closest('.select__control')?.querySelector('[class*=single-value]')?.textContent?.trim()??'':e.value;
      const number = name => e.getAttribute(name) && Number.isFinite(Number(e.getAttribute(name))) ? Number(e.getAttribute(name)) : null;
      const observation={pageId:location.href,fieldId:state.matchingIds.get(node),question:label,control,options,
        required:isRequired(e),
        constraints:['text','textarea'].includes(control)?{inputType:['number','email','url'].includes(e.type)?e.type:'text',
          min:number('min'),max:number('max'),step:number('step'),minLength:number('minlength'),maxLength:number('maxlength'),pattern:e.pattern||null,readOnly:!!e.readOnly}:undefined,
        ...(searchChoice?{queryable:searchChoice.valid,searchQuery:searchChoice.query,backing:choiceState(searchChoice),choiceDiagnostics:searchChoice.diagnostics??{reason:searchChoice.reason}}:{}),
        ...(buttonChoice?{choiceDiagnostics:buttonChoice.diagnostics,reason:'button_choice_interaction_unsupported',observedAnswer:{displayedValue:String(e.innerText??e.textContent??'').replace(/\s+/g,' ').trim(),hasBackingValue:!!e.value,selectionConfirmed:buttonChoice.diagnostics.selectionConfirmed}}:{}),
        ...(choice?{backing:JSON.stringify({value:choice.value,selected:choice.selected})}:{}),
        ...(state.committedChoiceDiagnostics?.has(e)?{choiceInspection:state.committedChoiceDiagnostics.get(e)}:{}),
        ...(fabric?{backing:fabricRead,country:fabric.countryValue,...(pendingFabricChange(fabric)?{provisional:true,reason:'previous_custom_write_unconfirmed'}:{})}:{}),
        ...(pendingControlChange(e)?{provisional:true,reason:'previous_control_write_unconfirmed'}:{}),
        ...(orphanedControlChange(e)?{provisional:true,reason:'orphaned_control_write_requires_review'}:{}),
        selected,valid:buttonChoice?buttonChoice.diagnostics.selectionConfirmed && e.validity?.valid!==false && e.getAttribute('aria-invalid')!=='true':searchChoice?searchChoice.valid && !pendingChoice(searchChoice) && e.validity?.valid!==false && e.getAttribute('aria-invalid')!=='true':fabric?fabricRead!==null && fabric.backing.validity.valid:e.validity?.valid!==false && e.getAttribute('aria-invalid')!=='true'};
      const {choiceInspection,...stableObservation}=observation;
      return {...observation,signature:JSON.stringify(stableObservation)};
    };
    const isRequired = e => {
      const attachment=jobviteProof(e);
      if(attachment && isRequired(attachment.trigger))return true;
      const fabric=fabricWidget(e);if(fabric)return isRequired(fabric.backing);
      const group=composedClosest(e,'fieldset,[role=radiogroup]');
      if (e.required || e.getAttribute('aria-required')==='true' ||
          [...e.labels??[]].some(label=>label.matches('.Mui-required') || label.querySelector('abbr[title="required" i],[aria-label="required" i]')) ||
          e.type==='radio' && group && (group.getAttribute('aria-required')==='true' ||
            deepQuery(group,'input[type=radio]').some(r=>r.required || r.getAttribute('aria-required')==='true'))) return true;
      const originalLabel=e.getAttribute('data-hunt-question-label')||rawLabelFor(e);
      const label=e.type==='radio' && group ? group.getAttribute('data-hunt-question-label') ?? group.getAttribute('aria-label') ?? group.querySelector('legend')?.textContent ?? originalLabel : originalLabel;
      if (/[✱*]\s*$/.test(label) || /(?:^|\s|\()required\)?$/i.test(label) && !/not required\)?$/i.test(label)) return true;
      if (e.type==='file') {
        const binding=fileBinding(e),widget=state.nativeFileBindings?.get(e)?.group ?? binding?.widget;
        if (widget && widget!==regionFor(e)) {
          // The already-proven upload owner may carry the required marker even
          // when its technical input is labelled only "file-input".
          const headings=deepQuery(widget,'label,legend,h1,h2,h3,h4,h5,h6,[role=heading],spl-typography-title[data-test="section-title"]');
          const firstLine=(widget.innerText??'').split('\n').find(line=>line.trim())??'';
          const references=[e,...e.labels??[],widget].flatMap(node=>(node.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean).flatMap(id=>{
            const matches=deepQuery(node.getRootNode(),`[id="${CSS.escape(id)}"]`);
            if(matches.length!==1 || matches[0]===e)return [];
            const labels=[matches[0].textContent??''];
            if(matches[0].querySelector('abbr[title="required" i],[aria-label="required" i]'))labels.push(`${matches[0].textContent??''} *`);
            // Rippling and Workable place the asterisk beside the referenced
            // heading. Only use its small, control-free heading cluster.
            for(let owner=matches[0].parentElement,depth=0;owner && depth<2;owner=owner.parentElement,depth++) {
              if(owner.querySelector('input,select,textarea'))break;
              const copy=owner.cloneNode(true);copy.querySelectorAll('svg,[hidden],[aria-hidden=true]').forEach(node=>node.remove());
              labels.push(copy.textContent??'');
            }
            return labels;
          }));
          if ([firstLine,...headings.map(node=>node.textContent??''),...references].some(text=>resumeLabel(text) && /(?:^[✱*]|[✱*]$)/.test(text.trim()))) return true;
        }
      }
      const owner=composedClosest(e,'[data-automation-id="formField"],[data-automation-id^="formField-"],[data-required],.ashby-application-form-field,[role=group]');
      return !!owner && (owner.getAttribute('data-required')==='true' || owner.getAttribute('aria-required')==='true' ||
        !!owner.querySelector('[data-automation-id="required"],abbr[title="required" i],[aria-label="required" i],.ashby-application-form-field-required'));
    };
    const observations = () => {
      const rows=new Map();
      for (const f of collectFields()) {
        if (deepQuery(f.region,'input[type=password]').some(visible) || /password|passcode|verification code|one.time code/i.test(f.label)) continue;
        if (scope!=='page' && !applicationRegions.includes(f.region)) continue;
        const row=observe(f.element,f.label); rows.set(row.fieldId,row);
      }
      return [...rows.values()];
    };
    if (action==='status') {
      // Diagnostic only: reading validity does not dispatch invalid events or
      // override committed attachment/choice evidence and matching decisions.
      const nativeControls=deepQuery(document,'input,textarea,select,button').filter(e=>e.validity);
      const validityFlags=['valueMissing','typeMismatch','patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError'];
      const summarizeValidity=controls=>({controlCount:controls.length,validationCandidateCount:controls.filter(e=>e.willValidate).length,
        invalidCount:controls.filter(e=>!e.validity.valid).length,blockingInvalidCount:controls.filter(e=>e.willValidate && !e.validity.valid).length,
        hiddenBlockingInvalidCount:controls.filter(e=>e.willValidate && !e.validity.valid && !visible(e)).length});
      const nextCandidates=deepQuery(document,'button,input[type=submit],input[type=button],[role=button]').filter(e=>visible(e) &&
        /^(?:next|continue|save\s+(?:and|&)\s+continue)$/i.test(String(e.getAttribute('aria-label') || (e.tagName==='INPUT'?e.value:e.innerText??e.textContent) || '').trim()));
      const invalidControls=nativeControls.filter(e=>!e.validity.valid);
      const noticeVisible=e=>{
        if(!visible(e) || composedClosest(e,'[hidden],[aria-hidden="true"]'))return false;
        for(let owner=e;owner;owner=composedParent(owner))if(getComputedStyle(owner).opacity==='0')return false;
        return true;
      };
      const noticeNodes=deepQuery(document,'[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"],[role="alertdialog"],[role="dialog"],dialog[open],[class*="error-summary" i],[id*="error-summary" i],[class*="errorsummary" i],[id*="errorsummary" i],[data-automation-id="inputAlert"],[data-automation-id*="error" i]')
        .filter(e=>e!==document.body && e!==document.documentElement && noticeVisible(e));
      const notices=[],seenNotices=new Set();let noticeCharacters=0,omittedNoticeCount=0;
      for(const node of noticeNodes) {
        if(notices.length>=20 || noticeCharacters>=6000){omittedNoticeCount++;continue;}
        const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text='',part,visited=0,truncated=false;
        while((part=walker.nextNode())) {
          if(++visited>2000){truncated=true;break;}
          const owner=part.parentElement;
          if(!owner || composedClosest(owner,'input,textarea,select,script,style,noscript,template,[contenteditable]:not([contenteditable="false"])') || !noticeVisible(owner))continue;
          text+=' '+part.textContent.slice(0,2401-text.length);
          if(text.length>2400){truncated=true;break;}
        }
        text=text.replace(/\b(?:https?:\/\/|www\.)\S+/gi,'[link]').replace(/\s+/g,' ').trim();
        const limit=Math.min(1200,6000-noticeCharacters);truncated ||= text.length>limit;text=text.slice(0,limit);
        const role=node.getAttribute('role'),live=node.getAttribute('aria-live');
        const notice={role:['alert','status','alertdialog','dialog'].includes(role)?role:node.tagName==='DIALOG'?'dialog':null,live:['polite','assertive','off'].includes(live)?live:null,
          visible:true,busy:node.getAttribute('aria-busy')==='true',disabled:node.matches(':disabled') || node.getAttribute('aria-disabled')==='true',
          visibleDisabledControlCount:deepQuery(node,'button,input,select,textarea,[role="button"]').filter(e=>noticeVisible(e) && (e.matches(':disabled') || e.getAttribute('aria-disabled')==='true')).length,
          text,truncated};
        const key=JSON.stringify(notice);if(seenNotices.has(key))continue;seenNotices.add(key);
        notices.push(notice);noticeCharacters+=text.length;
      }
      result.navigationDiagnostics={nativeValidation:{scope:'document',...summarizeValidity(nativeControls),
        invalidControls:invalidControls.slice(0,100).map(e=>({type:e.type || e.tagName.toLowerCase(),visible:visible(e),required:!!e.required,
          willValidate:!!e.willValidate,hasForm:!!e.form,associatedWithNextForm:!!e.form && nextCandidates.some(next=>next.form===e.form),
          flags:validityFlags.filter(flag=>e.validity[flag])})),omittedInvalidControlCount:Math.max(0,invalidControls.length-100)},
        notices:{scope:'document_visible_notice_containers',items:notices,omittedNoticeCount},
        nextCandidates:nextCandidates.map(e=>({type:e.type || null,nativeButton:e.tagName==='BUTTON' || e.tagName==='INPUT',
          disabled:e.matches(':disabled') || e.getAttribute('aria-disabled')==='true',hasForm:!!e.form,
          formNoValidate:e.form?!!e.form.noValidate:null,formNoValidateOverride:!!e.formNoValidate,
          ...(e.form?{nativeValidation:summarizeValidity(nativeControls.filter(control=>control.form===e.form))}:{})}))};
      state.fabricOptions??=new WeakMap();state.committedChoices??=new WeakMap();
      for(const field of fields) {
        if(isRequired(field.element) && (scope==='page' || applicationRegions.includes(field.region)) && !semanticChoiceButton(field.element) && !sharedChoice(field.element) && field.element.getAttribute('role')==='combobox' && field.element.value) {
          try {const proof=await inspectCommittedChoice(field.element);if(proof)state.committedChoices.set(field.element,proof);else state.committedChoices.delete(field.element);}
          catch {state.committedChoices.delete(field.element);result.skipped.push({label:field.label,reason:'custom_menu_inspection_unconfirmed'});}
        }
        const fabric=fabricWidget(field.element);
        if(!fabric || !isRequired(field.element) || scope!=='page' && !applicationRegions.includes(field.region))continue;
        try {state.fabricOptions.set(field.element,await fabricMenu(fabric));}
        catch {state.fabricOptions.delete(field.element);result.skipped.push({label:field.label,reason:'custom_menu_inspection_unconfirmed'});}
      }
      result.matching=observations();
      if(result.matching.some(row=>row.required && row.reason==='button_choice_interaction_unsupported'))result.incomplete=true;
      return result;
    }
    const reportMatch = (row, plan, outcome, reason, observedAnswer) => result.matching.push({...row,
      chosenAnswer:plan?.answer??null,provisional:plan?.provisional??true,outcome,reason,observedAnswer});

    const parserComplete = () => /résumé parsing was successful\./i.test(document.body?.innerText ?? '');
    const parserBusy = () => /(?:parsing (?:your )?(?:résumé|resume)|(?:résumé|resume) (?:is being parsed|parsing (?:in progress|has started)))/i.test(document.body?.innerText ?? '');
    let uploadReceipt = state.resumeAttempt?.url===location.href ? state.resumeAttempt : null;
    let parserPending = false;
    if (resume && typeof resume.base64 === 'string' && resume.base64.length <= 14_000_000 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(resume.base64) && resume.base64.length % 4 === 0 &&
        typeof resume.name === 'string' && /^[-a-z0-9_ .]+\.pdf$/i.test(resume.name)) {
      const resumeFields = deepQuery(document, 'input[type=file]').filter(e =>
        applicationRegions.includes(regionFor(e)) && fileBinding(e));
      const targets = resumeFields.filter(isRequired);
      if (!targets.length && resumeFields.length && !uploadReceipt) result.resume='optional';
      if (uploadReceipt) {
        // Retain the attempted upload even when a site clears/replaces its input.
        // Repeating Fill must not create another remote attachment.
        const requested=Uint8Array.from(atob(resume.base64),char=>char.charCodeAt(0));
        const attempted=new Uint8Array(await uploadReceipt.file.arrayBuffer());
        checkDeadline();
        if (requested.length!==attempted.length || requested.some((byte,index)=>byte!==attempted[index])) {
          result.resume='unverified';
          result.skipped.push({label:'Resume',reason:'different_resume_requires_manual_review'});
          return result;
        }
        const e=uploadReceipt.element;
        uploadReceipt.externalized ||= !e.isConnected || externalAttachment(e) || read(e)!==uploadReceipt.file;
        result.resume = ownedUploadCompleted(uploadReceipt) || !uploadReceipt.externalized && fileBinding(e) && regionFor(e)===uploadReceipt.region &&
          e.files?.length===1 && read(e)===uploadReceipt.file && e.validity.valid && e.getAttribute('aria-invalid')!=='true' ? 'verified' : 'unverified';
        result.skipped.push({label:'Resume',reason:result.resume==='verified'?'selected_resume_already_present':'resume_upload_already_attempted_review_attachment'});
        parserPending = parserBusy() || uploadReceipt.externalized && !ownedUploadCompleted(uploadReceipt) && !ownedAttachmentPresent(e) && !uploadReceipt.parserCompleted && !parserComplete();
        if (parserComplete()) uploadReceipt.parserCompleted=true;
      } else if (targets.length === 1) {
        const e = targets[0], label = fileBinding(e).label, fileRegion = regionFor(e);
        result.resume = 'unverified';
        if (externalAttachment(e)) {
          result.skipped.push({label,reason:'existing_remote_attachment_requires_review'});
          parserPending=parserBusy() || !ownedAttachmentPresent(e) && !parserComplete();
        } else if ((e.files?.length ?? 0) > 1 && replaceExistingResume) {
          result.skipped.push({label, reason:'ambiguous_resume_attachment'});
        } else if (e.files?.length && (!replaceExistingResume || state.nativeFileBindings?.get(e)?.kind==='jobvite')) {
          result.skipped.push({label, reason:'existing_attachment_preserved'});
        } else {
          checkDeadline();
          const bytes = Uint8Array.from(atob(resume.base64), char => char.charCodeAt(0));
          if (new TextDecoder().decode(bytes.subarray(0,5)) === '%PDF-') {
            const before = read(e), hadParserComplete=parserComplete();
            const file = new File([bytes], resume.name, {type:'application/pdf'});
            const owner=uploadOwner(e),fileSha256=crypto.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('') : null;
            checkDeadline();
            if(!fileBinding(e) || regionFor(e)!==fileRegion || read(e)!==before || owner && (!owner.isConnected || !composedContains(owner, e))) {
              result.skipped.push({label,reason:'resume_control_changed'});return result;
            }
            const clientOnly=owner?.matches('[role=group][aria-labelledby][data-allow-s3=false]') && fileBinding(e)?.widget===owner;
            const clientIds=clientOnly?(owner.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean):[];
            const clientHeadings=clientIds.length===1?[...owner.getRootNode().querySelectorAll(`[id="${CSS.escape(clientIds[0])}"]`)]:[];
            uploadReceipt = {url:location.href,element:e,region:fileRegion,file,fieldsBefore:fields,clientOnly:!!clientOnly,clientHeading:clientHeadings.length===1?clientHeadings[0]:null,
              externalized:false,parserCompleted:false,owner,fileSha256,hadAttachmentId:!!owner && attachmentIds(owner).some(input=>input.value),hadUploadSuccess:!!owner && (uploadSuccess(owner,file.name).length>0 || uploadRemoveControls(owner,file.name).length>0),selectedFileAccepted:false};
            state.resumeAttempt=uploadReceipt;
            const observeParser=()=>{if (!hadParserComplete && parserComplete()) uploadReceipt.parserCompleted=true;};
            const observer=new MutationObserver(observeParser);
            observer.observe(document.body,{subtree:true,childList:true,characterData:true});
            try {
              write(e, file);
              const started=Date.now();
              do {
                await new Promise(resolve => setTimeout(resolve,100));
                checkDeadline();observeParser();
                uploadReceipt.externalized ||= !e.isConnected || externalAttachment(e) || read(e)!==file;
                if (Date.now()-started>=600 && (!uploadReceipt.externalized && !parserBusy() || ownedUploadCompleted(uploadReceipt) || uploadReceipt.parserCompleted)) break;
              } while (Date.now()-started<3000);
            } finally { observer.disconnect(); }
            if (!uploadReceipt.externalized && fileBinding(e) && regionFor(e) === fileRegion && e.files?.length === 1 && read(e) === file && e.validity.valid) {
              changes.push({element:e, identity:identity(e), region:fileRegion, before, after:file, label,uploadReceipt});
              result.filled.push(label);
              result.resume = 'verified';
            } else if(ownedUploadCompleted(uploadReceipt)) {
              result.resume='verified';result.filled.push(label);
            } else {
              // Native File undo cannot remove a server-side upload. Preserve the
              // receipt and pause for attachment review, without a fake rollback.
              result.skipped.push({label, reason:uploadReceipt.externalized?'uploaded_attachment_requires_review':'attachment_not_verified_native_file_retained'});
            }
            parserPending=parserBusy() || uploadReceipt.externalized && !ownedUploadCompleted(uploadReceipt) && !ownedAttachmentPresent(e) && !uploadReceipt.parserCompleted;
          }
        }
      } else if (result.resume!=='optional') {
        if (targets.length>1) result.resume='unverified';
        result.skipped.push({label:'Resume',reason:targets.length>1?'ambiguous_duplicate':'resume_control_not_identified'});
      }
    }
    if (parserPending) {
      result.skipped.push({label:'Resume',reason:'resume_parsing_pending_profile_not_filled'});
      return result;
    }
    fields = collectFields();
    applicationRegions = identifyApplicationRegions(fields);
    const sameText = (element, label, expected) => element.value === expected ||
      (/phone|téléphone/i.test(label) && /\d/.test(element.value) && element.value.replace(/\D/g, '') === expected.replace(/\D/g, ''));
    const existingMatchReason = element => element.validity.valid && element.getAttribute('aria-invalid')!=='true'
      ? 'saved_value_already_present' : 'value_not_accepted';
    const reportExisting = (row, plan, same, skip) => {
      if (!same) {
        skip('saved_value_conflict');
        reportMatch(row, plan, 'unconfirmed', 'existing_value_preserved', row.selected);
      } else if (!row.valid) {
        skip('value_not_accepted');
        reportMatch(row, plan, 'verification_failed', 'value_not_accepted', row.selected);
      } else {
        skip('saved_value_already_present');
        reportMatch(row, plan, 'verified', 'existing_value_confirmed', row.selected);
      }
    };
    const dateValue = (element,label,value) => {
      if (element.type!=='text' || norm(element.placeholder)!=='mm/dd/yyyy') return value;
      const match=typeof value==='string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const date=match && new Date(`${value}T00:00:00Z`);
      return match && Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===value
        ? `${match[2]}/${match[3]}/${match[1]}` : undefined;
    };
    const radiosHandled = new Set();
    for (const f of fields) {
      let e = currentElement(f);
      const skip = reason => result.skipped.push({ label: f.label, reason });
      if(!e){skip('field_replaced_without_stable_identity');continue;}
      if(!editable(e)){skip('field_no_longer_editable');continue;}
      if(!isRequired(e)){skip('optional_field');continue;}
      if (scope !== 'page' && !applicationRegions.includes(f.region)) { skip('application_form_not_identified'); continue; }
      if(semanticChoiceButton(e)) {
        const row=observe(e,f.label),plan=matchingPlans?.find(plan=>plan.fieldId===row.fieldId);
        skip('button_choice_interaction_unsupported');reportMatch(row,plan,'unconfirmed','button_choice_interaction_unsupported',row.observedAnswer);continue;
      }
      if(orphanedControlChange(e)) {skip('orphaned_control_write_requires_review');reportMatch(observe(e,f.label),undefined,'unconfirmed','orphaned_control_write_requires_review',read(e));continue;}
      if(pendingControlChange(e)) {skip('previous_control_write_unconfirmed');reportMatch(observe(e,f.label),undefined,'unconfirmed','previous_control_write_unconfirmed',read(e));continue;}
      const searchChoice=sharedChoice(e);
      if(searchChoice) {
        const row=observe(e,f.label),plan=matchingPlans?.find(plan=>plan.fieldId===row.fieldId);
        if(!searchChoice.valid) {skip(searchChoice.reason);reportMatch(row,plan,'unconfirmed',searchChoice.reason,row.selected);continue;}
        if(pendingChoice(searchChoice)) {skip('previous_choice_write_unconfirmed');reportMatch(row,plan,'unconfirmed','previous_choice_write_unconfirmed',row.selected);continue;}
        if(!plan || plan.signature!==row.signature) {if(plan)result.skipped.push({label:row.question,reason:'field_changed_before_fill',fieldId:row.fieldId});reportMatch(row,plan,'observed','field_changed_or_new');continue;}
        if(searchChoice.labels.length) {
          const same=searchChoice.labels.length===1 && searchChoice.labels[0]===plan.answer;
          reportExisting(row, plan, same, skip);continue;
        }
        state.choiceDrafts??=new WeakMap();
        const draft=state.choiceDrafts.get(searchChoice.widget),ownedDraft=draft && boundChoice(draft.change) && choiceState(searchChoice)===draft.change.after;
        if(searchChoice.query && !ownedDraft) {skip('existing_search_query_preserved');reportMatch(row,plan,'unconfirmed','existing_search_query_preserved',row.selected);continue;}
        const querying=typeof plan.query==='string' && plan.query.length>0 && plan.answer==null;
        if(!querying && (typeof plan.answer!=='string' || !row.options.includes(plan.answer))) {skip(plan.reason);reportMatch(row,plan,'unconfirmed',plan.reason,row.selected);continue;}
        const reusable=ownedDraft && (changes.includes(draft.change) || state.undo.at(-1)?.includes(draft.change));
        const change=reusable?draft.change:{element:e,region:f.region,label:row.question,choiceWidget:searchChoice,before:choiceState(searchChoice),after:choiceState(searchChoice),searchQuery:querying?plan.query:searchChoice.query||plan.answer};
        const beforeWrite=choiceState(searchChoice);touchedChoices.add(change);
        try {
          if(querying) {
            change.searchQuery=plan.query;const current=await queryChoice(change,plan.query);
            if(current.labels.length && (current.labels.length!==1 || current.pills.length!==1 || !current.pills[0].remove))throw new Error('The search committed an item without a confirmed reset.');
            const options=current.options.filter(option=>!option.disabled).map(option=>option.label);
            closeChoice(change);await choicePause();change.after=choiceState(boundChoice(change));
            if(!change.after)throw new Error('The search owner changed.');
            state.choiceDrafts.set(searchChoice.widget,{change,options});
            if(!reusable && change.after!==change.before)changes.push(change);
            reportMatch(observe(currentElement(change),row.question),plan,'observed','choice_options_observed');
          } else {
            change.after=await selectChoice(change,plan.answer);
            state.choiceDrafts.set(searchChoice.widget,{change,options:row.options});
            if(!reusable && change.after!==change.before)changes.push(change);
            result.filled.push(row.question);reportMatch(observe(currentElement(change),row.question),plan,'verified','product_readback_confirmed',plan.answer);
          }
        } catch {
          const observed=choiceState(boundChoice(change));
          if(observed && observed!==beforeWrite) {
            await restoreChoice(change,beforeWrite).catch(()=>{});
          }
          change.after=choiceState(boundChoice(change));
          if(change.after!==beforeWrite) {
            state.unconfirmedChoices??=new WeakMap();state.unconfirmedChoiceHistory??=[];
            state.unconfirmedChoices.set(searchChoice.widget,change);state.unconfirmedChoiceHistory.push(change);
            // Keep a failed irreversible write out of the ordinary Undo batch.
            // Its durable evidence remains attached to this exact widget.
            if(reusable) {
              for(const history of [changes,...state.undo]) {const index=history.indexOf(change);if(index>=0)history.splice(index,1);}
              state.undo=state.undo.filter(entry=>entry.length);
            }
          } else if(change.after && change.after!==change.before && !reusable && !changes.includes(change))changes.push(change);
          if(change.after)state.choiceDrafts.set(searchChoice.widget,{change,options:[]});
          skip('choice_commit_or_reset_unconfirmed');reportMatch(row,plan,'unconfirmed','choice_commit_or_reset_unconfirmed',{before:beforeWrite,after:change.after});
        }
        continue;
      }
      const fabric=fabricWidget(e);
      if(fabric) {
        if(matchingPlans===undefined) {
          state.fabricOptions??=new WeakMap();
          try {state.fabricOptions.set(e,await fabricMenu(fabric));}catch {skip('custom_menu_inspection_unconfirmed');continue;}
        }
        const row=observe(e,f.label),plan=matchingPlans?.find(plan=>plan.fieldId===row.fieldId);
        if(pendingFabricChange(fabric)){skip('previous_custom_write_unconfirmed');reportMatch(row,plan,'unconfirmed','previous_custom_write_unconfirmed',row.selected);continue;}
        if(matchingPlans!==undefined && (!plan || plan.signature!==row.signature)){reportMatch(row,plan,'observed','field_changed_or_new');continue;}
        const answer=plan?.answer??f.expected;
        if(typeof answer!=='string' || !row.options.includes(answer)){skip(plan?.reason??'choice_requires_mapping');reportMatch(row,plan,'unconfirmed',plan?.reason??'choice_requires_mapping',row.selected);continue;}
        if(row.selected!=='') {const same=row.selected===answer;reportExisting(row, plan, same, skip);continue;}
        const before=fabricState(fabric);
        if(before===null){skip('custom_choice_backing_unconfirmed');continue;}
        const change={element:e,region:f.region,label:f.label,fabric,before,after:JSON.stringify({label:answer,value:null})};
        try {
          change.after=await selectFabric(change,change.after);
          changes.push(change);result.filled.push(f.label);reportMatch(row,plan,'verified','product_readback_confirmed',observe(e,f.label).selected);
        } catch {
          const after=fabricState(fabric);
          if(after && JSON.parse(after).label===answer && fabricClear(fabric))await selectFabric(change,before).catch(()=>{});
          const remaining=fabricState(fabric);
          if(remaining!==before) {
            state.unconfirmedFabric??=new WeakMap();
            state.unconfirmedFabric.set(e,{backing:fabric.backing,before,after:remaining});
          }
          skip('custom_choice_commit_or_reset_unconfirmed');reportMatch(row,plan,'unconfirmed','custom_choice_commit_or_reset_unconfirmed',{
            before:JSON.parse(before),after:remaining?JSON.parse(remaining):{label:e.querySelector('.fab-SelectToggle__content')?.textContent??'',value:fabric.backing.value},resetAvailable:!!fabricClear(fabric)});
        }
        continue;
      }
      if (matchingPlans !== undefined && !e.matches('input.iti__tel-input[data-intl-tel-input-id]')) {
        if(e.getAttribute('role')==='combobox' && e.value) {
          state.committedChoices??=new WeakMap();
          try {const proof=await inspectCommittedChoice(e);if(proof)state.committedChoices.set(e,proof);else state.committedChoices.delete(e);}
          catch {state.committedChoices.delete(e);skip('custom_menu_inspection_unconfirmed');continue;}
        }
        if (deepQuery(f.region,'input[type=password]').some(visible)) {skip('account_fields_preserved');continue;}
        const row=observe(e,f.label),plan=matchingPlans.find(plan=>plan.fieldId===row.fieldId);
        if (row.control==='radio') {
          if (radiosHandled.has(row.fieldId)) continue;
          radiosHandled.add(row.fieldId);
        }
        const signature=row.signature;
        if (!plan || plan.signature!==signature) {if(plan)result.skipped.push({label:row.question,reason:'field_changed_before_fill',fieldId:row.fieldId});reportMatch(row,plan,'observed','field_changed_or_new');continue;}
        if (plan.answer===null || plan.answer===undefined) {skip(plan.reason);reportMatch(row,plan,'unconfirmed',plan.reason,row.selected);continue;}
        let value=dateValue(e,row.question,plan.answer);
        if (value===undefined) {skip('saved_date_format_unsupported');reportMatch(row,plan,'unconfirmed','saved_date_format_unsupported',row.selected);continue;}
        if (row.selected!=='' && row.selected!==false) {
          const same=String(row.selected)===String(value) || row.control==='text' && typeof value==='string' && sameText(e,row.question,value);
          reportExisting(row, plan, same, skip);continue;
        }
        if (row.control==='listbox' || e.multiple) {skip('custom_choice_not_reversible');reportMatch(row,plan,'unconfirmed','custom_choice_not_reversible',row.selected);continue;}
        if (row.control==='radio') {
          const group=composedClosest(e,'fieldset,[role=radiogroup]');
          const radios=deepQuery(group,'input[type=radio]').filter(editable);
          const matches=radios.filter(radio=>labelFor(radio)===value);
          if (matches.length!==1 || !radios.every(radio=>radio.name===e.name)) {reportMatch(row,plan,'unconfirmed','choice_not_unique');continue;}
          e=matches[0];value=true;
        } else if (row.control==='select') {
          const options=[...e.options].filter(o=>!o.disabled && o.value && o.textContent.trim()===value);
          if (options.length!==1) {reportMatch(row,plan,'unconfirmed','choice_not_unique');continue;}
          value=options[0].value;
        }
        if (e.type!=='checkbox' && row.control!=='radio') value=String(value);
        if (read(e)===value && row.valid) {reportMatch(row,plan,'verified','existing_value_confirmed',row.selected);continue;}
        checkDeadline();
        const change={element:e,identity:identity(e),controlIdentity:f.controlIdentity,boundLabels:f.boundLabels,region:f.region,before:read(e),label:row.question};
        write(e,value);const immediate=currentElement(change),written=read(immediate??e);await new Promise(resolve=>setTimeout(resolve,100));
        e=currentElement(change);
        if (!e || !editable(e) || !unchanged(e,value) || !e.validity.valid || e.getAttribute('aria-invalid')==='true') {
          if(e && editable(e) && unchanged(e,written)) {
            write(e,change.before);await new Promise(resolve=>setTimeout(resolve,100));e=currentElement(change);
          }
          const restored=!!e && unchanged(e,change.before);
          if(!restored) {
            state.unconfirmedControls??=[];
            state.unconfirmedControls.push({...change,element:e??change.element,after:e?read(e):written});
          }
          const reason=!e?'field_replaced_without_stable_identity':'value_not_accepted';
          skip(reason);reportMatch(row,plan,'verification_failed',reason,{before:change.before,after:e?read(e):null,written,restored});continue;
        }
        changes.push({...change,element:e,after:read(e),matchingDynamic:!!matchingRunId && state.matchingRunId===matchingRunId});result.filled.push(row.question);
        reportMatch(row,plan,'verified','product_readback_confirmed',observe(e,row.question).selected);
        continue;
      }
      if (e.matches('input.iti__tel-input[data-intl-tel-input-id]')) {
        const widget=phoneWidget(e),before=widget&&phoneState(widget),country=fact('country'),number=fact('phone_number');
        if (!applicationRegions.includes(f.region) || !widget || !before || typeof country!=='string' || typeof number!=='string' || !number) {skip('phone_country_requires_review');continue;}
        const options=phoneOptions(widget).filter(option=>norm(option.name)===norm(country));
        if (options.length!==1 || !/^[a-z]{2}$/.test(options[0].code) || !/^\d+$/.test(options[0].dial)) {skip('phone_country_requires_review');continue;}
        const after=JSON.stringify({code:options[0].code,dial:options[0].dial,number});
        if (e.value) {skip(before===after?existingMatchReason(e):'saved_value_conflict');continue;}
        const change={element:e,identity:identity(e),region:f.region,label:f.label,phoneCountry:widget,before,after};
        try {await selectPhone(change,after);changes.push(change);result.filled.push(f.label);}
        catch {skip(phoneState(widget)===before?'phone_country_requires_review':'phone_country_change_requires_review');}
        continue;
      }
      if (e.type === 'radio') {
        const group = composedClosest(e, 'fieldset,[role=radiogroup]');
        if (!group || !e.name || radiosHandled.has(group)) continue;
        radiosHandled.add(group);
        const groupLabel = group.getAttribute('aria-label') || group.querySelector('legend')?.textContent || '';
        const eligible=canadaEligibility(groupLabel);
        const answer = eligible===undefined ? fact(choiceAliases[norm(groupLabel)]) : eligible;
        const radios = deepQuery(group, 'input[type=radio]').filter(radio => editable(radio));
        if (!radios.every(radio => radio.name === e.name)) continue;
        const wanted = typeof answer === 'boolean' ? (answer ? 'yes' : 'no') : typeof answer === 'string' ? norm(answer) : '';
        const matches = radios.filter(radio => wanted && norm(labelFor(radio)) === wanted);
        if (matches.length !== 1) {
          result.skipped.push({label:groupLabel,reason:matches.length>1?'ambiguous_duplicate':'choice_requires_mapping'});
          continue;
        }
        const radio = matches[0];
        if (radios.some(option => option.checked)) {
          result.skipped.push({label:groupLabel,reason:radio.checked?existingMatchReason(radio):'saved_value_conflict'});
          continue;
        }
        checkDeadline();
        write(radio, true);
        await new Promise(resolve => setTimeout(resolve, 100));
        if (radio.isConnected && radio.checked && radio.validity.valid) {
          changes.push({element:radio,identity:identity(radio),before:false,after:true,label:groupLabel});
          result.filled.push(groupLabel);
        } else {
          if (radio.isConnected && radio.checked) write(radio,false);
          result.skipped.push({label:groupLabel,reason:'value_not_accepted'});
        }
        continue;
      }
      if (e.getAttribute('role') === 'combobox' || e.getAttribute('role') === 'listbox') {
        const kind = norm(f.label);
        const country = ['country','phone country','country code'].includes(kind);
        const address = ['province','state','state/province'].includes(kind);
        const expected = country ? fact('country') : address ? fact('region') : undefined;
        const control = e.closest('.select__control');
        if (!applicationRegions.includes(f.region) || !control || typeof expected !== 'string' || !expected) {
          skip('choice_requires_mapping'); continue;
        }
        const choiceKey = text => norm(country ? text.replace(/\s*\+\d+\s*$/, '') : text);
        const selected = () => control.querySelector('.select__single-value')?.textContent?.trim();
        const present = selected();
        if (present || e.value) {
          skip(present && choiceKey(present) === norm(expected) ? existingMatchReason(e) : 'saved_value_conflict');
          continue;
        }
        // The site does not expose a verified native reset to the blank state.
        skip('custom_choice_not_reversible');
        continue;
      }
      if (e.type === 'checkbox' || e.multiple) { skip('choice_requires_mapping'); continue; }
      if (typeof f.expected !== 'string' || !f.expected) {
        const prior=uploadReceipt?.fieldsBefore.find(field=>field.identity===f.identity && field.region===f.region);
        skip(uploadReceipt?.parserCompleted && e.value && (!prior || prior.initialValue!==e.value)
          ? 'resume_parser_unmapped_value_requires_review' : 'no_stored_mapping');
        continue;
      }
      const region = regionFor(e);
      if (fields.filter(other => {const current=currentElement(other);return norm(other.label) === norm(f.label) && current && regionFor(current) === region;}).length > 1) { skip('ambiguous_duplicate'); continue; }
      let value = dateValue(e,f.label,f.expected);
      if(value===undefined) {skip('saved_date_format_unsupported');continue;}
      if (e instanceof HTMLSelectElement) {
        const options = [...e.options].filter(o => !o.disabled && (norm(o.textContent) === norm(value) || norm(o.value) === norm(value)));
        if (options.length !== 1) { skip('option_not_found'); continue; }
        value = options[0].value;
      }
      if (e.value && !(e instanceof HTMLSelectElement && e.selectedOptions[0]?.disabled)) {
        const prior=uploadReceipt?.fieldsBefore.find(field=>field.identity===f.identity && field.region===f.region);
        skip(sameText(e, f.label, value) ? existingMatchReason(e) :
          uploadReceipt?.parserCompleted && prior && prior.initialValue!==e.value ? 'resume_parser_value_conflict' : 'saved_value_conflict');
        continue;
      }
      checkDeadline();
      const before = e.value;
      const change = {element:e,identity:identity(e),controlIdentity:f.controlIdentity,boundLabels:f.boundLabels,region:f.region,before,label:f.label};
      write(e, value);
      const immediate=currentElement(change),written=read(immediate??e);
      await new Promise(resolve => setTimeout(resolve, 100));
      e = currentElement(change);
      if (!e || !sameText(e, f.label, value) || !e.validity.valid || e.getAttribute('aria-invalid') === 'true') {
        if(e && editable(e) && unchanged(e,written)) {
          write(e,before);await new Promise(resolve=>setTimeout(resolve,100));e=currentElement(change);
        }
        if(!e || !unchanged(e,before)) {
          state.unconfirmedControls??=[];
          state.unconfirmedControls.push({...change,element:e??change.element,after:e?read(e):written});
        }
        skip(e?'value_not_accepted':'field_replaced_without_stable_identity');continue;
      }
      changes.push({ ...change, element:e, after:e.value }); result.filled.push(f.label);
    }
    const savedProvince = fact('region');
    if (typeof savedProvince === 'string' && norm(fact('country')) === 'canada') {
      const province = deepQuery(document,'button.fab-SelectToggle[data-menu-id][aria-label^="Province "]')
        .filter(e => !fabricWidget(e) && editable(e) && applicationRegions.includes(regionFor(e)) &&
          [...regionFor(e).querySelectorAll('button.fab-SelectToggle[aria-label="Country Canada"]')].filter(visible).length === 1);
      if (province.length === 1) {
        const e = province[0], before = bambooValue(e), after = `Province ${savedProvince}`,context=bambooProvinceContext(e);
        if (!isRequired(e)) result.skipped.push({label:'Province',reason:'optional_field'});
        else if (!context) result.skipped.push({label:'Province',reason:'choice_requires_mapping'});
        else if (before === 'Province –Select–') {
          const change={element:e,region:context.region,before,after,label:'Province',bambooProvince:context};
          checkDeadline();
          try {
            await selectBamboo(change, after);
            changes.push(change);
            result.filled.push('Province');
          } catch (error) {
            if (sameBambooContext(e,context) && bambooValue(e) === after && bambooClear(e)) await selectBamboo(change, before).catch(()=>{});
            const reason=error instanceof Error ? ({
              'The province control changed. Check the form.':'province_control_changed',
              'The province menu binding changed.':'province_menu_binding_changed',
              'The province changed while its menu opened. Your edits were preserved.':'province_menu_open_changed',
              'The saved province is not uniquely available.':'province_option_not_unique',
              'The website did not verify the province choice and reset.':'province_selection_not_verified',
            })[error.message] : undefined;
            result.skipped.push({label:'Province',reason:bambooValue(e)===before?(reason??'value_not_accepted'):'province_change_requires_review'});
          }
        } else if (norm(before) !== norm(after)) {
          result.skipped.push({label:'Province',reason:'saved_value_conflict'});
        }
      }
    }
    // A later field can remount or invalidate an earlier search selection.
    // Keep that mutation visible even when query and selection shared an older batch.
    for(const change of touchedChoices) {
      const current=boundChoice(change);
      if(current && choiceState(current)===change.after && (current.empty || current.input.validity?.valid!==false && current.input.getAttribute('aria-invalid')!=='true'))continue;
      state.unconfirmedChoices??=new WeakMap();state.unconfirmedChoiceHistory??=[];
      state.unconfirmedChoices.set(change.choiceWidget.widget,change);
      if(!state.unconfirmedChoiceHistory.includes(change))state.unconfirmedChoiceHistory.push(change);
      for(const history of [changes,...state.undo]) {const index=history.indexOf(change);if(index>=0)history.splice(index,1);}
      state.undo=state.undo.filter(entry=>entry.length);
      result.filled=result.filled.filter(label=>label!==change.label);
      result.skipped.push({label:change.label,reason:'value_changed_after_fill'});
      for(const row of result.matching.filter(row=>row.question===change.label && row.outcome==='verified')) {row.outcome='verification_failed';row.reason='value_changed_after_fill';row.provisional=true;}
    }
    // An upload can trigger the site's parser after individual writes have settled.
    for (let index = changes.length - 1; index >= 0; index--) {
      const change = changes[index];
      if(preserveRemoteUpload(change)){changes.splice(index,1);result.resume='verified';continue;}
      const element = currentElement(change);
      const queryOnly=change.choiceWidget && boundChoice(change)?.empty;
      if (element && changeEditable(element,change) && unchangedChange(element,change, change.after) &&
          (queryOnly || element.validity.valid && element.getAttribute('aria-invalid') !== 'true')) continue;
      changes.splice(index, 1);
      if(change.controlIdentity && (!element || !unchanged(element,change.before))) {
        state.unconfirmedControls??=[];
        state.unconfirmedControls.push({...change,element:element??change.element,after:element?read(element):change.after});
      }
      if (change.element.type === 'file') result.resume = 'unverified';
      const filledIndex = result.filled.lastIndexOf(change.label);
      if (filledIndex >= 0) result.filled.splice(filledIndex, 1);
      result.skipped.push({label:change.label,reason:'value_changed_after_fill'});
      for (const row of result.matching.filter(row=>row.question===change.label && row.outcome==='verified')) {row.outcome='verification_failed';row.reason='value_changed_after_fill';row.provisional=true;}
    }
    return result;
  } finally {
    if (action === 'fill' && changes.length) { if (matchingRunId && state.matchingRunId===matchingRunId && state.undo.length) state.undo.at(-1).push(...changes); else state.undo.push(changes); state.matchingRunId=matchingRunId; state.undo = state.undo.slice(-10); state.redo = []; }
    state.busy = false; result.canUndo = state.undo.length > 0; result.canRedo = state.redo.length > 0;
    if(state.unconfirmedControls?.some(change=>change.region?.isConnected))result.incomplete=true;
    if(state.unconfirmedChoiceHistory?.some(change=>change.region?.isConnected && [...change.region.querySelectorAll('input[data-uxi-widget-type=selectinput]')].some(input=>pendingChoice(sharedChoice(input))===change)))result.incomplete=true;
  }
}
