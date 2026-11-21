import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const backgroundSource = readFileSync("extension/background.js", "utf8").replace("const instanceId = crypto.randomUUID();", "const instanceId = 'fixture-instance';").replace(/^import .*workday-account.*\r?\n/m, "").replace(/^import .*page-actions.*\r?\n/m, "const pageActionTabs = new Set();\n").replace(/^import .*website-handoff.*\r?\n/m, "const registerWebsiteHandoff = () => {};\n").replace(/^import .*page-viewport.*\r?\n/m,"const preparePageViewport = globalThis.viewportFixture ?? (async()=>async()=>{}); const viewportOwnership = globalThis.ownershipFixture ?? (()=>({has:async()=>false})); const viewportCleanupPending = \"Hunt could not restore this tab's page size. Retry the job or page action to finish cleanup before filling.\";\n");
const timers = { setTimeout, clearTimeout, setInterval, clearInterval };

test('failed restore remains actionable even when debugger detach also rejects',async()=>{
  const event={addListener(){}};const url='https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1';
  let detaches=0;
  const chrome={storage:{local:{get:async()=>({})}},runtime:{onMessage:event,onStartup:event},tabs:{get:async()=>({id:7,url,status:'complete'})},debugger:{onEvent:event,onDetach:event,attach:async()=>{},detach:async()=>{detaches++;throw new Error('session gone');},getTargets:async()=>[{tabId:7,id:'target'}]}};
  const viewportFixture=async()=>async()=>{throw new Error('clear rejected');};
  const command=runInNewContext(backgroundSource+'\nsocket={readyState:1};command',{chrome,URL,WebSocket:{OPEN:1},viewportFixture,...timers});
  await command('attach',{url,tabId:7});
  await assert.rejects(command('detach',{tabId:7}),/finish cleanup before filling/);
  assert.equal(detaches,1);
});

test('unsolicited detach preserves owned cleanup and never reattaches or clears',async()=>{
  const event={addListener(){}};const url='https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1';
  let listener:Function=()=>{},attaches=0,restores=0;const sent:any[]=[];
  const chrome={storage:{local:{get:async()=>({})}},runtime:{onMessage:event,onStartup:event},tabs:{get:async()=>({id:7,url,status:'complete'})},debugger:{onEvent:event,onDetach:{addListener(fn:Function){listener=fn;}},attach:async()=>{attaches++;},detach:async()=>assert.fail('No detach takeover'),getTargets:async()=>[{tabId:7,id:'target',attached:false}]}};
  const viewportFixture=async()=>async()=>{restores++;};
  const ownershipFixture=()=>({has:async()=>true});
  const command=runInNewContext(backgroundSource+'\nsocket={readyState:1,send:value=>sent.push(JSON.parse(value))};command',{chrome,URL,WebSocket:{OPEN:1},viewportFixture,ownershipFixture,sent,...timers});
  await command('attach',{url,tabId:7});await listener({tabId:7},'target_closed');
  assert.equal(attaches,1);assert.equal(restores,0);
  assert.equal(sent[0].params.viewportCleanupPending,true);assert.equal(sent[0].params.reason,'target_closed');
});

test('owned viewport restoration runs before detach on release and failed attachment',async()=>{
  for(const failure of [false,true]){
    const events:string[]=[];const event={addListener(){}};
    const url='https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1';
    const chrome={storage:{local:{get:async()=>({})}},runtime:{onMessage:event,onStartup:event},tabs:{get:async()=>({id:7,url,status:'complete'})},debugger:{onEvent:event,onDetach:event,attach:async()=>{},detach:async()=>{events.push('detach')},getTargets:async()=>failure?[]:[{tabId:7,id:'target'}]}};
    const viewportFixture=async()=>{events.push('prepare');return async()=>{events.push('restore')}};
    const command=runInNewContext(backgroundSource+'\nsocket={readyState:1};command',{chrome,URL,WebSocket:{OPEN:1},viewportFixture,...timers});
    if(failure)await assert.rejects(command('attach',{url,tabId:7}),/connection closed/);
    else {await command('attach',{url,tabId:7});await command('detach',{tabId:7});}
    assert.deepEqual(events,failure?['detach']:['prepare','restore','detach']);
  }
});

