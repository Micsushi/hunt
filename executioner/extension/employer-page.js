const changed='The page changed. Inspect it again before filling.';
const grant='Open Hunt from the Chrome toolbar on this page to grant access to the employer form.';

export function pageActionInput(params,frame,root,expiresAt) {
  const isRoot=frame.id===root.id, operation=params.operation;
  return {action:operation==='inspect'?'status':operation==='use_profile_country'?'fill':operation,
    expectedUrl:frame.url,scope:'page',allowProfileForms:new URL(frame.url).origin===new URL(root.url).origin,expiresAt,fieldId:params.fieldId,
    useProfileCountry:operation==='use_profile_country',aiConsentDecision:params.aiConsentDecision,
    facts:params.facts??(isRoot?params.profileCountryFacts:undefined)??[],
    currentProfileCountry:isRoot?params.profileCountryFacts?.find(f=>f.factId==='country')?.value:undefined,
    matchingPlans:operation==='fill'?params.matchingPlans?.filter(p=>p.frameId===frame.id):undefined,
    matchingRunId:params.matchingRunId,pageHandoff:params.pageHandoff,
    resume:operation==='fill' && isRoot?params.resume:undefined};
}

// Chrome's document IDs bind each message even when a frame navigates between
// discovery and delivery. Never send applicant data to a third-party frame.
export async function employerPageAction(params,expiresAt,documentKey,pageReport,prefer=false) {
  const {tabId,expectedUrl,documentId,operation}=params;
  const origin=new URL(expectedUrl).origin;
  const checkTime=()=>{if(Date.now()>=expiresAt)throw new Error('The page action expired. Inspect the draft before retrying.');};
  const snapshot=async()=>{
    checkTime();
    const tab=await chrome.tabs.get(tabId);
    if(tab.discarded || tab.pendingUrl || tab.url!==expectedUrl)throw new Error(changed);
    const all=(await chrome.webNavigation.getAllFrames({tabId})??[]).filter(row=>!row.documentLifecycle || row.documentLifecycle==='active');
    const root=all.find(row=>row.frameId===0);
    if(!root?.documentId || root.url!==expectedUrl)throw new Error(changed);
    const frames=[],unavailable=[];
    function visit(row){
      frames.push({id:row.documentId,loaderId:row.documentId,url:row.url});
      for(const child of all.filter(other=>other.parentFrameId===row.frameId)){
        if(!child.documentId || !/^https?:/.test(child.url))continue;
        const url=new URL(child.url);
        if(url.origin===origin && !url.username && !url.password)visit(child);
        else if(!(/^(?:www\.google\.com|www\.recaptcha\.net|recaptcha\.google\.com)$/.test(url.hostname) && /^\/recaptcha\//.test(url.pathname)) &&
                !(url.hostname.endsWith('.hcaptcha.com') && /captcha/i.test(url.pathname)))
          unavailable.push({parentId:row.documentId,url:child.url,report:{frameId:child.documentId,status:'unavailable',
            error:'Embedded content on '+url.hostname+' is outside the selected employer origin.'}});
      }
    }
    visit(root);
    return {frames,unavailable,binding:'employer-'+await documentKey(frames)};
  };
  const {frames,unavailable,binding}=await snapshot();
  if(documentId && binding!==documentId || operation!=='inspect' && !documentId)throw new Error(changed);
  const root=frames[0], results=[], hidden=new Set();
  if(operation==='reveal' && !frames.some(row=>row.id===params.frameId))throw new Error('This field changed. Reopen Hunt to review the current page.');
  for(const frame of frames){
    const isRoot=frame.id===root.id;
    if(operation==='reveal' && params.frameId!==frame.id || operation==='use_profile_country' && !isRoot)continue;
    const options={documentId:frame.id};
    const send=body=>chrome.tabs.sendMessage(tabId,{action:'employerDocument',topUrl:expectedUrl,expectedUrl:frame.url,...body},options);
    // A new install or a toolbar grant on a custom host can have no registered
    // receiver yet. Only the harmless probe is retried, never an action.
    let ready=await send({probe:true}).catch(()=>null);
    if(!ready?.ready){
      try{
        await chrome.scripting.executeScript({target:{tabId,documentIds:[frame.id]},world:'ISOLATED',files:['employer-document.js']});
        ready=await send({probe:true});
      }catch{}
    }
    if(prefer && (!ready?.ready || ready.preferDebugger))return null;
    if(!ready?.ready){
      if(isRoot)throw new Error(grant);
      results.push({frameId:frame.id,status:'unavailable',error:'Chrome did not grant access to this embedded document.'});continue;
    }
    for(const external of unavailable.filter(row=>row.parentId===frame.id)){
      if(ready.allForeignHidden || ready.hiddenSources?.includes(external.url))hidden.add(external);
      else if(prefer)return null;
    }
    if((await snapshot()).binding!==binding)throw new Error(changed);
    checkTime();
    const input=pageActionInput(params,frame,root,expiresAt);
    const reply=await send({input}).catch(()=>null);
    if(operation==='reveal'){
      if(reply?.result!==true)throw new Error('This field changed. Reopen Hunt to review the current page.');
      return {ok:true};
    }
    if(!reply?.result){
      if(isRoot || operation!=='inspect')throw new Error('This frame could not complete the page action. Inspect the draft before retrying.');
      results.push({frameId:frame.id,status:'unavailable',error:'The embedded document did not confirm the inspection.'});continue;
    }
    results.push({frameId:frame.id,status:'complete',...reply.result});
    if(isRoot && (reply.result.frameScope==='document' || reply.result.componentFailure?.component==='page_state'))break;
  }
  if((await snapshot()).binding!==binding)throw new Error(changed);
  if(operation==='inspect')await chrome.storage.session.set({['employerDocument:'+tabId]:root.id});
  // The queued handoff uses a DevTools loader ID. A Chrome document UUID
  // cannot establish that separate transition.
  return pageReport(params,{id:root.id},binding,[...results,...unavailable.filter(row=>!hidden.has(row)).map(row=>row.report)]);
}
