import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { SecretHandleMetadataV1 } from "../../src/contracts/live/index.ts";
import { liveFixtures } from "../../src/testing/live/index.ts";
import { WindowsDpapiSecretStore } from "../../src/secrets/windows-dpapi/store.ts";
import { WindowsDpapiBridge } from "../../src/secrets/windows-dpapi/bridge.ts";
import { WindowsDpapiSecretCustodian } from "../../src/secrets/windows-dpapi/private/custodian.ts";
import { WindowsDpapiSecretResolver } from "../../src/secrets/windows-dpapi/private/resolver.ts";

const activeSignal = () => new AbortController().signal;
const syntheticBytes = (...values: number[]) => Uint8Array.from(values);
const externalOptions = (root: string, now: () => string) => ({
  root,
  now,
  forbiddenRoots: [process.cwd()],
});

async function withSecretRoot(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hunt-s2-dpapi-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function activeMetadata(
  value: SecretHandleMetadataV1,
): asserts value is SecretHandleMetadataV1 & { state: "active" } {
  assert.equal(value.state, "active");
}

test("custodian provisions opaque scoped handles and public inspection returns metadata only", async () => {
  await withSecretRoot(async (root) => {
    const now = () => liveFixtures.issuedAt;
    const custodian = new WindowsDpapiSecretCustodian(externalOptions(root, now));
    const store = new WindowsDpapiSecretStore(externalOptions(root, now));
    const source = [syntheticBytes(19, 23, 29), syntheticBytes(31, 37, 41)];

    const provisioned = await custodian.provisionAccount(
      {
        journeyId: liveFixtures.journeyId,
        expiresAt: liveFixtures.expiresAt,
      },
      source,
      activeSignal(),
    );
    assert.equal(provisioned.ok, true);
    if (!provisioned.ok) return;
    assert.match(provisioned.value.handleId, /^secret_handle_[0-9a-f]{32}$/u);

    const inspected = await store.inspect(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        handleId: provisioned.value.handleId,
        expectedPurpose: "account_credentials",
        expectedConsumer: "credential_mutation_adapter",
      },
      activeSignal(),
    );
    assert.deepEqual(inspected, { ok: true, value: provisioned.value });
    assert.deepEqual(Object.keys(provisioned.value).sort(), [
      "consumer",
      "expiresAt",
      "handleId",
      "issuedAt",
      "journeyId",
      "provider",
      "purpose",
      "schemaVersion",
      "state",
    ]);

    const files = await readdir(root);
    assert.equal(files.length, 1);
    const record = await readFile(join(root, files[0]!));
    for (const value of source) {
      assert.equal(record.includes(Buffer.from(value)), false);
    }
  });
});

test("inspection fails closed for purpose, consumer, journey, expiry, revoke, and cancellation", async () => {
  await withSecretRoot(async (root) => {
    let currentTime: string = liveFixtures.issuedAt;
    const now = () => currentTime;
    const custodian = new WindowsDpapiSecretCustodian(externalOptions(root, now));
    const store = new WindowsDpapiSecretStore(externalOptions(root, now));
    const created = await custodian.provisionAccount(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      [syntheticBytes(47), syntheticBytes(53)],
      activeSignal(),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const base = {
      schemaVersion: 1 as const,
      journeyId: liveFixtures.journeyId,
      handleId: created.value.handleId,
      expectedPurpose: "account_credentials" as const,
      expectedConsumer: "credential_mutation_adapter" as const,
    };

    assert.deepEqual(await store.inspect({ ...base, expectedPurpose: "gmail_oauth" }, activeSignal()), {
      ok: false,
      error: { code: "secret_handle_mismatched", retryable: false },
    });
    assert.deepEqual(await store.inspect({ ...base, expectedConsumer: "gmail_auth_executor" }, activeSignal()), {
      ok: false,
      error: { code: "secret_consumer_forbidden", retryable: false },
    });
    assert.deepEqual(await store.inspect({ ...base, journeyId: liveFixtures.otherJourneyId }, activeSignal()), {
      ok: false,
      error: { code: "secret_handle_mismatched", retryable: false },
    });

    currentTime = liveFixtures.expiresAt;
    assert.deepEqual(await store.inspect(base, activeSignal()), {
      ok: false,
      error: { code: "secret_handle_expired", retryable: false },
    });
    currentTime = liveFixtures.issuedAt;

    const cancelled = new AbortController();
    cancelled.abort();
    assert.deepEqual(await store.inspect(base, cancelled.signal), {
      ok: false,
      error: { code: "operation_cancelled", retryable: false },
    });

    const revoked = await store.revoke(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: liveFixtures.operationIds.secretRevoke,
        handleId: created.value.handleId,
      },
      activeSignal(),
    );
    assert.deepEqual(revoked, { ok: true, value: undefined });
    assert.deepEqual(await store.inspect(base, activeSignal()), {
      ok: false,
      error: { code: "secret_handle_invalid", retryable: false },
    });
    assert.deepEqual(await store.revoke(
      {
        schemaVersion: 1,
        journeyId: liveFixtures.journeyId,
        operationId: liveFixtures.operationIds.secretRevoke,
        handleId: created.value.handleId,
      },
      activeSignal(),
    ), { ok: true, value: undefined });
  });
});

