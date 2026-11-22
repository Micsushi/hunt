import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {fillVisibleFields} from '../../extension/generic-fill.js';
import {applicantProfile,effectiveProfileFacts} from '../../src/product/sources.ts';
import {fillMatchedPage} from '../../src/product/page-matching.ts';
import {prepareCurrentPage} from '../../src/product/current-page-workflow.ts';

test('Rippling final submission availability is read after the last fill across both workflows', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url='https://ats.rippling.com/fixture/jobs/68057679-c967-4707-9423-ea2db74de7c5/apply';
    const profile=applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid'});
    const facts=effectiveProfileFacts(profile), resume=Buffer.from('%PDF-fixture');
    await page.route(url, route=>route.fulfill({contentType:'text/html',body:`
      <form><label>First name<input required value="Test"></label><label>Email<input type="email" required value="test@example.invalid"></label>
        <label>Resume<input type="file"></label><button type="submit" aria-label="Apply for this position" aria-disabled="true">Apply</button></form>
      <script>window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++;};</script>`}));
    await page.goto(url);
    for (const labelSource of ['text','aria']) {
      const button=page.locator('button');
      await button.evaluate((control:HTMLButtonElement,labelSource)=>{
        const form=control.form!;
        form.id='selected-application';
        document.body.append(control);
        control.setAttribute('form',form.id);
        control.textContent=labelSource==='text'?'Submit':'';
        if(labelSource==='aria')control.setAttribute('aria-label','Submit');
        else control.removeAttribute('aria-label');
        control.disabled=true;
      }, labelSource);
      const report=await page.evaluate(fillVisibleFields,{action:'status' as const,scope:'page' as const,facts});
      assert.ok(report.skipped.some(item=>item.reason==='employer_submission_disabled'),labelSource);
      await button.evaluate(control=>{control.setAttribute('form','another-form');});
      const other=await page.evaluate(fillVisibleFields,{action:'status' as const,scope:'page' as const,facts});
      assert.equal(other.skipped.some(item=>item.reason==='employer_submission_disabled'),false,labelSource);
      await page.goto(url);
    }
    const raw=await page.evaluate(fillVisibleFields,{action:'fill' as const,facts});

    await assert.rejects(prepareCurrentPage(page,{url,profile,resume},AbortSignal.timeout(10000),()=>{}),/employer still has submission disabled/);
    for (const workflow of ['C3.1','C3.2'] as const) for (const disabled of [true,false]) {
      await page.goto(url);
      let writes=0;
      const report=await fillMatchedPage({url,profile,resume,workflow,signal:AbortSignal.timeout(10000),call:async(action,matchingPlans,matchingRunId)=>{
        if(action==='fill'){
          writes++;
          if(writes===5 && !disabled)await page.locator('button').evaluate(el=>el.removeAttribute('aria-disabled'));
        }
        const result=await page.evaluate(fillVisibleFields,{action,facts,matchingPlans,matchingRunId});
        if(action==='fill'&&writes<5)await page.locator('form').evaluate((form,i)=>{
          form.insertAdjacentHTML('beforeend',`<label>Additional field ${i}<input></label>`);
        },writes);
        return {...result};
      }});
      assert.equal(writes,5);
      assert.equal(report.skipped.some(item=>item.reason==='employer_submission_disabled'),disabled,workflow);
      assert.equal(await page.evaluate('window.submits'),0);
    }
    const settlingCases = [
      { staysDisabled: true, invalidEmail: false },
      { staysDisabled: false, invalidEmail: false },
      { staysDisabled: false, invalidEmail: true },
    ];
    for (const workflow of ['C3.1','C3.2'] as const) for (const { staysDisabled, invalidEmail } of settlingCases) {
      await page.goto(url);
      if (invalidEmail) await page.locator('input[type=email]').fill('invalid');
      let writes=0;
      const settled=await fillMatchedPage({url,profile,resume,workflow,signal:AbortSignal.timeout(10000),call:async(action,matchingPlans,matchingRunId)=>{
        const result=await page.evaluate(fillVisibleFields,{action,facts,matchingPlans,matchingRunId});
        if(action==='fill') {
          writes++;
          assert.ok(result.skipped.some(item=>item.reason==='employer_submission_disabled'));
          if (!staysDisabled) await page.evaluate(async()=>{await new Promise(resolve=>setTimeout(resolve,20));document.querySelector('button')!.removeAttribute('aria-disabled');});
        }
        return {...result};
      }});
      assert.equal(writes,1);
      assert.equal(settled.incomplete,staysDisabled || invalidEmail,JSON.stringify(settled.skipped));
      assert.equal(settled.skipped.some(item=>item.reason==='employer_submission_disabled'),staysDisabled);
      assert.equal(settled.needsOwnerReview,staysDisabled || invalidEmail);
      assert.equal(await page.evaluate('window.submits'),0);
    }
    await page.goto(url);
    await page.locator('button').evaluate(el=>Object.defineProperty(el,'innerText',{configurable:true,get(){throw new Error('readback interrupted');}}));
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'fill' as const,facts}),/readback interrupted/);
    await page.locator('button').evaluate(el=>Reflect.deleteProperty(el,'innerText'));
    const next=await page.evaluate(fillVisibleFields,{action:'fill' as const,facts});
    assert.ok(next.skipped.some(item=>item.reason==='employer_submission_disabled'));
    assert.ok(raw.incomplete && raw.skipped.some(item=>item.reason==='employer_submission_disabled'),'raw fill lost the disabled submit control');
  } finally {await browser.close();}
});
