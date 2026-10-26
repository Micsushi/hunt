import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { chromium } from "playwright";
import { WebSocket } from "ws";
import { startProductServer } from "../../src/product/server.ts";
import { applicationFixture } from "./fixture.ts";

const sockets = new Map<string, WebSocket>();
let sequence = 0;
async function cdp(url: string, method: string, params: object = {}): Promise<any> {
  let socket = sockets.get(url);
  if (!socket) { socket = new WebSocket(url); sockets.set(url, socket); await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); }); }
  const id = ++sequence;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 30_000);
      const listener = (raw: WebSocket.RawData) => { const message = JSON.parse(raw.toString()); if (message.id !== id) return; clearTimeout(timer); socket!.off('message', listener); message.error ? reject(new Error(message.error.message)) : resolve(message.result); };
      socket!.on('message', listener);
      socket!.send(JSON.stringify({ id, method, params }));
    });
}

test("real extension retains Review and recovers after browser-initiated discard", { timeout: 180_000 }, async () => {
  for (const port of [47851, 47852, 47853]) {
    const probe = createTcpServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve())); });
  }
  const root = mkdtempSync(join(tmpdir(), "c3-suspension-"));
  const service = await startProductServer({ root, port: 47851 });
  const token = readFileSync(service.tokenPath, "utf8");
  const extension = join(root, "extension");
  execFileSync(process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1", "-subj", "/CN=suspension.wd1.myworkdayjobs.com"], { windowsHide: true, stdio: "ignore" });
  const fixture = applicationFixture
    .replace('<label>Resume<input', '<div data-automation-id="formField-resume"><label>Resume<abbr title="Required">*</abbr><input')
    .replace('type="file" data-automation-id="file-upload-input-ref" required', 'type="file" data-automation-id="file-upload-input-ref"')
    .replace('<button id="next">', '</div><button id="next">')
    .replace("function review(){", "function review(){sessionStorage.setItem('review',JSON.stringify({saved,resumeName,answer}));")
    .replace("profile();", `
      globalThis.restoredEdits=0;
      if(sessionStorage.getItem('review')) {
        ({saved,resumeName,answer}=JSON.parse(sessionStorage.getItem('review')));
        const originalProfile=profile, originalResume=resume, originalQuestions=questions;
        profile=()=>{originalProfile();root.querySelectorAll('input').forEach((input,index)=>input.value=saved[index]);};
        resume=()=>{originalResume();const item=document.createElement('div');item.dataset.automationId='file-upload-item';item.dataset.uploadState='success';item.textContent=resumeName;document.querySelector('#uploaded').append(item);};
        questions=()=>{originalQuestions();root.querySelector('select').value=answer;};
        const originalReview=review;
        review=()=>{originalReview();const submit=root.querySelector('button');submit.disabled=true;setTimeout(()=>submit.disabled=false,1500);};
        document.addEventListener('input',()=>globalThis.restoredEdits++);
      }
      if(sessionStorage.getItem('review')) {
        root.innerHTML='<div role="status">Loading saved application</div>';
        setTimeout(profile, 1500);
      } else profile();`);
  const fixtureServer = createServer({ key: readFileSync(join(root, "key.pem")), cert: readFileSync(join(root, "cert.pem")) }, (_, response) => { response.setHeader("Content-Type", "text/html"); response.end(fixture); });
  await new Promise<void>(resolve => fixtureServer.listen(47852, "127.0.0.1", resolve));
  cpSync(resolve("extension"), extension, { recursive: true });
  for (const file of ["background.js", "manifest.json"]) writeFileSync(join(extension, file), readFileSync(join(extension, file), "utf8").replaceAll("47831", "47851"));
  const browser = spawn(process.env.HUNT_C3_CHROMIUM ?? chromium.executablePath(), [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=47853', `--user-data-dir=${join(root, 'browser')}`,
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--ignore-certificate-errors", "--no-proxy-server", "--host-resolver-rules=MAP suspension.wd1.myworkdayjobs.com 127.0.0.1:47852", 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const targets = async (): Promise<any[]> => fetch('http://127.0.0.1:47853/json/list').then(response => response.json());
  let workerUrl: string | undefined;
  const evaluate = async (type: string, expression: string) => {
    const target = (await targets()).find(target => target.type === type && (type === 'service_worker' ? target.webSocketDebuggerUrl === workerUrl : target.url.includes('suspension.wd1')));
    assert.ok(target, `Missing ${type}`);
    const result = await cdp(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const worker = { evaluate: (expression: string) => evaluate('service_worker', expression) };
  const api = async (path: string, body: unknown, expected = 200) => {
    const response = await fetch(`${service.origin}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  };
  try {
    for (let i = 0; i < 100 && !workerUrl; i++) {
      for (const target of await targets().catch(() => [])) {
        if (target.type !== 'service_worker' || !target.url.endsWith('/background.js')) continue;
        const manifest = await cdp(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: "chrome.runtime?.getManifest?.().name", returnByValue: true });
        if (manifest.result?.value === 'Hunt C3') workerUrl = target.webSocketDebuggerUrl;
      }
      if (!workerUrl) await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (let i = 0; i < 100 && !await worker.evaluate("typeof chrome !== 'undefined' && !!chrome.storage?.local && typeof connect === 'function'"); i++) await new Promise(resolve => setTimeout(resolve, 100));
    await worker.evaluate(`chrome.storage.local.set({token:${JSON.stringify(token)}}).then(() => connect())`);
    for (let i = 0; i < 100 && !service.queue.snapshot().connected; i++) await new Promise(r => setTimeout(r, 50));
    await api("settings", { applicant: { given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.test" }, resumeBase64: Buffer.from("%PDF-1.4\nfixture").toString("base64") });
    await api("jobs", { jobs: [{ url: "https://suspension.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R1" }] });
    const job = service.queue.jobs[0]!;
    const deadline = Date.now() + 90_000;
    while (["running", "queued"].includes(job.status) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    assert.equal(job.status, "review", JSON.stringify(job));
    assert.equal(await worker.evaluate(`chrome.tabs.get(${job.tabId}).then(t=>t.discarded)`), false);
    // Simulate Chrome/user memory management independently of C3 completion.
    await worker.evaluate(`chrome.tabs.discard(${job.tabId})`);
    assert.equal(await worker.evaluate(`chrome.tabs.get(${job.tabId}).then(t=>t.discarded)`), true);
    assert.equal(JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")).jobs[0].status, "review");
    const digest = job.reviewDigest;
    await api(`jobs/${job.id}/action`, { action: "submit", confirmed: true, reviewDigest: digest }, 400);
    await api(`jobs/${job.id}/action`, { action: "refresh_review" });
    assert.equal(job.reviewDigest, digest);
    assert.equal(await worker.evaluate(`chrome.tabs.get(${job.tabId}).then(t=>t.discarded)`), false);
    assert.equal(await evaluate('page', 'restoredEdits'), 0);
    await api(`jobs/${job.id}/action`, { action: "open" });
    await api(`jobs/${job.id}/action`, { action: "submit", reviewDigest: digest }, 400);
    for (let i = 0; i < 100 && !await worker.evaluate(`chrome.tabs.get(${job.tabId}).then(t=>!t.discarded&&t.status==='complete')`); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await evaluate('page', "submits"), 0);
    await evaluate('page', `document.querySelector('[data-automation-id="formField-"] p').textContent='Edited after wake'`);
    await api(`jobs/${job.id}/action`, { action: "submit", confirmed: true, reviewDigest: digest }, 400);
    assert.equal(await evaluate('page', "submits"), 0);
    await evaluate('page', "profile();document.querySelector('input').value='';");
    await api(`jobs/${job.id}/action`, { action: "refresh_review" }, 400);
    assert.equal(await evaluate('page', "document.querySelector('input').value"), '');
    assert.equal(await evaluate('page', 'restoredEdits'), 0);
  } finally {
    await service.close();
    const version = await fetch('http://127.0.0.1:47853/json/version').then(response => response.json()).catch(() => null) as any;
    if (version?.webSocketDebuggerUrl) await cdp(version.webSocketDebuggerUrl, 'Browser.close').catch(() => {});
    for (const socket of sockets.values()) socket.close(); sockets.clear();
    if (browser.exitCode === null) browser.kill();
    fixtureServer.closeAllConnections(); fixtureServer.close();
  }
});
