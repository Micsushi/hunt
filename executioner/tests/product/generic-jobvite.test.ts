import assert from 'node:assert/strict';
import test from 'node:test';
import {cpSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type Page} from 'playwright';
import {proveJobviteResumeInput} from '../../extension/jobvite-resume.js';
import {fillVisibleFields} from '../../extension/generic-fill.js';
import {fillApplication} from '../../src/product/engine.ts';
import {fillGenericApplication} from '../../src/product/generic-application.ts';
import {applicantProfile} from '../../src/product/sources.ts';

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
    if (form) {
      // The live first step has only Next, and its file chooser sits outside the form.
      await page.getByRole('button',{name:'Submit application'}).evaluate(button => { button.textContent='Next'; });
    }
    assert.equal(await proof(page),true);assert.deepEqual(await counts(page),[0,0]);
    const result=await fill(page);assert.equal(result.resume,'verified');assert.ok(result.filled.includes('Resume'));
    assert.deepEqual(await counts(page),[1,0]);assert.equal(await page.locator('#file-input-0').evaluate(async(e:HTMLInputElement)=>e.files![0]!.text()),'%PDF-selected-jobvite-fixture');
    await proof(page);await fill(page);assert.equal(await page.evaluate('uploads'),1);assert.equal(await page.evaluate('opens'),1);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});assert.deepEqual(await counts(page),[0,0]);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.deepEqual(await counts(page),[1,0]);
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

test('Jobvite proof preserves a manual file selection and expires before opening',async()=>{
  const browser=await chromium.launch({headless:true});
  try {const page=await browser.newPage();await fixture(page);
    await assert.rejects(page.evaluate(proveJobviteResumeInput,{expectedUrl:url,expiresAt:Date.now()-1}));assert.equal(await page.evaluate('opens'),0);
    assert.equal(await proof(page),true);
    await page.locator('#file-input-0').setInputFiles({name:'Manual.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-manual')});
    const result=await fill(page);assert.equal(result.resume,'unverified');assert.ok(result.skipped.some(item=>item.reason==='existing_attachment_preserved'));
    assert.equal(await page.locator('#file-input-0').evaluate((e:HTMLInputElement)=>e.files![0]!.name),'Manual.pdf');
  }finally {await browser.close();}
});

test('queued Jobvite path uses the proof but preserves an existing manual resume',async()=>{
  const browser=await chromium.launch({headless:true});
  try {for(const manual of [false,true]){
    const page=await browser.newPage();await fixture(page);
    if(manual)await page.locator('#file-input-0').setInputFiles({name:'Manual.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-manual')});
    const result=await fillGenericApplication(page,url,applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),Buffer.from(resume.base64,'base64'),AbortSignal.timeout(5000));
    assert.equal(result.resume,manual?'unverified':'verified');
    assert.equal(await page.locator('#file-input-0').evaluate((e:HTMLInputElement)=>e.files![0]!.name),manual?'Manual.pdf':'Resume.pdf');
    if(manual)assert.ok(result.skipped.some(item=>item.reason==='existing_attachment_preserved'));
    assert.deepEqual(await counts(page),[1,0]);assert.equal(await page.evaluate('submits'),0);await page.close();
  }}finally {await browser.close();}
});

