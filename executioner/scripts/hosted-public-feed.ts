import { parseCsvRecords } from "./public-catalog-title.ts";
import { readBoundedJson, ResponseBodyTooLargeError } from "./workday-public-feed.ts";

export type HostedAts = "Greenhouse" | "Lever" | "Ashby";

export type HostedCatalogRow = Readonly<{
  sourceRow: number;
  company: string;
  ats: HostedAts;
  board: string;
  postingId: string;
  link: string;
}>;

export type HostedCandidateRow = Readonly<{
  company: string;
  title: string;
  location: string;
  ats: HostedAts;
  board: string;
  postingId: string;
  link: string;
}>;

export type HostedVerification = Readonly<{
  sourceRow: number;
  ats: HostedAts;
  company: string;
  expectedTitle: string;
  postingId: string;
  matched: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  error: string | null;
}>;

export type HostedPosting = Readonly<{
  title: string;
  location: string;
  postingId: string;
  link: string;
}>;

type FeedRequest = (url: string, init: RequestInit) => Promise<Response>;

const ATS_NAMES = new Set<HostedAts>(["Greenhouse", "Lever", "Ashby"]);

export function parseHostedCatalog(text: string, expectedRows = 100): HostedCatalogRow[] {
  if (!Number.isInteger(expectedRows) || expectedRows < 1) throw new TypeError("expected row count is invalid");
  const records = parseCsvRecords(text);
  const headers = records.shift()?.map((header) => header.trim()) ?? [];
  const prefix = ["company name", "job name", "country", "link"];
  if (!prefix.every((header, index) => headers[index] === header)) {
    throw new TypeError("hosted catalog must preserve the required schema prefix");
  }
  for (const header of ["ats", "posting id", "source board"]) {
    if (!headers.includes(header)) throw new TypeError(`hosted catalog is missing required header: ${header}`);
  }
  if (new Set(headers).size !== headers.length) throw new TypeError("hosted catalog has duplicate headers");
  if (records.length !== expectedRows) throw new TypeError(`hosted catalog row count must be ${expectedRows}`);

  const companyIndex = headers.indexOf("company name");
  const titleIndex = headers.indexOf("job name");
  const linkIndex = headers.indexOf("link");
  const atsIndex = headers.indexOf("ats");
  const postingIdIndex = headers.indexOf("posting id");
  const boardIndex = headers.indexOf("source board");
  const links = new Set<string>();
  const postingIds = new Set<string>();
  const atsNames = new Set<HostedAts>();

  const rows = records.map((cells, index) => {
    if (cells.length !== headers.length) throw new TypeError(`hosted catalog row ${index + 2} has the wrong column count`);
    const company = requiredCell(cells[companyIndex], "company name", index);
    requiredCell(cells[titleIndex], "job name", index);
    const atsValue = requiredCell(cells[atsIndex], "ats", index);
    if (!ATS_NAMES.has(atsValue as HostedAts)) throw new TypeError(`hosted catalog row ${index + 2} has an unsupported ATS`);
    const ats = atsValue as HostedAts;
    const board = requiredCell(cells[boardIndex], "source board", index);
    const postingId = requiredCell(cells[postingIdIndex], "posting id", index);
    const link = requiredCell(cells[linkIndex], "link", index);
    const identity = hostedTargetIdentity(link);
    if (identity.ats !== ats || identity.board !== board || identity.postingId !== postingId) {
      throw new TypeError(`hosted catalog row ${index + 2} does not match its ATS identity`);
    }
    if (links.has(identity.key)) throw new TypeError(`duplicate link at hosted catalog row ${index + 2}`);
    if (postingIds.has(`${ats}:${board}:${postingId}`)) {
      throw new TypeError(`duplicate posting ID at hosted catalog row ${index + 2}`);
    }
    links.add(identity.key);
    postingIds.add(`${ats}:${board}:${postingId}`);
    atsNames.add(ats);
    return { sourceRow: index + 2, company, ats, board, postingId, link };
  });
  if (atsNames.size !== 1) throw new TypeError("hosted catalog must contain exactly one ATS");
  return rows;
}