test("only the two frozen consumers resolve plaintext inside a callback and bytes are cleared", async () => {
  await withSecretRoot(async (root) => {
    const now = () => liveFixtures.issuedAt;
    const custodian = new WindowsDpapiSecretCustodian(externalOptions(root, now));
    const resolver = new WindowsDpapiSecretResolver(externalOptions(root, now));
    const account = await custodian.provisionAccount(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      [syntheticBytes(59, 61), syntheticBytes(67, 71)],
      activeSignal(),
    );
    const gmail = await custodian.provisionGmail(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      syntheticBytes(73, 79, 83),
      activeSignal(),
    );
    assert.equal(account.ok, true);
    assert.equal(gmail.ok, true);
    if (!account.ok || !gmail.ok) return;
    activeMetadata(account.value);
    activeMetadata(gmail.value);
    assert.equal(account.value.purpose, "account_credentials");
    assert.equal(account.value.consumer, "credential_mutation_adapter");
    assert.equal(gmail.value.purpose, "gmail_oauth");
    assert.equal(gmail.value.consumer, "gmail_auth_executor");

    let accountViews: readonly Readonly<Uint8Array>[] = [];
    const accountResult = await resolver.useAccountCredentials(
      account.value as typeof liveFixtures.accountSecret,
      activeSignal(),
      async (values) => {
        accountViews = values;
        assert.deepEqual(values.map((value) => [...value]), [[59, 61], [67, 71]]);
        return { kind: "verification_required", attemptedFields: ["email", "password"] };
      },
    );
    assert.deepEqual(accountResult, {
      ok: true,
      value: { kind: "verification_required", attemptedFields: ["email", "password"] },
    });
    assert.deepEqual(accountViews.map((value) => [...value]), [[0, 0], [0, 0]]);

    let gmailView: Readonly<Uint8Array> | undefined;
    const gmailResult = await resolver.useGmailAuthorization(
      gmail.value as typeof liveFixtures.gmailSecret,
      activeSignal(),
      async (value) => {
        gmailView = value;
        assert.deepEqual([...value], [73, 79, 83]);
        return liveFixtures.mailboxAvailable;
      },
    );
    assert.deepEqual(gmailResult, { ok: true, value: liveFixtures.mailboxAvailable });
    assert.deepEqual([...(gmailView ?? [])], [0, 0, 0]);
  });
});

test("resolver rejects supplied metadata widening before invoking a privileged callback", async () => {
  await withSecretRoot(async (root) => {
    const now = () => liveFixtures.issuedAt;
    const custodian = new WindowsDpapiSecretCustodian(externalOptions(root, now));
    const resolver = new WindowsDpapiSecretResolver(externalOptions(root, now));
    const account = await custodian.provisionAccount(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      [syntheticBytes(127), syntheticBytes(131)],
      activeSignal(),
    );
    assert.equal(account.ok, true);
    if (!account.ok) return;
    let invoked = false;
    const result = await resolver.useAccountCredentials(
      { ...account.value, provider: "synthetic_wrong_provider" } as never,
      activeSignal(),
      async () => {
        invoked = true;
        return { kind: "verification_required", attemptedFields: ["email", "password"] };
      },
    );
    assert.deepEqual(result, {
      ok: false,
      error: { code: "secret_handle_mismatched", retryable: false },
    });
    assert.equal(invoked, false);
  });
});

test("callback failure still clears resolved bytes", async () => {
  await withSecretRoot(async (root) => {
    const now = () => liveFixtures.issuedAt;
    const custodian = new WindowsDpapiSecretCustodian(externalOptions(root, now));
    const resolver = new WindowsDpapiSecretResolver(externalOptions(root, now));
    const gmail = await custodian.provisionGmail(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      syntheticBytes(137, 139),
      activeSignal(),
    );
    assert.equal(gmail.ok, true);
    if (!gmail.ok) return;
    let view: Readonly<Uint8Array> | undefined;
    await assert.rejects(
      resolver.useGmailAuthorization(
        gmail.value as typeof liveFixtures.gmailSecret,
        activeSignal(),
        async (value) => {
          view = value;
          throw new Error("synthetic callback failure");
        },
      ),
      /synthetic callback failure/u,
    );
    assert.deepEqual([...(view ?? [])], [0, 0]);
  });
});

