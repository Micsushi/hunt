import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';
import {applicationTarget} from '../../src/product/target.ts';
import {fillApplication, reviewDigest, submitReviewedApplication} from '../../src/product/engine.ts';
import {fillGenericIdentityFields} from '../../src/product/generic-application.ts';
import {applicantProfile} from '../../src/product/sources.ts';
import {inspectHostedFields} from '../../src/product/hosted-application.ts';
import {hostedReviewSnapshot} from '../../src/product/hosted-application.ts';
import {uploadGreenhouseResume,verifiedGreenhouseResume} from '../../src/product/greenhouse-resume.ts';
import {ApplicationQueue} from '../../src/product/queue.ts';

const id='11111111-1111-4111-8111-111111111111';
test('Ashby location retries once when a delayed country focus closes its uncommitted menu',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage(),url=`https://jobs.ashbyhq.com/fixture/${id}/application`;
    let ownerEdit=false;
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<style>@keyframes moving{from{transform:translateY(0)}to{transform:translateY(30px)}}.moving{animation:moving .2s linear infinite}</style>
      <label>Name<input name=name required></label><label>Email<input name=email type=email required></label><button type=button id=country>Canada</button>
      <div class=ashby-application-form-field-entry data-field-path=_systemfield_location><label for=location>Location</label><input id=location role=combobox aria-controls=places required><div id=places role=listbox hidden><div role=option>Toronto, Ontario, Canada</div></div></div><button>Submit Application</button>
      <script>const l=document.querySelector('#location'),p=document.querySelector('#places');window.searches=0;l.oninput=()=>{if(!l.value)return;window.searches++;p.hidden=false;if(window.searches===1){p.firstElementChild.className='moving';setTimeout(()=>{document.querySelector('#country').focus();l.value='${ownerEdit?'Owner edit':''}';p.hidden=true;p.firstElementChild.className='';},80);}};p.onclick=()=>{l.value='Toronto, Ontario, Canada';p.firstElementChild.setAttribute('aria-selected','true');p.hidden=true;};</script>`}));
    await page.goto(url);const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',city:'Toronto',region:'Ontario',country:'Canada'});
    await fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await page.locator('#location').inputValue(),'Toronto, Ontario, Canada');
    assert.equal(await page.evaluate('searches'),2);
    ownerEdit=true;await page.reload();
    await assert.rejects(fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{}),/Timeout/);
    assert.equal(await page.locator('#location').inputValue(),'Owner edit');
  }finally{await browser.close();}
});

test('Workable masked dates use date answers and sequential entry',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage(),url='https://apply.workable.com/fixture/j/DATE123/apply/';
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<label>Full name<input name=name required></label><label>Email<input name=email type=email required></label>
      <label>Date available to start work<input id=start placeholder="MM/DD/YYYY" inputmode=tel required></label><button>Submit application</button>
      <script>document.querySelector('#start').oninput=e=>{if(e.data&&e.data.length>1){e.target.value='';return;}const d=e.target.value.replace(/\\D/g,'').slice(0,8);e.target.value=d.slice(0,2)+(d.length>2?'/'+d.slice(2,4):'')+(d.length>4?'/'+d.slice(4):'');};</script>`}));
    await page.goto(url);await page.locator('#start').fill('11/20/2026');assert.equal(await page.locator('#start').inputValue(),'');
    const missingDate=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'});
    const draft=await fillApplication(page,{url,profile:missingDate,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(draft.needsOwnerReview,true);
    assert.match(await page.locator('#start').inputValue(),/^\d{2}\/\d{2}\/\d{4}$/);
    await page.locator('#start').fill('');
    const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',earliest_start_date:'2026-11-20'});
    const result=await fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    const value=await page.locator('#start').inputValue();assert.equal(value,'11/20/2026');
    assert.equal(await reviewDigest(page),result.reviewDigest);
    await fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await page.locator('#start').inputValue(),value);
  }finally{await browser.close();}
});

