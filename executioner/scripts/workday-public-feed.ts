export type WorkdayFeedSource = Readonly<{
  host: string;
  tenant: string;
  site: string;
  currentPosting: string;
  feedUrl: string;
}>;

export type WorkdayFeedPosting = Readonly<{
  title: string;
  externalPath: string;
  locationsText: string;
  postedOn: string;
}>;

export type CandidateCatalogRow = Readonly<{
  company: string;
  title: string;
  location: string;
  link: string;
}>;

type FeedResponse = Readonly<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}>;

type FeedRequest = (url: string, init: RequestInit) => Promise<FeedResponse>;

export async function requestWorkdayFeed(
  source: WorkdayFeedSource,
  cancellation?: AbortSignal,
  request: FeedRequest = fetch,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<unknown> {
  const body = JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: FeedResponse;
    try {
      response = await request(source.feedUrl, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body,
        redirect: "error",
        signal: cancellation
          ? AbortSignal.any([cancellation, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (cancellation?.aborted) throw cancellation.reason ?? error;
      if (attempt === 2) throw error;
      await pause(500 * (2 ** attempt));
      continue;
    }
    if (response.ok) {
      try {
        const value = await readBoundedJson(response.body);
        parseWorkdayFeed(value);
        return value;
      } catch (error) {
        if (error instanceof ResponseBodyTooLargeError) throw error;
        if (attempt === 2) throw error;
        await pause(500 * (2 ** attempt));
        continue;
      }
    }
    await cancelResponseBody(response.body);
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
      throw new Error(`Workday feed request failed with HTTP ${response.status}`);
    }
    await pause(500 * (2 ** attempt));
  }
  throw new Error("Workday feed request exhausted retries");
}

export function discoverCandidateRows(
  rows: readonly Readonly<{ company: string; link: string }>[],
  loadFeed: (source: WorkdayFeedSource, signal: AbortSignal) => Promise<unknown>,
  concurrency = 5,
): Promise<CandidateCatalogRow[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new TypeError("discovery concurrency must be between 1 and 5");
  }
  return discover();

  async function discover(): Promise<CandidateCatalogRow[]> {
    const results = new Array<CandidateCatalogRow>(rows.length);
    const cancellation = new AbortController();
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (!cancellation.signal.aborted && nextIndex < rows.length) {
        const index = nextIndex;
        nextIndex += 1;
        const row = rows[index]!;
        try {
          const source = parseWorkdaySource(row.link);
          const posting = selectDifferentPosting(
            source,
            parseWorkdayFeed(await loadFeed(source, cancellation.signal)),
          );
          if (!posting) throw new Error("no different open posting found");
          results[index] = { company: row.company, ...candidateFromPosting(source, posting) };
        } catch (error) {
          const reason = error instanceof Error ? error.message : "discovery failed";
          const failure = new Error(`${row.company}: ${reason}`);
          cancellation.abort(failure);
          throw failure;
        }
      }
    });
    await Promise.all(workers);
    return results;
  }
}

export function parseWorkdaySource(value: string): WorkdayFeedSource {
  const url = new URL(value);
  const host = url.hostname.toLocaleLowerCase("en-US");
  const hostMatch = /^([a-z0-9-]+)\.wd[0-9]+\.myworkdayjobs\.com$/u.exec(host);
  if (url.protocol !== "https:" || !hostMatch || url.username || url.password || url.hash) {
    throw new TypeError("source is not an admitted Workday job URL");
  }
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  const jobIndex = segments.lastIndexOf("job");
  if (jobIndex < 1 || jobIndex >= segments.length - 1) {
    throw new TypeError("source has no Workday posting identity");
  }
  const tenant = hostMatch[1]!;
  const site = segments[jobIndex - 1]!;
  const currentPosting = segments.at(-1)!;
  const feedUrl = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`;
  return { host, tenant, site, currentPosting, feedUrl };
}

export function parseWorkdayFeed(value: unknown): WorkdayFeedPosting[] {
  if (!isRecord(value) || !Number.isSafeInteger(value.total) || (value.total as number) < 0 || !Array.isArray(value.jobPostings)) {
    throw new TypeError("Workday feed response is invalid");
  }
  return value.jobPostings.map((posting, index) => {
    if (
      !isRecord(posting)
      || typeof posting.title !== "string"
      || posting.title.trim().length === 0
      || typeof posting.externalPath !== "string"
      || !/^\/job\/[^?#]+$/u.test(posting.externalPath)
      || posting.externalPath.includes("\n")
      || posting.externalPath.includes("\r")
      || (posting.locationsText !== undefined && typeof posting.locationsText !== "string")
      || (posting.postedOn !== undefined && typeof posting.postedOn !== "string")
    ) {
      throw new TypeError(`Workday feed posting ${index} is invalid`);
    }
    return {
      title: posting.title.trim(),
      externalPath: posting.externalPath,
      locationsText: posting.locationsText?.trim() || "Not recorded",
      postedOn: posting.postedOn?.trim() || "Not recorded",
    };
  });
}

export function selectDifferentPosting(
  source: WorkdayFeedSource,
  postings: readonly WorkdayFeedPosting[],
): WorkdayFeedPosting | undefined {
  return postings.find((posting) =>
    postingIdentity(posting.externalPath) !== source.currentPosting
    && !isFormulaShaped(posting.title));
}

export function candidateFromPosting(
  source: WorkdayFeedSource,
  posting: WorkdayFeedPosting,
): Readonly<{ title: string; link: string; location: string }> {
  return {
    title: posting.title,
    link: `https://${source.host}/${encodeURIComponent(source.site)}${posting.externalPath}`,
    location: posting.locationsText,
  };
}

export function buildCandidateCatalogCsv(rows: readonly CandidateCatalogRow[]): string {
  const header = [
    "company name",
    "job name",
    "country",
    "link",
    "test status",
    "observed account flow",
    "last tested",
    "notes",
  ];
  const records = rows.map((row) => [
    row.company,
    row.title,
    "Not recorded",
    row.link,
    "unverified_candidate",
    "",
    "",
    `Discovered from Workday public jobs feed; listed location: ${row.location}; run strict verifier before use.`,
  ]);
  return `${[header, ...records].map((record) => record.map(csvCell).join(",")).join("\n")}\n`;
}

function postingIdentity(externalPath: string): string {
  const segments = externalPath.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments[0] !== "job" || segments.length < 2) throw new TypeError("Workday external path is invalid");
  return segments.at(-1)!;
}

function csvCell(value: string): string {
  if (isFormulaShaped(value)) {
    throw new TypeError("candidate CSV contains a formula-shaped value");
  }
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export class ResponseBodyTooLargeError extends Error {}

export async function readBoundedJson(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes = 1_048_576,
): Promise<unknown> {
  if (!body) throw new TypeError("Workday feed response has no body");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximum response body size is invalid");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new ResponseBodyTooLargeError(`Workday feed response body exceeds ${maximumBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // HTTP status remains authoritative when response cleanup fails.
  }
}

function isFormulaShaped(value: string): boolean {
  return /^\s*[=+\-@]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
