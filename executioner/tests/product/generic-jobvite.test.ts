import assert from 'node:assert/strict';
import test from 'node:test';
import {cpSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type Page} from 'playwright';
import {proveJobviteResumeInput} from '../../extension/jobvite-resume.js';
import {fillVisibleFields} from '../../extension/generic-fill.js';

const url='https://jobs.jobvite.com/fixture/job/123/apply';
const facts=[{factId:'given_name',value:'Fixture'},{factId:'email_address',value:'fixture@example.invalid'}];
const resume={name:'Resume.pdf',base64:Buffer.from('%PDF-selected-jobvite-fixture').toString('base64')};
const markup=(external=false,form=true)=>`<!doctype html><style>.ng-hide{display:none}input[type=file]{width:1px;height:1px;opacity:0;position:absolute}</style>
  ${form?'<form id="application">':'<main>'}<label>First name<input name="first" required></label><label>Email<input type="email" name="email" required></label>
  <div><h3 id="jv-resume-header">Add Resume*</h3><button id="resume-trigger" type="button" jv-add-attachment attachment-label="Resume" aria-labelledby="jv-resume-header" aria-haspopup="true" aria-expanded="false">Add Resume*</button></div>
  <div><h3 id="jv-cover-header">Add Cover Letter</h3><button id="cover-trigger" type="button" jv-add-attachment attachment-label="Cover Letter" aria-labelledby="jv-cover-header" aria-haspopup="true" aria-expanded="false">Add Cover Letter</button></div>
  <button type="button" onclick="window.submits++">Submit application</button>${form?'</form>':'</main>'}
  <div id="attachmentDropdown" role="dialog" aria-label="Attachment Options" aria-hidden="true" class="ng-hide"><label for="file-input-0"><span role="button">File</span></label><input id="file-input-0" type="file"><a href="#">Close</a></div>
  <div id="attachmentDropdown" role="dialog" aria-label="Attachment Options" aria-hidden="true" class="ng-hide"><label for="file-input-1"><span role="button">File</span></label><input id="file-input-1" type="file"><a href="#">Close</a></div>
  <script>window.submits=0;window.opens=0;window.uploads=0;
  const dialogs=[...document.querySelectorAll('[role=dialog]')],triggers=[document.getElementById('resume-trigger'),document.getElementById('cover-trigger')];
  window.openAttachment=i=>{triggers[i].setAttribute('aria-expanded','true');dialogs[i].setAttribute('aria-hidden','false');dialogs[i].className='jv-tooltip-top';};
  triggers.forEach((t,i)=>t.onclick=()=>{window.opens++;setTimeout(()=>window.openAttachment(i),40);});
  dialogs.forEach((d,i)=>d.querySelector('a').onclick=e=>{e.preventDefault();d.className='ng-hide';d.setAttribute('aria-hidden','true');triggers[i].setAttribute('aria-expanded','false');});
  document.getElementById('file-input-0').onchange=e=>{window.uploads++;if(${external}){e.target.value='';dialogs[0].querySelector('a').click();}};
  </script>`;
async function fixture(page:Page,external=false,form=true){await page.route(url,r=>r.fulfill({contentType:'text/html; charset=utf-8',body:markup(external,form)}));await page.goto(url);}
const proof=(page:Page)=>page.evaluate(proveJobviteResumeInput,{expectedUrl:url,expiresAt:Date.now()+3000});
const fill=(page:Page)=>page.evaluate(fillVisibleFields,{facts,resume,expectedUrl:url,expiresAt:Date.now()+5000});
const counts=(page:Page)=>page.locator('input[type=file]').evaluateAll(es=>es.map(e=>(e as HTMLInputElement).files!.length));