test('Ashby autocomplete opens its unique toggle without treating focus as an open menu',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage(),url=`https://jobs.ashbyhq.com/fixture/${id}/application`;
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<label>Name<input name=name required></label><label>Email<input name=email type=email required></label>
      <div class=ashby-application-form-field-entry><label for=choice>How did you hear about us?</label><div><input id=choice role=combobox aria-expanded=false aria-controls=choices class=ashby-application-form-input-autocomplete required><button type=button id=toggle>Open options</button></div><div id=choices role=listbox hidden><div role=option>Job board</div><div role=option>Referral</div></div></div>
      <button>Submit Application</button><script>const c=document.querySelector('#choice'),p=document.querySelector('#choices');window.opens=0;document.querySelector('#toggle').onclick=()=>{window.opens++;c.setAttribute('aria-expanded','true');p.hidden=false;};p.onclick=e=>{c.value=e.target.textContent;e.target.setAttribute('aria-selected','true');c.setAttribute('aria-expanded','false');p.hidden=true;};</script>`}));
    await page.goto(url);const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',application_source:'Referral'});
    await fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await page.locator('#choice').inputValue(),'Referral');assert.equal(await page.evaluate('opens'),1);
    await page.reload();
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#choice')!;
      const old = input.closest('.ashby-application-form-field-entry')!;
      const group = document.createElement('fieldset');
      group.append(...old.childNodes);
      old.replaceWith(group);
      input.required = false;
      const label = group.querySelector('label')!;
      label.htmlFor = 'unmounted-component';
      label.className = 'ashby-application-form-question-title _required_fixture_91';
    });
    const sourceField = async () => (await inspectHostedFields(page)).find(field=>field.kind==='combobox');
    assert.equal((await sourceField())?.label, 'How did you hear about us?');
    assert.equal((await sourceField())?.required, true);
    await assert.rejects(hostedReviewSnapshot(page), /Required or invalid fields/);
    await fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await page.locator('#choice').inputValue(),'Referral');
    const fieldset = page.locator('fieldset');
    await fieldset.evaluate(e=>e.append(document.createElement('input')));
    await assert.rejects(inspectHostedFields(page), /ambiguous controls/);
    await fieldset.locator(':scope > input').evaluate(e=>e.remove());
    await fieldset.locator('label').evaluate(e=>e.classList.remove('_required_fixture_91'));
    assert.equal((await sourceField())?.required,false);
    await fieldset.locator('label').evaluate(e=>e.classList.add('_required_fixture_91'));
    await fieldset.evaluate(e=>{
      e.setAttribute('class','ashby-application-form-field-entry');
      e.setAttribute('data-field-entry-id','owned');
      e.setAttribute('data-field-path','owned');
      const wrapper=document.createElement('div');
      const label=e.querySelector('label')!;
      label.replaceWith(wrapper);
      wrapper.append(label);
    });
    assert.equal((await sourceField())?.required,true);
    await page.locator('#choice').fill('');await page.locator('#toggle').evaluate(e=>e.after(e.cloneNode(true)));
    await assert.rejects(fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{}),/opener is ambiguous/);
    assert.equal(await page.locator('#choice').inputValue(),'');
    await page.reload();
    await page.locator('label[for=choice]').evaluate(e=>{e.textContent='How did you hear about Example Employer?';});
    await page.locator('#choices').evaluate(e=>{e.innerHTML='<div role=option>Company Website</div><div role=option>Job Board</div><div role=option>LinkedIn</div>';});
    await page.evaluate(id=>{
      const data=document.createElement('script');
      data.type='application/ld+json';
      data.textContent=JSON.stringify({'@type':'JobPosting',identifier:{value:id},hiringOrganization:{'@type':'Organization',name:'Example Employer'}});
      document.head.append(data);
    },id);
    const defaults=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'});
    await fillApplication(page,{url,profile:defaults,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await page.locator('#choice').inputValue(),'Job Board');
  }finally{await browser.close();}
});

test('Greenhouse upload acknowledgement survives unrelated edits but not replacement or reload',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage(),url='https://job-boards.greenhouse.io/fixture/jobs/12345';
    const file={name:'Resume.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-receipt-fixture')};
    const sha=createHash('sha256').update(file.buffer).digest('hex'),md5=createHash('md5').update(file.buffer).digest('hex');
    let wrongEtag=false,duplicateUpload=false,reloadOnUpload=false,restored=false;
    await page.route('**/*',async route=>{
      if(route.request().url().includes('.amazonaws.com')){if(reloadOnUpload)restored=true;return route.fulfill({status:201,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/xml',body:`<PostResponse><ETag>"${wrongEtag?'0'.repeat(32):md5}"</ETag></PostResponse>`});}
      return route.fulfill({contentType:'text/html',body:`<label>Email<input type=email value="fixture@example.invalid" required></label>
        <div role=group aria-labelledby=upload-label-resume>${restored?'<span>Resume.pdf</span><button aria-label="Remove file">Remove</button>':'<span id=upload-label-resume>Resume</span><input type=file>'}</div><button>Submit application</button>
        <script>const field=document.querySelector('input[type=file]');if(field)field.onchange=async function(){const data=new FormData();data.append('file',this.files[0]);${duplicateUpload?"void fetch('https://grnhse-prod-jben-us-west-2.s3.us-west-2.amazonaws.com/unrelated',{method:'POST',body:data});":''}await fetch('https://grnhse-prod-jben-us-west-2.s3.us-west-2.amazonaws.com/',{method:'POST',body:data});${reloadOnUpload?'setTimeout(()=>location.reload(),50);return;':''}this.parentElement.innerHTML='<span>Resume.pdf</span><button aria-label="Remove file">Remove</button>';};</script>`});
    });
    const upload=async()=>{await page.goto(url);return uploadGreenhouseResume(page,file);};
    let receipt=await upload();
    assert.equal(await verifiedGreenhouseResume(page,receipt,sha),true);
    assert.equal((await hostedReviewSnapshot(page,sha,true,receipt)).resumeExpected,true);
    await assert.rejects(hostedReviewSnapshot(page,sha),/resume field is missing/i);
    const root=await mkdtemp(join(tmpdir(),'hunt-gh-refresh-'));
    const queue=new ApplicationQueue(root,{connected:false,open:async()=>({tabId:1,page,browser:{close:async()=>{}} as typeof browser}),release:async()=>{}});
    try {
      queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),file.buffer.toString('base64'));
      const [job]=queue.add([{url}]);
      Object.assign(job!,{status:'review',tabId:1,reviewUrl:url,resumeExpected:true,resumeUpload:receipt});
      await queue.action(job!.id,'refresh_review');
      assert.equal(job!.status,'review');
      await page.locator('[role=group] span').evaluate(e=>e.replaceWith(e.cloneNode(true)));
      await assert.rejects(queue.action(job!.id,'refresh_review'),/resume field is missing/i);
      assert.equal(job!.status,'paused');
    } finally {await queue.close();await rm(root,{recursive:true,force:true});}
    receipt=await upload();
    await page.evaluate(()=>document.body.append(document.createElement('aside')));
    assert.equal(await verifiedGreenhouseResume(page,receipt,sha),true);
    assert.equal(await verifiedGreenhouseResume(page,receipt,'0'.repeat(64)),false);
    await page.locator('[role=group] span').evaluate(e=>e.replaceWith(e.cloneNode(true)));
    assert.equal(await verifiedGreenhouseResume(page,receipt,sha),false);
    receipt=await upload();
    await page.locator('[role=group]').evaluate(e=>{const parent=e.parentElement!;e.remove();parent.append(e);});
    assert.equal(await verifiedGreenhouseResume(page,receipt,sha),false);
    receipt=await upload();await page.reload();
    assert.equal(await verifiedGreenhouseResume(page,receipt,sha),false);
    wrongEtag=true;
    await assert.rejects(upload(),/not confirmed/i);
    wrongEtag=false;duplicateUpload=true;
    await assert.rejects(upload(),/not confirmed|changed during upload/i);
    duplicateUpload=false;reloadOnUpload=true;
    await assert.rejects(upload());
    assert.equal(restored,true);
  } finally {await browser.close();}
});
test('restored Workable optional attachments are preserved and required uploads verify the selected PDF',async(t)=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try {
    const p=await b.newPage(),url='https://apply.workable.com/fixture/j/ABC123/apply/';
    await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`
      <label>Email<input type=email required></label>
      <div data-role=dropzone><span id=resume-heading>Resume</span>
      <label id=replace role=button tabindex=0 for=attachment-file onclick="window.replacing=true">Replace file</label>
      <input id=attachment-file data-ui=resume type=file name=attachment aria-labelledby="resume-heading replace">
      <a data-action=view href="/old-resume.pdf">View Resume.pdf</a></div>
      <label>Cover letter<input type=file name=cover></label>
      <button onclick="window.submits++">Submit application</button><script>window.submits=0</script>`}));
    await p.goto(url);
    await p.locator('[name=attachment]').setInputFiles({name:'Resume.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-old-resume')});
    await p.locator('[name=cover]').setInputFiles({name:'Cover.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-existing-cover')});
    const observed=(await inspectHostedFields(p)).find(f=>f.name==='attachment');
    assert.equal(observed?.label,'Resume Replace file');assert.equal(observed?.required,false);
    const resume=Buffer.from('%PDF-new-server-selected-resume');
    const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'});
    await assert.rejects(fillApplication(p,{url,profile,resume},AbortSignal.timeout(15000),()=>{}),/attached resume does not match/i);
    assert.equal(await p.locator('[name=attachment]').evaluate(async(e:HTMLInputElement)=>e.files![0]!.text()),'%PDF-old-resume');
    assert.equal(await p.locator('[data-action=view]').getAttribute('href'),'/old-resume.pdf');
    assert.equal(await p.locator('[name=cover]').evaluate(async(e:HTMLInputElement)=>e.files![0]!.text()),'%PDF-existing-cover');
    assert.equal(await p.evaluate('window.replacing'),undefined);assert.equal(await p.evaluate('submits'),0);
    await p.reload();
    await p.locator('[name=attachment]').evaluate((e:HTMLInputElement)=>{
      e.required=true;e.parentElement!.querySelector('[data-action=view]')!.remove();
      e.onchange=()=>{const link=document.createElement('a');link.dataset.action='view';link.href='/first-upload.pdf';link.textContent='View resume';e.parentElement!.append(link);};
    });
    let previewReads=0;
    let previewStatus=200;
    let redirect=false;
    let contentType='application/pdf';
    let replaceLink=false;
    await p.route('**/first-upload.pdf',async route=>{
      previewReads++;
      if(replaceLink)await p.locator('[data-action=view]').evaluate(e=>e.replaceWith(e.cloneNode(true)));
      if(redirect)await route.fulfill({status:302,headers:{location:'/login'}});
      else await route.fulfill({status:previewStatus,contentType,body:contentType==='text/html'?'Sign in':resume});
    });
    let loginReads=0;
    await p.route('**/login',route=>{loginReads++;return route.fulfill({contentType:'text/html',body:'Login'});});
    const anonymous=t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:403}));
    let uploadChanges=0;
    await p.exposeFunction('recordUpload',()=>{uploadChanges++;});
    await p.locator('[name=attachment]').evaluate(e=>e.addEventListener('change',()=>(window as any).recordUpload()));

    const initial=await fillApplication(p,{url,profile,resume},AbortSignal.timeout(15000),()=>{});
    assert.equal(initial.resumeExpected,true);
    assert.equal(await p.locator('[name=attachment]').evaluate(async(e:HTMLInputElement)=>e.files![0]!.text()),resume.toString());
    assert.equal(await p.locator('[name=attachment]').evaluate((e:HTMLInputElement)=>e.files![0]!.name),`Resume-${createHash('sha256').update(resume).digest('hex').slice(0,12)}.pdf`);
    assert.equal(await p.locator('[data-action=view]').getAttribute('href'),'/first-upload.pdf');
    assert.equal(previewReads,1);
    assert.equal(uploadChanges,1);
    await p.locator('[type=email]').fill('');
    await assert.rejects(fillApplication(p,{url,profile,resume:Buffer.from('%PDF-another-selection')},AbortSignal.timeout(15000),()=>{}),/preview does not confirm/i);
    assert.equal(await p.locator('[type=email]').inputValue(),'');
    assert.equal(await p.locator('[name=attachment]').evaluate(async(e:HTMLInputElement)=>e.files![0]!.text()),resume.toString());
    for(const status of [403,503]) {
      previewStatus=status;
      await p.locator('[type=email]').fill('');
      const before:number=previewReads;
      let observed=false,verified=false;
      await assert.rejects(fillApplication(p,{url,profile,resume,onResumeObserved:()=>{observed=true;},onResumeUpload:()=>{verified=true;}},AbortSignal.timeout(15000),()=>{}),/preview could not be verified/);
      assert.equal(observed,true);
      assert.equal(verified,false);
      await assert.rejects(hostedReviewSnapshot(p, createHash('sha256').update(resume).digest('hex'), true), /preview has not been verified/);
      await assert.rejects(reviewDigest(p), /preview has not been verified/);
      assert.equal(previewReads,before+1);
      assert.equal(await p.locator('[type=email]').inputValue(),'fixture@example.invalid');
    }
    previewStatus=200; contentType='text/html';
    await assert.rejects(fillApplication(p,{url,profile,resume},AbortSignal.timeout(15000),()=>{}),/preview could not be verified/);
    contentType='application/pdf';
    redirect=true;
    await assert.rejects(fillApplication(p,{url,profile,resume},AbortSignal.timeout(15000),()=>{}),/preview could not be verified/);
    assert.equal(loginReads,0);
    assert.equal(anonymous.mock.callCount(),0);
    redirect=false; replaceLink=true;
    await assert.rejects(fillApplication(p,{url,profile,resume},AbortSignal.timeout(15000),()=>{}),/resume changed during verification/);
    await p.locator('[data-action=view]').evaluate((a:HTMLAnchorElement)=>a.href='https://fixture-cdn.invalid/selected.pdf');
    await assert.rejects(fillApplication(p,{url,profile,resume},AbortSignal.timeout(15000),()=>{}),/preview could not be verified/);
    assert.equal(anonymous.mock.callCount(),1);
    assert.equal(uploadChanges,1);
    assert.equal(await p.evaluate('submits'),0);
  } finally {await b.close();}
});

test('first fill retains resume expectation when the employer removes its file input',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try {
    const p=await b.newPage(),url=`https://jobs.lever.co/fixture/${id}/apply`;
    await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<label>Email<input type=email required></label>
      <label>Resume<input type=file required onchange="setTimeout(()=>this.remove(),100)"></label>
      <button onclick="window.submits++">Submit application</button><script>window.submits=0</script>`}));
    await p.goto(url);
    let resumeExpected=false;
    const input={url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),resume:Buffer.from('%PDF-fixture'),onResumeObserved:()=>{resumeExpected=true;}};
    await assert.rejects(fillApplication(p,input,AbortSignal.timeout(15000),()=>{}),/selected resume attachment could not be verified/i);
    assert.equal(resumeExpected,true);
    await assert.rejects(fillApplication(p,{...input,resumeExpected},AbortSignal.timeout(15000),()=>{}),/resume field is missing/i);
    assert.equal(await p.evaluate('submits'),0);
  } finally { await b.close(); }
});

test('Ashby nested optional consent stays separate from required Phone and legal name uses saved identity',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try {
    const p=await b.newPage();const url=`https://jobs.ashbyhq.com/fixture/${id}/application`;
    await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`
      <label>Legal Name<input name=name required></label><label>Email<input name=email type=email required></label>
      <div class=ashby-application-form-field-entry><label class="ashby-application-form-question-title _required_fixture">Phone<input name=phone required></label>
        <div class=ashby-application-form-texting-consent-description><ul>${['SMS text','WhatsApp'].map((channel,i)=>`<li class=_consentRadioGroupItem_fixture><p>Receive ${channel} messages</p><div class=_consentRadioGroup_fixture>
          <label><input type=radio name=consent${i} value=yes>Yes - I consent to receiving ${channel} messages</label>
          <label><input type=radio name=consent${i} value=no>No - I do not consent to receiving ${channel} messages</label>
        </div></li>`).join('')}</ul></div>
      </div><button onclick="window.submits++">Submit application</button><script>window.submits=0</script>`}));
    await p.goto(url);
    const fields=await inspectHostedFields(p), radios=fields.filter(f=>f.kind==='radio');
    assert.equal(fields.find(f=>f.name==='phone')?.required,true);
    assert.deepEqual(radios.map(f=>[f.label,f.required]),[['Receive SMS text messages',false],['Receive WhatsApp messages',false]]);
    const input={url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',phone_number:'4035550100'}),resume:Buffer.from('%PDF-fixture')};
    await fillApplication(p,input,AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('[name=name]').inputValue(),'Fixture Applicant');
    assert.equal(await p.locator('input[type=radio]:checked').count(),0);
    await p.locator('[name=consent1][value=no]').check();
    await fillApplication(p,input,AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('[name=consent1][value=no]').isChecked(),true);
    await p.locator('[name=consent0]').evaluateAll(es=>es.forEach(e=>(e as HTMLInputElement).required=true));
    await assert.rejects(fillApplication(p,input,AbortSignal.timeout(15000),()=>{}), /requires a consent decision/);
    assert.equal(await p.locator('[name=consent0]:checked').count(),0);
    assert.equal(await p.locator('[name=consent1][value=no]').isChecked(),true);
    assert.equal(await p.evaluate('submits'),0);
  } finally { await b.close(); }
});

