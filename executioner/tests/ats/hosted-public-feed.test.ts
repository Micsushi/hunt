import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHostedCatalogCsv,
  type HostedCandidateRow,
  parseHostedCatalog,
  refreshHostedCatalog,
  requestHostedFeed,
  verifyHostedCatalog,
} from "../../scripts/hosted-public-feed.ts";

const header = "company name,job name,country,link,ats,posting id,source board,test status,last verified,notes\n";

test("hosted catalog parsing admits repeated companies but rejects mixed or mismatched ATS identities", () => {
  const csv = header
    + row("Cloudflare", "Engineer", "https://boards.greenhouse.io/cloudflare/jobs/1", "Greenhouse", "1", "cloudflare")
    + row("Cloudflare", "Analyst", "https://job-boards.greenhouse.io/cloudflare/jobs/2", "Greenhouse", "2", "cloudflare");
  const parsed = parseHostedCatalog(csv, 2);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]?.company, "Cloudflare");
  assert.throws(
    () => parseHostedCatalog(csv.replace(",Greenhouse,2,", ",Lever,2,"), 2),
    /ATS identity/u,
  );
  assert.throws(
    () => parseHostedCatalog(csv.replace("/jobs/2", "/jobs/1").replace(",2,cloudflare", ",1,cloudflare"), 2),
    /duplicate/u,
  );
});

test("hosted refresh preserves current postings and replaces only stale slots within each company board", async () => {
  const source = parseHostedCatalog(
    header
      + row("PointClickCare", "Current", "https://jobs.lever.co/pointclickcare/current", "Lever", "current", "pointclickcare")
      + row("PointClickCare", "Closed", "https://jobs.lever.co/pointclickcare/closed", "Lever", "closed", "pointclickcare")
      + row("Other Co", "Old", "https://jobs.lever.co/other/old", "Lever", "old", "other"),
    3,
  );
  const refreshed = await refreshHostedCatalog(source, async (_ats, board) => board === "pointclickcare" ? [
    posting("Current title", "current", "https://jobs.lever.co/pointclickcare/current"),
    posting("Replacement", "new", "https://jobs.lever.co/pointclickcare/new"),
  ] : [posting("Other replacement", "new-other", "https://jobs.lever.co/other/new-other")]);

  assert.deepEqual(refreshed.map((candidate) => candidate.postingId), ["current", "new", "new-other"]);
  assert.equal(refreshed[0]?.title, "Current title");
  assert.equal(parseHostedCatalog(buildHostedCatalogCsv(refreshed), 3).length, 3);
});

test("official hosted feed adapters validate all providers and hosted URL verification fails closed", async () => {
  const fixtures = {
    Greenhouse: {
      jobs: [{ id: 1, title: "Engineer", absolute_url: "https://boards.greenhouse.io/cloudflare/jobs/1", location: { name: "Remote" } }],
    },
    Lever: [{ id: "2", text: "Analyst", hostedUrl: "https://jobs.lever.co/pointclickcare/2", categories: { location: "Toronto" } }],
    Ashby: {
      jobs: [{ id: "3", title: "Designer", jobUrl: "https://jobs.ashbyhq.com/notion/3", location: "New York", isListed: true }],
    },
  } as const;
  const boards = { Greenhouse: "cloudflare", Lever: "pointclickcare", Ashby: "notion" } as const;
  for (const ats of ["Greenhouse", "Lever", "Ashby"] as const) {
    const postings = await requestHostedFeed(ats, boards[ats], async () => jsonResponse(fixtures[ats]), async () => {});
    assert.equal(postings.length, 1);
  }
  const largeLeverFeed = [{
    ...fixtures.Lever[0],
    description: "x".repeat(1_100_000),
  }];
  assert.equal(
    (await requestHostedFeed("Lever", "pointclickcare", async () => jsonResponse(largeLeverFeed), async () => {})).length,
    1,
  );

  const candidate: HostedCandidateRow = {
    company: "Notion",
    title: "Designer",
    location: "New York",
    ats: "Ashby",
    board: "notion",
    postingId: "3",
    link: "https://jobs.ashbyhq.com/notion/3",
  };
  const matched = await verifyHostedCatalog([candidate], 1, async () => responseWithUrl(200, candidate.link));
  const redirected = await verifyHostedCatalog([candidate], 1, async () => responseWithUrl(200, "https://jobs.ashbyhq.com/notion/4"));
  assert.equal(matched[0]?.matched, true);
  assert.equal(redirected[0]?.matched, false);
  await assert.rejects(
    refreshHostedCatalog([
      { sourceRow: 2, company: "Tiny", ats: "Lever", board: "tiny", postingId: "closed", link: "https://jobs.lever.co/tiny/closed" },
    ], async () => []),
    /fewer than 1/u,
  );
});

function row(company: string, title: string, link: string, ats: string, postingId: string, board: string): string {
  return `${company},${title},Not recorded,${link},${ats},${postingId},${board},unverified_candidate,,\n`;
}

function posting(title: string, postingId: string, link: string) {
  return { title, location: "Not recorded", postingId, link };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function responseWithUrl(status: number, url: string): Response {
  const response = new Response("", { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
