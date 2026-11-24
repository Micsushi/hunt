/** A user-selected form may be on a custom HTTPS port or a local development server. */
export function supportsCurrentPage(value, workspaceOrigin = 'http://127.0.0.1:47831') {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname) && /^\d+(?:\.\d+){3}$/.test(url.hostname);
    return url.protocol === 'http:' && loopback && url.port !== '47831' && url.port !== new URL(workspaceOrigin).port;
  } catch {
    return false;
  }
}

const websiteOrigin = 'https://agent-hunt-review.mshi.ca';
const localOrigin = 'http://127.0.0.1:47831';
const protocol = 'hunt-c3-handoff-v1';

// This website bridge cannot read applicant details or run browser/account actions.
export function registerWebsiteHandoff(chrome, connected) {
  let importing = false;
  chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
    let trusted = false;
    try { trusted = !sender.id && sender.frameId === 0 && sender.origin === websiteOrigin && new URL(sender.url).origin === websiteOrigin; } catch { /* Malformed senders are not admitted. */ }
    if (!trusted || sender.documentLifecycle && sender.documentLifecycle !== 'active') return;
    if (message?.protocol !== protocol || !['status', 'preview', 'import'].includes(message.operation)) return;
    if (message.operation === 'import' && importing) { respond({ok: false, code: 'busy'}); return; }
    if (message.operation === 'import') importing = true;
    const deadline = Math.min(Date.now() + 20000, Number(message.expiresAt));
    const reply = async () => {
      if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('expired');
      const {token} = await chrome.storage.local.get('token');
      if (!token || !connected()) throw new Error('disconnected');
      const request = async (path, body) => {
        if (Date.now() >= deadline) throw new Error('expired');
        const response = await fetch(localOrigin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          redirect: 'error',
        });
        if (!response.ok) throw new Error(response.status === 404 ? 'update_required' : 'rejected');
        return response.json();
      };
      if (message.operation === 'status') {
        const state = await request('/agent/status');
        return {connected: connected() && state.connected === true, configured: state.configured === true};
      }
      if (!message.bundle || new TextEncoder().encode(JSON.stringify(message.bundle)).length > 32 * 1024 * 1024) throw new Error('rejected');
      const preview = await request('/handoff/preview', message.bundle);
      if (!Array.isArray(preview.jobs)) throw new Error('rejected');
      if (message.operation === 'preview') return {jobs: preview.jobs.map(job => ({sourceJobId: job.sourceJobId, resumeVersion: job.resumeVersion, status: job.status}))};
      // Never fall back to /handoff/import: older services would start filling.
      const jobs = await request('/handoff/import-paused', message.bundle);
      if (!Array.isArray(jobs) || jobs.some(job => job.status !== 'paused')) throw new Error('unconfirmed');
      // Keep the owner's current tab and any unsaved workspace edits in place.
      return {jobs: jobs.map(job => ({id: job.id, sourceJobId: job.sourceJobId, resumeVersion: job.resumeVersion, status: job.status})), workspaceOpened:false};
    };
    reply().then(result => respond({ok: true, result})).catch(error => {
      const code = ['expired','busy','disconnected','update_required','rejected','unconfirmed'].includes(error.message) ? error.message : 'unconfirmed';
      respond({ok: false, code});
    }).finally(() => { if (message.operation === 'import') importing = false; });
    return true;
  });
}
