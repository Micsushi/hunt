import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { liveFixtures } from "../../src/testing/live/index.ts";
import {
  ExactSealedAccountCustodian,
} from "../../src/secrets/windows-dpapi/private/exact-sealed-account-custodian.ts";
import { readSecretRecord } from "../../src/secrets/windows-dpapi/record.ts";

const HANDLE = "secret_handle_0123456789abcdef0123456789abcdef";

async function withRoot(operation: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hunt-exact-account-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("prepares exact metadata for the configured handle and persists ciphertext once", async () => {
  await withRoot(async (root) => {
    const custodian = new ExactSealedAccountCustodian({
      root,
      forbiddenRoots: [process.cwd()],
      now: () => liveFixtures.issuedAt,
    });
    const prepared = await custodian.prepare({
      handleId: HANDLE,
      journeyId: liveFixtures.journeyId,
      expiresAt: liveFixtures.expiresAt,
    });
    const entropy = prepared.entropy();
    const parsed = JSON.parse(new TextDecoder().decode(entropy));
    assert.deepEqual(parsed, {
      storageVersion: 1,
      schemaVersion: 1,
      handleId: HANDLE,
      journeyId: liveFixtures.journeyId,
      provider: "windows_dpapi_current_user_v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      scope: "account_access",
      issuedAt: liveFixtures.issuedAt,
      expiresAt: liveFixtures.expiresAt,
      state: "active",
    });

    const sealed = Uint8Array.from([53, 59, 61]);
    const result = await prepared.commit(sealed, new AbortController().signal);
    assert.equal(sealed.every((value) => value === 0), true);
    assert.deepEqual(result, {
      schemaVersion: 1,
      handleId: HANDLE,
      journeyId: liveFixtures.journeyId,
      provider: "windows_dpapi_current_user_v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      issuedAt: liveFixtures.issuedAt,
      expiresAt: liveFixtures.expiresAt,
      state: "active",
    });
    const stored = await readSecretRecord(root, HANDLE);
    assert.deepEqual([...(stored?.sealedBytes ?? [])], [53, 59, 61]);
    stored?.sealedBytes.fill(0);
    stored?.metadataBytes.fill(0);

    await assert.rejects(
      prepared.commit(Uint8Array.from([67]), new AbortController().signal),
      /exact account handle already exists/u,
    );
  });
});

test("rejects invalid handles, expiry, existing records, cancellation, and empty ciphertext", async () => {
  await withRoot(async (root) => {
    const custodian = new ExactSealedAccountCustodian({
      root,
      forbiddenRoots: [process.cwd()],
      now: () => liveFixtures.issuedAt,
    });
    for (const request of [
      { handleId: "secret_handle_not_exact", journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      { handleId: HANDLE, journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.issuedAt },
    ]) {
      await assert.rejects(custodian.prepare(request as never), /exact account request invalid/u);
    }
    const prepared = await custodian.prepare({
      handleId: HANDLE,
      journeyId: liveFixtures.journeyId,
      expiresAt: liveFixtures.expiresAt,
    });
    const empty = new Uint8Array();
    await assert.rejects(
      prepared.commit(empty, new AbortController().signal),
      /exact account ciphertext invalid/u,
    );
    const cancelled = Uint8Array.from([71]);
    await assert.rejects(
      prepared.commit(cancelled, AbortSignal.abort()),
      /exact account provisioning cancelled/u,
    );
    assert.equal(cancelled[0], 0);
    assert.deepEqual(await readdir(root), []);
  });
});
