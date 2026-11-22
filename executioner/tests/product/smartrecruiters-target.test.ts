import assert from "node:assert/strict";
import test from "node:test";
import { genericApplicationTarget } from '../../src/product/target.ts';
import { verifySmartRecruitersApplication } from "../../src/product/smartrecruiters-target.ts";

const company = "Fixture";
const id = "744000123456789";
const uuid = "224c7a1f-105c-4c02-a59a-2f26d92e8239";
const posting = `https://jobs.smartrecruiters.com/${company}/${id}-analyst?oga=true`;
const application = `https://jobs.smartrecruiters.com/oneclick-ui/company/${company}/publication/${uuid}?dcr_ci=${company}`;
const metadata = { id, uuid, company: { identifier: company }, active: true };

test("invalid host, company, UUID, and conflicting tenant query never reach the public API", async t => {
  const fetcher = t.mock.method(globalThis, "fetch", async () => Response.json(metadata));
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
});

test("unrelated, inactive, malformed, oversized and failed API responses cannot establish a binding", async t => {
  let response: () => Response = () => Response.json(metadata);
  const fetcher = t.mock.method(globalThis, "fetch", async () => response());
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
});

test("only the exact screening route shares the verified publication identity", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json(metadata));
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
});
