import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';

test('manual Bamboo chooser proof binds the exact native input, preserves undo, and rejects a different chooser', {timeout:60000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-bamboo-proof-'));
  for(const file of ['page-actions.js','generic-fill.js','jobvite-resume.js','page-viewport.js','workday-account.js','question-context.js','shared-choice-widget.js'])copyFileSync(resolve('extension',file),join(root,file));
  writeFileSync(join(root,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated chooser proof',version:'1.0',permissions:['debugger','tabs','storage'],background:{service_worker:'background.js',type:'module'}}));
  writeFileSync(join(root,'background.js'),"import {pageAction} from './page-actions.js'; globalThis.runAction = params => pageAction(params,new Set());");
  const context=await chromium.launchPersistentContext(join(root,'browser'),{headless:true,channel:'chromium',...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  try {
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    const url='https://fixture.bamboohr.com/careers/1';
    const markup=(wrong=false)=>`<!doctype html><form id="job-application-form"><label>First name<input autocomplete="given-name" required></label><label>Email<input type="email" required></label><div><h2>Resume*</h2><input id="resume" type="file" style="display:none"><button type="button" onclick="document.querySelector('#${wrong?'other':'resume'}').click()">Choose File</button></div>${wrong?'<div><h2>Cover letter</h2><input id="other" type="file" style="display:none"></div>':''}<button type="submit">Submit</button></form><script>window.submissions=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submissions++}</script>`;
    await context.route(url,route=>route.fulfill({contentType:'text/html',body:markup()}));
    const page=await context.newPage();await page.goto(url);
    const tabId=await worker.evaluate(async url=>(await (globalThis as any).chrome.tabs.query({})).find((tab:any)=>tab.url===url).id,url);
    const action=(operation:string,documentId?:string)=>worker.evaluate(params=>(globalThis as any).runAction(params),{tabId,expectedUrl:url,operation,documentId,expiresAt:Date.now()+12000,facts:[{factId:'given_name',value:'Fixture'}],resume:{name:'Resume.pdf',base64:Buffer.from('%PDF-1.4\nFixture').toString('base64')}});
    const inspected=await action('inspect');
    const filled=await action('fill',inspected.documentId);
    assert.ok(filled.filled.includes('Resume'),JSON.stringify(filled));
    assert.equal(filled.resume,'verified');
    assert.equal(await page.locator('#resume').evaluate((e:any)=>e.files.length),1);
    assert.equal(await page.locator('#resume').evaluate(async(e:any)=>await e.files[0].text()),'%PDF-1.4\nFixture');
    assert.equal(filled.canUndo,true);
    await action('undo',inspected.documentId);
    assert.equal(await page.locator('#resume').evaluate((e:any)=>e.files.length),0);
    await action('redo',inspected.documentId);
    assert.equal(await page.locator('#resume').evaluate((e:any)=>e.files.length),1);
    assert.equal(await page.evaluate(()=>(window as any).submissions),0);
    await context.unroute(url);await context.route(url,route=>route.fulfill({contentType:'text/html',body:markup(true)}));
    await page.reload();const wrong=await action('inspect');const rejected=await action('fill',wrong.documentId);
    assert.equal(rejected.filled.includes('Resume'),false,JSON.stringify(rejected));
    assert.equal(rejected.resume,'missing');
    assert.equal(await page.locator('#resume').evaluate((e:any)=>e.files.length),0);
    assert.equal(await page.locator('#other').evaluate((e:any)=>e.files.length),0);
    assert.equal(await page.evaluate(()=>(window as any).submissions),0);
    // Replacing the candidate during the click cannot transfer proof to the new input.
    await context.unroute(url);await context.route(url,route=>route.fulfill({contentType:'text/html',body:markup().replace("document.querySelector('#resume').click()","const old=document.querySelector('#resume');const copy=old.cloneNode();old.replaceWith(copy);old.click()") }));
    await page.reload();const replaced=await action('inspect');const replacement=await action('fill',replaced.documentId);
    assert.equal(replacement.filled.includes('Resume'),false,JSON.stringify(replacement));
    assert.equal(await page.locator('#resume').evaluate((e:any)=>e.files.length),0);
    assert.equal(await page.evaluate(()=>(window as any).submissions),0);
    // A chooser after the action reaches the browser again: interception was torn down.
    const chooser=page.waitForEvent('filechooser');await page.locator('#resume').evaluate((e:any)=>e.click());assert.equal((await chooser).isMultiple(),false);
  } finally {await context.close();}
});
