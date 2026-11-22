export function createRequiredFieldReader({ uploadHeading, markedRequired,
  verifiedDialogUpload, fabricWidget, composedClosest, composedParent, deepQuery, rawLabelFor, fileBinding, state, regionFor, resumeLabel, otherAttachment
}) {
  const isRequired = e => {
    const attachment=verifiedDialogUpload(e);
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
        const headings=deepQuery(widget,'label,legend,h1,h2,h3,h4,h5,h6,[role=heading],' + uploadHeading);
        const firstLine=(widget.innerText??'').split('\n').find(line=>line.trim())??'';
        const references=[e,...e.labels??[],widget].flatMap(node=>(node.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean).flatMap(id=>{
          const matches=deepQuery(node.getRootNode(),`[id="${CSS.escape(id)}"]`);
          if(matches.length!==1 || matches[0]===e)return [];
          const labels=[matches[0].textContent??''];
          if(matches[0].querySelector('abbr[title="required" i],[aria-label="required" i]'))labels.push(`${matches[0].textContent??''} *`);
          // Some forms place the asterisk beside the referenced
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
    return markedRequired(e, composedClosest, deepQuery);
  };
  // Observe extra documents without opening a chooser or touching their files.
  const missingAttachmentLabel = input => {
    if (!input.willValidate || (!input.validity.valueMissing && input.getAttribute('aria-required')!=='true') || input.files?.length ||
        composedClosest(input, '[inert],[aria-disabled=true]')) return;
    const shown = node => node.checkVisibility({visibilityProperty:true,opacityProperty:true}) &&
      !composedClosest(node,'[hidden],[inert],[aria-hidden=true]');
    const ownLabel = rawLabelFor(input);
    for (let group=composedParent(input); group && group!==regionFor(input); group=composedParent(group)) {
      if (deepQuery(group,'input:not([type=hidden]),textarea,select').some(node=>node!==input)) break;
      if (deepQuery(group,'input[type=hidden]').some(node=>node.value) ||
          deepQuery(group,'a[download],[data-upload-state=success],[role=progressbar],[aria-busy=true]').length ||
          deepQuery(group,'button').some(node=>/^(remove|delete)(?: file| attachment)?$/i.test((node.getAttribute('aria-label') || node.innerText).trim()))) return;
      const lines=(group.innerText ?? '').split(/\n/).map(text=>text.trim()).filter(Boolean);
      const label=[ownLabel,lines[0]].find(text=>text && otherAttachment(text));
      if (!label) continue;
      const pickerShown=shown(input);
      const triggers=deepQuery(group,'button[type=button]').filter(button=>!button.matches(':disabled,[aria-disabled=true]') &&
        shown(button) && /^(?:choose|select|browse)(?: a)? files?[✱*]?$/i.test(button.innerText.trim()));
      const emptyNotice=deepQuery(group,'span,p,[role=status]').some(node=>shown(node) && /^no files? selected$/i.test(node.innerText.trim()));
      if (pickerShown || triggers.length===1 && emptyNotice) {
        return label.replace(/[✱*]/g,'').trim();
      }
    }
  };
  return { isRequired, missingAttachmentLabel };
}
