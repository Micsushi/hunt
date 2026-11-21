import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {ApplicationQueue} from '../../src/product/queue.ts';
import {applicantProfile} from '../../src/product/sources.ts';

test('explicit generic run uses the bound selected PDF, fills profile facts and pauses without advancing', {timeout:30000},async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage();let opens=0;
  const root=mkdtempSync(join(tmpdir(),'c3-generic-queue-'));
  const url='https://fixture.bamboohr.com/careers/123';
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<label>First name<input required name="first"></label><label>Email<input required name="email" type="email"></label><label>Current company<input required name="current_company" value="Other company"></label><label>Resume<input required type="file" accept=".pdf"></label><button onclick="window.advances++">Next</button><button onclick="window.submits++">Submit</button><script>window.advances=0;window.submits=0;</script>'}));
  await page.goto(url);
  const queue=new ApplicationQueue(root,{connected:true,open:async requested=>{opens++;assert.equal(requested,url);return {tabId:123,page,browser:{close:async()=>{}} as typeof browser};},release:async()=>{}});
  try {
    queue.configure(applicantProfile({given_name:'Saved',family_name:'Applicant',email_address:'fixture@example.invalid',current_company:'Saved company'}),Buffer.from('%PDF-default').toString('base64'));
    const selected=Buffer.from('%PDF-selected-version-17');
    const [job]=queue.add([{url,resumeBase64:selected.toString('base64'),resumeVersion:'17',sourceJobId:123}],{paused:true});
    assert.equal(opens,0);assert.equal(job!.status,'paused');
    await queue.action(job!.id,'retry');
    const end=Date.now()+15000;while(queue.snapshot().jobs[0]!.actionPending&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(job!.status,'paused');assert.equal(job!.submissionAllowed,false);assert.match(job!.error!,/Partial page fill/);assert.match(job!.error!,/Selected resume verified/);assert.match(job!.error!,/Current company: saved profile differs/);assert.equal(job!.error!.includes('Other company'),false);assert.equal(job!.error!.includes('Saved company'),false);
    assert.equal(await page.locator('[name="first"]').inputValue(),'Saved');
    const uploaded=await page.locator('input[type=file]').evaluate(async(element:HTMLInputElement)=>Array.from(new Uint8Array(await element.files![0]!.arrayBuffer())));
    assert.equal(createHash('sha256').update(Buffer.from(uploaded)).digest('hex'),createHash('sha256').update(selected).digest('hex'));
    assert.equal(await page.evaluate('advances'),0);assert.equal(await page.evaluate('submits'),0);
    assert.equal(queue.snapshot().jobs[0]!.actionPending,false);
    await queue.action(job!.id,'retry');
    const retryEnd=Date.now()+15000;while(queue.snapshot().jobs[0]!.actionPending&&Date.now()<retryEnd)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(queue.snapshot().jobs[0]!.actionPending,false);
    assert.match(job!.error!,/Current company: saved profile differs/);
    assert.doesNotMatch(job!.error!,/First name:|Email:|Resume: needs review/,'matching saved answers are not unresolved warnings');
    await page.locator('[name=first]').evaluate(e=>e.setAttribute('aria-invalid','true'));
    await queue.action(job!.id,'retry');
    const invalidEnd=Date.now()+15000;while(queue.snapshot().jobs[0]!.actionPending&&Date.now()<invalidEnd)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(queue.snapshot().jobs[0]!.actionPending,false);
    assert.match(job!.error!,/First name: site rejected the value/,'invalid matching values remain visible warnings');
    assert.equal(await page.evaluate('advances+submits'),0);
  }finally{await queue.close();await browser.close();}
});
