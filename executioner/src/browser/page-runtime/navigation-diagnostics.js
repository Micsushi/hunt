export function readNavigationDiagnostics({deepQuery, composedClosest, composedParent, visible, norm}) {
  // Diagnostic only: reading validity does not dispatch invalid events or
  // override committed attachment/choice evidence and matching decisions.
  const nativeControls=deepQuery(document,'input,textarea,select,button').filter(e=>e.validity);
  const validityFlags=['valueMissing','typeMismatch','patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError'];
  const summarizeValidity=controls=>({controlCount:controls.length,validationCandidateCount:controls.filter(e=>e.willValidate).length,
    invalidCount:controls.filter(e=>!e.validity.valid).length,blockingInvalidCount:controls.filter(e=>e.willValidate && !e.validity.valid).length,
    hiddenBlockingInvalidCount:controls.filter(e=>e.willValidate && !e.validity.valid && !visible(e)).length});
  const nextCandidates=deepQuery(document,'button,input[type=submit],input[type=button],[role=button]').filter(e=>visible(e) &&
    /^(?:next|continue|save\s+(?:and|&)\s+continue)$/i.test(String(e.getAttribute('aria-label') || (e.tagName==='INPUT'?e.value:e.innerText??e.textContent) || '').trim()));
  const invalidControls=nativeControls.filter(e=>!e.validity.valid);
  const noticeVisible=e=>{
    if(!visible(e) || composedClosest(e,'[hidden],[aria-hidden="true"]'))return false;
    for(let owner=e;owner;owner=composedParent(owner))if(getComputedStyle(owner).opacity==='0')return false;
    return true;
  };
  const noticeNodes=deepQuery(document,'[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"],[role="alertdialog"],[role="dialog"],dialog[open],[class*="error-summary" i],[id*="error-summary" i],[class*="errorsummary" i],[id*="errorsummary" i],[data-automation-id="inputAlert"],[data-automation-id*="error" i]')
    .filter(e=>e!==document.body && e!==document.documentElement && noticeVisible(e));
  const notices=[],seenNotices=new Set();let noticeCharacters=0,omittedNoticeCount=0;
  for(const node of noticeNodes) {
    if(notices.length>=20 || noticeCharacters>=6000){omittedNoticeCount++;continue;}
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text='',part,visited=0,truncated=false;
    while((part=walker.nextNode())) {
      if(++visited>2000){truncated=true;break;}
      const owner=part.parentElement;
      if(!owner || composedClosest(owner,'input,textarea,select,script,style,noscript,template,[contenteditable]:not([contenteditable="false"])') || !noticeVisible(owner))continue;
      text+=' '+part.textContent.slice(0,2401-text.length);
      if(text.length>2400){truncated=true;break;}
    }
    text=text.replace(/\b(?:https?:\/\/|www\.)\S+/gi,'[link]').replace(/\s+/g,' ').trim();
    const limit=Math.min(1200,6000-noticeCharacters);truncated ||= text.length>limit;text=text.slice(0,limit);
    const role=node.getAttribute('role'),live=node.getAttribute('aria-live');
    const notice={role:['alert','status','alertdialog','dialog'].includes(role)?role:node.tagName==='DIALOG'?'dialog':null,live:['polite','assertive','off'].includes(live)?live:null,
      visible:true,busy:node.getAttribute('aria-busy')==='true',disabled:node.matches(':disabled') || node.getAttribute('aria-disabled')==='true',
      visibleDisabledControlCount:deepQuery(node,'button,input,select,textarea,[role="button"]').filter(e=>noticeVisible(e) && (e.matches(':disabled') || e.getAttribute('aria-disabled')==='true')).length,
      text,truncated};
    const key=JSON.stringify(notice);if(seenNotices.has(key))continue;seenNotices.add(key);
    notices.push(notice);noticeCharacters+=text.length;
  }
  return {nativeValidation:{scope:'document',...summarizeValidity(nativeControls),
    invalidControls:invalidControls.slice(0,100).map(e=>({type:e.type || e.tagName.toLowerCase(),visible:visible(e),required:!!e.required,
      willValidate:!!e.willValidate,hasForm:!!e.form,associatedWithNextForm:!!e.form && nextCandidates.some(next=>next.form===e.form),
      flags:validityFlags.filter(flag=>e.validity[flag])})),omittedInvalidControlCount:Math.max(0,invalidControls.length-100)},
    notices:{scope:'document_visible_notice_containers',items:notices,omittedNoticeCount},
    nextCandidates:nextCandidates.map(e=>({type:e.type || null,nativeButton:e.tagName==='BUTTON' || e.tagName==='INPUT',
      disabled:e.matches(':disabled') || e.getAttribute('aria-disabled')==='true',hasForm:!!e.form,
      formNoValidate:e.form?!!e.form.noValidate:null,formNoValidateOverride:!!e.formNoValidate,
      ...(e.form?{nativeValidation:summarizeValidity(nativeControls.filter(control=>control.form===e.form))}:{})}))};
}
