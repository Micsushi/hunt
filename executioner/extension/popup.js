import { supportsCurrentPage } from './website-handoff.js';

await initializePopup();

async function initializePopup() {
  const $=id=>document.getElementById(id),origin='http://127.0.0.1:47831';
  const toolbar=chrome.extension.getViews({type:'popup'}).includes(window);
  if(!toolbar)document.documentElement.classList.add('tab-view');
  const compact=toolbar && screen.availHeight<590;
  function showPanel(panel){
    if(!compact)return;
    document.body.dataset.panel=panel;
    for(const button of $('compact-nav').children)button.setAttribute('aria-pressed',String(button.dataset.panel===panel));
    layoutMessage();
  }
  if(compact){
    $('compact-nav').hidden=false;
    $('compact-nav').onclick=event=>{if(event.target.dataset.panel)showPanel(event.target.dataset.panel);};
  }
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const saved=await chrome.storage.local.get('token');
  const choiceKey='pageResume:'+tab?.id;
  let preference=(await chrome.storage.session.get(choiceKey))[choiceKey];
  $('job').textContent=tab?.title||'Current page';
  $('job').title=tab?.title||'';
  let busy=false, serviceReady=false, browserReady=false;
  const canPartial=supportsCurrentPage(tab?.url,origin);
  $('actions').hidden=!canPartial;
  if(!canPartial)$('job').textContent='Open a web form';
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
  function renderSelection(next, error=''){
    alternatives=next;
    const options=resumeOptions(next);
    const queued=next?.queued;
    const select=$('resume-select');
    const prefMatch=preference?.url===tab?.url
      ? options.find(item=>item.sha256===preference.sha256 && (!preference.jobId || item.jobId===preference.jobId || item.sha256===queued?.sha256))
      : null;
    const activeResume=prefMatch||next?.currentPage||options[0]||null;
    const matchesQueued=Boolean(prefMatch && queued?.source==='selected' && queued.jobId && activeResume?.sha256===queued.sha256 && queued.sha256!==next?.currentPage?.sha256);
    currentPageJobId=matchesQueued?queued.jobId:undefined;
    selectedResumeSha256=prefMatch && !matchesQueued && activeResume?.sha256!==next?.currentPage?.sha256 ? activeResume.sha256 : undefined;
    selection=next?(activeResume?{...next,currentPage:activeResume}:next):null;
    $('prepare-action').hidden=!next?.supportsQueue;
    $('support').textContent=error || next?.queuedError || (!canPartial?'Switch to a website, then reopen Hunt.':next?.supportsQueue?'Full application or current page':'');
    if(options.length){
      const signature=options.map(item=>`${item.sha256}:${item.name}:${item.version||''}`).join('|');
      if(select.dataset.signature!==signature){
        select.replaceChildren(...options.map(item=>{
          const opt=document.createElement('option');
          opt.value=item.sha256;
          opt.textContent=item.version?`${item.name} · ${item.version}`:item.name;
          return opt;
        }));
        select.dataset.signature=signature;
      }
      if(activeResume)select.value=activeResume.sha256;
    }else{
      select.replaceChildren();
      delete select.dataset.signature;
    }
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
    countryAction.hidden=!profileCountryConflict;
    countryAction.disabled=busy||!profileCountryConflict||!serviceReady||!browserReady;
    $('resume-select').disabled=busy||$('resume-select').options.length<=1;
    const preview=$('open-resume');
    if(!busy && selection?.currentPage?.sha256)preview.href='resume-preview.html?pdf='+selection.currentPage.sha256;
    else preview.removeAttribute('href');
    $('connect-local').disabled=busy;$('batch').disabled=busy;
    if(compact){
      $('compact-nav').querySelector('[data-panel=result]').disabled=!$('status').textContent;
    }
  }
  function setStatus({summary='', warnings=[], errors=[]}={}){
    const box=$('status');
    box.replaceChildren();
    box.dataset.error=String(errors.length>0);
    if(summary){
      const p=document.createElement('p');
      p.className='status-summary';
      p.textContent=summary;
      box.append(p);
    }
    const addList=(cls,items)=>{
      const unique=[...new Set(items.filter(Boolean))];
      if(!unique.length)return;
      const ul=document.createElement('ul');
      ul.className='status-list '+cls;
      for(const text of unique){
        const li=document.createElement('li');
        li.textContent=text;
        ul.append(li);
      }
      box.append(ul);
    };
    addList('status-error',errors);
    addList('status-warn',warnings);
  }
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
        const fallback=focused===countryAction?(compact?$('compact-nav').querySelector('[data-panel=page]'):canUndo?$('undo'):$('partial')):$('batch');
        (focused.checkVisibility()&&!focused.disabled?focused:fallback).focus();
      }
    }
  }
  let historyVersion=0;
  // Chrome caps toolbar popup height. Long results remain readable one part at a time.
  const statusBox=$('status');
  let messagePage=0;
  function layoutMessage(reset=false){
    if(reset)messagePage=0;
    delete statusBox.dataset.paged;
    if(statusBox.offsetHeight<=(compact&&profileCountryConflict?70:135)){$('message-pages').hidden=true;return;}
    const width=statusBox.clientWidth;
    statusBox.style.setProperty('--column-width',(width-20)+'px');
    statusBox.dataset.paged='';
    const count=Math.ceil(statusBox.scrollWidth/width);
    messagePage=Math.max(0,Math.min(count-1,messagePage));
    statusBox.scrollLeft=messagePage*width;
    $('message-position').textContent=`Part ${messagePage+1} of ${count}`;
    $('previous-message').disabled=messagePage===0;
    $('next-message').disabled=messagePage===count-1;
    $('message-pages').hidden=count<2;
  }
  new MutationObserver(()=>{
    if(compact){
      const hasResult=Boolean(statusBox.textContent);
      $('compact-nav').querySelector('[data-panel=result]').disabled=!hasResult;
      if(hasResult)showPanel('result');
      else if(document.body.dataset.panel==='result')showPanel('page');
    }
    layoutMessage(true);
  }).observe(statusBox,{childList:true,characterData:true,subtree:true});
  window.addEventListener('resize',()=>layoutMessage());
  $('previous-message').onclick=()=>{messagePage--;layoutMessage();};
  $('next-message').onclick=()=>{messagePage++;layoutMessage();};
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
    else if(result.resumeEvidence==='picker')warnings.push('The local file picker matches the selected PDF. Employer contents unverified.');
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
    if(result.accountPage){setStatus({summary:'Account fields filled.'});return;}
    const count=result.filled.length;
    const summary=['fill','use_profile_country'].includes(action)?`${count} ${count===1?'field changed':'fields changed'}.`:`${count} field changes ${action==='undo'?'undone':'restored'}.`;
    const warnings=[], errors=profileCountryConflict?[countryMismatch]:[];
    const conflictItems=(result.skipped||[]).filter(item=>['saved_value_conflict','value_changed_after_fill'].includes(item.reason)
      && !(profileCountryConflict && item.reason==='saved_value_conflict' && /^country\b/i.test(item.label?.trim())));
    if(conflictItems.length){
      const names=[...new Set(conflictItems.map(item=>String(item.label||'').replace(/[\u2009*✱]/g,'').trim()).filter(Boolean))];
      errors.push(names.length
        ? `${names.join(', ')} ${names.length===1?'differs':'differ'} from saved answers or changed after filling.`
        : `${conflictItems.length} ${conflictItems.length===1?'field differs':'fields differ'} from saved answers or changed after filling.`);
    }
    collectAttachments(result, warnings, errors);
    const addressReason=result.skipped?.find(item=>['bamboo_address_change_unconfirmed','bamboo_address_restore_unconfirmed'].includes(item.reason))?.reason;
    if(addressReason)errors.push(addressReason==='bamboo_address_restore_unconfirmed'
      ? 'C3 could not verify the restored address. Check Country, region and postal code on the form.'
      : 'BambooHR did not confirm the address update. Check the address and your saved profile.');
    if(result.needsOwnerReview){
      const reviewNames=Array.isArray(result.reviewFields)?result.reviewFields.filter(Boolean):[];
      warnings.push(reviewNames.length
        ? `Review suggested or uncertain answers: ${reviewNames.join(', ')}.`
        : 'Suggested answers and uncertain matches need review.');
    }
    if (result.componentFailure && !addressReason) {
      const {component, operation} = result.componentFailure;
      errors.push('Check ' + component.replaceAll('_', ' ') + ' (' + operation.replaceAll('_', ' ') + ').');
    }
    const submissionDisabled=Boolean(result.skipped?.some(item=>item.reason==='employer_submission_disabled'));
    if(submissionDisabled)errors.push('The employer still has submission disabled.');
    if (result.frames?.some(frame => frame.status === 'unavailable')) {
      errors.push('A frame could not be reached. Check it before retrying.');
    } else if (result.incomplete && !result.componentFailure && !submissionDisabled && !addressReason) {
      errors.push('Check the incomplete fields before retrying.');
    }
    setStatus({summary, warnings, errors});
  }
  $('partial').onclick=()=>run(()=>partial('fill'),$('partial'),'Filling page…');
  countryAction.onclick=()=>run(()=>partial('use_profile_country'),countryAction,'Updating address…');
  $('undo').onclick=()=>run(()=>partial('undo'));
  $('redo').onclick=()=>run(()=>partial('redo'));
  function applyPageState(result){
    canUndo=result.canUndo;canRedo=result.canRedo;profileCountryConflict=result.profileCountryConflict===true;
  }
  async function loadHistory(){const version=historyVersion;try{const result=await inspectPage();if(version!==historyVersion)return;applyPageState(result);
    if(!busy&&!$('status').textContent){
      const warnings=[], errors=profileCountryConflict?[countryMismatch]:[];
      collectAttachments(result, warnings, errors);
      if(result.skipped?.some(item=>item.reason==='employer_submission_disabled'))errors.push('The employer still has submission disabled.');
      if(warnings.length||errors.length)setStatus({warnings, errors});
    }
    controls();}catch{}}
  async function refreshHistory(){
    historyVersion++;canUndo=false;canRedo=false;profileCountryConflict=false;controls();
    if(inspection)await inspection.catch(()=>{});
    pageDocumentId=undefined;
    await loadHistory();
  }
  $('resume-select').onchange=()=>run(async()=>{
    const chosenSha=$('resume-select').value;
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
  $('batch').onclick=()=>run(async()=>{const {token}=await chrome.storage.local.get('token');await chrome.tabs.create({url:origin+'/#token='+encodeURIComponent(token||'')});});
  $('fill').onclick=()=>run(async()=>{const digest=selection?.queued?.sha256;const current=await chrome.tabs.get(tab.id);if(current.url!==tab.url)throw new Error('The page changed. Reopen C3 on the application.');const {token}=await chrome.storage.local.get('token');const resultConnect=await browserReply(chrome.runtime.sendMessage({action:'connect'}));if(!resultConnect?.ok)throw new Error(resultConnect?.error||'Connection request failed');if((await chrome.tabs.get(tab.id)).url!==tab.url)throw new Error('The page changed. Reopen C3 on the application.');
    const request={jobs:[{url:tab.url,tabId:tab.id,title:tab.title,...(digest&&{expectedResumeSha256:digest})}]};
    let response,result;try{response=await fetch(origin+'/jobs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(token||'')},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});result=await response.json();}catch{throw new Error('No confirmation received. Check Applications for this job.');}if(!response.ok)throw new Error(typeof result?.error==='string'&&result.error?result.error:'C3 could not confirm this job. Check Applications before retrying.');const job=result?.[0];if(!job||typeof job.status!=='string')throw new Error('No confirmation received. Check Applications before retrying.');setStatus({summary:['queued','running'].includes(job.status)?'Queued. C3 will stop at Review.':`${job.stage||job.status}. Open Applications to continue.`});});

  controls();await checkConnection();
  showPanel('page');
  if(canPartial && selection)void loadHistory();
  if(!saved.token)void run(connectLocal);
  setInterval(()=>{if(!busy)void checkConnection();},5000);
}
