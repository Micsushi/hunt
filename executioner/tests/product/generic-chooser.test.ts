import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,type Page} from 'playwright';
import {fillGenericApplication,proveBambooResumeInput} from '../../src/product/generic-application.ts';
import {fillVisibleFields} from '../../extension/generic-fill.js';
import {prepareCurrentPage} from '../../src/product/current-page-workflow.ts';
import {componentFailure} from '../../src/product/component-diagnostics.ts';

const url='https://fixture.bamboohr.com/careers/123';
const selected=Buffer.from('%PDF-selected-chooser-fixture');
const facts=[{factId:'given_name',value:'Fixture'},{factId:'email_address',value:'fixture@example.invalid'}];
const chooserListeners=(page:Page)=>(page as unknown as {listenerCount(event:string):number}).listenerCount('filechooser');
async function fixture(page:Page,handler:string){
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<form id="job-application-form">
    <label>First name<input name="first" required></label><label>Email<input name="email" type="text" required></label>
    <div id="upload"><p>Resume*</p><div><div><div><button id="choose" type="button">Choose File*</button><span>No file selected</span></div><input id="file" type="file" style="opacity:0;width:0;height:0;position:absolute" aria-label="file-input"></div><input type="hidden" name="resumeFileId"></div></div>
    <div><div>Cover letter</div><input id="cover" type="file" hidden></div>
    <button type="button" onclick="window.submits++">Submit</button></form>
    <script>window.submits=0;window.activations=0;document.getElementById('choose').onclick=()=>{window.activations++;${handler}};</script>`}));
  await page.goto(url);
}
async function fill(page:Page){return page.evaluate(fillVisibleFields,{facts,resume:{name:'Resume.pdf',base64:selected.toString('base64')},replaceExistingResume:true});}

test('Bamboo asynchronous chooser proves only binding; shared fill owns exact bytes and native undo',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,"setTimeout(()=>document.getElementById('file').click(),40);");
    await page.evaluate(() => {
      const code = document.createElement('input'); code.autocomplete='one-time-code';
      document.body.append(code);
    });
    const blocked = await fillGenericApplication(page,url,{},selected,AbortSignal.timeout(5000));
    assert.equal(blocked.componentFailure?.operation,'blocked_by_account_or_code_control');
    assert.deepEqual(blocked.filled,[]);
    assert.equal(await page.evaluate('activations'),0);
    await page.locator('input[autocomplete=one-time-code]').evaluate(e=>e.remove());
    await proveBambooResumeInput(page,url,AbortSignal.timeout(5000),Date.now()+5000);
    assert.equal(await page.locator('#file').evaluate((e:HTMLInputElement)=>e.files!.length),0,'proof has no payload');
    assert.equal(chooserListeners(page),0);
    const result=await fill(page);assert.equal(result.resume,'verified');
    assert.deepEqual(await page.locator('#file').evaluate(async(e:HTMLInputElement)=>[...new Uint8Array(await e.files![0]!.arrayBuffer())]),[...selected]);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});assert.equal(await page.locator('#file').evaluate((e:HTMLInputElement)=>e.files!.length),0);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.equal(await page.locator('#file').evaluate((e:HTMLInputElement)=>e.files![0]!.size),selected.length);
    await page.locator('input[name=resumeFileId]').evaluate((e:HTMLInputElement)=>{e.value='fixture-remote-receipt';});
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/Fields changed/);
    assert.equal((await fill(page)).resume,'unverified','remote receipt is not reversible native-file state');
    assert.equal(await page.evaluate('activations'),1,'retry does not open another chooser');
    assert.equal(await page.evaluate('submits'),0);
  }finally{await browser.close();}
});

test('wrong, missing and expired chooser attempts leave files and listeners untouched',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,"document.getElementById('cover').click();");
    await assert.rejects(prepareCurrentPage(page,{url,profile:{},resume:selected},AbortSignal.timeout(5000),()=>{}),error=>{
      assert.match(String(error),/different upload field/);
      assert.deepEqual(componentFailure(error),{component:'uploads',operation:'bind_file_chooser'});
      return true;
    });
    assert.equal(await page.locator('input[type=file]').evaluateAll(es=>es.some(e=>(e as HTMLInputElement).files!.length)),false);
    assert.equal(chooserListeners(page),0);assert.equal(await page.evaluate('submits'),0);
    await page.locator('#choose').evaluate(e => { (e as HTMLButtonElement).onclick = null; });
    await assert.rejects(prepareCurrentPage(page,{url,profile:{},resume:selected},AbortSignal.timeout(6000),()=>{}),error=>{
      assert.match(String(error),/did not identify one upload field/);
      assert.deepEqual(componentFailure(error),{component:'uploads',operation:'observe_file_chooser'});
      return true;
    });
    assert.equal(chooserListeners(page),0);
    const clicks=await page.evaluate('activations');
    await assert.rejects(proveBambooResumeInput(page,url,AbortSignal.timeout(1000),Date.now()-1),/expired/);
    assert.equal(await page.evaluate('activations'),clicks);
    assert.equal(await page.locator('#file').evaluate((e:HTMLInputElement)=>e.files!.length),0);
  }finally{await browser.close();}
});

test('Bamboo upload receipt allows profile fill without a parser toast and survives Undo',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,"document.getElementById('file').click();");
    await page.locator('#cover').evaluate(e=>e.parentElement!.remove());
    await proveBambooResumeInput(page,url,AbortSignal.timeout(5000),Date.now()+5000);
    await page.locator('#file').evaluate(e=>e.addEventListener('change',()=>{
      (document.querySelector('input[name=resumeFileId]') as HTMLInputElement).value='fixture-remote-receipt';
      e.remove();
    }));
    const result=await fill(page);
    assert.equal(result.resume,'unverified','attachment still needs independent employer review');
    assert.ok(result.filled.includes('First name'));assert.ok(result.filled.includes('Email'));
    assert.equal(result.skipped.some(item=>item.reason==='resume_parsing_pending_profile_not_filled'),false);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('[name=first]').inputValue(),'');
    assert.equal(await page.locator('[name=resumeFileId]').inputValue(),'fixture-remote-receipt');
    await page.locator('form').evaluate(e=>{const status=document.createElement('div');status.textContent='Resume parsing in progress';e.append(status);});
    assert.ok((await fill(page)).skipped.some(item=>item.reason==='resume_parsing_pending_profile_not_filled'));
    assert.equal(await page.locator('[name=first]').inputValue(),'');
    assert.equal(await page.evaluate('activations'),1);assert.equal(await page.evaluate('submits'),0);
  }finally{await browser.close();}
});

test('input replacement and page navigation invalidate chooser proof',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await fixture(page,"document.getElementById('file').click();");
    await proveBambooResumeInput(page,url,AbortSignal.timeout(5000),Date.now()+5000);
    await page.locator('#file').evaluate(e=>e.replaceWith(e.cloneNode()));
    assert.equal((await fill(page)).resume,'missing');
    await page.goto(url);
    assert.equal((await fill(page)).resume,'missing');
    assert.equal(await page.locator('#file').evaluate((e:HTMLInputElement)=>e.files!.length),0);
  }finally{await browser.close();}
});
