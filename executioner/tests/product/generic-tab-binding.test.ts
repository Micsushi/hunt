import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {fillApplication} from '../../src/product/engine.ts';
import {startProductServer} from '../../src/product/server.ts';
import {applicantProfile} from '../../src/product/sources.ts';
import {productApplicationTarget} from '../../src/product/target.ts';

test('unfamiliar applications stay on the current page and old selected inputs remain protected',async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-page-scope-'));
  const url='https://fixture.bamboohr.com/careers/123';
  const id=randomUUID(), resume=Buffer.from('%PDF-selected');
  const smartId=randomUUID(), company='Fixture', postingId='744000123456789', uuid=randomUUID();
  const postingUrl='https://jobs.smartrecruiters.com/'+company+'/'+postingId+'-analyst';
  const personal='https://jobs.smartrecruiters.com/oneclick-ui/company/'+company+'/publication/'+uuid;
  const selectedApplicationUrl=personal+'/screening?dcr_ci='+company;
  const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'});
  const input=JSON.stringify({profile,resume:resume.toString('base64')});
  const inputPath=join(root,id+'.input.json');
  writeFileSync(inputPath,input);
  writeFileSync(join(root,'jobs.json'),JSON.stringify({concurrency:1,jobs:[
    {...productApplicationTarget(url),id,url,status:'queued',sourceJobId:123,resumeVersion:'v18',submissionAllowed:false},
    {...productApplicationTarget(postingUrl),id:smartId,url:postingUrl,status:'paused',tabId:4,selectedDocument:'original-loader',selectedApplicationUrl}
  ]}));
  const app=await startProductServer({root,port:0});
  const post=(path:string,body:unknown)=>fetch(app.origin+path,{method:'POST',headers:{
    Authorization:'Bearer '+readFileSync(app.tokenPath,'utf8'),'Content-Type':'application/json'
  },body:JSON.stringify(body)});
  const fetchLocal=globalThis.fetch;
  let verifiedUuid=uuid, lookups=0;
  globalThis.fetch=async(input,options)=>{
    if(String(input).startsWith(app.origin+'/'))return fetchLocal(input,options);
    assert.equal(String(input),'https://api.smartrecruiters.com/v1/companies/'+company+'/postings/'+postingId);
    lookups++;
    return Response.json({id:postingId,uuid:verifiedUuid,company:{identifier:company},active:true});
  };
  try {
    app.queue.configure(profile,Buffer.from('%PDF-default').toString('base64'));
    await assert.rejects(fillApplication({} as Page,{url,profile,resume},AbortSignal.timeout(1000),()=>{}),/Fill current page/);
    const job=app.queue.snapshot().jobs[0]!;
    assert.equal(job.status,'paused');
    assert.equal(job.id,id);
    assert.equal(job.currentPageOnly,true);
    for (const action of ['retry','refresh_review','submit']) {
      const response=await post('/jobs/'+id+'/action',{action});
      assert.equal(response.status,400);
      assert.match((await response.json()).error,/selected resume/);
    }
    for (const operation of ['fill','redo']) {
      const response=await post('/browser/page',{tabId:7,expectedUrl:url,documentId:'a'.repeat(64),operation});
      assert.equal(response.status,400);
      assert.match((await response.json()).error,/selected resume/);
    }
    const restored=app.queue.jobs.find(job=>job.id===smartId)!;
    assert.equal(restored.tabId,undefined);
    for(const expectedUrl of [personal+'?dcr_ci='+company,selectedApplicationUrl]) {
      for(const operation of ['fill','redo']) {
        const response=await post('/browser/page',{tabId:8,expectedUrl,documentId:'b'.repeat(64),operation});
        assert.equal(response.status,400);
        assert.match((await response.json()).error,/selected resume/);
      }
    }
    assert.equal(lookups,0);
    const open=()=>post('/jobs/'+smartId+'/action',{action:'open'});
    assert.deepEqual(await (await open()).json(),{url:selectedApplicationUrl});
    verifiedUuid=randomUUID();
    assert.equal((await open()).status,400);
    for(const unsafe of [personal.replace('https:','http:'),personal.replace(company,'Other'),personal+'?redirect=elsewhere']) {
      restored.selectedApplicationUrl=unsafe;
      assert.equal((await open()).status,400);
    }
    assert.equal(lookups,2);
    restored.selectedApplicationUrl=selectedApplicationUrl;
    for (const newUrl of ['https://jobs.jobvite.com/fixture/job/abc/apply',
      'https://jobs.smartrecruiters.com/Fixture/744000123456789-analyst',
      'https://unknown.example/apply']) {
      const jobs=[{url:newUrl,tabId:8}];
      for (const body of [{jobs},{jobs,documentId:'b'.repeat(64)}]) {
        const response=await post('/jobs',body);
        assert.equal(response.status,400);
        assert.match((await response.json()).error,/Fill current page/);
      }
      const bundle={format:'hunt-c3-handoff',version:1,jobs:[{url:newUrl,title:'Fixture',sourceJobId:122,
        resumeVersion:'v17',resumeName:'Selected.pdf',resumeBase64:resume.toString('base64'),
        resumeSha256:createHash('sha256').update(resume).digest('hex')}]};
      for(const operation of ['preview','import','import-paused']) {
        const response=await post('/handoff/'+operation,bundle);
        assert.equal(response.status,400);
        assert.match((await response.json()).error,/Fill current page/);
      }
    }
    assert.equal(app.queue.jobs.length,2);
    assert.equal(app.queue.jobs[0]!.status,'paused');
    assert.equal(app.queue.jobs[0]!.resumeVersion,'v18');
    assert.equal(readFileSync(inputPath,'utf8'),input);
  } finally {globalThis.fetch=fetchLocal;await app.close();}
});
