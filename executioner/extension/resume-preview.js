// Keep the PDF's object URL alive in this tab after Chrome closes the action popup.
const params = new URLSearchParams(location.hash.slice(1));
const status = document.getElementById('preview-status');
try {
  const tabId = Number(params.get('tabId'));
  const workflow = params.get('workflow');
  const sha256 = params.get('sha256') || '';
  const currentPageJobId = params.get('currentPageJobId');
  if (!Number.isSafeInteger(tabId) || tabId < 1 || !['currentPage', 'queued'].includes(workflow) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Open this résumé from the Hunt popup.');
  }
  const tab = await chrome.tabs.get(tabId);
  const {token} = await chrome.storage.local.get('token');
  if (!token) throw new Error('Connect to Hunt, then open the résumé again.');
  const service = chrome.runtime.getManifest().host_permissions.find(pattern => pattern.startsWith('http://127.0.0.1:'));
  const response = await fetch(new URL('/browser/page-resume', service), {
    method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify({tabId, expectedUrl: tab.url, workflow, sha256, ...(workflow === 'currentPage' && currentPageJobId && {currentPageJobId})}), signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Open the selected résumé again from Hunt.');
  if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/pdf') throw new Error('The selected file is unavailable.');
  const blob = await response.blob();
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== sha256) throw new Error('The selected résumé changed. Open it again from Hunt.');
  const frame = document.getElementById('pdf');
  frame.src = URL.createObjectURL(blob);
  frame.hidden = false;
  status.hidden = true;
} catch (error) {
  status.textContent = error.message || 'The résumé could not be opened.';
}
