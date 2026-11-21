import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
