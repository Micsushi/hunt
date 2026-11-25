import { listPageTabs, pageAction, pageActionTabs } from './page-actions.js';
import { workdayAccountCommand } from './workday-account.js';
const accountSessions = new Map();
const instanceId = crypto.randomUUID();
let reloadPending = false;
import { registerWebsiteHandoff } from './website-handoff.js';
import { preparePageViewport, viewportOwnership, viewportCleanupPending } from './page-viewport.js';
import { createCurrentPageFill } from './current-page-fill.js';
import { reconcileFieldReview, saveFillReview, showPageReview } from './fill-review-result.js';
const origin = 'http://127.0.0.1:47831';
let socket, heartbeat, socketToken, reconnect;
const popupPageRequests=new Map();
const currentPageFill=createCurrentPageFill(origin,()=>!reloadPending && socket?.readyState===WebSocket.OPEN,async tabId=>{
  const pending=popupPageRequests.get(tabId);
  if(!pending)return;
  if(pending.operation!=='inspect')throw new Error('A page action is already in progress.');
  await pending.request;
});
const attached = new Map();
const browserVersion = () => `${navigator.brave ? 'Brave' : 'Chrome'}/${navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] || 'unknown'}`;
const retryTabs = new Map();
const attachmentChanges = new Set();
let cleanup = Promise.resolve();
function supported(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && (/^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(u.hostname) || ['job-boards.greenhouse.io','boards.greenhouse.io','job-boards.eu.greenhouse.io','jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com','apply.workable.com'].includes(u.hostname)); }
  catch { return false; }
}
function exactGenericUrl(value) {
  try { const url=new URL(value); if(url.protocol!=='https:'||url.username||url.password||url.port)return null;url.hash='';return url.href; }
  catch { return null; }
}
function send(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
async function connect() {
  clearTimeout(reconnect);
  const { token } = await chrome.storage.local.get('token');
  if (!token) return;
  await cleanup;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    if (socketToken === token) return;
    socket.close();
  }
  if (socket?.readyState === WebSocket.CLOSING) {
    await new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    return connect();
  }
  const connection = socket = new WebSocket(`${origin.replace('http:', 'ws:')}/extension?token=${encodeURIComponent(token)}`);
  socketToken = token;
  connection.onopen = () => { clearInterval(heartbeat); heartbeat = setInterval(() => send({ method: 'ping' }), 20_000); };
  connection.onclose = () => {
    if (socket !== connection) return;
    clearInterval(heartbeat);
    for (const [tabId, owner] of accountSessions) if (owner.connection === connection) { accountSessions.delete(tabId); pageActionTabs.delete(tabId); }
    // An attach may still be awaiting Chrome when the socket closes.
    cleanup = Promise.allSettled([...attachmentChanges]).then(async () => {
      await Promise.all([...attached].filter(([, owner]) => owner.connection === connection).map(async ([tabId, owner]) => {
        if (attached.get(tabId) === owner) attached.delete(tabId);
        await owner.restoreViewport?.().catch(() => {});
        await chrome.debugger.detach({ tabId }).catch(() => {});
      }));
    });
    reconnect = setTimeout(() => { void connect(); }, 2000);
  };
  connection.onmessage = async event => {
    let message;
    try { message = JSON.parse(event.data); } catch { connection.close(); return; }
    const reply = value => { if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(value)); };
    try { reply({ id: message.id, result: await command(message.method, message.params, connection) }); }
    catch (error) { reply({ id: message.id, error: { message: error.message } }); }
  };
}
function command(method, params, connection = socket) {
  const task = executeCommand(method, params, connection);
  if (method === 'attach' || method === 'detach') {
    attachmentChanges.add(task);
    task.then(() => attachmentChanges.delete(task), () => attachmentChanges.delete(task));
  }
  return task;
}
async function executeCommand(method, params, connection) {
  let tabId = params.tabId;
  if (method === 'agentStatus') return {version:chrome.runtime.getManifest().version,browser:browserVersion(),extensionId:chrome.runtime.id,instanceId,reloadPending,capabilities:['pageAction-v1','pageAction-v2','selected-page-handoff-v1','question-matching-v1','consent-redo-v1','profile-country-v1','website-handoff-v1','generic-attach-v1','workday-account-v1','workday-create-account-v1','workday-account-fill-v1','workday-page-v1','self-reload-v1']};
  if (reloadPending) throw new Error('Hunt is reloading. Wait for it to reconnect.');
  if (method === 'reloadExtension') {
    if (connection !== socket || connection.readyState !== WebSocket.OPEN || attached.size || accountSessions.size || pageActionTabs.size || attachmentChanges.size || currentPageFill.busy()) throw new Error('Pause active C3 operations before reloading the extension.');
    reloadPending = true;
    // Acknowledge first; Chrome then reloads only this extension from its installed folder.
    setTimeout(() => chrome.runtime.reload(), 250);
    return {accepted:true,instanceId};
  }
  if (method === 'workdayAccount') return workdayAccountCommand(chrome, accountSessions, attached, pageActionTabs, params, connection);
  if (method === 'browserDiagnostics') return (await chrome.debugger.getTargets()).map(target=>{
    let extensionOrigin;
    try { const url=new URL(target.url);if(url.protocol==='chrome-extension:' && /^[a-p]{32}$/.test(url.hostname))extensionOrigin=`chrome-extension://${url.hostname}`; } catch {}
    return {targetId:target.id,type:['page','background_page','worker','service_worker'].includes(target.type)?target.type:'other',
      attached:target.attached===true,...(Number.isSafeInteger(target.tabId)?{tabId:target.tabId}:{}),...(extensionOrigin?{extensionOrigin}:{})};
  });
  if (method === 'pageTabs') return listPageTabs(origin);
  if (method === 'pageAction') return pageAction(params, attached, origin);
  if (method === 'version') return { protocolVersion: '1.3', product: navigator.userAgent.match(/(?:Chrome|Chromium)\/[\d.]+/)?.[0] || 'Chrome/125.0.0.0', revision: 'c3', userAgent: navigator.userAgent, jsVersion: 'V8' };
  if (method === 'focus') {
    const tab = await chrome.tabs.get(tabId);
    const genericUrl=params.generic===true?exactGenericUrl(params.url):null;
    if (params.generic===true ? !genericUrl || exactGenericUrl(tab.url)!==genericUrl : !supported(tab.url)) throw new Error('This tab no longer shows the selected application.');
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }); return {};
  }
  if (method === 'attach') {
    if (pageActionTabs.has(tabId)) throw new Error('C3 is already operating this tab.');
    if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Browser connection closed during attachment. Retry this job.');
    // Only the authenticated service can admit a generic target. Bind its exact document.
    const genericUrl=params.generic===true?exactGenericUrl(params.url):null;
    if (params.generic===true?!genericUrl:!supported(params.url)) throw new Error('Use a supported job posting link.');
    const matches=value=>genericUrl?exactGenericUrl(value)===genericUrl:supported(value)&&new URL(value).hostname===new URL(params.url).hostname;
    // Report only the identity of a newly opened tab. Redirects still need service verification before attachment.
    const reportRedirect = genericUrl && !tabId && !params.existingOnly && params.reportRedirect === true;
    const loadable = value => matches(value) || reportRedirect && exactGenericUrl(value) && new URL(value).origin === new URL(genericUrl).origin;
    if (!tabId && !params.existingOnly) tabId = retryTabs.get(params.url);
    let tab, created = false;
    if (tabId) {
      try { tab = await chrome.tabs.get(tabId); }
      catch (error) { if (params.existingOnly || !/No tab with id/i.test(error.message)) throw error; }
    }
    if (!tab && params.existingOnly) throw new Error('The review tab is closed. Retry this job to inspect its saved draft.');
    if (!tab) {
      tab = await chrome.tabs.create({ url: params.url, active: false });
      created = true;
      // Keep failed opens recoverable without closing a tab the user may inspect.
      retryTabs.set(params.url, tab.id);
    }
    if (!loadable(tab.url || tab.pendingUrl)) throw new Error('The selected tab does not match this job.');
    tabId = tab.id;
    const waking = tab.discarded;
    if (waking) await chrome.tabs.reload(tabId);
    const deadline = Date.now() + 30_000;
    if (waking) tab = await chrome.tabs.get(tabId);
    const ready = () => loadable(tab.url) && (!(waking || created || reportRedirect) || !tab.discarded && tab.status === 'complete' && !tab.pendingUrl);
    while (!ready() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      tab = await chrome.tabs.get(tabId);
    }
    if (!ready()) throw new Error('The job page did not load. Retry when the site is available.');
    if (!matches(tab.url)) return {redirectedTabId:tabId};
    if (attached.has(tabId)) throw new Error('This tab is already running.');
    if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Browser connection closed during attachment. Retry this job.');
    await chrome.debugger.attach({ tabId }, '1.3');
    let restoreViewport = async () => {};
    try {
      const target = (await chrome.debugger.getTargets()).find(t => t.tabId === tabId);
      if (!target || connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Browser connection closed during attachment. Retry this job.');
      const viewportOwner=viewportOwnership(target.id);
      restoreViewport = await preparePageViewport((method,values={})=>chrome.debugger.sendCommand({tabId},method,values),viewportOwner);
      if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Browser connection closed during attachment. Retry this job.');
      const documentId=genericUrl?(await chrome.debugger.sendCommand({tabId},'Page.getFrameTree')).frameTree?.frame?.loaderId:undefined;
      if(genericUrl&&!documentId)throw new Error('The application document could not be verified.');
      if(params.selectedDocument && (!params.existingOnly || !genericUrl || documentId!==params.selectedDocument)) throw new Error('The selected application document changed. Inspect it again.');
      let screening;
      if (genericUrl) {
        const url = new URL(genericUrl);
        const base = url.pathname.match(/^\/oneclick-ui\/company\/([\w-]+)\/publication\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/i);
        if (url.origin==='https://jobs.smartrecruiters.com' && base && url.searchParams.getAll('dcr_ci').every(company=>company===base[1])) {
          url.pathname=url.pathname.replace(/\/$/,'')+'/screening';
          screening={url:url.href,binding:crypto.randomUUID(),expires:0};
        }
      }
      attached.set(tabId, { targetId: target.id, host: new URL(params.url).hostname, genericUrl, documentId, connection, restoreViewport, viewportOwner, screening });
      return { tabId, targetId: target.id, ...(screening && {screeningBinding:screening.binding}), ...(params.selectedDocument && {selectedDocument:documentId}) };
    } catch (error) {
      let cleanupFailed=false;
      await restoreViewport().catch(() => {cleanupFailed=true;});
      await chrome.debugger.detach({ tabId }).catch(() => {});
      if(cleanupFailed)throw new Error(viewportCleanupPending);
      throw error;
    }
  }
  const owned = attached.get(tabId);
  if (!owned) throw new Error('This tab is not attached to C3.');
  if (method === 'detach') {
    attached.delete(tabId);let cleanupFailed=false;
    await owned.restoreViewport?.().catch(() => {cleanupFailed=true;});
    try { await chrome.debugger.detach({ tabId }); }
    catch(error) { if(!cleanupFailed)throw error; }
    if(cleanupFailed)throw new Error(viewportCleanupPending);
    return {};
  }
  let tab = await chrome.tabs.get(tabId);
  if (owned.genericUrl) {
    const transition=owned.screening;
    const granting=method==='screeningTransition';
    if (granting && (!transition?.binding || params.binding!==transition.binding || params.url!==owned.genericUrl)) {
      throw new Error('The screening transition does not belong to this application.');
    }
    let url, frameUrl, retries=0;
    while (true) {
      const frame=(await chrome.debugger.sendCommand({tabId},'Page.getFrameTree')).frameTree?.frame;
      if (frame?.loaderId!==owned.documentId || attached.get(tabId)!==owned || owned.connection!==connection) throw new Error('The application document changed. Inspect it before retrying.');
      url=exactGenericUrl(tab.url);
      frameUrl=exactGenericUrl(frame.url);
      if (!granting && !(transition?.expires>Date.now())) {
        if (transition?.expires && url!==frameUrl) throw new Error('The application document changed. Inspect it before retrying.');
        break;
      }
      if (![owned.genericUrl,transition.url].includes(url) || ![owned.genericUrl,transition.url].includes(frameUrl)) {
        throw new Error('The screening transition left the verified application route.');
      }
      if (url===frameUrl) break;
      // Chrome's tab and debugger APIs can publish a same-document route change at different times.
      if (retries++ === 12) throw new Error('The screening route did not settle in the selected tab.');
      await new Promise(resolve=>setTimeout(resolve,25));
      tab=await chrome.tabs.get(tabId);
    }
    if (granting) {
      transition.binding=null;
      transition.expires=Date.now()+4000;
    }
    if (url!==owned.genericUrl) {
      if (!transition?.expires || Date.now()>transition.expires || url!==transition.url || frameUrl!==url) {
        throw new Error('The application document changed. Inspect it before retrying.');
      }
      owned.genericUrl=url;
      delete owned.screening;
    }
    if (granting) return {screening:url===transition.url,resampled:retries>0};
    if(method==='cdp'&&['Page.navigate','Page.reload','Page.navigateToHistoryEntry'].includes(params.method))throw new Error('Unfamiliar applications must stay on the current page.');
  } else if (!supported(tab.url) || new URL(tab.url).hostname !== owned.host) throw new Error('The selected tab left its supported job site.');
  if (method === 'info') return { targetId: owned.targetId, browserContextId: 'c3-default', type: 'page', title: tab.title || '', url: tab.url, attached: true, canAccessOpener: false };
  if (method === 'cdp') {
    if (params.method === 'Page.navigate' && (!supported(params.params.url) || new URL(params.params.url).hostname !== owned.host)) throw new Error('Navigation outside the selected employer is blocked.');
    return await chrome.debugger.sendCommand({ tabId, ...(params.sessionId ? { sessionId: params.sessionId } : {}) }, params.method, params.params) || {};
  }
  throw new Error('Unknown C3 command.');
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (attached.get(source.tabId)?.connection === socket) send({ method: 'event', params: { tabId: source.tabId, sessionId: source.sessionId, method, params } });
});
chrome.debugger.onDetach.addListener(async (source, reason) => {
  const owner = attached.get(source.tabId);
  if (!owner) return;
  // A delayed old detach event must not invalidate a newly attached session.
  const targets = await chrome.debugger.getTargets().catch(() => null);
  if (!targets || attached.get(source.tabId) !== owner || targets.some(target => target.tabId === source.tabId && target.attached)) return;
  attached.delete(source.tabId);
  if (owner.connection === socket) send({ method: 'detached', params: { tabId: source.tabId, reason:['target_closed','canceled_by_user'].includes(reason)?reason:'unspecified_or_other', viewportCleanupPending:await owner.viewportOwner?.has().catch(()=>false)===true } });
});
chrome.tabs.onRemoved?.addListener(tabId => {
  void chrome.storage.session.remove('employerDocument:'+tabId).catch(()=>{});
  for (const [url, id] of retryTabs) if (id === tabId) retryTabs.delete(url);
});
// A native action popup disappears on blur. Its port closes with the view,
// letting the employer-page controls reappear without timers.
const toolbarPorts=new Map();
chrome.runtime.onConnect?.addListener(port=>{
  if(port.name!=='current-page-toolbar' || port.sender?.id!==chrome.runtime.id || port.sender.url!==chrome.runtime.getURL('popup.html'))return;
  let selected;
  const presence=open=>{
    if(selected)void chrome.tabs.sendMessage(selected.tabId,{action:'toolbarPresence',expectedUrl:selected.url,open},{frameId:0}).catch(()=>{});
  };
  port.onMessage.addListener(message=>{
    if(selected || !Number.isSafeInteger(message.tabId) || !exactGenericUrl(message.url))return;
    selected=message;toolbarPorts.set(selected.tabId,port);presence(true);
  });
  port.onDisconnect.addListener(()=>{
    if(selected && toolbarPorts.get(selected.tabId)===port){
      toolbarPorts.delete(selected.tabId);presence(false);
    }
  });
});
async function revealReviewedField(tabId,expectedUrl,documentId,target) {
  const reveal=()=>pageAction({operation:'reveal',tabId,expectedUrl,documentId,
    frameId:target.frameId,fieldId:target.fieldId},attached,origin);
  try {await reveal();return;} catch {
    const fresh=await pageAction({operation:'inspect',tabId,expectedUrl},attached,origin);
    if(fresh.documentId!==documentId)throw new Error('Review expired.');
    const sameField=row=>row.frameId===target.frameId && row.fieldId===target.fieldId;
    if(!fresh.requiredIssues?.some(sameField) && !fresh.matching?.some(row=>row.canReveal && sameField(row)))
      throw new Error('Field unavailable.');
    await reveal();
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.action === 'ownFillDocumentId' && sender.frameId===0 && sender.tab?.id) {
    respond(sender.documentId);return;
  }
  if (message.action === 'fillFromInvitation') {
    // The isolated script admits a trusted click. The sender, never page
    // arguments, determines the tab, top-level document and destination.
    if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !sender.documentId ||
        !exactGenericUrl(sender.url) || !exactGenericUrl(message.expectedUrl) ||
        new URL(sender.url).origin!==new URL(message.expectedUrl).origin) {
      respond({ok:false,error:'Hunt could not identify the application in this tab.'});return;
    }
    if(reloadPending){respond({ok:false,error:'Hunt is reloading. Try again in a moment.'});return;}
    const {hostname} = new URL(sender.url);
    const hosts = chrome.runtime.getManifest().content_scripts.find(script => script.js.includes('ats-invitation.js')).matches;
    if (!hosts.some(pattern => {
      const host = pattern.slice('https://'.length, -2);
      return host.startsWith('*.') ? hostname.endsWith(host.slice(1)) : hostname === host;
    })) return;
    // On same-document navigation Chrome can retain the sender's original URL.
    // start checks the active tab's live URL and challenges this exact document at that URL.
    currentPageFill.start({tabId:sender.tab.id,url:message.expectedUrl,callerDocumentId:sender.documentId,manual:false})
      .then(respond,error=>respond({ok:false,error:error.message}));
    return true;
  }
  if (message.action === 'startCurrentPageFill' && sender.url === chrome.runtime.getURL('popup.html')) {
    if(reloadPending || !/^[a-f0-9]{64}$/.test(message.expectedResumeSha256)){
      respond({ok:false,error:'Check the selected resume and reconnect Hunt before filling.'});return;
    }
    currentPageFill.start({tabId:message.tabId,url:message.expectedUrl,expectedDocument:message.documentId,
      expectedResume:message.expectedResumeSha256,manual:true}).then(respond,error=>respond({ok:false,error:error.message}));
    return true;
  }
  if (message.action === 'connectionStatus' && sender.url === chrome.runtime.getURL('popup.html')) {
    respond({connected:socket?.readyState === WebSocket.OPEN,version:chrome.runtime.getManifest().version,browser:browserVersion()}); return;
  }
  if (message.action === 'pageAction' && sender.url === chrome.runtime.getURL('popup.html')) {
    if(currentPageFill.busy(message.tabId) || popupPageRequests.has(message.tabId)){
      respond({ok:false,error:'Hunt is working on this page. Wait for it to finish.'});return;
    }
    const expiresAt = Math.min(Date.now()+12000,Number.isFinite(message.expiresAt) ? message.expiresAt : Infinity);
    const request=(async()=>{
      const {token} = await chrome.storage.local.get('token');
      if(Date.now()>=expiresAt)throw new Error('The page action expired. Inspect the draft before retrying.');
      // The service validates live profile mode and queued resume ownership for every entry point.
      const response=await fetch(origin+'/browser/page',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(token||'')},body:JSON.stringify({operation:message.operation,tabId:message.tabId,expectedUrl:message.expectedUrl,documentId:message.documentId,expectedResumeSha256:message.expectedResumeSha256,currentPageJobId:message.currentPageJobId,...(message.resumeSha256?{resumeSha256:message.resumeSha256}:{}),expiresAt}),signal:AbortSignal.timeout(Math.max(1,expiresAt-Date.now())),redirect:'error'});
      const result=await response.json();
      if(!response.ok)throw new Error(response.status===404?'Update the local C3 app before filling this page.':typeof result?.error==='string'?result.error:'C3 could not confirm this page action. Inspect the draft before retrying.');
      return result;
    })();
    popupPageRequests.set(message.tabId,{operation:message.operation,request});
    request.then(result=>respond({ok:true,result}),error=>respond({ok:false,error:error.message}))
      .finally(()=>popupPageRequests.delete(message.tabId));
    return true;
  }
  if (message.action === 'revealIssue' && sender.url === chrome.runtime.getURL('popup.html')) {
    const {tabId,expectedUrl,documentId,frameId,fieldId}=message;
    revealReviewedField(tabId,expectedUrl,documentId,{frameId,fieldId})
      .then(()=>respond({ok:true})).catch(error=>respond({ok:false,error:error.message}));
    return true;
  }
  if (message.action === 'fieldReview' && sender.frameId === 0 && sender.tab?.id && sender.documentId) {
    (async()=>{
      const tabId=sender.tab.id, key='fillReview:'+tabId;
      const review=(await chrome.storage.session.get(key))[key];
      if(!review?.token || message.token!==review.token)throw new Error('Review expired.');
      const tab=await chrome.tabs.get(tabId), url=message.expectedUrl;
      if(tab.url!==url || tab.pendingUrl || new URL(sender.url).origin!==new URL(url).origin ||
          review.browserDocumentId && review.browserDocumentId!==sender.documentId)throw new Error('Review expired.');
      if(message.command==='refresh'){
        if(!tab.active || reloadPending || currentPageFill.busy(tabId) || popupPageRequests.has(tabId))throw new Error('Review unavailable.');
        const result=await pageAction({operation:'inspect',tabId,expectedUrl:url},attached,origin);
        if(result.documentId!==review.documentId)throw new Error('Review expired.');
        const latest=(await chrome.storage.session.get(key))[key];
        if(latest?.token!==review.token)return;
        const next=reconcileFieldReview(latest.issues,latest.index,result);
        // Compare display data only. Fresh inspection targets also contain
        // diagnostics that are intentionally absent from the saved view.
        const sameDisplay=(a,b)=>a.label===b.label && a.message===b.message && !!a.country===!!b.country &&
          a.target?.fieldId===b.target?.fieldId && a.target?.frameId===b.target?.frameId && a.target?.section===b.target?.section;
        if(next.issues.length===latest.issues.length && next.issues.every((item,i)=>sameDisplay(item,latest.issues[i])))return;
        const saved=await saveFillReview(tabId,review.page,review.documentId,next.issues,next.index,{
          browserDocumentId:sender.documentId,phase:next.issues.length?'review':'done',liveUpdate:true,
          summary:next.issues.length?'':'All flagged fields resolved.'});
        await showPageReview(tabId,url,saved,sender.documentId);
        return;
      }
      if(message.command==='close'){await chrome.storage.session.remove(key);return;}
      if(message.command==='step' && Number.isInteger(message.index) && message.index>=0 && message.index<review.targets.length){
        await chrome.storage.session.set({[key]:{...review,index:message.index}});
        return;
      }
      const target=Number.isSafeInteger(message.index) && review.targets?.[message.index];
      if(message.command!=='show' || !target)throw new Error('Field unavailable.');
      await revealReviewedField(tabId,url,review.documentId,target);
    })().then(()=>respond({ok:true})).catch(error=>respond({ok:false,expired:error.message==='Review expired.'}));
    return true;
  }
  if (message.action === 'connect') { connect().then(() => respond({ ok: true })).catch(() => respond({ ok: false, error: 'Could not connect to C3.' })); return true; }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled?.addListener(connect);
registerWebsiteHandoff(chrome, () => socket?.readyState === WebSocket.OPEN);
void connect();
