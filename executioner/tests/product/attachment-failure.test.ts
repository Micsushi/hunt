import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {AttachmentFailure,ExtensionBridge} from '../../src/product/extension-bridge.ts';

test('known attachment conflicts are fixed codes and unknown messages never escape',()=>{
  for(const [message,code] of [
    ['C3 is already operating this tab.','c3_page_action_busy'],
    ['This tab is already running.','c3_attachment_busy'],
    ['Another debugger is already attached to the tab with id: 123.','debugger_already_attached'],
    ['No tab with id: 123.','attachment_tab_closed'],
    ['Cannot attach to this target.','debugger_access_denied'],
    ['Cannot access a chrome-extension:// URL of different extension','debugger_protected_extension'],
    ['This tab has no usable page area. Resize or restore its browser window, then retry.','attachment_viewport_unavailable'],
    ["Hunt could not restore this tab's page size. Retry the job or page action to finish cleanup before filling.",'attachment_viewport_cleanup_pending'],
    ['The selected tab does not match this job.','attachment_target_mismatch'],
    ['The job page did not load. Retry when the site is available.','attachment_page_not_ready'],
    ['Browser connection closed during attachment. Retry this job.','attachment_connection_closed'],
    ['Another debugger is already attached to the tab with id: secret','attachment_unknown'],
    ['locator.fill: strict mode violation: private typed text','attachment_unknown'],
    ['__proto__','attachment_unknown'],
  ]){
    const error=new AttachmentFailure(new Error(message));assert.equal(error.code,code);
    assert.equal(error.message,'C3 attachment stopped: '+code);assert.equal(error.cause,undefined);
    assert.doesNotMatch(error.stack??'',/private typed|with id:|secret/);
  }
});

test('unknown attach text is bounded in a local private receipt, never the public error',()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-attach-diagnostic-'));
  const previous=process.env.HUNT_C3_PRODUCT_ROOT;
  process.env.HUNT_C3_PRODUCT_ROOT=root;
  try {
    const error=new AttachmentFailure(new Error('fixture private message '+ 'x'.repeat(9000)));
    const receipt=JSON.parse(readFileSync(join(root,'attachment-error.private.json'),'utf8'));
    assert.deepEqual(Object.keys(receipt),['operation','recordedAt','message']);
    assert.equal(receipt.operation,'browser.attach');assert.equal(receipt.message.length,8192);
    assert.doesNotMatch(JSON.stringify(error),/fixture private message/);
    assert.equal(error.message,'C3 attachment stopped: attachment_unknown');
  } finally {
    if(previous===undefined)delete process.env.HUNT_C3_PRODUCT_ROOT;else process.env.HUNT_C3_PRODUCT_ROOT=previous;
  }
});

test('only the attach request is classified; no retry or debugger takeover occurs',async()=>{
  const bridge=new ExtensionBridge(createServer(),'fixture','http://127.0.0.1:1');let calls=0;
  bridge.call=async method=>{calls++;assert.equal(method,'attach');throw new Error('Another debugger is already attached to the tab with id: 123.');};
  try{
    await assert.rejects(bridge.open('https://job-boards.greenhouse.io/fixture/jobs/123',7,true),error=>error instanceof AttachmentFailure&&error.code==='debugger_already_attached');
    assert.equal(calls,1);
  }finally{bridge.close();}
});

test('private transport evidence records only lifecycle enums, never CDP payloads',async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-transport-evidence-'));
  const previous=process.env.HUNT_C3_PRODUCT_ROOT;process.env.HUNT_C3_PRODUCT_ROOT=root;
  const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const bridge=new ExtensionBridge(server,'fixture',origin);
  const socket=new WebSocket(origin.replace('http:','ws:')+'/extension?token=fixture',{origin:'chrome-extension://'+'a'.repeat(32)});
  try {
    await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
    socket.send(JSON.stringify({method:'event',params:{tabId:7,sessionId:'private-session-id',method:'Inspector.detached',params:{reason:'private reason text',secret:'private payload'}}}));
    socket.send(JSON.stringify({method:'event',params:{tabId:7,method:'Runtime.consoleAPICalled',params:{text:'private runtime value'}}}));
    socket.send(JSON.stringify({method:'event',params:{tabId:7,method:'Target.detachedFromTarget',params:{sessionId:'a'.repeat(32),targetId:'b'.repeat(32),secret:'private payload'}}}));
    socket.send(JSON.stringify({method:'event',params:{tabId:7,method:'Target.detachedFromTarget',params:{sessionId:'private-session-id',targetId:'private-target'}}}));
    socket.send(JSON.stringify({method:'detached',params:{tabId:7,reason:'private detach text'}}));
    await new Promise(resolve=>setTimeout(resolve,30));socket.close(1000,'private close reason');
    await new Promise<void>(resolve=>socket.once('close',()=>resolve()));await new Promise(resolve=>setTimeout(resolve,10));
    const text=readFileSync(join(root,'browser-transport.private.json'),'utf8');
    assert.doesNotMatch(text,/private|Runtime.consoleAPICalled/);
    const events=JSON.parse(text);
    assert.deepEqual(events.map((event:any)=>event.event),['Inspector.detached','Target.detachedFromTarget','Target.detachedFromTarget','extension_reported_detach','extension_connection_closed']);
    assert.equal(events[0].reason,'unspecified_or_other');assert.equal(events[0].childSession,true);assert.equal(events[4].code,1000);
    assert.equal(events[1].detachedSessionId,'a'.repeat(32));assert.equal(events[1].detachedTargetId,'b'.repeat(32));
    assert.equal(events[1].detachedTargetIsRoot,false);assert.equal(events[1].detachedSessionIsRoot,false);
    assert.equal(events[2].detachedTargetId,undefined);assert.equal(events[2].detachedSessionId,undefined);
  } finally {
    socket.terminate();bridge.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(previous===undefined)delete process.env.HUNT_C3_PRODUCT_ROOT;else process.env.HUNT_C3_PRODUCT_ROOT=previous;
  }
});
