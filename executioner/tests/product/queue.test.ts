import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationQueue, type BrowserConnection } from "../../src/product/queue.ts";
import { applicantProfile, productSources } from "../../src/product/sources.ts";
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
});

test("restoring a replaced job and silently changing its selected resume are rejected", async () => {
  const queue = new ApplicationQueue(mkdtempSync(join(tmpdir(), "c3-duplicate-")), { connected: false, open: async () => { throw new Error(); }, release: async () => {} });
  try {
    queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" }), Buffer.from("%PDF-original").toString("base64"));
    const input = { url: "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1" };
    const [first] = queue.add([input]);
    assert.throws(() => queue.add([{ ...input, resumeBase64: Buffer.from("%PDF-replacement").toString("base64") }]), /different resume/);
    await queue.action(first!.id, "remove");
    queue.add([input]);
    await assert.rejects(queue.action(first!.id, "restore"), /already been added/);
  } finally { await queue.close(); }
});

test("editing basic details preserves imported policy and cannot promote test profiles", () => {
  const values = { given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" };
  const original = applicantProfile(values) as any;
  original.executionPolicy = { ...original.executionPolicy, answerFallbackPolicy: "owner_facts_only" };
  const edited = applicantProfile({ ...values, given_name: "Changed" }, original) as any;
  assert.deepEqual(edited.executionPolicy, original.executionPolicy);
  original.profilePlan.mode = "synthetic_test_non_submittable";
  assert.throws(() => applicantProfile(values, original), /test profile/);
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
  const observed = deferred<void>();
  let receipt: {token:string;selectedSha256:string;filename:string;applicationKey:string};
  const queue = new ApplicationQueue(root, bridge, async (_page, input) => {
    input.onResumeObserved!();
    receipt={token:'11111111-1111-4111-8111-111111111111',selectedSha256:'a'.repeat(64),filename:'Resume.pdf',applicationKey:queue.jobs[0]!.key};
    input.onResumeUpload!(receipt);
    assert.equal(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).jobs[0].resumeExpected, true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).jobs[0].resumeUpload, receipt);
    observed.resolve();
    throw new Error("upload removed its input");
  });
  queue.configure(applicantProfile({given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid"}), Buffer.from("%PDF-fixture").toString("base64"));
  const [job] = queue.add([{url}]);
  await observed.promise;
  await queue.close();
  const retried = deferred<{resumeExpected?:boolean;resumeUpload?:unknown}>();
  const restored = new ApplicationQueue(root, bridge, async (_page, input) => {
    retried.resolve(input);
    throw new Error("resume input still missing");
  });
  try {
    await restored.action(job!.id, "retry");
    const input=await retried.promise;
    assert.equal(input.resumeExpected, true);assert.deepEqual(input.resumeUpload,receipt!);
  } finally { await restored.close(); }
  assert.equal(restored.jobs[0]!.status, "paused");
});

test("shutdown is bounded while a pending open remains responsible for late cleanup", async () => {
  const opening = deferred<Awaited<ReturnType<BrowserConnection["open"]>>>();
  const opened = deferred<void>(), released = deferred<void>();
  let fills = 0;
  const bridge: BrowserConnection = { connected: true,
    open: async () => { opened.resolve(); return opening.promise; },
    release: async () => { released.resolve(); },
  };
  const queue = new ApplicationQueue(mkdtempSync(join(tmpdir(), "c3-close-bound-")), bridge, async () => {
    fills++; return { reviewDigest: "fixture", completedPages: 1 };
  });
  queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.invalid" }), Buffer.from("%PDF-fixture").toString("base64"));
  const [job] = queue.add([{ url: "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1" }]);
  await opened.promise;
  await queue.close(10);
  assert.equal(job!.status, "paused");
  opening.resolve({ tabId: 43, page: {} as any, browser: { close: async () => {} } as any });
  await released.promise;
  assert.equal(fills, 0);
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


test("unfamiliar selected resumes require paused admission and cannot become submittable", async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-generic-import-'));
  const bridge:BrowserConnection={connected:false,open:async()=>{throw new Error('must stay paused');},release:async()=>{}};
  const queue=new ApplicationQueue(root,bridge);
  try {
    queue.configure(applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'}),Buffer.from('%PDF-default').toString('base64'));
    const input={url:'https://fixture.bamboohr.com/careers/123',resumeBase64:Buffer.from('%PDF-selected').toString('base64'),sourceJobId:123,resumeVersion:'17'};
    assert.throws(()=>queue.add([input]),/paused/);
    const [job]=queue.add([input],{paused:true});assert.equal(job!.submissionAllowed,false);
    assert.equal(job!.status,'paused');assert.equal(JSON.parse(readFileSync(join(root,`${job!.id}.input.json`),'utf8')).resume,input.resumeBase64);
    await queue.close();const restored=new ApplicationQueue(root,bridge);assert.equal(restored.jobs[0]!.status,'paused');assert.equal(restored.jobs[0]!.resumeVersion,'17');await restored.close();
  }finally{await queue.close();}
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