test('socket cleanup restores its owned viewport before debugger detach',async()=>{
  let token:string|undefined;const sockets:any[]=[];const events:string[]=[];
  class Socket {static OPEN=1;static CONNECTING=0;static CLOSING=2;readyState=1;onclose=()=>{};constructor(){sockets.push(this)}close(){this.readyState=3;this.onclose()}}
  const event={addListener(){}};const url='https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1';
  const chrome={storage:{local:{get:async()=>({token})}},runtime:{onMessage:event,onStartup:event},tabs:{get:async()=>({id:7,url,status:'complete'})},debugger:{onEvent:event,onDetach:event,attach:async()=>{},detach:async()=>{events.push('detach')},getTargets:async()=>[{tabId:7,id:'target'}]}};
  const viewportFixture=async()=>async()=>{events.push('restore')};
  const api=runInNewContext(backgroundSource+'\n({connect,command,drain:()=>cleanup})',{chrome,URL,WebSocket:Socket,viewportFixture,setTimeout:()=>0,clearTimeout,setInterval,clearInterval});
  token='fixture';await api.connect();await api.command('attach',{url,tabId:7});sockets[0].close();await api.drain();
  assert.deepEqual(events,['restore','detach']);
});

test('popup actions use the guarded service route and never read a default resume directly',async()=>{
  let listener:Function=()=>{},request:any;const event={addListener(){}};
  const chrome={storage:{local:{get:async()=>({token:'fixture-key'})}},runtime:{id:'fixture',getURL:(path:string)=>'chrome-extension://fixture/'+path,onMessage:{addListener(fn:Function){listener=fn;}},onStartup:event},tabs:{},debugger:{onEvent:event,onDetach:event}};
  let fetches=0;
  const fetch=async(url:string,options:any)=>{fetches++;assert.equal(url,'http://127.0.0.1:47831/browser/page');request=JSON.parse(options.body);return{ok:false,status:400,json:async()=>({error:'Use the queued application in Applications.'})};};
  runInNewContext(backgroundSource.replace(/^void connect\(\);\s*$/m,''),{chrome,URL,fetch,AbortSignal,WebSocket:{OPEN:1},...timers});
  const message={action:'pageAction',operation:'fill',tabId:7,expectedUrl:'https://fixture.example/apply',documentId:'doc',expiresAt:Date.now()+5000};
  const reply=await new Promise<any>(resolve=>listener(message,{id:'fixture',url:chrome.runtime.getURL('popup.html')},resolve));
  assert.equal(reply.ok,false);assert.match(reply.error,/queued/);assert.equal(fetches,1);
  assert.equal(request.documentId,'doc');assert.equal(request.expiresAt,message.expiresAt);assert.equal('facts' in request,false);assert.equal('resume' in request,false);
  const expired=await new Promise<any>(resolve=>listener({...message,expiresAt:1},{id:'fixture',url:chrome.runtime.getURL('popup.html')},resolve));
  assert.equal(expired.ok,false);assert.equal(fetches,1);
});

test('explicit generic attachment binds the exact URL and document and refuses navigation',async()=>{
  const original='https://solace.bamboohr.com/careers/823';
  const tab={id:7,url:original,status:'complete',discarded:false};let loader='document-one';
  const event={addListener(){}};
  const chrome={storage:{local:{get:async()=>({})}},runtime:{onMessage:event,onStartup:event},tabs:{get:async()=>({...tab})},debugger:{onEvent:event,onDetach:event,attach:async()=>{},detach:async()=>{},getTargets:async()=>[{tabId:7,id:'target'}],sendCommand:async()=>({frameTree:{frame:{loaderId:loader}}})}};
  const command=runInNewContext(backgroundSource+'\nsocket={readyState:1}; command',{chrome,URL,WebSocket:{OPEN:1},...timers});
  await assert.rejects(command('attach',{tabId:7,url:original}),/supported job/);
  await command('attach',{tabId:7,url:original,generic:true});
  assert.equal((await command('info',{tabId:7})).url,original);
  await assert.rejects(command('cdp',{tabId:7,method:'Page.navigate',params:{url:original}}),/current page/);
  tab.url='https://solace.bamboohr.com/careers/999';
  await assert.rejects(command('info',{tabId:7}),/document changed/);
  tab.url='https://evil.example/careers/823';
  await assert.rejects(command('info',{tabId:7}),/document changed/);
  tab.url=original;loader='document-two';
  await assert.rejects(command('info',{tabId:7}),/document changed/);
  await command('detach',{tabId:7});
});

