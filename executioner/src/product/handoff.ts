import { createHash } from 'node:crypto';
import { applicationTarget, canonicalPostingKey, productApplicationTarget } from './target.ts';
import { smartRecruitersPostingForApplication, smartRecruitersPublication } from './smartrecruiters-target.ts';
import type { ProductJob } from './queue.ts';

export const handoffMaxBytes = 32 * 1024 * 1024;
// Do not send a default PDF where an ambiguous spelling could identify a saved draft.
function possiblePostingAlias(key: string): string {
  return canonicalPostingKey(key).toLowerCase().replace(/^ats\.us1\.rippling\.com\//u, 'ats.rippling.com/');
}

export interface HandoffJob {
  url: string; title: string; sourceJobId: number; resumeName: string;
  resumeVersion: string; resumeBase64: string; resumeSha256: string;
}

/** A file is an owner-selected snapshot, not a signed claim about current server state. */
export function inspectHandoffBundle(value: unknown, existing: readonly ProductJob[], allowCurrentPage = false) {
  const parseTarget = allowCurrentPage ? productApplicationTarget : applicationTarget;
  const object = (entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry);
  const exactKeys = (entry: Record<string, unknown>, keys: string[]) => Object.keys(entry).length === keys.length && keys.every(key=>Object.hasOwn(entry,key));
  if (!object(value) || !exactKeys(value,['format','version','jobs']) || value.format !== 'hunt-c3-handoff' || value.version !== 1 ||
      !Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > 30) throw new Error('Choose a supported Hunt application bundle with 1 to 30 jobs.');
  if (Buffer.byteLength(JSON.stringify(value)) > handoffMaxBytes) throw new Error('This application bundle is too large. Export fewer jobs at once.');
  const keys = new Set<string>(), ids = new Set<number>();
  const jobs = value.jobs.map((entry): HandoffJob => {
    if (!object(entry) || !exactKeys(entry,['url','title','sourceJobId','resumeName','resumeVersion','resumeBase64','resumeSha256']) ||
        typeof entry.url !== 'string' || !Number.isSafeInteger(entry.sourceJobId) || Number(entry.sourceJobId) < 1 ||
        ['title','resumeName','resumeVersion'].some(key=>typeof entry[key] !== 'string' || !(entry[key] as string).trim() || (entry[key] as string).length > 500) ||
        typeof entry.resumeBase64 !== 'string' || typeof entry.resumeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.resumeSha256)) {
      throw new Error('The application bundle contains invalid job or resume details. Export it again from Hunt.');
    }
    const job = entry as unknown as HandoffJob;
    let target: ReturnType<typeof productApplicationTarget>;
    try { target = parseTarget(job.url); }
    catch { throw new Error(`Job ${job.sourceJobId} cannot be queued. Export the supported jobs again and use Fill current page for this job.`); }
    if (existing.some(item=>item.status !== 'removed' && canonicalPostingKey(item.key) !== target.key &&
        possiblePostingAlias(item.key) === possiblePostingAlias(target.key))) throw new Error('This link resembles a saved posting. Use the exact saved link.');
    if (keys.has(possiblePostingAlias(target.key)) || ids.has(job.sourceJobId)) throw new Error('The application bundle contains duplicate jobs. Export each application once.');
    keys.add(possiblePostingAlias(target.key)); ids.add(job.sourceJobId);
    const pdf = Buffer.from(job.resumeBase64,'base64');
    if (pdf.length > 5 * 1024 * 1024 || pdf.subarray(0,5).toString() !== '%PDF-' || pdf.toString('base64') !== job.resumeBase64 ||
        createHash('sha256').update(pdf).digest('hex') !== job.resumeSha256) throw new Error('A bundled PDF is invalid or its checksum does not match. Export the bundle again.');
    const current = existing.find(item=>item.status !== 'removed' && canonicalPostingKey(item.key) === target.key);
    if (existing.some(item => item.status !== 'removed' && item.sourceJobId === job.sourceJobId && canonicalPostingKey(item.key) !== target.key)) {
      throw new Error('The selected Hunt job already belongs to a different application link.');
    }
    if (target.ats === 'generic' && current && !current.pageHandoff) throw new Error('Finish the existing saved draft manually to preserve its selected resume.');
    if (current && (current.resumeSha256 !== job.resumeSha256 ||
        current.sourceJobId !== undefined && current.sourceJobId !== job.sourceJobId ||
        current.resumeVersion !== undefined && current.resumeVersion !== job.resumeVersion)) {
      throw new Error('An existing application has a different job or resume version. Pause and remove its queue entry before importing the new selection.');
    }
    return job;
  });
  const preview = jobs.map(({resumeBase64: _pdf,...job})=>({ ...job,
    ...(parseTarget(job.url).ats === 'generic' && {currentPageOnly:true}),
    status: existing.some(item=>item.status !== 'removed' && canonicalPostingKey(item.key) === parseTarget(job.url).key) ? 'existing' as const : 'new' as const,
  }));
  return { jobs, preview };
}

export async function currentPageOwner(jobs: ProductJob[], tabId: number, url: URL) {
  let key: string | undefined;
  try { key = productApplicationTarget(url.href).key; } catch { /* Ordinary page fill also supports unfamiliar HTTPS pages. */ }
  const publication = smartRecruitersPublication(new URL(url.pathname, url.origin));
  const current = jobs.filter(job => job.status !== 'removed');
  if (key && current.some(job => canonicalPostingKey(job.key) !== key && possiblePostingAlias(job.key) === possiblePostingAlias(key!))) {
    throw new Error('This page resembles a saved posting. Open the exact job link from Applications to preserve its resume.');
  }
  const owners = current.filter(job => {
    const selected = job.selectedApplicationUrl && smartRecruitersPublication(new URL(job.selectedApplicationUrl));
    return job.tabId === tabId || canonicalPostingKey(job.key) === key ||
      publication && selected && publication.base.toLowerCase() === selected.base.toLowerCase();
  });
  if (publication) {
    const prefix = url.hostname + '/' + publication.company.toLowerCase() + '/';
    const candidates = current.filter(job => !owners.includes(job) && job.key.toLowerCase().startsWith(prefix) &&
      /^[0-9]+$/.test(job.key.slice(prefix.length)));
    if (candidates.length) {
      const posting = await smartRecruitersPostingForApplication(url.href);
      if (!posting) throw new Error('C3 could not verify which saved job owns this application. Open it from Applications.');
      const postingKey = productApplicationTarget(posting).key.toLowerCase();
      owners.push(...candidates.filter(job => job.key.toLowerCase() === postingKey));
    }
  }
  if (owners.length > 1) throw new Error('This tab and application identify different saved jobs. Reopen the selected posting.');
  return owners[0];
}
