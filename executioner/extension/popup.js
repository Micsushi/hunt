const $=id=>document.getElementById(id),origin='http://127.0.0.1:47831';
const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
const saved=await chrome.storage.local.get('token');
$('extension-version').textContent=`Hunt C3 extension ${chrome.runtime.getManifest().version}`;
$('job').textContent=tab?.title||'Current page';
$('job').title=tab?.title||'';
const supported=(()=>{try{const u=new URL(tab?.url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(/^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(u.hostname)||['job-boards.greenhouse.io','boards.greenhouse.io','job-boards.eu.greenhouse.io','jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com','apply.workable.com'].includes(u.hostname));}catch{return false;}})();
$('fill').disabled=!supported;
let busy=false, serviceReady=false, browserReady=false;
const canPartial=(()=>{try{return new URL(tab?.url).protocol==='https:';}catch{return false;}})();
$('prepare-action').hidden=!supported;
$('partial-help').hidden=!canPartial;
if(!canPartial)$('job').textContent='Open a job application';
$('support').textContent=canPartial?(supported?'':'Only current-page filling is supported on this site.'):'Switch to an application on an HTTPS website, then reopen Hunt.';
$('partial').disabled=!canPartial;
let canUndo=false,canRedo=false;
function controls(){
  $('fill').disabled=busy||!supported||!serviceReady||!browserReady;
  $('partial').disabled=busy||!canPartial||!serviceReady;
  $('undo').disabled=busy||!canUndo;$('redo').disabled=busy||!canRedo;
  $('history').hidden=!canUndo&&!canRedo;
  $('connect').disabled=busy;$('connect-local').disabled=busy;$('batch').disabled=busy;
  $('website').disabled=busy||!serviceReady||!browserReady;
}
async function checkConnection(){
  serviceReady=false;browserReady=false;
  $('connection-details').textContent='';
  try{
    const {token}=await chrome.storage.local.get('token');
    if(!token){$('connection').textContent='Connect to the local app to get started';return;}
    const response=await fetch(origin+'/state',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(4000)});
    if(!response.ok){$('connection').textContent=response.status===401?'Pairing key rejected':'C3 service unavailable';return;}
    const state=await response.json();serviceReady=Boolean(state.configured);
    const local=await browserReply(chrome.runtime.sendMessage({action:'connectionStatus'}));
    browserReady=Boolean(local?.connected);
    $('connection').textContent=!browserReady?(state.connected?'Another browser is connected':'Browser connection pending'):!serviceReady?'Connected. Save your profile in the workspace.':'Connected';
    $('browser-details').textContent=local?.browser||'';
    $('connection-details').textContent=!browserReady&&state.connected?'Choose Connect to local app to use this browser.':'';
  }catch{$('connection').textContent='Start the local C3 app to connect';}
  finally{
    $('connection').dataset.ready=String(serviceReady&&browserReady);
    const destination=$(browserReady?'pairing-actions':'connection-actions');
    if($('connect-local').parentElement!==destination)destination.append($('connect-local'));
    controls();
  }
}
async function run(action,control,message){
  if(busy)return;
  const focused=document.activeElement;
  const pairing=control&&$('settings').contains(control);
  $(pairing?'pairing-feedback':'page-feedback').append($('status'));
  busy=true;controls();$('status').dataset.error='false';$('status').textContent=message||'';
  const label=control?.textContent;if(control){control.textContent=message;control.setAttribute('aria-busy','true');}
  try{await action();}catch(e){$('status').dataset.error='true';$('status').textContent=e.name==='TimeoutError'?'Request timed out. Check that C3 is running, then retry.':e.message;}
  finally{
    busy=false;if(control){control.textContent=label;control.removeAttribute('aria-busy');}controls();
    // Disabling or moving the clicked control can drop keyboard focus.
    // Restore it only if the user has not focused something else while waiting.
    if(document.activeElement===document.body&&focused instanceof HTMLButtonElement){
      (focused.checkVisibility()&&!focused.disabled?focused:$('batch')).focus();
    }
  }
}
let historyVersion=0;
async function browserReply(promise,message='The browser did not respond. Reopen C3 to retry.'){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),15000);})]);}
  finally{clearTimeout(timer);}
}
let pageDocumentId;
async function pageReply(operation){
  const reply=await browserReply(chrome.runtime.sendMessage({action:'pageAction',operation,tabId:tab.id,expectedUrl:tab.url,documentId:pageDocumentId,expiresAt:Date.now()+12000}));
  if(!reply?.ok)throw new Error(reply?.error||'The page action was not confirmed. Inspect the draft before retrying.');
  pageDocumentId=reply.result.documentId;
  if(reply.result.accountPage)$('partial-help').textContent='Uses your saved account and approved terms.';
  return reply.result;
}
function showSubmissionWarning(result){
  if(!result.skipped?.some(item=>item.reason==='employer_submission_disabled'))return false;
  const status=$('status');
  status.dataset.error='true';
  status.textContent+=(status.textContent?' ':'')+'The employer still has submission disabled.';
  return true;
}
function showAttachments(result){
  const rows=result.skipped??[], reasons=new Set(rows.map(row=>row.reason));
  const notes=new Set();
  if(reasons.has('different_resume_requires_manual_review'))notes.add('Your selected PDF differs from the earlier resume selection on this page. Check which resume the employer has.');
  else if(reasons.has('resume_filename_differs'))notes.add('The employer shows a different resume filename. Check it against your selected PDF.');
  else if(result.resumeEvidence==='filename'||reasons.has('resume_filename_visible_contents_unverified'))notes.add('The employer shows the matching resume filename. PDF contents unverified.');
  else if(result.resumeEvidence==='earlier_filename')notes.add('The previous step showed the matching resume filename. PDF contents unverified.');
  else if(reasons.has('resume_filename_visible'))notes.add('The employer shows a resume filename. Check it against your selected PDF. Contents unverified.');
  else if(reasons.has('resume_picker_occupied'))notes.add('The local resume picker contains a file. Check it against your selected PDF. Employer contents unverified.');
  else if(['existing_attachment_preserved','existing_remote_attachment_requires_review','existing_smartrecruiters_attachment_requires_review','remote_upload_preserved','client_attachment_preserved'].some(reason=>reasons.has(reason)))notes.add('A resume is already present. Check it against your selected PDF.');
  else if(result.resumeEvidence==='picker')notes.add('The local file picker matches the selected PDF. Employer contents unverified.');
  else if(reasons.has('required_resume_missing') || result.operation==='inspect' && result.resume==='missing')notes.add('The required resume field is empty.');
  else if(reasons.has('resume_control_not_identified'))notes.add('C3 could not identify the resume field. Check the employer page.');
  else if(['resume_attachment_not_verified','resume_upload_already_attempted_review_attachment','uploaded_attachment_requires_review','attachment_not_verified_native_file_retained','ambiguous_resume_attachment','resume_parsing_pending_profile_not_filled'].some(reason=>reasons.has(reason)))notes.add('The resume attachment was not confirmed. Check it on the employer page.');
  for(const row of rows){
    if(!['required_attachment_missing','required_attachment_unconfirmed'].includes(row.reason))continue;
    const name=/transcript|relev[ée] de notes/i.test(row.label)?'transcript':/cover[ -]?letter|lettre de/i.test(row.label)?'cover letter':'document';
    notes.add(row.reason==='required_attachment_missing'?`The required ${name} is missing.`:`Check the required ${name}. Its upload is unconfirmed.`);
  }
  if(notes.size){
    const status=$('status');
    status.dataset.error='true';
    status.textContent+=(status.textContent?' ':'')+[...notes].join(' ');
  }
}
async function partial(action){
  historyVersion++;
  if(!pageDocumentId)await pageReply('inspect');
  const result=await pageReply(action);
  canUndo=result.canUndo;canRedo=result.canRedo;
  if(result.accountPage){$('status').textContent='Account fields filled. Review them before continuing.';return;}
  const count=result.filled.length;
  $('status').textContent=action==='fill'?`${count} changes on this page. Existing entries were preserved. Review every answer and attachment.`:`${count} field changes ${action==='undo'?'undone':'restored'}.`;
  const conflicts=(result.skipped||[]).filter(item=>['saved_value_conflict','value_changed_after_fill'].includes(item.reason)).length;
  if(conflicts){$('status').dataset.error='true';$('status').textContent+=` ${conflicts} ${conflicts===1?'field differs':'fields differ'} from saved answers or changed after filling. Check them before continuing.`;}
  showAttachments(result);
  if(result.needsOwnerReview)$('status').textContent+=' Suggested answers and uncertain matches need review.';
  if (result.componentFailure) {
    const {component, operation} = result.componentFailure;
    $('status').dataset.error = 'true';
    $('status').textContent += ' Check ' + component.replaceAll('_', ' ') + ' (' + operation.replaceAll('_', ' ') + ').';
  }
  const submissionDisabled = showSubmissionWarning(result);
  if (result.frames?.some(frame => frame.status === 'unavailable')) {
    $('status').dataset.error = 'true';
    $('status').textContent += ' A frame could not be reached. Check it before retrying.';
  } else if (result.incomplete && !result.componentFailure && !submissionDisabled) {
    $('status').dataset.error = 'true';
    $('status').textContent += ' Check the incomplete fields before retrying.';
  }
}
$('partial').onclick=()=>run(()=>partial('fill'),$('partial'),'Filling page…');
$('undo').onclick=()=>run(()=>partial('undo'));
$('redo').onclick=()=>run(()=>partial('redo'));
if(canPartial)void(async()=>{const version=historyVersion;try{const result=await pageReply('inspect');if(version!==historyVersion)return;canUndo=result.canUndo;canRedo=result.canRedo;
  if(!busy&&!$('status').textContent){showAttachments(result);showSubmissionWarning(result);}
  controls();}catch{}})();
