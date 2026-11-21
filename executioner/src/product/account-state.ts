import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { accountStorageFile } from './account-storage.ts';
import { writePrivateFileAtomic } from '../composition/private/s2-application-source-preparation.ts';
import { GmailImapFailure } from '../mailbox/providers/gmail/private/imap-client.ts';

export interface ProductAccount {
  email: string;
  password: string;
  gmailAppPassword?: string;
}

/** Empty password inputs retain saved values only for the same account. */
export function prepareAccountUpdate(value: unknown, previous?: ProductAccount): ProductAccount {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enter an account email and password.');
  const body = value as Record<string, unknown>;
  if (typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ||
      body.password !== undefined && typeof body.password !== 'string' ||
      body.gmailAppPassword !== undefined && typeof body.gmailAppPassword !== 'string') throw new Error('Enter an account email and password.');
  const email = body.email.trim();
  const sameAccount = previous?.email.trim().toLowerCase() === email.toLowerCase();
  const password = (body.password as string | undefined) || (sameAccount ? previous?.password : undefined);
  const gmailAppPassword = (body.gmailAppPassword as string | undefined)?.replace(/\s/g, '') ||
    (sameAccount ? previous?.gmailAppPassword : undefined);
  if (!password || password.length > 1024 || (gmailAppPassword?.length ?? 0) > 1024) throw new Error('Enter an application password for this account.');
  return { email, password, ...(gmailAppPassword ? { gmailAppPassword } : {}) };
}

type GmailStatus = 'missing' | 'untested' | 'verified' | 'failed';
interface Evidence {
  schemaVersion: 1;
  accountBinding: string;
  applicationPasswordSaved: boolean;
  gmailSaved: boolean;
  gmailStatus: GmailStatus;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  error?: string;
}
const safeErrors = new Set(['operation_cancelled', 'gmail_auth_denied', 'gmail_network_unavailable', 'mailbox_query_invalid', 'saved_account_unavailable']);
const validTime = (value: unknown) => value === undefined || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

/** Value-free evidence is bound to the encrypted account, never to a password hash. */
export class ProductAccountState {
  private readonly root: string;
  private evidence?: Evidence;
  private persistenceError?: string;
  private email?: string;

  constructor(root: string) {
    this.root = root;
    const path = join(root, 'account-status.json');
    try {
      if (!existsSync(path) || statSync(path).size > 8192) return;
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Evidence;
      if (saved.schemaVersion !== 1 || typeof saved.accountBinding !== 'string' || !/^[a-f0-9]{64}$/.test(saved.accountBinding) || saved.accountBinding !== this.binding() ||
          typeof saved.applicationPasswordSaved !== 'boolean' || typeof saved.gmailSaved !== 'boolean' ||
          !['missing', 'untested', 'verified', 'failed'].includes(saved.gmailStatus) ||
          !validTime(saved.lastCheckedAt) || !validTime(saved.lastSuccessAt) ||
          saved.error !== undefined && !safeErrors.has(saved.error) ||
          saved.gmailStatus === 'verified' && !saved.lastSuccessAt) return;
      this.evidence = saved;
    } catch { /* Missing or unreadable evidence never establishes verification. */ }
  }

  private binding(): string | undefined {
    const path = accountStorageFile(this.root);
    if (!existsSync(path) || statSync(path).size > 16384) return;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  observeSaved(account: ProductAccount) {
    const binding = this.binding();
    if (!binding) return;
    this.email = account.email;
    const prior = this.evidence?.accountBinding === binding ? this.evidence : undefined;
    this.evidence = { schemaVersion: 1, accountBinding: binding,
      applicationPasswordSaved: !!account.password, gmailSaved: !!account.gmailAppPassword,
      gmailStatus: account.gmailAppPassword ? prior?.gmailStatus ?? 'untested' : 'missing',
      ...(prior?.lastCheckedAt ? { lastCheckedAt: prior.lastCheckedAt } : {}),
      ...(prior?.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {}),
      ...(prior?.error ? { error: prior.error } : {}) };
    this.persist();
  }

  accepted(account: ProductAccount, saved: boolean, gmailVerified: boolean) {
    const now = new Date().toISOString();
    this.email = account.email;
    this.evidence = { schemaVersion: 1, accountBinding: saved ? this.binding() ?? '' : '',
      applicationPasswordSaved: saved && !!account.password, gmailSaved: saved && !!account.gmailAppPassword,
      gmailStatus: gmailVerified ? 'verified' : account.gmailAppPassword ? 'untested' : 'missing',
      ...(gmailVerified ? { lastCheckedAt: now, lastSuccessAt: now } : {}) };
    if (saved) this.persist();
  }

  failed(error: unknown) {
    if (!this.evidence) return;
    this.evidence.gmailStatus = this.evidence.gmailStatus === 'missing' ? 'missing' : 'failed';
    this.evidence.lastCheckedAt = new Date().toISOString();
    this.evidence.error = error instanceof GmailImapFailure ? error.code : 'saved_account_unavailable';
    this.persist();
  }

  snapshot(configured: { accountConfigured: boolean; emailConfigured: boolean }) {
    const savedAccount = existsSync(accountStorageFile(this.root));
    let evidence = this.evidence;
    try { if ((savedAccount || evidence?.accountBinding) && evidence?.accountBinding !== this.binding()) evidence = undefined; }
    catch { evidence = undefined; }
    return { savedAccount, ...(evidence && this.email ? { email: this.email } : {}),
      applicationPassword: { saved: evidence?.applicationPasswordSaved ?? (savedAccount ? null : false),
        configured: configured.accountConfigured, status: 'untested' as const },
      gmail: { saved: evidence?.gmailSaved ?? (savedAccount ? null : false), configured: configured.emailConfigured,
        status: evidence?.gmailStatus ?? (savedAccount ? 'untested' : 'missing'),
        ...(evidence?.lastCheckedAt ? { lastCheckedAt: evidence.lastCheckedAt } : {}),
        ...(evidence?.lastSuccessAt ? { lastSuccessAt: evidence.lastSuccessAt } : {}),
        ...(evidence?.error ? { error: evidence.error } : {}) },
      ...(this.persistenceError ? { evidencePersistenceError: this.persistenceError } : {}) };
  }

  private persist() {
    if (!this.evidence?.accountBinding) return;
    try {
      writePrivateFileAtomic(join(this.root, 'account-status.json'), Buffer.from(JSON.stringify(this.evidence)));
      this.persistenceError = undefined;
    } catch { this.persistenceError = 'The connection result could not be saved. Recheck after restarting C3.'; }
  }
}