export async function requestHostedFeed(
  ats: HostedAts,
  board: string,
  request: FeedRequest = fetch,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<HostedPosting[]> {
  const url = hostedFeedUrl(ats, board);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await request(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await pause(500 * (2 ** attempt));
      continue;
    }
    if (response.ok) {
      try {
        return parseHostedFeed(ats, board, await readBoundedJson(response.body, 8_388_608));
      } catch (error) {
        if (error instanceof ResponseBodyTooLargeError) throw error;
        if (attempt === 2) throw error;
        await pause(500 * (2 ** attempt));
        continue;
      }
    }
    await response.body?.cancel().catch(() => {});
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
      throw new Error(`${ats} feed request failed with HTTP ${response.status}`);
    }
    await pause(500 * (2 ** attempt));
  }
  throw new Error(`${ats} feed request exhausted retries`);
}

export async function refreshHostedCatalog(
  rows: readonly HostedCatalogRow[],
  loadFeed: (ats: HostedAts, board: string) => Promise<readonly HostedPosting[]> = requestHostedFeed,
): Promise<HostedCandidateRow[]> {
  const groups = new Map<string, HostedCatalogRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.ats, row.board, row.company]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const replacements = new Map<number, HostedCandidateRow>();
  for (const group of groups.values()) {
    const first = group[0]!;
    const postings = [...await loadFeed(first.ats, first.board)];
    const byId = new Map(postings.map((posting) => [posting.postingId, posting]));
    const used = new Set<string>();
    let next = 0;
    for (const row of group) {
      let posting = byId.get(row.postingId);
      if (posting && used.has(posting.postingId)) posting = undefined;
      while (!posting && next < postings.length) {
        const candidate = postings[next++]!;
        if (!used.has(candidate.postingId)) posting = candidate;
      }
      if (!posting) {
        throw new Error(`${first.company} ${first.ats} feed has fewer than ${group.length} unique current postings`);
      }
      used.add(posting.postingId);
      replacements.set(row.sourceRow, {
        company: row.company,
        title: posting.title,
        location: posting.location,
        ats: row.ats,
        board: row.board,
        postingId: posting.postingId,
        link: posting.link,
      });
    }
  }
  return rows.map((row) => replacements.get(row.sourceRow)!);
}

export function buildHostedCatalogCsv(rows: readonly HostedCandidateRow[]): string {
  const header = [
    "company name", "job name", "country", "link", "ats", "posting id",
    "source board", "test status", "last verified", "notes",
  ];
  const records = rows.map((row) => [
    row.company,
    row.title,
    "Not recorded",
    row.link,
    row.ats,
    row.postingId,
    row.board,
    "unverified_candidate",
    "",
    `Discovered from the official ${row.ats} public feed; listed location: ${row.location}; run URL verification before use.`,
  ]);
  return `${[header, ...records].map((record) => record.map(csvCell).join(",")).join("\n")}\n`;
}

export async function verifyHostedCatalog(
  rows: readonly HostedCandidateRow[],
  concurrency = 5,
  request: FeedRequest = fetch,
): Promise<HostedVerification[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new TypeError("verification concurrency must be between 1 and 12");
  }
  const results = new Array<HostedVerification>(rows.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++;
      const row = rows[index]!;
      let response: Response | undefined;
      let finalUrl: string | null = null;
      let error: string | null = null;
      let matched = false;
      try {
        response = await request(row.link, {
          headers: { accept: "text/html" },
          redirect: "follow",
          signal: AbortSignal.timeout(30_000),
        });
        finalUrl = response.url || row.link;
        matched = response.status === 200
          && hostedTargetIdentity(finalUrl).key === hostedTargetIdentity(row.link).key;
      } catch (caught) {
        error = String(caught instanceof Error ? caught.message : caught).slice(0, 500);
      } finally {
        await response?.body?.cancel().catch(() => {});
      }
      results[index] = {
        sourceRow: index + 2,
        ats: row.ats,
        company: row.company,
        expectedTitle: row.title,
        postingId: row.postingId,
        matched,
        httpStatus: response?.status ?? null,
        finalUrl,
        error,
      };
    }
  });
  await Promise.all(workers);
  return results;
}

