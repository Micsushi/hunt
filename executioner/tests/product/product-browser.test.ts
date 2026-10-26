import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright";
import { startProductServer } from "../../src/product/server.ts";
import { applicationFixture, accountFixture } from "./fixture.ts";

test("real extension fills concurrent tabs through Review and requires fresh per-job submission", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-product-check-"));
  const service = await startProductServer({ root });
  const token = readFileSync(service.tokenPath, "utf8");
  const extension = resolve("extension");
  const context = await chromium.launchPersistentContext(join(root, "browser"), {
    headless: true, channel: "chromium", ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const api = async (path: string, body?: unknown, expected = 200) => {
    const response = await fetch(`${service.origin}/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  };
  try {
    let worker;
    for (let i = 0; i < 100 && !worker; i++) {
      for (const candidate of context.serviceWorkers()) {
        if (await candidate.evaluate("chrome.runtime?.getManifest?.().name === 'Hunt C3'").catch(() => false)) { worker = candidate; break; }
      }
      if (!worker) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(worker, "Hunt C3 extension worker must initialize");
    await worker.evaluate(`chrome.storage.local.set({token:${JSON.stringify(token)}}).then(() => connect())`);
    for (let i = 0; i < 100 && !service.queue.snapshot().connected; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(service.queue.snapshot().connected, true);
    const count = Number(process.env.C3_BATCH_CHECK_COUNT ?? 2);
    assert.ok(count >= 2 && count <= 30);
    await context.route(/https:\/\/fixture\d+\.wd1\.myworkdayjobs\.com\//, route => route.fulfill({ contentType: "text/html", body: route.request().url().includes("//fixture0.") ? accountFixture : applicationFixture }));
    const pages: Page[] = [];
    for (let i = 0; i < count; i++) {
      const page = await context.newPage();
      await page.goto(`https://fixture${i}.wd1.myworkdayjobs.com/en-US/Test/job/City/Job_R${i}`);
      pages.push(page);
    }
    const tabs = await worker.evaluate("chrome.tabs.query({})") as { id: number; url: string }[];
    await api("settings", { applicant: { given_name: "Synthetic", family_name: "Applicant", email_address: "fixture@example.invalid" }, resumeBase64: Buffer.from("%PDF-1.4\nsynthetic fixture").toString("base64") });
    await api("account", { email: "fixture@example.invalid", password: "Synthetic-only-123!" });
    let verifications = 0;
    service.queue.verifyEmail = async page => {
      assert.equal(await page.evaluate("sessionStorage.getItem('created')"), "yes");
      await page.evaluate("sessionStorage.setItem('verified','yes')"); verifications++;
    };
    await api("concurrency", { value: count });
    // Exercise the actual popup entry point on the first selected job.
    await worker.evaluate(`chrome.tabs.update(${tabs.find(t => t.url === pages[0]!.url())!.id}, {active:true})`);
    const popupUrl = worker.url().replace(/background\.js$/, "popup.html");
    const [popup] = await Promise.all([context.waitForEvent("page"), worker.evaluate(`chrome.tabs.create({url:${JSON.stringify(popupUrl)},active:false})`)]);
    await popup.getByRole("button", { name: "Prepare this job", exact: true }).click();
    await popup.getByText("Queued. C3 will stop at Review.", { exact: true }).waitFor();
    const jobs = await api("jobs", { jobs: pages.map(page => ({ url: page.url(), tabId: tabs.find(t => t.url === page.url())!.id })) });
    const deadline = Date.now() + 180_000;
    while (service.queue.jobs.some(j => ["queued", "running"].includes(j.status)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
    assert.deepEqual(service.queue.jobs.map(j => j.status), Array(count).fill("review"), JSON.stringify(service.queue.snapshot()));
    assert.equal(await worker.evaluate("attached.size"), 0, "Review tabs must release debugger connections");
    assert.equal(verifications, 1);
    for (const page of pages) assert.equal(await page.evaluate("submits"), 0);
    const first = service.queue.jobs[0]!;
    await api(`jobs/${first.id}/action`, { action: "submit", reviewDigest: first.reviewDigest }, 400);
    await pages[0]!.locator('[data-automation-id="formField-"] p').first().evaluate(el => { el.textContent = "Changed by applicant"; });
    await api(`jobs/${first.id}/action`, { action: "submit", confirmed: true, reviewDigest: first.reviewDigest }, 400);
    assert.equal(first.status, "review");
    const reviewedUrl = pages[0]!.url();
    await pages[0]!.evaluate(() => history.pushState(null, "", location.pathname + "-different-job"));
    await api(`jobs/${first.id}/action`, { action: "refresh_review" }, 400);
    await pages[0]!.evaluate(url => history.replaceState(null, "", url), reviewedUrl);
    await api(`jobs/${first.id}/action`, { action: "refresh_review" });
    const simultaneous = await Promise.all([1, 2].map(() => fetch(`${service.origin}/jobs/${first.id}/action`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit", confirmed: true, reviewDigest: first.reviewDigest }),
    })));
    assert.deepEqual(simultaneous.map(r => r.status).sort(), [200, 400]);
    assert.equal(first.status, "submitted");
    assert.equal(await pages[0]!.evaluate("submits"), 1);
    await api(`jobs/${first.id}/action`, { action: "submit", confirmed: true, reviewDigest: first.reviewDigest }, 400);
    assert.equal(await pages[0]!.evaluate("submits"), 1);
    assert.equal((await api("jobs", { jobs: [{ url: pages[1]!.url() + "/apply/applyManually" }] }))[0].id, jobs[1].id);
    const ui = await context.newPage();
    await ui.goto(`${service.origin}/#token=${token}`);
    await ui.getByText("Connected", { exact: true }).waitFor();
    assert.equal(await ui.locator("#jobs li").count(), count);
    assert.equal(await ui.locator('[name="given_name"]').inputValue(), "Synthetic");
    await ui.setViewportSize({ width: 390, height: 844 });
    assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.C3_SCREENSHOT_DIR) {
      await ui.screenshot({ path: join(process.env.C3_SCREENSHOT_DIR, "mobile.png"), fullPage: true });
      await ui.setViewportSize({ width: 1440, height: 1000 });
      await ui.screenshot({ path: join(process.env.C3_SCREENSHOT_DIR, "desktop.png"), fullPage: true });
    }
    console.log(`Verified ${count} simultaneous extension-driven, three-page applications in one browser; no automatic submissions.`);
  } finally { await service.close(); await context.close(); }
});

test("one extension prepares mixed ATS tabs without offering submission", {timeout:90_000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'c3-mixed-'));
  const service=await startProductServer({root});
  const token=readFileSync(service.tokenPath,'utf8');
  const extension=resolve('extension');
  const context=await chromium.launchPersistentContext(join(root,'browser'),{headless:true,channel:"chromium",...(process.env.HUNT_C3_CHROMIUM?{executablePath:process.env.HUNT_C3_CHROMIUM}:{}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const api=async(path:string,body:unknown)=>{const r=await fetch(`${service.origin}/${path}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();};
  try{
    let worker=context.serviceWorkers()[0];for(let i=0;i<100&&!worker;i++){await new Promise(r=>setTimeout(r,100));worker=context.serviceWorkers()[0];}assert.ok(worker);
    await worker.evaluate(`chrome.storage.local.set({token:${JSON.stringify(token)}}).then(()=>connect())`);
    for(let i=0;i<100&&!service.queue.snapshot().connected;i++)await new Promise(r=>setTimeout(r,50));assert.equal(service.queue.snapshot().connected,true);
    await api('settings',{applicant:{given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'},resumeBase64:Buffer.from('%PDF-fixture').toString('base64')});
    const urls=['https://apply.workable.com/fixture/j/ABC123/apply/','https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111/apply','https://job-boards.greenhouse.io/fixture/jobs/123','https://jobs.ashbyhq.com/fixture/11111111-1111-4111-8111-111111111111/application'];
    await context.route(/https:\/\/(jobs.lever.co|job-boards.greenhouse.io|jobs.ashbyhq.com|apply.workable.com)\//,r=>r.fulfill({contentType:'text/html',body:'<label>Name<input required></label><label>Email<input type=email required></label><button onclick="window.submits++">Submit application</button><script>window.submits=0</script>'}));
    const pages=[];const inputs=[];for(const url of urls){const p=await context.newPage();await p.goto(url);pages.push(p);const tab=await worker.evaluate(`chrome.tabs.query({}).then(tabs=>tabs.find(t=>t.url===${JSON.stringify(url)}))`) as {id:number};inputs.push({url,tabId:tab.id});}
    await api('jobs',{jobs:inputs});
    const deadline=Date.now()+60000;while(service.queue.jobs.some(j=>j.status==='queued'||j.status==='running')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
    assert.deepEqual(service.queue.jobs.map(j=>j.status),['review','review','review','review']);
    assert.ok(service.queue.jobs.every(j=>!j.submissionAllowed));
    for(const p of pages){assert.equal(await p.locator('input[type=email]').inputValue(),'fixture@example.invalid');assert.equal(await p.evaluate('submits'),0);}
  }finally{await service.close();await context.close();}
});
