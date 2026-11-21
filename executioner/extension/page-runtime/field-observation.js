export function createFieldObserver({
  deepQuery, visible, norm, fabricWidget, fabricState, state, sharedChoice, semanticChoiceButton, boundChoice, choiceState, composedClosest, editable, labelFor, isRequired, pendingFabricChange, pendingControlChange, orphanedControlChange, pendingChoice, phoneWidget, phoneState, provinceContext, provinceValue
}) {
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
  const observe = (e, label) => {
    const fabric=fabricWidget(e),fabricRead=fabric && fabricState(fabric),committed=state.committedChoices?.get(e),searchChoice=sharedChoice(e),buttonChoice=semanticChoiceButton(e)?buttonChoiceObservation(e):null;
    const province = !fabric && provinceContext(e);
    const queryDraft=searchChoice?.widget && state.choiceDrafts?.get(searchChoice.widget);
    const cachedOptions=queryDraft && boundChoice(queryDraft.change) && choiceState(searchChoice)===queryDraft.change.after?queryDraft.options:[];
    const choice=committed?.value===e.value?committed:null;
    const group=e.type==='radio' ? composedClosest(e,'fieldset,[role=radiogroup]') : null;
    const node=group??e;
    state.matchingIds??=new WeakMap();
    if (!state.matchingIds.has(node)) state.matchingIds.set(node,crypto.randomUUID());
    const radios=group ? deepQuery(group,'input[type=radio]').filter(editable) : [];
    if (group) label=group.getAttribute('aria-label') || group.querySelector('legend')?.textContent || label;
    const control=province?'listbox':group?'radio':searchChoice || buttonChoice?'listbox':fabric || e.getAttribute('role')==='combobox' || e.getAttribute('role')==='listbox'?'listbox':
      e.type==='checkbox'?'checkbox':e.tagName==='SELECT'?'select':e.tagName==='TEXTAREA'?'textarea':e.type==='date'?'date':'text';
    const menuId=e.getAttribute('aria-controls');
    const menus=menuId?deepQuery(e.getRootNode(),`[id="${CSS.escape(menuId)}"]`):[];
    // Some forms give their first placeholder a nonempty machine value.
    const noSelection=o=>!e.multiple && o.index===0 && /(?:^|[_-])no[_-]selection$/i.test(o.value) &&
      /^-+\s*no answer\s*-+$/i.test(o.label.trim());
    const availableOption=o=>o.value && !noSelection(o) && (e.multiple ? !o.matches(':disabled') && !o.closest('[hidden]') : !o.disabled);
    const optionLabel=o=>(e.multiple ? o.label : o.textContent).trim();
    const options=buttonChoice?buttonChoice.options:searchChoice?[...new Set([...searchChoice.labels,...(searchChoice.popupStatus==='ready'?searchChoice.options.filter(option=>!option.disabled).map(option=>option.label):cachedOptions)])]:fabric ? state.fabricOptions?.get(e)??[] : choice?choice.options:control==='select'?[...e.options].filter(availableOption).map(optionLabel):
      group?radios.map(labelFor):control==='listbox' && menus.length===1?[...menus[0].querySelectorAll('[role=option]')].filter(o=>o.getAttribute('aria-disabled')!=='true').map(o=>o.textContent.trim()):[];
    const selected=province ? (provinceValue(e) === 'Province –Select–' ? '' : provinceValue(e).slice(9)) : buttonChoice?buttonChoice.selected:searchChoice?searchChoice.labels.join('; '):fabric ? fabricRead?JSON.parse(fabricRead).label:'' : control==='select'?[...e.selectedOptions].filter(availableOption).map(optionLabel).join('; '):
      group?radios.filter(o=>o.checked).map(labelFor).join('; '):control==='checkbox'?e.checked:
      control==='listbox'?choice?.selected??e.closest('.select__control')?.querySelector('[class*=single-value]')?.textContent?.trim()??'':e.value;
    const number = name => e.getAttribute(name) && Number.isFinite(Number(e.getAttribute(name))) ? Number(e.getAttribute(name)) : null;
    const phone = phoneWidget(e);
    const widgetType = e.type === 'select-multiple' ? {widget:'native-multiple'} : province ? {widget:'province-menu', backing:provinceValue(e)} : e.matches('input.iti__tel-input[data-intl-tel-input-id]')
      ? {widget:'international-phone', backing:phone ? phoneState(phone) : null} : {};
    const form = e.hasAttribute('form') ? e.form : e.form ?? composedClosest(e,'form,[role=form]');
    if (form && !state.matchingIds.has(form)) state.matchingIds.set(form,crypto.randomUUID());
    const observation={...(form ? {formId:state.matchingIds.get(form)} : {}),...widgetType,pageId:location.href,fieldId:state.matchingIds.get(node),question:label,control,options,
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
  return { observe };
}
