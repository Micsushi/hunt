import {pageFillSource, observePageSource, checkPageSource, pageFillWorld} from './page-runtime/serialize.js';
import { inspectChoiceWidget } from './shared-choice-widget.js';
import { bambooResumeControl } from './page-adapters/bamboo-resume.js';
import { annotateQuestionContext } from './question-context.js';
import { proveJobviteResumeInput } from './jobvite-resume.js';
import { preparePageViewport, viewportOwnership, viewportUnavailable, viewportCleanupPending } from './page-viewport.js';
import { supportsCurrentPage } from './website-handoff.js';

// These declarations are injected into the exact isolated execution context bound below.
const observeCurrentDocument = `(${observePageSource})()`;
const interruption = checkPageSource;

export const pageActionTabs = new Set();
const pageErrors = new Set([
  viewportUnavailable,
  viewportCleanupPending,
  'The tab changed or is unloaded. Inspect the loaded application again.',
  'The page changed. Inspect it again before filling.',
  'The page changed during this action.',
  'The page action expired. Inspect the draft before retrying.',
  'This frame could not complete the page action. Inspect the draft before retrying.',
  'This page could not be read. Inspect the application before retrying.',
  'This field changed. Reopen Hunt to review the current page.',
]);
const httpsPage = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port; }
  catch { return false; }
};
const securityWidgetFrame = value => {
  if(!httpsPage(value))return false;
  const url=new URL(value);
  return ['www.google.com','www.recaptcha.net','recaptcha.google.com'].includes(url.hostname) &&
    /^\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)$/.test(url.pathname);
};
const emptyHiddenFrame = async (send,frame) => {
  const {backendNodeId}=await send('DOM.getFrameOwner',{frameId:frame.id});
  const resolved=await send('DOM.resolveNode',{backendNodeId});
  const objectId=resolved.object?.objectId;
  if(!objectId)return false;
  try {
    const owner=await send('Runtime.callFunctionOn',{objectId,returnByValue:true,functionDeclaration:`function() {
      if(!(this instanceof HTMLIFrameElement))return false;
      const style=getComputedStyle(this),rects=[...this.getClientRects()];
      return this.hidden || !rects.some(rect=>rect.width>0 && rect.height>0) || style.display==='none' || ['hidden','collapse'].includes(style.visibility);
    }`});
    if(owner.exceptionDetails || owner.result?.value!==true)return false;
  }finally{await send('Runtime.releaseObject',{objectId}).catch(()=>{});}
  const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:frame.id,worldName:pageFillWorld});
  const empty=await send('Runtime.callFunctionOn',{executionContextId,returnByValue:true,functionDeclaration:`function() {
    return location.href==='about:blank' && document.readyState==='complete' && !!document.body &&
      document.body.children.length===0 && !document.body.textContent.trim() &&
      !document.querySelector('input,textarea,select,button,iframe,object,embed,[contenteditable],[role=combobox],[role=textbox]');
  }`});
  return !empty.exceptionDetails && empty.result?.value===true;
};
const framesIn = tree => {
  const frames = [];
  const collect = node => { frames.push(node.frame); (node.childFrames || []).forEach(collect); };
  collect(tree); return frames;
};
const documentKey = async frames => {
  const binding = frames.map(frame=>[frame.id,frame.loaderId,frame.url]).sort((a,b)=>a[0].localeCompare(b[0]));
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(binding)));
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
};

