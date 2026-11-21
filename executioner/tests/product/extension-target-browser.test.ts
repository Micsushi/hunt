import assert from 'node:assert/strict';
import test from 'node:test';
import {cpSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type BrowserContext} from 'playwright';
import {startProductServer} from '../../src/product/server.ts';
import type {ExtensionBridge} from '../../src/product/extension-bridge.ts';

test('real extension attaches an already-open Rippling application and still rejects a changed document', {timeout:60000},async()=>{
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
    const session=await bridge.open(posting,tabId,true);
    assert.equal(session.page.url(),application);assert.equal((await bridge.call('info',{tabId})).url,application);
    await page.reload();
    await assert.rejects(bridge.call('info',{tabId}),/document changed/);
    assert.equal(await page.locator('input').inputValue(),'');
    await bridge.release(tabId);await session.browser.close();
    await bridge.focus(tabId,posting);
  }finally{await context?.close();await service.close();}
});
