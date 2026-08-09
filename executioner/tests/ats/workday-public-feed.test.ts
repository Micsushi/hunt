import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePublicCatalog } from "../../scripts/public-catalog-title.ts";
import {
  buildCandidateCatalogCsv,
  candidateFromPosting,
  discoverCandidateRows,
  parseWorkdayFeed,
  parseWorkdaySource,
  requestWorkdayFeed,
  selectDifferentPosting,
} from "../../scripts/workday-public-feed.ts";

test("Workday source URLs deterministically identify the public jobs feed", () => {
  assert.deepEqual(
    parseWorkdaySource(
      "https://workday.wd5.myworkdayjobs.com/en-US/Workday_Jobs/job/US/Old-Role_JR-1?source=LinkedIn",
    ),
    {
      host: "workday.wd5.myworkdayjobs.com",
      tenant: "workday",
      site: "Workday_Jobs",
      currentPosting: "Old-Role_JR-1",
      feedUrl: "https://workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday_Jobs/jobs",
    },
  );
});

test("feed requests retry transient Workday failures with the exact public payload", async () => {
  const source = parseWorkdaySource("https://acme.wd5.myworkdayjobs.com/Careers/job/US/Old_R1");
  const requests: Array<Readonly<{ url: string; body: string }>> = [];
  const pauses: number[] = [];
  const responses = [
    new Response("", { status: 503 }),
    jsonResponse({ total: 0, jobPostings: [] }),
  ];
  const result = await requestWorkdayFeed(
    source,
    undefined,
    async (url, init) => {
      requests.push({ url, body: String(init.body) });
      return responses.shift()!;
    },
    async (milliseconds) => { pauses.push(milliseconds); },
  );

  assert.deepEqual(result, { total: 0, jobPostings: [] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, source.feedUrl);
  assert.deepEqual(JSON.parse(requests[0]!.body), {
    appliedFacets: {},
    limit: 20,
    offset: 0,
    searchText: "",
  });
  assert.deepEqual(pauses, [500]);
});

test("feed requests retry a transient malformed 200 response", async () => {
  const source = parseWorkdaySource("https://acme.wd5.myworkdayjobs.com/Careers/job/US/Old_R1");
  const pauses: number[] = [];
  const responses = [
    jsonResponse({ total: 1, jobPostings: [{ title: "Broken" }] }),
    jsonResponse({ total: 0, jobPostings: [] }),
  ];
  const result = await requestWorkdayFeed(
    source,
    undefined,
    async () => responses.shift()!,
    async (milliseconds) => { pauses.push(milliseconds); },
  );

  assert.deepEqual(result, { total: 0, jobPostings: [] });
  assert.deepEqual(pauses, [500]);
});

test("feed requests fail closed before retaining an oversized response body", async () => {
  const source = parseWorkdaySource("https://acme.wd5.myworkdayjobs.com/Careers/job/US/Old_R1");
  let requests = 0;
  await assert.rejects(
    requestWorkdayFeed(source, undefined, async () => {
      requests += 1;
      return new Response(`{"padding":"${"x".repeat(1_048_576)}"}`);
    }, async () => {}),
    /body exceeds/u,
  );
  assert.equal(requests, 1);
});

test("feed requests do not retry permanent statuses and exhaust transient statuses", async () => {
  const source = parseWorkdaySource("https://acme.wd5.myworkdayjobs.com/Careers/job/US/Old_R1");
  let permanentRequests = 0;
  let permanentCancellations = 0;
  await assert.rejects(
    requestWorkdayFeed(source, undefined, async () => {
      permanentRequests += 1;
      return errorResponse(404, () => { permanentCancellations += 1; });
    }, async () => {}),
    /HTTP 404/u,
  );
  assert.equal(permanentRequests, 1);
  assert.equal(permanentCancellations, 1);

  let transientRequests = 0;
  let transientCancellations = 0;
  const pauses: number[] = [];
  await assert.rejects(
    requestWorkdayFeed(source, undefined, async () => {
      transientRequests += 1;
      return errorResponse(503, () => { transientCancellations += 1; });
    }, async (milliseconds) => { pauses.push(milliseconds); }),
    /HTTP 503/u,
  );
  assert.equal(transientRequests, 3);
  assert.equal(transientCancellations, 3);
  assert.deepEqual(pauses, [500, 1_000]);
});

test("bulk discovery preserves company order and bounds concurrent feed requests", async () => {
  const rows = [
    { company: "One", link: "https://one.wd5.myworkdayjobs.com/Careers/job/US/Old_R1" },
    { company: "Two", link: "https://two.wd5.myworkdayjobs.com/Jobs/job/US/Old_R1" },
    { company: "Three", link: "https://three.wd5.myworkdayjobs.com/External/job/US/Old_R1" },
  ];
  let active = 0;
  let maximumActive = 0;
  const discovered = await discoverCandidateRows(rows, async (source) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, source.tenant === "one" ? 10 : 1));
    active -= 1;
    return {
      total: 1,
      jobPostings: [{
        title: `${source.tenant} replacement`,
        externalPath: `/job/US/New_R2`,
        locationsText: "United States",
      }],
    };
  }, 2);

  assert.deepEqual(discovered.map((row) => row.company), ["One", "Two", "Three"]);
  assert.equal(maximumActive, 2);
  assert.throws(
    () => discoverCandidateRows(rows, async () => ({ total: 0, jobPostings: [] }), 0),
    /concurrency/u,
  );
  await assert.rejects(
    discoverCandidateRows(rows.slice(0, 1), async () => ({ total: 1, jobPostings: [{
      title: "Old",
      externalPath: "/job/US/Old_R1",
    }] }), 1),
    /no different open posting/u,
  );
  await assert.rejects(
    discoverCandidateRows(rows.slice(0, 1), async () => ({ total: 1, jobPostings: [{ title: "Broken" }] }), 1),
    /One: Workday feed posting 0 is invalid/u,
  );
});

