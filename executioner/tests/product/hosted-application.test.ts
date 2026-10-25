import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {applicationTarget} from '../../src/product/target.ts';
import {fillApplication, reviewDigest, submitReviewedApplication} from '../../src/product/engine.ts';
import {fillGenericIdentityFields} from '../../src/product/generic-application.ts';
import {applicantProfile} from '../../src/product/sources.ts';

const id='11111111-1111-4111-8111-111111111111';
test('hosted targets preserve job and employer identities and reject unrelated origins',()=>{
  for(const host of ['jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com']) {
    const a=applicationTarget(`https://${host}/one/${id}`);
    assert.equal(a.key,applicationTarget(`https://${host}/one/${id}/application?source=test`).key);
    assert.notEqual(a.key,applicationTarget(`https://${host}/two/${id}`).key);
  }
  for(const url of ['https://jobs.lever.co.evil.test/one/'+id,'https://jobs.lever.co/','http://jobs.lever.co/one/'+id,'https://user@jobs.ashbyhq.com/one/'+id,'https://jobs.ashbyhq.com/one%2ftwo/'+id])assert.throws(()=>applicationTarget(url));
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
      <div><div class=application-label>Language skills (check all that apply)</div><div class=application-field><ul data-qa=checkboxes><li><label><input type=checkbox name=languages value=English required>English</label></li><li><label><input type=checkbox name=languages value=Spanish required>Spanish</label></li></ul></div></div>
      <fieldset><legend>Will you require sponsorship?</legend><label><input type=radio name=sponsor value=Yes required>Yes</label><label><input type=radio name=sponsor value=No required>No</label></fieldset>
      <button onclick="window.submits++">Submit application</button><script>window.submits=0</script>`}));
    await p.goto(url);
    const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.test'});
    const result=await fillApplication(p,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('[name=name]').inputValue(),'Fixture Applicant');
    assert.equal(await p.locator('input[type=radio]:checked').count(),1);
    assert.equal(await p.locator('input[type=checkbox]:checked').count(),1,'a required choice group must not select every option');
    assert.equal(await p.evaluate('submits'),0);
    await p.locator('[name=name]').fill('Edited');assert.notEqual(await reviewDigest(p),result.reviewDigest);
    await assert.rejects(submitReviewedApplication(p,result.reviewDigest),/not enabled/);
    await p.locator('[name=email]').fill('');await assert.rejects(reviewDigest(p),/Required/);
    assert.equal(await p.evaluate('submits'),0);
  }finally{await b.close();}
});

test('custom required buttons and one-of questions must be answered before review',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try{
    const p=await b.newPage();const url=`https://jobs.ashbyhq.com/fixture/${id}/application`;
    await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<label>Name<input required></label><label>Email<input type=email required></label>
      <div class=ashby-application-form-field-entry><label class=_required_fixture>Will you require sponsorship?</label><div class=ashby-application-form-input-yesno><button data-option=yes aria-pressed=false>Yes</button><button data-option=no aria-pressed=false>No</button></div></div>
      <section class=ashby-application-form-section-container><h2>Answer 1 of 3 Questions</h2><label>Describe a project<textarea></textarea></label><label>Describe a challenge<textarea></textarea></label><label>Describe your interests<textarea></textarea></label></section>
      <button onclick="window.submits++">Submit Application</button><script>window.submits=0;document.querySelectorAll('[data-option]').forEach(b=>b.onclick=()=>{b.parentElement.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)))});</script>`}));
    await p.goto(url);await assert.rejects(reviewDigest(p));
    await fillApplication(p,{url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.test'}),resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('[aria-pressed=true]').count(),1);
    assert.equal(await p.locator('textarea').evaluateAll(es=>es.filter(e=>(e as HTMLTextAreaElement).value).length),1);
    assert.equal(await p.evaluate('submits'),0);
    await p.locator('[aria-pressed=true]').evaluate(e=>e.setAttribute('aria-pressed','false'));
    await assert.rejects(reviewDigest(p),/Required/);
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
      <span id=related>Do you know anyone at this company? *</span><div role=group data-ui=relations aria-labelledby=related>
        <label><div role=checkbox aria-checked=false><input aria-hidden=true type=checkbox required></div>No</label>
        <label><div role=checkbox aria-checked=false><input aria-hidden=true type=checkbox required></div>Yes</label>
      </div>
      <button onclick="window.submits++">Submit application</button><script>window.submits=0;
      document.querySelectorAll('[role=radio],[role=checkbox]').forEach(e=>e.closest('label')?.addEventListener('click',()=>{}));
      document.querySelectorAll('fieldset label').forEach(l=>l.onclick=e=>{e.preventDefault();document.querySelectorAll('[role=radio]').forEach(r=>{r.setAttribute('aria-checked',String(r===l.parentElement));r.querySelector('input').required=false;});});
      document.querySelectorAll('[role=checkbox]').forEach(c=>c.onclick=e=>{e.preventDefault();c.setAttribute('aria-checked','true');});
      </script>`}));
    await p.goto(url);
    const result=await fillApplication(p,{url,profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.test'}),resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
    assert.equal(await p.locator('[role=radio][aria-checked=true]').count(),1);
    assert.equal(await p.locator('input[type=radio]:checked').count(),0);
    assert.equal(await p.locator('[role=checkbox][aria-checked=true]').count(),1);
    assert.equal(await p.evaluate('submits'),0);
    await p.locator('[role=checkbox][aria-checked=true]').evaluate(e=>e.setAttribute('aria-checked','false'));
    await assert.rejects(reviewDigest(p),/Required/);
    await assert.rejects(submitReviewedApplication(p,result.reviewDigest),/not enabled/);
  }finally{await b.close();}
});


