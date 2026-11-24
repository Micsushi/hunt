const $ = id => document.getElementById(id);
const proxied = location.pathname.startsWith('/api/c3/');
const base = proxied ? '/api/c3/' : '/';
$('browse-resumes').hidden = proxied;
if (proxied) { $('pair').hidden = true; $('handoff-entry').hidden = true; $('pairing-settings').hidden = true; }
const previousToken=sessionStorage.getItem('c3-token') ?? '';
let urlToken = new URLSearchParams(location.hash.slice(1)).get('token');
let token = urlToken ?? previousToken;
if (urlToken !== null) history.replaceState(null, '', location.pathname + location.search);
let state, busy = false, rendered = '', pendingSubmit, historyBusy = false, profileLoaded = false, polling = false, profileDirty = false;
let stateFresh = false, refreshSequence = 0, pendingJob;
let handoffBundle, handoffPaused = false, handoffFileVersion = 0;
let savedProfile, savedResumeUrl, accountStatus, accountDraft = false, metadataCheckedAt = 0, extensionId = '';
const jobErrors = new Map();
$('profile-form').addEventListener('input', updateProfileDraft);
$('account-form').addEventListener('input', () => { accountDraft = true; });
const viewCopy={profile:'Profile',applications:'Applications',settings:'Settings'};
const profileSections = [...document.querySelectorAll('.section-nav a')];
let sectionId = profileSections.find(link => link.hash === location.hash)?.hash.slice(1) || 'contact';
function showSection(id) {
  sectionId = id;
  for (const section of $('profile-form').querySelectorAll('.profile-section')) section.hidden = section.id !== id;
  for (const link of profileSections) {
    if (link.hash === '#'+id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
for (const link of profileSections) link.onclick = event => {
  event.preventDefault();
  if (location.hash !== link.hash) history.pushState(null, '', link.hash);
  showSection(link.hash.slice(1));
};
window.addEventListener('hashchange', () => {
  const link = profileSections.find(item => item.hash === location.hash);
  if (!link && location.hash) return;
  document.querySelector('[data-view="profile"]').click();
  showSection(link ? link.hash.slice(1) : 'contact');
});
$('profile-form').addEventListener('invalid', event => {
  const firstInvalid = $('profile-form').querySelector(':invalid[name]');
  if (event.target === firstInvalid) showSection(firstInvalid.closest('fieldset').id);
}, true);
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{
  for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==button.dataset.view;
  for(const tab of document.querySelectorAll('[data-view]')){if(tab===button)tab.setAttribute('aria-current','page');else tab.removeAttribute('aria-current');}
  $('page-title').textContent=viewCopy[button.dataset.view];
};
if(proxied)document.querySelector('[data-view="applications"]').click();
$('review-profile-answers').onclick=()=>{document.querySelector('[data-view="profile"]').click();showSection('contact');$('profile-form').querySelector('[name]').focus();};
$('concurrency').replaceChildren(...Array.from({length:30}, (_,i) => new Option(String(i+1), String(i+1))));
$('concurrency').disabled = true;
const undo = [], redo = [];
async function api(path, body) {
  if(body !== undefined && !stateFresh) throw new Error('Refresh progress before trying another action.');
  const signal = AbortSignal.timeout(body === undefined ? 15000 : 90000);
  let response, data;
  try {
    response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type':'application/json', ...(token ? { Authorization:'Bearer '+token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal });
    data = await response.json();
    if(!response.ok && response.status >= 500) throw new Error(data.error || data.detail || 'C3 could not confirm this action.');
  } catch(e) {
    if(body !== undefined) {
      stateFresh=false; refreshSequence++;
      $('connection').textContent='Progress needs refresh'; $('connection').dataset.connected='false';
      $('connection-error').hidden=false;
      $('connection-error').querySelector('p').textContent='The action was not confirmed. Refresh progress and check its result before retrying. It may still finish in C3.';
    }
    throw new Error(signal.aborted ? 'C3 did not respond in time. Refresh progress before retrying.' : e.message);
  }
  if (!proxied && response.status === 401) {
    if(urlToken !== null && token === urlToken && previousToken && previousToken !== token) {
      token=previousToken;urlToken=null;
      return api(path,body);
    }
    stateFresh=false; $('pair').hidden=false;
    throw new Error('This pairing key is no longer accepted. Enter the current key below, or reconnect Hunt C3 in the extension and choose Open full menu.');
  }
  if (!response.ok) throw new Error(data.error || data.detail || 'C3 is unavailable.');
  return data;
}
function error(value) { $('error').textContent = value || ''; $('error').hidden = !value; }
async function perform(action, jobId, label) {
  if (busy || historyBusy) return;
  busy = true; refreshSequence++; pendingJob = jobId ? { id:jobId, label } : undefined;
  if(jobId)jobErrors.delete(jobId);
  historyButtons(); renderJobs(); error(''); let confirmed = false;
  try { await action(); confirmed = true; await refresh(); }
  catch(e) {
    if(jobId) {
      jobErrors.set(jobId, { message:confirmed ? 'Action confirmed, but progress could not be refreshed. Reconnect to check its result.' : e.message, refreshOnly:confirmed });
      if(!confirmed) {
        stateFresh=false;
        $('connection').textContent='Progress needs refresh'; $('connection').dataset.connected='false';
        $('connection-error').hidden=false;
        $('connection-error').querySelector('p').textContent='Refresh progress before trying another action. The request may have reached C3 even though it returned an error.';
      }
    } else if($('connection-error').hidden)error(e.message);
  }
  finally { busy = false; pendingJob = undefined; historyButtons(); renderJobs(); }
}
function historyButtons() { $('repair-link').disabled=busy||historyBusy||!stateFresh||!!state?.storageError; $('undo').disabled = busy || historyBusy || !stateFresh || !undo.length; $('redo').disabled = busy || historyBusy || !stateFresh || !redo.length; $('retry-connection').disabled = busy || historyBusy; $('retry-profile').disabled = busy || historyBusy; $('check-account').disabled=busy||historyBusy||!stateFresh||!(accountStatus?.gmail?.configured||accountStatus?.gmail?.saved); $('check-connection').disabled=busy||historyBusy; $('connect-website').disabled=busy||historyBusy||!stateFresh||!state?.connected||!state?.configured||!extensionId; $('settings-connect').disabled=busy||historyBusy; $('refresh-profile').disabled=busy||historyBusy||!stateFresh; $('save-profile').disabled=busy||historyBusy||!profileLoaded||!stateFresh||!profileDirty; $('save-account').disabled=busy||historyBusy||!stateFresh; handoffControls(); }
function remember(entry) { undo.push(entry); if(undo.length > 20) undo.shift(); redo.length = 0; historyButtons(); }
async function reverse(from, to, direction) {
  if(busy || historyBusy || !stateFresh || !from.length) return;
  historyBusy = true; refreshSequence++; const active=document.activeElement; historyButtons(); renderJobs(); const entry = from.at(-1);
  try { await entry[direction](); from.pop(); to.push(entry); $('notice').textContent = direction === 'undo' ? 'Change undone' : 'Change restored'; await refresh(); }
  catch(e) { error(e.message); } finally { historyBusy = false; historyButtons(); renderJobs(); if(document.activeElement===active||document.activeElement===document.body)(from.length&&!$(direction).disabled ? $(direction) : document.querySelector('[data-view][aria-current]')).focus(); }
}
$('undo').onclick = () => reverse(undo, redo, 'undo'); $('redo').onclick = () => reverse(redo, undo, 'redo');
$('repair-link-form').onsubmit = event => {
  event.preventDefault();
  void perform(async () => {
    await api('repair-saved-link', {url:$('repair-link-url').value.trim()});
    $('repair-link-url').value=''; $('link-recovery').open=false;
    $('notice').textContent='Application link repaired.'; $('queue-title').focus();
  });
};
$('recover-storage').onclick = () => perform(() => api('recover-storage', {}));
$('retry-connection').onclick = $('retry-profile').onclick = () => perform(async () => {});
$('job-search').oninput = $('job-filter').onchange = () => renderJobs();
$('clear-filters').onclick = () => { $('job-search').value=''; $('job-filter').value='all'; renderJobs(); $('job-search').focus(); };
async function applyPairingKey(input) {
  const candidate = input.value.trim();
  const response = await fetch(base + 'state', { headers: { Authorization: 'Bearer ' + candidate }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Pairing key rejected. Your saved connection was kept.');
  const checked = await response.json();
  if (typeof checked.connected !== 'boolean' || typeof checked.configured !== 'boolean') throw new Error('C3 did not confirm the connection. Your saved connection was kept.');
  token = candidate; sessionStorage.setItem('c3-token', token); input.value = ''; await refresh();
  $('notice').textContent = 'Connection saved.';
}
$('pair').onsubmit = e => { e.preventDefault(); void perform(() => applyPairingKey($('token'))); };
$('settings-pair-form').onsubmit = e => { e.preventDefault(); void perform(() => applyPairingKey($('settings-token'))); };
$('batch').onsubmit = e => { e.preventDefault(); const submitted = $('links').value; void perform(async () => {
  const jobs = [...new Set(submitted.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))].map(url=>({url}));
  const added = await api('jobs', { jobs }); const existing=new Set(state.jobs.map(job=>job.id));const distinct=[...new Map(added.map(job=>[job.id,job])).values()];const reused=distinct.filter(job=>existing.has(job.id)).length; $('notice').textContent=`${distinct.length-reused} new applications · ${reused} already in your list${added.length===distinct.length?'':' · '+(added.length-distinct.length)+' duplicate links ignored'}`; if($('links').value === submitted) $('links').value = ''; $('links').focus();
}); };
function handoffControls() {
  $('preview-handoff').disabled=busy||historyBusy||!stateFresh||!$('handoff-file').files[0];
  $('import-handoff').disabled=busy||historyBusy||!stateFresh||!state?.configured||!handoffBundle;
  $('cancel-handoff').disabled=busy||historyBusy;
  if(handoffBundle)$('handoff-status').textContent=state?.configured?'':'Save your profile first, then return here to add these applications.';
}
$('handoff-entry').ontoggle=()=>{if($('handoff-entry').open)$('batch-entry').open=false;};
$('handoff-file').onchange=()=>{
  handoffFileVersion++;handoffBundle=undefined;$('handoff-preview').hidden=true;$('handoff-status').textContent='';$('handoff-status').setAttribute('role','status');handoffControls();
};
$('cancel-handoff').onclick=()=>{handoffBundle=undefined;$('handoff-preview').hidden=true;$('handoff-status').textContent='Preview cancelled.';handoffControls();$('preview-handoff').focus();};
$('preview-handoff').onclick=()=>{
  const file=$('handoff-file').files[0], version=handoffFileVersion;
  void perform(async()=>{
    handoffBundle=undefined;$('handoff-preview').hidden=true;$('handoff-status').textContent='Checking applications and PDFs…';$('handoff-status').setAttribute('role','status');
    try {
    if(!file||file.size>32*1024*1024)throw new Error('Choose a Hunt application file smaller than 32 MB.');
    let bundle;
    try{bundle=JSON.parse(await file.text());}catch{throw new Error('Choose a valid .hunt.json file downloaded from Hunt.');}
    if(version!==handoffFileVersion)return;
    const preview=await api('handoff/preview',bundle);
    if(version!==handoffFileVersion)return;
    $('handoff-jobs').replaceChildren(...preview.jobs.map(job=>{
      const row=document.createElement('li'), title=document.createElement('a'), resume=document.createElement('p');
      title.textContent=job.title||job.url;title.href=job.url;title.target='_blank';title.rel='noopener noreferrer';
      resume.textContent=`${job.resumeName} · C2 version ${job.resumeVersion}${job.status==='existing'?' · Already in your list':''}`;
      resume.className='note';row.append(title,resume);return row;
    }));
    handoffPaused=preview.jobs.some(job=>job.currentPageOnly);
    $('import-handoff').textContent=handoffPaused?'Add applications paused':'Add and fill applications';
    handoffBundle=bundle;$('handoff-preview').hidden=false;
    $('handoff-summary').textContent=`${preview.jobs.length} ${preview.jobs.length===1?'application':'applications'}. Nothing queued yet.`;
    }catch(e){if(version===handoffFileVersion){$('handoff-status').textContent=e.message;$('handoff-status').setAttribute('role','alert');}}
  });
};
$('import-handoff').onclick=()=>{
  if(!handoffBundle)return;
  const bundle=handoffBundle, paused=handoffPaused, version=handoffFileVersion;
  void perform(async()=>{
    handoffBundle=undefined;$('handoff-preview').hidden=true;$('notice').textContent='';
    $('handoff-status').textContent='Import requested. Check the list before retrying.';handoffControls();
    const existing=new Set(state.jobs.map(job=>job.id));
    const added=await api(paused?'handoff/import-paused':'handoff/import',bundle);
    const reused=added.filter(job=>existing.has(job.id)).length;
    $('notice').textContent=`${added.length-reused} new applications · ${reused} already in your list. Selected resumes were kept.`;
    if(version===handoffFileVersion){$('handoff-file').value='';$('handoff-preview').hidden=true;$('handoff-status').textContent='Import confirmed.';}
    if(document.activeElement===$('import-handoff')||document.activeElement===document.body)$('queue-title').focus();
  });
};
$('concurrency').onchange = () => { const before = state.concurrency, after = Number($('concurrency').value); void perform(async () => {
  await api('concurrency', { value: after }); remember({undo:()=>api('concurrency',{value:before}),redo:()=>api('concurrency',{value:after})});
}); };
const base64 = async file => { const bytes = new Uint8Array(await file.arrayBuffer()); let text=''; for(let i=0;i<bytes.length;i+=8192) text += String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(text); };
function profileControls(loaded) { for(const input of $('profile-form').elements) input.disabled = !loaded; }
profileControls(false);
$('profile-form').onsubmit = e => { e.preventDefault(); const focusWasSave=document.activeElement===$('save-profile'); if(!profileLoaded) { error('Load your saved profile before editing. Retry the profile connection.'); return; } void perform(async () => {
  const resume = $('resume').files[0], applicant = Object.fromEntries(new FormData($('profile-form'))), before = await api('settings');
  if(!resume && !before) throw new Error('Choose your PDF resume.');
  if(resume?.size > 5*1024*1024) throw new Error('Choose a PDF smaller than 5 MB.');
  const after = await api('settings', { applicant, expectedRevision:savedProfile?.profile?.profile?.revision ?? null, ...(resume ? {resumeBase64:await base64(resume), resumeName:resume.name} : {}) });
  if(before) remember({undo:()=>restoreSettings(before),redo:()=>restoreSettings(after)});
  profileDirty = JSON.stringify(Object.fromEntries(new FormData($('profile-form')))) !== JSON.stringify(applicant) || $('resume').files[0] !== resume;
  if($('resume').files[0] === resume) $('resume').value='';
  await loadProfile(after);
  if(focusWasSave && (document.activeElement===$('save-profile')||document.activeElement===document.body))
    $(sectionId).querySelector('input,select,textarea')?.focus();
  $('notice').textContent = 'Profile saved for new applications.';
}); };
async function restoreSettings(value) { const saved=await api('settings',{profile:value.profile,resumeBase64:value.resume,resumeName:value.resumeName,expectedRevision:savedProfile?.profile?.profile?.revision ?? null}); await loadProfile(saved); return saved; }
function savedAnswer(name) {
  return String((savedProfile?.effectiveFacts ?? savedProfile?.profile?.profile?.facts)?.find(f=>f.factId===name)?.value ?? '');
}
function updateProfileDraft() {
  let changed=!!$('resume').files[0];
  for(const input of $('profile-form').querySelectorAll('[name]')) {
    const differs=input.value!==savedAnswer(input.name);changed ||= differs;
    let previous=input.parentElement.querySelector('.saved-value');
    if(!previous){
      input.setAttribute('aria-label',[...input.parentElement.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join(' ').trim());
      previous=document.createElement('small');previous.className='saved-value';previous.id='saved-value-'+input.name;input.parentElement.append(previous);
    }
    previous.hidden=!differs;
    const descriptions = input.name === 'ai_evaluation_consent' ? ['consent-scope'] : [];
    if(differs) descriptions.push(previous.id);
    if(descriptions.length)input.setAttribute('aria-describedby',descriptions.join(' '));else input.removeAttribute('aria-describedby');
    const value=savedAnswer(input.name);
    previous.textContent=`Saved: ${input.tagName==='SELECT'?[...input.options].find(o=>o.value===value)?.textContent||value||'Not answered':value||'Not answered'}`;
  }
  profileDirty=changed||!savedProfile;
  renderProfileStatus();
  historyButtons(); renderJobs();
}
function renderProfileStatus() {
  const status = !profileLoaded ? ($('profile-error').hidden ? 'Loading profile…' : 'Profile unavailable')
    : profileDirty ? 'Unsaved changes'
    : state?.configured ? 'Saved on this device' : 'Profile and resume required';
  if($('profile-status').textContent!==status)$('profile-status').textContent=status;
}
$('refresh-profile').onclick=()=>perform(async()=>{await loadProfile();$('notice').textContent=profileDirty?'Saved values refreshed. Your edits were kept.':'Saved profile refreshed.';});
async function loadProfile(saved) {
  if(!profileLoaded)profileControls(false);
  if (!$('answer-fields').children.length) {
    const schema = await api('profile-fields');
    $('storage-path').textContent = `Saved on this device: ${schema.storage}`;
    const labels = {ai_evaluation_consent:'Allow AI screening of my application when an employer requires an answer', configured_narrative:'Reusable interest statement', work_authorization:'Authorized to work in the application country', sponsorship_required:'Need employer sponsorship', work_authorization_canada:'Authorized to work in Canada', sponsorship_required_canada:'Need employer sponsorship in Canada', age_requirement_met:'At least 18 years old', essential_functions_ability:'Able to perform essential job functions', employment_agreement_prevents_employment:'An existing agreement prevents new employment', highest_education:'Highest education level', current_company:'Current employer', current_title:'Current job title', salary_expectations:'Salary expectations (include currency and period)', desired_salary:'Desired salary amount', weekly_hours:'Available hours per week', notice_period_days:'Notice period in days', travel_percentage:'Willingness to travel (%)', application_source:'How you find job opportunities'};
    const groups=[
      ['work','Work & education'],
      ['availability','Availability & pay'],
      ['eligibility','Work eligibility'],
      ['disclosures','Optional disclosures'],
    ];
    const containers={};
    for(const [id,title] of groups){const section=document.createElement('fieldset'),legend=document.createElement('legend'),grid=document.createElement('div');section.className='profile-section';section.id=id;legend.textContent=title;grid.className='profile-grid';section.append(legend,grid);$('answer-fields').append(section);containers[id]=grid;}
    for (const field of schema.fields) {
      if ([...$('profile-form').elements].some(input => input.name === field.id)) continue;
      const label = document.createElement('label');
      label.textContent = labels[field.id] || field.id.replaceAll('_',' ').replace(/^./, c=>c.toUpperCase());
      const input = document.createElement(field.type === 'boolean' ? 'select' : field.id === 'configured_narrative' ? 'textarea' : 'input');
      input.name = field.id;
      if (field.type === 'boolean') input.append(new Option('Not answered',''), new Option('Yes','true'), new Option('No','false'));
      else if (field.type === 'number') { input.type='number'; input.min='0'; input.step='any'; }
      else { input.maxLength=4000; if(field.id==='earliest_start_date'||field.id==='self_identification_date')input.type='date'; }
      if (field.id === 'configured_narrative') { input.rows=4; label.className='wide'; }
      const group=field.id==='ai_evaluation_consent'||/disclosure|self_identification/.test(field.id)?'disclosures':field.type==='boolean'?'eligibility':/salary|start_date|weekly_hours|notice_period|travel_percentage/.test(field.id)?'availability':'work';
      label.append(input); containers[group].append(label);
      if (field.id === 'ai_evaluation_consent') {
        const hint = document.createElement('small');
        hint.id = 'consent-scope';
        hint.textContent = 'Applies to new applications and saved drafts on the next fill.';
        label.append(hint);
      }
    }
  }
  showSection(sectionId);
  if(!profileLoaded)profileControls(false);
  if(saved===undefined)saved=await api('settings');
  savedProfile=saved;
  const manifest=saved?.profile;
  $('profile-answer-warning').hidden=!(manifest?.executionPolicy?.answerFallbackPolicy==='deterministic_site_valid_editable' ||
    manifest?.profilePlan?.mode==='synthetic_test_non_submittable' || manifest?.profile?.facts?.some(f=>f.lane==='synthetic_test_default'));
  if(!profileDirty)for(const input of $('profile-form').querySelectorAll('[name]')) {
    input.value=savedAnswer(input.name);
  }
  profileLoaded=true; profileControls(true); $('profile-error').hidden=true;
  if(savedResumeUrl)URL.revokeObjectURL(savedResumeUrl);
  savedResumeUrl=undefined;$('view-resume').hidden=!saved?.resume;
  if(saved?.resume){const bytes=Uint8Array.from(atob(saved.resume),c=>c.charCodeAt(0));savedResumeUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));$('view-resume').href=savedResumeUrl;$('view-resume').textContent=saved.resumeName || 'View saved PDF';$('saved-resume').textContent='';}
  else $('saved-resume').textContent='Choose a PDF to save your profile.';
  updateProfileDraft();
}
function downloadBackup(value) {
  const settings={profile:value.profile,resume:value.resume,resumeName:value.resumeName};
  const blob=new Blob([JSON.stringify({format:'hunt-c3-profile',version:1,exportedAt:new Date().toISOString(),settings},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url;link.download=`hunt-c3-profile-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-backup').onclick=()=>perform(async()=>{const saved=await api('settings');if(!saved)throw new Error('Save your profile first.');downloadBackup(saved);$('notice').textContent='Backup downloaded. It contains saved values, not unsaved edits.';});
$('restore-backup').onclick=()=>perform(async()=>{
  if(profileDirty)throw new Error('Save your edits before restoring a backup.');
  const file=$('backup-file').files[0];if(!file||file.size>12*1024*1024)throw new Error('Choose a C3 profile backup smaller than 12 MB.');
  const backup=JSON.parse(await file.text());if(backup.format!=='hunt-c3-profile'||backup.version!==1||!backup.settings)throw new Error('This is not a supported C3 profile backup.');
  const before=await api('settings');const after=await restoreSettings(backup.settings);
  if(before)remember({undo:()=>restoreSettings(before),redo:()=>restoreSettings(after)});
  if($('backup-file').files[0]===file)$('backup-file').value='';$('notice').textContent='Profile restored for new applications. You can undo this change.';
});
$('import-profile').onclick=()=>perform(async()=>{
  if(profileDirty)throw new Error('Save your edits before importing another profile.');
  const draft = JSON.stringify(Object.fromEntries(new FormData($('profile-form'))));
  const file=$('profile').files[0], resume=$('import-resume').files[0], profileResume=$('resume').files[0], before=await api('settings');
  if(!file || (!resume && !before))throw new Error('Choose a prepared C3 profile and a PDF resume.');
  const after=await api('settings',{profile:JSON.parse(await file.text()),resumeBase64:resume ? await base64(resume) : before.resume,resumeName:resume?.name ?? before?.resumeName,expectedRevision:savedProfile?.profile?.profile?.revision ?? null});
  if(before)remember({undo:()=>restoreSettings(before),redo:()=>restoreSettings(after)});
  profileDirty = JSON.stringify(Object.fromEntries(new FormData($('profile-form')))) !== draft || $('resume').files[0] !== profileResume;
  if($('import-resume').files[0] === resume) $('import-resume').value='';
  await loadProfile(after); if($('profile').files[0] === file) $('profile').value='';
});
$('account-form').onsubmit = e => { e.preventDefault(); void perform(async () => {
  const submitted={ email:$('email').value, password:$('password').value, gmailAppPassword:$('gmail').value },active=document.activeElement;
  const result = await api('account', submitted);
  accountDraft=$('email').value!==submitted.email||$('password').value!==submitted.password||$('gmail').value!==submitted.gmailAppPassword;
  if($('password').value===submitted.password)$('password').value=''; if($('gmail').value===submitted.gmailAppPassword)$('gmail').value='';
  $('notice').textContent=(result.accountSaved ? 'Account saved securely.' : 'Account available until restart.')+(result.gmailVerified ? ' Gmail connection verified.' : ''); await loadAccountStatus(); if(document.activeElement===active||document.activeElement===document.body)$('email').focus();
}); };
function checkTime(value) { return value ? new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)) : ''; }
function savedPasswordText(value) { return value===null?'Saved file could not be read':value?'Saved securely':'Not saved'; }
async function loadAccountStatus() {
  accountStatus=await api('account/status');
  const application=accountStatus.applicationPassword,gmail=accountStatus.gmail;
  $('application-password-state').textContent=application.saved || application.configured ?
    `${savedPasswordText(application.saved)}. Employer sign-in not checked.` : savedPasswordText(application.saved);
  const mailText=gmail.status==='verified'?'Inbox access verified':gmail.status==='failed'?'Inbox check failed':gmail.status==='missing'?'No Gmail credentials configured':'Inbox access not checked';
  const mailState=gmail.saved===false && gmail.status==='missing' ? 'Not configured' : `${savedPasswordText(gmail.saved)}. ${mailText}`;
  $('gmail-password-state').textContent=`${mailState}.${gmail.lastSuccessAt?` Last successful check: ${checkTime(gmail.lastSuccessAt)}.`:''}${gmail.error?' Recheck, or enter a replacement Gmail app password.':''}`;
  if(!accountDraft && typeof accountStatus.email==='string')$('email').value=accountStatus.email;
  if(accountStatus.evidencePersistenceError)$('account-storage-status').textContent='The check finished, but its status could not be saved. Check local storage before relying on it.';
  historyButtons();
}
$('check-account').onclick=()=>perform(async()=>{
  $('check-account').textContent='Checking inbox access…';
  try { await api('account/check',{}); await loadAccountStatus(); $('notice').textContent=accountStatus.gmail.status==='verified'?'Gmail inbox access verified.':'Gmail check failed. The saved account was kept.'; }
  catch(error) { await loadAccountStatus().catch(()=>{});throw error; }
  finally { $('check-account').textContent='Recheck saved Gmail'; }
});
async function loadConnectionStatus() {
  const status=await api('agent/status');
  extensionId=typeof status.extension?.extensionId==='string'?status.extension.extensionId:'';
  $('connection-details').textContent=status.extension?`${status.extension.browser || 'Browser'} connected.`:status.connected?'Browser connected. Reload Hunt C3 to show its version.':'Open Hunt C3 in your browser and select Connect to local app.';
  $('connection-version').textContent=`Local app ${status.serviceVersion}${status.extension?.version?` · Extension ${status.extension.version}`:''}`;
  historyButtons();
}
$('check-connection').onclick=()=>perform(async()=>{await loadConnectionStatus();$('notice').textContent='Connection checked.';});
$('connect-website').onclick=()=>{
  if(!extensionId)return;
  window.open('https://agent-hunt-review.mshi.ca/executioner#c3-extension='+encodeURIComponent(extensionId),'_blank','noopener');
};
function button(text, action, jobId, blocked=false) { const b=document.createElement('button'); b.type='button'; b.className='secondary'; b.textContent=text; b.disabled=busy||historyBusy||!stateFresh||blocked; b.onclick=()=>perform(action,jobId,`${text} in progress…`); return b; }
const ownerReview = job => job.status==='review' && job.stage.startsWith('Owner review needed:');
const needsAttention = job => ownerReview(job) || ['paused','submission_uncertain'].includes(job.status);
async function refresh() {
  if(!proxied && !token) { $('pair').hidden=false; $('connection').textContent='Not paired'; return; }
  const sequence=++refreshSequence; let next;
  try { next=await api('state'); $('account-storage-status').textContent=next.accountRestoreError || (next.accountSaved && !next.accountConfigured ? 'Saved account is reconnecting.' : ''); }
  catch(e) {
    if(sequence!==refreshSequence)return;
    stateFresh=false; $('connection').textContent='Connection lost'; $('connection').dataset.connected='false';
    $('connection-error').hidden=false; $('connection-error').querySelector('p').textContent=`${e.message} ${state ? 'Showing last confirmed progress.' : 'Progress could not be loaded.'} Reconnect before changing jobs.`;
    $('start').disabled=true; $('concurrency').disabled=true; historyButtons(); renderJobs(); throw e;
  }
  if(sequence!==refreshSequence)return;
  if(!proxied && token){sessionStorage.setItem('c3-token',token);urlToken=null;}
  if(!state)$('batch-entry').open=next.jobs.length===0;
  state=next; stateFresh=true; $('pair').hidden=true; $('connection-error').hidden=true;
  for(const [id,issue] of jobErrors)if(issue.refreshOnly)jobErrors.delete(id);
  if(state.storageError)error(state.storageError);
  $('recover-storage').hidden = !state.storageError;
  $('connection').textContent=state.connected ? 'Connected' : 'Extension disconnected'; $('connection').dataset.connected=String(state.connected);
  $('start').disabled=!state.configured || !state.connected; $('concurrency').disabled=false; $('concurrency').value=String(state.concurrency);
  renderProfileStatus();
  $('summary').textContent=`${state.jobs.filter(j=>j.status==='review').length} at review · ${state.jobs.filter(needsAttention).length} need attention · ${state.jobs.filter(j=>j.status==='running').length} running`;
  const conflicting=state.conflictingJobCount || 0, unreadable=(state.unavailableJobCount || 0)-conflicting;
  $('link-recovery').hidden=proxied || !unreadable;
  const warnings=[];
  if(conflicting) warnings.push(`${conflicting} saved applications have conflicting links. Keep your local data and restore an Applications backup with one entry per posting.`);
  if(unreadable) warnings.push(`${unreadable} saved ${unreadable===1?'application has an unreadable link':'applications have unreadable links'}.${proxied ? ' Open local Applications to repair.' : ''}`);
  $('queue-warning').hidden=!warnings.length; $('queue-warning').textContent=warnings.join(' ');
  $('empty').hidden=state.jobs.length>0;
  historyButtons(); renderJobs();
  if(!profileLoaded) {
    try { await loadProfile(); $('profile-error').hidden=true; }
    catch(e) { $('profile-error').hidden=false; $('profile-error').querySelector('p').textContent=`Profile could not be loaded: ${e.message}`; renderProfileStatus(); }
  }
  if(Date.now()-metadataCheckedAt>15000) {
    metadataCheckedAt=Date.now();
    try { await loadAccountStatus(); }
    catch { $('application-password-state').textContent='Saved-account status unavailable. Check the local app connection.'; $('gmail-password-state').textContent='Verification status unavailable.'; }
    try { await loadConnectionStatus(); }
    catch { $('connection-details').textContent='Browser details unavailable. Update the local C3 app, then check the connection.'; }
  }
}
function renderJobs() {
  if(!state)return;
  $('start').disabled=busy||historyBusy||!stateFresh||!state.configured||!state.connected;
  $('batch-blocker').hidden=!stateFresh || (state.configured && state.connected);
  $('batch-blocker').textContent=!state.configured?'Save your profile and resume before filling.':!state.connected?'Connect the Hunt C3 extension to fill applications.':'';
  $('concurrency').disabled=busy||historyBusy||!stateFresh;
  const query=$('job-search').value.trim().toLowerCase(), filter=$('job-filter').value;
  const jobs=state.jobs.filter(job=>(!query || `${job.title} ${job.url}`.toLowerCase().includes(query)) &&
    (filter==='all'||filter==='attention'&&needsAttention(job)||filter==='active'&&['queued','running'].includes(job.status)||job.status===filter));
  const filteredCount = (query || filter!=='all') && jobs.length ? `${jobs.length} of ${state.jobs.length} applications` : '';
  if($('filter-summary').textContent!==filteredCount)$('filter-summary').textContent=filteredCount;
  $('no-matches').hidden=jobs.length>0||state.jobs.length===0;
  const signature=JSON.stringify([state.jobs,query,filter,stateFresh,busy,historyBusy,profileLoaded,profileDirty,savedProfile?.profile?.profile?.revision,pendingJob,[...jobErrors]]); if(signature===rendered)return; rendered=signature;
  const active=document.activeElement, focusJob=active?.closest('[data-job]')?.dataset.job, focusText=active?.dataset.focusAction||active?.textContent;
  const expandedDiagnostics=new Set([...$('jobs').querySelectorAll('.job-diagnostics[open]')].map(item=>item.closest('[data-job]').dataset.job));
  const rows=jobs.map(job=>{
    const li=document.createElement('li'); li.dataset.job=job.id;li.tabIndex=-1;
    const content=document.createElement('div'), title=document.createElement('a'); title.className='job-title';title.textContent=job.title;title.href=job.url;title.target='_blank';title.rel='noopener noreferrer'; content.append(title);
    const status=document.createElement('p');status.className='job-status';status.textContent=job.status==='paused'&&job.actionPending?'Pausing…':ownerReview(job)?'Owner review needed':({queued:'Queued',running:'Running',paused:'Paused',review:'At review',submitting:'Submitting',submitted:'Submitted',submission_uncertain:'Submission uncertain'}[job.status]||job.status);status.dataset.attention=String(needsAttention(job));content.append(status);
    if(job.currentPageOnly && ['paused','review'].includes(job.status)){const stage=document.createElement('p');stage.className='job-stage';stage.textContent=job.pageHandoff?'Open the job link, then choose Fill current page to use its selected resume.':'Open the job link and choose Fill current page. It uses your default resume.';content.append(stage);}
    else if(job.stage!==status.textContent&&!(job.stage==='Needs attention'&&job.error)){const stage=document.createElement('p');stage.className=ownerReview(job)?'job-stage owner-warning':'job-stage';stage.textContent=ownerReview(job)?job.stage.replace(/^Owner review needed: /,'').replace(/^./,c=>c.toUpperCase()):job.stage;content.append(stage);}
    if(job.resumeName){const resume=document.createElement('p');resume.className='job-stage';resume.textContent=`Resume: ${job.resumeName}${job.resumeVersion ? ' · '+job.resumeVersion : ''}`;content.append(resume);}
    if(proxied && job.sourceJobId){const source=document.createElement('a');source.href=`/jobs/${job.sourceJobId}`;source.target='_top';source.textContent='View Hunt job';content.append(source);}
    if (job.status === 'paused' && job.componentFailure) {
      const detail = document.createElement('p');
      detail.className = 'job-stage';
      detail.textContent = [job.componentFailure.component, job.componentFailure.operation]
        .map(part => part.replaceAll('_', ' ')).join(' / ');
      const diagnostics=document.createElement('details'),summary=document.createElement('summary');
      diagnostics.className='job-diagnostics'; diagnostics.open=expandedDiagnostics.has(job.id); summary.textContent='Technical details';
      diagnostics.append(summary,detail); content.append(diagnostics);
    }
    if(job.error){const p=document.createElement('p');p.className='job-error';p.setAttribute('role','alert');p.textContent=job.error;content.append(p);}
    if(jobErrors.has(job.id)&&jobErrors.get(job.id).message!==job.error){const p=document.createElement('p');p.className='job-action-error';p.setAttribute('role','alert');p.textContent=jobErrors.get(job.id).message;content.append(p);}
    if(pendingJob?.id===job.id){const p=document.createElement('p');p.className='job-pending';p.setAttribute('role','status');p.textContent=pendingJob.label;content.append(p);}
    const actions=document.createElement('div');actions.className='actions';
    const act=action=>api(`jobs/${job.id}/action`,{action});
    if(job.tabId)actions.append(button('Open application',()=>act('open'),job.id));
    else if(job.currentPageOnly && job.status==='paused' && job.selectedDocument && job.selectedApplicationUrl) {
      actions.append(button('Open saved application',async()=>{
        const tab=window.open('about:blank','_blank');
        if(!tab)throw new Error('Allow a new tab for this workspace or open the posting using its title.');
        tab.opener=null;
        try {
          const verified=await act('open');
          tab.location.replace(verified.url);
        } catch(error) {tab.close();throw error;}
      },job.id));
    }
    if(['running','queued'].includes(job.status))actions.append(button('Pause',()=>act('pause'),job.id));
    if(!job.currentPageOnly && ['paused','review'].includes(job.status))actions.append(button('Retry',()=>act('retry'),job.id,job.actionPending));
    if(!job.currentPageOnly && job.status==='paused'&&job.profileUpdateAvailable)actions.append(button('Use saved profile',async()=>{
      const expectedProfileRevision=savedProfile?.profile?.profile?.revision;
      const expectedProfileDigest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(savedProfile?.profile))))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      const apply=()=>api(`jobs/${job.id}/action`,{action:'refresh_profile',expectedProfileRevision,expectedProfileDigest});
      let refreshed=await apply();
      if(refreshed.inputDigest)remember({undo:()=>api(`jobs/${job.id}/action`,{action:'undo_profile_refresh',inputDigest:refreshed.inputDigest,refreshToken:refreshed.refreshToken}),redo:async()=>{refreshed=await apply();}});
      $('notice').textContent=refreshed.unchanged?'This application already uses the saved profile.':'Saved profile applied. Choose Retry to continue.';
    },job.id,job.actionPending||!profileLoaded||profileDirty));
    if(['paused','queued','review'].includes(job.status))actions.append(button('Remove',async()=>{await act('remove');remember({undo:()=>act('restore'),redo:()=>act('remove')});$('notice').textContent='Removed from the list. Undo is available in this tab until reload or 20 more changes.';},job.id,job.actionPending));
    if(!job.currentPageOnly && (job.status==='review'||job.status==='paused'&&job.reviewUrl))actions.append(button('Refresh review',()=>act('refresh_review'),job.id,job.actionPending));
    if(job.status==='review'){
      if(!job.currentPageOnly && job.submissionAllowed)actions.append(button('Submit…',async()=>{pendingSubmit=job;$('submit-title').textContent=job.title;$('reviewed').checked=false;$('submit-dialog').returnValue='';$('submit-dialog').showModal();},job.id,job.actionPending));
    }
    li.append(content,actions);return li;
  });
  $('jobs').replaceChildren(...rows);
  if(focusJob && !active.isConnected){const row=rows.find(r=>r.dataset.job===focusJob), buttons=[...(row?.querySelectorAll('button:not(:disabled),summary')||[])];const next=buttons.find(b=>b.textContent===focusText)||(!busy&&!historyBusy&&(buttons.find(b=>b.tagName==='BUTTON'&&b.textContent!=='Open application')||buttons[0]))||row||$('queue-title');if(next===row)row.dataset.focusAction=focusText;next.focus();}
}
$('submit-dialog').addEventListener('close',()=>{if($('submit-dialog').returnValue!=='submit')return; const job=pendingSubmit;
  void perform(()=>api(`jobs/${job.id}/action`,{action:'submit',confirmed:$('reviewed').checked,reviewDigest:job.reviewDigest}));
});
void refresh().catch(()=>{});
setInterval(()=>{if(!busy && !historyBusy && !polling && !document.hidden && !$('submit-dialog').open){polling=true;void refresh().catch(()=>{}).finally(()=>{polling=false;});}},2500);
