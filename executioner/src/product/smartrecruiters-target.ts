const jobsHost = "jobs.smartrecruiters.com";
const postingApi = "https://api.smartrecruiters.com";
/** Only the personal and screening pages identify the same verified OneClick publication. */
export function smartRecruitersPublication(url:URL) {
  if (url.origin !== "https://jobs.smartrecruiters.com" || url.username || url.password || url.port) return;
  const path = url.pathname.replace(/\/$/, "");
  const screening = path.endsWith("/screening");
  const base = screening ? path.slice(0, -"/screening".length) : path;
  const match = /^\/oneclick-ui\/company\/([\w-]+)\/publication\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(base);
  if (!match || url.searchParams.getAll("dcr_ci").some(value => value !== match[1])) return;
  return {base,company:match[1]!,uuid:match[2]!,screening};
}

function jobUrl(input: string): URL | undefined {
  try {
    const url = new URL(input);
    if (url.protocol === "https:" && url.hostname === jobsHost &&
        !url.username && !url.password && !url.port) return url;
  } catch { /* An invalid URL does not establish posting identity. */ }
}

/** Confirm the exact public posting ID behind an already-open application. */
export async function verifySmartRecruitersApplication(
  postingUrl: string,
  applicationUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const posting = jobUrl(postingUrl);
  const application = jobUrl(applicationUrl);
  if (!posting || !application) return false;
  const source = /^\/([\w-]+)\/(\d+)(?:-[\w-]+)?\/?$/.exec(posting.pathname);
  const destination = smartRecruitersPublication(application);
  if (!source || !destination) return false;
  const [, company, id] = source;
  const {company:applicationCompany,uuid:applicationUuid} = destination;
  if (company !== applicationCompany) return false;

  const timeout = AbortSignal.timeout(5000);
  try {
    const response = await fetch(`${postingApi}/v1/companies/${company}/postings/${id}`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok || !response.body) return false;
    // Only a small public metadata response can establish the binding.
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) {
          await reader.cancel();
          return false;
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const record = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: unknown;
      uuid?: unknown;
      active?: unknown;
      company?: { identifier?: unknown };
    } | null;
    return record !== null && record.id === id && record.company?.identifier === company && record.active === true &&
      typeof record.uuid === "string" && record.uuid.toLowerCase() === applicationUuid!.toLowerCase();
  } catch {
    return false;
  }
}