test('hosted targets preserve job and employer identities and reject unrelated origins',()=>{
  for(const host of ['jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com']) {
    const a=applicationTarget(`https://${host}/one/${id}`);
    assert.equal(a.key,applicationTarget(`https://${host}/one/${id}/application?source=test`).key);
    assert.notEqual(a.key,applicationTarget(`https://${host}/two/${id}`).key);
  }
  for(const url of ['https://jobs.lever.co.evil.test/one/'+id,'https://jobs.lever.co/','http://jobs.lever.co/one/'+id,Object.assign(new URL('https://jobs.ashbyhq.com/one/'+id), {username:'user'}).href,'https://jobs.ashbyhq.com/one%2ftwo/'+id])assert.throws(()=>applicationTarget(url));
  assert.equal(applicationTarget('https://job-boards.greenhouse.io/test/jobs/123').key,applicationTarget('https://boards.greenhouse.io/test/jobs/123').key);
  assert.equal(applicationTarget('https://apply.workable.com/one/j/ABC123/apply/').key,applicationTarget('https://apply.workable.com/one/j/ABC123').key);
  assert.throws(()=>applicationTarget('https://apply.workable.com.evil.test/one/j/ABC123'));
  assert.equal(applicationTarget('https://test.wd1.myworkdayjobs.com/Test/job/City/Job_R1/apply').key,'test.wd1.myworkdayjobs.com/Job_R1');
});