test("tampered ciphertext and an unavailable bridge fail without invoking consumers", async () => {
  await withSecretRoot(async (root) => {
    const now = () => liveFixtures.issuedAt;
    const custodian = new WindowsDpapiSecretCustodian(externalOptions(root, now));
    const resolver = new WindowsDpapiSecretResolver(externalOptions(root, now));
    const gmail = await custodian.provisionGmail(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      syntheticBytes(149, 151),
      activeSignal(),
    );
    assert.equal(gmail.ok, true);
    if (!gmail.ok) return;
    const file = join(root, `${gmail.value.handleId}.s2secret`);
    const record = await readFile(file);
    const last = record.length - 1;
    record[last] = record[last]! ^ 0xff;
    await writeFile(file, record);
    record.fill(0);
    let invoked = false;
    assert.deepEqual(await resolver.useGmailAuthorization(
      gmail.value as typeof liveFixtures.gmailSecret,
      activeSignal(),
      async () => {
        invoked = true;
        return liveFixtures.mailboxAvailable;
      },
    ), {
      ok: false,
      error: { code: "secret_store_unavailable", retryable: true },
    });
    assert.equal(invoked, false);
  });

  await withSecretRoot(async (root) => {
    const custodian = new WindowsDpapiSecretCustodian({
      root,
      now: () => liveFixtures.issuedAt,
      forbiddenRoots: [process.cwd()],
      bridge: new WindowsDpapiBridge({ executable: join(root, "missing.exe") }),
    });
    assert.deepEqual(await custodian.provisionGmail(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      syntheticBytes(157, 163),
      activeSignal(),
    ), {
      ok: false,
      error: { code: "secret_store_unavailable", retryable: true },
    });
    assert.deepEqual(await readdir(root), []);
  });
});

test("rotation creates a new handle and invalidates the old record", async () => {
  await withSecretRoot(async (root) => {
    const now = () => liveFixtures.issuedAt;
    const custodian = new WindowsDpapiSecretCustodian(externalOptions(root, now));
    const store = new WindowsDpapiSecretStore(externalOptions(root, now));
    const first = await custodian.provisionGmail(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      syntheticBytes(89, 97),
      activeSignal(),
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const rotated = await custodian.rotateGmail(
      first.value,
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      syntheticBytes(101, 103),
      activeSignal(),
    );
    assert.equal(rotated.ok, true);
    if (!rotated.ok) return;
    assert.notEqual(rotated.value.handleId, first.value.handleId);
    assert.deepEqual(await store.inspect({
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      handleId: first.value.handleId,
      expectedPurpose: "gmail_oauth",
      expectedConsumer: "gmail_auth_executor",
    }, activeSignal()), {
      ok: false,
      error: { code: "secret_handle_invalid", retryable: false },
    });
  });
});

test("the private custodian deletes an exact scoped record without widening root access", async () => {
  await withSecretRoot(async (root) => {
    const now = () => liveFixtures.issuedAt;
    const custodian = new WindowsDpapiSecretCustodian(externalOptions(root, now));
    const store = new WindowsDpapiSecretStore(externalOptions(root, now));
    const created = await custodian.provisionGmail(
      { journeyId: liveFixtures.journeyId, expiresAt: liveFixtures.expiresAt },
      syntheticBytes(107, 109),
      activeSignal(),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    assert.deepEqual(await custodian.delete(created.value, activeSignal()), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(await store.inspect({
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      handleId: created.value.handleId,
      expectedPurpose: "gmail_oauth",
      expectedConsumer: "gmail_auth_executor",
    }, activeSignal()), {
      ok: false,
      error: { code: "secret_handle_invalid", retryable: false },
    });
    assert.deepEqual(await readdir(root), []);
  });
});

test("secret roots inside forbidden repository roots are rejected without leaking the path", () => {
  assert.throws(
    () => new WindowsDpapiSecretStore({ root: process.cwd(), forbiddenRoots: [process.cwd()] }),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "secret root is not an approved external directory",
  );
});

test("secret root construction requires an explicit forbidden-root boundary", async () => {
  await withSecretRoot(async (root) => {
    assert.throws(
      () => new WindowsDpapiSecretStore({ root } as never),
      /secret root is not an approved external directory/u,
    );
  });
});

test("secret root validation resolves directory links before applying forbidden roots", async () => {
  const parent = await mkdtemp(join(tmpdir(), "hunt-s2-root-policy-"));
  const forbidden = await mkdtemp(join(tmpdir(), "hunt-s2-forbidden-"));
  const linked = join(parent, "linked");
  try {
    await symlink(forbidden, linked, "junction");
    assert.throws(
      () => new WindowsDpapiSecretStore({ root: linked, forbiddenRoots: [forbidden] }),
      /secret root is not an approved external directory/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(forbidden, { recursive: true, force: true });
  }
});
