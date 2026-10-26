import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationQueue, type BrowserConnection } from "../../src/product/queue.ts";
import { applicantProfile } from "../../src/product/sources.ts";

test("legacy campaign profile imports without promoting its non-submittable mode", async () => {
  const queue = new ApplicationQueue(mkdtempSync(join(tmpdir(), "c3-legacy-")), { connected: false, open: async () => { throw new Error(); }, release: async () => {} });
  try {
    const profile = applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }) as any;
    profile.profilePlan.mode = "synthetic_test_non_submittable";
    delete profile.executionPolicy;
    queue.configure(profile, Buffer.from("%PDF-original").toString("base64"));
    const [job] = queue.add([{ url: "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1" }]);
    assert.equal(job!.submissionAllowed, false);
    assert.throws(() => queue.configure({ ...profile, executionPolicy: null }, Buffer.from("%PDF-original").toString("base64")), /policy denied/);
  } finally { await queue.close(); }
});

test("queue snapshots inputs, supports remove/restore, and never retries uncertain submissions after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-queue-"));
  const bridge: BrowserConnection = { connected: false, open: async () => { throw new Error("should not open"); }, release: async () => {} };
  const queue = new ApplicationQueue(root, bridge);
  const profile = applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" });
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
    queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }), Buffer.from("%PDF-original").toString("base64"));
    const input = { url: "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1" };
    const [first] = queue.add([input]);
    assert.throws(() => queue.add([{ ...input, resumeBase64: Buffer.from("%PDF-replacement").toString("base64") }]), /different resume/);
    await queue.action(first!.id, "remove");
    queue.add([input]);
    await assert.rejects(queue.action(first!.id, "restore"), /already been added/);
  } finally { await queue.close(); }
});

test("editing basic details preserves imported policy and cannot promote test profiles", () => {
  const values = { given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" };
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
    queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }), Buffer.from("%PDF-original").toString("base64"));
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

test("a matching C1 handoff preserves its source and selected resume identity", async () => {
  const queue = new ApplicationQueue(mkdtempSync(join(tmpdir(), "c3-origin-")), { connected: false, open: async () => { throw new Error(); }, release: async () => {} });
  try {
    const resumeBase64 = Buffer.from("%PDF-selected").toString("base64");
    queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }), resumeBase64);
    const input = { url: "https://fixture.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1" };
    const [manual] = queue.add([input]);
    queue.add([{ ...input, resumeBase64, sourceJobId: 7, resumeVersion: "version-2", resumeName: "selected.pdf" }]);
    assert.equal(manual!.sourceJobId, 7); assert.equal(manual!.resumeVersion, "version-2");
    assert.equal(manual!.resumeName, "selected.pdf");
    assert.equal(manual!.resumeSha256?.length, 64);
    assert.throws(() => queue.add([{ ...input, resumeBase64, sourceJobId: 8 }]), /another Hunt job/);
    assert.equal(manual!.sourceJobId, 7);
  } finally { await queue.close(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("shutdown drains an opening runner and releases its late session without filling", async () => {
  const opening = deferred<Awaited<ReturnType<BrowserConnection["open"]>>>();
  const opened = deferred<void>();
  const released = deferred<void>();
  let fills = 0, disconnects = 0;
  const bridge: BrowserConnection = { connected: true,
    open: async () => { opened.resolve(); return opening.promise; },
    release: async () => { released.resolve(); },
  };
  const root = mkdtempSync(join(tmpdir(), "c3-close-open-"));
  const queue = new ApplicationQueue(root, bridge, async () => {
    fills++; return { reviewDigest: "fixture", completedPages: 1 };
  });
  queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }), Buffer.from("%PDF-fixture").toString("base64"));
  const [job] = queue.add([{ url: "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1" }]);
  await opened.promise;
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  opening.resolve({ tabId: 42, page: {} as any, browser: { close: async () => { disconnects++; } } as any });
  await closing; await released.promise;
  assert.equal(fills, 0); assert.equal(disconnects, 1);
  assert.equal(job!.status, "paused");
  assert.equal(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).jobs[0].status, "paused");
  await assert.rejects(queue.action(job!.id, "retry"), /stopping/);
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
  queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }), Buffer.from("%PDF-fixture").toString("base64"));
  const [job] = queue.add([{ url: "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1" }]);
  await opened.promise;
  await queue.close(10);
  assert.equal(job!.status, "paused");
  opening.resolve({ tabId: 43, page: {} as any, browser: { close: async () => {} } as any });
  await released.promise;
  assert.equal(fills, 0);
});

test("shutdown also drains pending review opens and prevents further review work", async () => {
  const opening = deferred<Awaited<ReturnType<BrowserConnection["open"]>>>();
  const released = deferred<void>();
  const bridge: BrowserConnection = { connected: false, open: async () => opening.promise,
    release: async () => { released.resolve(); },
  };
  const queue = new ApplicationQueue(mkdtempSync(join(tmpdir(), "c3-close-review-")), bridge);
  queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }), Buffer.from("%PDF-fixture").toString("base64"));
  const [job] = queue.add([{ url: "https://fixture.wd1.myworkdayjobs.com/Test/job/City/Job_R1" }]);
  job!.status = "review"; job!.tabId = 44;
  const reviewing = assert.rejects(queue.action(job!.id, "refresh_review"), /stopping/);
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  opening.resolve({ tabId: 44, page: {} as any, browser: { close: async () => {} } as any });
  await closing; await reviewing; await released.promise;
  assert.equal(job!.status, "review");
});

test("shutdown preserves uncertain submission state even when progress cannot be saved", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-close-storage-"));
  const queue = new ApplicationQueue(root, { connected: false, open: async () => { throw new Error(); }, release: async () => {} });
  queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }), Buffer.from("%PDF-fixture").toString("base64"));
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
  queue.configure(applicantProfile({ given_name: "Fixture", family_name: "Applicant", email_address: "fixture@example.test" }), Buffer.from("%PDF-fixture").toString("base64"));
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