test("bulk discovery cancels sibling feed work after the first failure", async () => {
  const rows = [
    { company: "One", link: "https://one.wd5.myworkdayjobs.com/Careers/job/US/Old_R1" },
    { company: "Two", link: "https://two.wd5.myworkdayjobs.com/Careers/job/US/Old_R1" },
    { company: "Three", link: "https://three.wd5.myworkdayjobs.com/Careers/job/US/Old_R1" },
  ];
  let siblingCancelled = false;
  await assert.rejects(
    discoverCandidateRows(rows, async (source, signal) => {
      if (source.tenant === "one") throw new Error("feed failed");
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          siblingCancelled = true;
          reject(signal.reason);
        }, { once: true });
        setTimeout(resolve, 1_000);
      });
      return { total: 0, jobPostings: [] };
    }, 3),
    /One: feed failed/u,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(siblingCancelled, true);
});

test("Workday feed parsing and selection reject the current posting", () => {
  const source = parseWorkdaySource(
    "https://acme.wd5.myworkdayjobs.com/Careers/job/US/Old-Role_R1",
  );
  const postings = parseWorkdayFeed({
    total: 2,
    jobPostings: [
      {
        title: "Old Role",
        externalPath: "/job/US/Old-Role_R1",
        locationsText: "United States",
        postedOn: "Posted Today",
      },
      {
        title: "C++ Platform Engineer",
        externalPath: "/job/US/C---Platform-Engineer_R2",
        locationsText: "United States",
        postedOn: "Posted Today",
      },
    ],
  });

  const selected = selectDifferentPosting(source, postings);
  assert.equal(selected?.title, "C++ Platform Engineer");
  assert.deepEqual(candidateFromPosting(source, selected!), {
    title: "C++ Platform Engineer",
    link: "https://acme.wd5.myworkdayjobs.com/Careers/job/US/C---Platform-Engineer_R2",
    location: "United States",
  });
  assert.throws(() => parseWorkdayFeed({ total: 1, jobPostings: [{ title: "Broken" }] }), /feed/u);

  assert.equal(selectDifferentPosting(source, [
    { ...postings[1]!, title: "=IMPORTXML(\"https://example.invalid\")" },
    { ...postings[1]!, title: "Safe replacement" },
  ])?.title, "Safe replacement");
});

test("candidate CSV preserves 100-company verifier shape without claiming verification", () => {
  const csv = buildCandidateCatalogCsv([
    {
      company: "Acme, Inc.",
      title: "Engineer, Platform",
      location: "Denver, Colorado",
      link: "https://acme.wd5.myworkdayjobs.com/Careers/job/US/Engineer_R2",
    },
    {
      company: "Beta",
      title: "C# Developer",
      location: "Toronto, Ontario",
      link: "https://beta.wd3.myworkdayjobs.com/Jobs/job/CA/Developer_R3",
    },
  ]);
  const parsed = parsePublicCatalog(csv, 2);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.company, "Acme, Inc.");
  assert.equal(parsed[0]?.expectedTitle, "Engineer, Platform");
  assert.match(csv, /unverified_candidate/u);
  assert.doesNotMatch(csv, /application_entry_reached/u);
  for (const title of ["=1+1", "+SUM(1,1)", "-SUM(1,1)", "-1+2", "@command", "\t=1+1"]) {
    assert.throws(
      () => buildCandidateCatalogCsv([{
        company: "Acme",
        title,
        location: "Denver",
        link: "https://acme.wd5.myworkdayjobs.com/Careers/job/US/Engineer_R2",
      }]),
      /formula-shaped/u,
    );
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, cancelled: () => void): Response {
  return new Response(new ReadableStream({ cancel: cancelled }), { status });
}