test('hosted fill answers owned radio groups and never submits; edits invalidate review',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try{
    const p=await b.newPage();const url=`https://jobs.lever.co/fixture/${id}/apply`;
    await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<label>Full name<input name=name required></label><label>Email<input name=email type=email required></label>
      <div><div class=application-label>Languages spoken</div><div class=application-field><ul data-qa=checkboxes><li><label><input type=checkbox name=languages value=English required>English</label></li><li><label><input type=checkbox name=languages value=Spanish required>Spanish</label></li></ul></div></div>
      <fieldset><legend>Will you require sponsorship?</legend><label><input type=radio name=sponsor value=Yes required>Yes</label><label><input type=radio name=sponsor value=No required>No</label></fieldset>
      <button onclick="window.submits++">Submit application</button><script>window.submits=0</script>`}));
    await p.goto(url);
    const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',languages:'English',sponsorship_required:'false'});
    const result=await fillApplication(p,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('[name=name]').inputValue(),'Fixture Applicant');
    assert.equal(await p.locator('input[type=radio]:checked').inputValue(),'No');
    assert.equal(await p.locator('input[type=checkbox]:checked').count(),1,'a required choice group must not select every option');
    assert.equal(await p.evaluate('submits'),0);
    await p.locator('[name=name]').fill('Edited');assert.notEqual(await reviewDigest(p),result.reviewDigest);
    await assert.rejects(submitReviewedApplication(p,result.reviewDigest),/not enabled/);
    await p.locator('[name=email]').fill('');await assert.rejects(reviewDigest(p),/Required/);
    await p.locator('legend').evaluate(e=>{e.textContent='Background checks may be required. '.repeat(20)+'By submitting my application, I confirm that I have read and understood this information.';});
    await p.locator('input[type=radio]').evaluateAll(es=>es.forEach(e=>(e as HTMLInputElement).checked=false));
    await assert.rejects(fillApplication(p,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{}),/requires a consent decision/);
    assert.equal(await p.locator('input[type=radio]:checked').count(),0);
    await p.locator('fieldset').evaluate(e=>{e.innerHTML='<input role="combobox" aria-label="Applicant Privacy Notice" aria-required="true" onclick="window.consentClicks=(window.consentClicks||0)+1">';});
    await assert.rejects(fillApplication(p,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{}),/dropdown did not expose its choices/i);
    assert.ok(await p.evaluate('window.consentClicks>0'));
    assert.equal(await p.evaluate('submits'),0);
  }finally{await b.close();}
});

test('custom required buttons and one-of questions must be answered before review',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try{
    const p=await b.newPage();const url=`https://jobs.ashbyhq.com/fixture/${id}/application`;
    await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<label>Name<input required></label><label>Email<input type=email required></label>
      <div class=ashby-application-form-field-entry><label class=_required_fixture>Will you require sponsorship?</label><div class=ashby-application-form-input-yesno><button data-option=yes aria-pressed=false>Yes</button><button data-option=no aria-pressed=false>No</button></div></div>
      <section class=ashby-application-form-section-container><h2>Answer 1 of 3 Questions</h2><label>Brief interest statement<textarea></textarea></label><label>Describe a challenge<textarea></textarea></label><label>Describe your interests<textarea></textarea></label></section>
      <button onclick="window.submits++">Submit Application</button><script>window.submits=0;document.querySelectorAll('[data-option]').forEach(b=>b.onclick=()=>{b.parentElement.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)))});</script>`}));
    await p.goto(url);await assert.rejects(reviewDigest(p));
    await fillApplication(p,{url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',sponsorship_required:'false',configured_narrative:'Fixture interest statement.'}),resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('[aria-pressed=true]').textContent(),'No');
    assert.equal(await p.locator('textarea').first().inputValue(),'Fixture interest statement.');
    assert.equal(await p.locator('textarea').evaluateAll(es=>es.filter(e=>(e as HTMLTextAreaElement).value).length),1);
    assert.equal(await p.evaluate('submits'),0);
    await p.locator('[aria-pressed=true]').evaluate(e=>e.setAttribute('aria-pressed','false'));
    await assert.rejects(reviewDigest(p),/Required/);
    // Ashby can render a single title with a generated for-attribute that has no DOM target.
    await p.setContent(`<label>Email<input name=email type=email value="fixture@example.invalid" required></label>
      <div class="ashby-application-form-field-entry" data-field-path="fixture.binary" data-field-entry-id="binary">
        <label class="ashby-application-form-question-title _required_fixture" for="unmounted-binary">Will you require sponsorship?</label>
        <div class="ashby-application-form-input-yesno">
          <button type=button data-option=yes aria-pressed=false>Yes</button><button type=button data-option=no aria-pressed=false>No</button>
          <input name=question type=checkbox hidden></div><input role=combobox hidden></div>
      <div class="ashby-application-form-field-entry" data-field-path="fixture.source" data-field-entry-id="source">
        <fieldset><label class="ashby-application-form-question-title _required_fixture" for="unmounted-source">How did you hear about us?</label>
          <input role=combobox aria-expanded=false aria-controls=choices><button type=button>Options</button>
          <div id=choices role=listbox hidden><div role=option>Job board</div></div><input id=source-copy role=combobox hidden><label id=title-copy class="ashby-application-form-question-title" for="missing-copy" hidden>Other question</label></fieldset></div>
      <div class="ashby-application-form-field-entry" data-field-path="fixture.optional" data-field-entry-id="optional">
        <label class="ashby-application-form-question-title" for="unmounted-optional">Optional preference</label>
        <input role=combobox></div>
      <button type=button onclick="window.submits++">Submit Application</button>
      <script>window.submits=0;const q=document.querySelector('input[aria-controls=choices]'),options=document.querySelector('#choices');
      q.onclick=()=>{options.hidden=false;q.setAttribute('aria-expanded','true')};
      options.onclick=()=>{q.value='Job board';options.firstElementChild.setAttribute('aria-selected','true');q.setAttribute('aria-expanded','false');options.hidden=true};
      document.querySelectorAll('[data-option]').forEach(b=>b.onclick=()=>{b.parentElement.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));b.parentElement.querySelector('input').checked=b.dataset.option==='yes'});</script>`);
    await assert.rejects(reviewDigest(p),/Required/);
    const observed = await inspectHostedFields(p);
    assert.deepEqual(observed.filter(f=>['buttons','combobox'].includes(f.kind)).map(f=>[f.label,f.required]),
      [['Will you require sponsorship?',true],['How did you hear about us?',true],['Optional preference',false]]);
    const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',sponsorship_required:'false',application_source:'Job board'});
    await fillApplication(p,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('button[data-option=no]').getAttribute('aria-pressed'),'true');
    assert.equal(await p.locator('input[type=checkbox]').isChecked(),false);
    await p.locator('#source-copy').evaluate(e=>e.removeAttribute('hidden'));
    await assert.rejects(reviewDigest(p),/ambiguous/i);
    await p.locator('[data-field-entry-id=source]').evaluate(entry=>{
      entry.querySelector('label')!.classList.remove('_required_fixture');
      const marker=document.createElement('span');
      marker.className='ashby-application-form-field-required';
      marker.textContent='*';
      entry.prepend(marker);
    });
    await assert.rejects(reviewDigest(p),/ambiguous/i);
    await p.locator('#source-copy').evaluate(e=>e.setAttribute('hidden',''));
    assert.equal((await inspectHostedFields(p)).find(field=>field.label==='How did you hear about us?')?.required,true);
    await p.locator('#title-copy').evaluate(e=>e.removeAttribute('hidden'));
    await assert.rejects(reviewDigest(p),/ambiguous/i);
    await p.locator('#title-copy').evaluate(e=>e.setAttribute('hidden',''));
    await p.locator('[data-field-entry-id=optional]').evaluate(e=>document.querySelector('[data-field-entry-id=source]')!.append(e));
    const optional = p.locator('[data-field-entry-id=optional] input');
    assert.equal(await optional.inputValue(),'');
    await reviewDigest(p);
    await optional.evaluate(e=>e.setAttribute('aria-invalid','true'));
    await assert.rejects(reviewDigest(p),/invalid/);
    await optional.evaluate((e:HTMLInputElement)=>{e.removeAttribute('aria-invalid');e.setCustomValidity('Invalid answer')});
    await assert.rejects(reviewDigest(p),/invalid/);
    await optional.evaluate((e:HTMLInputElement)=>e.setCustomValidity(''));
    await reviewDigest(p);
    await p.locator('input[aria-controls=choices]').evaluate((e:HTMLInputElement)=>{e.value='Job board';document.querySelector('#choices [role=option]')!.removeAttribute('aria-selected')});
    await assert.rejects(reviewDigest(p),/Required/);
    await p.locator('#choices [role=option]').evaluate(e=>e.setAttribute('aria-selected','true'));
    await p.locator('input[type=checkbox]').evaluate((e:HTMLInputElement)=>{e.checked=true});
    await assert.rejects(reviewDigest(p),/Required/);
    await assert.rejects(fillApplication(p,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(5000),()=>{}),/inconsistent choice/);
    assert.equal(await p.locator('input[type=checkbox]').isChecked(),true);
    await p.locator('[data-field-entry-id=binary] label').evaluate(label=>label.classList.remove('_required_fixture'));
    await assert.rejects(reviewDigest(p),/invalid/);
    assert.equal(await p.evaluate('submits'),0);
  }finally{await b.close();}
});


test('Workable ARIA choices use group labels and selected UI state, not native proxy state',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try{
    const p=await b.newPage();const url='https://apply.workable.com/fixture/j/ABC123/apply/';
    await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`
      <label>Name<input required></label><label>Email<input type=email required></label>
      <span id=sponsor>Will you require sponsorship? *</span><fieldset role=radiogroup aria-labelledby=sponsor>
        <div role=radio aria-checked=false><label><input aria-hidden=true type=radio name=sponsor value=yes required>Yes</label></div>
        <div role=radio aria-checked=false><label><input aria-hidden=true type=radio name=sponsor value=no required>No</label></div>
      </fieldset>
      <span id=related>Do you have any relatives currently employed by the company? *</span><div role=group data-ui=relations aria-labelledby=related>
        <label><div role=checkbox aria-checked=false><input aria-hidden=true type=checkbox required></div>No</label>
        <label><div role=checkbox aria-checked=false><input aria-hidden=true type=checkbox required></div>Yes</label>
      </div>
      <button onclick="window.submits++">Submit application</button><script>window.submits=0;
      document.querySelectorAll('[role=radio],[role=checkbox]').forEach(e=>e.closest('label')?.addEventListener('click',()=>{}));
      document.querySelectorAll('fieldset label').forEach(l=>l.onclick=e=>{e.preventDefault();document.querySelectorAll('[role=radio]').forEach(r=>{r.setAttribute('aria-checked',String(r===l.parentElement));r.querySelector('input').required=false;});});
      document.querySelectorAll('[role=checkbox]').forEach(c=>c.onclick=e=>{e.preventDefault();c.setAttribute('aria-checked','true');});
      </script>`}));
    await p.goto(url);
    const saved=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',sponsorship_required:'false'}) as {profile:{facts:unknown[];unsetFactIds:string[]}};
    const result=await fillApplication(p,{url,profile:{...saved,profile:{...saved.profile,facts:[...saved.profile.facts,{factId:'relatives_employed',value:false,provenance:'owner_provided',lane:'live_owner_fact'}],unsetFactIds:saved.profile.unsetFactIds.filter(x=>x!=='relatives_employed')}},resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('[role=radio][aria-checked=true]').count(),1);
    assert.equal(await p.locator('input[type=radio]:checked').count(),0);
    assert.equal(await p.locator('[role=checkbox][aria-checked=true]').count(),1);
    assert.equal(await p.evaluate('submits'),0);
    await p.locator('[role=checkbox][aria-checked=true]').evaluate(e=>e.setAttribute('aria-checked','false'));
    await assert.rejects(reviewDigest(p),/Required/);
    await assert.rejects(submitReviewedApplication(p,result.reviewDigest),/not enabled/);
  }finally{await b.close();}
});


test('hosted fill uses saved numeric salary, start date and exact radio after resume autofill', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = 'https://jobs.lever.co/fixture/' + id + '/apply';
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<form>
      <label>Resume<input id="resume" type="file" required></label>
      <label>First name<input id="first" required></label>
      <label>Email<input id="email" type="email" required></label>
      <label>Desired Annual Salary<input id="annual" type="number" min="1" max="999999" required></label>
      <label>What salary range are you targeting?<textarea id="range" required></textarea></label>
      <label>When are you looking to start?<input id="start" type="date" required></label>
      <fieldset><legend>How did you hear about PocketHealth?</legend>
        <label><input type="radio" name="source" required>LinkedIn</label>
        <label><input type="radio" name="source" required>Other</label>
      </fieldset><button onclick="window.submitted=true">Submit application</button></form>
      <script>document.querySelector('#resume').onchange=()=>{document.querySelector('#first').value='Parser value'};</script>` }));
    await page.goto(url);
    const profile = applicantProfile({ given_name: 'Saved', family_name: 'Applicant', email_address: 'saved@example.invalid',
      desired_salary: '90000', salary_expectations: 'CAD 90,000 to 100,000', earliest_start_date: '2027-01-04', application_source: 'LinkedIn' });
    const bytes = Buffer.from('%PDF-fixture exact selected');
    await fillApplication(page, { url, profile, resume: bytes }, AbortSignal.timeout(15000), () => {});
    assert.equal(await page.locator('#first').inputValue(), 'Saved');
    assert.equal(await page.locator('#annual').inputValue(), '90000');
    assert.equal(await page.locator('#range').inputValue(), 'CAD 90,000 to 100,000');
    assert.equal(await page.locator('#start').inputValue(), '2027-01-04');
    assert.equal(await page.getByRole('radio', { name: 'LinkedIn' }).isChecked(), true);
    assert.equal(await page.locator('#resume').evaluate(async (e: HTMLInputElement) => await e.files?.[0]?.text()), bytes.toString());
    assert.equal(await page.evaluate('window.submitted'), undefined);
  } finally {
    await browser.close();
  }
});

