import { createHash } from 'node:crypto';
import { applicationTarget } from './target.ts';
import type { ProductJob } from './queue.ts';

export const handoffMaxBytes = 32 * 1024 * 1024;
export interface HandoffJob {
  url: string; title: string; sourceJobId: number; resumeName: string;
  resumeVersion: string; resumeBase64: string; resumeSha256: string;
}

/** A file is an owner-selected snapshot, not a signed claim about current server state. */
export function inspectHandoffBundle(value: unknown, existing: readonly ProductJob[]) {
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
    const job = entry as unknown as HandoffJob, target = applicationTarget(job.url);
    if (keys.has(target.key) || ids.has(job.sourceJobId)) throw new Error('The application bundle contains duplicate jobs. Export each application once.');
    keys.add(target.key); ids.add(job.sourceJobId);
    const pdf = Buffer.from(job.resumeBase64,'base64');
    if (pdf.length > 5 * 1024 * 1024 || pdf.subarray(0,5).toString() !== '%PDF-' || pdf.toString('base64') !== job.resumeBase64 ||
        createHash('sha256').update(pdf).digest('hex') !== job.resumeSha256) throw new Error('A bundled PDF is invalid or its checksum does not match. Export the bundle again.');
    const current = existing.find(item=>item.status !== 'removed' && item.key === target.key);
    if (current && (current.resumeSha256 !== job.resumeSha256 ||
        current.sourceJobId !== undefined && current.sourceJobId !== job.sourceJobId ||
        current.resumeVersion !== undefined && current.resumeVersion !== job.resumeVersion)) {
      throw new Error('An existing application has a different job or resume version. Pause and remove its queue entry before importing the new selection.');
    }
    return job;
  });
  const preview = jobs.map(({resumeBase64: _pdf,...job})=>({ ...job,
    status: existing.some(item=>item.status !== 'removed' && item.key === applicationTarget(job.url).key) ? 'existing' as const : 'new' as const,
  }));
  return { jobs, preview };
}