// Observe the site's native chooser to prove the hidden input's binding. The
// shared filler alone supplies files and records reversible changes afterward.
async function proveBambooResumeInput(send, tabId, frame, executionContextId, binding, checkDeadline, expiresAt) {
  const candidate = await send('Runtime.callFunctionOn', {
    executionContextId, functionDeclaration: `function() { return (${bambooResumeControl.toString()})(); }`,
  });
  const objectId = candidate.result?.objectId;
  if (!objectId || candidate.exceptionDetails) return;
  let listener, timer, inputObjectId, intercepting = false;
  try {
    const input = await send('Runtime.callFunctionOn', {objectId, functionDeclaration:'function() { return this.input; }'});
    if (!input.result?.objectId) return;
    inputObjectId = input.result.objectId;
    const {node} = await send('DOM.describeNode', {objectId:input.result.objectId});
    checkDeadline();
    if (await documentKey(framesIn((await send('Page.getFrameTree')).frameTree)) !== binding) throw new Error('The page changed during this action.');
    await send('Page.enable');
    const chooser = new Promise(resolve => {
      listener = (source, method, event) => {
        if (source.tabId === tabId && method === 'Page.fileChooserOpened') resolve(event);
      };
      chrome.debugger.onEvent.addListener(listener);
      timer = setTimeout(()=>resolve(null), Math.max(0, Math.min(1200, expiresAt-Date.now())));
    });
    await send('Page.setInterceptFileChooserDialog',{enabled:true}); intercepting = true;
    checkDeadline();
    const clicked = await send('Runtime.callFunctionOn', {
      objectId, functionDeclaration:`function() { if (location.href!==${JSON.stringify(frame.url)} || ${interruption}(${observeCurrentDocument},'fill')) return false; const current=(${bambooResumeControl.toString()})(); if (!current || current.input!==this.input || current.button!==this.button || current.form!==this.form || current.group!==this.group) return false; this.button.click(); return true; }`,
      userGesture:true, returnByValue:true,
    });
    if (clicked.exceptionDetails || clicked.result?.value !== true) return;
    const event = await chooser;
    checkDeadline();
    if (!event || event.backendNodeId !== node.backendNodeId || event.frameId !== frame.id || event.mode !== 'selectSingle') return;
    if (await documentKey(framesIn((await send('Page.getFrameTree')).frameTree)) !== binding) throw new Error('The page changed during this action.');
    checkDeadline();
    await send('Runtime.callFunctionOn', {
      objectId, functionDeclaration:`function() { const current=(${bambooResumeControl.toString()})(); if (!current || current.input!==this.input || current.button!==this.button || current.form!==this.form || current.group!==this.group) return; const state=globalThis.__huntC3PartialFill??={undo:[],redo:[],busy:false}; (state.nativeFileBindings??=new WeakMap()).set(this.input,{region:this.form,group:this.group,button:this.button}); }`,
    });
  } finally {
    clearTimeout(timer);
    if (listener) chrome.debugger.onEvent.removeListener(listener);
    if (intercepting) await send('Page.setInterceptFileChooserDialog',{enabled:false}).catch(()=>{});
    if (inputObjectId) await send('Runtime.releaseObject',{objectId:inputObjectId}).catch(()=>{});
    await send('Runtime.releaseObject',{objectId}).catch(()=>{});
  }
}

export async function listPageTabs(workspaceOrigin) {
  return (await chrome.tabs.query({})).filter(tab => supportsCurrentPage(tab.url, workspaceOrigin)).map(tab => ({tabId:tab.id,url:tab.url,title:tab.title || '',discarded:!!tab.discarded}));
}

