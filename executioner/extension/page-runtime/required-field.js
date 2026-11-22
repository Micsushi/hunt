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
  const unresolvedAttachment = input => {
    if (!input.willValidate ||
        composedClosest(input, '[inert],[aria-disabled=true]') || composedClosest(composedParent(input),'[hidden],[aria-hidden=true]')) return;
    const shown = node => node.checkVisibility({visibilityProperty:true,opacityProperty:true}) &&
      !composedClosest(node,'[hidden],[inert],[aria-hidden=true]');
    const ownLabel=rawLabelFor(input);
    let label=otherAttachment(ownLabel) ? ownLabel : '';
    let owner=input;
    let required=input.required || input.getAttribute('aria-required')==='true';
    const region=regionFor(input);
    for (let group=composedParent(input); group && group!==region && !group.matches('form,body,html'); group=composedParent(group)) {
      if (deepQuery(group,'input:not([type=hidden],[type=button]),textarea,select').some(node=>node!==input)) break;
      owner=group;
      if (!shown(group)) continue;
      required ||= group.getAttribute('aria-required')==='true' || group.getAttribute('data-required')==='true';
      const heading=(group.innerText ?? '').trim().split('\n')[0];
      if (!label && otherAttachment(heading)) label=heading;
    }
    const boundLabels=[...input.labels ?? []].filter(node=>node.control===input && shown(node));
    const titles=[...boundLabels,...deepQuery(owner,'p,label,legend,h1,h2,h3,h4,h5,h6,[role=heading],.application-label,.application-question-title,div,span')];
    for (const title of titles) {
      const labelledControl=title.closest('label')?.control;
      if (!shown(title) || title.closest('button,a,[role=button]') || labelledControl && labelledControl!==input ||
          deepQuery(title,'button,a,[role=button],input[type=button]').length) continue;
      // Plain layout elements can be titles, but cannot borrow the text of a neighboring widget.
      if (title.matches('div,span') && [...title.children].some(child=>{
        const part=child.innerText?.trim();
        return !child.matches('span,abbr,sup,small,strong,em') || part && !otherAttachment(part) && !/^(?:[✱*]|\(?required\)?)$/i.test(part);
      })) continue;
      const text=title.innerText.trim();
      if (!otherAttachment(text)) continue;
      label ||= text;
      required ||= /[✱*]\s*$|\(required\)\s*$/i.test(text) ||
        deepQuery(title,'abbr[title=required i],[aria-label=required i]').some(shown);
    }
    if (!label || !required) return;
    label=label.replace(/[✱*]/g,'').replace(/\s*\(required\)\s*$/i,'').trim();
    const nativeShown=shown(input);
    if (!nativeShown) {
      if (!boundLabels.length && (owner===input || !shown(owner) || !owner.innerText.trim())) return;
      // A disabled chooser makes its visible shell inactive. Custom widgets need no known trigger.
      const actions=deepQuery(owner,'button,input[type=button],[role=button],a[href],[tabindex]').filter(node=>node!==input && shown(node));
      if (actions.length && actions.every(node=>node.matches(':disabled') || composedClosest(node,'[aria-disabled=true]'))) return;
    }
    // While an upload is pending, even a retained file or ID can belong to the previous selection.
    const compact=text=>text.toLowerCase().replace(/[^\p{L}\d]/gu,'');
    const attachmentIds=['fileid','uploadid','attachmentid'];
    const names=new Set([...attachmentIds,...attachmentIds.map(suffix=>compact(label)+suffix)]);
    const pending='[role=progressbar],progress,[aria-busy=true],[data-upload-state=pending],[data-upload-state=uploading]';
    if (owner.matches(pending) && shown(owner) || deepQuery(owner,pending).some(shown)) {
      return {label,reason:'required_attachment_unconfirmed'};
    }
    const completed='[data-upload-state=success]';
    const retainedId=node=>names.has(compact(node.name)) && !/^(?:|0+|-1|null|undefined|none|false)$/i.test(node.value.trim());
    if (input.files?.length || deepQuery(owner,'input[type=hidden][name]').some(retainedId) ||
        owner.matches(completed) && shown(owner) || deepQuery(owner,completed).some(shown)) return;
    const emptyNotice=deepQuery(owner,'span,p,[role=status]').some(node=>shown(node) && /^no files? selected$/i.test(node.innerText.trim()));
    return {label,reason:nativeShown || emptyNotice ? 'required_attachment_missing' : 'required_attachment_unconfirmed'};
  };
  return { isRequired, unresolvedAttachment };
}