test('queued Jobvite advances once from the acknowledged first step and stops before submission', async () => {
  const browser = await chromium.launch({headless:true});
  const profile = applicantProfile({given_name:'Fixture', family_name:'Applicant', email_address:'fixture@example.invalid'});
  const input = {url, profile, resume:Buffer.from(resume.base64,'base64')};
  try {
    for (const mode of ['advance','slow','invalid','submit','stall','conflict','rejected','expanded-conflict','twice','ambiguous-disclosure','foreign-disclosure','retained-match','retained-other']) {
      const page = await browser.newPage();
      await fixture(page,true);
      await page.evaluate(mode => {
        const form = document.querySelector('form')!;
        const article = document.createElement('article');
        article.setAttribute('ng-controller','JVApply');
        form.replaceWith(article); article.append(form);
        form.name='scopeData.applyForm';form.setAttribute('ng-submit','submitApplication()');
        form.onsubmit = e => {e.preventDefault(); (window as any).submits++;};
        const first = document.createElement('section');
        first.setAttribute('ng-form','scopeData.step1'); first.setAttribute('ng-if','showStep(1)');
        first.append(...form.childNodes); form.append(first);
        first.querySelector('button[onclick]')!.remove();
        const trigger=first.querySelector('#resume-trigger')!,owner=trigger.parentElement!;
        owner.id='attachResume';owner.setAttribute('ng-controller','JVApplyWith');
        trigger.setAttribute('on-success','sendResume(type, res)');
        const file=document.querySelector<HTMLInputElement>('#file-input-0')!;
        file.addEventListener('change',()=>owner.insertAdjacentHTML('beforeend',
          '<ul><li ng-if="resumeName"><span jv-focus-on="resumeName" ng-click="editOrPreviewResume()">'+(mode==='retained-other'?'Previous.pdf':'Resume.pdf')+'</span> <a href="" ng-click="removeResume()">Remove</a></li></ul>'));
        if (mode==='invalid') first.insertAdjacentHTML('beforeend','<input required value="" aria-invalid=true>');
        if (mode==='conflict') first.querySelector<HTMLInputElement>('[name=first]')!.value='Other';
        const next=document.createElement('button');
        next.type=mode==='submit'?'submit':'button';next.textContent='Next';next.setAttribute('ng-click','nextStep()');
        form.append(next);(window as any).advances=0;(window as any).expands=0;
        next.onclick=event=>{
          if (!event.isTrusted) throw new Error('Expected trusted browser input');
          (window as any).advances++;
          if (['rejected','expanded-conflict','twice','ambiguous-disclosure','foreign-disclosure'].includes(mode) &&
              ((window as any).advances===1 || mode==='twice')) {
            for(const label of first.querySelectorAll('label'))label.hidden=true;
            const box=document.createElement('div');box.className='jv-apply-form-actions';
            box.innerHTML='<p class="jv-apply-error"><a href="" ng-click="showAllFields = true">View Full Application Form</a></p>';
            if(mode==='ambiguous-disclosure')box.firstElementChild!.append(box.querySelector('a')!.cloneNode(true));
            if(mode==='foreign-disclosure')document.body.append(box);else form.append(box);
            for(const link of box.querySelectorAll('a'))link.onclick=e=>{
              e.preventDefault();(window as any).expands++;box.remove();
              for(const label of first.querySelectorAll('label'))label.hidden=false;
              if(mode==='expanded-conflict') first.querySelector<HTMLInputElement>('[name=first]')!.value='Other';
            };
            return;
          }
          if(mode==='stall')return;
          const showScreening=()=>{
            first.remove();next.remove();
            form.insertAdjacentHTML('afterbegin','<section ng-form="scopeData.step2" ng-if="showStep(2)"><label>First name<input required></label></section><button type=submit>Send Application</button>');
            if (mode === 'advance') {
              form.querySelector('section')!.insertAdjacentHTML('beforeend', `
                <fieldset class="jv-input-group">
                  <legend>Which intake(s) are you available for? *</legend>
                  <label><input hidden type="checkbox" name="intake"> January</label>
                  <label><input hidden type="checkbox" name="intake"> May</label>
                </fieldset>`);
            }
          };
          if(mode==='slow') setTimeout(showScreening,4100); else showScreening();
        };
      },mode);
      if (mode.startsWith('retained-')) {
        const cdp=await page.context().newCDPSession(page);
        try {
          const {frameTree}=await cdp.send('Page.getFrameTree');
          const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'prior-page-fill'});
          const prior=mode==='retained-other'?{...resume,name:'Previous.pdf'}:resume;
          const response=await cdp.send('Runtime.evaluate',{contextId:executionContextId,awaitPromise:true,returnByValue:true,
            expression:'(async()=>{await ('+proveJobviteResumeInput.toString()+')('+JSON.stringify({expectedUrl:url})+');return ('+
              fillVisibleFields.toString()+')('+JSON.stringify({facts,resume:prior,expectedUrl:url})+');})()'});
          assert.equal(response.exceptionDetails,undefined);
          assert.equal(response.result.value.resume,'unverified');
          assert.equal(await page.evaluate('Boolean(globalThis.__huntC3PartialFill?.resumeAttempt)'),false);
        } finally { await cdp.detach(); }
      }
      const inspection=await page.evaluate(fillVisibleFields,{facts,action:'status' as const});
      assert.equal((inspection as {jobviteFirstStep?:boolean}).jobviteFirstStep===true,mode!=='submit');
      const attempt=()=>fillApplication(page,input,AbortSignal.timeout(25_000),()=>{});
      const stop = ['advance','slow','rejected'].includes(mode) ? /Jobvite acknowledged the selected resume\. The employer PDF contents remain unverified\. Review the screening step\. C3 stopped before submission\./ :
        mode==='retained-match' ? /employer shows the matching filename\. PDF contents unverified/ :
        mode==='retained-other' ? /existing attachment needs review/ :
        mode==='expanded-conflict' ? /saved profile differs.*C3 clicked Next and opened the full Jobvite form\. Review the first step/ :
        ['stall','ambiguous-disclosure','foreign-disclosure'].includes(mode) ? /clicked Next once/ :
        mode==='conflict' ? /saved profile differs/ : mode==='twice' ? /clicked Next, opened the full Jobvite form, checked the required fields and clicked Next again\. Jobvite still requests more information\. Review the first step\. The attached PDF contents remain unverified\./ : /has not advanced/;
      await assert.rejects(attempt(), (error: Error) => {
        assert.match(error.message, stop);
        if (mode === 'advance') assert.match(error.message, /Review suggested answers/);
        return true;
      });
      if (mode === 'advance') {
        assert.equal(await page.getByRole('textbox', {name: 'First name'}).inputValue(), 'Fixture');
        assert.equal(await page.getByLabel('January').isChecked(), true);
      }
      if(mode==='stall') await assert.rejects(attempt(),/has not advanced|could not be confirmed/);
      if (mode==='twice') await assert.rejects(attempt(),/has not advanced|stayed on the first step/);
      const count=['rejected','twice'].includes(mode)?2:['advance','slow','stall','expanded-conflict','ambiguous-disclosure','foreign-disclosure'].includes(mode)?1:0;
      assert.deepEqual(await page.evaluate('([advances,expands,submits,uploads])'),[count,['rejected','twice','expanded-conflict'].includes(mode)?1:0,0,1]);
      if (mode.startsWith('retained-')) {
        assert.equal(await page.evaluate('opens'),1);
        assert.equal(await page.locator('li[ng-if="resumeName"] span').textContent(),mode==='retained-match'?'Resume.pdf':'Previous.pdf');
      }
      await page.close();
    }
  } finally { await browser.close(); }
});