test('Jobvite portal transition binds Resume despite duplicate dialog IDs, with exact bytes and shared Undo/Redo',async()=>{
  const browser=await chromium.launch({headless:true});
  try {for(const form of [true,false]){
    const page=await browser.newPage();await fixture(page,false,form);
    await assert.rejects(page.evaluate(proveJobviteResumeInput,{expectedUrl:url,expiresAt:Date.now()-1}));
    assert.equal(await page.evaluate('opens'),0);
    if (form) {
      // The live first step has only Next, and its file chooser sits outside the form.
      await page.getByRole('button',{name:'Submit application'}).evaluate(button => { button.textContent='Next'; });
    }
    assert.equal(await proof(page),true);assert.deepEqual(await counts(page),[0,0]);
    const result=await fill(page);assert.equal(result.resume,'verified');assert.equal(result.resumeEvidence,'picker');assert.ok(result.filled.includes('Resume'));
    assert.deepEqual(await counts(page),[1,0]);assert.equal(await page.locator('#file-input-0').evaluate(async(e:HTMLInputElement)=>e.files![0]!.text()),'%PDF-selected-jobvite-fixture');
    await proof(page);await fill(page);assert.equal(await page.evaluate('uploads'),1);assert.equal(await page.evaluate('opens'),1);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});assert.deepEqual(await counts(page),[0,0]);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.deepEqual(await counts(page),[1,0]);
    await page.reload();
    assert.equal(await proof(page),true);
    await page.locator('#file-input-0').setInputFiles({name:'Manual.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-manual')});
    const manual=await fill(page);assert.equal(manual.resume,'unverified');assert.ok(manual.skipped.some(item=>item.reason==='existing_attachment_preserved'));
    assert.equal(await page.locator('#file-input-0').evaluate((e:HTMLInputElement)=>e.files![0]!.name),'Manual.pdf');
    assert.equal(await page.evaluate('submits'),0);await page.close();
  }} finally {await browser.close();}
});

test('Jobvite refuses an open cover menu, ambiguous file binding, and trigger/context replacement',async()=>{
  const browser=await chromium.launch({headless:true});
  try {for(const mode of ['cover-open','ambiguous','wrong-label','trigger-replaced','context-edited','input-remounted']){
    const page=await browser.newPage();await fixture(page);
    await page.evaluate(mode=>{
      const input=document.getElementById('file-input-0')!,trigger=document.getElementById('resume-trigger')!;
      if(mode==='cover-open')(window as any).openAttachment(1);
      if(mode==='ambiguous'){const other=document.createElement('input');other.type='file';input.parentElement!.append(other);}
      if(mode==='wrong-label')input.parentElement!.querySelector('label')!.htmlFor='file-input-1';
      if(mode==='trigger-replaced')trigger.addEventListener('click',()=>setTimeout(()=>trigger.replaceWith(trigger.cloneNode(true)),10));
    },mode);
    const accepted=await proof(page);
    if(mode==='context-edited')await page.locator('#resume-trigger').evaluate(e=>e.setAttribute('attachment-label','Cover Letter'));
    if(mode==='input-remounted')await page.locator('#file-input-0').evaluate(e=>e.replaceWith(e.cloneNode()));
    if(!['context-edited','input-remounted'].includes(mode))assert.equal(accepted,false,mode);
    const result=await fill(page);assert.equal(result.resume,'missing',mode);assert.ok((await counts(page)).every(n=>n===0),mode);
    assert.equal(await page.evaluate('submits'),0);await page.close();
  }} finally {await browser.close();}
});

test('Jobvite external upload receipt prevents repeated upload after the portal closes or remounts',async()=>{
  const browser=await chromium.launch({headless:true});
  try {const page=await browser.newPage();await fixture(page,true);assert.equal(await proof(page),true);
    const result=await fill(page);assert.equal(result.resume,'unverified');assert.equal(result.canUndo,false);
    assert.ok(result.skipped.some(item=>item.reason==='resume_parsing_pending_profile_not_filled'));
    await page.locator('#file-input-0').evaluate(e=>e.replaceWith(e.cloneNode()));
    await proof(page);const retry=await fill(page);assert.equal(retry.resume,'unverified');
    assert.equal(await page.evaluate('uploads'),1);assert.equal(await page.evaluate('opens'),1);assert.equal(await page.locator('[name=first]').inputValue(),'');
    assert.equal(await page.evaluate('submits'),0);
  }finally {await browser.close();}
});

