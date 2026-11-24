import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { startProductServer } from '../../src/product/server.ts';

test('local full-menu history selects the originating page and browses closed pages without exposing URL secrets or answers',async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-history-ui-'));
  const service=await startProductServer({root,port:0});
  const token=readFileSync(service.tokenPath,'utf8').trim();
  const save=(url:string,pageSteps:object[],pageRequired?:object[])=>{
    const id=createHash('sha256').update(url).digest('hex').slice(0,24);
    const run=join(root,'learning','page-'+id,randomUUID());
    mkdirSync(run,{recursive:true});
    writeFileSync(join(run,'matching-backlog.json'),JSON.stringify({schemaVersion:1,workflow:'C3.2',url,entries:[],pageSteps,pageRequired}));
    return id;
  };
  const id=save('https://careers.example/jobs/2465/candidate?code=private-fixture',[
    {label:'First name',outcome:'changed',reason:'field_changed'},
    {label:'Email/Login',outcome:'changed',reason:'field_changed'},
    {label:'Password',outcome:'skipped',reason:'password_field_preserved'},
    {label:'State/Province',outcome:'skipped',reason:'needs_owner_answer'}
  ],[{label:'Password',reason:'required_empty'}]);
  const second=save('https://hiring.example/jobs/75/secret-path',[
    {label:'City',outcome:'changed',reason:'field_changed'}
  ]);
  let browser;
  try{
    assert.equal((await fetch(service.origin+'/fill-history')).status,401);
    assert.equal((await fetch(service.origin+'/fill-history/'+id)).status,401);
    const index=await (await fetch(service.origin+'/fill-history',{headers:{Authorization:'Bearer '+token}})).text();
    assert.doesNotMatch(index,/private-fixture|secret-path|candidate\?/);
    browser=await chromium.launch({channel:'chromium',headless:true,...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{})});
    const page=await browser.newPage({viewport:{width:1080,height:740}});
    await page.goto(service.origin+'/#token='+token+'&page='+id);
    await page.getByRole('button',{name:'Fill history',exact:true}).click();
    const panel=page.getByRole('region',{name:'Fill history'});
    await panel.getByText('Email/Login',{exact:true}).waitFor();
    assert.match(await panel.locator('li').filter({hasText:'Password'}).innerText(),/Required field was empty after filling\. Enter this password yourself\./);
    assert.equal(await panel.getByLabel('Application page').inputValue(),id);
    await page.screenshot({path:join(root,'full-menu-history.png')});
    await panel.getByLabel('Application page').selectOption(second);
    await panel.getByText('City',{exact:true}).waitFor();
    assert.equal(await panel.getByText('Email/Login',{exact:true}).count(),0);
    await page.goto('about:blank');
    await page.goto(service.origin+'/#token='+token+'&page='+'0'.repeat(24));
    await page.getByRole('button',{name:'Fill history',exact:true}).click();
    await panel.getByText('No fills recorded for this page.').waitFor();
    await page.reload();
    await page.getByRole('button',{name:'Fill history',exact:true}).click();
    await panel.locator('li').first().waitFor();
    await page.setViewportSize({width:320,height:500});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    console.log('Full-menu history evidence:',join(root,'full-menu-history.png'));
  }finally{await browser?.close();await service.close();}
});

test('popup pairs from the workspace, preserves saved keys on failure, and reconnects after restart', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'c3-pairing-'));
  const port = 49191;
  const extension = join(root, 'extension');
  cpSync(resolve('extension'), extension, { recursive: true });
  // Only the loopback port changes; the installed extension and service stay untouched.
  for (const file of ['manifest.json', 'background.js', 'popup.js', 'website-handoff.js']) {
    const path = join(extension, file);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('47831', String(port)));
  }
  let context: BrowserContext | undefined;
  let service = await startProductServer({ root: join(root, 'service'), port });
  try {
    const token = readFileSync(service.tokenPath, 'utf8').trim();
    context = await chromium.launchPersistentContext(join(root, 'browser'), {
      headless: true, channel: 'chromium',
      viewport: { width: 360, height: 640 },
      ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const popup = await context.newPage();
    await popup.goto(worker.url().replace(/background\.js$/, 'popup.html'));
    const connect = popup.getByRole('button', { name: 'Connect to local app', exact: true });
    const clickConnect = async () => {
      await connect.click();
    };
    const savedKey = () => worker.evaluate(async () => (await (globalThis as any).chrome.storage.local.get('token')).token);
    await clickConnect();
    await popup.getByText('Open the full menu in this browser, then connect again.').waitFor();
    assert.equal(await savedKey(), undefined);
    await popup.screenshot({ path: join(root, 'popup-unpaired.png'), fullPage: true });

    const workspace = await context.newPage();
    await workspace.goto(`${service.origin}/#token=${token}`);
    await workspace.waitForFunction(() => !location.hash && Boolean(sessionStorage.getItem('c3-token')));
    await workspace.goto(`${service.origin}/#token=${'a'.repeat(64)}`);
    await workspace.reload();
    await workspace.waitForFunction(expected => sessionStorage.getItem('c3-token')===expected && !location.hash,token);
    await workspace.getByText('Extension disconnected',{exact:true}).waitFor();
    await clickConnect();
    await popup.getByText(/Connection saved\./).waitFor();
    assert.equal(await savedKey(), token);
    await popup.getByText('Connected · Save profile in full menu', { exact: true }).waitFor();
    assert.equal(await popup.locator('#settings').count(), 0, 'connection settings moved out of popup');
    assert.equal(await connect.isVisible(), false, 'connect button hidden once connected');
    assert.equal(service.queue.snapshot().connected, true);

    // Invalid pairing key entered in the full menu Settings panel preserves the saved workspace connection.
    await workspace.getByRole('button', { name: 'Settings', exact: true }).click();
    await workspace.locator('#pairing-settings > summary').click();
    await workspace.locator('#settings-token').fill('invalid-key');
    await workspace.locator('#settings-connect').click();
    await workspace.getByText('Pairing key rejected. Your saved connection was kept.', { exact: true }).waitFor();
    assert.equal(await workspace.evaluate(() => sessionStorage.getItem('c3-token')), token);
    await workspace.close();

    // The saved connection works without an open workspace, including a service restart.
    await popup.reload();
    await popup.getByText('Connected · Save profile in full menu', { exact: true }).waitFor();
    await service.close();
    await popup.getByText('Start the local C3 app to connect', { exact: true }).waitFor();
    await clickConnect();
    await popup.locator('#status[data-error="true"]').waitFor();
    assert.equal(await savedKey(), token);
    service = await startProductServer({ root: join(root, 'service'), port });
    await popup.getByText('Connected · Save profile in full menu', { exact: true }).waitFor();
    assert.equal(service.queue.snapshot().connected, true);
    assert.equal(service.queue.snapshot().jobs.length, 0);
    await popup.screenshot({ path: join(root, 'popup-connected.png'), fullPage: true });
    console.log(`Pairing browser evidence: ${root}`);
  } finally {
    await context?.close();
    await service.close();
  }
});
