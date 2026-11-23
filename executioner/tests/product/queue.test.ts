import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationQueue, type BrowserConnection } from "../../src/product/queue.ts";
import { startProductServer } from "../../src/product/server.ts";
import { applicantProfile, productSources } from "../../src/product/sources.ts";
import { parseApplicationProfile } from "../../src/profile/application-profile.ts";
import type { ProductInput } from "../../src/product/application-contract.ts";
import { disposeResumeArtifact } from '../../src/contracts/index.ts';

test("queue snapshots inputs, supports remove/restore, and never retries uncertain submissions after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-queue-"));
  const bridge: BrowserConnection = { connected: false, open: async () => { throw new Error("should not open"); }, release: async () => {} };
  const queue = new ApplicationQueue(root, bridge);
  const profile = applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" });
  queue.configure(profile, Buffer.from("%PDF-1.4 original").toString("base64"));
  const [first, second] = queue.add([1, 2].map(i => ({ url: `https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Test_R${i}` })));
  queue.configure(profile, Buffer.from("%PDF-1.4 new default").toString("base64"));
  assert.equal(Buffer.from(JSON.parse(readFileSync(join(root, `${first!.id}.input.json`), "utf8")).resume, "base64").toString(), "%PDF-1.4 original");
  await queue.action(first!.id, "remove");
  assert.equal(queue.snapshot().jobs.length, 1);
  await queue.action(first!.id, "restore");
  assert.equal(first!.status, "paused");
  second!.status = "submitting";
  queue.setConcurrency(10);
  await queue.close();
  const restored = new ApplicationQueue(root, bridge);
  assert.equal(restored.jobs[1]!.status, "submission_uncertain");
  await assert.rejects(restored.action(second!.id, "retry"));
  await restored.close();

  const stateFile=join(root,'jobs.json');
  const saved=JSON.parse(readFileSync(stateFile,'utf8'));
  const invalid={...saved.jobs[0],url:'javascript:private-legacy-evidence',title:'Job at javascript:private-legacy-evidence',
    sourceJobId:72,status:'submitting',tabId:23,selectedDocument:'stale-doc',selectedApplicationUrl:first!.url,
    reviewDigest:'stale',reviewUrl:first!.url,submissionAllowed:true,resumeExpected:true,resumeUpload:{kind:'picker'},
    workdayResumeEvidence:{upload:'filename'},error:'stale employer text'};
  saved.jobs[0]=invalid;
  writeFileSync(stateFile,JSON.stringify(saved));
  const inputFile=join(root,invalid.id+'.input.json');
  const originalInput=readFileSync(inputFile);
  for (let restart=0; restart<2; restart++) {
    const service=await startProductServer({root,port:0});
    try {
      const headers={Authorization:'Bearer '+readFileSync(service.tokenPath,'utf8').trim(),'Content-Type':'application/json'};
      const post=(path:string,body:unknown)=>fetch(service.origin+path,{method:'POST',headers,body:JSON.stringify(body)});
      const response=await fetch(service.origin+'/state',{headers});
      assert.equal(response.status,200);
      const state=await response.json();
      assert.equal(state.unavailableJobCount,1);
      assert.equal(service.queue.snapshot().unavailableJobCount,1);
      assert.ok(state.jobs.some((job:{id:string})=>job.id===second!.id));
      assert.ok(!JSON.stringify(state).includes('private-legacy-evidence'));
      assert.ok(!service.queue.jobs.some(job=>job.id===invalid.id));
      for(const action of ['open','retry','submit']) {
        assert.equal((await post('/jobs/'+invalid.id+'/action',{action,confirmed:true})).status,400);
      }
      const heldPage=await post('/browser/page',{operation:'inspect',tabId:24,expectedUrl:first!.url});
      assert.equal(heldPage.status,400);
      assert.match((await heldPage.json()).error,/unreadable link/);
      assert.equal((await post('/jobs',{jobs:[{url:first!.url}]})).status,400);
      if (!restart) assert.equal((await post('/jobs',{jobs:[{url:'https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Test_R3'}]})).status,200);
      else assert.ok(state.jobs.some((job:{url:string})=>job.url.endsWith('Test_R3')));
      assert.equal((await post('/concurrency',{value:3})).status,200);
    } finally { await service.close(); }
    assert.deepEqual(JSON.parse(readFileSync(stateFile,'utf8')).jobs.find((job:{id:string})=>job.id===invalid.id),invalid);
    assert.deepEqual(readFileSync(inputFile),originalInput);
  }
  const service=await startProductServer({root,port:0});
  try {
    const headers={Authorization:'Bearer '+readFileSync(service.tokenPath,'utf8').trim(),'Content-Type':'application/json',Origin:service.origin};
    const repair=(body:unknown, origin=service.origin)=>fetch(service.origin+'/repair-saved-link',{
      method:'POST',headers:{...headers,Origin:origin},body:JSON.stringify(body)});
    for (const request of [{url:invalid.url},{url:second!.url},{url:first!.url.toLowerCase()},
      {url:'https://example.invalid/jobs/1'},{url:first!.url,sourceJobId:72}]) {
      const response=await repair(request); assert.equal(response.status,400);
      assert.ok(!(await response.text()).includes('private-legacy-evidence'));
    }
    assert.equal((await repair({url:first!.url},'chrome-extension://'+'a'.repeat(32))).status,400);
    const peer=service.queue.jobs.find(job=>job.id===second!.id)!;
    for (const conflict of [{sourceJobId:72},{selectedDocument:'stale-doc'},{selectedApplicationUrl:first!.url}]) {
      Object.assign(peer,conflict); assert.equal((await repair({url:first!.url})).status,400);
      for(const field of Object.keys(conflict)) delete peer[field as keyof typeof peer];
    }
    const originalQueueBeforeDamage=readFileSync(stateFile);
    writeFileSync(inputFile,JSON.stringify({...JSON.parse(originalInput.toString()),resume:Buffer.from('%PDF-other').toString('base64')}));
    try {
      const missing=await repair({url:first!.url});
      assert.equal(missing.status,400); assert.match((await missing.json()).error,/original saved profile or resume/);
      assert.deepEqual(readFileSync(stateFile),originalQueueBeforeDamage);
    } finally {writeFileSync(inputFile,originalInput);}
    // A failed disk write must not publish a repaired row in memory.
    const originalQueue=readFileSync(stateFile);
    unlinkSync(stateFile); mkdirSync(stateFile);
    assert.equal((await repair({url:first!.url})).status,400);
    assert.equal(service.queue.snapshot().unavailableJobCount,1);
    rmdirSync(stateFile);writeFileSync(stateFile,originalQueue);service.queue.recoverStorage();
    peer.tabId=23; // Chrome reused the quarantined row's pre-restart tab number for a different posting.
    const originalNeighbor=JSON.stringify(peer);
    assert.equal((await repair({url:first!.url})).status,200);
    const result=service.queue.snapshot();
    assert.equal(result.unavailableJobCount,0);
    const repaired=result.jobs.find(job=>job.id===invalid.id)!;
    assert.equal(repaired.status,'submission_uncertain');
    assert.equal(repaired.sourceJobId,72); assert.equal(repaired.resumeSha256,invalid.resumeSha256); assert.equal(repaired.resumeExpected,true);
    for (const field of ['tabId','selectedDocument','selectedApplicationUrl','reviewDigest','reviewUrl','resumeUpload','workdayResumeEvidence','error']) {
      assert.ok(!Object.hasOwn(repaired,field));
    }
    assert.ok(!JSON.stringify(result).includes('private-legacy-evidence'));
    assert.deepEqual(readFileSync(inputFile),originalInput);
    const repairedQueue=readFileSync(stateFile);
    assert.equal((await repair({url:first!.url})).status,400);
    assert.deepEqual(readFileSync(stateFile),repairedQueue);
    assert.equal(JSON.stringify(peer),originalNeighbor);
    await assert.rejects(service.queue.action(invalid.id,'retry'));
  } finally {await service.close();}

  for (const oldStatus of ['queued','running','review','paused','submission_uncertain','submitted']) {
    saved.jobs[0]={...invalid,status:oldStatus};
    writeFileSync(stateFile,JSON.stringify(saved));
    const recovered=new ApplicationQueue(root,bridge);
    try {
      await recovered.repairSavedLink(first!.url,new Map());
      assert.equal(recovered.jobs.find(job=>job.id===invalid.id)?.status,
        ['submission_uncertain','submitted'].includes(oldStatus)?oldStatus:'paused');
      await assert.rejects(recovered.action(invalid.id,'submit','stale',true));
    } finally {await recovered.close();}
  }
  // A merely similar active key prevents repair, even when the other row is also unreadable.
  saved.jobs[0]=invalid;
  const other=saved.jobs[1];
  saved.jobs[1]={...other,url:'broken',key:invalid.key.toLowerCase()};
  writeFileSync(stateFile,JSON.stringify(saved));
  const ambiguous=new ApplicationQueue(root,bridge);
  try {
    await assert.rejects(async()=>ambiguous.repairSavedLink(first!.url,new Map()),/could not match/);
    assert.equal(ambiguous.snapshot().unavailableJobCount,2);
  } finally {await ambiguous.close();}
  saved.jobs[1]=other;
  saved.jobs[0]={...invalid,url:first!.url,key:'tampered'};
  writeFileSync(stateFile,JSON.stringify(saved));
  assert.throws(()=>new ApplicationQueue(root,bridge),/Saved C3 queue is invalid/);
  saved.jobs[0]={...invalid,id:second!.id};
  writeFileSync(stateFile,JSON.stringify(saved));
  assert.throws(()=>new ApplicationQueue(root,bridge),/Saved C3 queue is invalid/);
  saved.jobs[0]={...saved.jobs[1],id:invalid.id};
  writeFileSync(stateFile,JSON.stringify(saved));
  assert.throws(()=>new ApplicationQueue(root,bridge),/Saved C3 queue is invalid/);
});

