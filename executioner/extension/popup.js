import { fillVisibleFields } from './generic-fill.js';
const $=id=>document.getElementById(id),origin='http://127.0.0.1:47831';
const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
const saved=await chrome.storage.local.get('token');$('token').value=saved.token||'';
$('job').textContent=tab?.title||'Open a supported job tab';
const supported=(()=>{try{const u=new URL(tab?.url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(/^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(u.hostname)||['job-boards.greenhouse.io','boards.greenhouse.io','job-boards.eu.greenhouse.io','jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com','apply.workable.com'].includes(u.hostname));}catch{return false;}})();
$('fill').disabled=!supported;
$('support').textContent=supported?'':tab?.url?.startsWith('https:')?'Full application preparation is unavailable on this site.':'Open an HTTPS application page to fill fields.';
let busy=false, serviceReady=false, browserReady=false;
const canPartial=(()=>{try{return new URL(tab?.url).protocol==='https:';}catch{return false;}})();
$('partial').disabled=!canPartial;
let canUndo=false,canRedo=false;
function controls(){
  $('fill').disabled=busy||!supported||!serviceReady||!browserReady;
  $('partial').disabled=busy||!canPartial||!serviceReady;
  $('undo').disabled=busy||!canUndo;$('redo').disabled=busy||!canRedo;
  $('connect').disabled=busy;$('batch').disabled=busy;
}
async function checkConnection(){
  serviceReady=false;browserReady=false;
  try{
    const {token}=await chrome.storage.local.get('token');
    if(!token){$('connection').textContent='Pair C3 in Connection below';return;}
    const response=await fetch(origin+'/state',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(4000)});
    if(!response.ok){$('connection').textContent=response.status===401?'Pairing key rejected':'C3 service unavailable';return;}
    const state=await response.json();serviceReady=Boolean(state.configured);browserReady=Boolean(state.connected);
    $('connection').textContent=!serviceReady?'Save your profile in the workspace':!browserReady?'Browser connection pending':'Connected';
  }catch{$('connection').textContent='Start the local C3 app to connect';}
  finally{$('connection').dataset.ready=String(serviceReady&&browserReady);controls();}
}
async function run(action,control,message){
  if(busy)return;busy=true;controls();$('status').dataset.error='false';$('status').textContent=message||'';
  const label=control?.textContent;if(control){control.textContent=message;control.setAttribute('aria-busy','true');}
  try{await action();}catch(e){$('status').dataset.error='true';$('status').textContent=e.message;}
  finally{busy=false;if(control){control.textContent=label;control.removeAttribute('aria-busy');}controls();}
}
async function partial(action){
  const current=await chrome.tabs.get(tab.id);
  if(current.url!==tab.url)throw new Error('The page changed. Reopen C3 on the application.');
  let facts=[];
  if(action==='fill'){
    const {token}=await chrome.storage.local.get('token');
    const response=await fetch(origin+'/settings',{headers:{Authorization:'Bearer '+(token||'')}});
    if(!response.ok)throw new Error('Connect C3, then open workspace > Profile.');
    const settings=await response.json();facts=settings?.profile?.profile?.facts;
    if(!Array.isArray(facts))throw new Error('Save your details in workspace > Profile first.');
  }
  const results=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:fillVisibleFields,args:[{facts,action,scope:'page'}]});
  canUndo=results.some(r=>r.result?.canUndo);canRedo=results.some(r=>r.result?.canRedo);
  const count=results.reduce((n,r)=>n+(r.result?.filled?.length||0),0);
  $('status').textContent=action==='fill'?`${count} fields filled on this page. Existing entries were preserved. Files, custom choices and inaccessible frames may need attention.`:`${count} field changes ${action==='undo'?'undone':'restored'}.`;
}
$('partial').onclick=()=>run(()=>partial('fill'),$('partial'),'Filling page…');
$('undo').onclick=()=>run(()=>partial('undo'));
$('redo').onclick=()=>run(()=>partial('redo'));
if(canPartial){try{const results=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},func:fillVisibleFields,args:[{action:'status'}]});canUndo=results.some(r=>r.result?.canUndo);canRedo=results.some(r=>r.result?.canRedo);$('undo').disabled=!canUndo;$('redo').disabled=!canRedo;}catch{}}
$('connect').onclick=()=>run(async()=>{await chrome.storage.local.set({token:$('token').value.trim()});const result=await chrome.runtime.sendMessage({action:'connect'});if(!result?.ok)throw new Error(result?.error||'Connection request failed');await checkConnection();$('status').textContent=browserReady?'Connected':'Connection requested';});
$('batch').onclick=()=>run(async()=>{const {token}=await chrome.storage.local.get('token');await chrome.tabs.create({url:origin+'/#token='+encodeURIComponent(token||'')});});
$('fill').onclick=()=>run(async()=>{const current=await chrome.tabs.get(tab.id);if(current.url!==tab.url)throw new Error('The page changed. Reopen C3 on the application.');const {token}=await chrome.storage.local.get('token');const resultConnect=await chrome.runtime.sendMessage({action:'connect'});if(!resultConnect?.ok)throw new Error(resultConnect?.error||'Connection request failed');const response=await fetch(origin+'/jobs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(token||'')},body:JSON.stringify({jobs:[{url:tab.url,tabId:tab.id,title:tab.title}]})}).catch(()=>{throw new Error('No confirmation received. Check Applications for this job.');});const result=await response.json();if(!response.ok)throw new Error(result.error);const job=result[0];$('status').textContent=['queued','running'].includes(job.status)?'Queued. C3 will stop at Review.':`${job.stage}. Open Applications to continue.`;});

controls();await checkConnection();setInterval(()=>{if(!busy)void checkConnection();},5000);