test('actual extension page action runs Jobvite proof and shared history in the same isolated world',{timeout:45000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-jobvite-proof-'));
  cpSync(resolve('extension'),root,{recursive:true});
  writeFileSync(join(root,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated Jobvite proof',version:'1.0',permissions:['debugger','tabs','storage'],background:{service_worker:'background.js',type:'module'}}));
  writeFileSync(join(root,'background.js'),"import {pageAction} from './page-actions.js'; globalThis.runAction=params=>pageAction(params,new Set());");
  const context=await chromium.launchPersistentContext(join(root,'browser'),{headless:true,channel:'chromium',...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  try {
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const page=await context.newPage();await fixture(page);
    const tabId=await worker.evaluate(async u=>(await (globalThis as any).chrome.tabs.query({})).find((t:any)=>t.url===u).id,url);
    const action=(operation:string,documentId?:string)=>worker.evaluate(p=>(globalThis as any).runAction(p),{tabId,expectedUrl:url,operation,documentId,facts,resume,expiresAt:Date.now()+10000});
    const inspection=await action('inspect');const result=await action('fill',inspection.documentId);
    assert.equal(result.resume,'verified',JSON.stringify(result));assert.deepEqual(await counts(page),[1,0]);
    await action('undo',inspection.documentId);assert.deepEqual(await counts(page),[0,0]);
    await action('redo',inspection.documentId);assert.deepEqual(await counts(page),[1,0]);assert.equal(await page.evaluate('submits'),0);
  } finally {await context.close();}
});