test("restoring a replaced job and silently changing its selected resume are rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-duplicate-"));
  const bridge = { connected: false, open: async () => { throw new Error(); }, release: async () => {} };
  let queue = new ApplicationQueue(root, bridge);
  try {
    queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" }), Buffer.from("%PDF-original").toString("base64"));
    const input = { url: "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1" };
    const [first] = queue.add([input]);
    assert.throws(() => queue.add([{ ...input, resumeBase64: Buffer.from("%PDF-replacement").toString("base64") }]), /different resume/);
    await queue.action(first!.id, "remove");
    const [neighbor] = queue.add([input]);
    await assert.rejects(queue.action(first!.id, "restore"), /already been added/);

    const url = 'https://www.amazon.jobs/en/jobs/7654/fixture';
    const selected = {url, sourceJobId:130, resumeBase64:Buffer.from('%PDF-selected').toString('base64'), resumeVersion:'v17'};
    const options = {paused:true, currentPageHandoff:true};
    const [amazon] = queue.add([selected], options);
    const inputFile = join(root, amazon!.id+'.input.json');
    const originalInput = readFileSync(inputFile);
    const oldKey = 'www.amazon.jobs/jobs/7654'; // Written by the released www-host parser.
    const canonicalUrl = url.replace('www.amazon.jobs','amazon.jobs');
    await queue.close();
    const legacyFile=join(root,'jobs.json');
    const legacy=JSON.parse(readFileSync(legacyFile,'utf8'));
    Object.assign(legacy.jobs.find((job:{id:string})=>job.id===amazon!.id), {url:'broken',key:oldKey});
    writeFileSync(legacyFile,JSON.stringify(legacy));
    queue = new ApplicationQueue(root,bridge);
    await queue.repairSavedLink(canonicalUrl,new Map());
    assert.equal(queue.jobs.find(job=>job.id===amazon!.id)?.url,canonicalUrl);
    assert.deepEqual(readFileSync(inputFile),originalInput);
    for (const status of ['paused','removed'] as const) {
      if (status==='removed') await queue.action(amazon!.id,'remove');
      queue.jobs.find(job=>job.id===amazon!.id)!.key = oldKey;
      await queue.close();
      queue = new ApplicationQueue(root, bridge);
      const visible = queue.snapshot().jobs;
      assert.ok(visible.some(job=>job.id===neighbor!.id));
      assert.equal(visible.some(job=>job.id===amazon!.id),status==='paused');
      assert.equal(queue.jobs.find(job=>job.id===amazon!.id)!.key,'amazon.jobs/jobs/7654');
      if (status==='paused') {
        assert.equal(queue.add([{...selected,url:canonicalUrl}],options)[0]!.id,amazon!.id);
        assert.throws(()=>queue.add([{...selected,url:canonicalUrl,sourceJobId:131}],options),/another Hunt job/);
        assert.throws(()=>queue.add([{...selected,url:url+'/unrelated'}],options),/recognized public application form/);
      } else {
        const [replacement] = queue.add([{...selected,url:canonicalUrl}],options);
        assert.notEqual(replacement!.id,amazon!.id);
        await assert.rejects(queue.action(amazon!.id,'restore'),/already been added/);
      }
      assert.deepEqual(readFileSync(inputFile),originalInput);
    }
    await queue.close();
    const stateFile = join(root,'jobs.json');
    const saved = JSON.parse(readFileSync(stateFile,'utf8'));
    const archived = saved.jobs.find((job:{id:string})=>job.id===amazon!.id);
    for (const key of ['www.amazon.jobs/jobs/7655','www.amazon.jobs/jobs/7654/unrelated']) {
      archived.key = key;
      writeFileSync(stateFile,JSON.stringify(saved));
      assert.throws(()=>new ApplicationQueue(root,bridge),/Saved C3 queue is invalid/);
    }
    archived.key = oldKey;
    archived.status = 'paused';
    writeFileSync(stateFile,JSON.stringify(saved));
    assert.throws(()=>new ApplicationQueue(root,bridge),/Saved C3 queue is invalid/);
  } finally { await queue.close(); }
});

