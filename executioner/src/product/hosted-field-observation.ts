import type { Page } from 'playwright';
import { uploadLabelKind } from '../../extension/page-runtime/upload-label.js';
import { annotateQuestionContext } from '../../extension/question-context.js';
import { ApplicationPause } from './application-contract.ts';

const controls = 'input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea,.ashby-application-form-input-yesno,[role=group][data-ui]:has(input[type=checkbox]),.application-field:has(>ul[data-qa=checkboxes])';

export async function inspectHostedFields(page: Page) {
  await page.evaluate(annotateQuestionContext);
  const fields = await page.locator(controls).evaluateAll(elements => {
    const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
    const clean = (s: string) => s.replace(/[✱*]/g, '').replace(/\s+/g, ' ').trim();
    const labelContent = (e: Element, includeAsterisk = false) => {
      const copy = e.cloneNode(true) as Element;
      copy.querySelectorAll('input,select,textarea,button,svg,[role=option],.dropdown-container,[hidden]').forEach(x => x.remove());
      copy.querySelectorAll('[aria-hidden=true]').forEach(x => {
        if (!includeAsterisk || !/^[✱*]$/.test(x.textContent?.trim() ?? '')) x.remove();
      });
      return copy.textContent ?? '';
    };
    const labelText = (e: Element) => clean(labelContent(e));
    const committedChoice = (e: HTMLInputElement) => {
      if (location.hostname === 'jobs.ashbyhq.com' && e.matches('.ashby-application-form-input-autocomplete[aria-autocomplete=list]')) {
        const restored = (e as HTMLInputElement & { huntRestoredChoice?: string }).huntRestoredChoice;
        return restored && restored === e.value && e !== document.activeElement && e.getAttribute('aria-expanded') === 'false' ? restored : '';
      }
      const control=e.closest('.select__control');
      const pill=control?.querySelector('[class*=single-value]')?.textContent?.trim() ||
        [...control?.querySelectorAll('.select__multi-value__label')??[]].map(node=>node.textContent?.trim()).join('; ');
      if(pill)return pill;
      const id=e.getAttribute('aria-controls'), menus=id?[...document.querySelectorAll(`[id="${CSS.escape(id)}"]`)]:[];
      const selected=menus.length===1?[...menus[0]!.querySelectorAll('[role=option][aria-selected=true]')]:[];
      const label=selected.length===1?selected[0]!.textContent?.trim():undefined;
      return e.getAttribute('aria-expanded')!=='true' && label && label===e.value.trim()?label:'';
    };
    const forms = [...document.querySelectorAll('form,[role=form]')];
    const out = [];
    const radioVisible=(e:Element)=>visible(e)||!!e.closest('[role=radio]')&&visible(e.closest('[role=radio]')!);
    const selected=(e:HTMLInputElement)=>{const aria=e.closest('[role=radio],[role=checkbox]')?.getAttribute('aria-checked');return aria!==undefined&&aria!==null?aria==='true':e.checked;};
    const radioNames = new Set<string>();
    for (const [index, raw] of elements.entries()) {
      const e = raw as HTMLInputElement;
      if (e.getAttribute('aria-hidden')==='true' && e.tabIndex===-1 && e.closest('[class*=select],[data-input-type=select]')?.querySelector('[role=combobox]')) continue;
      if (e.disabled || e.type === 'hidden' || /captcha|beecatcher/i.test(e.name ?? '') || e.closest('.ashby-application-form-autofill-input-root') || e.type === 'checkbox' && e.closest('.ashby-application-form-input-yesno')) continue;
      if(e.type==='checkbox'&&e.closest('[role=group][data-ui],.application-field:has(>ul[data-qa=checkboxes])'))continue;
      if(e.type==='radio' && radioNames.has(e.name))continue;
      if(e.type==='radio')radioNames.add(e.name);
      const radios=e.type==='radio'?[...document.querySelectorAll<HTMLInputElement>('input[type=radio]')].filter(r=>r.name===e.name&&radioVisible(r)):[];
      const radioGroup = radios.length ? e.closest('fieldset,[role=radiogroup],[class*=consentRadioGroupItem]') : null;
      const uploadCandidate=e.type==='file'?e.closest('[role=group][aria-labelledby],fieldset'):null;
      const uploadGroup=uploadCandidate?.querySelectorAll('input:not([type=hidden]),select,textarea').length===1?uploadCandidate:null;
      let group = radioGroup ?? e.closest('.ashby-application-form-field-entry,.application-question,.application-field,.field,fieldset') ?? e.parentElement;
      const referenceIds=[...new Set((e.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean))];
      const referenceMatches=referenceIds.map(id=>[...(e.getRootNode() as Document|ShadowRoot).querySelectorAll(`[id="${CSS.escape(id)}"]`)]);
      const referenced=referenceMatches.every(matches=>matches.length===1)?referenceMatches.map(matches=>matches[0]!):[];
      const ownLabels = [...e.labels ?? []];
      const descriptiveIds = new Set((e.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
      const labelsOnly = referenced.filter(label => !descriptiveIds.has(label.id));
      let labelOwners: Element[] = labelsOnly.length ? labelsOnly : ownLabels;
      let label = labelsOnly.map(labelText).join(' ').trim() || clean(e.getAttribute('aria-label') ?? '') || ownLabels.map(labelText).join(' ');
      const fileLabels = e.type === 'file' ? [e.getAttribute('aria-label') ?? '', ...labelsOnly.map(labelText), ...ownLabels.map(labelText)] : [];
      const ambiguousFile = e.type === 'file' && (referenceMatches.some(matches => matches.length!==1) || e.multiple);
      if(uploadGroup) {
        const owners=(uploadGroup.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean).flatMap(id=>{
          const matches=[...document.querySelectorAll(`[id="${CSS.escape(id)}"]`)];
          return matches.length===1&&uploadGroup.contains(matches[0]!)?matches:[];
        });
        if(!owners.length && uploadGroup.matches('fieldset')) {const legend=uploadGroup.querySelector(':scope > legend');if(legend)owners.push(legend);}
        if(owners.length){
          group=uploadGroup;
          fileLabels.push(...owners.map(labelText));
          if(!label || /^(?:attach|replace file|choose files?|select files?|upload)(?:\s*[✱*])?$/i.test(label))label=owners.map(labelText).join(' ');
          labelOwners=[...labelOwners,...owners];
        }
      }
      if (!(e.type==='radio'?radioVisible(e):visible(e)) && !(e.type === 'file' && group && visible(group))) continue;
      const eeoName = e.tagName === 'SELECT' && location.hostname === 'jobs.lever.co'
        ? /^eeo\[(race|veteran|disability|gender)\]$/.exec(e.name ?? '')?.[1] : undefined;
      if (eeoName) {
        label = {race:'Race',veteran:'Veteran status',disability:'Disability status',gender:'Gender'}[eeoName] ?? label;
      }
      const precedingLabel = e.closest('.application-field')?.previousElementSibling;
      const ashbyButtons = e.matches('.ashby-application-form-input-yesno');
      let ambiguousTitles: Element[] | undefined;
      let ashbyEntryRequired = false;
      const bareFieldset = location.hostname === 'jobs.ashbyhq.com' && e.matches('input.ashby-application-form-input-autocomplete[role=combobox]')
        ? e.closest('fieldset') : null;
      const fullEntry = e.closest('.ashby-application-form-field-entry[data-field-entry-id][data-field-path]');
      const ashbyEntry = fullEntry ?? bareFieldset;
      if (ashbyEntry && (ashbyButtons || e.matches('input[role=combobox]'))) {
        // Ashby titles can refer to an ID that is absent from the rendered entry.
        const isBare = !fullEntry;
        const activeInEntry = (node: Element) => node.closest(isBare ? 'fieldset,.ashby-application-form-field-entry' : '.ashby-application-form-field-entry') === ashbyEntry &&
          visible(node) && !node.closest('[hidden],[inert],[aria-hidden=true]');
        const titles = [...ashbyEntry.querySelectorAll<HTMLLabelElement>(isBare ? ':scope > label.ashby-application-form-question-title' : 'label.ashby-application-form-question-title')].filter(activeInEntry);
        const widgetSelector = isBare ? 'input:not([type=hidden]),select,textarea,.ashby-application-form-input-yesno' : '.ashby-application-form-input-yesno,input[role=combobox]';
        const widgets = [...ashbyEntry.querySelectorAll(widgetSelector)].filter(activeInEntry);
        if (widgets.includes(e)) {
          ashbyEntryRequired = !!ashbyEntry.querySelector(':scope > .ashby-application-form-field-required');
          if (ashbyEntryRequired && (widgets.length > 1 || titles.length > 1)) return null;
          const orphans = titles.filter(title=>title.htmlFor && !document.getElementById(title.htmlFor));
          if (titles.length === 1 && widgets.length === 1 && orphans[0]) {
            labelOwners = [...new Set([...labelOwners, orphans[0]])];
            if (!label) label = labelText(orphans[0]);
          } else ambiguousTitles = orphans;
        }
      }
      const ownsLabel = (candidate: Element) => candidate instanceof HTMLLabelElement
        ? candidate.control === e || (ashbyButtons && group?.matches('.ashby-application-form-field-entry') &&
          candidate === group.firstElementChild && !candidate.hasAttribute('for') && !candidate.control &&
          group.querySelectorAll('.ashby-application-form-input-yesno').length === 1)
        : candidate.matches('.application-label,.application-question-title,legend');
      if (!label && precedingLabel && ownsLabel(precedingLabel)) {
        labelOwners = [precedingLabel];
        label = labelText(precedingLabel);
      }
      if(e.matches('.application-field:has(>ul[data-qa=checkboxes])')){const owner=e.parentElement?.querySelector('.application-label');if(owner)label=labelText(owner);}
      if (!label) {
        for (let parent = e.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
          if (e.type==='file' && parent.querySelectorAll('input:not([type=hidden]),select,textarea').length!==1) break;
          const candidate = parent.querySelector('label,legend,.application-label,.application-question-title');
          if (candidate && !ownsLabel(candidate)) break;
          if (candidate) { labelOwners = [candidate]; label = labelText(candidate); break; }
        }
      }
      if (e.type==='file' && !fileLabels.some(Boolean) && label) fileLabels.push(label);
      if (!label) label = e.getAttribute('placeholder') ?? '';
      if(radios.length) {
        const owner=document.getElementById(radioGroup?.getAttribute('aria-labelledby')??'') ?? radioGroup?.querySelector('legend,.ashby-application-form-question-title') ?? (radioGroup?.matches('[class*=consentRadioGroupItem]') ? radioGroup.querySelector('p') : null) ?? e.closest('.ashby-application-form-field-entry')?.querySelector('.ashby-application-form-question-title') ?? e.closest('.application-field')?.parentElement?.querySelector('.application-label');
        if(!owner)throw new Error('Radio question owner missing');labelOwners=[owner];label=labelText(owner);
      }
      const section = e.closest('.ashby-application-form-section-container');
      const oneOf = /answer (?:1|one) of \d+ questions/i.test(section?.querySelector('h2')?.textContent ?? '');
      const sectionInputs = section ? [...section.querySelectorAll('textarea')] : [];
      const groupRequired = oneOf && !sectionInputs.some(t => t.value.trim()) && (sectionInputs[0] as Element) === e;
      const multiChecks=e.matches('[role=group][data-ui],.application-field:has(>ul[data-qa=checkboxes])')?[...e.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]:[];
      const requiredMarker = '[data-required=true],.required,.ashby-application-form-field-required,[class*=_required_]';
      const hasRequiredMarker = (owner: Element) => owner.matches(requiredMarker) ||
        !!owner.querySelector(requiredMarker) || /[✱*]\s*$/.test(labelContent(owner, true)) || (()=>{
          const original=clean(labelContent(owner));
          for(let cluster=owner.parentElement,depth=0;cluster && depth<2;cluster=cluster.parentElement,depth++) {
            if(cluster.querySelector('input,select,textarea'))break;
            const text=labelContent(cluster,true).trim();
            if(clean(text)===original && /(?:^[✱*]|[✱*]$)/.test(text))return true;
          }
          return false;
        })();
      if (ambiguousTitles?.some(hasRequiredMarker)) return null;
      const markedLabel = labelOwners.some(hasRequiredMarker);
      const ashbyMarker = ashbyEntryRequired || group?.matches('.ashby-application-form-field-entry') &&
        !!group.querySelector(':scope > .ashby-application-form-field-required');
      const uploadWrapper=e.type==='file'?e.closest('.ashby-application-form-field-entry,.application-question,.application-field,.field'):null;
      const uploadWrapperRequired=uploadWrapper?.querySelectorAll('input:not([type=hidden]),select,textarea').length===1 &&
        (uploadWrapper.matches('[data-required=true],[aria-required=true]') || !!uploadWrapper.querySelector(':scope > .ashby-application-form-field-required'));
      const required = !!e.closest('[data-input-type=select]')?.querySelector('input[required]') ||
        multiChecks.some(c=>c.required) || radios.some(r=>r.required || r.getAttribute('aria-required')==='true') ||
        groupRequired || e.required || e.getAttribute('aria-required') === 'true' || (!eeoName && markedLabel) || ashbyMarker || uploadWrapperRequired ||
        !!group?.matches('[data-required=true],[aria-required=true]');
      const maskedDate = location.hostname==='apply.workable.com' && e.type==='text' && e.placeholder==='MM/DD/YYYY' && e.inputMode==='tel';
      const kind = multiChecks.length?'multicheck':e.classList.contains('ashby-application-form-input-yesno') ? 'buttons' : e.type === 'file' ? 'file' : e.id === 'location-input' && e.closest('.application-field') ? 'location' : e.tagName === 'SELECT' ? 'select' : e.getAttribute('role') === 'combobox' ? 'combobox' : e.type === 'radio' ? 'radio' : e.type === 'checkbox' ? 'checkbox' : e.tagName === 'TEXTAREA' ? 'textarea' : maskedDate || e.type === 'date' ? 'date' : 'text';
      label = e.getAttribute('data-hunt-question-context') || label;
      const key = `hosted-${index}`;
      e.setAttribute('data-c3-hosted', key);
      const options = kind==='multicheck'?multiChecks.map(r=>[...r.labels??[]].map(labelText).join(' ')):kind==='radio'?radios.map(r=>[...r.labels??[]].map(labelText).join(' ')):kind === 'select' ? [...(raw as HTMLSelectElement).options].filter(o => !o.disabled && o.value).map(o => o.textContent?.trim() ?? '') : kind === 'buttons' ? [...e.querySelectorAll('button[data-option]')].map(o => o.textContent?.trim() ?? '') : [];
      let buttonValue = '';
      let buttonConflict = false;
      if (ashbyButtons) {
        const pressed = e.querySelectorAll<HTMLButtonElement>('button[data-option][aria-pressed=true]');
        const backers = e.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
        const choice = pressed.length === 1 ? pressed[0] : undefined;
        if (choice && (backers.length === 0 || backers.length === 1 &&
          ['yes', 'no'].includes(choice.dataset.option ?? '') && backers[0]!.checked === (choice.dataset.option === 'yes'))) {
          buttonValue = choice.textContent?.trim() ?? '';
        }
        buttonConflict = !buttonValue && (pressed.length > 0 || [...backers].some(input=>input.checked));
      }
      let value = kind==='select'?[...(raw as HTMLSelectElement).selectedOptions].filter(o=>!o.disabled&&o.value).map(o=>o.textContent?.trim()??'').join('; '):kind==='multicheck'?multiChecks.filter(selected).map(r=>[...r.labels??[]].map(labelText).join(' ')).join('; '):kind==='radio'?radios.filter(selected).map(r=>[...r.labels??[]].map(labelText).join(' ')).join(''):kind === 'buttons' ? buttonValue : kind === 'combobox' ? committedChoice(e) : e.value ?? '';
      if (kind === 'location' && location.hostname === 'jobs.lever.co' && e.matches('#location-input.location-input[name=location]')) {
        const backing = e.closest('.application-field')?.querySelectorAll<HTMLInputElement>('input#selected-location[type=hidden][name=selectedLocation]');
        try {
          const selected = backing?.length === 1 && JSON.parse(backing[0]!.value);
          value = typeof selected?.name === 'string' && selected.name === e.value ? e.value : '';
        } catch { value = ''; }
      }
      const owner = e.form ?? (e.hasAttribute('form') ? null : e.closest('form,[role=form]'));
      const formId = owner ? forms.indexOf(owner) : -1;
      out.push({ key, fileLabels, ambiguousFile, ...(formId >= 0 && {formId: String(formId)}), label, required, kind, options, value, checked: radios.length?radios.some(selected):e.checked ?? false, files: e.files?.length ?? 0,
        ...(buttonConflict && {buttonConflict: true}), valid: !buttonConflict && e.getAttribute('aria-invalid') !== 'true' && (!e.validity || e.validity.valid), name: e.name ?? '',
        inputType: e.type, min: e.min === '' ? null : Number(e.min), max: e.max === '' ? null : Number(e.max), step: e.step === 'any' ? null : Number(e.step || '1'), minLength: e.minLength, maxLength: e.maxLength, pattern: e.pattern ?? '', readOnly: e.readOnly ?? false });
    }
    return out;
  });
  if (fields === null) throw new ApplicationPause('A required choice has ambiguous controls. Inspect the application before retrying.');
  return fields.map(({fileLabels,ambiguousFile,...field}) => {
    const labels = fileLabels.map(uploadLabelKind);
    return {...field, ...(field.kind==='file' && {resumeTarget:!ambiguousFile && labels.includes('resume') && !labels.includes('other')})};
  });
}
