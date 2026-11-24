import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProductServer } from '../../src/product/server.ts';
import { inspectHandoffBundle, handoffMaxBytes } from '../../src/product/handoff.ts';
import {ExtensionBridge} from '../../src/product/extension-bridge.ts';
import {effectiveProfileFacts} from '../../src/product/sources.ts';

test('protected inspection reports the previously observed Workday page without issuing a document binding', async () => {
  const {pageAction} = await import(new URL('../../extension/page-actions.js',import.meta.url).href);
  const root = mkdtempSync(join(tmpdir(),'c3-workday-protected-inspection-'));
  const service = await startProductServer({root,port:0});
  const url = 'https://fixture.wd5.myworkdayjobs.com/External/job/City/Developer_R1/apply';
  const bridge = (service.queue as unknown as {bridge:ExtensionBridge}).bridge;
  const calls: string[] = [];
  let kind = 'application', conflict = false, protection = true;
  const oldChrome = Object.getOwnPropertyDescriptor(globalThis,'chrome');
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:{
    tabs:{get:async () => ({url})}, debugger:{attach:async () => {
      calls.push('attach');
      throw new Error(protection ? 'Cannot access a chrome-extension:// URL of different extension' : 'arbitrary browser error');
    }},
  }});
  try {
    bridge.call = async (method, params = {}) => {
      calls.push(method === 'workdayAccount' ? String(params.operation) : method);
      if (method === 'agentStatus') return {capabilities:['workday-account-fill-v1','workday-page-v1']};
      if (method === 'workdayAccount') return params.operation === 'inspect' ? {
        state:'application',documentId:'observed-account-document',observation:{version:'workday-page-v1',
          kind, signals:[kind === 'review' ? 'review_root' : 'application_root'], conflicts:conflict ? ['sign_in_form'] : []},
      } : {};
      assert.equal(method,'pageAction');
      return pageAction(params,new Set());
    };
    for (const mode of ['application','review','conflicting','different error']) {
      kind = mode === 'review' ? 'review' : 'application';
      conflict = mode === 'conflicting';
      protection = mode !== 'different error';
      calls.length = 0;
      const response = await fetch(service.origin+'/browser/page',{method:'POST',headers:{
        Authorization:'Bearer '+readFileSync(service.tokenPath,'utf8').trim(),'Content-Type':'application/json',
      },body:JSON.stringify({operation:'inspect',tabId:1,expectedUrl:url})});
      assert.equal(response.status,400);
      const body = await response.json() as {error:string;partialObservation?:unknown};
      if (conflict || !protection) {
        assert.deepEqual(body,{error:'C3 could not access the selected tab. Inspect the draft before retrying.'});
      } else {
        assert.deepEqual(body.partialObservation,{kind,incomplete:true,reason:'debugger_protected_extension'});
        assert.match(body.error,/Chrome blocked detailed inspection/);
        assert.deepEqual(Object.keys(body).sort(),['error','partialObservation']);
      }
      assert.deepEqual(calls,['agentStatus','begin','inspect','end','pageAction','attach']);
    }
  } finally {
    if (oldChrome) Object.defineProperty(globalThis,'chrome',oldChrome);
    else Reflect.deleteProperty(globalThis,'chrome');
    await service.close();
  }
});

function job(id: number) {
  const pdf = Buffer.from(`%PDF-selected-resume-${id}`);
  return {url:`https://job-boards.greenhouse.io/fixture/jobs/${id}`,title:`Fixture job ${id}`,sourceJobId:id,
    resumeName:`selected-${id}.pdf`,resumeVersion:`version-${id}`,resumeBase64:pdf.toString('base64'),resumeSha256:createHash('sha256').update(pdf).digest('hex')};
}
const bundle = (...jobs: ReturnType<typeof job>[]) => ({format:'hunt-c3-handoff',version:1,jobs});

