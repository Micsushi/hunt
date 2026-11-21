import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillApplication } from '../../src/product/engine.ts';
import { inspectHostedFields } from '../../src/product/hosted-application.ts';
import { applicantProfile } from '../../src/product/sources.ts';

test('hosted labels exclude survey descriptions and requiredness stays with each control', async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    const url='https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111/apply';
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`
      <label>Name<input required></label><label>Email<input type="email" required></label>
      <div class="application-question">
        <label id="demographic" for="survey">Disability status</label>
        <p id="survey-instructions">Optional information. ${'Long employer description * '.repeat(35)}</p>
        <select id="survey" aria-labelledby="demographic survey-instructions" aria-describedby="survey-instructions">
          <option value="">Choose</option><option>Yes</option><option>No</option>
        </select>
        <div class="application-label">Are you legally entitled to work in Canada?</div>
        <div class="application-field full-width required-field"><select id="authorized" required><option value="">Choose</option><option>Yes</option><option>No</option></select></div>
      </div>
      <div class="application-question">
        <label for="bound-elsewhere">Are you legally entitled to work in Canada?</label>
        <div class="application-field"><select id="unrelated"><option value="">Choose</option><option>Yes</option><option>No</option></select></div>
      </div>
      <input id="bound-elsewhere" type="hidden">
      <label>Are you legally authorized to work for any employer in Canada and able to provide proof of such?
        <select id="qualified" required><option value="">Choose</option><option>Yes</option><option>No</option></select>
      </label>
      <label>Which U.S. State or Canadian Province do you reside in?
        <select id="region" required><option value="">Choose</option><option>Alberta</option><option>Ontario</option></select>
      </label>
      <label>How did you first learn about Affirm as an employer?
        <select id="source" required><option value="">Choose</option><option>LinkedIn</option><option>Indeed</option><option>Other</option></select>
      </label>
      <div class="application-field"><label>Race ${'Optional explanatory text * '.repeat(30)}
        <select name="eeo[race]" id="race"><option value="">Choose</option><option>Prefer not to say</option></select></label></div>
      <label>Wrapping asterisk only <span aria-hidden="true">*</span><select id="asterisk"><option value="">Choose</option><option>Yes</option></select></label>
      <label>Unknown required prompt ${'Full question text '.repeat(32)}<textarea id="unknown" required></textarea></label>
      <label>Preferred name<input id="preferred" required></label>
      <button onclick="window.submitted=true">Submit application</button>`}));
    await page.goto(url);
    const fields=await inspectHostedFields(page);
    assert.equal(fields.find(field=>field.label==='Disability status')?.required,false);
    assert.equal(fields.find(field=>field.label==='Race')?.required,false);
    assert.equal(fields.find(field=>field.label==='Wrapping asterisk only')?.required,true);
    await page.locator('label:has(#asterisk) [aria-hidden=true]').evaluate(marker=>{marker.textContent='✱'});
    assert.equal((await inspectHostedFields(page)).find(field=>field.label==='Wrapping asterisk only')?.required,true);
    assert.equal(fields.find(field=>field.label==='Are you legally entitled to work in Canada?')?.required,true);
    const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',
      preferred_name:'Saved',work_authorization_canada:'true',region:'Alberta',application_source:'Job board'});
    const review=await fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{});
    assert.equal(review.needsOwnerReview,true);
    assert.equal(await page.locator('#authorized').inputValue(),'Yes');
    assert.equal(await page.locator('#unrelated').inputValue(),'');
    assert.equal(await page.locator('#qualified').inputValue(),'Yes');
    assert.equal(await page.locator('#region').inputValue(),'Alberta');
    assert.equal(await page.locator('#source').inputValue(),'LinkedIn');
    assert.equal(await page.locator('#preferred').inputValue(),'Saved');
    assert.equal(await page.locator('#survey').inputValue(),'');
    assert.equal(await page.locator('#race').inputValue(),'');
    assert.ok(await page.locator('#unknown').inputValue());
    assert.equal(await page.evaluate('window.submitted'),undefined);
    await page.reload();
    const unscoped = applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',
      preferred_name:'Saved',work_authorization:'true'});
    const fallback=await fillApplication(page,{url,profile:unscoped,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{});
    assert.equal(fallback.needsOwnerReview,true);
    assert.equal(await page.locator('#authorized').inputValue(),'Yes');
    assert.equal(await page.locator('#qualified').inputValue(),'Yes');
    assert.equal(await page.evaluate('window.submitted'),undefined);
  } finally { await browser.close(); }
});