test("editing or importing a legacy profile cannot promote its test policy", async () => {
  const values = { given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" };
  const original = applicantProfile(values) as any;
  original.executionPolicy = { ...original.executionPolicy, answerFallbackPolicy: "owner_facts_only" };
  const edited = applicantProfile({ ...values, given_name: "Changed" }, original) as any;
  assert.deepEqual(edited.executionPolicy, original.executionPolicy);
  original.profilePlan.mode = "synthetic_test_non_submittable";
  assert.throws(() => applicantProfile(values, original), /test profile/);
  delete original.executionPolicy;
  const queue = new ApplicationQueue(mkdtempSync(join(tmpdir(), "c3-legacy-policy-")), {
    connected: false, open: async () => { throw new Error("unexpected browser open"); }, release: async () => {},
  });
  try {
    const pdf = Buffer.from("%PDF-original").toString("base64");
    queue.configure(original, pdf);
    const [job] = queue.add([{url: "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1"}]);
    assert.equal(job!.submissionAllowed, false);
    assert.throws(() => queue.configure({...original, executionPolicy: null}, pdf), /policy denied/);
  } finally { await queue.close(); }
});

test("disk failure pauses scheduling instead of crashing the service", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-storage-"));
  let opened = false;
  const bridge: BrowserConnection = { connected: false, open: async () => { opened = true; throw new Error(); }, release: async () => {} };
  const queue = new ApplicationQueue(root, bridge);
  try {
    queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" }), Buffer.from("%PDF-original").toString("base64"));
    const [job] = queue.add([{ url: "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1" }]);
    const stateFile = join(root, "jobs.json"); unlinkSync(stateFile); mkdirSync(stateFile);
    bridge.connected = true;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.match(queue.snapshot().storageError!, /could not save/);
    assert.equal(opened, false); assert.equal(job!.status, "paused");
    bridge.connected = false; rmdirSync(stateFile);
    queue.setConcurrency(6);
    assert.match(queue.snapshot().storageError!, /could not save/, "successful background persistence must not resume work");
    await queue.action(job!.id, "retry");
    assert.equal(queue.snapshot().storageError, undefined);
  } finally { await queue.close(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("observed resume requirement survives a failed fill and service restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-resume-observed-"));
  const url = "https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111";
  const bridge: BrowserConnection = { connected: true,
    open: async () => ({tabId: 46, page: {url: () => url} as any, browser: {close: async () => {}} as any}),
    release: async () => {} };
  const observed = deferred<void>(), finishGrant = deferred<void>();
  let pendingGrantSignal: AbortSignal | undefined;
  let receipt: {token:string;selectedSha256:string;filename:string;applicationKey:string};
  const queue = new ApplicationQueue(root, bridge, async (_page, input, signal) => {
    pendingGrantSignal = signal;
    input.onResumeObserved!();
    receipt={token:'11111111-1111-4111-8111-111111111111',selectedSha256:'a'.repeat(64),filename:'Resume.pdf',applicationKey:queue.jobs[0]!.key};
    input.onResumeUpload!(receipt);
    assert.equal(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).jobs[0].resumeExpected, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).jobs[0].resumeUpload, receipt);
    observed.resolve();
    await finishGrant.promise;
    signal.throwIfAborted();
    throw new Error("upload removed its input");
  });
  const owner = {given_name:"Fixture",family_name:"Applicant",email_address:"fixture@example.invalid",city:"Pinned"};
  const facts = (manifest: unknown) => parseApplicationProfile((manifest as {profile:unknown}).profile).facts;
  const consent = (manifest: unknown) => facts(manifest).find(fact => fact.factId === "ai_evaluation_consent")?.value;
  const pdf = Buffer.from("%PDF-fixture").toString("base64");
  queue.configure(applicantProfile({...owner,ai_evaluation_consent:"true"}), pdf);
  const [job] = queue.add([{url}]);
  const selected = queue.add([{url:"https://jobs.jobvite.com/fixture/job/abc/apply",sourceJobId:52,
    resumeVersion:"v2",resumeBase64:pdf}],{paused:true,currentPageHandoff:true})[0]!;
  const savedInputs = [job!,selected].map(draft => readFileSync(join(root,draft.id+".input.json"),"utf8"));
  assert.equal(consent(queue.currentPageInput(selected).profile),true);
  await observed.promise;
  queue.configureApplicant({...owner,ai_evaluation_consent:"false"});
  assert.equal(pendingGrantSignal?.aborted,true);
  assert.match(pendingGrantSignal?.reason.message,/consent changed/);
  finishGrant.resolve();
  await queue.close();
  const retried = deferred<ProductInput>(), pendingConsent = deferred<void>();
  let staleWrite = false;
  const restored = new ApplicationQueue(root, bridge, async (_page, input, signal) => {
    retried.resolve(input);
    await pendingConsent.promise;
    signal.throwIfAborted();
    staleWrite = true;
    throw new Error("resume input still missing");
  });
  try {
    restored.configureApplicant({...owner,city:"Changed",ai_evaluation_consent:"false"});
    await restored.action(job!.id, "retry");
    const input=await retried.promise;
    assert.equal(input.resumeExpected, true);assert.deepEqual(input.resumeUpload,receipt!);
    assert.equal(consent(input.profile),false);
    assert.equal(input.resume.toString("base64"),pdf);
    const pinnedFacts = facts(JSON.parse(savedInputs[0]!).profile).filter(f => f.factId !== "ai_evaluation_consent");
    assert.deepEqual(facts(input.profile).filter(f => f.factId !== "ai_evaluation_consent"),pinnedFacts);
    assert.equal(consent(restored.currentPageInput(selected).profile),false);
    restored.configureApplicant({...owner,ai_evaluation_consent:""});
    const cleared = restored.currentPageInput(selected);
    assert.equal(consent(cleared.profile),undefined);
    assert.equal(cleared.resume,pdf);
    assert.deepEqual(facts(cleared.profile),pinnedFacts);
    assert.deepEqual([job!,selected].map(draft => readFileSync(join(root,draft.id+".input.json"),"utf8")),savedInputs);
  } finally { pendingConsent.resolve(); await restored.close(); }
  assert.equal(staleWrite,false);
  assert.equal(restored.jobs[0]!.status, "paused");
  assert.match(restored.jobs[0]!.error!,/consent changed/);
});

