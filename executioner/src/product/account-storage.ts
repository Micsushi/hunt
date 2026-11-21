import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowsDpapiBridge } from '../secrets/windows-dpapi/bridge.ts';
import { approvedSecretRoot } from '../secrets/windows-dpapi/record.ts';
import { writePrivateFileAtomic } from '../composition/private/s2-application-source-preparation.ts';

const entropy = Buffer.from('hunt-c3-product-account-v1');
export const accountStorageFile = (root: string) => join(root, 'account.dpapi');

export async function saveAccount(root: string, account: { email: string; password: string; gmailAppPassword?: string }): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  approvedSecretRoot(root, [resolve(dirname(fileURLToPath(import.meta.url)), '../../..')]);
  const plaintext = Buffer.from(JSON.stringify(account));
  try {
    const sealed = await new WindowsDpapiBridge().protect(plaintext, entropy, AbortSignal.timeout(15_000));
    try { writePrivateFileAtomic(accountStorageFile(root), sealed); }
    finally { sealed.fill(0); }
    return true;
  } catch { throw new Error('Could not encrypt and save the account. Your previous saved account was kept.'); }
  finally { plaintext.fill(0); }
}

export async function loadAccount(root: string): Promise<unknown | undefined> {
  const path = accountStorageFile(root);
  if (!existsSync(path)) return undefined;
  if (process.platform !== 'win32' || statSync(path).size > 16384) throw new Error('Saved account is unavailable.');
  const sealed = readFileSync(path);
  try {
    const plaintext = await new WindowsDpapiBridge().unprotect(sealed, entropy, AbortSignal.timeout(15_000));
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); }
    finally { plaintext.fill(0); }
  } finally { sealed.fill(0); }
}
