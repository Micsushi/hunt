import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { liveFixtures } from "../../src/testing/live/index.ts";
import { ExactSealedGmailCustodian } from "../../src/secrets/windows-dpapi/private/exact-sealed-gmail-custodian.ts";
import { readSecretRecord } from "../../src/secrets/windows-dpapi/record.ts";

const HANDLE = "secret_handle_fedcba9876543210fedcba9876543210";

test("prepares the exact configured Gmail handle and commits ciphertext once", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-exact-gmail-"));
  try {
    const prepared = await new ExactSealedGmailCustodian({
      root,
      forbiddenRoots: [process.cwd()],
      now: () => liveFixtures.issuedAt,
    }).prepare({
      handleId: HANDLE,
      journeyId: liveFixtures.journeyId,
      expiresAt: new Date(Date.parse(liveFixtures.issuedAt) + 30 * 60_000).toISOString(),
    });
    const entropy = prepared.entropy();
    assert.deepEqual(JSON.parse(new TextDecoder().decode(entropy)), {
      storageVersion: 1,
      schemaVersion: 1,
      handleId: HANDLE,
      journeyId: liveFixtures.journeyId,
      provider: "windows_dpapi_current_user_v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      issuedAt: liveFixtures.issuedAt,
      expiresAt: new Date(Date.parse(liveFixtures.issuedAt) + 30 * 60_000).toISOString(),
      state: "active",
    });
    entropy.fill(0);

    const sealed = Uint8Array.from([17, 19, 23]);
    const metadata = await prepared.commit(sealed, new AbortController().signal);
    assert.equal(sealed.every((value) => value === 0), true);
    assert.equal(metadata.handleId, HANDLE);
    assert.equal(metadata.purpose, "gmail_oauth");
    assert.equal(metadata.consumer, "gmail_auth_executor");
    const stored = await readSecretRecord(root, HANDLE);
    assert.deepEqual([...(stored?.sealedBytes ?? [])], [17, 19, 23]);
    stored?.sealedBytes.fill(0);
    stored?.metadataBytes.fill(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects long expiry, invalid handle, cancellation, and empty ciphertext", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-exact-gmail-deny-"));
  try {
    const custodian = new ExactSealedGmailCustodian({
      root,
      forbiddenRoots: [process.cwd()],
      now: () => liveFixtures.issuedAt,
    });
    for (const request of [
      { handleId: "secret_handle_invalid", journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      { handleId: HANDLE, journeyId: liveFixtures.journeyId, expiresAt: new Date(Date.parse(liveFixtures.issuedAt) + 31 * 60_000).toISOString() },
    ]) {
      await assert.rejects(custodian.prepare(request as never), /exact Gmail request invalid/u);
    }
    const prepared = await custodian.prepare({
      handleId: HANDLE,
      journeyId: liveFixtures.journeyId,
      expiresAt: new Date(Date.parse(liveFixtures.issuedAt) + 30 * 60_000).toISOString(),
    });
    await assert.rejects(
      prepared.commit(new Uint8Array(), new AbortController().signal),
      /exact Gmail ciphertext invalid/u,
    );
    const cancelled = Uint8Array.from([29]);
    await assert.rejects(prepared.commit(cancelled, AbortSignal.abort()), /cancelled/u);
    assert.equal(cancelled[0], 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