test("shutdown drains or bounds pending runner and Review opens and releases late sessions", async () => {
  for (const mode of ["runner", "bounded-runner", "review"] as const) {
    const opening = deferred<Awaited<ReturnType<BrowserConnection["open"]>>>();
    const opened = deferred<void>(), released = deferred<void>();
    let fills = 0, disconnects = 0;
    const root = mkdtempSync(join(tmpdir(), "c3-pending-shutdown-"));
    const queue = new ApplicationQueue(root, {
      connected: mode !== "review",
      open: async () => { opened.resolve(); return opening.promise; },
      release: async () => { released.resolve(); },
    }, async () => { fills++; return { reviewDigest: "fixture", completedPages: 1 }; });
    queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" }), Buffer.from("%PDF-fixture").toString("base64"));
    const [job] = queue.add([{ url: "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1" }]);
    let reviewing: Promise<void> | undefined;
    if (mode === "review") {
      job!.status = "review"; job!.tabId = 44;
      reviewing = assert.rejects(queue.action(job!.id, "refresh_review"), /stopping/);
    }
    await opened.promise;
    let closed = false;
    const closing = queue.close(mode === "bounded-runner" ? 10 : undefined).then(() => { closed = true; });
    if (mode === "bounded-runner") await closing;
    else {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed, false);
    }
    opening.resolve({ tabId: 44, page: {} as any, browser: { close: async () => { disconnects++; } } as any });
    await closing; await reviewing; await released.promise;
    assert.equal(fills, 0);
    assert.equal(disconnects, 1);
    assert.equal(job!.status, mode === "review" ? "review" : "paused");
    if (mode !== "review") {
      assert.equal(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).jobs[0].status, "paused");
      await assert.rejects(queue.action(job!.id, "retry"), /stopping/);
    }
  }
});