async function connectWithToken(token){
  if(!token)throw new Error('Enter a pairing key, or use Connect to local app.');
  let response;
  try{response=await fetch(origin+'/state',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(4000)});}
  catch{throw new Error('Start the local C3 app, then retry. Your saved connection was kept.');}
  if(!response.ok)throw new Error(response.status===401?'Pairing key rejected. Your saved connection was kept.':'C3 service unavailable. Your saved connection was kept.');
  const state=await response.json();
  if(typeof state?.connected!=='boolean'||typeof state?.configured!=='boolean')throw new Error('C3 did not confirm the connection. Your saved connection was kept.');
  await chrome.storage.local.set({token});
  const result=await browserReply(chrome.runtime.sendMessage({action:'connect'}));
  if(!result?.ok)throw new Error(result?.error||'Connection request failed. Reopen C3 to retry.');
  $('token').value='';await checkConnection();$('status').textContent=browserReady?'Connection saved. C3 reconnects automatically.':'Connection saved. Waiting for the browser.';
}
$('connect').onclick=()=>run(()=>connectWithToken($('token').value.trim()),$('connect'),'Connecting…');
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
  if(keys.size>1)throw new Error('Several workspaces have different keys. Close the old workspaces, then retry. Your saved connection was kept.');
  const token=keys.values().next().value||(await chrome.storage.local.get('token')).token;
  if(!token)throw new Error('Start C3 with npm --prefix executioner run product -- --open. Keep its workspace open in this browser, then retry.');
  await connectWithToken(token);
}
$('connect-local').onclick=()=>run(connectLocal,$('connect-local'),'Connecting…');
$('batch').onclick=()=>run(async()=>{const {token}=await chrome.storage.local.get('token');await chrome.tabs.create({url:origin+'/#token='+encodeURIComponent(token||'')});});
$('website').onclick=()=>run(async()=>{await chrome.tabs.create({url:'https://agent-hunt-review.mshi.ca/executioner#c3-extension='+chrome.runtime.id});},$('website'),'Opening Hunt…');
$('fill').onclick=()=>run(async()=>{const current=await chrome.tabs.get(tab.id);if(current.url!==tab.url)throw new Error('The page changed. Reopen C3 on the application.');const {token}=await chrome.storage.local.get('token');const resultConnect=await browserReply(chrome.runtime.sendMessage({action:'connect'}));if(!resultConnect?.ok)throw new Error(resultConnect?.error||'Connection request failed');if((await chrome.tabs.get(tab.id)).url!==tab.url)throw new Error('The page changed. Reopen C3 on the application.');
  const request={jobs:[{url:tab.url,tabId:tab.id,title:tab.title}]};
  let response,result;try{response=await fetch(origin+'/jobs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(token||'')},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)});result=await response.json();}catch{throw new Error('No confirmation received. Check Applications for this job.');}if(!response.ok)throw new Error(typeof result?.error==='string'&&result.error?result.error:'C3 could not confirm this job. Check Applications before retrying.');const job=result?.[0];if(!job||typeof job.status!=='string')throw new Error('No confirmation received. Check Applications for this job.');$('status').textContent=['queued','running'].includes(job.status)?'Queued. C3 will stop at Review.':`${job.stage||job.status}. Open Applications to continue.`;});

controls();await checkConnection();
if(!saved.token)void run(connectLocal);
setInterval(()=>{if(!busy)void checkConnection();},5000);
