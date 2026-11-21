export function createRequiredFieldReader({
  jobviteProof, fabricWidget, composedClosest, deepQuery, rawLabelFor, fileBinding, state, regionFor, resumeLabel
}) {
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
    // A shared group marker does not identify which sibling must be filled.
    if (owner?.matches('[role=group]') && deepQuery(owner,'input:not([type=hidden]),textarea,select,button[aria-haspopup=listbox],button[role=combobox]').some(control=>control!==e)) return false;
    return !!owner && (owner.getAttribute('data-required')==='true' || owner.getAttribute('aria-required')==='true' ||
      !!owner.querySelector('[data-automation-id="required"],abbr[title="required" i],[aria-label="required" i],.ashby-application-form-field-required'));
  };
  return { isRequired };
}
