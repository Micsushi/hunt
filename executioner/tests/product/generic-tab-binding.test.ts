import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwright';
import type {ExtensionBridge} from '../../src/product/extension-bridge.ts';
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
    {...productApplicationTarget(postingUrl),id:smartId,url:postingUrl,status:'paused',tabId:4,selectedDocument:'original-loader',selectedApplicationUrl},
    {...productApplicationTarget('https://held.bamboohr.com/careers/123'),id:randomUUID(),url:'unreadable',status:'paused',pageHandoff:true,sourceJobId:456,resumeVersion:'v18'}
  ]}));
  const app=await startProductServer({root,port:0});
  const post=(path:string,body:unknown)=>fetch(app.origin+path,{method:'POST',headers:{
    Authorization:'Bearer '+readFileSync(app.tokenPath,'utf8'),'Content-Type':'application/json'
  },body:JSON.stringify(body)});
  const fetchLocal=globalThis.fetch;
  let verifiedUuid=uuid, lookups=0;
  globalThis.fetch=async(input,options)=>{
    if(String(input).startsWith(app.origin+'/'))return fetchLocal(input,options);
    assert.ok([postingId,uuid].some(key=>String(input)==='https://api.smartrecruiters.com/v1/companies/'+company+'/postings/'+key));
    lookups++;
    return Response.json({id:postingId,uuid:verifiedUuid,postingUrl,company:{identifier:company},active:true});
  };
  try {
    app.queue.configure(profile,Buffer.from('%PDF-default').toString('base64'));
    await assert.rejects(fillApplication({} as Page,{url,profile,resume},AbortSignal.timeout(1000),()=>{}),/Fill current page/);
    const job=app.queue.snapshot().jobs[0]!;
    assert.equal(job.status,'paused');
    assert.equal(job.id,id);
    assert.equal(job.currentPageOnly,true);
    for (const action of ['retry','refresh_review','submit','refresh_profile']) {
      const response=await post('/jobs/'+id+'/action',{action});
      assert.equal(response.status,400);
      assert.match((await response.json()).error,/selected resume/);
    }
    const bridge=(app.queue as unknown as {bridge:ExtensionBridge}).bridge;
    const genericPdf=Buffer.from('%PDF-default').toString('base64');
    let legacyFills=0;
    bridge.call=async(method,params={})=>{
      if(method==='agentStatus')return {capabilities:['pageAction-v2','question-matching-v1','consent-redo-v1']};
      assert.equal(method,'pageAction');
      assert.equal(params.pageHandoff,undefined);
      if(params.operation==='fill'){
        assert.equal((params.resume as {base64:string}).base64,genericPdf);
        legacyFills++;
      }
      return {tabId:params.tabId,url:params.expectedUrl,documentId:params.documentId,filled:[],matching:[],skipped:[]};
    };
    for (const operation of ['fill','redo']) {
      const response=await post('/browser/page',{tabId:7,expectedUrl:url,documentId:'a'.repeat(64),operation});
      assert.equal(response.status,200,await response.text());
    }
    const restored=app.queue.jobs.find(job=>job.id===smartId)!;
    assert.equal(restored.tabId,undefined);
    for(const expectedUrl of [personal+'?dcr_ci='+company,selectedApplicationUrl]) {
      for(const operation of ['fill','redo']) {
        const response=await post('/browser/page',{tabId:8,expectedUrl,documentId:'b'.repeat(64),operation});
        assert.equal(response.status,200,await response.text());
      }
    }
    assert.equal(lookups,0);
    // Older imports can retain only the numeric posting and the tailored PDF.
    delete restored.selectedApplicationUrl;
    for(const operation of ['fill','redo']) {
      const response=await post('/browser/page',{tabId:8,expectedUrl:selectedApplicationUrl,documentId:'b'.repeat(64),operation});
      assert.equal(response.status,200,await response.text());
    }
    assert.equal(lookups,0);
    assert.equal(legacyFills,4);
    for (const address of ['https://fixture.bamboohr.com:8443/profile','http://localhost:8024/profile']) {
      assert.equal((await post('/browser/page',{operation:'fill',tabId:17,expectedUrl:address,documentId:'local-document'})).status,200);
      assert.equal((await post('/jobs',{jobs:[{url:address}]})).status,400);
    }
    for (const address of [app.origin,'http://localhost:47831/','http://forms.example/profile','chrome://settings/','https://fixture@forms.example.invalid/profile']) {
      assert.equal((await post('/browser/page',{operation:'fill',tabId:17,expectedUrl:address,documentId:'local-document'})).status,400);
    }
    assert.equal(legacyFills,6);
    restored.selectedApplicationUrl=selectedApplicationUrl;
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
    const bundleFor = (target:string,sourceJobId:number) => ({format:'hunt-c3-handoff',version:1,jobs:[{
      url:target,title:'Fixture',sourceJobId,resumeVersion:'v17',resumeName:'Selected.pdf',resumeBase64:resume.toString('base64'),
      resumeSha256:createHash('sha256').update(resume).digest('hex')}]});
    const selectedUrl='https://jobs.jobvite.com/fixture/job/abc/apply';
    for (const newUrl of [selectedUrl, postingUrl, 'https://unknown.example/apply']) {
      const jobs=[{url:newUrl,tabId:8}];
      for (const body of [{jobs},{jobs,documentId:'b'.repeat(64)}]) {
        const response=await post('/jobs',body);
        assert.equal(response.status,400);
        assert.match((await response.json()).error,/Fill current page/);
      }
      const bundle=bundleFor(newUrl,122);
      assert.equal((await post('/handoff/import',bundle)).status,400);
      if (newUrl!==selectedUrl) {
        for(const operation of ['preview','import-paused']) assert.equal((await post('/handoff/'+operation,bundle)).status,400);
      }
    }
    const bundle=bundleFor(selectedUrl,122);
    assert.equal((await (await post('/handoff/preview',bundle)).json()).jobs[0].currentPageOnly,true);
    const [selected]=await (await post('/handoff/import-paused',bundle)).json();
    assert.equal(selected.status,'paused');
    assert.equal(selected.pageHandoff,true);
    assert.equal(selected.submissionAllowed,false);
    assert.equal((await (await post('/handoff/import-paused',bundle)).json())[0].id,selected.id);
    const documentId='c'.repeat(64),observedPdfs:string[]=[],defaultPdfs:string[]=[];
    let latestDocument=documentId,filesInHistory=false;
    bridge.call=async(method,params={})=>{
      if(method==='agentStatus')return {capabilities:['pageAction-v2','question-matching-v1','selected-page-handoff-v1','consent-redo-v1']};
      if(method==='pageTabs')return [{tabId:9,url:selectedUrl}];
      assert.equal(method,'pageAction');
      if(params.pageHandoff) assert.equal(params.pageHandoff,selected.id);
      if(params.operation==='fill') {
        const resume=params.resume as {base64:string};
        const facts=params.facts as {factId:string;value:unknown}[];
        (params.pageHandoff ? observedPdfs : defaultPdfs).push(resume.base64);
        assert.equal(facts.find(fact=>fact.factId==='given_name')?.value,params.pageHandoff ? 'Fixture' : 'Changed');
        filesInHistory=true;
      }
      if(params.operation==='undo')filesInHistory=false;
      return {url:params.expectedUrl,tabId:params.tabId,documentId:latestDocument,filled:[],matching:[],skipped:[],canUndo:filesInHistory,canRedo:!filesInHistory};
    };
    const operate=(operation:string,tabId=9,url=selectedUrl,doc=latestDocument)=>post('/browser/page',{tabId,expectedUrl:url,operation,...(operation!=='inspect'&&{documentId:doc})});
    app.queue.configure(applicantProfile({given_name:'Changed',family_name:'Tester',email_address:'changed@example.invalid'}),Buffer.from('%PDF-default').toString('base64'));
    const selection={tabId:9,expectedUrl:selectedUrl};
    const metadata=await (await post('/browser/page-resume',selection)).json();
    const hash=createHash('sha256').update(resume).digest('hex');
    const currentPage={name:'Selected.pdf',source:'selected',version:'v17',sha256:hash};
    const defaultHash=createHash('sha256').update('%PDF-default').digest('hex');
    assert.deepEqual(metadata,{supportsQueue:false,currentPage,queued:null,resumes:[
      {id:'default',name:'Default resume · '+defaultHash.slice(0,8),source:'default',sha256:defaultHash},
      {...currentPage,id:hash,jobId:selected.id},
    ]});
    const preview=await post('/browser/page-resume',{...selection,workflow:'currentPage',sha256:hash});
    assert.equal(preview.headers.get('content-type'),'application/pdf');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()),resume);
    assert.equal((await post('/browser/page-resume',{...selection,workflow:'currentPage',sha256:'0'.repeat(64)})).status,400);
    assert.equal((await post('/browser/page-resume',{...selection,tabId:18})).status,400);
    assert.equal((await post('/browser/page-resume',{...selection,expectedUrl:app.origin})).status,400);
    assert.equal((await fetchLocal(app.origin+'/browser/page-resume',{method:'POST',body:JSON.stringify(selection)})).status,401);
    const later='https://jobs.jobvite.com/fixture/application/screening';
    for (const ordinary of ['https://other.example.invalid/application','https://jobs.jobvite.com/another/job/other/apply',
        'https://jobs.jobvite.com/fixture/job/other/apply/screening']) {
      assert.equal((await operate('inspect',35,ordinary)).status,200);
      assert.equal((await operate('fill',35,ordinary)).status,200);
    }
    assert.equal((await operate('inspect',36,later)).status,200);
    for (const op of ['fill','redo']) {
      const response=await operate(op,36,later);
      assert.equal(response.status,400,'possible selected draft received default PDF: '+defaultPdfs.length);
      assert.match((await response.json()).error,/Applications/);
    }
    const heldLater='https://held.bamboohr.com/application/step-2';
    assert.equal((await operate('inspect',37,heldLater)).status,200);
    const heldFill=await operate('fill',37,heldLater);
    assert.equal(heldFill.status,400,'a quarantined handoff can never be allowed to receive default bytes');
    assert.match((await heldFill.json()).error,/repair/i);
    assert.deepEqual(defaultPdfs,Array(3).fill(Buffer.from('%PDF-default').toString('base64')));
    assert.equal((await operate('fill')).status,400,'a prior default or another tab cannot fill before inspecting its saved handoff');
    assert.equal((await operate('inspect')).status,200);
    assert.equal((await operate('inspect',12,selectedUrl.replace('/fixture/','/Fixture/'))).status,400,'uncertain posting aliases cannot acquire the default PDF');
    assert.equal((await operate('inspect',10)).status,400,'the same posting is already bound to another tab');
    for(const op of ['fill','undo','redo'])assert.equal((await operate(op)).status,200,op);
    assert.deepEqual(observedPdfs,[resume.toString('base64')]);
    assert.equal((await operate('redo',9,selectedUrl.replace('abc','def'))).status,400,'navigated tab must be inspected again');
    assert.equal((await operate('inspect',9,'https://other.example.invalid/application')).status,400,'an unknown home for the same tab cannot silently switch to the default resume');
    assert.equal((await operate('inspect',9,'https://fixture.wd5.myworkdayjobs.com/External/job/Developer_R1')).status,400,
      'a different employer cannot inherit account access from an imported tab');
    latestDocument='d'.repeat(64);
    assert.equal((await operate('fill')).status,400,'new document cannot reuse the old binding');
    assert.equal((await operate('inspect')).status,200);
    const selectedInput=join(root,selected.id+'.input.json');
    const original=JSON.parse(readFileSync(selectedInput,'utf8'));
    writeFileSync(selectedInput,JSON.stringify({...original,resume:Buffer.from('%PDF-substituted').toString('base64')}));
    assert.equal((await operate('fill')).status,400);
    assert.deepEqual(observedPdfs,[resume.toString('base64')]);
    assert.equal(app.queue.jobs.length,3);
    const amazon='https://amazon.jobs/en/jobs/7654/fixture';
    const alternate=amazon.replace('amazon.jobs','www.amazon.jobs');
    const [imported]=await (await post('/handoff/import-paused',bundleFor(alternate,130))).json();
    const stored=app.queue.jobs.find(job=>job.id===imported.id)!;
    // Exercise deduplication when a saved job still has its original host-prefixed key.
    stored.key='www.amazon.jobs/jobs/7654';
    assert.equal((await (await post('/handoff/import-paused',bundleFor(amazon,130))).json())[0].id,imported.id);
    assert.equal((await operate('fill',11,amazon)).status,400);
    let selectedBytes:string|undefined;
    bridge.call=async(method,params={})=>{
      if(method==='agentStatus')return {capabilities:['pageAction-v2','question-matching-v1','selected-page-handoff-v1','consent-redo-v1']};
      assert.equal(params.pageHandoff,imported.id);
      if(params.operation==='fill')selectedBytes=(params.resume as {base64:string}).base64;
      return {url:params.expectedUrl,tabId:params.tabId,documentId:latestDocument,filled:[],matching:[],skipped:[],canUndo:false,canRedo:false};
    };
    assert.equal((await operate('inspect',11,amazon)).status,200);
    assert.equal((await operate('fill',11,amazon)).status,200);
    assert.equal(selectedBytes,resume.toString('base64'));
    await app.queue.action(selected.id,'remove');
    const [variant] = await (await post('/handoff/import-paused',bundleFor(selectedUrl.replace('/fixture/','/Fixture/'),131))).json();
    assert.ok(variant.pageHandoff);
    await assert.rejects(app.queue.action(selected.id,'restore'),/already been added/);
    await app.queue.action(variant.id,'remove');
    const [movedSource]=await (await post('/handoff/import-paused',bundleFor(selectedUrl.replace('abc','different'),122))).json();
    assert.ok(movedSource.pageHandoff);
    const collision=await post('/handoff/import-paused',bundleFor(selectedUrl,122));
    assert.equal(collision.status,400);
    assert.match((await collision.json()).error,/different application link/);
    const batchConflict={...bundle,jobs:[bundleFor(selectedUrl,132).jobs[0],bundleFor(selectedUrl.replace('abc','new'),132).jobs[0]]};
    const count=app.queue.jobs.length;
    assert.equal((await post('/handoff/import-paused',batchConflict)).status,400);
    assert.equal(app.queue.jobs.length,count);
    await assert.rejects(app.queue.action(selected.id,'restore'),/already been added/);

    assert.equal(app.queue.jobs[0]!.status,'paused');
    assert.equal(app.queue.jobs[0]!.resumeVersion,'v18');
    assert.equal(readFileSync(inputPath,'utf8'),input);
    // A deliberate re-import can adopt the *same* saved PDF. The default fill above did not.
    assert.equal(app.queue.jobs[0]!.pageHandoff,undefined);
    const explicit=bundleFor(url,123);
    explicit.jobs[0]!.resumeVersion='v18';
    const [adopted]=await (await post('/handoff/import-paused',explicit)).json();
    assert.equal(adopted.id,id);
    assert.equal(adopted.pageHandoff,true);
    assert.equal(adopted.resumeSha256,explicit.jobs[0]!.resumeSha256);
    assert.equal(readFileSync(inputPath,'utf8'),input);
  } finally {globalThis.fetch=fetchLocal;await app.close();}
});
