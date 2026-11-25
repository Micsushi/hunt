export function createRequiredFieldReader({ uploadHeading, markedRequired, readRequiredControl,
  verifiedDialogUpload, fabricWidget, radioSelected, composedClosest, composedParent, deepQuery, rawLabelFor, fileBinding, state, regionFor, resumeLabel, otherAttachment
}) {
  const requiredLabel=label=>label.matches('.Mui-required') || label.querySelector('abbr[title="required" i],[aria-label="required" i]');
  const isRequired = e => {
    const attachment=verifiedDialogUpload(e);
    if(attachment && isRequired(attachment.trigger))return true;
    const fabric=fabricWidget(e);if(fabric)return isRequired(fabric.backing);
    const group=composedClosest(e,'fieldset,[role=radiogroup]');
    if (e.required || e.getAttribute('aria-required')==='true' ||
        [...e.labels??[]].some(requiredLabel) ||
        e.type==='radio' && group && (group.getAttribute('aria-required')==='true' ||
          deepQuery(group,'input[type=radio]').some(r=>r.required || r.getAttribute('aria-required')==='true'))) return true;
    const originalLabel=e.getAttribute('data-hunt-question-label')||rawLabelFor(e);
    const label=e.type==='radio' && group ? group.getAttribute('data-hunt-question-label') ?? group.getAttribute('aria-label') ?? group.querySelector('legend')?.textContent ?? originalLabel : originalLabel;
    if (/[✱*]\s*(?:required\s*)?$/i.test(label) || /(?:^|\s|\()required\)?$/i.test(label) && !/not required\)?$/i.test(label)) return true;
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
    for (let group=composedParent(input); group && group!==region && group!==region.host && !group.matches('form,body,html'); group=composedParent(group)) {
      if (deepQuery(group,'input:not([type=hidden],[type=button]),textarea,select').some(node=>node!==input)) break;
      owner=group;
      if (!shown(group)) continue;
      required ||= group.getAttribute('aria-required')==='true' || group.getAttribute('data-required')==='true';
      const heading=(group.innerText ?? '').trim().split('\n')[0];
      if (!label && otherAttachment(heading)) label=heading;
    }
    const boundLabels=[...input.labels ?? []].filter(node=>node.control===input && shown(node));
    required ||= boundLabels.some(requiredLabel) || markedRequired(input,(element,selector)=>{
      const field=composedClosest(element,selector);
      return field && owner.contains(field) ? field : null;
    },deepQuery);
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
    const target=nativeShown?input:boundLabels[0]??owner;
    if (input.validity.customError || input.getAttribute('aria-invalid')==='true' ||
        owner.matches(pending) && shown(owner) || deepQuery(owner,pending).some(shown)) {
      return {label,target,reason:'required_attachment_unconfirmed'};
    }
    const completed='[data-upload-state=success]';
    const retainedId=node=>names.has(compact(node.name)) && !/^(?:|0+|-1|null|undefined|none|false)$/i.test(node.value.trim());
    if (input.files?.length || deepQuery(owner,'input[type=hidden][name]').some(retainedId) ||
        owner.matches(completed) && shown(owner) || deepQuery(owner,completed).some(shown)) return;
    const emptyNotice=deepQuery(owner,'span,p,[role=status]').some(node=>shown(node) && /^no files? selected$/i.test(node.innerText.trim()));
    return {label,target,reason:nativeShown || emptyNotice ? 'required_attachment_missing' : 'required_attachment_unconfirmed'};
  };
  // The reviewer also sees controls the filler intentionally excludes, including
  // account fields. Only a label, a reason and an opaque element id leave the frame.
  function requiredIssues(root,{visible,labelFor,externalAttachment,selectedChoice,inScope}) {
    const ids=state.requiredIssueIds ??= new WeakMap();
    const targets=new Map(), issues=[];
    const controls=deepQuery(root,'input,select,textarea,button[aria-haspopup=listbox],[role=combobox],[role=listbox],[role=radiogroup],[role=checkbox],[role=switch],[role=textbox],[contenteditable=true]');
    const shown=e=>visible(e) && !composedClosest(e,'[hidden],[aria-hidden=true],[inert]') && e.checkVisibility({opacityProperty:true,visibilityProperty:true});
    const placeholder=text=>{
      const prompt=text.trim().replace(/^[-–—]+|[-–—]+$/g,'').trim();
      return !prompt || /^(?:make a selection|(?:please\s+)?(?:select|choose)(?:\s+(?:(?:a|an|your|one)\s+)?(?:country|state|province|state\/province|region|option|answer|item|one))?|select\.\.\.)$/i.test(prompt);
    };
    const issueFor=e=>{
      if (!e.isConnected || !inScope(e) || e.matches(':disabled') || e.readOnly || composedClosest(e,'[inert],[aria-disabled=true]') ||
          ['hidden','submit','reset','button','image'].includes(e.type) && !e.matches('[role=checkbox],[role=switch],[role=combobox],[aria-haspopup=listbox]')) return;
      const attachment=e.type==='file' && unresolvedAttachment(e);
      const target=shown(e)?e:e.type==='file' && [attachment?.target,...e.labels??[],fileBinding(e)?.widget].find(node=>node && shown(node));
      if (!target || (!attachment && !isRequired(e))) return;
      let label=attachment?.label || labelFor(e) || 'Required field';
      if(e.type==='password') label=/re[- ]?enter|confirm|repeat/i.test(label)?'Password (Re-enter)':'Password';
      const role=e.getAttribute('role');
      let reason;
      const componentState=readRequiredControl(e,shown);
      if(componentState==='complete')return;
      if(componentState)reason=componentState;
      else if(attachment) reason=attachment.reason==='required_attachment_missing'?'required_empty':'required_unconfirmed';
      else if(e.type==='file' && (otherAttachment(label) || externalAttachment(e))) return;
      else if(e.type==='radio'){
        const group=composedClosest(e,'[role=radiogroup],fieldset');
        if(group?.matches('[role=radiogroup][aria-required=true]'))return;
        const radios=e.name?controls.filter(other=>other.type==='radio' && other.name===e.name && other.form===e.form && other.getRootNode()===e.getRootNode()):[e];
        if(radios.some(radioSelected) || radios.find(other=>shown(other) && !other.matches(':disabled') && isRequired(other))!==e)return;
        label=group?.querySelector('legend')?.textContent || group?.getAttribute('aria-label') || label;
        reason='required_empty';
      } else if(e.validity?.valueMissing) reason='required_empty';
      else if(e.getAttribute('aria-invalid')==='true' || e.willValidate && !e.validity.valid) reason='required_invalid';
      else if(e.tagName==='SELECT'){
        if(![...e.selectedOptions].some(o=>o.value.trim() && !placeholder(o.textContent)))reason='required_empty';
      } else if(e.type==='file'){if(!e.files?.length)reason='required_empty';}
      else if(e.type==='password'){
        // Native validity above reports emptiness without reading the secret.
        if(!e.required)reason=e.matches(':placeholder-shown')?'required_empty':'required_unconfirmed';
      }
      else if(e.type==='checkbox' || role==='checkbox' || role==='switch'){if(!(e.checked || e.getAttribute('aria-checked')==='true'))reason='required_empty';}
      else if(role==='radiogroup'){
        label=e.getAttribute('aria-label') || e.querySelector('legend')?.textContent?.trim() || label;
        if(![...e.querySelectorAll('input[type=radio]')].some(radioSelected) && !e.querySelector('[role=radio][aria-checked=true]'))reason='required_empty';
      }
      else if(role==='listbox' || role==='combobox' || e.matches('[aria-haspopup=listbox]')){
        if(!selectedChoice(e,label) && !e.querySelector('[role=option][aria-selected=true]'))reason='required_unconfirmed';
      } else if(!String(e.value??e.textContent??'').trim())reason='required_empty';
      if(reason){
        label=String(label).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s*[✱*]\s*$/,'').trim();
        if(/https?:|www\.|\S+@\S+|[a-z\d_-]{32,}|[?&](?:code|token|key)=/i.test(label))label='Required field';
        label=label.slice(0,140)||'Required field';
        const legend=composedClosest(e,'fieldset')?.querySelector(':scope > legend');
        let section;
        if(legend && shown(legend) && !legend.querySelector('input,select,textarea,button,a,iframe,[tabindex],[role],[contenteditable]')){
          const text=legend.textContent.trim();
          if(text && text.length<=70 && text.toLowerCase()!==label.toLowerCase() &&
              !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]|https?:|www\.|\S+@\S+|[a-z\d_-]{32,}|[?&](?:code|token|key)=/i.test(text))section=text;
        }
        return {target,reason,label,section};
      }
    };
    // Carry an issue's handle through an inspection when the form replaced its
    // input but retained a unique ID or the actual label that owned it.
    for(const binding of state.requiredIssueBindings ?? []){
      if(binding.control.isConnected)continue;
      const replacement=binding.replacement();
      if(replacement && !ids.has(replacement))ids.set(replacement,ids.get(binding.control));
    }
    const bindings=[];
    for(const control of controls){
      const issue=issueFor(control);
      if(!issue)continue;
      if(ids.get(control)?.label!==issue.label || ids.get(control)?.section!==issue.section)ids.set(control,{label:issue.label,section:issue.section,id:crypto.randomUUID()});
      const fieldId=ids.get(control).id;
      issues.push({fieldId,label:issue.label,reason:issue.reason,...(issue.section && {section:issue.section})});
      const form=control.form, tree=control.getRootNode(), id=control.id;
      const selector=id && form && issue.target===control ? '#'+CSS.escape(id) : null;
      const unique=selector && tree.querySelectorAll(selector).length===1;
      const label=control.labels?.length===1 ? control.labels[0] : null;
      const replacement=()=>{
        if(!form?.isConnected)return null;
        let field;
        if(id){
          if(!unique)return null;
          const matches=tree.querySelectorAll(selector);
          if(matches.length===1)field=matches[0];
        }else if(label?.isConnected && label.getRootNode()===tree && label.querySelectorAll('input,select,textarea,button').length===1){
          field=label.control;
        }
        return field && field.form===form && field.tagName===control.tagName &&
          field.type===control.type && field.name===control.name ? field : null;
      };
      bindings.push({control,replacement});
      targets.set(fieldId,()=>{
        // A label-only remount gets a fresh inspection before it can be shown.
        const field=control.isConnected ? control : unique && replacement();
        if(!field)return null;
        const now=issueFor(field);
        return now && now.target===(field===control?issue.target:field) &&
          now.label===issue.label && now.section===issue.section ? now.target : null;
      });
    }
    state.requiredIssueBindings=bindings;
    state.requiredIssueTargets=targets;
    return issues;
  }
  return { isRequired, unresolvedAttachment, requiredIssues };
}
