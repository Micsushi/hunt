import assert from 'node:assert/strict';
import test from 'node:test';
import {cpSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type BrowserContext} from 'playwright';
import {startProductServer} from '../../src/product/server.ts';
import {type ExtensionBridge, verifiedScreeningTransition} from '../../src/product/extension-bridge.ts';

test('real extension binds Rippling documents and only permits the verified SmartRecruiters screening transition', {timeout:90000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'c3-existing-target-'));
  const service=await startProductServer({root:join(root,'service'),port:0});
  const extension=join(root,'extension');cpSync(resolve('extension'),extension,{recursive:true});
  for(const name of ['manifest.json','background.js','popup.js','website-handoff.js']){
    const file=join(extension,name);writeFileSync(file,readFileSync(file,'utf8').replaceAll('47831',new URL(service.origin).port));
  }
  let context:BrowserContext|undefined;
  try{
    context=await chromium.launchPersistentContext(join(root,'browser'),{headless:true,channel:'chromium',...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    await worker.evaluate(async token=>{await (globalThis as any).chrome.storage.local.set({token});},readFileSync(service.tokenPath,'utf8').trim());
    const popup=await context.newPage();await popup.goto(worker.url().replace(/background\.js$/,'popup.html'));
    await popup.evaluate(()=>(globalThis as any).chrome.runtime.sendMessage({action:'connect'}));
    for(let i=0;i<100&&!service.queue.snapshot().connected;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(service.queue.snapshot().connected,true);
    const posting='https://ats.rippling.com/fixture/jobs/68057679-c967-4707-9423-ea2db74de7c5?jobSite=Indeed';
    const application=posting.replace('?','/apply?')+'&step=application';
    await context.route('https://ats.rippling.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture application</title><label>First name<input></label>'}));
    const page=await context.newPage();await page.goto(application);
    const tabId=await worker.evaluate(async url=>(await (globalThis as any).chrome.tabs.query({})).find((t:any)=>t.url===url).id,application);
    const bridge=(service.queue as unknown as {bridge:ExtensionBridge}).bridge;
    const issuesUrl='https://fixture.example.invalid/issue-review', childUrl=issuesUrl+'/address';
    await context.route(childUrl,route=>route.fulfill({contentType:'text/html',body:`<form>
      <fieldset><legend>Address</legend><label>State/Province<select required><option value="-1">Please select a country</option></select></label></fieldset>
      <label>Transcript<input type=file required></label><div role=combobox aria-label="Office" aria-required=true></div>
      <label>Country<input required value="Canada"></label><label>Hidden<input required hidden></label>
      <label>Optional<input></label><button>Continue</button></form><style>[role=combobox]{height:30px}</style>`}));
    await context.route(issuesUrl,route=>route.fulfill({contentType:'text/html',body:`<form>
      <label>First name<input autocomplete=given-name></label><label>Email<input type=email></label>
      <label>Email/Login<input type=email required value="bad"></label><label>Password<input type=password required autocomplete=new-password></label>
      <label>Password (Re-enter)<input type=password required value="private-fixture"></label></form>
      <form><label>Newsletter email<input type=email required></label></form>
      <form><label>Cover letter<input type=file required></label></form>
      <iframe title="Address" src="${childUrl}"></iframe>`}));
    await page.goto(issuesUrl);
    const inspected=await bridge.call('pageAction',{operation:'inspect',tabId,expectedUrl:issuesUrl});
    type Issue={fieldId:string;frameId:string;label:string;section?:string;reason:string};
    const issues:Issue[]=inspected.requiredIssues;
    assert.deepEqual(issues.map(i=>[i.label,i.reason]),[
      ['Email/Login','required_invalid'],['Password','required_empty'],['Cover letter','required_empty'],['State/Province','required_empty'],
      ['Transcript','required_empty'],['Office','required_unconfirmed']]);
    assert.doesNotMatch(JSON.stringify(issues),/private-fixture/);
    const child=page.frameLocator('iframe');
    const province=issues.find(i=>i.label==='State/Province')!;
    assert.equal(province.section,'Address');
    const locate=(issue:Issue)=>popup.evaluate(args=>(globalThis as any).chrome.runtime.sendMessage(args),
      {action:'revealIssue',tabId,expectedUrl:issuesUrl,documentId:inspected.documentId,frameId:issue.frameId,fieldId:issue.fieldId});
    assert.equal((await locate(province)).ok,true);
    assert.equal(await child.getByLabel('State/Province').evaluate(e=>e.getAnimations().length>0),true);
    assert.equal(await child.getByLabel('State/Province').inputValue(),'-1');
    await child.getByLabel('State/Province').evaluate((e:HTMLSelectElement)=>e.replaceChildren(new Option('Alberta','AB',true,true)));
    assert.equal((await locate(province)).ok,false,'a resolved control cannot be highlighted as missing');
    await page.reload();
    assert.equal((await locate(province)).ok,false,'a stale document cannot reveal controls');
    await page.goto(application);
    const session=await bridge.open(posting,tabId,true);
    assert.equal(session.page.url(),application);assert.equal((await bridge.call('info',{tabId})).url,application);
    await page.reload();
    await assert.rejects(bridge.call('info',{tabId}),/document changed/);
    assert.equal(await page.locator('input').inputValue(),'');
    await bridge.release(tabId);await session.browser.close();
    await bridge.focus(tabId,posting);

    const uuid='11111111-1111-4111-8111-111111111111';
    const source='https://jobs.smartrecruiters.com/Fixture/123456-title';
    const base='https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/'+uuid;
    const query='?dcr_ci=Fixture', personal=base+query, screening=base+'/screening'+query;
    await context.route('https://jobs.smartrecruiters.com/**',route=>route.fulfill({contentType:'text/html',body:'<main>Fixture application</main>'}));
    t.mock.method(globalThis,'fetch',async (url:unknown)=>{
      assert.equal(String(url),'https://api.smartrecruiters.com/v1/companies/Fixture/postings/123456');
      return Response.json({id:'123456',company:{identifier:'Fixture'},uuid,active:true});
    });
    await page.goto(personal);
    const unverified=await bridge.open(personal,tabId,true);
    assert.throws(()=>verifiedScreeningTransition(unverified.page,personal),/verified SmartRecruiters posting/);
    await bridge.release(tabId);await unverified.browser.close();
    const previous=await bridge.open(source,tabId,true);
    const stale=verifiedScreeningTransition(previous.page,personal);
    await bridge.release(tabId);await previous.browser.close();
    const delayed=await bridge.open(source,tabId,true);
    await assert.rejects(stale(),/tab changed/);
    await verifiedScreeningTransition(delayed.page,personal)();
    assert.equal((await bridge.call('info',{tabId})).url,personal);
    await page.evaluate(path=>history.pushState({},'',path),screening);
    assert.equal((await bridge.call('info',{tabId})).url,screening);
    await bridge.release(tabId);await delayed.browser.close();
    for (const destination of [screening,screening.replace('/Fixture/','/Other/'),screening.replace(uuid,'2'+uuid.slice(1)),base+'/other'+query,screening+'&extra=yes','reload']) {
      await page.goto(personal);
      const bound=await bridge.open(source,tabId,true);
      try {
        const grant=verifiedScreeningTransition(bound.page,personal);
        if (destination==='reload') await page.goto(screening);
        else await page.evaluate(path=>history.pushState({},'',path),destination);
        if (destination===screening) {
          await assert.rejects(bridge.call('info',{tabId}),/document changed/);
          await worker.evaluate(({tabId,personal})=>{
            // The tab API briefly still reports the personal page after CDP observes the screening route.
            const tabs=(globalThis as any).chrome.tabs, original=tabs.get.bind(tabs);
            tabs.get=async (id:number)=>{
              const snapshot=await original(id);
              if (id!==tabId) return snapshot;
              tabs.get=original;
              return {...snapshot,url:personal};
            };
          },{tabId,personal});
          await grant();
          assert.equal((await bridge.call('info',{tabId})).url,screening);
          assert.equal(await bound.page.locator('main').textContent(),'Fixture application');
          await assert.rejects(grant(),/no longer available/);
          await assert.rejects(bridge.call('cdp',{tabId,method:'Page.reload'}),/must stay on the current page/);
          await page.evaluate(path=>history.pushState({},'',path),personal);
          await assert.rejects(bridge.call('info',{tabId}),/document changed/);
        } else {
          await assert.rejects(grant(),/left the verified application route|document changed/);
          await assert.rejects(bridge.call('info',{tabId}),/document changed/);
        }
      } finally {await bridge.release(tabId);await bound.browser.close();}
    }
  }finally{await context?.close();await service.close();}
});
