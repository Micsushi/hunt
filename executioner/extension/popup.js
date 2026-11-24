import { supportsCurrentPage } from './website-handoff.js';

await initializePopup();

async function initializePopup() {
  const $=id=>document.getElementById(id),origin='http://127.0.0.1:47831';
  const toolbar=chrome.extension.getViews({type:'popup'}).includes(window);
  if(!toolbar)document.documentElement.classList.add('tab-view');
  const compact=toolbar && screen.availHeight<590;
  if(compact)document.body.dataset.compact='';
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const saved=await chrome.storage.local.get('token');
  const choiceKey='pageResume:'+tab?.id;
  let preference=(await chrome.storage.session.get(choiceKey))[choiceKey];
  let busy=false, serviceReady=false, browserReady=false;
  const canPartial=supportsCurrentPage(tab?.url,origin);
  $('actions').hidden=!canPartial;
  const pageHash=canPartial ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(tab.url))),byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,24) : '';
  const reviewKey='fillReview:'+tab?.id;
  let savedReview=(await chrome.storage.session.get(reviewKey))[reviewKey];
  let selection=null, alternatives=null, currentPageJobId, selectedResumeSha256;
  function resumeOptions(next){
    const seen=new Set(), list=[];
    const add=item=>{
      if(!item?.sha256||seen.has(item.sha256))return;
      seen.add(item.sha256);
      list.push(item);
    };
    if(next?.currentPage)add(next.currentPage);
    if(next?.queued)add(next.queued);
    if(Array.isArray(next?.resumes))for(const item of next.resumes)add(item);
    return list;
  }
  const picker=$('resume-picker'), resumeButton=$('resume-select'), resumeSearch=$('resume-search'), resumeSort=$('resume-sort');
  const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
  const resumeLabel=item=>item.version ? item.name+' · '+item.version : item.name;
  function displayFilename(container,item){
    const filename=document.createElement('span');
    filename.className='resume-filename';
    filename.textContent=container.id==='resume-name' ? item.name.replace(/^Default resume · [a-f0-9]{8}$/i,'Default resume') : item.name;
    container.replaceChildren(filename);
    if(item.version){
      const version=document.createElement('span');
      version.className='resume-version';
      version.textContent=' · '+item.version;
      container.append(version);
    }
  }
  let pickerSignature;
  function renderPicker(){
    if(picker.hidden)return;
    const query=resumeSearch.value.trim().toLocaleLowerCase();
    const rows=resumeOptions(alternatives).filter(item=>resumeLabel(item).toLocaleLowerCase().includes(query));
    rows.sort((a,b)=>{
      const versionOrder=collator.compare(String(a.version||'').replace(/^v(?=\d)/i,''),String(b.version||'').replace(/^v(?=\d)/i,''));
      if(resumeSort.value!=='name' && versionOrder)return resumeSort.value==='version' ? -versionOrder : versionOrder;
      return collator.compare(a.name,b.name)||versionOrder;
    });
    const signature=JSON.stringify([resumeButton.value,rows.map(item=>[item.sha256,resumeLabel(item)])]);
    if(signature===pickerSignature)return;
    pickerSignature=signature;
    $('no-resumes').hidden=rows.length!==0;
    $('resume-list').replaceChildren(...rows.map(item=>{
      const row=document.createElement('li'), choose=document.createElement('button'), preview=document.createElement('a');
      const label=resumeLabel(item);
      choose.className='secondary';
      choose.value=item.sha256;
      choose.title=label;
      displayFilename(choose,item);
      choose.setAttribute('aria-pressed',String(item.sha256===resumeButton.value));
      choose.onclick=()=>chooseResume(item.sha256);
      preview.textContent='Open PDF';
      preview.setAttribute('aria-label','Open PDF: '+label);
      preview.href='resume-preview.html?pdf='+item.sha256;
      preview.target='_blank';
      preview.rel='noopener';
      row.append(choose,preview);
      return row;
    }));
  }
  function togglePicker(open){
    picker.hidden=!open;
    resumeButton.setAttribute('aria-expanded',String(open));
    if(open){
      resumeSearch.value='';
      renderPicker();
      resumeSearch.focus();
    }
  }
  resumeButton.onclick=()=>togglePicker(picker.hidden);
  resumeSearch.oninput=resumeSort.onchange=renderPicker;
  $('resumes').onkeydown=event=>{
    if(event.key==='Escape' && !picker.hidden){
      event.preventDefault();
      togglePicker(false);
      resumeButton.focus();
    }else if(!picker.hidden && (event.key==='ArrowDown'||event.key==='ArrowUp') && event.target!==resumeSort){
      const buttons=[...$('resume-list').querySelectorAll('button')];
      const index=buttons.indexOf(event.target.closest('li')?.querySelector('button'));
      const next=index+(event.key==='ArrowDown'?1:-1);
      if(buttons[next]){
        event.preventDefault();
        buttons[next].focus();
      }
    }
  };
  function renderSelection(next, error=''){
    alternatives=next;
    const options=resumeOptions(next);
    const queued=next?.queued;
    const prefMatch=preference?.url===tab?.url
      ? options.find(item=>item.sha256===preference.sha256 && (!preference.jobId || item.jobId===preference.jobId || item.sha256===queued?.sha256))
      : null;
    const activeResume=prefMatch||next?.currentPage||options[0]||null;
    const matchesQueued=Boolean(prefMatch && queued?.source==='selected' && queued.jobId && activeResume?.sha256===queued.sha256 && queued.sha256!==next?.currentPage?.sha256);
    currentPageJobId=matchesQueued?queued.jobId:undefined;
    selectedResumeSha256=prefMatch && !matchesQueued && activeResume?.sha256!==next?.currentPage?.sha256 ? activeResume.sha256 : undefined;
    selection=next?(activeResume?{...next,currentPage:activeResume}:next):null;
    $('prepare-action').hidden=!next?.supportsQueue;
    $('support').textContent=error || next?.queuedError || (!canPartial?'Switch to a website, then reopen Hunt.':'');
    resumeButton.value=activeResume?.sha256||'';
    const title=activeResume?resumeLabel(activeResume):'';
    if(resumeButton.title!==title){
      resumeButton.title=title;
      if(activeResume)displayFilename($('resume-name'),activeResume);
      else $('resume-name').replaceChildren();
    }
    if(activeResume)renderPicker();
    else togglePicker(false);
    $('resumes').hidden=!options.length;
  }
  renderSelection(null);
  let canUndo=false,canRedo=false,profileCountryConflict=false;
  const countryAction=$('use-profile-country');
  const countryMismatch='Country is set to United States. Your profile uses Canada.';
  function controls(){
    $('fill').disabled=busy||!selection?.supportsQueue||!selection.queued||!!selection.queuedError||!serviceReady||!browserReady;
    $('partial').disabled=busy||!canPartial||!selection||!serviceReady||!browserReady;
    $('undo').disabled=busy||!canUndo;$('redo').disabled=busy||!canRedo;
    $('history').hidden=!canUndo&&!canRedo;
    countryAction.disabled=busy||!profileCountryConflict||!serviceReady||!browserReady;
    resumeButton.disabled=busy||!selection?.currentPage;
    if(busy)togglePicker(false);
    $('connect-local').disabled=busy;$('batch').disabled=busy;
    $('more-actions').hidden=!selection?.supportsQueue && !canUndo && !canRedo;
    if($('more-actions').hidden)setMore(false);
  }
  function setMore(open){
    $('other-actions').hidden=!open;
    $('more-actions').setAttribute('aria-expanded',String(open));
  }
  $('more-actions').onclick=()=>setMore($('other-actions').hidden);
  function setStatus({summary='',errors=[]}={}){
    $('status').textContent=errors.length ? errors.join(' ') : summary;
    $('status').dataset.error=String(errors.length>0);
  }
  let issues=[],issueIndex=0,issuesDocumentId;
  function showReview(open,focus=false){
    const reviewing=open && issues.length>0;
    $('issue-view').hidden=!reviewing;
    document.querySelector('main').hidden=reviewing;
    $('back-to-fill').hidden=!reviewing;
    $('resume-label').hidden=reviewing;
    $('return-issues').hidden=!issues.length;
    $('return-issues').textContent='Review '+issues.length+' '+(issues.length===1?'issue':'issues');
    if(reviewing){
      const issue=issues[issueIndex];
      const position='Issue '+(issueIndex+1)+' of '+issues.length;
      $('issue-position').textContent=issue.target?.section ? position+' · '+issue.target.section : position;
      $('issue-label').textContent=issue.label;
      $('issue-message').textContent=issue.target ? issue.message+' Reopen Hunt after editing to recheck.' : issue.message;
      $('show-field').hidden=!issue.target;
      countryAction.hidden=!issue.country || !profileCountryConflict;
      $('issue-navigation').hidden=issues.length<2;
      $('previous-message').disabled=issueIndex===0;
      $('next-message').disabled=issueIndex===issues.length-1;
      if(focus)$('issue-label').focus();
    }else{
      countryAction.hidden=true;
      if(focus)$('partial').focus();
    }
  }
  function rememberReview(){
    savedReview={page:pageHash,documentId:issuesDocumentId,index:issueIndex};
    return chrome.storage.session.set({[reviewKey]:savedReview});
  }
  function stepIssue(direction){
    issueIndex=Math.max(0,Math.min(issues.length-1,issueIndex+direction));
    setStatus();showReview(true,true);void rememberReview();
  }
  $('previous-message').onclick=()=>stepIssue(-1);
  $('next-message').onclick=()=>stepIssue(1);
  $('back-to-fill').onclick=()=>{setStatus();showReview(false,true);};
  $('return-issues').onclick=()=>showReview(true,true);
  $('show-field').onclick=async()=>{
    const issue=issues[issueIndex];
    if(!issue?.target || busy)return;
    const button=$('show-field');
    button.disabled=true;
    try{
      const reply=await browserReply(chrome.runtime.sendMessage({action:'revealIssue',tabId:tab.id,expectedUrl:tab.url,documentId:issuesDocumentId,
        frameId:issue.target.frameId,fieldId:issue.target.fieldId}));
      if(!reply?.ok)throw new Error();
      if(toolbar)window.close();
    }catch{
      try{
        const inspected=await inspectPage();
        applyPageState(inspected);
        if(inspected.documentId===issuesDocumentId)presentResult(inspected,issueIndex);
        else{issues=[];showReview(false);}
      }catch{issues=[];showReview(false);}
      setStatus({errors:['That field could not be located. Check the current form.']});
    }finally{button.disabled=false;}
  };
  async function checkConnection(){
    serviceReady=false;browserReady=false;
    try{
      const {token}=await chrome.storage.local.get('token');
      if(!token){$('connection').textContent='Not connected';return;}
      const response=await fetch(origin+'/state',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(4000)});
      if(!response.ok){$('connection').textContent=response.status===401?'Pairing key rejected':'C3 service unavailable';return;}
      const state=await response.json();serviceReady=Boolean(state.configured);
      const local=await browserReply(chrome.runtime.sendMessage({action:'connectionStatus'}));
      browserReady=Boolean(local?.connected);
      $('connection').textContent=!browserReady?(state.connected?'Another browser is connected':'Browser connection pending'):!serviceReady?'Connected · Save profile in full menu':'Connected';
      if(serviceReady && browserReady && canPartial){
        try{
          const metadata=await fetch(origin+'/browser/page-resume',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
            body:JSON.stringify({tabId:tab.id,expectedUrl:tab.url}),signal:AbortSignal.timeout(4000),redirect:'error'});
          if(!metadata.ok)throw new Error((await metadata.json()).error||'Open the full menu to check the selected resume.');
          const next=await metadata.json();
          const formerChoice=currentPageJobId||selectedResumeSha256;
          renderSelection(next);
          if(preference?.url===tab.url && !currentPageJobId && !selectedResumeSha256 && preference.sha256!==next?.currentPage?.sha256){
            preference=null;
            await chrome.storage.session.remove(choiceKey);
            setStatus({errors:['The selected resume changed. Check the resume before filling.']});
            if(formerChoice)await refreshHistory();
          }
        }catch(error){renderSelection(null,error.message||'Could not check the selected resume.');}
      }
    }catch{$('connection').textContent='Start the local C3 app to connect';}
    finally{
      if(!browserReady || !serviceReady)renderSelection(null);
      $('connection').dataset.ready=String(serviceReady&&browserReady);
      $('connection-actions').hidden=browserReady;
      controls();
    }
  }
  async function run(action,control,message){
    if(busy)return;
    const focused=document.activeElement;
    busy=true;controls();setStatus({summary:message||''});
    const label=control?.textContent;if(control){control.textContent=message;control.setAttribute('aria-busy','true');}
    try{await action();}catch(e){setStatus({errors:[e.name==='TimeoutError'?'Request timed out. Check that C3 is running, then retry.':e.message]});}
    finally{
      busy=false;if(control){control.textContent=label;control.removeAttribute('aria-busy');}controls();
      // Disabling or moving the clicked control can drop keyboard focus.
      // Restore it only if the user has not focused something else while waiting.
      if(document.activeElement===document.body&&(focused instanceof HTMLButtonElement||focused instanceof HTMLSelectElement)){
        const fallback=$('issue-view').hidden?$('partial'):$('issue-label');
        (focused.checkVisibility()&&!focused.disabled?focused:fallback.disabled?$('batch'):fallback).focus();
      }
    }
  }
  let historyVersion=0;
  async function browserReply(promise,message='The browser did not respond. Reopen C3 to retry.'){
    let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),15000);})]);}
    finally{clearTimeout(timer);}
  }
  let pageDocumentId, inspection;
  function inspectPage(){
    if(!inspection)inspection=pageReply('inspect').finally(()=>{inspection=null;});
    return inspection;
  }
  async function pageReply(operation, expectedResumeSha256){
    const reply=await browserReply(chrome.runtime.sendMessage({action:'pageAction',operation,tabId:tab.id,expectedUrl:tab.url,documentId:pageDocumentId,
      ...(currentPageJobId&&{currentPageJobId}),...(operation!=='use_profile_country'&&selectedResumeSha256&&{resumeSha256:selectedResumeSha256}),...(expectedResumeSha256&&{expectedResumeSha256}),expiresAt:Date.now()+12000}));
    if(!reply?.ok)throw new Error(reply?.error||'The page action was not confirmed. Inspect the draft before retrying.');
    pageDocumentId=reply.result.documentId;
    return reply.result;
  }
  function collectAttachments(result, warnings, errors){
    const rows=result.skipped??[], reasons=new Set(rows.map(row=>row.reason));
    if(['undo','redo'].includes(result.operation) && (reasons.has('remote_upload_preserved')||reasons.has('client_attachment_preserved')))warnings.push('The attachment stayed on the employer page.');
    if(reasons.has('different_resume_requires_manual_review'))errors.push('Your selected PDF differs from the earlier resume selection on this page. Check which resume the employer has.');
    else if(reasons.has('resume_filename_differs'))errors.push('The employer shows a different resume filename. Check it against your selected PDF.');
    else if(result.resumeEvidence==='filename'||reasons.has('resume_filename_visible_contents_unverified'))warnings.push('The employer shows the matching resume filename. PDF contents unverified.');
    else if(result.resumeEvidence==='earlier_filename')warnings.push('The previous step showed the matching resume filename. PDF contents unverified.');
    else if(reasons.has('resume_filename_visible'))warnings.push('The employer shows a resume filename. Check it against your selected PDF. Contents unverified.');
    else if(reasons.has('resume_picker_occupied'))warnings.push('The local resume picker contains a file. Check it against your selected PDF. Employer contents unverified.');
    else if(['existing_attachment_preserved','existing_remote_attachment_requires_review','existing_smartrecruiters_attachment_requires_review','remote_upload_preserved','client_attachment_preserved'].some(reason=>reasons.has(reason)))warnings.push('A resume is already present. Check it against your selected PDF.');
    else if(reasons.has('required_resume_missing') || result.operation==='inspect' && result.resume==='missing')errors.push('The required resume field is empty.');
    else if(reasons.has('resume_control_not_identified'))errors.push('C3 could not identify the resume field. Check the employer page.');
    else if(['resume_attachment_not_verified','resume_upload_already_attempted_review_attachment','uploaded_attachment_requires_review','attachment_not_verified_native_file_retained','ambiguous_resume_attachment','resume_parsing_pending_profile_not_filled'].some(reason=>reasons.has(reason)))errors.push('The resume attachment was not confirmed. Check it on the employer page.');
    for(const row of rows){
      if(!['required_attachment_missing','required_attachment_unconfirmed'].includes(row.reason))continue;
      const name=/transcript|relev[ée] de notes/i.test(row.label)?'transcript':/cover[ -]?letter|lettre de/i.test(row.label)?'cover letter':'document';
      errors.push(row.reason==='required_attachment_missing'?`The required ${name} is missing.`:`Check the required ${name}. Its upload is unconfirmed.`);
    }
  }
  async function partial(action){
    historyVersion++;
    const digest=action==='fill'?selection?.currentPage?.sha256:undefined;
    if(!pageDocumentId)await inspectPage();
    let result;
    try{
      result=await pageReply(action,digest);
    }catch(error){
      const uncertain=/timed?\s*out|expir(?:ed|y)|not confirmed|did not respond/i.test(error.message);
      if(!uncertain && action!=='use_profile_country')throw error;
      // A timed-out write can still have created undo history. Inspect it without repeating the write.
      try{
        const inspected=await inspectPage();
        applyPageState(inspected);
      }catch{profileCountryConflict=false;}
      if(!uncertain)throw error;
      throw new Error(canUndo?'C3 could not confirm all changes. Check the page or use Undo fill.':'C3 could not confirm all changes. Check the page and reopen Hunt for Undo.');
    }
    applyPageState(result);
    if(result.accountPage){issues=[];showReview(false);setStatus({summary:'Account fields filled.'});return;}
    issuesDocumentId=result.documentId;
    presentResult(result);
    await rememberReview();
  }
  function presentResult(result,index=0){
    const warnings=[],errors=[],fieldIssues=[];
    const required=(result.requiredIssues??[]).map(target=>({
      label:target.label,
      message:target.reason==='required_empty'?'This required field is empty.':
        target.reason==='required_invalid'?'The current value needs a correction.':'C3 could not verify this required field.',
      target,
    }));
    const conflictItems=(result.skipped||[]).filter(item=>['saved_value_conflict','value_changed_after_fill'].includes(item.reason)
      && !(profileCountryConflict && item.reason==='saved_value_conflict' && /^country\b/i.test(item.label?.trim())));
    for(const label of new Set(conflictItems.map(item=>String(item.label||'Field').replace(/[\u2009*✱]/g,'').trim()))){
      fieldIssues.push({label,message:'The form value differs from your saved answer or changed after filling.'});
    }
    collectAttachments(result, warnings, errors);
    const addressReason=result.skipped?.find(item=>['bamboo_address_change_unconfirmed','bamboo_address_restore_unconfirmed'].includes(item.reason))?.reason;
    if(addressReason)errors.push(addressReason==='bamboo_address_restore_unconfirmed'
      ? 'C3 could not verify the restored address. Check Country, region and postal code on the form.'
      : 'BambooHR did not confirm the address update. Check the address and your saved profile.');
    for(const label of new Set(result.reviewFields??[])){
      if(label && !required.some(issue=>issue.label===label) && !fieldIssues.some(issue=>issue.label===label))
        fieldIssues.push({label,message:'Check the suggested answer on the form.'});
    }
    if (result.componentFailure && !addressReason) {
      const {component, operation} = result.componentFailure;
      errors.push('Check ' + component.replaceAll('_', ' ') + ' (' + operation.replaceAll('_', ' ') + ').');
    }
    const submissionDisabled=Boolean(result.skipped?.some(item=>item.reason==='employer_submission_disabled'));
    if(submissionDisabled)errors.push('The employer still has submission disabled.');
    if (result.frames?.some(frame => frame.status === 'unavailable')) {
      errors.push('C3 could not inspect an embedded section. Check it on the form.');
    } else if (result.incomplete && !result.componentFailure && !submissionDisabled && !addressReason && !required.length && !fieldIssues.length && !warnings.length && !errors.length && !profileCountryConflict) {
      errors.push('Check the incomplete fields before retrying.');
    }
    if(result.needsOwnerReview && !fieldIssues.length && !required.length && !errors.length && !warnings.length && !profileCountryConflict)
      warnings.push('Some answers need review. Check the page before continuing.');
    const normalize=str=>str.toLowerCase().replace(/[^a-z0-9]/g,'');
    const duplicatesRequired=message=>required.some(issue=>{
      const label=normalize(issue.label);
      return label && (message==='The required resume field is empty.' && /resume|cv/.test(label) ||
        /^The required .+ is missing\.$/.test(message) && normalize(message.slice(13,-12))===label);
    });
    const secondary=[...new Set([...errors,...warnings])].filter(text=>!duplicatesRequired(text));
    issues=[...required,...fieldIssues,...(profileCountryConflict?[{label:'Country',message:countryMismatch,country:true}]:[]),
      ...secondary.map(message=>({label:message.includes('resume')||message.includes('PDF')?'Review attachment':'Check the form',message}))];
    issueIndex=Math.max(0,Math.min(Number.isInteger(index)?index:0,issues.length-1));
    setMore(false);
    showReview(issues.length>0);
    const count=result.filled?.length??0;
    const summary=result.operation==='inspect'?'':result.operation==='undo'?count+' field changes undone.':
      result.operation==='redo'?count+' field changes restored.':count+' '+(count===1?'field changed.':'fields changed.');
    const note=result.resumeEvidence==='picker'?'The local file picker matches the selected PDF. Employer contents unverified.':'';
    setStatus({summary:issues.length?'':[summary,note].filter(Boolean).join(' ')});
  }
  $('partial').onclick=()=>run(()=>partial('fill'),$('partial'),'Filling page…');
  countryAction.onclick=()=>run(()=>partial('use_profile_country'),countryAction,'Updating address…');
  $('undo').onclick=()=>run(()=>partial('undo'));
  $('redo').onclick=()=>run(()=>partial('redo'));
  function applyPageState(result){
    canUndo=result.canUndo;canRedo=result.canRedo;profileCountryConflict=result.profileCountryConflict===true;
  }
  async function loadHistory(){const version=historyVersion;try{const result=await inspectPage();if(version!==historyVersion)return;applyPageState(result);
    if(!busy && savedReview?.page===pageHash && savedReview.documentId===result.documentId){
      issuesDocumentId=result.documentId;
      presentResult(result,savedReview.index);
    }
    controls();}catch{
      if(!busy && savedReview?.page===pageHash)setStatus({errors:['C3 could not check this page for remaining issues.']});
    }}
  async function refreshHistory(){
    historyVersion++;canUndo=false;canRedo=false;profileCountryConflict=false;controls();
    if(inspection)await inspection.catch(()=>{});
    pageDocumentId=undefined;
    await loadHistory();
  }
  async function chooseResume(chosenSha){
    togglePicker(false);
    resumeButton.focus();
    if(chosenSha===resumeButton.value)return;
    await run(async()=>{
      const isDefault=chosenSha===alternatives?.currentPage?.sha256;
      const queued=alternatives?.queued;
      const matchedJobId=queued?.source==='selected' && queued.sha256===chosenSha ? queued.jobId : undefined;
      const next=!isDefault && chosenSha ? {sha256:chosenSha,...(matchedJobId&&{jobId:matchedJobId}),url:tab.url} : null;
      if(next)await chrome.storage.session.set({[choiceKey]:next});
      else await chrome.storage.session.remove(choiceKey);
      preference=next;
      renderSelection(alternatives);
      await refreshHistory();
    });
    if(document.activeElement===document.body)resumeButton.focus();
  }
  async function connectWithToken(token){
    if(!token)throw new Error('Open the full menu in this browser, then connect again.');
    let response;
    try{response=await fetch(origin+'/state',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(4000)});}
    catch{throw new Error('Start the local C3 app, then retry. Your saved connection was kept.');}
    if(!response.ok)throw new Error(response.status===401?'Pairing key rejected. Your saved connection was kept.':'C3 service unavailable. Your saved connection was kept.');
    const state=await response.json();
    if(typeof state?.connected!=='boolean'||typeof state?.configured!=='boolean')throw new Error('C3 did not confirm the connection. Your saved connection was kept.');
    await chrome.storage.local.set({token});
    const result=await browserReply(chrome.runtime.sendMessage({action:'connect'}));
    if(!result?.ok)throw new Error(result?.error||'Connection request failed. Reopen C3 to retry.');
    await checkConnection();setStatus({summary:browserReady?'Connection saved.':'Connection saved. Waiting for the browser.'});
  }
  async function connectLocal(){
    const tabs=await chrome.tabs.query({url:origin+'/*'});
    const keys=new Set();
    for(const workspace of tabs){
      const url=new URL(workspace.url);
      if(url.origin!==origin||url.pathname!=='/'||url.username||url.password)continue;
      try{
        const results=await chrome.scripting.executeScript({target:{tabId:workspace.id},func:expectedOrigin=>{
          if(location.origin!==expectedOrigin||location.pathname!=='/')return null;
          return new URLSearchParams(location.hash.slice(1)).get('token')??sessionStorage.getItem('c3-token');
        },args:[origin]});
        const key=results[0]?.result;
        if(typeof key==='string'&&/^[a-f0-9]{64}$/.test(key))keys.add(key);
      }catch{/* A closed or navigated workspace is not a pairing source. */}
    }
    if(keys.size>1)throw new Error('Several full menu tabs have different keys. Close the old tabs, then retry. Your saved connection was kept.');
    const token=keys.values().next().value||(await chrome.storage.local.get('token')).token;
    if(!token)throw new Error('Open the full menu in this browser, then connect again.');
    await connectWithToken(token);
  }
  $('connect-local').onclick=()=>run(connectLocal,$('connect-local'),'Connecting…');
  $('batch').onclick=()=>run(async()=>{const {token}=await chrome.storage.local.get('token');await chrome.tabs.create({url:origin+'/#token='+encodeURIComponent(token||'')+(pageHash?'&page='+pageHash:'')});});
  $('fill').onclick=()=>run(async()=>{const digest=selection?.queued?.sha256;const current=await chrome.tabs.get(tab.id);if(current.url!==tab.url)throw new Error('The page changed. Reopen C3 on the application.');const {token}=await chrome.storage.local.get('token');const resultConnect=await browserReply(chrome.runtime.sendMessage({action:'connect'}));if(!resultConnect?.ok)throw new Error(resultConnect?.error||'Connection request failed');if((await chrome.tabs.get(tab.id)).url!==tab.url)throw new Error('The page changed. Reopen C3 on the application.');
    const request={jobs:[{url:tab.url,tabId:tab.id,title:tab.title,...(digest&&{expectedResumeSha256:digest})}]};
    let response,result;try{response=await fetch(origin+'/jobs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(token||'')},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});result=await response.json();}catch{throw new Error('No confirmation received. Check Applications for this job.');}if(!response.ok)throw new Error(typeof result?.error==='string'&&result.error?result.error:'C3 could not confirm this job. Check Applications before retrying.');const job=result?.[0];if(!job||typeof job.status!=='string')throw new Error('No confirmation received. Check Applications before retrying.');setStatus({summary:['queued','running'].includes(job.status)?'Queued. C3 will stop at Review.':`${job.stage||job.status}. Open Applications to continue.`});});

  controls();await checkConnection();
  if(canPartial && selection)void loadHistory();
  if(!saved.token)void run(connectLocal);
  setInterval(()=>{if(!busy)void checkConnection();},5000);
}
