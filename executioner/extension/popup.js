import { summarizeFill, saveFillReview, showPageReview, reconcileFieldReview } from './fill-review-result.js';
import { resolvePageResume } from './current-page-resume.js';
import { supportsCurrentPage } from './website-handoff.js';

async function initializePopup() {
  const $=id=>document.getElementById(id),origin='http://127.0.0.1:47831';
  const toolbar=chrome.extension.getViews({type:'popup'}).includes(window);
  if(!toolbar)document.documentElement.classList.add('tab-view');
  const compact=toolbar && screen.availHeight<590;
  if(compact)document.body.dataset.compact='';
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const canPartial=supportsCurrentPage(tab?.url,origin);
  if(toolbar && canPartial){
    const port=chrome.runtime.connect({name:'current-page-toolbar'});
    port.postMessage({tabId:tab.id,url:tab.url});
    window.addEventListener('pagehide',()=>port.disconnect(),{once:true});
  }
  if(canPartial){
    const heading=$('site-name'), platform=$('site-ats');
    heading.textContent=new URL(tab.url).hostname;
    void popupSiteContext(tab).then(context=>{
      heading.textContent=context?.company || context?.hostname || 'Hunt C3';
      heading.title=context?.hostname || '';
      platform.textContent=context?.ats ? 'ATS · '+context.ats : '';
      platform.hidden=!context?.ats;
    });
  }
  const saved=await chrome.storage.local.get('token');
  const choiceKey='pageResume:'+tab?.id;
  let preference=(await chrome.storage.session.get(choiceKey))[choiceKey];
  let busy=false, workerFilling=false, serviceReady=false, browserReady=false;
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
  const resumeList=$('resume-list'), trashToggle=$('resume-trash-toggle'), pickerStatus=$('resume-picker-status');
  let viewingTrash=false, changingLibrary=false, libraryRevision=0;
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
      version.textContent=container.id==='resume-name' ? ' · '+item.version : 'Version '+item.version;
      container.append(version);
    }
  }
  let pickerSignature;
  function renderPicker(){
    if(picker.hidden)return;
    const trash=alternatives?.trashedResumes || [];
    const archived=new Set(trash.map(item=>item.sha256));
    const query=resumeSearch.value.trim().toLocaleLowerCase();
    const library=viewingTrash ? trash : resumeOptions(alternatives).filter(item=>!archived.has(item.sha256));
    const rows=library.filter(item=>resumeLabel(item).toLocaleLowerCase().includes(query));
    rows.sort((a,b)=>{
      const versionOrder=collator.compare(String(a.version||'').replace(/^v(?=\d)/i,''),String(b.version||'').replace(/^v(?=\d)/i,''));
      if(resumeSort.value!=='name' && versionOrder)return resumeSort.value==='version' ? -versionOrder : versionOrder;
      return collator.compare(a.name,b.name)||versionOrder;
    });
    trashToggle.setAttribute('aria-pressed',String(viewingTrash));
    $('resume-trash-label').textContent=viewingTrash ? 'Back to resumes' : 'Trash ('+trash.length+')';
    const signature=JSON.stringify([viewingTrash,query,resumeButton.value,rows.map(item=>[item.sha256,resumeLabel(item)])]);
    if(signature===pickerSignature)return;
    pickerSignature=signature;
    const focusedRow=document.activeElement?.closest('#resume-list li');
    const focusIndex=Array.from(resumeList.children).indexOf(focusedRow);
    const focusClass=document.activeElement?.dataset.action;
    $('no-resumes').hidden=rows.length!==0;
    $('no-resumes').textContent=query ? 'No matching resumes.' : viewingTrash ? 'Trash is empty.' : 'No resumes in this list.';
    resumeList.setAttribute('aria-label',viewingTrash ? 'Resumes in Trash' : 'Matching resumes');
    resumeList.replaceChildren(...rows.map(item=>{
      const row=document.createElement('li');
      const label=resumeLabel(item);
      const name=document.createElement(viewingTrash?'span':'button');
      name.className=viewingTrash?'trashed-name':'resume-choice';
      name.title=label;
      displayFilename(name,item);
      if(!viewingTrash){
        name.value=item.sha256;
        name.dataset.action='select';
        name.setAttribute('aria-pressed',String(item.sha256===resumeButton.value));
        name.onclick=()=>chooseResume(item.sha256);
      }
      const preview=document.createElement('a');
      preview.className='resume-icon';
      preview.dataset.action='open';
      preview.title='Open PDF';
      preview.setAttribute('aria-label','Open PDF: '+label);
      preview.append($('resume-icon-open').content.cloneNode(true));
      preview.href='resume-preview.html?pdf='+item.sha256;
      preview.target='_blank';
      preview.rel='noopener';
      const action=document.createElement('button');
      action.className='resume-icon';
      action.dataset.action=viewingTrash?'restore':'trash';
      action.title=viewingTrash?'Restore':'Move to Trash';
      action.setAttribute('aria-label',action.title+': '+label);
      action.append($('resume-icon-'+action.dataset.action).content.cloneNode(true));
      action.onclick=()=>changeLibrary(item.sha256,action.dataset.action);
      row.append(name,preview,action);
      return row;
    }));
    if(focusIndex>=0 && document.activeElement===document.body){
      const row=resumeList.children[Math.min(focusIndex,rows.length-1)];
      (row?.querySelector('[data-action="'+focusClass+'"]') || trashToggle).focus();
    }
  }
  async function changeLibrary(sha,action){
    if(changingLibrary || busy)return;
    changingLibrary=true;
    pickerStatus.textContent='';
    try{
      const {token}=await chrome.storage.local.get('token');
      const response=await fetch(origin+'/resumes/'+sha+'/'+action,{method:'POST',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',
        redirect:'error',signal:AbortSignal.timeout(8000)});
      if(!response.ok)throw new Error();
      const library=await response.json();
      ++libraryRevision;
      if(alternatives)renderSelection({...alternatives,resumes:library.resumes,trashedResumes:library.trashedResumes});
      controls();
      pickerStatus.textContent=action==='trash'?'Moved to Trash.':'Resume restored.';
    }catch{
      pickerStatus.textContent='Could not confirm the change. Reopen the picker to check.';
      await checkConnection();
    }finally{changingLibrary=false;}
  }
  trashToggle.onclick=()=>{
    viewingTrash=!viewingTrash;
    resumeSearch.value='';
    pickerStatus.textContent='';
    renderPicker();
    resumeList.scrollTop=0;
  };
  function togglePicker(open){
    picker.hidden=!open;
    resumeButton.setAttribute('aria-expanded',String(open));
    if(open){
      viewingTrash=false;
      pickerStatus.textContent='';
      resumeSearch.value='';
      renderPicker();
      resumeList.scrollTop=0;
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
      const buttons=[...resumeList.querySelectorAll(viewingTrash?'[data-action=restore]':'.resume-choice')];
      const index=Array.from(resumeList.children).indexOf(event.target.closest('li'));
      const next=index+(event.key==='ArrowDown'?1:-1);
      if(buttons[next]){
        event.preventDefault();
        buttons[next].focus();
      }
    }
  };
  function renderSelection(next, error=''){
    alternatives=next;
    const trash=next?.trashedResumes || [];
    const options=resumeOptions(next);
    const resolved=resolvePageResume(next,preference,tab?.url);
    const {activeResume}=resolved;
    currentPageJobId=resolved.currentPageJobId;
    selectedResumeSha256=resolved.selectedResumeSha256;
    selection=next?{...next,currentPage:activeResume}:null;
    $('prepare-action').hidden=!next?.supportsQueue;
    $('support').textContent=error || next?.queuedError || (!canPartial?'Switch to a website, then reopen Hunt.':'');
    resumeButton.value=activeResume?.sha256||'';
    const title=activeResume?resumeLabel(activeResume):'Choose a resume';
    if(resumeButton.title!==title){
      resumeButton.title=title;
      if(activeResume)displayFilename($('resume-name'),activeResume);
      else $('resume-name').textContent=title;
    }
    if(next)renderPicker();
    else togglePicker(false);
    $('resumes').hidden=!options.length && !trash.length;
  }
  renderSelection(null);
  let canUndo=false,canRedo=false,profileCountryConflict=false;
  const countryAction=$('use-profile-country');
  function controls(){
    const locked=busy || workerFilling;
    $('fill').disabled=locked||!selection?.supportsQueue||!selection.queued||!!selection.queuedError||!serviceReady||!browserReady;
    $('partial').disabled=locked||!canPartial||!selection?.currentPage||!serviceReady||!browserReady;
    $('undo').disabled=locked||!canUndo;$('redo').disabled=locked||!canRedo;
    $('history').hidden=!canUndo&&!canRedo;
    countryAction.disabled=locked||!profileCountryConflict||!serviceReady||!browserReady;
    resumeButton.disabled=locked||!selection;
    if(locked)togglePicker(false);
    $('connect-local').disabled=locked;$('batch').disabled=locked;
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
    $('return-issues').hidden=!issues.length;
    $('return-issues').textContent='Review '+issues.length+' '+(issues.length===1?'issue':'issues');
    if(reviewing){
      const issue=issues[issueIndex];
      const position='Issue '+(issueIndex+1)+' of '+issues.length;
      $('issue-position').textContent=issue.target?.section ? position+' · '+issue.target.section : position;
      $('issue-label').textContent=issue.label;
      $('issue-message').textContent=issue.message;
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
  function pageReview(review){
    return toolbar && showPageReview(tab.id,tab.url,review,review?.browserDocumentId);
  }
  async function rememberReview(){
    const status=savedReview?.browserDocumentId ? {browserDocumentId:savedReview.browserDocumentId,phase:issues.length?'review':'done'} : {};
    savedReview=await saveFillReview(tab.id,pageHash,issuesDocumentId,issues,issueIndex,status);
    return pageReview(issues.length?savedReview:null);
  }
  function stepIssue(direction){
    issueIndex=Math.max(0,Math.min(issues.length-1,issueIndex+direction));
    setStatus();showReview(true,true);void rememberReview();
  }
  $('previous-message').onclick=()=>stepIssue(-1);
  $('next-message').onclick=()=>stepIssue(1);
  $('back-to-fill').onclick=()=>{setStatus();showReview(false,true);void pageReview(null);};
  $('return-issues').onclick=()=>{showReview(true,true);void rememberReview();};
  $('close-review').onclick=async()=>{
    await chrome.storage.session.remove(reviewKey);
    savedReview=null;
    await pageReview(null);
    if(toolbar)window.close();else showReview(false,true);
  };
  $('show-field').onclick=async()=>{
    const issue=issues[issueIndex];
    if(!issue?.target || busy)return;
    const button=$('show-field');
    button.disabled=true;
    try{
      const reply=await browserReply(chrome.runtime.sendMessage({action:'revealIssue',tabId:tab.id,expectedUrl:tab.url,documentId:issuesDocumentId,
        frameId:issue.target.frameId,fieldId:issue.target.fieldId}));
      if(!reply?.ok)throw new Error();
      if(toolbar){
        if(await rememberReview())window.close();
        else setStatus({errors:['Field highlighted. Chrome could not keep the review open on this page.']});
      }
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
        const requestedRevision=libraryRevision;
        try{
          const metadata=await fetch(origin+'/browser/page-resume',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
            body:JSON.stringify({tabId:tab.id,expectedUrl:tab.url}),signal:AbortSignal.timeout(4000),redirect:'error'});
          if(!metadata.ok)throw new Error((await metadata.json()).error||'Open the full menu to check the selected resume.');
          const next=await metadata.json();
          if(requestedRevision!==libraryRevision)return;
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
    if(busy || workerFilling)return;
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
  let pageDocumentId, inspection, lastInspection;
  function inspectPage(){
    if(!inspection)inspection=pageReply('inspect').then(result=>{
      lastInspection={documentId:result.documentId,requiredIssues:result.requiredIssues??[]};
      return result;
    }).finally(()=>{inspection=null;});
    return inspection;
  }
  async function pageReply(operation, expectedResumeSha256){
    const reply=await browserReply(chrome.runtime.sendMessage({action:'pageAction',operation,tabId:tab.id,expectedUrl:tab.url,documentId:pageDocumentId,
      ...(currentPageJobId&&{currentPageJobId}),...(operation!=='use_profile_country'&&selectedResumeSha256&&{resumeSha256:selectedResumeSha256}),...(expectedResumeSha256&&{expectedResumeSha256}),expiresAt:Date.now()+12000}));
    if(!reply?.ok)throw new Error(reply?.error||'The page action was not confirmed. Inspect the draft before retrying.');
    pageDocumentId=reply.result.documentId;
    return reply.result;
  }
  async function partial(action){
    historyVersion++;
    const digest=action==='fill'?selection?.currentPage?.sha256:undefined;
    if(!pageDocumentId)await inspectPage();
    const originalDocument=pageDocumentId;
    let result;
    try{
      result=await pageReply(action,digest);
    }catch(error){
      const uncertain=/timed?\s*out|expir(?:ed|y)|not confirmed|did not respond/i.test(error.message);
      const interrupted=uncertain || /no usable page area|lost access to the page|could not access the selected tab|could not be read|protected extension content|another debugger is attached/i.test(error.message);
      if(!interrupted && action!=='use_profile_country')throw error;
      // Read the same document again. Never repeat a write to recover its result.
      const previous=lastInspection;
      let inspected;
      try{
        inspected=await inspectPage();
      }catch{profileCountryConflict=false;}
      if(inspected?.documentId===originalDocument){
        applyPageState(inspected);
        issuesDocumentId=originalDocument;
        presentResult(inspected);
        await rememberReview();
      }else{
        issues=[];canUndo=false;canRedo=false;profileCountryConflict=false;showReview(false);
        if(!inspected && interrupted && previous?.documentId===originalDocument && previous.requiredIssues.length){
          issues=previous.requiredIssues.map(field=>({label:field.label,message:
            (field.section?field.section+'. ':'')+'Flagged before this attempt. C3 could not recheck this field.'}));
          issueIndex=0;issuesDocumentId=originalDocument;showReview(true);await rememberReview();
        }
      }
      if(!interrupted)throw error;
      if(inspected && inspected.documentId!==originalDocument)throw new Error('The page changed during this action. Reopen Hunt on the current page.');
      if(inspected)throw new Error('C3 could not confirm all changes. The page was rechecked.');
      throw new Error(uncertain?'C3 could not confirm all changes or recheck the form. Review the draft before retrying.':
        error.message+' C3 could not recheck which changes were saved.');
    }
    applyPageState(result);
    if(result.accountPage){issues=[];showReview(false);await pageReview(null);setStatus({summary:'Account fields filled.'});return;}
    issuesDocumentId=result.documentId;
    presentResult(result);
    await rememberReview();
  }
  function presentResult(result,index=0){
    const review=summarizeFill(result);
    issues=review.issues;
    issueIndex=Math.max(0,Math.min(Number.isInteger(index)?index:0,issues.length-1));
    setMore(false);
    showReview(issues.length>0);
    setStatus({summary:review.summary});
  }
  $('partial').onclick=()=>run(async()=>{
    if(!toolbar){await partial('fill');return;}
    const digest=selection?.currentPage?.sha256;
    if(!digest)throw new Error('Choose a resume before filling.');
    // The worker owns the write after acknowledging the click, so Chrome can
    // destroy this popup without interrupting the fill or its review.
    const reply=await browserReply(chrome.runtime.sendMessage({action:'startCurrentPageFill',tabId:tab.id,
      expectedUrl:tab.url,documentId:pageDocumentId,expectedResumeSha256:digest}));
    if(!reply?.ok)throw new Error(reply?.error||'Hunt could not start this fill.');
    window.close();
  },$('partial'),'Filling page…');
  countryAction.onclick=()=>run(()=>partial('use_profile_country'),countryAction,'Updating address…');
  $('undo').onclick=()=>run(()=>partial('undo'));
  $('redo').onclick=()=>run(()=>partial('redo'));
  function applyPageState(result){
    canUndo=result.canUndo;canRedo=result.canRedo;profileCountryConflict=result.profileCountryConflict===true;
  }
  async function loadHistory(restored=false){const version=historyVersion;try{const result=await inspectPage();if(version!==historyVersion)return;applyPageState(result);
    if(restored && savedReview?.page===pageHash && savedReview.documentId===result.documentId){
      // Refresh located findings against the actual page; retain fill-only
      // notices (for example, employer attachment confirmation).
      if(savedReview.phase==='review'){
        const fresh=reconcileFieldReview(issues,issueIndex,result);
        issues=fresh.issues;issueIndex=fresh.index;showReview(issues.length>0);
        if(toolbar)await rememberReview();
      }
    }else if(!busy && savedReview?.page===pageHash && savedReview.documentId===result.documentId){
      issuesDocumentId=result.documentId;
      presentResult(result,savedReview.index);
      if(toolbar)await rememberReview();
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
    if(chosenSha===preference?.sha256 && preference.url===tab.url)return;
    await run(async()=>{
      const queued=alternatives?.queued;
      const matchedJobId=queued?.source==='selected' && queued.sha256===chosenSha && chosenSha!==alternatives?.currentPage?.sha256 ? queued.jobId : undefined;
      const next={sha256:chosenSha,...(matchedJobId&&{jobId:matchedJobId}),url:tab.url};
      await chrome.storage.session.set({[choiceKey]:next});
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

  async function restoreWorkerView(review){
    if(!review?.phase || !review.browserDocumentId || review.page!==pageHash)return false;
    const id=await chrome.tabs.sendMessage(tab.id,{action:'identifyFillDocument',expectedUrl:tab.url},
      {documentId:review.browserDocumentId}).catch(()=>null);
    if(id!==review.browserDocumentId || savedReview!==review)return false;
    workerFilling=review.phase==='filling';
    issues=review.issues??[];issueIndex=Math.max(0,Math.min(review.index??0,issues.length-1));
    issuesDocumentId=review.documentId;profileCountryConflict=issues.some(issue=>issue.country);
    showReview(!workerFilling && issues.length>0);
    setStatus(workerFilling?{summary:'Filling current page…'}:review.error && !issues.length?{errors:[review.error]}:{summary:review.summary??''});
    controls();
    return true;
  }
  // A user can open the toolbar while the invitation's fill is running.
  // Keep that view in sync even if it missed the original click.
  if(toolbar)chrome.storage.onChanged.addListener((changes,area)=>{
    const change=changes[reviewKey];
    if(area!=='session' || !change || !(change.newValue?.liveUpdate || change.newValue?.phase==='filling' || change.oldValue?.phase==='filling'))return;
    historyVersion++;
    savedReview=change.newValue;
    void restoreWorkerView(savedReview);
  });
  savedReview=(await chrome.storage.session.get(reviewKey))[reviewKey];
  const restored=await restoreWorkerView(savedReview);
  controls();await checkConnection();
  if(canPartial && selection && !workerFilling)void loadHistory(restored);
  if(!saved.token)void run(connectLocal);
  setInterval(()=>{if(!busy)void checkConnection();},5000);
}

// These are display labels. Recognizing a host does not enable queued preparation.
const hostedPlatforms = [
  ['Workday', /\.(?:myworkdayjobs|myworkdaysite)\.com$/],
  ['Greenhouse', /^(?:boards|job-boards(?:\.(?:eu|anz))?)\.greenhouse\.io$/],
  ['Lever', /^jobs(?:\.eu)?\.lever\.co$/],
  ['Ashby', /^jobs\.ashbyhq\.com$/],
  ['Workable', /^apply\.workable\.com$/],
  ['BambooHR', /\.bamboohr\.com$/],
  ['SmartRecruiters', /^jobs\.smartrecruiters\.com$/],
  ['Jobvite', /^jobs\.jobvite\.com$/],
  ['Recruitee', /\.recruitee\.com$/],
  ['JazzHR', /\.applytojob\.com$/],
  ['Rippling', /^ats(?:\.us1)?\.rippling\.com$/],
];

// Runs in the selected top frame. Read only the hiring organization declared
// by the posting; page titles, tenant slugs and account form values are not names.
function readPostingCompany(expectedUrl) {
  if (location.href !== expectedUrl) return null;
  const scripts = document.querySelectorAll('script[type="application/ld+json" i]');
  if (scripts.length > 24) return null;
  let budget = 256 * 1024;
  const postings = [];
  for (const script of scripts) {
    const text = script.textContent;
    budget -= text.length;
    if (budget < 0) return null;
    let data;
    try { data = JSON.parse(text); } catch { continue; }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      for (const item of [node, ...(Array.isArray(node?.['@graph']) ? node['@graph'] : [])]) {
        if ([item?.['@type']].flat().includes('JobPosting')) postings.push(item);
      }
    }
  }
  if (postings.length !== 1) return null;
  const [posting] = postings;
  // A recommendation for a different URL cannot name the current employer.
  const reference = posting.url ?? posting['@id'];
  if (reference !== undefined) {
    if (typeof reference !== 'string' || !reference.trim()) return null;
    let declared;
    try { declared = new URL(reference, expectedUrl); } catch { return null; }
    const current = new URL(expectedUrl);
    if (declared.origin !== location.origin || declared.pathname !== location.pathname ||
        [...declared.searchParams].some(([key, value]) => !current.searchParams.getAll(key).includes(value)) ||
        (declared.hash.startsWith('#/') && declared.hash !== current.hash)) return null;
  }
  const name = posting.hiringOrganization?.name;
  if (typeof name !== 'string' || name.length > 160 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name)) return null;
  return name.trim() || null;
}

async function popupSiteContext(tab) {
  const {hostname, pathname} = new URL(tab.url);
  // iCIMS also hosts marketing and support. Tenant portals commonly use a
  // careers/jobs prefix, and custom portal names expose the same /jobs/ route.
  const icimsPortal = /^[\w-]+\.icims\.com$/.test(hostname) &&
    (/^(?:careers?|jobs?)[\w-]*\./.test(hostname) || /^\/jobs(?:\/|$)/.test(pathname) && !hostname.startsWith('www.'));
  const ats = icimsPortal ? 'iCIMS' : hostedPlatforms.find(([, pattern]) => pattern.test(hostname))?.[0] ?? null;
  let company = null;
  try {
    const [top] = await chrome.scripting.executeScript({
      target: {tabId: tab.id, frameIds: [0]}, func: readPostingCompany, args: [tab.url],
    });
    company = top?.result ?? null;
  } catch { /* Some browser-managed pages permit only hostname identification. */ }
  try {
    const current = await chrome.tabs.get(tab.id);
    if (!current.active || current.url !== tab.url) return null;
  } catch { return null; }
  return {hostname, ats, company};
}

await initializePopup();