function parseHostedFeed(ats: HostedAts, board: string, value: unknown): HostedPosting[] {
  const raw = ats === "Lever"
    ? value
    : isRecord(value) ? value.jobs : undefined;
  if (!Array.isArray(raw)) throw new TypeError(`${ats} feed response is invalid`);
  const postings: HostedPosting[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || (ats === "Ashby" && item.isListed === false)) continue;
    const postingId = String(item.id ?? "").trim();
    const title = String(ats === "Lever" ? item.text ?? "" : item.title ?? "").trim();
    const link = String(ats === "Greenhouse" ? item.absolute_url ?? "" : ats === "Lever" ? item.hostedUrl ?? "" : item.jobUrl ?? "").trim();
    const location = ats === "Lever"
      ? isRecord(item.categories) ? String(item.categories.location ?? "Not recorded").trim() : "Not recorded"
      : ats === "Greenhouse"
        ? isRecord(item.location) ? String(item.location.name ?? "Not recorded").trim() : "Not recorded"
        : String(item.location ?? "Not recorded").trim();
    if (!postingId || !title || !link || isFormulaShaped(title)) continue;
    try {
      const identity = hostedTargetIdentity(link);
      if (identity.ats !== ats || identity.board !== board || identity.postingId !== postingId || seen.has(identity.key)) continue;
      seen.add(identity.key);
      postings.push({ title, location: location || "Not recorded", postingId, link });
    } catch {
      // Custom career-site links are not ATS-pure catalog candidates.
    }
  }
  return postings;
}

function hostedFeedUrl(ats: HostedAts, board: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/u.test(board)) throw new TypeError("hosted ATS board is invalid");
  if (ats === "Greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs`;
  if (ats === "Lever") return `https://api.lever.co/v0/postings/${board}?mode=json`;
  return `https://api.ashbyhq.com/posting-api/job-board/${board}`;
}

function hostedTargetIdentity(value: string): Readonly<{
  ats: HostedAts;
  board: string;
  postingId: string;
  key: string;
}> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("hosted catalog link is unsafe");
  }
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  let ats: HostedAts;
  let board: string;
  let postingId: string;
  if (["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname)) {
    if (segments.length !== 3 || segments[1] !== "jobs") throw new TypeError("Greenhouse link is invalid");
    [board, , postingId] = segments as [string, string, string];
    ats = "Greenhouse";
  } else if (url.hostname === "jobs.lever.co") {
    if (segments.length !== 2) throw new TypeError("Lever link is invalid");
    [board, postingId] = segments as [string, string];
    ats = "Lever";
  } else if (url.hostname === "jobs.ashbyhq.com") {
    if (segments.length !== 2) throw new TypeError("Ashby link is invalid");
    [board, postingId] = segments as [string, string];
    ats = "Ashby";
  } else throw new TypeError("hosted catalog link is not on an admitted ATS host");
  if (!board || !postingId) throw new TypeError("hosted catalog link has no posting identity");
  return { ats, board, postingId, key: JSON.stringify([ats, board, postingId]) };
}

function requiredCell(value: string | undefined, name: string, rowIndex: number): string {
  const result = value?.trim() ?? "";
  if (!result) throw new TypeError(`hosted catalog row ${rowIndex + 2} has an empty ${name}`);
  if (isFormulaShaped(result)) throw new TypeError(`hosted catalog row ${rowIndex + 2} has a formula-shaped ${name}`);
  return result;
}

function csvCell(value: string): string {
  if (isFormulaShaped(value)) throw new TypeError("hosted candidate CSV contains a formula-shaped value");
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function isFormulaShaped(value: string): boolean {
  return /^\s*[=+\-@]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
