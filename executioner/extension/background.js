const origin = 'http://127.0.0.1:47831';
let socket, heartbeat, socketToken, reconnect;
const attached = new Map();
const retryTabs = new Map();
const attachmentChanges = new Set();
let cleanup = Promise.resolve();
function supported(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && (/^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(u.hostname) || ['job-boards.greenhouse.io','boards.greenhouse.io','job-boards.eu.greenhouse.io','jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com','apply.workable.com'].includes(u.hostname)); }
  catch { return false; }
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
    // An attach may still be awaiting Chrome when the socket closes.
    cleanup = Promise.allSettled([...attachmentChanges]).then(async () => {
      await Promise.all([...attached].filter(([, owner]) => owner.connection === connection).map(async ([tabId, owner]) => {
        if (attached.get(tabId) === owner) attached.delete(tabId);
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
  if (method === 'version') return { protocolVersion: '1.3', product: navigator.userAgent.match(/(?:Chrome|Chromium)\/[\d.]+/)?.[0] || 'Chrome/125.0.0.0', revision: 'c3', userAgent: navigator.userAgent, jsVersion: 'V8' };
  if (method === 'focus') {
    const tab = await chrome.tabs.get(tabId);
    if (!supported(tab.url)) throw new Error('This tab no longer shows a supported application.');
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }); return {};
  }
  if (method === 'attach') {
    if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Browser connection closed during attachment. Retry this job.');
    if (!supported(params.url)) throw new Error('Use a supported job posting link.');
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
    if (!supported(tab.url || tab.pendingUrl) || new URL(tab.url || tab.pendingUrl).hostname !== new URL(params.url).hostname) throw new Error('The selected tab does not match this job.');
    tabId = tab.id;
    const waking = tab.discarded;
    if (waking) await chrome.tabs.reload(tabId);
    const deadline = Date.now() + 30_000;
    if (waking) tab = await chrome.tabs.get(tabId);
    while ((!supported(tab.url) || (waking || created) && (tab.discarded || tab.status !== 'complete')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      tab = await chrome.tabs.get(tabId);
    }
    if (!supported(tab.url) || (waking || created) && (tab.discarded || tab.status !== 'complete') || new URL(tab.url).hostname !== new URL(params.url).hostname) throw new Error('The job page did not load. Retry when the site is available.');
    if (attached.has(tabId)) throw new Error('This tab is already running.');
    if (connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Browser connection closed during attachment. Retry this job.');
    await chrome.debugger.attach({ tabId }, '1.3');
    try {
      const target = (await chrome.debugger.getTargets()).find(t => t.tabId === tabId);
      if (!target || connection !== socket || connection.readyState !== WebSocket.OPEN) throw new Error('Browser connection closed during attachment. Retry this job.');
      attached.set(tabId, { targetId: target.id, host: new URL(params.url).hostname, connection });
      return { tabId, targetId: target.id };
    } catch (error) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw error;
    }
  }
  const owned = attached.get(tabId);
  if (!owned) throw new Error('This tab is not attached to C3.');
  if (method === 'detach') { attached.delete(tabId); await chrome.debugger.detach({ tabId }); return {}; }
  const tab = await chrome.tabs.get(tabId);
  if (!supported(tab.url) || new URL(tab.url).hostname !== owned.host) throw new Error('The selected tab left its supported job site.');
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
chrome.debugger.onDetach.addListener(async source => {
  const owner = attached.get(source.tabId);
  if (!owner) return;
  // A delayed old detach event must not invalidate a newly attached session.
  const targets = await chrome.debugger.getTargets().catch(() => null);
  if (!targets || attached.get(source.tabId) !== owner || targets.some(target => target.tabId === source.tabId && target.attached)) return;
  attached.delete(source.tabId);
  if (owner.connection === socket) send({ method: 'detached', params: { tabId: source.tabId } });
});
chrome.tabs.onRemoved?.addListener(tabId => {
  for (const [url, id] of retryTabs) if (id === tabId) retryTabs.delete(url);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.action === 'connect') { connect().then(() => respond({ ok: true })).catch(() => respond({ ok: false, error: 'Could not connect to C3.' })); return true; }
});
chrome.runtime.onStartup.addListener(connect);
void connect();