test("shutdown preserves uncertain submission state even when progress cannot be saved", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-close-storage-"));
  const queue = new ApplicationQueue(root, { connected: false, open: async () => { throw new Error(); }, release: async () => {} });
  queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" }), Buffer.from("%PDF-fixture").toString("base64"));
  const [job] = queue.add([{ url: "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1" }]);
  job!.status = "submitting"; job!.reviewDigest = "fixture";
  queue.setConcurrency(6);
  const stateFile = join(root, "jobs.json"); unlinkSync(stateFile); mkdirSync(stateFile);
  await queue.close();
  assert.equal(job!.status, "submission_uncertain");
  assert.equal(job!.reviewDigest, undefined);
  assert.match(queue.snapshot().storageError!, /could not save/);
  rmdirSync(stateFile);
});

test("shutdown detaches a stalled automation connection and drains the active fill", async () => {
  const filling = deferred<void>(), finishFill = deferred<void>(), finishDisconnect = deferred<void>();
  const detached = deferred<void>();
  const url = "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1";
  const queue = new ApplicationQueue(mkdtempSync(join(tmpdir(), "c3-close-fill-")), {
    connected: true,
    open: async () => ({ tabId: 45, page: { url: () => url } as any,
      browser: { close: async () => finishDisconnect.promise } as any }),
    release: async () => { detached.resolve(); },
  }, async () => {
    filling.resolve(); await finishFill.promise;
    return { reviewDigest: "fixture", completedPages: 1 };
  });
  queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" }), Buffer.from("%PDF-fixture").toString("base64"));
  const [job] = queue.add([{ url }]);
  await filling.promise;
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  await detached.promise;
  assert.equal(closed, false);
  finishDisconnect.resolve(); finishFill.resolve();
  await closing;
  assert.equal(job!.status, "paused", "late fill success must not restore Review after shutdown");
});


