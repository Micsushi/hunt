import assert from 'node:assert/strict';
import test from 'node:test';
import {cpSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type BrowserContext} from 'playwright';
import {startProductServer} from '../../src/product/server.ts';
import {fixtureApplicantProfile} from './fixture.ts';

test('actual popup transport rejects synthetic profiles and queued resume substitution before effects', {timeout:60000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-popup-safety-'));
  const service=await startProductServer({root:join(root,'service'),port:0});
  const token=readFileSync(service.tokenPath,'utf8').trim();
  const extension=join(root,'extension');cpSync(resolve('extension'),extension,{recursive:true});
  for(const name of ['manifest.json','background.js','popup.js','website-handoff.js']){
    const file=join(extension,name);writeFileSync(file,readFileSync(file,'utf8').replaceAll('47831',new URL(service.origin).port));
  }
  let context:BrowserContext|undefined;
  try{
    context=await chromium.launchPersistentContext(join(root,'browser'),{headless:true,channel:'chromium',...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    await worker.evaluate(async token=>{await (globalThis as any).chrome.storage.local.set({token});},token);
    const popup=await context.newPage();await popup.goto(worker.url().replace(/background\.js$/,'popup.html'));
    await popup.evaluate(()=>(globalThis as any).chrome.runtime.sendMessage({action:'connect'}));
    for(let i=0;i<100&&!service.queue.snapshot().connected;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(service.queue.snapshot().connected,true);
    const url='https://job-boards.greenhouse.io/fixture/jobs/123';
    await context.route(url,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><form><label>First name<input required autocomplete="given-name"></label><label>Email<input required type="email"></label><label>Resume<input required type="file" accept=".pdf"></label></form>'}));
    const page=await context.newPage();await page.goto(url);
    const tabId=await worker.evaluate(async url=>(await (globalThis as any).chrome.tabs.query({})).find((t:any)=>t.url===url).id,url);
    const send=(operation:string,documentId?:string,expectedUrl=url)=>popup.evaluate(args=>(globalThis as any).chrome.runtime.sendMessage({action:'pageAction',...args,expiresAt:Date.now()+12000}),{operation,documentId,tabId,expectedUrl});
    const inspect=await send('inspect');assert.equal(inspect.ok,true);
    const resume=Buffer.from('%PDF-1.4\nDefault fixture').toString('base64');
    const personal=fixtureApplicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'});
    const syntheticProfile=structuredClone(personal) as any;
    syntheticProfile.profilePlan.mode='synthetic_test_non_submittable';
    syntheticProfile.executionPolicy.answerFallbackPolicy='deterministic_site_valid_editable';
    service.queue.configure(syntheticProfile,resume);
    const synthetic=await send('fill',inspect.result.documentId);assert.equal(synthetic.ok,false);assert.match(synthetic.error,/saved personal profile/);
    assert.equal(await page.locator('input').first().inputValue(),'');assert.equal(await page.locator('input[type=file]').evaluate((el:any)=>el.files.length),0);
    service.queue.configure(personal,resume);
    const selected=Buffer.from('%PDF-1.4\nSelected version fixture').toString('base64');
    const queued=service.queue.add([{url,tabId,resumeBase64:selected,resumeName:'Selected.pdf',resumeVersion:'v8',sourceJobId:123}],{paused:true})[0]!;
    const before=readFileSync(join(root,'service',queued.id+'.input.json'),'utf8');
    for(const operation of ['fill','redo']){
      const result=await send(operation,inspect.result.documentId);assert.equal(result.ok,false);assert.match(result.error,/queued|Applications/i);
    }
    assert.equal(await page.locator('input').first().inputValue(),'');assert.equal(await page.locator('input[type=file]').evaluate((el:any)=>el.files.length),0);
    assert.equal(readFileSync(join(root,'service',queued.id+'.input.json'),'utf8'),before);assert.equal(queued.status,'paused');
    assert.equal(await worker.evaluate(async()=> (await (globalThis as any).chrome.storage.local.get('token')).token),token);
    await page.screenshot({path:join(root,'unchanged-queued-draft.png')});
    await service.queue.action(queued.id,'remove');
    const allowed=await send('fill',inspect.result.documentId);assert.equal(allowed.ok,true,JSON.stringify(allowed));
    assert.equal(await page.locator('input').first().inputValue(),'Fixture');
    assert.equal(await page.locator('input[type=file]').evaluate((el:any)=>el.files.length),1);
    const oneClick='https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/11111111-1111-4111-8111-111111111111';
    const childUrl=new URL('/unrelated-contact',oneClick).href;
    const contact='<label>First name<input required autocomplete="given-name"></label><label>Email<input required type="email"></label>';
    const owner='<oc-oneclick-form>'+contact+'<oc-resume-upload><spl-dropzone data-test="resume-upload"><label>Resume<input type="file"></label></spl-dropzone></oc-resume-upload></oc-oneclick-form>';
    let owners=1;
    await context.route(childUrl,route=>route.fulfill({contentType:'text/html',body:'<form>'+contact+'<button>Subscribe</button></form>'}));
    await context.route(oneClick,route=>route.fulfill({contentType:'text/html',body:'<main>'+owner.repeat(owners)+'</main><iframe src="'+childUrl+'"></iframe>'}));
    for (owners of [1,0,2]) {
      await page.goto(oneClick);
      const initial=await send('inspect',undefined,oneClick);
      assert.equal(initial.ok,true);
      const filled=await send('fill',initial.result.documentId,oneClick);
      assert.equal(filled.ok,true,JSON.stringify(filled));
      const child=page.frameLocator('iframe');
      assert.equal(await child.locator('input').first().inputValue(),'','unrelated frame must remain blank');
      assert.equal(await child.locator('input').last().inputValue(),'');
      assert.equal(initial.result.frames.length,1);
      assert.equal(filled.result.frames.length,1);
      if (owners>0) assert.equal(await page.locator('main input').first().inputValue(),owners===1?'Fixture':'');
    }
  }finally{await context?.close();await service.close();}
});
