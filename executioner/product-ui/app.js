const $ = id => document.getElementById(id);
const proxied = location.pathname.startsWith('/api/c3/');
const base = proxied ? '/api/c3/' : '/';
if (proxied) $('pair').hidden = true;
let token = sessionStorage.getItem('c3-token') || new URLSearchParams(location.hash.slice(1)).get('token') || '';
if (new URLSearchParams(location.hash.slice(1)).has('token')) { sessionStorage.setItem('c3-token', token); history.replaceState(null, '', location.pathname + location.search); }
let state, busy = false, rendered = '', pendingSubmit, historyBusy = false, profileLoaded = false, polling = false, profileDirty = false, profileSuggestions = [];
$('profile-form').addEventListener('input', () => { profileDirty = true; $('draft-state').textContent='Unsaved changes'; $('profile-status').textContent='Not saved'; });
const viewCopy={profile:'Profile',applications:'Applications',settings:'Settings'};
for(const item of [$('account-form'),$('backup-file').closest('details'),$('import-profile').closest('details')]) $('settings-panel').append(item);
const accountHeading=document.createElement('h2');accountHeading.textContent='Application account';$('account-form').prepend(accountHeading);
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{
  for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==button.dataset.view;
  for(const tab of document.querySelectorAll('[data-view]')){if(tab===button)tab.setAttribute('aria-current','page');else tab.removeAttribute('aria-current');}
  $('page-title').textContent=viewCopy[button.dataset.view];
};
$('concurrency').replaceChildren(...Array.from({length:30}, (_,i) => new Option(String(i+1), String(i+1))));
$('concurrency').disabled = true;
const undo = [], redo = [];
async function api(path, body) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type':'application/json', ...(token ? { Authorization:'Bearer '+token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.detail || 'C3 is unavailable.');
  return data;
}
function error(value) { $('error').textContent = value || ''; $('error').hidden = !value; }
async function perform(action) { if (busy || historyBusy) { error('Another action is still running. Try again when it finishes.'); return; } busy = true; historyButtons(); error(''); try { await action(); await refresh(); } catch(e) { error(e.message); } finally { busy = false; historyButtons(); } }
function historyButtons() { $('undo').disabled = busy || historyBusy || !undo.length; $('redo').disabled = busy || historyBusy || !redo.length; }
function remember(entry) { undo.push(entry); if(undo.length > 20) undo.shift(); redo.length = 0; historyButtons(); }
async function reverse(from, to, direction) {
  if(busy || historyBusy || !from.length) return;
  historyBusy = true; historyButtons(); const entry = from.at(-1);
  try { await entry[direction](); from.pop(); to.push(entry); $('notice').textContent = direction === 'undo' ? 'Change undone' : 'Change restored'; await refresh(); }
  catch(e) { error(e.message); } finally { historyBusy = false; historyButtons(); (from.length ? $(direction) : document.querySelector('[data-view][aria-current]')).focus(); }
}
$('undo').onclick = () => reverse(undo, redo, 'undo'); $('redo').onclick = () => reverse(redo, undo, 'redo');
$('recover-storage').onclick = () => perform(() => api('recover-storage', {}));
$('pair').onsubmit = e => { e.preventDefault(); token = $('token').value.trim(); sessionStorage.setItem('c3-token', token); void perform(refresh); };
$('batch').onsubmit = e => { e.preventDefault(); const submitted = $('links').value; void perform(async () => {
  const jobs = [...new Set(submitted.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))].map(url=>({url}));
  const added = await api('jobs', { jobs }); const existing=new Set(state.jobs.map(job=>job.id));const distinct=[...new Map(added.map(job=>[job.id,job])).values()];const reused=distinct.filter(job=>existing.has(job.id)).length; $('notice').textContent=`${distinct.length-reused} new applications · ${reused} already in your list · ${added.length-distinct.length} duplicate links ignored`; if($('links').value === submitted) $('links').value = ''; $('links').focus();
}); };
$('concurrency').onchange = () => { const before = state.concurrency, after = Number($('concurrency').value); void perform(async () => {
  await api('concurrency', { value: after }); remember({undo:()=>api('concurrency',{value:before}),redo:()=>api('concurrency',{value:after})});
}); };
const base64 = async file => { const bytes = new Uint8Array(await file.arrayBuffer()); let text=''; for(let i=0;i<bytes.length;i+=8192) text += String.fromCharCode(...bytes.subarray(i,i+8192)); return btoa(text); };
$('profile-form').onsubmit = e => { e.preventDefault(); void perform(async () => {
  if(!$('suggestion-review').hidden && !$('accept-suggestions').checked)throw new Error('Review the suggested answers and confirm them before saving.');
  const resume = $('resume').files[0], applicant = Object.fromEntries(new FormData($('profile-form'))), before = await api('settings');
  if(!resume && !before) throw new Error('Choose your PDF resume.');
  if(resume?.size > 5*1024*1024) throw new Error('Choose a PDF smaller than 5 MB.');
  await api('settings', { applicant, ...(resume ? {resumeBase64:await base64(resume)} : {}) });
  const after = await api('settings');
  if(before) remember({undo:()=>restoreSettings(before),redo:()=>restoreSettings(after)});
  profileDirty = JSON.stringify(Object.fromEntries(new FormData($('profile-form')))) !== JSON.stringify(applicant) || $('resume').files[0] !== resume;
  if($('resume').files[0] === resume) $('resume').value='';
  await loadProfile();
  $('notice').textContent = 'Saved for new jobs. Queued jobs keep their original profile and resume.';
}); };
async function restoreSettings(value) { await api('settings',{profile:value.profile,resumeBase64:value.resume}); if(!profileDirty)await loadProfile(); }
async function loadProfile(suggest = false) {
  if (!$('answer-fields').children.length) {
    const schema = await api('profile-fields');
    profileSuggestions = schema.fields.filter(field => field.suggestedValue !== undefined);
    $('storage-path').textContent = `Saved on this device: ${schema.storage}`;
    const labels = {configured_narrative:'Reusable interest statement', work_authorization:'Authorized to work in the application country', sponsorship_required:'Need employer sponsorship', age_requirement_met:'At least 18 years old', essential_functions_ability:'Able to perform essential job functions', employment_agreement_prevents_employment:'An existing agreement prevents new employment', highest_education:'Highest education level', current_company:'Current employer', current_title:'Current job title', salary_expectations:'Salary expectations (include currency and period)', desired_salary:'Desired salary amount', weekly_hours:'Available hours per week', notice_period_days:'Notice period in days', travel_percentage:'Willingness to travel (%)', application_source:'How you find job opportunities'};
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
      const group=/disclosure|self_identification/.test(field.id)?'disclosures':field.type==='boolean'?'eligibility':/salary|start_date|weekly_hours|notice_period|travel_percentage/.test(field.id)?'availability':'work';
      label.append(input); containers[group].append(label);
    }
  }
  const saved=await api('settings');
  if(!profileDirty)for(const input of $('profile-form').querySelectorAll('[name]')) {
    if(input.name==='answer_policy') { input.value=saved?.profile?.executionPolicy?.answerFallbackPolicy==='deterministic_site_valid_editable'?'test':'real'; continue; }
    input.value=String(saved?.profile?.profile?.facts?.find(f=>f.factId===input.name)?.value ?? '');
  }
  if(!profileDirty){
    for(const badge of document.querySelectorAll('.suggested-answer'))badge.remove();
    let suggestions=0;
    for(const field of suggest ? profileSuggestions : []){
      const input=$('profile-form').elements.namedItem(field.id);
      if(!input || input.value!=='')continue;
      input.value=String(field.suggestedValue);
      const badge=document.createElement('span');badge.className='suggested-answer';badge.textContent='Suggested';input.closest('label').append(badge);suggestions++;
    }
    $('suggestion-review').hidden=!suggestions;$('accept-suggestions').checked=false;
    if(suggestions)profileDirty=true;
  }
  $('saved-policy').textContent = saved?.profile?.executionPolicy?.answerFallbackPolicy === 'deterministic_site_valid_editable' ? 'Saved mode: test values enabled.' : 'Saved mode: your answers only.';
  profileLoaded=true;
  $('draft-state').textContent=profileDirty?'Unsaved changes':'Saved';
}
function downloadBackup(value) {
  const blob=new Blob([JSON.stringify({format:'hunt-c3-profile',version:1,exportedAt:new Date().toISOString(),settings:value},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url;link.download=`hunt-c3-profile-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-backup').onclick=()=>perform(async()=>{const saved=await api('settings');if(!saved)throw new Error('Save your profile first.');downloadBackup(saved);$('notice').textContent='Backup downloaded. It contains saved values, not unsaved edits.';});
$('restore-backup').onclick=()=>perform(async()=>{
  if(profileDirty)throw new Error('Save your edits before restoring a backup.');
  const file=$('backup-file').files[0];if(!file||file.size>12*1024*1024)throw new Error('Choose a C3 profile backup smaller than 12 MB.');
  const backup=JSON.parse(await file.text());if(backup.format!=='hunt-c3-profile'||backup.version!==1||!backup.settings)throw new Error('This is not a supported C3 profile backup.');
  const before=await api('settings');await restoreSettings(backup.settings);const after=await api('settings');
  if(before)remember({undo:()=>restoreSettings(before),redo:()=>restoreSettings(after)});
  $('backup-file').value='';$('notice').textContent='Profile restored for new applications. You can undo this change.';
});
$('import-profile').onclick=()=>perform(async()=>{
  if(profileDirty)throw new Error('Save your edits before importing another profile.');
  const draft = JSON.stringify(Object.fromEntries(new FormData($('profile-form'))));
  const file=$('profile').files[0], resume=$('import-resume').files[0], profileResume=$('resume').files[0], before=await api('settings');
  if(!file || (!resume && !before))throw new Error('Choose a prepared C3 profile and a PDF resume.');
  await api('settings',{profile:JSON.parse(await file.text()),resumeBase64:resume ? await base64(resume) : before.resume});
  const after=await api('settings'); if(before)remember({undo:()=>restoreSettings(before),redo:()=>restoreSettings(after)});
  profileDirty = JSON.stringify(Object.fromEntries(new FormData($('profile-form')))) !== draft || $('resume').files[0] !== profileResume;
  if($('import-resume').files[0] === resume) $('import-resume').value='';
  await loadProfile(); if($('profile').files[0] === file) $('profile').value='';
});
$('account-form').onsubmit = e => { e.preventDefault(); void perform(async () => {
  await api('account', { email:$('email').value, password:$('password').value, gmailAppPassword:$('gmail').value });
  $('password').value=''; $('gmail').value=''; $('notice').textContent='Account available for this service session'; $('email').focus();
}); };
function button(text, action) { const b=document.createElement('button'); b.type='button'; b.className='secondary'; b.textContent=text; b.onclick=()=>perform(action); return b; }
async function refresh() {
  if(!proxied && !token) { $('pair').hidden=false; $('connection').textContent='Not paired'; return; }
  state = await api('state'); $('pair').hidden=true;
  if(state.storageError)error(state.storageError);
  $('recover-storage').hidden = !state.storageError;
  if(!profileLoaded)await loadProfile(true);
  $('connection').textContent=state.connected ? 'Connected' : 'Extension disconnected'; $('connection').dataset.connected=String(state.connected);
  $('start').disabled=!state.configured || !state.connected; $('concurrency').disabled=false; $('concurrency').value=String(state.concurrency);
  $('profile-status').textContent=profileDirty?'Not saved':state.configured ? 'Saved on this device' : 'Profile and resume required';
  $('summary').textContent=`${state.jobs.filter(j=>j.status==='review').length} ready to review · ${state.jobs.filter(j=>j.status==='running').length} running`;
  $('empty').hidden=state.jobs.length>0;
  $('profile-usage').textContent=`${state.jobs.length} applications have their own saved profile snapshot. Re-adding the same recognized job returns its existing entry.`;
  const signature=JSON.stringify(state.jobs); if(signature===rendered)return; rendered=signature;
  const active=document.activeElement, focusJob=active?.closest('[data-job]')?.dataset.job, focusText=active?.textContent;
  const rows=state.jobs.map(job=>{
    const li=document.createElement('li'); li.dataset.job=job.id;
    const content=document.createElement('div'), title=document.createElement('a'); title.className='job-title';title.textContent=job.title;title.href=job.url;title.target='_blank';title.rel='noopener noreferrer'; content.append(title);
    const stage=document.createElement('p');stage.className='job-stage';stage.textContent=job.stage;content.append(stage);
    if(job.resumeName){const resume=document.createElement('p');resume.className='job-stage';resume.textContent=`Resume: ${job.resumeName}${job.resumeVersion ? ' · '+job.resumeVersion : ''}`;content.append(resume);}
    if(proxied && job.sourceJobId){const source=document.createElement('a');source.href=`/jobs/${job.sourceJobId}`;source.target='_top';source.textContent='View Hunt job';content.append(source);}
    if(job.error){const p=document.createElement('p');p.className='job-error';p.textContent=job.error;content.append(p);}
    const actions=document.createElement('div');actions.className='actions';
    const act=action=>api(`jobs/${job.id}/action`,{action});
    if(job.tabId)actions.append(button('Open application',()=>act('open')));
    if(['running','queued'].includes(job.status))actions.append(button('Pause',()=>act('pause')));
    if(['paused','review'].includes(job.status))actions.append(button('Retry',()=>act('retry')));
    if(['paused','queued'].includes(job.status))actions.append(button('Remove',async()=>{await act('remove');remember({undo:()=>act('restore'),redo:()=>act('remove')});}));
    if(job.status==='review'){
      actions.append(button('Refresh review',()=>act('refresh_review')));
      if(job.submissionAllowed)actions.append(button('Submit…',async()=>{pendingSubmit=job;$('submit-title').textContent=job.title;$('reviewed').checked=false;$('submit-dialog').returnValue='';$('submit-dialog').showModal();}));
    }
    li.append(content,actions);return li;
  });
  $('jobs').replaceChildren(...rows);
  if(focusJob && !active.isConnected){const row=rows.find(r=>r.dataset.job===focusJob);const next=[...(row?.querySelectorAll('button')||[])].find(b=>b.textContent===focusText)||row?.querySelector('a')||$('links');next.focus();}
}
$('submit-dialog').addEventListener('close',()=>{if($('submit-dialog').returnValue!=='submit')return; const job=pendingSubmit;
  void perform(()=>api(`jobs/${job.id}/action`,{action:'submit',confirmed:$('reviewed').checked,reviewDigest:job.reviewDigest}));
});
void refresh().catch(e=>error(e.message));
setInterval(()=>{if(!busy && !historyBusy && !polling && !document.hidden && !$('submit-dialog').open){polling=true;void refresh().catch(e=>{error(e.message);$('connection').textContent='Disconnected';}).finally(()=>{polling=false;});}},2500);
