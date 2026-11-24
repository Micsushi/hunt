import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {cpSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WebSocketServer} from 'ws';
import {chromium,type BrowserContext} from 'playwright';

test('trusted website reaches only the paired paused-import bridge in a real extension', {timeout:60000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-website-'));
  const paths:string[]=[];
  const token='b'.repeat(64);
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
    paths.push(req.url!);
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
    res.setHeader('Content-Type','application/json');
    if(req.url==='/agent/status'||req.url==='/state')res.end(JSON.stringify({connected:true,configured:true,private:'not-for-website'}));
    else if(req.url==='/handoff/preview')res.end(JSON.stringify({jobs:body.jobs.map((j:any)=>({sourceJobId:j.sourceJobId,resumeVersion:j.resumeVersion,status:'new'}))}));
    else if(req.url==='/handoff/import-paused')res.end(JSON.stringify(body.jobs.map((j:any)=>({id:'fixture',sourceJobId:j.sourceJobId,resumeVersion:j.resumeVersion,status:'paused'}))));
    else res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const sockets=new WebSocketServer({server});
  const extension=join(root,'extension');cpSync(resolve('extension'),extension,{recursive:true});
  for(const name of ['manifest.json','background.js','popup.js','website-handoff.js']){
    const p=join(extension,name);writeFileSync(p,readFileSync(p,'utf8').replaceAll('47831',String(port)));
  }
  let context:BrowserContext|undefined;
  try{
    context=await chromium.launchPersistentContext(join(root,'profile'),{headless:true,channel:'chromium',...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    const id=new URL(worker.url()).host;
    const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.getByText('Open the full menu in this browser, then connect again.',{exact:true}).waitFor();
    await context.route(`http://127.0.0.1:${port}/`,route=>route.fulfill({contentType:'text/html',body:'<title>Existing workspace</title><label>Draft<textarea>Unsaved fixture details</textarea></label>'}));
    const workspace=await context.newPage();await workspace.goto(`http://127.0.0.1:${port}/#token=${token}`);
    await popup.getByRole('button',{name:'Connect to local app',exact:true}).click();
    await popup.locator('#connection[data-ready="true"]').waitFor({state:'attached'});
    assert.equal(await popup.getByRole('button',{name:'Connect to local app',exact:true}).isVisible(),false);
    assert.equal(await popup.locator('#settings').count(),0);
    await context.route('https://agent-hunt-review.mshi.ca/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Hunt website fixture</title><h1>Applications</h1>'}));
    const page=await context.newPage();await page.goto('https://agent-hunt-review.mshi.ca/executioner');
    const send=async(operation:string,extra:object={})=>page.evaluate(({id,operation,extra})=>new Promise<any>(resolve=>{
      (globalThis as any).chrome.runtime.sendMessage(id,{protocol:'hunt-c3-handoff-v1',operation,expiresAt:Date.now()+15000,...extra},(reply:any)=>resolve(reply??{error:(globalThis as any).chrome.runtime.lastError?.message}));
    }),{id,operation,extra});
    assert.deepEqual(await send('status'),{ok:true,result:{connected:true,configured:true}});
    await page.bringToFront();
    const pagesBefore=context.pages().length;
    const activeBefore=await worker.evaluate(async()=>(await (globalThis as any).chrome.tabs.query({active:true})).map((tab:any)=>tab.id));
    const bundle={format:'hunt-c3-handoff',version:1,jobs:[{sourceJobId:123,resumeVersion:'8'}]};
    const reply=await send('import',{bundle});
    assert.equal(reply.ok,true);assert.equal(reply.result.jobs[0].status,'paused');assert.equal(reply.result.workspaceOpened,false);
    assert.equal(context.pages().length,pagesBefore);assert.equal(await workspace.locator('textarea').inputValue(),'Unsaved fixture details');
    assert.deepEqual(await worker.evaluate(async()=>(await (globalThis as any).chrome.tabs.query({active:true})).map((tab:any)=>tab.id)),activeBefore);
    assert.equal(JSON.stringify(reply).includes(token),false);
    assert.equal(paths.filter(path=>path==='/handoff/import-paused').length,1);
    assert.equal(paths.includes('/handoff/import'),false);
    assert.equal(await worker.evaluate(async()=> (await (globalThis as any).chrome.storage.local.get('token')).token),token);
    const previous=paths.length;
    await send('pageAction',{operation:'pageAction',url:'http://127.0.0.1/settings'});
    assert.equal(paths.length,previous);
    await page.screenshot({path:join(root,'website-transport.png')});
  }finally{
    await context?.close();for(const socket of sockets.clients)socket.terminate();await new Promise<void>(resolve=>sockets.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
