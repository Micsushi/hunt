import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProductServer } from '../../src/product/server.ts';
import { GmailImapClient, GmailImapFailure } from '../../src/mailbox/providers/gmail/private/imap-client.ts';
import { accountStorageFile, loadAccount } from '../../src/product/account-storage.ts';

test('account setup verifies Gmail and preserves a working account when replacement fails', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hunt-gmail-check-'));
  let service = await startProductServer({ root, port: 47863 });
  try {
    const check = t.mock.method(GmailImapClient.prototype, 'checkConnection', async () => {});
    const headers = { Authorization: `Bearer ${readFileSync(service.tokenPath, 'utf8').trim()}`, 'Content-Type': 'application/json' };
    const account = { email: 'fixture@example.invalid', password: 'synthetic', gmailAppPassword: 'synthetic-gmail' };
    const save = (body: unknown) => fetch(service.origin + '/account', { method: 'POST', headers, body: JSON.stringify(body) });
    const saved = await save(account);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { ok: true, gmailVerified: true, accountSaved: process.platform === 'win32' });
    assert.equal(check.mock.callCount(), 1);
    assert.equal(service.queue.snapshot().emailConfigured, true);
    const previous = service.queue.verifyEmail;
    check.mock.mockImplementation(async () => { throw new GmailImapFailure('gmail_auth_denied'); });
    const rejected = await save({ ...account, email: 'replacement@example.invalid' });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'gmail_auth_denied' });
    assert.equal(service.queue.credentials?.email, account.email);
    assert.equal(service.queue.verifyEmail, previous);
    if (process.platform === 'win32') {
      const ciphertext = readFileSync(accountStorageFile(root));
      assert.equal(ciphertext.includes(Buffer.from(account.password)), false);
      assert.equal(ciphertext.includes(Buffer.from(account.gmailAppPassword)), false);
      assert.deepEqual(await loadAccount(root), account);
      check.mock.mockImplementation(async () => {});
      await service.close();
      service = await startProductServer({ root, port: 47863 });
      assert.equal(service.queue.snapshot().accountConfigured, true);
      assert.equal(service.queue.snapshot().emailConfigured, true);
      const response = await fetch(service.origin + '/state', { headers });
      const state = await response.text();
      assert.equal(state.includes(account.password), false);
      assert.equal(state.includes(account.gmailAppPassword), false);
    }
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