test('portable handoff previews without writes, authenticates, preserves exact PDFs and reconciles identical manual jobs',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hunt-handoff-'));
  const service=await startProductServer({root,port:47861});
  try {
    const headers={'Content-Type':'application/json',Authorization:`Bearer ${readFileSync(service.tokenPath,'utf8').trim()}`};
    const post=(path:string,body:unknown,extra:Record<string,string>={})=>fetch(`${service.origin}/${path}`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
    assert.equal((await post('handoff/preview',bundle(job(1)),{Authorization:''})).status,401);
    assert.equal((await post('handoff/preview',bundle(job(1)),{Origin:'https://other.example.invalid'})).status,403);
    const before=readdirSync(root);
    const preview=await post('handoff/preview',bundle(job(1),job(2)));
    assert.equal(preview.status,200);
    const details=await preview.json() as {jobs:Record<string,unknown>[]};
    assert.deepEqual(details.jobs.map(j=>j.status),['new','new']);
    assert.equal(details.jobs.some(j=>'resumeBase64' in j),false);
    assert.deepEqual(readdirSync(root),before);
    assert.equal((await post('handoff/import',bundle(job(1)))).status,400,'import still needs a profile');
    const saved=await post('settings',{applicant:{given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'},resumeBase64:job(1).resumeBase64});
    assert.equal(saved.status,200);
    assert.deepEqual(await saved.json(),{...service.queue.getSettings(),effectiveFacts:effectiveProfileFacts(service.queue.getSettings()!.profile)},'save confirmation supplies canonical settings plus derived facts for reversible UI history');
    const manual=service.queue.add([{url:job(1).url}])[0]!;
    const result=await post('handoff/import',bundle(job(1),job(2)));
    assert.equal(result.status,200);
    assert.equal(service.queue.jobs.length,2);
    assert.equal(service.queue.jobs[0]!.id,manual.id);
    for (const current of service.queue.jobs) {
      const expected=job(current.sourceJobId!);
      assert.equal(current.resumeSha256,expected.resumeSha256);
      assert.equal(current.resumeVersion,expected.resumeVersion);
      assert.equal(current.resumeName,expected.resumeName);
      assert.equal(JSON.parse(readFileSync(join(root,`${current.id}.input.json`),'utf8')).resume,expected.resumeBase64);
      assert.equal(current.status,'queued');
    }
    const stable=JSON.stringify(service.queue.snapshot());
    assert.equal((await post('handoff/import',bundle(job(1),job(2)))).status,200);
    assert.equal(JSON.stringify(service.queue.snapshot()),stable);
    const existing=await (await post('handoff/preview',bundle(job(1),job(2)))).json() as {jobs:{status:string}[]};
    assert.deepEqual(existing.jobs.map(j=>j.status),['existing','existing']);
    const files=readdirSync(root);
    const inputPath=join(root,`${manual.id}.input.json`);
    const legacyInput=JSON.parse(readFileSync(inputPath,'utf8'));
    writeFileSync(inputPath,JSON.stringify({...legacyInput,resume:legacyInput.resume+'\n'}));
    assert.equal((await post('handoff/import',bundle(job(1),job(2)))).status,200,'legacy base64 whitespace must not change PDF identity');
    assert.deepEqual(readdirSync(root),files);
    assert.equal((await post('jobs',{jobs:[job(3),{...job(1),sourceJobId:99}]})).status,400);
    assert.deepEqual(readdirSync(root),files,'ordinary queue batches also reject later conflicts before persisting earlier inputs');
    for (const changed of [
      {...job(1),resumeVersion:'another-version'},
      {...job(1),sourceJobId:99},
      {...job(1),resumeBase64:job(4).resumeBase64,resumeSha256:job(4).resumeSha256},
      {...job(1),resumeSha256:'0'.repeat(64)},
    ]) {
      assert.equal((await post('handoff/import',bundle(job(3),changed))).status,400);
      assert.equal(JSON.stringify(service.queue.snapshot()),stable);
      assert.deepEqual(readdirSync(root),files,'a later conflict must not persist the earlier new job');
    }
  } finally { await service.close(); }
});

test('portable handoff rejects unsupported versions, targets, injected authority and malformed or excessive data',()=>{
  for (const invalid of [
    {...bundle(job(1)),version:2}, {...bundle(job(1)),token:'injected'},
    bundle({...job(1),url:'https://unsupported.example/job'}),
    bundle({...job(1),resumeBase64:job(1).resumeBase64+'\n'}),
    bundle({...job(1),sourceJobId:0}), bundle(job(1),job(1)), bundle(),
    {...bundle(job(1)),jobs:[{...job(1),submissionAllowed:true}]},
    {...bundle(job(1)),jobs:Array.from({length:31},(_,i)=>job(i+1))},
    bundle({...job(1),resumeBase64:'A'.repeat(handoffMaxBytes)}),
  ]) assert.throws(()=>inspectHandoffBundle(invalid,[]));
});


test('explicit paused import keeps the exact portable contract and never schedules the bundle',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hunt-handoff-paused-'));const service=await startProductServer({root,port:0});
  try {
    const headers={'Content-Type':'application/json',Authorization:`Bearer ${readFileSync(service.tokenPath,'utf8').trim()}`};
    const post=(path:string,body:unknown)=>fetch(`${service.origin}/${path}`,{method:'POST',headers,body:JSON.stringify(body)});
    const defaultPdf=Buffer.from('%PDF-current-page-default').toString('base64');
    const applicant={given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',city:'Old City'};
    await post('settings',{applicant,resumeBase64:defaultPdf});
    const result=await post('handoff/import-paused',bundle(job(1)));
    assert.equal(result.status,200);const added=await result.json() as {id:string;status:string}[];
    assert.equal(added[0]!.status,'paused');assert.equal(service.queue.jobs[0]!.status,'paused');
    assert.equal(JSON.parse(readFileSync(join(root,`${added[0]!.id}.input.json`),'utf8')).resume,job(1).resumeBase64);
    assert.equal((await post('handoff/import-paused',{...bundle(job(2)),accountPolicy:'create'})).status,400);
    assert.equal(service.queue.jobs.length,1);
    assert.equal((await post('settings',{applicant:{...applicant,city:'Updated City'}})).status,200);
    const bridge=(service.queue as unknown as {bridge:ExtensionBridge}).bridge;
    const uploads:string[]=[],cities:unknown[]=[];
    bridge.call=async(method,args={})=>{
      if(method==='agentStatus') return {capabilities:['pageAction-v2','question-matching-v1','consent-redo-v1','selected-page-handoff-v1']};
      if(method==='pageTabs') return [{tabId:1,url:job(1).url}];
      assert.equal(method,'pageAction');
      if(args.operation==='fill') {
        uploads.push((args.resume as {base64:string}).base64);
        cities.push((args.facts as {factId:string;value:unknown}[]).find(fact=>fact.factId==='city')?.value);
      }
      return {tabId:args.tabId,url:args.expectedUrl,documentId:'fixture',matching:[],filled:[],skipped:[],canUndo:false,canRedo:false};
    };
    for(const operation of ['fill','redo']) {
      const current=await post('browser/page',{operation,tabId:1,expectedUrl:job(1).url,documentId:'fixture'});
      assert.equal(current.status,200);
    }
    assert.deepEqual(uploads,[defaultPdf]);
    const page={tabId:1,expectedUrl:job(1).url};
    const metadata=await (await post('browser/page-resume',page)).json();
    assert.equal(metadata.currentPage.source,'default');
    assert.equal(metadata.queued.jobId,added[0]!.id);
    const chosen={...page,currentPageJobId:metadata.queued.jobId};
    const pdf=await post('browser/page-resume',{...chosen,workflow:'currentPage',sha256:job(1).resumeSha256});
    assert.equal(pdf.status,200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).toString('base64'),job(1).resumeBase64);
    assert.equal((await post('browser/page',{...chosen,operation:'inspect',expectedUrl:job(2).url})).status,400);
    assert.equal((await post('browser/page',{...chosen,operation:'inspect'})).status,200);
    assert.equal((await post('browser/page',{...chosen,operation:'fill',documentId:'fixture',expectedResumeSha256:job(1).resumeSha256})).status,200);
    assert.equal((await post('browser/page',{...page,operation:'inspect'})).status,200);
    assert.equal((await post('browser/page',{...page,operation:'fill',documentId:'fixture'})).status,200);
    assert.deepEqual(uploads,[defaultPdf,job(1).resumeBase64,defaultPdf]);
    assert.deepEqual(cities,['Updated City','Updated City','Updated City']);
    assert.equal(service.queue.jobs[0]!.status,'paused');
    const inputPath=join(root,`${added[0]!.id}.input.json`);
    const input=readFileSync(inputPath,'utf8');
    assert.equal(JSON.parse(input).resume,job(1).resumeBase64);
    assert.equal(effectiveProfileFacts(JSON.parse(input).profile).find(fact=>fact.factId==='city')?.value,'Old City');
    for (const damaged of ['invalid JSON',JSON.stringify({...JSON.parse(input),resume:defaultPdf})]) {
      writeFileSync(inputPath,damaged);
      const selection=await (await post('browser/page-resume',page)).json();
      assert.equal(selection.currentPage?.sha256,metadata.currentPage.sha256);
      assert.equal(selection.queued,null);
      assert.match(selection.queuedError,/Applications/);
      const currentPdf=await post('browser/page-resume',{...page,workflow:'currentPage',sha256:metadata.currentPage.sha256});
      assert.equal(currentPdf.status,200);
      assert.equal(Buffer.from(await currentPdf.arrayBuffer()).toString('base64'),defaultPdf);
      assert.equal((await post('browser/page-resume',{...page,workflow:'queued',sha256:job(1).resumeSha256})).status,400);
      assert.equal((await post('browser/page-resume',{...chosen,workflow:'currentPage',sha256:job(1).resumeSha256})).status,400);
      assert.equal((await post('jobs',{jobs:[{url:job(1).url,expectedResumeSha256:job(1).resumeSha256}]})).status,400);
      assert.equal((await post('browser/page',{...page,operation:'fill',documentId:'fixture',expectedResumeSha256:metadata.currentPage.sha256})).status,200);
      assert.equal(uploads.at(-1),defaultPdf);
    }
    writeFileSync(inputPath,input);
    const workday='https://fixture.wd5.myworkdayjobs.com/External/job/Developer_R1';
    service.queue.add([{url:workday,tabId:2}],{paused:true});
    service.queue.credentials={email:'fixture@example.invalid',password:'fixture-only'};
    const accountOperations:unknown[]=[];
    bridge.call=async(method,args={})=>{
      if (method==='agentStatus') return {capabilities:['workday-account-fill-v1','workday-page-v1']};
      assert.equal(method,'workdayAccount');
      assert.equal(args.tabId,2);
      accountOperations.push(args.operation);
      if (args.operation==='inspect') return {state:'sign_in',documentId:'account-document'};
      if (args.operation==='fill_page') return {state:'account_filled',filled:['Email','Password']};
      return {};
    };
    const account=await post('browser/page',{operation:'fill',tabId:2,expectedUrl:workday,documentId:'account-document'});
    assert.equal(account.status,200);
    assert.equal((await account.json() as {accountPage:boolean}).accountPage,true);
    assert.deepEqual(accountOperations,['begin','inspect','fill_page','end']);
    assert.equal(service.queue.jobs.find(job=>job.url===workday)?.status,'paused');

    const expired=await post('browser/page',{operation:'fill',tabId:1,expectedUrl:job(2).url,documentId:'fixture',expiresAt:Date.now()-1});
    assert.equal(expired.status,400);assert.match((await expired.json() as {error:string}).error,/expired/);
    const synthetic=structuredClone(service.queue.getSettings()!.profile) as any;
    synthetic.profilePlan.mode='synthetic_test_non_submittable';
    synthetic.executionPolicy.answerFallbackPolicy='deterministic_site_valid_editable';
    assert.equal((await post('settings',{profile:synthetic,resumeBase64:job(1).resumeBase64})).status,200);
    for(const operation of ['fill','redo']) {
      const denied=await post('browser/page',{operation,tabId:1,expectedUrl:job(2).url,documentId:'inspected-fixture'});
      assert.equal(denied.status,400);assert.match((await denied.json() as {error:string}).error,/saved personal profile/);
    }
    assert.equal((service.queue.getSettings()!.profile as any).profilePlan.mode,'synthetic_test_non_submittable','refusal must preserve saved settings');
  }finally{await service.close();}
});

test('manual fill and redo require the new paired extension capability and retain the caller deadline',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hunt-page-capability-'));const service=await startProductServer({root,port:0});
  const original=ExtensionBridge.prototype.call;let modern=false,redoCapable=false,effects=0,slow=false,revoke=false;
  ExtensionBridge.prototype.call=async function(method,params){
    if(method==='agentStatus') {if(slow)await new Promise(resolve=>setTimeout(resolve,40));return {capabilities:modern?['pageAction-v2','question-matching-v1',...(redoCapable?['consent-redo-v1']:[])]:['pageAction-v1']};}
    if(method==='pageAction' && params?.operation==='inspect' && revoke) {
      revoke=false;
      service.queue.configureApplicant({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',ai_evaluation_consent:'false'});
      return {documentId:params.documentId,status:'partial',filled:[],skipped:[],matching:[{
        fieldId:'screening',frameId:'frame',signature:'fixture',question:'AI evaluation consent',control:'radio',options:['Yes','No'],required:true,valid:false,selected:'',
      }],canUndo:false,canRedo:false};
    }
    if(method==='pageAction'){if(params?.operation==='fill') effects++;return {documentId:params?.documentId,status:'partial',filled:[],skipped:[],matching:[],canUndo:false,canRedo:false};}
    throw new Error('Unexpected bridge action');
  };
  try {
    const headers={'Content-Type':'application/json',Authorization:`Bearer ${readFileSync(service.tokenPath,'utf8').trim()}`};
    const post=(path:string,body:unknown)=>fetch(`${service.origin}/${path}`,{method:'POST',headers,body:JSON.stringify(body)});
    await post('settings',{applicant:{given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'},resumeBase64:job(1).resumeBase64});
    for(const operation of ['fill','redo']) {
      const denied=await post('browser/page',{operation,tabId:1,expectedUrl:job(1).url,documentId:'fixture'});
      assert.equal(denied.status,400);assert.match((await denied.json() as {error:string}).error,/Reload Hunt C3 0.1.9/);
    }
    assert.equal(effects,0);modern=true;
    assert.equal((await post('browser/page',{operation:'fill',tabId:1,expectedUrl:job(1).url,documentId:'fixture'})).status,200);
    const oldRedo=await post('browser/page',{operation:'redo',tabId:1,expectedUrl:job(1).url,documentId:'fixture'});
    assert.match((await oldRedo.json()).error,/current consent/);
    redoCapable=true;
    service.queue.configureApplicant({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',ai_evaluation_consent:'true'});
    revoke=true;
    const revoked=await post('browser/page',{operation:'fill',tabId:1,expectedUrl:job(1).url,documentId:'fixture'});
    assert.equal(revoked.status,400);assert.match((await revoked.json()).error,/consent changed/);
    assert.equal(effects,1);slow=true;
    const expired=await post('browser/page',{operation:'fill',tabId:1,expectedUrl:job(1).url,documentId:'fixture',expiresAt:Date.now()+20});
    assert.equal(expired.status,400);assert.match((await expired.json() as {error:string}).error,/expired/);assert.equal(effects,1);
  }finally{ExtensionBridge.prototype.call=original;await service.close();}
});