test('stored profile answers beat defaults across fresh applications and narrative revisions',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try{
    for(const current of [false,true]){
      const p=await b.newPage();const url=`https://jobs.lever.co/fixture/${id}/apply`;
      await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<label>First &amp; Last Name<input name=full required></label><label>Email Address<input type=email required></label><label>Prénom<input name=frfirst required></label><label>Nom de famille<input name=frlast required></label><label>Adresse e-mail<input name=fremail type=email required></label><label>Téléphone<input name=frphone required></label><div class=select__control><label for=referral>How did you hear about this job?</label><span class=select__multi-value__label>LinkedIn</span><span class=select__multi-value__label>Referral</span><input id=referral role=combobox aria-required=true></div><label>LinkedIn URL<input name=link required></label><label>Brief interest statement<textarea required></textarea></label><fieldset><legend>Do you currently work at Fixture?</legend><label><input type=radio name=current value=Yes required>Yes</label><label><input type=radio name=current value=No required>No</label></fieldset><button>${current?"Envoyer la candidature":"Submit application"}</button>`}));
      await p.goto(url);
      const profile=structuredClone(applicantProfile({given_name:'Stored',family_name:'Applicant',email_address:'stored@example.invalid',phone_number:'4035550100',linkedin_url:'https://www.linkedin.com/in/fixture-applicant'})) as {profile:{facts:unknown[];unsetFactIds:string[]}};
      const narrative=current?'Updated saved narrative.':'Original saved narrative.';
      profile.profile.facts.push({factId:'configured_narrative',value:narrative,provenance:'configured_template',lane:'live_owner_fact'},{factId:'current_associate',value:current,provenance:'owner_provided',lane:'live_owner_fact'});
      profile.profile.unsetFactIds=profile.profile.unsetFactIds.filter(x=>!['configured_narrative','current_associate'].includes(x));
      await fillApplication(p,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
      assert.equal(await p.locator('[name=full]').inputValue(),'Stored Applicant');
      assert.deepEqual(await p.locator('.select__multi-value__label').allTextContents(),['LinkedIn','Referral']);
      for(const [name,value] of Object.entries({frfirst:'Stored',frlast:'Applicant',fremail:'stored@example.invalid',frphone:'4035550100'}))assert.equal(await p.locator(`[name=${name}]`).inputValue(),value);
      assert.equal(await p.locator('textarea').inputValue(),narrative);
      assert.equal(await p.locator('input:checked').inputValue(),current?'Yes':'No');
      assert.equal(await p.locator('[name=link]').inputValue(),'https://www.linkedin.com/in/fixture-applicant');
      await p.close();
    }
  }finally{await b.close();}
});


test('generic partial fill preserves entries, skips credentials, and never submits',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try{
    const p=await b.newPage();await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<form><label>First name<input name=firstName required></label><label>Last name<input name=lastName required></label><label>Email<input type=email name=email required></label><input type=file><button onclick="window.submitted=true">Submit</button></form><form><label>Password<input type=password></label></form>'}));
    await p.goto('https://employer.example.test/apply');
    const profile=applicantProfile({given_name:'Stored',family_name:'Applicant',email_address:'stored@example.invalid'}) as {profile:unknown};
    const result=await fillGenericIdentityFields(p,profile.profile,AbortSignal.timeout(10000));
    assert.equal(result.status,'partial');assert.equal(result.filled.length,3);
    assert.equal(await p.locator('[name=firstName]').inputValue(),'Stored');
    assert.equal(await p.locator('[type=password]').inputValue(),'');assert.equal(await p.evaluate('window.submitted'),undefined);
    await p.locator('[name=firstName]').fill('Owner edit');
    assert.equal((await fillGenericIdentityFields(p,profile.profile,AbortSignal.timeout(10000))).filled.length,0);
    assert.equal(await p.locator('[name=firstName]').inputValue(),'Owner edit');
  }finally{await b.close();}
});
