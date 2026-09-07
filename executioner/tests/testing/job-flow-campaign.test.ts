import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { loadJobFlowMatrix, validateJobFlowMatrix, verifyReadOnlyLiveJob, matrixTestFiles } from "../../scripts/job-flow-campaign.ts";

const matrix = () => loadJobFlowMatrix(resolve("fixtures/job-flow-campaign/v1.json"), process.cwd());
const job = () => matrix().baselineJobs[0]!;
const policy = { retryLimit: 1, timeoutMs: 1000, maxBytes: 1024 };

test("matrix covers every failure, unique company, real test file and synthetic boundary", () => {
  const value = matrix();
  assert.deepEqual(validateJobFlowMatrix(value, process.cwd()), []);
  assert.ok(matrixTestFiles(value).length > 10);
  const unsafe = structuredClone(value) as any;
  unsafe.safety.externalSubmissionAllowed = true;
  unsafe.baselineJobs[1].id = unsafe.baselineJobs[0].id;
  unsafe.rules[0].testFiles = ["../../outside.test.ts"];
  assert.equal(validateJobFlowMatrix(unsafe, process.cwd()).length, 3);
});

test("matrix cannot replace completion with an unsupported ATS stop or a private host", () => {
  const value = structuredClone(matrix()) as any;
  value.baselineJobs[0].ats = "lever";
  value.baselineJobs[0].officialUrl = "https://localhost/";
  value.baselineJobs[0].allowedHosts = ["localhost"];
  value.baselineJobs[0].terminalState = "unsupported_ats_safe_stop";
  assert.ok(validateJobFlowMatrix(value, process.cwd()).length >= 3);
});

test("rejects foreign, credentialed, insecure and nonstandard-port URLs before any fetch", async () => {
  for (const officialUrl of ["http://sunlife.wd3.myworkdayjobs.com/", "https://evil.example/", "https://synthetic@example.invalid/", "https://sunlife.wd3.myworkdayjobs.com:8443/"]) {
    let requests = 0;
    const result = await verifyReadOnlyLiveJob({ ...job(), officialUrl, allowedHosts: [...job().allowedHosts, "example.invalid"] }, policy, async () => { requests++; throw Error(); });
    assert.equal(result.outcome, "redirect_denied");
    assert.equal(requests, 0);
  }
});

test("manual redirect validates destination before issuing GET and bounds cycles", async () => {
  for (const destination of ["https://evil.example/secret", job().officialUrl]) {
    const requests: string[] = [];
    const result = await verifyReadOnlyLiveJob(job(), policy, async (url, init) => {
      requests.push(url);
      assert.equal(init.redirect, "manual");
      assert.equal(init.method, "GET");
      return new Response(null, { status: 302, headers: { location: destination } });
    });
    assert.equal(result.outcome, "redirect_denied");
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("follows an allowed relative redirect without claiming application acceptance", async () => {
  let calls = 0;
  const result = await verifyReadOnlyLiveJob(job(), policy, async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: "/current" } })
    : new Response(job().titleMarker));
  assert.equal(calls, 2);
  assert.equal(result.outcome, "posting_present");
});

test("stream size cap cancels an unbounded body without buffering it", async () => {
  let cancelled = false;
  let pulls = 0;
  const result = await verifyReadOnlyLiveJob(job(), policy, async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(800)); },
    cancel() { cancelled = true; },
  })));
  assert.equal(result.outcome, "unavailable");
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test("expiration, title mismatch and access/rate limits do not loop", async () => {
  for (const [response, expected] of [
    [new Response(null, { status: 404 }), "expired"],
    [new Response(`${job().titleMarker}: job is no longer available`), "expired"],
    [new Response("Sign in"), "title_mismatch"],
    [new Response(null, { status: 429 }), "unavailable"],
    [new Response(null, { status: 403 }), "unavailable"],
    [new Response(null, { status: 503, headers: { "retry-after": "60" } }), "unavailable"],
  ] as const) {
    let calls = 0;
    const result = await verifyReadOnlyLiveJob(job(), policy, async () => { calls++; return response; });
    assert.equal(result.outcome, expected);
    assert.equal(calls, 1);
  }
});

test("transient failures have a fixed attempt ceiling and sanitized diagnostics", async () => {
  let calls = 0;
  const result = await verifyReadOnlyLiveJob(job(), policy, async () => { calls++; throw new Error("private-token"); });
  assert.equal(calls, 2);
  assert.equal(result.outcome, "unavailable");
  assert.equal(JSON.stringify(result).includes("private-token"), false);
});
