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
    const ownLabel=rawLabelFor(input);
    let label=otherAttachment(ownLabel) ? ownLabel : '';
    let owner=input;
    const region=regionFor(input);
    for (let group=composedParent(input); group && group!==region && !group.matches('form,body,html'); group=composedParent(group)) {
      if (deepQuery(group,'input:not([type=hidden]),textarea,select').some(node=>node!==input)) break;
      owner=group;
      const heading=(group.innerText ?? '').trim().split('\n')[0];
      if (!label && otherAttachment(heading)) label=heading;
    }
    if (!label) return;
    label=label.replace(/[✱*]/g,'').trim();
    // Only an attachment ID belonging to this picker can outweigh an empty native control.
    const compact=text=>text.toLowerCase().replace(/[^\p{L}\d]/gu,'');
    const attachmentIds=['fileid','uploadid','attachmentid'];
    const names=new Set([...attachmentIds,...attachmentIds.map(suffix=>compact(label)+suffix)]);
    if (deepQuery(owner,'input[type=hidden][name]').some(node=>names.has(compact(node.name)) && !!node.value) ||
        deepQuery(owner,'a[download],[data-upload-state=success],[role=progressbar],[aria-busy=true]').some(shown) ||
        deepQuery(owner,'button').some(node=>shown(node) && /^(remove|delete)(?: file| attachment)?$/i.test((node.getAttribute('aria-label') || node.innerText).trim()))) return;
    if (shown(input)) return label;
    const triggers=deepQuery(owner,'button[type=button]').filter(button=>!button.matches(':disabled,[aria-disabled=true]') &&
      shown(button) && /^(?:choose|select|browse)(?: a)? files?[✱*]?$/i.test(button.innerText.trim()));
    const emptyNotice=deepQuery(owner,'span,p,[role=status]').some(node=>shown(node) && /^no files? selected$/i.test(node.innerText.trim()));
    if (triggers.length===1 && emptyNotice) return label;
  };
  return { isRequired, missingAttachmentLabel };
}
