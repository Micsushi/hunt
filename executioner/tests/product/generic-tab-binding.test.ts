import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startProductServer} from '../../src/product/server.ts';
import {ExtensionBridge} from '../../src/product/extension-bridge.ts';
import {ApplicationQueue} from '../../src/product/queue.ts';
import {applicantProfile} from '../../src/product/sources.ts';

test('normal add binds only an existing paused generic job without changing its selected input or starting it',async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-generic-bind-'));let opens=0;
  const bridge={connected:false,open:async()=>{opens++;throw new Error('Unexpected browser operation')},release:async()=>{}};
  const queue=new ApplicationQueue(root,bridge);
  try {
    const url='https://fixture.bamboohr.com/careers/123';
    queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),Buffer.from('%PDF-default').toString('base64'));
    assert.throws(()=>queue.add([{url,tabId:7}]),/Import unfamiliar/);
    const job=queue.add([{url,sourceJobId:123,resumeVersion:'v18',resumeBase64:Buffer.from('%PDF-selected').toString('base64')}],{paused:true})[0]!;
    const path=join(root,job.id+'.input.json'),before=readFileSync(path,'utf8');const {tabId:originalTab,...metadata}=job;
    const journal=join(root,job.id+'.account-journal.json');writeFileSync(journal,'saved journal');bridge.connected=true;
    const bound=queue.add([{url,tabId:7}])[0]!;
    assert.equal(bound.id,job.id);assert.equal(bound.tabId,7);assert.equal(bound.status,'paused');
    const {tabId,...rest}=bound;assert.deepEqual(rest,metadata);
    assert.equal(readFileSync(path,'utf8'),before);assert.equal(readFileSync(journal,'utf8'),'saved journal');assert.equal(opens,0);
    for(const extra of [{resumeBase64:Buffer.from('%PDF-other').toString('base64')},{sourceJobId:999},{title:'changed'}])assert.throws(()=>queue.add([{url,tabId:8,...extra}]),/Import unfamiliar/);
    assert.throws(()=>queue.add([{url:url.replace('/123','/124'),tabId:7}]),/Import unfamiliar/);
    for(const status of ['running','queued','review'] as const){job.status=status;assert.throws(()=>queue.add([{url,tabId:8}]),/Import unfamiliar/);}job.status='paused';
    (queue as any).running.set(job.id,new AbortController());assert.throws(()=>queue.add([{url,tabId:8}]),/Import unfamiliar/);(queue as any).running.delete(job.id);
    assert.equal(readFileSync(path,'utf8'),before);assert.equal(opens,0);
  } finally {await queue.close();}
});

test('selected Jobvite Prepare binds only the inspected first step and preserves the default PDF',async()=>{
  const root = mkdtempSync(join(tmpdir(),'c3-jobvite-preparation-'));
  const app = await startProductServer({root,port:0});
  const url = 'https://jobs.jobvite.com/fixture/job/abc/apply', documentId='a'.repeat(64);
  const input={jobs:[{url,tabId:7}],documentId};
  const auth={Authorization:'Bearer '+readFileSync(app.tokenPath,'utf8'),'Content-Type':'application/json'};
  const prepare=(body:unknown)=>fetch(app.origin+'/jobs',{method:'POST',headers:auth,body:JSON.stringify(body)});
  const observed={url,documentId,mainDocumentId:'first-loader',tabId:7,jobviteFirstStep:true,operation:'inspect'};
  let seen={...observed};
  const bridge=(app.queue as unknown as {bridge:ExtensionBridge}).bridge;
  bridge.call=async method=>{assert.equal(method,'pageAction');return seen;};
  try{
    const pdf=Buffer.from('%PDF-selected-default').toString('base64');
    app.queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),pdf);
    for (const invalid of [
      {...input,jobs:[{url,tabId:7,sourceJobId:92}]},
      {...input,jobs:[{url:url.replace('/fixture/','/other/'),tabId:7}]},
      {...input,jobs:[{url,tabId:9}]}, {...input,documentId:'b'.repeat(64)},
    ])assert.equal((await prepare(invalid)).status,400);
    seen={...observed,jobviteFirstStep:false};
    assert.equal((await prepare(input)).status,400);assert.equal(app.queue.jobs.length,0);
    seen=observed;
    assert.equal((await prepare(input)).status,200);
    const job=app.queue.jobs[0]!;
    assert.equal(job.tabId,7);assert.equal(job.selectedDocument,'first-loader');assert.equal(job.status,'paused');
    assert.equal(job.submissionAllowed,false);assert.equal(job.sourceJobId,undefined);
    assert.equal(JSON.parse(readFileSync(join(root,job.id+'.input.json'),'utf8')).resume,pdf);
    assert.equal((await prepare(input)).status,200);assert.equal(app.queue.jobs.length,1);
    const other='https://jobs.jobvite.com/fixture/job/xyz/apply';
    app.queue.add([{url:other,sourceJobId:99,resumeVersion:'v1',resumeBase64:Buffer.from('%PDF-other').toString('base64')}],{paused:true});
    seen={...observed,url:other,tabId:9};
    assert.equal((await prepare({jobs:[{url:other,tabId:9}],documentId})).status,400);
    const calls:string[]=[];
    let current=url.replace('/apply','');
    bridge.call=async(method,args={})=>{
      calls.push(method);
      if(method==='pageTabs')return [{tabId:7,url:current}];
      if(method==='attach'){assert.equal(args.existingOnly,true);assert.equal(args.selectedDocument,'first-loader');return {tabId:7,targetId:'tab'};}
      assert.equal(method,'detach');return {};
    };
    await assert.rejects(bridge.open(url,7,true,'first-loader'),/address changed/);
    current=url;
    await assert.rejects(bridge.open(url,7,true,'first-loader'),/confirm the selected application document/);
    assert.deepEqual(calls,['pageTabs','pageTabs','attach','detach']);
  }finally{await app.close();}
});