test('stored profile answers beat defaults across fresh applications and narrative revisions',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try{
    for(const current of [false,true]){
      const p=await b.newPage();const url=`https://jobs.lever.co/fixture/${id}/apply`;
      await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<label>First &amp; Last Name<input name=full required></label><label>Email Address<input type=email required></label><label>LinkedIn URL<input name=link required></label><label>Brief interest statement<textarea required></textarea></label><fieldset><legend>Do you currently work at Example?</legend><label><input type=radio name=current value=Yes required>Yes</label><label><input type=radio name=current value=No required>No</label></fieldset><button>Submit application</button>`}));
      await p.goto(url);
      const profile=structuredClone(applicantProfile({given_name:'Stored',family_name:'Applicant',email_address:'stored@example.test'})) as {profile:{facts:unknown[];unsetFactIds:string[]}};
      const narrative=current?'Updated saved narrative.':'Original saved narrative.';
      profile.profile.facts.push({factId:'configured_narrative',value:narrative,provenance:'configured_template',lane:'live_owner_fact'},{factId:'current_associate',value:current,provenance:'owner_provided',lane:'live_owner_fact'});
      profile.profile.unsetFactIds=profile.profile.unsetFactIds.filter(x=>!['configured_narrative','current_associate'].includes(x));
      await fillApplication(p,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(15000),()=>{});
      assert.equal(await p.locator('[name=full]').inputValue(),'Stored Applicant');
      assert.equal(await p.locator('textarea').inputValue(),narrative);
      assert.equal(await p.locator('input:checked').inputValue(),current?'Yes':'No');
      assert.match(await p.locator('[name=link]').inputValue(),/^https:\/\//);
      await p.close();
    }
  }finally{await b.close();}
});


test('generic partial fill preserves entries, skips credentials, and never submits',async()=>{
  const b=await chromium.launch({headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
  try{
    const p=await b.newPage();await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<label>First name<input name=firstName></label><label>Last name<input name=lastName></label><label>Email<input type=email name=email></label><input type=file><label>Password<input type=password></label><button onclick="window.submitted=true">Submit</button>'}));
    await p.goto('https://employer.example.test/apply');
    const profile=applicantProfile({given_name:'Stored',family_name:'Applicant',email_address:'stored@example.test'}) as {profile:unknown};
    const result=await fillGenericIdentityFields(p,profile.profile,AbortSignal.timeout(10000));
    assert.equal(result.status,'partial');assert.equal(result.filled.length,3);
    assert.equal(await p.locator('[name=firstName]').inputValue(),'Stored');
    assert.equal(await p.locator('[type=password]').inputValue(),'');assert.equal(await p.evaluate('window.submitted'),undefined);
    await p.locator('[name=firstName]').fill('Owner edit');
    assert.equal((await fillGenericIdentityFields(p,profile.profile,AbortSignal.timeout(10000))).filled.length,0);
    assert.equal(await p.locator('[name=firstName]').inputValue(),'Owner edit');
  }finally{await b.close();}
});