test('released generic drafts can be focused only at their exact admitted URL',async()=>{
  const original='https://solace.bamboohr.com/careers/823';let url=original,focused=0;
  const event={addListener(){}};
  const chrome={storage:{local:{get:async()=>({})}},runtime:{onMessage:event,onStartup:event},tabs:{get:async()=>({id:7,url,windowId:1}),update:async()=>{focused++;}},windows:{update:async()=>{}},debugger:{onEvent:event,onDetach:event}};
  const command=runInNewContext(backgroundSource+'\ncommand',{chrome,URL,WebSocket:{OPEN:1},...timers});
  await assert.rejects(command('focus',{tabId:7,url:original}),/selected application/);
  await command('focus',{tabId:7,url:original,generic:true});assert.equal(focused,1);
  url='https://solace.bamboohr.com/careers/999';
  await assert.rejects(command('focus',{tabId:7,url:original,generic:true}),/selected application/);
  url='https://evil.example/';
  await assert.rejects(command('focus',{tabId:7,url:original,generic:true}),/selected application/);
  await assert.rejects(command('focus',{tabId:7,generic:true}),/selected application/);
  assert.equal(focused,1);
});

test("naturally discarded tabs wake before attachment and completed tabs stay loaded", async () => {
  let reloads = 0;
  const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1/apply";
  const tab = { id: 1, url, active: false, discarded: false, status: "complete" };
  const event = { addListener() {} };
  const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: event, onStartup: event },
    tabs: {
      get: async () => ({ ...tab }), create: async () => ({ ...tab }),
      discard: async () => { assert.fail("C3 must leave completed tabs loaded"); },
      reload: async () => { reloads++; tab.discarded = false; tab.status = "complete"; } },
    debugger: { onEvent: event, onDetach: event, detach: async () => {},
      attach: async () => { assert.equal(tab.discarded, false); assert.equal(tab.status, "complete"); }, getTargets: async () => [{ tabId: 1, id: "target" }] } };
  const command = runInNewContext(backgroundSource + "\nsocket={readyState:1}; command", { chrome, URL, WebSocket: { OPEN: 1 }, ...timers });
  await command('attach', { url });
  await command('detach', { tabId: 1 });
  assert.equal(reloads, 0);
  assert.equal(tab.discarded, false);
  tab.discarded = true;
  tab.status = "unloaded";
  await command('attach', { tabId: 1, url, existingOnly: true });
  assert.equal(reloads, 1);
  await command('detach', { tabId: 1 });
});

test("extension cleans interrupted attachments and recreates missing tabs", async () => {
  for (const scenario of ["disconnect", "missing-target", "closed-tab"]) {
    let detached = 0, created = 0;
    const connection = { readyState: 1 };
    const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1";
    const event = { addListener() {} };
    const chrome = {
      storage: { local: { get: async () => ({}) } },
      runtime: { onMessage: event, onStartup: event },
      tabs: {
        get: async () => { if (scenario === "closed-tab") throw new Error("No tab with id: 99."); return { id: 1, url, status: "complete" }; },
        create: async () => { created++; return { id: 1, url, status: "complete" }; },
      },
      debugger: {
        onEvent: event, onDetach: event,
        attach: async () => { if (scenario === "disconnect") connection.readyState = 3; },
        detach: async () => { detached++; },
        getTargets: async () => scenario === "missing-target" ? [] : [{ tabId: 1, id: "target" }],
      },
    };
    const run = runInNewContext(backgroundSource + "\n(value) => { socket = value; return command('attach', {url:'" + url + "',tabId:99}, value); }", { chrome, URL, WebSocket: { OPEN: 1 }, ...timers });
    if (scenario === "closed-tab") { assert.equal((await run(connection)).tabId, 1); assert.equal(created, 1); }
    else { await assert.rejects(run(connection), /connection closed/); assert.equal(detached, 1); }
  }
});

test("reconnection waits for the old socket cleanup", async () => {
  let finishClose: () => void = () => {}, opened = 0;
  const old = { readyState: 2, addEventListener: (_: string, callback: () => void) => { finishClose = callback; } };
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2;
    constructor() { opened++; }
  }
  const event = { addListener() {} };
  const chrome = { storage: { local: { get: async () => ({}) } }, tabs: {}, runtime: { onMessage: event, onStartup: event }, debugger: { onEvent: event, onDetach: event } };
  const connectOld = runInNewContext(backgroundSource + "\nold => { socket = old; chrome.storage.local.get = async () => ({token:'fixture'}); return connect(); }", { chrome, WebSocket: Socket, URL, ...timers });
  const pending = connectOld(old);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, 0);
  old.readyState = 3; finishClose();
  await pending;
  assert.equal(opened, 1);
});