test("paused admission never opens a connected browser and preserves pause across restart", async () => {
  const root=mkdtempSync(join(tmpdir(),'c3-paused-import-')); let opens=0;
  const bridge:BrowserConnection={connected:true,open:async()=>{opens++;throw new Error('unexpected');},release:async()=>{}};
  let queue=new ApplicationQueue(root,bridge);
  queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),Buffer.from('%PDF-selected').toString('base64'));
  const input={url:'https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1'};
  const [job]=queue.add([input],{paused:true});
  assert.equal(job!.status,'paused');assert.equal(opens,0);
  await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(opens,0);
  assert.equal(queue.add([input],{paused:true})[0]!.id,job!.id);
  await queue.close();queue=new ApplicationQueue(root,bridge);
  assert.equal(queue.jobs[0]!.status,'paused');assert.equal(opens,0);
  queue.jobs[0]!.status='running';
  assert.throws(()=>queue.add([input],{paused:true}),/already active/);
  queue.jobs[0]!.status='paused';await queue.close();
});

test("legacy scalar study plans normalize without modifying saved input and retain edit authority", () => {
  const values={given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',education_field_of_study:'Computer Science'};
  const profile=applicantProfile(values) as any;
  profile.profilePlan.repeatables=[{section:'education',rows:[{rowKey:'education_1',fields:[{fieldId:'education.field_of_study',questionType:'education',answerType:'multi_select',allowedOptions:[],answer:{kind:'answered',value:'Computer Science',provenance:'owner_provided',lane:'live_owner_fact'},optionMapping:{canonicalValue:'Computer Science',visibleOption:'Computer Science',provenance:'visible_option'}}]}]}];
  const before=JSON.stringify(profile);
  const sources=productSources(profile,Buffer.from('%PDF-fixture'));
  const field=sources.profilePlan.repeatables[0]!.rows[0]!.fields[0]!;
  assert.equal(field.answer.kind==='answered'&&field.answer.value,'["Computer Science"]');
  assert.equal(JSON.stringify(profile),before);disposeResumeArtifact(sources.resumeIntent.artifact);
  const normalized={...profile,profilePlan:sources.profilePlan};
  const edited=applicantProfile({...values,education_field_of_study:'Mathematics'},normalized) as any;
  const admitted=productSources(edited,Buffer.from('%PDF-fixture'));disposeResumeArtifact(admitted.resumeIntent.artifact);
  assert.equal(edited.profilePlan.repeatables[0].rows[0].fields[0].answer.value,'["Mathematics"]');
  assert.throws(()=>applicantProfile({...values,education_field_of_study:''},normalized),/rather than clearing/);
  const forged=structuredClone(edited);forged.profilePlan.repeatables[0].rows[0].fields[0].answer.value='["Unapproved"]';forged.profilePlan.repeatables[0].rows[0].fields[0].optionMapping.canonicalValue='["Unapproved"]';
  assert.throws(()=>productSources(forged,Buffer.from('%PDF-fixture')));
});


test("live drafts allow reviewable defaults without changing saved policy",()=>{
  const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',answer_policy:'test'}) as any;
  const before=JSON.stringify(profile);const sources=productSources(profile,Buffer.from('%PDF-fixture'));
  assert.equal(sources.executionPolicy.answerFallbackPolicy,'deterministic_site_valid_editable');
  assert.equal(sources.executionPolicy.submissionPolicy,'forbidden');
  assert.equal(JSON.stringify(profile),before);
  assert.equal(profile.executionPolicy.answerFallbackPolicy,'deterministic_site_valid_editable');
  disposeResumeArtifact(sources.resumeIntent.artifact);
  assert.equal((applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}) as any).executionPolicy.answerFallbackPolicy,'owner_facts_only');
});
