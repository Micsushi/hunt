import assert from "node:assert/strict";
import test from "node:test";
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startProductServer} from '../../src/product/server.ts';
import {applicantProfile} from '../../src/product/sources.ts';
import { genericApplicationTarget } from '../../src/product/target.ts';
import { verifySmartRecruitersApplication } from "../../src/product/smartrecruiters-target.ts";

const company = "Fixture";
const id = "744000123456789";
const uuid = "224c7a1f-105c-4c02-a59a-2f26d92e8239";
const posting = `https://jobs.smartrecruiters.com/${company}/${id}-analyst?oga=true`;
const application = `https://jobs.smartrecruiters.com/oneclick-ui/company/${company}/publication/${uuid}?dcr_ci=${company}`;
const metadata = { id, uuid, company: { identifier: company }, active: true };

test("posting and screening bind only after the local identity and public metadata agree", async t => {
  const localFetch=globalThis.fetch;
  let response: () => Response = () => Response.json(metadata);
  const fetcher = t.mock.method(globalThis, "fetch", async () => response());
  for (const candidate of [
    application.replace("jobs.smartrecruiters.com", "jobs.smartrecruiters.com.evil.example"),
    application.replace("/Fixture/", "/Other/"),
    application.replace(uuid, "not-a-uuid"),
    application + "&dcr_ci=Other",
    application.replace("https://", "https://user@"),
  ]) {
    assert.equal(await verifySmartRecruitersApplication(posting, candidate), false);
  }
  assert.equal(await verifySmartRecruitersApplication(application, posting), false);
  assert.equal(fetcher.mock.callCount(), 0);

  for (const candidate of [
    () => Response.json({ ...metadata, id: "744000999999999" }),
    () => Response.json({ ...metadata, uuid: "11111111-1111-4111-8111-111111111111" }),
    () => Response.json({ ...metadata, company: { identifier: "Other" } }),
    () => Response.json({ ...metadata, active: false }),
    () => new Response("{"),
    () => new Response("x".repeat(256 * 1024 + 1)),
    () => new Response(null, { status: 302 }),
    () => { throw new Error("network unavailable"); },
  ]) {
    response = candidate;
    assert.equal(await verifySmartRecruitersApplication(posting, application), false);
  }
  assert.equal(fetcher.mock.callCount(), 8);

  response = () => Response.json(metadata);
  const screening = application.replace("?", "/screening?");
  assert.equal(genericApplicationTarget(application).key,genericApplicationTarget(screening).key);
  assert.equal(genericApplicationTarget(screening).url,screening);
  assert.equal(await verifySmartRecruitersApplication(posting,screening),true);
  for (const invalid of ["/screening/extra","/done","/screening-old","/SCREENING"]) {
    const other = application.replace("?",invalid+"?");
    assert.throws(() => genericApplicationTarget(other));
    assert.equal(await verifySmartRecruitersApplication(posting,other),false);
  }
  assert.equal(await verifySmartRecruitersApplication(posting,screening.replace(uuid,"11111111-1111-4111-8111-111111111111")),false);
  assert.throws(() => genericApplicationTarget(screening+"&dcr_ci=Other"));

  const root=mkdtempSync(join(tmpdir(),'c3-repair-publication-')), jobId=randomUUID();
  const pdf=Buffer.from('%PDF-original'), input=JSON.stringify({resume:pdf.toString('base64'),
    profile:applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'})});
  writeFileSync(join(root,jobId+'.input.json'),input);
  writeFileSync(join(root,'jobs.json'),JSON.stringify({concurrency:1,jobs:[{...genericApplicationTarget(posting),
    id:jobId,url:'unreadable',title:'Analyst',status:'paused',pageHandoff:true,sourceJobId:97,resumeVersion:'v2',
    resumeSha256:createHash('sha256').update(pdf).digest('hex'),selectedDocument:'previous',selectedApplicationUrl:screening}]}));
  const app=await startProductServer({root,port:0});
  try {
    const repair=()=>localFetch(app.origin+'/repair-saved-link',{method:'POST',headers:{Origin:app.origin,
      Authorization:'Bearer '+readFileSync(app.tokenPath,'utf8'),'Content-Type':'application/json'},body:JSON.stringify({url:posting})});
    response=()=>Response.json({...metadata,uuid:randomUUID()});
    assert.equal((await repair()).status,400);
    assert.equal(app.queue.snapshot().unavailableJobCount,1);
    response=()=>Response.json(metadata);
    assert.equal((await repair()).status,200,'public metadata confirms the saved original ID and OneClick publication');
    const [repaired]=app.queue.jobs;
    assert.equal(repaired?.id,jobId);assert.equal(repaired.status,'paused');assert.equal(repaired.sourceJobId,97);
    assert.equal(repaired.selectedApplicationUrl,undefined);assert.equal(readFileSync(join(root,jobId+'.input.json'),'utf8'),input);
  } finally {await app.close();}
});