/** Popup and agent actions share one document-local undo history without new host permissions. */
export async function pageAction(params, attached, workspaceOrigin) {
  const expiresAt = Math.min(Date.now()+15000,Number.isFinite(params.expiresAt) ? params.expiresAt : Infinity);
  const checkDeadline = () => { if (Date.now() >= expiresAt) throw new Error('The page action expired. Inspect the draft before retrying.'); };
  const { tabId, expectedUrl, documentId, operation } = params;
  const useProfileCountry = operation === 'use_profile_country';
  if (!Number.isSafeInteger(tabId) || tabId < 1 || !supportsCurrentPage(expectedUrl, workspaceOrigin) || !['inspect','fill','undo','redo','use_profile_country','reveal'].includes(operation)) throw new Error('Choose a supported form tab and page action.');
  if (operation !== 'inspect' && (typeof documentId !== 'string' || !documentId)) throw new Error('Inspect this page before changing fields.');
  if (attached.has(tabId) || pageActionTabs.has(tabId)) throw new Error('C3 is already operating this tab. Wait for it to finish.');
  pageActionTabs.add(tabId);
  let owned = false;
  let restoreViewport = async () => {};
  try {
    checkDeadline();
    const tab = await chrome.tabs.get(tabId);
    checkDeadline();
    if (tab.url !== expectedUrl || tab.pendingUrl || tab.discarded) throw new Error('The tab changed or is unloaded. Inspect the loaded application again.');
    await chrome.debugger.attach({tabId}, '1.3'); owned = true;
    checkDeadline();
    const send = (method, values = {}) => chrome.debugger.sendCommand({tabId}, method, values);
    const tree = await send('Page.getFrameTree');
    const root = tree.frameTree.frame;
    const frames = framesIn(tree.frameTree), binding = await documentKey(frames);
    checkDeadline();
    if (root.url !== expectedUrl || operation !== 'inspect' && binding !== documentId) throw new Error('The page changed. Inspect it again before filling.');
    if(operation==='reveal'){
      const frame=frames.find(item=>item.id===params.frameId);
      if(!frame || typeof params.fieldId!=='string' || !/^[a-f0-9-]{36}$/.test(params.fieldId) ||
          !supportsCurrentPage(frame.url,workspaceOrigin) || securityWidgetFrame(frame.url)) throw new Error('This field changed. Reopen Hunt to review the current page.');
      const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:frame.id,worldName:pageFillWorld});
      if(await documentKey(framesIn((await send('Page.getFrameTree')).frameTree))!==binding)throw new Error('The page changed during this action.');
      checkDeadline();
      const revealed=await send('Runtime.callFunctionOn',{executionContextId,returnByValue:true,
        functionDeclaration:`function(url,id) {
          if(location.href!==url)return false;
          const field=globalThis.__huntC3PartialFill?.requiredIssueTargets?.get(id)?.();
          if(!field?.isConnected)return false;
          // Explicit reveal leaves focus and open editors untouched.
          field.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
          field.animate([{outline:'3px solid #185dd0',outlineOffset:'2px'},{outline:'3px solid #185dd0',outlineOffset:'2px'}],1800);
          return true;
        }`,arguments:[{value:frame.url},{value:params.fieldId}]});
      if(revealed.result?.value!==true)throw new Error('This field changed. Reopen Hunt to review the current page.');
      return {ok:true};
    }
    const target=(await chrome.debugger.getTargets()).find(target=>target.tabId===tabId);
    if(!target)throw new Error('This page could not be read. Inspect the application before retrying.');
    restoreViewport = await preparePageViewport(send,viewportOwnership(target.id));
    checkDeadline();
    const results = [];
    for (const frame of useProfileCountry ? [root] : frames) {
      if(frame.id!==root.id && securityWidgetFrame(frame.url)) {results.push({frameId:frame.id,status:'ignored_security_widget'});continue;}
      if (!supportsCurrentPage(frame.url, workspaceOrigin) ||
          frame.id !== root.id && frame.url.startsWith('http:') && new URL(frame.url).origin !== new URL(root.url).origin) {
        let empty=false;
        if(frame.id!==root.id && (!frame.url || frame.url==='about:blank')) {
          try {checkDeadline();empty=await emptyHiddenFrame(send,frame);}catch {empty=false;}
        }
        results.push({frameId:frame.id,status:empty?'ignored_empty_frame':'unavailable'});continue;
      }
      try {
        checkDeadline();
        const {executionContextId} = await send('Page.createIsolatedWorld',{frameId:frame.id,worldName:pageFillWorld});
        const latest = await send('Page.getFrameTree');
        if (await documentKey(framesIn(latest.frameTree)) !== binding) throw new Error('The page changed during this action.');
        checkDeadline();
        if (operation === 'fill' && params.resume && frame.id === root.id) {
          const admission=await send('Runtime.callFunctionOn',{executionContextId,returnByValue:true,
            functionDeclaration:`function() { return ${interruption}(${observeCurrentDocument},'fill',true) ?? null; }`});
          if(admission.exceptionDetails)throw new Error('This frame could not complete the page action. Inspect the draft before retrying.');
          if (admission.result?.value) {
            results.push({frameId:frame.id,...admission.result.value});
            break;
          }
          await proveBambooResumeInput(send,tabId,frame,executionContextId,binding,checkDeadline,expiresAt);
        }
        const response = await send('Runtime.callFunctionOn', {
          executionContextId,
          functionDeclaration: `async function(input) { const observe=(${observePageSource}); const observation=observe(input.expectedUrl); const blocked=${interruption}(observation,input.action,true); if (blocked) return blocked; globalThis.__huntC3ChoiceWidget=(${inspectChoiceWidget.toString()}); (${annotateQuestionContext.toString()})(); if (input.action==='fill' && input.resume) await (${proveJobviteResumeInput.toString()})(input);
            const result=await (${pageFillSource})(input);
            if ((input.action==='status' || observation.screeningSubmissionControl) && location.href!==input.expectedUrl) throw new Error('The inspected frame changed.');
            if (result.componentFailure?.component==='page_state') return {observation,...result};
            const current=observation.screeningSubmissionControl?observe(input.expectedUrl):observation;
            if (current.screeningSubmissionControl==='disabled') {
              if (input.action==='status' || input.action==='fill' && !input.matchingRunId) result.incomplete=true;
              (result.skipped??=[]).push({label:'Application',reason:'employer_submission_disabled'});
            }
            return {observation:current,...result}; }`,
          arguments: [{value:{action:operation === 'inspect' ? 'status' : useProfileCountry ? 'fill' : operation,
            useProfileCountry,aiConsentDecision:params.aiConsentDecision,facts:params.facts ?? (frame.id===root.id ? params.profileCountryFacts : undefined) ?? [],
            currentProfileCountry:frame.id===root.id && params.profileCountryFacts ? params.profileCountryFacts.find(fact=>fact.factId==='country')?.value ?? null : undefined,
            matchingPlans:operation==='fill'?params.matchingPlans?.filter(plan=>plan.frameId===frame.id):undefined,matchingRunId:params.matchingRunId,pageHandoff:params.pageHandoff,resume:operation === 'fill' && frame.id === root.id ? params.resume : undefined,scope:'page',allowProfileForms:new URL(frame.url).origin===new URL(root.url).origin,expectedUrl:frame.url,expiresAt}}],
          awaitPromise:true,returnByValue:true,
        });
        if (response.exceptionDetails || !response.result?.value) throw new Error('The page action failed. Inspect the draft before retrying.');
        results.push({frameId:frame.id,status:'complete',...response.result.value});
        if(frame.id===root.id && (response.result.value.frameScope==='document' || response.result.value.componentFailure?.component==='page_state'))break;
      } catch (error) {
        results.push({frameId:frame.id,status:'unavailable',error:pageErrors.has(error.message) ? error.message : 'This frame could not complete the page action. Inspect the draft before retrying.'});
        if (frame.id === root.id) break;
      }
    }
    const completed = results.filter(result => !['unavailable','ignored_security_widget','ignored_empty_frame'].includes(result.status));
    if (!completed.length) throw new Error(results[0]?.error || 'This page could not be read. Inspect the application before retrying.');
    const observation = completed.find(result=>result.frameId===root.id)?.observation;
    const componentFailure = completed.find(result => result.componentFailure)?.componentFailure;
    const attachment = completed.find(result=>result.frameId === root.id);
    const resume = attachment?.resume;
    const resumeEvidence = attachment?.resumeEvidence;
    const rootResult = operation === 'inspect' && completed.find(result=>result.frameId===root.id);
    const jobviteFirstStep = Boolean(rootResult && rootResult.jobviteFirstStep);
    const smartRecruitersFirstStep = Boolean(rootResult && rootResult.smartRecruitersFirstStep);
    const smartRecruitersScreening = Boolean(rootResult && rootResult.smartRecruitersScreening);
    return {tabId,url:expectedUrl,documentId:binding,operation,...(observation?{observation}:{}),
      ...((jobviteFirstStep || smartRecruitersFirstStep || smartRecruitersScreening) && root.loaderId ? {jobviteFirstStep,smartRecruitersFirstStep,smartRecruitersScreening,mainDocumentId:root.loaderId} : {}),
      ...(componentFailure ? {componentFailure} : {}),
      profileCountryConflict:attachment?.profileCountryConflict === true,
      ...(['verified','missing','unverified','optional'].includes(resume) ? {resume} : {}),
      ...(resume === 'verified' && ['picker','filename','earlier_filename'].includes(resumeEvidence) ? {resumeEvidence} : {}),
      incomplete:results.some(result=>result.status==='unavailable' || result.incomplete===true),
      matching:completed.flatMap(result=>(result.matching??[]).map(row=>({...row,frameId:result.frameId}))),
      ...(operation==='inspect'?{navigationDiagnostics:completed.filter(result=>result.navigationDiagnostics).map(result=>({frameId:result.frameId,...result.navigationDiagnostics}))}:{}),
      filled:completed.flatMap(result=>result.filled || []),skipped:completed.flatMap(result=>(result.skipped || []).map(row=>row.fieldId?{...row,frameId:result.frameId}:row)),
      requiredIssues:completed.flatMap(result=>(result.requiredIssues || []).map(issue=>({...issue,frameId:result.frameId}))),
      canUndo:completed.some(result=>result.canUndo),canRedo:completed.some(result=>result.canRedo),
      frames:results.map(({frameId,status,error})=>({frameId,status,...(error?{error}: {})}))};
  } catch (error) {
    if (!owned && operation === 'inspect' && params.reportProtectedAttachment === true &&
        error.message === 'Cannot access a chrome-extension:// URL of different extension') throw new Error('debugger_protected_extension');
    if (pageErrors.has(error.message)) throw error;
    throw new Error('C3 could not access the selected tab. Inspect the draft before retrying.');
  } finally {
    let cleanupFailed=false;
    await restoreViewport().catch(()=>{cleanupFailed=true;});
    if (owned) await chrome.debugger.detach({tabId}).catch(()=>{});
    pageActionTabs.delete(tabId);
    if(cleanupFailed)throw new Error(viewportCleanupPending);
  }
}
