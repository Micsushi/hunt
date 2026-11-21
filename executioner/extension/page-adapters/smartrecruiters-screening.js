import { smartRecruitersOptions } from './smartrecruiters-city.js';

// The fieldset and its radio hosts live in different shadow roots. The group publishes the selected option's value.
export function createSmartRecruitersScreening(form, deepQuery, composedClosest, visible) {
  const labelOf = host => {
    const labels = [...host?.children??[]].filter(child=>child.slot==='label-content');
    return labels.length===1 ? labels[0].textContent.trim() : '';
  };
  const selectQuestion = element => {
    if (!element.matches('input[role=combobox][id^=question_]')) return null;
    const host = composedClosest(element,'spl-autocomplete');
    const field = host && composedClosest(host,'sr-question-field-select');
    const definition = field && composedClosest(field,'sr-screening-questions-form[data-test=screening-questions-form]');
    if (!definition || host.id!==element.id || deepQuery(field,'spl-autocomplete').length!==1 ||
        deepQuery(host,'input[role=combobox]').length!==1) return null;
    let questions;
    try { questions=JSON.parse(definition.getAttribute('definition')).questions; } catch { return null; }
    const rows = Array.isArray(questions) && questions.filter(row=>row.type==='select' && 'question_'+row.id===element.id);
    if (rows.length!==1 || typeof rows[0].label!=='string') return null;
    const fields = rows[0].fields;
    const choices = fields?.length===1 && fields[0].multipleChoice===false && fields[0].questionsFieldValues;
    if (!Array.isArray(choices) || !choices.length || choices.some(choice=>!choice?.label || !choice.id || choice.fieldValue!==choice.id)) return null;
    const options=choices.map(choice=>choice.label), values=choices.map(choice=>choice.id);
    if (new Set(options).size!==options.length || new Set(values).size!==values.length) return null;
    // A search string can equal an option. Require the same employer option identifier behind the display.
    const backing=host.value;
    const value=typeof backing==='string' ? backing : backing?.value ?? backing?.id;
    const index=values.indexOf(value);
    const selected=index>=0 && element.value===options[index] && element.getAttribute('aria-invalid')!=='true' ? options[index] : '';
    return {host,question:rows[0].label,control:'listbox',options,values,selected,value:value??'',
      coherent:!!selected || !element.value && (backing==null || backing==='') && !host.getAttribute('value'),required:rows[0].required===true && element.getAttribute('aria-required')==='true',valid:!!selected};
  };
  const label = element => {
    if (!form?.screening || form.region(element)!==form.owner) return '';
    if (element.type==='checkbox') return labelOf(composedClosest(element,'spl-checkbox[data-test=consent-box]'));
    if (element.matches('fieldset[role=radiogroup]')) return labelOf(composedClosest(element,'spl-radio-group'));
    return selectQuestion(element)?.question ?? '';
  };
  const read = element => {
    if (!form?.screening || form.region(element)!==form.owner) return null;
    if (!element.matches('fieldset[role=radiogroup]')) return selectQuestion(element);
    const host = composedClosest(element,'spl-radio-group');
    const question = label(element);
    if (!host || !question || !composedClosest(host,'sr-question-field-radio') ||
        deepQuery(host,'fieldset[role=radiogroup]').length!==1) return null;
    const choices = [...host.children].filter(node => node.matches('spl-radio[role=radio]'));
    const options = choices.map(node=>node.getAttribute('label')?.trim());
    const values = choices.map(node=>node.getAttribute('value'));
    const selected = choices.filter(node=>node.getAttribute('aria-checked')==='true');
    const value = host.getAttribute('value');
    const coherent = choices.length>0 && new Set(options).size===choices.length && options.every(Boolean) &&
      new Set(values).size===choices.length && values.every(v=>v!==null && v!=='') &&
      choices.every(node=>visible(node) && node.getAttribute('aria-disabled')==='false' && /^(true|false)$/.test(node.getAttribute('aria-checked')??'')) &&
      (selected.length===0 && value==='' || selected.length===1 && selected[0].getAttribute('value')===value);
    return {host,question,control:'radio',options,choices,values,selected:coherent && selected.length?selected[0].getAttribute('label').trim():'',
      value,coherent,required:element.getAttribute('aria-required')==='true',valid:coherent && selected.length===1};
  };
  const select = async (element, observed, answer, checkDeadline, onChoiceClick) => {
    const before = read(element);
    if (!before?.coherent || before.host!==observed.host || before.selected || !form.current()) return false;
    const index = before.options.indexOf(answer);
    if (index<0 || before.values[index]!==observed.values[index]) return false;
    checkDeadline();
    if (before.control==='listbox') {
      if (element.getAttribute('aria-expanded')!=='true') element.click();
      let option;
      for (let attempt=0; attempt<10 && !option; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,50));
        checkDeadline();
        const active=read(element);
        if (!form.current() || active?.host!==before.host || !active.coherent || active.selected ||
            active.values[active.options.indexOf(answer)]!==before.values[index]) return false;
        const menus=deepQuery(before.host,'[role=listbox]').filter(list=>list.id===element.getAttribute('aria-controls') && visible(list));
        if (element.getAttribute('aria-expanded')!=='true' || menus.length!==1) continue;
        const rendered=smartRecruitersOptions(before.host,menus[0],'.c-spl-autocomplete-option-content spl-truncate[title]',deepQuery,visible);
        const matches=rendered.filter(row=>row.label===answer);
        if (matches.length===1 && !matches[0].disabled) option=matches[0].node;
      }
      if (!option) return false;
      checkDeadline();
      onChoiceClick?.();
      option.click();
    } else {
      if (before.choices[index]!==observed.choices[index]) return false;
      before.choices[index].click();
    }
    for (let attempt=0; attempt<10; attempt++) {
      await new Promise(resolve=>setTimeout(resolve,50));
      checkDeadline();
      const current=read(element);
      if (!current || current.host!==before.host || !form.current()) return false;
      if (current.valid) return current.selected===answer && current.value===before.values[index];
    }
    return false;
  };
  const currentChoice = (element, original) => {
    if (!element.isConnected || !form?.current()) return null;
    const current = read(element);
    if (current?.control !== 'listbox' || !current.coherent || current.host !== original.host ||
        current.question !== original.question || current.options.length !== original.options.length ||
        current.options.some((label,i) => label !== original.options[i] || current.values[i] !== original.values[i])) return null;
    return current;
  };
  const clearButton = host => {
    const buttons = deepQuery(host,'spl-icon[role=button][aria-label],button[aria-label]').filter(node =>
      composedClosest(node,'spl-autocomplete')===host && node.getAttribute('aria-label')?.trim().replace(/\s+/g,' ')==='Clear value' &&
      visible(node) && !node.disabled && !composedClosest(node,'[inert],[aria-disabled=true],[aria-hidden=true]') &&
      !(node instanceof HTMLButtonElement && node.form && node.type==='submit'));
    return buttons.length===1 ? buttons[0] : null;
  };
  const historyValue = (element, original) => {
    const current = currentChoice(element,original);
    // A radio has no supported way back to unanswered. Only journal choices with an employer-provided inverse.
    return current && (!current.selected || clearButton(current.host)) ? current.value : null;
  };
  const restore = async (element, original, from, to, checkDeadline) => {
    if (historyValue(element,original)!==from) throw new Error('The screening choice changed. Your edits were preserved.');
    checkDeadline();
    if (to) {
      const answer = original.options[original.values.indexOf(to)];
      if (answer && await select(element,original,answer,checkDeadline) && historyValue(element,original)===to) return;
    } else {
      clearButton(original.host).click();
      for (let attempt=0; attempt<10; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,50));
        checkDeadline();
        const value = historyValue(element,original);
        if (value==='') return;
        if (value!==from) break;
      }
    }
    throw new Error('The employer did not confirm the restored screening choice.');
  };
  return {label,read,select,historyValue,restore};
}
