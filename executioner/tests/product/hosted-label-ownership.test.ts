import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillApplication } from '../../src/product/engine.ts';
import { inspectHostedFields } from '../../src/product/hosted-application.ts';
import { applicantProfile } from '../../src/product/sources.ts';
import { fillVisibleFields } from '../../extension/generic-fill.js';

test('hosted labels exclude survey descriptions and requiredness stays with each control', async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    const url='https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111/apply';
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`
      <form><label>Name<input required></label><label>Email<input type="email" required></label>
      <li class="application-question resume"><label>
        <div class="application-label">Resume/CV<span class="required" role="img" aria-label="Required">*</span></div>
        <span class="help-icon" role="img" aria-label="PDF, DOCX"></span>
        <div class="application-field"><a class="visible-resume-upload" href="#"><span class="filename"></span><span class="default-label">Attach Resume/CV</span>
          <input type="file" id="resume-upload-input" name="resume" data-qa="input-resume" aria-describedby="resume-format parse-status" style="opacity:0"></a>
          <span class="resume-upload-failure" style="display:none">Couldn't auto-read resume.</span>
          <span id="parse-status" class="resume-upload-working" style="display:none">Analyzing resume...</span>
          <span class="resume-upload-success" style="display:none">Success!</span></div>
      </label><p id="resume-format">Accepted file types: PDF, DOCX. Maximum size: 10 MB.</p>
      <span class="resume-upload-oversize" hidden>File exceeds the maximum upload size of <b>100MB</b>. Please try a smaller size.</span></li>
      <span hidden id="other-document">Cover Letter</span>
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
      <button type="button" onclick="window.submitted=true">Submit application</button></form>`}));
    await page.goto(url);
    const fields=await inspectHostedFields(page);
    const resumeControl=page.locator('input[name=resume]');
    const resume=fields.find(field=>field.kind==='file');
    assert.equal(resume?.label,'Resume/CV');
    assert.equal(resume?.resumeTarget,true);
    assert.equal(resume?.required,true);
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
    assert.equal(await resumeControl.evaluate(async(e:HTMLInputElement)=>e.files?.[0]?.text()),'%PDF-fixture');
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

    await page.reload();
    await resumeControl.evaluate((input:HTMLInputElement)=>{
      input.addEventListener('change',()=>{
        input.closest('a')!.querySelector('.filename')!.textContent=input.files?.[0]?.name ?? '';
        (input.closest('label')!.querySelector('.resume-upload-success') as HTMLElement).style.display=input.files?.length?'':'none';
      });
    });
    const facts=[{factId:'given_name',value:'Fixture'},{factId:'family_name',value:'Applicant'},{factId:'email_address',value:'fixture@example.invalid'}];
    const fillPage = (replaceExistingResume=true) => page.evaluate(fillVisibleFields,{facts,
      resume:{name:'Resume.pdf',base64:Buffer.from('%PDF-current-page').toString('base64')},replaceExistingResume});
    const currentPage = await fillPage();
    assert.equal(currentPage.resume,'verified');
    assert.equal(await resumeControl.evaluate(async(e:HTMLInputElement)=>e.files?.[0]?.text()),'%PDF-current-page');
    assert.equal(await page.locator('.filename').textContent(),'Resume.pdf');
    assert.equal((await inspectHostedFields(page)).find(field=>field.kind==='file')?.resumeTarget,true);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await resumeControl.evaluate((e:HTMLInputElement)=>e.files!.length),0);
    for (const [selector,attribute,value] of [
      ['input[name=resume]','aria-label','Cover letter'],
      ['li.resume > label','aria-label','Cover letter'],
      ['li.resume > label','aria-labelledby','other-document'],
      ['li.resume > label','text','Cover letter only'],
      ['.filename','text','Upload your transcript'],
      ['.filename','aria-label','Cover letter'],
      ['.resume-upload-success','text','Attach your academic transcript'],
      ['.application-label .required','aria-label','Cover letter only'],
      ['.help-icon','aria-label','Cover letter only'],
      ['input[name=resume]','aria-describedby','resume-format other-document'],
      ['li.resume','text','Attach your cover letter here'],
    ] as const) {
      await page.reload();
      await page.locator(selector).evaluate((node,[attribute,value])=>{
        if (attribute==='text') { (node as HTMLElement).style.display=''; node.append(value); }
        else node.setAttribute(attribute,value);
      },[attribute,value] as const);
      const conflict=selector+' '+attribute;
      assert.equal((await inspectHostedFields(page)).find(field=>field.kind==='file')?.resumeTarget,false,conflict);
      if (selector==='.application-label .required' || selector==='.help-icon' || attribute==='aria-describedby' || selector==='li.resume') {
        await assert.rejects(fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{}),/additional attachment/);
        assert.equal(await resumeControl.evaluate((e:HTMLInputElement)=>e.files!.length),0,conflict);
      }
      assert.notEqual((await fillPage()).resume,'verified',conflict);
      assert.equal(await resumeControl.evaluate((e:HTMLInputElement)=>e.files!.length),0,conflict);
    }
    await resumeControl.setInputFiles({name:'Existing.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-existing')});
    assert.notEqual((await fillPage()).resume,'verified');
    await assert.rejects(fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{}),/additional attachment/);
    assert.equal(await resumeControl.evaluate(async(e:HTMLInputElement)=>e.files?.[0]?.text()),'%PDF-existing');

    await page.reload();
    const existing=Buffer.concat([Buffer.from('%PDF-existing'),Buffer.from([0,255])]);
    await resumeControl.setInputFiles({name:'Resume.pdf',mimeType:'application/pdf',buffer:existing});
    const selectedBytes=()=>resumeControl.evaluate(async(input:HTMLInputElement)=>
      Array.from(new Uint8Array(await input.files![0]!.arrayBuffer())));
    assert.equal((await inspectHostedFields(page)).find(field=>field.kind==='file')?.resumeTarget,true);
    const preserved=await fillPage(false);
    assert.equal(preserved.resume,'unverified');
    assert.ok(preserved.skipped.some(row=>row.reason==='existing_attachment_preserved'));
    assert.deepEqual(await selectedBytes(),[...existing]);
    await assert.rejects(fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{}),
      /selected resume attachment could not be verified/);
    assert.deepEqual(await selectedBytes(),[...existing]);
    const matching=await fillApplication(page,{url,profile,resume:existing},AbortSignal.timeout(12000),()=>{});
    assert.equal(matching.needsOwnerReview,true);
    assert.deepEqual(await selectedBytes(),[...existing]);
    assert.equal(await page.evaluate('window.submitted'),undefined);
  } finally { await browser.close(); }
});