test("failed created tabs and failed CDP setup reuse the same tab without closing user drafts", async () => {
  for (const failure of ["load", "attach", "target", "cdp"]) {
    let created = 0, shouldFail = true, removedListener = (_: number) => {};
    const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1";
    const event = { addListener() {} };
    const tabs = new Map<number, { id: number; url: string; status: string }>();
    const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: event, onStartup: event },
      tabs: {
        create: async () => { const tab = { id: ++created, url, status: failure === "load" ? "loading" : "complete" }; tabs.set(created, tab); return tab; },
        get: async (id: number) => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`); return tabs.get(id); },
        remove: async () => { assert.fail("Failed opening must preserve a draft the user may have inspected"); },
        onRemoved: { addListener(listener: typeof removedListener) { removedListener = listener; } },
      },
      debugger: { onEvent: event, onDetach: event, detach: async () => {},
        attach: async () => { if (failure === "attach" && shouldFail) throw new Error("debugger unavailable"); },
        getTargets: async () => failure === "target" && shouldFail ? [] : [...tabs.keys()].map(tabId => ({ tabId, id: `target-${tabId}` })),
      } };
    let clock = 0;
    const command = runInNewContext(backgroundSource + "\nsocket={readyState:1}; command", { chrome, URL, Date: { now: () => clock += 31_000 }, WebSocket: { OPEN: 1 }, ...timers });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (failure === "cdp") {
        const result = await command("attach", { url });
        // The service detaches when connectOverCDP fails before queue registration.
        await command("detach", { tabId: result.tabId });
      } else if (failure === "load" && attempt === 1) {
        // Existing tabs can be attached while loading; later CDP failures still reuse them.
        const result = await command("attach", { url });
        await command("detach", { tabId: result.tabId });
      } else await assert.rejects(command("attach", { url }));
      assert.equal(created, 1);
    }
    shouldFail = false;
    tabs.get(1)!.status = "complete";
    assert.equal((await command("attach", { url })).tabId, 1);
    await command("detach", { tabId: 1 });
    tabs.delete(1); removedListener(1);
    if (failure === "load") await assert.rejects(command("attach", { url }), /did not load/);
    else assert.equal((await command("attach", { url })).tabId, 2);
    assert.equal(created, 2);
  }
});

test("reconnection drains pending attachment and detach before a new socket opens", async () => {
  let releaseAttach = () => {}, releaseDetach = () => {}, attachStarted = false, detachStarted = false;
  let token: string | undefined;
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0; static CLOSING = 2;
    readyState = 1; onclose = () => {};
    constructor() { sockets.push(this); }
    close() { this.readyState = 3; this.onclose(); }
  }
  const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1";
  const event = { addListener() {} };
  const chrome = { storage: { local: { get: async () => ({ token }) } }, runtime: { onMessage: event, onStartup: event },
    tabs: { get: async () => ({ id: 1, url, status: "complete" }) },
    debugger: { onEvent: event, onDetach: event,
      attach: () => { attachStarted = true; return new Promise<void>(resolve => { releaseAttach = resolve; }); },
      detach: () => { detachStarted = true; return new Promise<void>(resolve => { releaseDetach = resolve; }); },
      getTargets: async () => [{ tabId: 1, id: "target" }],
    } };
  const api = runInNewContext(backgroundSource + "\n({connect,command})", { chrome, URL, WebSocket: Socket, ...timers });
  token = "fixture"; await api.connect();
  const opening = assert.rejects(api.command("attach", { url, tabId: 1 }), /connection closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attachStarted, true);
  sockets[0]!.close();
  const reconnecting = api.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 1);
  releaseAttach();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(detachStarted, true);
  assert.equal(sockets.length, 1);
  releaseDetach();
  await Promise.all([opening, reconnecting]);
  assert.equal(sockets.length, 2);
});

test("a stale detach event cannot remove the replacement attachment", async () => {
  let detachedListener = async (_: { tabId: number }) => {}, targetAttached = true;
  const url = "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1";
  const event = { addListener() {} };
  const chrome = { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: event, onStartup: event },
    tabs: { get: async () => ({ id: 1, url, status: "complete" }) },
    debugger: { onEvent: event, onDetach: { addListener(listener: typeof detachedListener) { detachedListener = listener; } },
      attach: async () => {}, detach: async () => {},
      getTargets: async () => [{ tabId: 1, id: "target", attached: targetAttached }],
    } };
  const command = runInNewContext(backgroundSource + "\nsocket={readyState:1,send(){}}; command", { chrome, URL, WebSocket: { OPEN: 1 }, ...timers });
  await command("attach", { url, tabId: 1 });
  await command("detach", { tabId: 1 });
  await command("attach", { url, tabId: 1 });
  await detachedListener({ tabId: 1 });
  assert.equal((await command("info", { tabId: 1 })).targetId, "target");
  targetAttached = false;
  await detachedListener({ tabId: 1 });
  await assert.rejects(command("info", { tabId: 1 }), /not attached/);
});
