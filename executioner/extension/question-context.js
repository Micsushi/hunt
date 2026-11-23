/** Annotate associated declarations before any workflow resolves a consent decision. */
export function annotateQuestionContext(mode) {
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const unique = values => [...new Set(values.map(clean).filter(Boolean))];
  const labelText = node => {
    if (!node.querySelector('input,select,textarea,button')) return clean(node.textContent);
    const copy=node.cloneNode(true);
    copy.querySelectorAll('input,select,textarea,button').forEach(control=>control.remove());
    return clean(copy.textContent);
  };
  const visible = node => node.getClientRects().length > 0 && !node.closest('[hidden],[aria-hidden=true],[inert]') &&
    getComputedStyle(node).visibility !== 'hidden';
  const groups='fieldset,[role=radiogroup]';
  const controls='input:not([type=hidden]),select,textarea,button,[role=checkbox],[role=radio],[role=combobox]';
  const approval=/\b(?:consent|privacy|agree to|i (?:agree|accept|acknowledge)|(?:applicant|application|recruitment|account) terms|terms (?:and conditions|of (?:use|service)))\b|^(?:terms|agree|accept|acknowledge)[.*✱\s]*$/i;
  const screening=/\b(?:ai|artificial intelligence|automated)\b.*\b(?:screening|evaluation|assessment) of (?:my|your|this|the) (?:application|resume|candidacy)\b/i;
  const bareOption=/^(?:yes|no|(?:i )?(?:agree|disagree|accept|decline)|please select|select(?: one)?|choose(?: one)?)\s*[*✱]?$/i;
  // Browser adapters pass their already-bound question, title nodes and options to the same reader.
  const read = (e, observedLabel='', observedTitles=[], observedMembers) => {
    const root=e.getRootNode();
    let ambiguous=false;
    const refs=(node,attribute)=>{
      const values=[];
      for (const id of (node.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
        const matches=root.querySelectorAll('[id="'+CSS.escape(id)+'"]');
        if (matches.length!==1) ambiguous=true;
        for (const target of matches) {
          const text=unique([target.getAttribute('aria-label'),labelText(target)]);
          if (!text.length) ambiguous=true;
          values.push(...text);
        }
      }
      return values;
    };
    const names=node=>unique([...refs(node,'aria-labelledby'),node.getAttribute('aria-label')]);
    const descriptions=node=>unique([...refs(node,'aria-describedby'),node.getAttribute('aria-description')]);
    const checkbox=e.matches('input[type=checkbox],[role=checkbox]');
    const group=e.matches(groups) || !!observedMembers?.length;
    const labels=[...new Set([...e.labels || [],...observedTitles])];
    const legend=(group ? e : e.closest('fieldset'))?.querySelector(':scope > legend');
    const titles=unique([observedLabel,...names(e),...labels.flatMap(node=>[...names(node),labelText(node)]),
      group && legend ? labelText(legend) : '', e.getAttribute('role')==='checkbox' ? labelText(e) : '']);
    const label=titles[0] || '';
    if (checkbox) e.setAttribute('data-hunt-question-label', label);
    const associated=[...descriptions(e),...labels.flatMap(descriptions)];
    const fieldset=e.closest('fieldset');
    const soleField=!group && fieldset && [...fieldset.querySelectorAll(controls)].every(control=>control===e || e.contains(control));
    if (soleField) {
      associated.push(...names(fieldset),...descriptions(fieldset));
      if (legend) associated.push(labelText(legend));
    }
    if (legend && (group || soleField)) {
      associated.push(...names(legend),...descriptions(legend));
    }
    const members=observedMembers || (group ? [...e.querySelectorAll('input[type=radio],[role=radio]')].filter(node=>node.closest(groups)===e) :
      e.matches('select') ? [...e.options].filter(option=>!option.disabled && option.value) : []);
    // A declaration on just one choice is not a shared affirmative decision.
    const scopes=members.map(member=>{
      const labels=[...member.labels || []].filter(node=>node.control===member);
      const owner=member.closest('optgroup');
      const optionTitles=unique([...names(member),labelText(member),...labels.flatMap(node=>[...names(node),labelText(node)])]);
      if (!e.contains(member)) ambiguous=true;
      return unique([...optionTitles.filter(text=>!bareOption.test(text)),...descriptions(member),
        ...labels.flatMap(descriptions),...owner ? [...names(owner),...descriptions(owner)] : []]).sort();
    });
    if (new Set(scopes.map(parts=>JSON.stringify(parts))).size>1) ambiguous=true;
    associated.push(...scopes.flat());
    const declared=unique([...titles,...associated]).join(' ');
    if (!approval.test(label) && !approval.test(declared) && !screening.test(declared)) return;
    if (ambiguous) {
      return `Consent details could not be verified. ${declared}`.trim();
    }
    const specific=unique([...titles.slice(1),...associated]).filter(text=>text!==label);
    for (let owner=group ? e : e.parentElement,depth=0;owner && depth<5 && !owner.matches('form,body,main,[role=form]');owner=owner.parentElement,depth++) {
      const owned=[...owner.querySelectorAll(controls)];
      if (owned.some(control=>control!==e && !control.contains(e) && !e.contains(control))) break;
      if (group && owned.some(control=>!members.includes(control))) break;
      const notes=unique([...owner.querySelectorAll('p,[role=note]')].filter(node=>visible(node) && !node.closest('label')).map(labelText));
      if (!notes.length) continue;
      specific.push(...notes.filter(text=>text!==label));
      break;
    }
    if (specific.length) return unique([label,...specific]).join(' ');
  };
  if (mode==='reader') return read;
  const roots=[document];
  for (const root of roots) {
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
    for (const e of root.querySelectorAll('input:not([type=hidden],[type=file],[type=radio],[type=button],[type=submit]),textarea,select,[role=checkbox],[role=combobox],[aria-haspopup=listbox],fieldset:has(input[type=radio]),[role=radiogroup]')) {
      e.removeAttribute('data-hunt-question-context');
      e.removeAttribute('data-hunt-question-label');
      const context=read(e);
      if (context) e.setAttribute('data-hunt-question-context',context);
    }
  }
}
