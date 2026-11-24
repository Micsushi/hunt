// Local full-menu tabs inherit their session's pairing key when opened.
window.opener = null;
const status = document.getElementById('preview-status');
const library = document.getElementById('library');
const digest = new URLSearchParams(location.search).get('pdf');
try {
  const extension = location.protocol === 'chrome-extension:';
  const token = extension ? (await chrome.storage.local.get('token')).token : sessionStorage.getItem('c3-token');
  if (!token) throw new Error('Connect to Hunt and open the resume again.');
  const origin = extension ? chrome.runtime.getManifest().host_permissions.find(url => url.startsWith('http://127.0.0.1:')) : location.origin;
  async function read(path) {
    const response = await fetch(new URL(path, origin), {
      headers: {Authorization: 'Bearer '+token}, signal: AbortSignal.timeout(15000), redirect: 'error'
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Reconnect to Hunt and try again.' : 'The saved resume is unavailable. Reopen Hunt to check the selection.');
    return response;
  }
  const resumes = await (await read('/resumes')).json();
  for (const resume of resumes) {
    const link = document.createElement('a');
    link.href = '?pdf='+resume.sha256;
    link.textContent = resume.version ? resume.name+' · '+resume.version : resume.name;
    if (resume.sha256 === digest) {
      link.setAttribute('aria-current','page');
      document.title = link.textContent+' · Hunt C3';
      library.querySelector('summary').textContent = 'Viewing '+link.textContent+' · Browse saved resumes';
    }
    const item = document.createElement('li');
    item.append(link);
    document.getElementById('files').append(item);
  }
  library.hidden = !resumes.length;
  library.open = !digest;
  if (digest) {
    if (!resumes.some(resume => resume.sha256 === digest)) throw new Error('This PDF is no longer available. Choose another saved resume.');
    const response = await read('/resumes/'+digest);
    const blob = await response.blob();
    const hash = await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    const actual = Array.from(new Uint8Array(hash),byte => byte.toString(16).padStart(2,'0')).join('');
    if (blob.type !== 'application/pdf' || actual !== digest) throw new Error('The file differs from the selected PDF. Reopen Hunt to check it.');
    const frame = document.getElementById('pdf');
    frame.src = URL.createObjectURL(blob);
    frame.hidden = false;
  }
  status.hidden = resumes.length > 0;
  if (!resumes.length) status.textContent = 'No saved resumes.';
} catch (error) {
  status.textContent = error.message || 'The resume could not be opened.';
}
