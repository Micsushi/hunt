import { resolvePageResume } from './current-page-resume.js';
import { summarizeFill, saveFillReview, showPageReview } from './fill-review-result.js';
import { supportsCurrentPage } from './website-handoff.js';

// The worker owns the operation once it acknowledges the click. Chrome may
// destroy the caller (especially its toolbar popup) at any point after that.
export function createCurrentPageFill(origin, connected, waitForPopupRead=async()=>{}) {
  const active=new Map();
  const changed='The application page changed. Open Hunt on the current page.';
  const interrupted='Hunt could not confirm the fill. Check the form before retrying.';
  // A service worker may be evicted or the browser may restart after sending
  // the write. Restore an honest status without replaying that request.
  const recovered=(async()=>{
    const records=await chrome.storage.session.get(null);
    for(const [key,row] of Object.entries(records)){
      if(!/^fillReview:\d+$/.test(key) || row?.phase!=='filling')continue;
      const tabId=Number(key.split(':')[1]);
      await saveFillReview(tabId,row.page,row.documentId,[{label:'Check the form',message:interrupted}],0,
        {browserDocumentId:row.browserDocumentId,phase:'error',error:interrupted});
    }
  })().catch(()=>{});
  async function checkTab(tabId,url) {
    const tab=await chrome.tabs.get(tabId);
    if(!tab.active || tab.discarded || tab.pendingUrl || tab.url!==url)throw new Error(changed);
  }
  async function identify(tabId,url,documentId,manual) {
    const send=()=>chrome.tabs.sendMessage(tabId,{action:'identifyFillDocument',expectedUrl:url},
      documentId?{documentId}:{frameId:0});
    let id;
    try{id=await send();}catch{}
    if(!id && manual && !documentId){
      // The toolbar's activeTab grant also supports manually selected forms
      // outside the invitation's static host list.
      try{
        const [root]=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},files:['field-review.js']});
        id=await chrome.tabs.sendMessage(tabId,{action:'identifyFillDocument',expectedUrl:url},{documentId:root.documentId});
      }catch{}
    }
    if(typeof id!=='string' || !id || documentId && id!==documentId)throw new Error(changed);
    return id;
  }
  async function post(path,body) {
    const {token}=await chrome.storage.local.get('token');
    if(!token || !connected())throw new Error('Connect Hunt C3 before filling this page.');
    const expiresAt=Date.now()+12000;
    let response;
    try{
      response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        body:JSON.stringify(path==='/browser/page'?{...body,expiresAt}:body),signal:AbortSignal.timeout(12000),redirect:'error'});
    }catch{throw new Error(body.operation==='fill'?interrupted:'Hunt could not check this page. Reopen the extension to retry.');}
    const result=await response.json().catch(()=>null);
    if(!response.ok || !result)throw new Error(typeof result?.error==='string'?result.error:
      body.operation==='fill'?interrupted:'Hunt could not check this page.');
    return result;
  }
  async function start({tabId,url,callerDocumentId,expectedDocument,expectedResume,manual}) {
    if(!Number.isSafeInteger(tabId) || tabId<1 || !supportsCurrentPage(url,origin) ||
        !manual && !callerDocumentId)throw new Error(changed);
    await recovered;
    await checkTab(tabId,url);
    const browserDocumentId=await identify(tabId,url,callerDocumentId,manual);
    // Pin the document first so a click from a later visit to the same URL
    // cannot consume an acknowledgement meant for an older visit.
    if(active.has(tabId)){
      const previous=active.get(tabId);
      if(previous.url!==url || previous.browserDocumentId!==browserDocumentId)throw new Error('Wait for the current fill to finish.');
      await previous.accepted;
      return {ok:true,started:false};
    }
    const operation={url,browserDocumentId};
    active.set(tabId,operation);
    const run=async()=>{
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url))),
        byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,24);
      await checkTab(tabId,url);
      await saveFillReview(tabId,hash,expectedDocument,[],0,{phase:'filling',browserDocumentId});
      void chrome.tabs.sendMessage(tabId,{action:'dismissFillInvitation',expectedUrl:url},{documentId:browserDocumentId}).catch(()=>{});
      return hash;
    };
    operation.accepted=run();
    let hash;
    try{hash=await operation.accepted;}catch(error){active.delete(tabId);throw error;}
    // Do not depend on the caller's message port remaining open after ACK.
    void finish().finally(()=>{if(active.get(tabId)===operation)active.delete(tabId);}).catch(()=>{});
    return {ok:true,started:true};

    async function finish(){
      const base={tabId,expectedUrl:url}, choiceKey='pageResume:'+tabId;
      let documentId=expectedDocument, issues=[], summary='', error='', attempted=false, inspected;
      try{
        await waitForPopupRead(tabId);
        const metadata=await post('/browser/page-resume',base);
        const preference=(await chrome.storage.session.get(choiceKey))[choiceKey];
        const {activeResume,currentPageJobId,selectedResumeSha256,stalePreference}=resolvePageResume(metadata,preference,url);
        if(stalePreference || !activeResume || expectedResume && expectedResume!==activeResume.sha256)
          throw new Error('Choose a resume in Hunt before filling this page.');
        const selected={...base,...(currentPageJobId&&{currentPageJobId}),...(selectedResumeSha256&&{resumeSha256:selectedResumeSha256})};
        inspected=await post('/browser/page',{...selected,operation:'inspect'});
        if(!inspected.documentId || documentId && inspected.documentId!==documentId)throw new Error(changed);
        documentId=inspected.documentId;
        await checkTab(tabId,url);
        await identify(tabId,url,browserDocumentId,false);
        attempted=true;
        const result=await post('/browser/page',{...selected,documentId,operation:'fill',expectedResumeSha256:activeResume.sha256});
        if(result.documentId!==documentId)throw new Error(interrupted);
        if(result.accountPage)summary='Account fields filled.';
        else ({issues,summary}=summarizeFill(result));
      }catch(failure){
        error=failure.message || interrupted;
        if(attempted && /confirm|timed?\s*out|expir|usable page area|access|protected extension|debugger is attached/i.test(error)){
          // A write may have happened before its receipt was lost. Recheck
          // this document once without ever resending the fill.
          try{
            await identify(tabId,url,browserDocumentId,false);
            const fresh=await post('/browser/page',{...base,operation:'inspect'});
            if(fresh.documentId===documentId)issues=summarizeFill(fresh).issues;
          }catch{
            issues=(inspected?.requiredIssues??[]).map(row=>({label:row.label,
              message:'Flagged before the fill. Hunt could not recheck this field.'}));
          }
        }
        issues=[{label:'Check the form',message:error},...issues];
      }
      const phase=error?'error':issues.length?'review':'done';
      const review=await saveFillReview(tabId,hash,documentId,issues,0,{phase,browserDocumentId,summary,error});
      try{
        await identify(tabId,url,browserDocumentId,false);
        await showPageReview(tabId,url,issues.length?review:null,browserDocumentId);
      }catch{/* The tab may be closed. Its old result cannot attach to another document. */}
    }
  }
  return {start,busy:tabId=>tabId===undefined?active.size>0:active.has(tabId)};
}
