import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('extension/website-handoff.js','utf8').replace(/^export function /gm,'function ');
const trusted = {origin:'https://agent-hunt-review.mshi.ca',url:'https://agent-hunt-review.mshi.ca/jobs/1',frameId:0};
const message = (operation: string) => ({protocol:'hunt-c3-handoff-v1',operation,expiresAt:Date.now()+10000,bundle:{jobs:[{sourceJobId:1}]}});

function fixture(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
  let listener: (message: unknown, sender: unknown, respond: (value: any) => void) => unknown;
  const opened: string[] = [];
  const chrome = {runtime:{onMessageExternal:{addListener(value: typeof listener){listener=value;}}},storage:{local:{get:async()=>({token:'private-test-key'})}},tabs:{create:async({url}:{url:string})=>{opened.push(url);}}};
  runInNewContext(source+'\nregisterWebsiteHandoff(chrome,()=>true);',{chrome,fetch:fetcher,URL,TextEncoder,AbortSignal,Date,Number,JSON,Error,encodeURIComponent});
  const call = (input: unknown, sender: unknown = trusted) => new Promise<any>(resolve=>{if(listener(input,sender,resolve)!==true)resolve(undefined);});
  return {call,opened};
}

test('website handoff restricts origins, frames and operations; redacts service state', async()=>{
  const paths: string[]=[];
  const f=fixture(async(url,init)=>{paths.push(url);assert.equal((init.headers as any).Authorization,'Bearer private-test-key');return Response.json({connected:true,configured:true,account:{email:'private'},token:'never-return'});});
  for (const sender of [{...trusted,origin:'https://evil.example'},{...trusted,url:'https://evil.example'},{...trusted,frameId:1},{...trusted,id:'other-extension'},{...trusted,url:'broken'},{...trusted,documentLifecycle:'prerender'}]) assert.equal(await f.call(message('status'),sender),undefined);
  for(const operation of ['pageAction','settings','account','connect','submit'])assert.equal(await f.call(message(operation)),undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(await f.call(message('status')))),{ok:true,result:{connected:true,configured:true}});
  assert.deepEqual(paths,['http://127.0.0.1:47831/agent/status']);
});

test('imports use paused endpoint only, serialize, preserve keys and never echo private errors',async()=>{
  const paths:string[]=[]; let release:()=>void=()=>{};
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const f=fixture(async(url)=>{
    paths.push(url);
    if(url.endsWith('/handoff/preview')){await waiting;return Response.json({jobs:[{sourceJobId:1,resumeVersion:'8',status:'new',resumeBase64:'private'}]});}
    return Response.json([{id:'test',sourceJobId:1,resumeVersion:'8',status:'paused',profile:'private'}]);
  });
  assert.equal((await f.call({...message('import'),expiresAt:Date.now()-1})).code,'expired');
  assert.deepEqual(paths, []);
  await new Promise<void>(resolve => setImmediate(resolve)); // The next browser message arrives on another task.
  const first=f.call(message('import'));
  assert.equal((await f.call(message('import'))).code,'busy');
  release();
  const reply=await first;
  assert.equal(reply.ok,true);assert.equal(reply.result.jobs[0].status,'paused');
  assert.equal(JSON.stringify(reply).includes('private'),false);
  assert.deepEqual(paths,['http://127.0.0.1:47831/handoff/preview','http://127.0.0.1:47831/handoff/import-paused']);
  assert.deepEqual(f.opened,[]);assert.equal(reply.result.workspaceOpened,false);
  const old=fixture(async(url)=>url.endsWith('preview')?Response.json({jobs:[]}):new Response('',{status:404}));
  assert.equal((await old.call(message('import'))).code,'update_required');
  assert.deepEqual(old.opened,[]);
  const broken=fixture(async()=>{throw new Error('private-key applicant-private-details');});
  assert.deepEqual(JSON.parse(JSON.stringify(await broken.call(message('import')))),{ok:false,code:'unconfirmed'});
});
