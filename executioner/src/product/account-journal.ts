import type { WorkdayPageObservation } from '../ats/workday/page-observation.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writePrivateFileAtomic } from '../composition/private/s2-application-source-preparation.ts';

export type AccountEvent = 'page_observed' | 'employer_recovery_started' | 'sign_in_fields_started' | 'sign_in_attempted' | 'sign_in_diagnostic' | 'sign_in_transition_observed' | 'sign_in_rejected' |
  'sign_in_uncertain' | 'application_opened' | 'creation_blocked' | 'reset_blocked' |
  'verification_blocked' | 'sign_in_fields_failed' | 'creation_fields_started' | 'creation_attempted' |
  'creation_uncertain' | 'account_exists' | 'verification_started' | 'verification_link_opened' | 'creation_terms_attempted';

/** Prevent duplicate registration after an uncertain result, including across restarts. */
export function employerAccountPolicy(root: string, url: string, email: string) {
  const key = createHash('sha256').update(new URL(url).origin + '\n' + email.trim().toLowerCase()).digest('hex');
  const directory = join(root, 'employer-accounts');
  const path = join(directory, `${key}.json`);
  const read = () => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as {status:string;updatedAt:string} : undefined;
  const previous = read();
  return {preferCreate:previous === undefined, verificationSince:previous?.status==='creation_pending' ? Date.parse(previous.updatedAt) : undefined, record(event:AccountEvent) {
    if (!['creation_attempted','account_exists','sign_in_transition_observed'].includes(event)) return;
    if (event === 'creation_attempted' && read() !== undefined) throw new Error('Account creation was already attempted for this employer. Inspect the account before retrying.');
    mkdirSync(directory, {recursive:true,mode:0o700});
    writePrivateFileAtomic(path, Buffer.from(JSON.stringify({schemaVersion:1,status:event==='creation_attempted'?'creation_pending':'existing',updatedAt:new Date().toISOString()})));
  }};
}

/** One immutable run identity, with atomic snapshots. No page values or raw errors. */
export function accountJournal(root: string, jobId: string, runId: string) {
  const directory = join(root, 'account-actions', jobId);
  const events: { sequence: number; at: string; event: AccountEvent; trace?: string; observation?: WorkdayPageObservation }[] = [];
  return (event: AccountEvent, trace?: string, observation?: WorkdayPageObservation) => {
    if (!["page_observed","employer_recovery_started","sign_in_fields_started","sign_in_attempted","sign_in_diagnostic","sign_in_transition_observed","sign_in_rejected","sign_in_uncertain","application_opened","creation_blocked","reset_blocked","verification_blocked","sign_in_fields_failed","creation_fields_started","creation_attempted","creation_uncertain","account_exists","verification_started","verification_link_opened","creation_terms_attempted"].includes(event)) throw new Error("Invalid account event.");
    // Trace comes only from the account adapter's fixed catalog, never page text.
    if (trace !== undefined && !/^submit_[a-z_]{1,80}$/.test(trace)) throw new Error('Invalid account diagnostic.');
    if (events.length >= 512) throw new Error('Account diagnostic limit reached.');
    if (observation && (observation.version !== 'workday-page-v1' || !/^[a-z_]{1,40}$/.test(observation.kind) ||
      !/^[0-9.]{1,30}$/.test(observation.documentKey) || observation.documentId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(observation.documentId) || [...observation.signals,...observation.conflicts].some(value=>!/^[a-z_]{1,80}$/.test(value)))) throw new Error('Invalid page observation.');
    const safeObservation = observation && {version:observation.version,kind:observation.kind,documentKey:observation.documentKey,
      ...(observation.documentId?{documentId:observation.documentId}:{}),signals:[...observation.signals],conflicts:[...observation.conflicts]};
    const next = [...events, { sequence: events.length + 1, at: new Date().toISOString(), event, ...(trace ? {trace} : {}), ...(safeObservation ? {observation:safeObservation} : {}) }];
    mkdirSync(directory, {recursive: true, mode: 0o700});
    writePrivateFileAtomic(join(directory, `${runId}.json`), Buffer.from(JSON.stringify({schemaVersion:1, jobId, runId, policy:'create_if_unknown_then_sign_in', events:next})));
    events.push(next[next.length - 1]!);
  };
}