test('extension page actions verify Jobvite file history and the final SmartRecruiters screening footer',{timeout:45000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-jobvite-proof-'));
  cpSync(resolve('extension'),root,{recursive:true});
  writeFileSync(join(root,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated Jobvite proof',version:'1.0',permissions:['debugger','tabs','storage'],background:{service_worker:'background.js',type:'module'}}));
  writeFileSync(join(root,'background.js'),"import {pageAction} from './page-actions.js'; globalThis.runAction=params=>pageAction(params,new Set());");
  const context=await chromium.launchPersistentContext(join(root,'browser'),{headless:true,channel:'chromium',...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  try {
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const page=await context.newPage();await fixture(page);
    const tabId=await worker.evaluate(async u=>(await (globalThis as any).chrome.tabs.query({})).find((t:any)=>t.url===u).id,url);
    const action=(operation:string,documentId?:string,pageHandoff?:string,file=resume)=>worker.evaluate(p=>(globalThis as any).runAction(p),{tabId,expectedUrl:url,operation,documentId,pageHandoff,facts,resume:file,expiresAt:Date.now()+10000});
    const inspection=await action('inspect');const result=await action('fill',inspection.documentId);
    assert.equal(result.resume,'verified',JSON.stringify(result));assert.equal(result.resumeEvidence,'picker');assert.deepEqual(await counts(page),[1,0]);
    await action('undo',inspection.documentId);assert.deepEqual(await counts(page),[0,0]);
    await action('redo',inspection.documentId);assert.deepEqual(await counts(page),[1,0]);assert.equal(await page.evaluate('submits'),0);
    const occupied=await action('inspect',undefined,'imported-job');
    const conflict=await action('fill',occupied.documentId,'imported-job',{...resume,base64:Buffer.from('%PDF-different-selected').toString('base64')});
    assert.equal(conflict.resume,'unverified');
    assert.ok(conflict.skipped.some((field:{reason:string})=>field.reason==='different_resume_requires_manual_review'));
    assert.deepEqual(await counts(page),[1,0]);
    await action('undo',inspection.documentId);
    const selected=await action('inspect',undefined,'imported-job');
    assert.equal(selected.canRedo,false,'a selected job cannot redo an earlier default PDF');
    assert.equal((await action('fill',selected.documentId,'imported-job')).resume,'verified');
    assert.equal((await action('inspect')).canUndo,false,'ordinary history excludes the selected job write');
    await action('undo',selected.documentId,'imported-job');assert.deepEqual(await counts(page),[0,0]);
    await action('redo',selected.documentId,'imported-job');assert.deepEqual(await counts(page),[1,0]);


    const screening='https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/abcd1234-1111-2222-3333-111111111111/screening';
    await page.route(screening, route=>route.fulfill({contentType:'text/html',body:`
      <main><oc-screening-questions><oc-screening-questions-form>
        <label>First name<input required></label>
      </oc-screening-questions-form><oc-nav-screening-questions>
        <oc-button data-test="footer-submit"><spl-button>Submit</spl-button></oc-button>
      </oc-nav-screening-questions></oc-screening-questions></main>
      <script>
        const footer=document.querySelector('spl-button');
        footer.attachShadow({mode:'open'}).innerHTML='<button disabled><slot></slot></button>';
        const button=footer.shadowRoot.querySelector('button');
        window.clicks=0;
        button.onclick=()=>window.clicks++;
        document.querySelector('input').oninput=()=>{
          if(window.mode==='enabled')button.disabled=false;
          if(window.mode==='hidden')footer.hidden=true;
          if(window.mode==='transparent')footer.style.opacity='0';
          if(window.mode==='zero')button.style.cssText='display:block;width:0;height:0;padding:0;border:0;overflow:hidden';
          if(window.mode==='unknown' && !footer.nextSibling)footer.after(footer.cloneNode(true));
        };
      </script>`}));
    for (const mode of ['disabled','enabled','unknown','hidden','transparent','zero']) {
      await page.goto(screening);
      await page.evaluate(mode=>{(window as any).mode=mode;},mode);
      const run=(operation:string, overrides:Record<string,unknown>={})=>worker.evaluate(
        params=>(globalThis as any).runAction(params),
        {operation,tabId,expectedUrl:screening,expiresAt:Date.now()+10000,...overrides},
      );
      const before=await run('inspect');
      assert.equal(before.observation.screeningSubmissionControl,'disabled');
      const row=before.matching.find((field:{question:string})=>/First name/i.test(field.question));
      assert.ok(row,'required screening name must be available to matching');
      const after=await run('fill',{documentId:before.documentId,facts,matchingPlans:[{
        fieldId:row.fieldId,signature:row.signature,frameId:row.frameId,answer:'Fixture',reason:'saved_fact',provisional:false,
      }]});
      assert.equal(await page.locator('input').inputValue(),'Fixture');
      assert.equal(after.observation.screeningSubmissionControl,['hidden','transparent','zero'].includes(mode) ? 'unknown' : mode,mode);
      assert.equal(after.skipped.some((item:{reason:string})=>item.reason==='employer_submission_disabled'),mode==='disabled');
      if (mode==='unknown')assert.equal(after.observation.kind,'unknown');
      if (mode==='disabled')assert.equal(after.incomplete,true);
      assert.equal(await page.evaluate('window.clicks'),0);
    }
  } finally {await context.close();}
});
