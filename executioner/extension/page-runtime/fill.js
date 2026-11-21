import { createUploadReader } from './upload-reader.js';
import { createLegacyAnswerReader } from './legacy-page-answers.js';
import { createCompositeControlActions } from './composite-control-actions.js';
import { readNavigationDiagnostics } from './navigation-diagnostics.js';
import { createRequiredFieldReader } from './required-field.js';
import { createFieldObserver } from './field-observation.js';
import { createDomReader } from './dom-reader.js';
import { createFieldRecognition } from './field-recognition.js';
import { createUploadVerification } from './upload-verification.js';
import { createControlInteraction } from './control-interaction.js';
import { createPhoneReader } from './phone-reader.js';

/** Runs in the exact document selected by the injection boundary. */
export async function runPageFill({ facts = [], action = 'fill', scope = 'application', expectedUrl, expiresAt, resume, replaceExistingResume = false, matchingPlans, matchingRunId } = {}, adapters) {
  const {observeCurrentDocument, currentPageInterruption, createSearchChoiceReader, createFabricControl, createProvinceMenu, isPortalResumeBinding} = adapters;
  const checkDeadline = () => { if (expiresAt !== undefined && Date.now() >= expiresAt) throw new Error('Field changes expired. Check the page and reopen C3 before retrying.'); };
  checkDeadline();
  if (expectedUrl !== undefined && location.href !== expectedUrl) throw new Error('The page changed. Reopen C3 on the application.');
  const observed = observeCurrentDocument();
  const interrupted = currentPageInterruption(observed, action);
  if (interrupted) return interrupted;
  const separateAccountForm = observed.signals.includes('separate_account_form');
  if (separateAccountForm) scope = 'application';
  const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[✱*]/g, '').replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();
  const state = globalThis.__huntC3PartialFill ??= { undo: [], redo: [], busy: false };
  if (state.busy) throw new Error('A field fill is already running.');
  state.busy = true;
  const result = { status: 'partial', filled: [], skipped: [], canUndo: false, canRedo: false, matching: [],
    resume: /** @type {'verified'|'missing'|'unverified'|'optional'} */ ('missing') };
  const addSkip = (label, reason, component, operation, fieldId) => {
    const row = {label, reason};
    if (fieldId) row.fieldId = fieldId;
    if (component && component !== 'answer_matching' && operation !== 'operate_choice') row.componentFailure = {component, operation};
    result.skipped.push(row);
  };
  const changes = [];
  const touchedChoices = new Set();
  const { deepQuery, composedClosest, composedParent, composedContains, visible, editable } = createDomReader();
  const verifiedDialogUpload = e => {
    const proof=state.nativeFileBindings?.get(e);
    if (!isPortalResumeBinding(proof) || typeof proof.valid !== 'function') return null;
    try {return proof.valid()?proof:null;} catch {return null;}
  };
  const regionFor = e => verifiedDialogUpload(e)?.region || e.form || composedClosest(e, 'form,[role=form]') || e.getRootNode();
  const { fabricWidget, fabricState, pendingFabricChange, sameFabric, fabricClear, fabricMenu, selectFabric, isMenuToggle, menuToggleSelector, fabricDisplayedLabel } = createFabricControl({
    regionFor, norm, state, deepQuery, visible, editable, checkDeadline
  });
  const provinceMenu = createProvinceMenu({regionFor, norm, visible, editable, checkDeadline, deepQuery});
  const { semanticChoiceButton, rawLabelFor, labelFor, resumeLabel, otherAttachment } = createFieldRecognition({ addressGroupLabel:adapters.addressGroupLabel, composedClosest, deepQuery, fabricWidget, norm });
  const {sharedChoice, boundChoice, candidates:searchChoiceCandidates} = createSearchChoiceReader(regionFor);
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
  const { fileBinding, uploadOwner } = createUploadReader({ isPortalResumeBinding, uploadHeading:adapters.uploadHeading,
    state, regionFor, deepQuery, composedClosest, composedParent, composedContains, visible, editable, norm, verifiedDialogUpload, resumeLabel, otherAttachment
  });
  const {parserComplete, parserBusy, uploadSuccess, hasPdfUploadNotice} = adapters.createUploadStatusReader(norm, deepQuery);
  const { attachmentIds, uploadRemoveControls, ownedUploadCompleted } = createUploadVerification({ deepQuery, composedContains, uploadSuccess, verifiedClientAttachment:adapters.verifiedClientAttachment, state, regionFor, norm, resumeLabel });
  const ownedAttachmentPresent = e => {
    const proof=state.nativeFileBindings?.get(e),owner=uploadOwner(e)??proof?.group;
    const region=state.resumeAttempt?.element===e ? state.resumeAttempt.region : proof?.region??regionFor(e);
    return !!owner?.isConnected && !!region?.isConnected && composedContains(region,owner) &&
      (!e.isConnected || composedContains(owner, e) && regionFor(e)===region) && attachmentIds(owner).some(input=>input.value);
  };
  const externalAttachment = e => {
      if (isPortalResumeBinding(state.nativeFileBindings?.get(e)) && !verifiedDialogUpload(e)) return true;
      if (ownedAttachmentPresent(e)) return true;
      for (let group=composedParent(e), depth=0; group && depth<6 && group!==regionFor(e) && group!==document.body; group=composedParent(group),depth++) {
        if (deepQuery(group,'input[type=file]').length>1) break;
        const text=group.innerText ?? '';
        if (hasPdfUploadNotice(text)) return true;
      }
      return false;
    };
  const changeEditable = (e,change) => change.choiceWidget ? editable(e) && boundChoice(change)?.input===e : change.fabric ? editable(e) && e===change.fabric.input && sameFabric(change.fabric) && fabricState(change.fabric)!==null : change.phoneCountry
    ? editable(e) && e===change.phoneCountry.input && regionFor(e)===change.region && phoneState(change.phoneCountry)!==null
    : provinceMenu.savedContext(change) ? editable(e) && provinceMenu.same(e,provinceMenu.savedContext(change))
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
      // Older entries saved the first radio's controlIdentity even when a different option was written.
      if (change.element.type === 'radio' && change.element.name && change.identity) {
        const [, , , name, label] = JSON.parse(change.identity);
        const radios = deepQuery(change.region,'input[type=radio]').filter(radio =>
          regionFor(radio) === change.region && radio.name === name && radio.value === change.element.value &&
          norm(labelFor(radio)) === label && editable(radio));
        return radios.length === 1 ? radios[0] : null;
      }
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
  const read = e => isMenuToggle(e) ? e.getAttribute('aria-label') ?? '' :
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
  const { write, queryChoice, closeChoice, selectChoice, restoreChoice, choicePause } = createControlInteraction({ state, checkDeadline, boundChoice, editable, visible, choiceState });
  const { phoneWidget, phoneOptions, phoneState } = createPhoneReader({ editable, norm });
  const readChange = (e,change) => change.choiceWidget ? choiceState(boundChoice(change)) : change.fabric ? fabricState(change.fabric) : change.phoneCountry ? phoneState(change.phoneCountry) : read(e);
  const unchangedChange = (e,change,value) => change.choiceWidget || change.fabric || change.phoneCountry ? readChange(e,change)===value : unchanged(e,value);
  const { selectPhone } = createCompositeControlActions({
    phoneState, phoneOptions, changeEditable, checkDeadline, visible, editable, write
  });
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
          else if (provinceMenu.savedContext(c)) await provinceMenu.select(c,c[next]);
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
    const { choiceAliases, fact, canadaEligibility, answer } = createLegacyAnswerReader({
      facts, norm
    });
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
    const collectFields = () => deepQuery(document, 'input,textarea,select,button[aria-haspopup="listbox"],button[role="combobox"],'+menuToggleSelector).filter(e => editable(e) && !['g-recaptcha-response','h-captcha-response'].includes(e.name) &&
      (fabricWidget(e) || provinceMenu.context(e) || semanticChoiceButton(e) || !['hidden', 'password', 'file', 'submit', 'button', 'reset'].includes(e.type))).map(element => {
      const label = provinceMenu.context(element) ? 'Province' : dialComposite(element)?'Phone country code':labelFor(element);
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
    const { isRequired } = createRequiredFieldReader({ uploadHeading:adapters.uploadHeading, markedRequired:adapters.markedRequired,
      verifiedDialogUpload, fabricWidget, composedClosest, deepQuery, rawLabelFor, fileBinding, state, regionFor, resumeLabel
    });
    const { observe } = createFieldObserver({
      deepQuery, visible, norm, fabricWidget, fabricState, state, sharedChoice, semanticChoiceButton, boundChoice, choiceState, composedClosest, editable, labelFor, isRequired, pendingFabricChange, pendingControlChange, orphanedControlChange, pendingChoice, phoneWidget, phoneState, provinceContext:provinceMenu.context, provinceValue:provinceMenu.value
    });
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
      result.navigationDiagnostics = readNavigationDiagnostics({noticeMarkers:adapters.noticeMarkers, deepQuery, composedClosest, composedParent, visible, norm});
      state.fabricOptions??=new WeakMap();state.committedChoices??=new WeakMap();
      for(const field of fields) {
        if(isRequired(field.element) && (scope==='page' || applicationRegions.includes(field.region)) && !semanticChoiceButton(field.element) && !sharedChoice(field.element) && field.element.getAttribute('role')==='combobox' && field.element.value) {
          try {const proof=await inspectCommittedChoice(field.element);if(proof)state.committedChoices.set(field.element,proof);else state.committedChoices.delete(field.element);}
          catch {state.committedChoices.delete(field.element);addSkip(field.label, 'custom_menu_inspection_unconfirmed', 'field_recognition', 'read_menu');}
        }
        const fabric=fabricWidget(field.element);
        if(!fabric || !isRequired(field.element) || scope!=='page' && !applicationRegions.includes(field.region))continue;
        try {state.fabricOptions.set(field.element,await fabricMenu(fabric));}
        catch {state.fabricOptions.delete(field.element);addSkip(field.label, 'custom_menu_inspection_unconfirmed', 'field_recognition', 'read_menu');}
      }
      result.matching=observations();
      if(result.matching.some(row=>row.required && row.reason==='button_choice_interaction_unsupported'))result.incomplete=true;
      return result;
    }
    const reportMatch = (row, plan, outcome, reason, observedAnswer) => result.matching.push({...row,
      chosenAnswer:plan?.answer??null,provisional:plan?.provisional??true,outcome,reason,observedAnswer});

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
          addSkip('Resume', 'different_resume_requires_manual_review', 'uploads', 'verify_attachment');
          return result;
        }
        const e=uploadReceipt.element;
        uploadReceipt.externalized ||= !e.isConnected || externalAttachment(e) || read(e)!==uploadReceipt.file;
        result.resume = ownedUploadCompleted(uploadReceipt) || !uploadReceipt.externalized && fileBinding(e) && regionFor(e)===uploadReceipt.region &&
          e.files?.length===1 && read(e)===uploadReceipt.file && e.validity.valid && e.getAttribute('aria-invalid')!=='true' ? 'verified' : 'unverified';
        if (result.resume==='verified') addSkip('Resume', 'selected_resume_already_present');
          else addSkip('Resume', 'resume_upload_already_attempted_review_attachment', 'uploads', 'verify_attachment');
        parserPending = parserBusy() || uploadReceipt.externalized && !ownedUploadCompleted(uploadReceipt) && !ownedAttachmentPresent(e) && !uploadReceipt.parserCompleted && !parserComplete();
        if (parserComplete()) uploadReceipt.parserCompleted=true;
      } else if (targets.length === 1) {
        const e = targets[0], label = fileBinding(e).label, fileRegion = regionFor(e);
        result.resume = 'unverified';
        if (externalAttachment(e)) {
          addSkip(label, 'existing_remote_attachment_requires_review', 'uploads', 'verify_attachment');
          parserPending=parserBusy() || !ownedAttachmentPresent(e) && !parserComplete();
        } else if ((e.files?.length ?? 0) > 1 && replaceExistingResume) {
          addSkip(label, 'ambiguous_resume_attachment', 'uploads', 'verify_attachment');
        } else if (e.files?.length && (!replaceExistingResume || isPortalResumeBinding(state.nativeFileBindings?.get(e)))) {
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
              addSkip(label, 'resume_control_changed', 'uploads', 'verify_attachment');return result;
            }
            uploadReceipt = {url:location.href,element:e,region:fileRegion,file,fieldsBefore:fields,...adapters.clientAttachmentState(owner,fileBinding(e)),
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
              addSkip(label, uploadReceipt.externalized?'uploaded_attachment_requires_review':'attachment_not_verified_native_file_retained', 'uploads', 'verify_attachment');
            }
            parserPending=parserBusy() || uploadReceipt.externalized && !ownedUploadCompleted(uploadReceipt) && !ownedAttachmentPresent(e) && !uploadReceipt.parserCompleted;
          }
        }
      } else if (result.resume!=='optional') {
        if (targets.length > 1) {
          result.resume = 'unverified';
          addSkip('Resume', 'ambiguous_duplicate', 'uploads', 'identify_attachment');
        } else addSkip('Resume', 'resume_control_not_identified');
      }
    }
    if (parserPending) {
      addSkip('Resume', 'resume_parsing_pending_profile_not_filled', 'uploads', 'verify_attachment');
      return result;
    }
    fields = collectFields();
    applicationRegions = identifyApplicationRegions(fields);
    if (separateAccountForm) fields = fields.filter(field => applicationRegions.includes(field.region));
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
      const skip = (reason, component, operation) => addSkip(f.label, reason, component, operation);
      if(!e){skip('field_replaced_without_stable_identity', 'field_recognition', 'identify_field');continue;}
      if(!editable(e)){skip('field_no_longer_editable', 'field_recognition', 'identify_field');continue;}
      if (!fabricWidget(e) && provinceMenu.context(e)) continue; // Process the unique province menu with its country below.
      if(!isRequired(e)){skip('optional_field');continue;}
      if (scope !== 'page' && !applicationRegions.includes(f.region)) { skip('application_form_not_identified', 'page_state', 'identify_application'); continue; }
      if(semanticChoiceButton(e)) {
        const row=observe(e,f.label),plan=matchingPlans?.find(plan=>plan.fieldId===row.fieldId);
        skip('button_choice_interaction_unsupported', 'browser_interaction', 'operate_choice');reportMatch(row,plan,'unconfirmed','button_choice_interaction_unsupported',row.observedAnswer);continue;
      }
      if(orphanedControlChange(e)) {skip('orphaned_control_write_requires_review', 'browser_interaction', 'verify_selection');reportMatch(observe(e,f.label),undefined,'unconfirmed','orphaned_control_write_requires_review',read(e));continue;}
      if(pendingControlChange(e)) {skip('previous_control_write_unconfirmed', 'browser_interaction', 'verify_selection');reportMatch(observe(e,f.label),undefined,'unconfirmed','previous_control_write_unconfirmed',read(e));continue;}
      const searchChoice=sharedChoice(e);
      if(searchChoice) {
        const row=observe(e,f.label),plan=matchingPlans?.find(plan=>plan.fieldId===row.fieldId);
        if(!searchChoice.valid) {skip(searchChoice.reason, 'field_recognition', 'read_choice');reportMatch(row,plan,'unconfirmed',searchChoice.reason,row.selected);continue;}
        if(pendingChoice(searchChoice)) {skip('previous_choice_write_unconfirmed', 'browser_interaction', 'verify_selection');reportMatch(row,plan,'unconfirmed','previous_choice_write_unconfirmed',row.selected);continue;}
        if(!plan || plan.signature!==row.signature) {if(plan)addSkip(row.question, 'field_changed_before_fill', 'field_recognition', 'rebind_field', row.fieldId);reportMatch(row,plan,'observed','field_changed_or_new');continue;}
        if(searchChoice.labels.length) {
          const same=searchChoice.labels.length===1 && searchChoice.labels[0]===plan.answer;
          reportExisting(row, plan, same, skip);continue;
        }
        state.choiceDrafts??=new WeakMap();
        const draft=state.choiceDrafts.get(searchChoice.widget),ownedDraft=draft && boundChoice(draft.change) && choiceState(searchChoice)===draft.change.after;
        if(searchChoice.query && !ownedDraft) {skip('existing_search_query_preserved');reportMatch(row,plan,'unconfirmed','existing_search_query_preserved',row.selected);continue;}
        const querying=typeof plan.query==='string' && plan.query.length>0 && plan.answer==null;
        if(!querying && (typeof plan.answer!=='string' || !row.options.includes(plan.answer))) {skip(plan.reason, 'answer_matching', 'match_field');reportMatch(row,plan,'unconfirmed',plan.reason,row.selected);continue;}
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
          skip('choice_commit_or_reset_unconfirmed', 'browser_interaction', 'verify_selection');reportMatch(row,plan,'unconfirmed','choice_commit_or_reset_unconfirmed',{before:beforeWrite,after:change.after});
        }
        continue;
      }
      const fabric=fabricWidget(e);
      if(fabric) {
        if(matchingPlans===undefined) {
          state.fabricOptions??=new WeakMap();
          try {state.fabricOptions.set(e,await fabricMenu(fabric));}catch {skip('custom_menu_inspection_unconfirmed', 'field_recognition', 'read_menu');continue;}
        }
        const row=observe(e,f.label),plan=matchingPlans?.find(plan=>plan.fieldId===row.fieldId);
        if(pendingFabricChange(fabric)){skip('previous_custom_write_unconfirmed', 'browser_interaction', 'verify_selection');reportMatch(row,plan,'unconfirmed','previous_custom_write_unconfirmed',row.selected);continue;}
        if(matchingPlans!==undefined && (!plan || plan.signature!==row.signature)){reportMatch(row,plan,'observed','field_changed_or_new');continue;}
        const answer=matchingPlans === undefined ? f.expected : plan.answer;
        if(typeof answer!=='string' || !row.options.includes(answer)){skip(plan?.reason??'choice_requires_mapping', 'answer_matching', 'match_field');reportMatch(row,plan,'unconfirmed',plan?.reason??'choice_requires_mapping',row.selected);continue;}
        if(row.selected!=='') {const same=row.selected===answer;reportExisting(row, plan, same, skip);continue;}
        const before=fabricState(fabric);
        if(before===null){skip('custom_choice_backing_unconfirmed', 'browser_interaction', 'verify_selection');continue;}
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
          skip('custom_choice_commit_or_reset_unconfirmed', 'browser_interaction', 'verify_selection');reportMatch(row,plan,'unconfirmed','custom_choice_commit_or_reset_unconfirmed',{
            before:JSON.parse(before),after:remaining?JSON.parse(remaining):{label:fabricDisplayedLabel(e),value:fabric.backing.value},resetAvailable:!!fabricClear(fabric)});
        }
        continue;
      }
      if (matchingPlans !== undefined && !e.matches('input.iti__tel-input[data-intl-tel-input-id]')) {
        if(e.getAttribute('role')==='combobox' && e.value) {
          state.committedChoices??=new WeakMap();
          try {const proof=await inspectCommittedChoice(e);if(proof)state.committedChoices.set(e,proof);else state.committedChoices.delete(e);}
          catch {state.committedChoices.delete(e);skip('custom_menu_inspection_unconfirmed', 'field_recognition', 'read_menu');continue;}
        }
        if (deepQuery(f.region,'input[type=password]').some(visible)) {skip('account_fields_preserved');continue;}
        const row=observe(e,f.label),plan=matchingPlans.find(plan=>plan.fieldId===row.fieldId);
        if (row.control==='radio') {
          if (radiosHandled.has(row.fieldId)) continue;
          radiosHandled.add(row.fieldId);
        }
        const signature=row.signature;
        if (!plan || plan.signature!==signature) {if(plan)addSkip(row.question, 'field_changed_before_fill', 'field_recognition', 'rebind_field', row.fieldId);reportMatch(row,plan,'observed','field_changed_or_new');continue;}
        if (plan.answer===null || plan.answer===undefined) {skip(plan.reason, 'answer_matching', 'match_field');reportMatch(row,plan,'unconfirmed',plan.reason,row.selected);continue;}
        let value=dateValue(e,row.question,plan.answer);
        if (value===undefined) {skip('saved_date_format_unsupported', 'answer_matching', 'match_field');reportMatch(row,plan,'unconfirmed','saved_date_format_unsupported',row.selected);continue;}
        if (row.selected!=='' && row.selected!==false) {
          const same=String(row.selected)===String(value) || row.control==='text' && typeof value==='string' && sameText(e,row.question,value);
          reportExisting(row, plan, same, skip);continue;
        }
        if (row.control==='listbox' || e.multiple) {skip('custom_choice_not_reversible', 'browser_interaction', 'operate_choice');reportMatch(row,plan,'unconfirmed','custom_choice_not_reversible',row.selected);continue;}
        if (row.control==='radio') {
          const group=composedClosest(e,'fieldset,[role=radiogroup]');
          const radios=deepQuery(group,'input[type=radio]').filter(editable);
          const matches=radios.filter(radio=>labelFor(radio)===value);
          if (matches.length!==1 || !radios.every(radio=>radio.name===e.name)) {skip('choice_not_unique', 'field_recognition', 'identify_option');reportMatch(row,plan,'unconfirmed','choice_not_unique');continue;}
          e=matches[0];value=true;
        } else if (row.control==='select') {
          const options=[...e.options].filter(o=>!o.disabled && o.value && o.textContent.trim()===value);
          if (options.length!==1) {skip('choice_not_unique', 'field_recognition', 'identify_option');reportMatch(row,plan,'unconfirmed','choice_not_unique');continue;}
          value=options[0].value;
        }
        if (e.type!=='checkbox' && row.control!=='radio') value=String(value);
        if (read(e)===value && row.valid) {reportMatch(row,plan,'verified','existing_value_confirmed',row.selected);continue;}
        checkDeadline();
        const change={element:e,identity:identity(e),controlIdentity:controlIdentity(e),boundLabels:[...e.labels??[]],region:f.region,before:read(e),label:row.question};
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
          skip(reason, 'browser_interaction', 'verify_field');reportMatch(row,plan,'verification_failed',reason,{before:change.before,after:e?read(e):null,written,restored});continue;
        }
        changes.push({...change,element:e,after:read(e),matchingDynamic:!!matchingRunId && state.matchingRunId===matchingRunId});result.filled.push(row.question);
        reportMatch(row,plan,'verified','product_readback_confirmed',observe(e,row.question).selected);
        continue;
      }
      if (e.matches('input.iti__tel-input[data-intl-tel-input-id]')) {
        const row = observe(e, f.label);
        const plan = matchingPlans?.find(candidate => candidate.fieldId === row.fieldId);
        if (matchingPlans !== undefined && (!plan || plan.signature !== row.signature)) {
          reportMatch(row, plan, 'observed', 'field_changed_or_new');
          continue;
        }
        const country = matchingPlans === undefined ? fact('country') : plan.phoneCountry;
        const number = matchingPlans === undefined ? fact('phone_number') : plan.answer;
        const widget = phoneWidget(e);
        const before = widget && phoneState(widget);
        const record = (outcome, reason, readback) => {
          if (plan) reportMatch(row, plan, outcome, reason, readback);
        };
        if (!applicationRegions.includes(f.region) || !widget || !before || typeof country !== 'string' || typeof number !== 'string' || !number) {
          skip('phone_country_requires_review', !widget || !before ? 'field_recognition' : 'answer_matching', !widget || !before ? 'read_phone' : 'match_phone');
          record('unconfirmed', 'phone_country_requires_review', before);
          continue;
        }
        const options = phoneOptions(widget).filter(option => norm(option.name) === norm(country) && (!plan?.phoneDial || option.dial === plan.phoneDial));
        if (options.length !== 1 || !/^[a-z]{2}$/.test(options[0].code) || !/^\d+$/.test(options[0].dial)) {
          skip('phone_country_requires_review', 'answer_matching', 'match_phone_country');
          record('unconfirmed', 'phone_country_requires_review', before);
          continue;
        }
        const after = JSON.stringify({code:options[0].code, dial:options[0].dial, number});
        if (e.value) {
          const reason = before === after ? existingMatchReason(e) : 'saved_value_conflict';
          skip(reason);
          record(before === after && row.valid ? 'verified' : 'unconfirmed', reason, before);
          continue;
        }
        const change = {element:e, identity:identity(e), region:f.region, label:f.label, phoneCountry:widget, before, after};
        try {
          await selectPhone(change, after);
          changes.push(change);
          result.filled.push(f.label);
          record('verified', 'product_readback_confirmed', phoneState(widget));
        } catch {
          const observed = phoneState(widget);
          const reason = observed === before ? 'phone_country_requires_review' : 'phone_country_change_requires_review';
          skip(reason, 'browser_interaction', 'verify_phone');
          record('unconfirmed', reason, observed);
        }
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
          skip('choice_requires_mapping', 'answer_matching', 'match_field'); continue;
        }
        const choiceKey = text => norm(country ? text.replace(/\s*\+\d+\s*$/, '') : text);
        const selected = () => control.querySelector('.select__single-value')?.textContent?.trim();
        const present = selected();
        if (present || e.value) {
          skip(present && choiceKey(present) === norm(expected) ? existingMatchReason(e) : 'saved_value_conflict');
          continue;
        }
        // The site does not expose a verified native reset to the blank state.
        skip('custom_choice_not_reversible', 'browser_interaction', 'operate_choice');
        continue;
      }
      if (e.type === 'checkbox' || e.multiple) { skip('choice_requires_mapping', 'answer_matching', 'match_field'); continue; }
      if (typeof f.expected !== 'string' || !f.expected) {
        const prior=uploadReceipt?.fieldsBefore.find(field=>field.identity===f.identity && field.region===f.region);
        skip(uploadReceipt?.parserCompleted && e.value && (!prior || prior.initialValue!==e.value)
          ? 'resume_parser_unmapped_value_requires_review' : 'no_stored_mapping');
        continue;
      }
      const region = regionFor(e);
      if (fields.filter(other => {const current=currentElement(other);return norm(other.label) === norm(f.label) && current && regionFor(current) === region;}).length > 1) { skip('ambiguous_duplicate', 'field_recognition', 'identify_field'); continue; }
      let value = dateValue(e,f.label,f.expected);
      if(value===undefined) {skip('saved_date_format_unsupported', 'answer_matching', 'match_field');continue;}
      if (e instanceof HTMLSelectElement) {
        const options = [...e.options].filter(o => !o.disabled && (norm(o.textContent) === norm(value) || norm(o.value) === norm(value)));
        if (options.length !== 1) { skip('option_not_found', 'answer_matching', 'match_field'); continue; }
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
        skip(e?'value_not_accepted':'field_replaced_without_stable_identity', e?'browser_interaction':'field_recognition', e?'verify_field':'identify_field');continue;
      }
      changes.push({ ...change, element:e, after:e.value }); result.filled.push(f.label);
    }
    await provinceMenu.reconcile({fact, matchingPlans, scope, applicationRegions, fabricWidget, observe, reportMatch, isRequired, result, addSkip, changes});
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
      addSkip(change.label, 'value_changed_after_fill', change.uploadReceipt?'uploads':'browser_interaction', change.uploadReceipt?'verify_attachment':'verify_field');
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
      addSkip(change.label, 'value_changed_after_fill', change.uploadReceipt?'uploads':'browser_interaction', change.uploadReceipt?'verify_attachment':'verify_field');
      for (const row of result.matching.filter(row=>row.question===change.label && row.outcome==='verified')) {row.outcome='verification_failed';row.reason='value_changed_after_fill';row.provisional=true;}
    }
    return result;
  } finally {
    if (action === 'fill' && changes.length) { if (matchingRunId && state.matchingRunId===matchingRunId && state.undo.length) state.undo.at(-1).push(...changes); else state.undo.push(changes); state.matchingRunId=matchingRunId; state.undo = state.undo.slice(-10); state.redo = []; }
    const failed = result.skipped.find(row => row.componentFailure);
    if (failed) result.componentFailure = failed.componentFailure;
    state.busy = false; result.canUndo = state.undo.length > 0; result.canRedo = state.redo.length > 0;
    if(state.unconfirmedControls?.some(change=>change.region?.isConnected))result.incomplete=true;
    if(state.unconfirmedChoiceHistory?.some(change=>change.region?.isConnected && searchChoiceCandidates(change.region).some(input=>pendingChoice(sharedChoice(input))===change)))result.incomplete=true;
  }
}
