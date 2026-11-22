import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {WebSocket} from 'ws';
import {startProductServer} from '../../src/product/server.ts';

test('authenticated diagnostics return only sanitized extension metadata without attaching',async()=>{
  const source=readFileSync('extension/background.js','utf8').replace("const instanceId = crypto.randomUUID();", "const instanceId = 'fixture-instance';").replace(/^import .*workday-account.*\r?\n/m, "").replace(/^import .*page-actions.*\r?\n/m,'const pageActionTabs=new Set();\n').replace(/^import .*website-handoff.*\r?\n/m,'const registerWebsiteHandoff=()=>{};\n').replace(/^import .*page-viewport.*\r?\n/m,'const preparePageViewport=async()=>async()=>{};\n');
  const event={addListener(){}};let reads=0;
  const chrome={storage:{local:{get:async()=>({})}},runtime:{onMessage:event,onStartup:event},tabs:{},debugger:{onEvent:event,onDetach:event,getTargets:async()=>{reads++;return [
    {id:'one',tabId:7,type:'page',attached:false,title:'Private title',url:'https://example.invalid/private?token=private'},
    {id:'two',type:'background_page',attached:true,title:'Private extension title',url:'chrome-extension://'+'a'.repeat(32)+'/private.html?token=private'},
  ]},attach:()=>assert.fail('No diagnostic attachment')}};
  const command=runInNewContext(source+'\ncommand',{chrome,URL,WebSocket:{OPEN:1},setTimeout,clearTimeout,setInterval,clearInterval});
  const metadata=JSON.parse(JSON.stringify(await command('browserDiagnostics',{})));
  assert.deepEqual(metadata,[{targetId:'one',type:'page',attached:false,tabId:7},{targetId:'two',type:'background_page',attached:true,extensionOrigin:'chrome-extension://'+'a'.repeat(32)}]);
  assert.equal(reads,1);assert.doesNotMatch(JSON.stringify(metadata),/private|title|token/i);
  const service=await startProductServer({root:mkdtempSync(join(tmpdir(),'c3-browser-diagnostic-')),port:0});
  let socket:WebSocket|undefined,requests=0;
  try {
    assert.equal((await fetch(service.origin+'/browser/diagnostics')).status,401);
    const token=readFileSync(service.tokenPath,'utf8').trim();
    socket=new WebSocket(service.origin.replace('http:','ws:')+'/extension?token='+encodeURIComponent(token),{origin:'chrome-extension://'+'a'.repeat(32)});
    socket.on('message',raw=>{const message=JSON.parse(raw.toString());requests++;assert.equal(message.method,'browserDiagnostics');socket!.send(JSON.stringify({id:message.id,result:metadata}));});
    await new Promise<void>((resolve,reject)=>{socket!.once('open',resolve);socket!.once('error',reject)});
    const result=await fetch(service.origin+'/browser/diagnostics',{headers:{authorization:'Bearer '+token}});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),metadata);assert.equal(requests,1);
  } finally {socket?.terminate();await service.close();}
});
