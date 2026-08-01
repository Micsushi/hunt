import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapS2GmailAuthorization,
  type GmailCiphertextSealer,
} from "../../src/composition/s2-gmail-bootstrap.ts";
import type { RealRunOwnerInputsV1 } from "../../src/live/preflight/types.ts";
import type {
  WindowsAclAdmissionPaths,
  WindowsAclAdmissionResult,
} from "../../src/live/preflight/private/windows-acl.ts";
import type { GmailOAuthSealRequest } from "../../src/secrets/windows-dpapi/private/interactive-gmail-oauth-sealer.ts";
import { writeSecretRecord } from "../../src/secrets/windows-dpapi/record.ts";

const NOW = "2026-08-01T12:00:00.000Z";
const GMAIL_EXPIRES = "2026-08-01T12:30:00.000Z";
const ACCOUNT_EXPIRES = GMAIL_EXPIRES;
const ACCOUNT_HANDLE = "secret_handle_0123456789abcdef0123456789abcdef";
const GMAIL_HANDLE = "secret_handle_fedcba9876543210fedcba9876543210";

class AclAdmission {
  readonly #results: readonly WindowsAclAdmissionResult[];
  calls: WindowsAclAdmissionPaths[] = [];

  constructor(results: readonly WindowsAclAdmissionResult[] = [{ ok: true }, { ok: true }, { ok: true }]) {
    this.#results = results;
  }

  admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult {
    this.calls.push(paths);
    return this.#results[this.calls.length - 1] ?? { ok: true };
  }
}

class Sealer implements GmailCiphertextSealer {
  calls = 0;
  request?: GmailOAuthSealRequest;

  async seal(value: GmailOAuthSealRequest): Promise<Uint8Array> {
    this.calls += 1;
    this.request = {
      ...value,
      gmailMetadata: Uint8Array.from(value.gmailMetadata),
      accountMetadata: Uint8Array.from(value.accountMetadata),
      accountCiphertext: Uint8Array.from(value.accountCiphertext),
    };
    return Uint8Array.from([31, 37, 41]);
  }
}

test("preflights both inputs before sealing the exact Gmail handle", async () => {
  const record = await fixture();
  try {
    const acl = new AclAdmission();
    const sealer = new Sealer();
    const result = await bootstrapS2GmailAuthorization(
      record.owner,
      record.bootstrap,
      {
        now: NOW,
        ownerConfigPath: record.ownerConfigPath,
        bootstrapInputPath: record.bootstrapInputPath,
        forbiddenRoots: [record.repository],
        aclAdmission: acl,
        sealer,
      },
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "gmail_authorization_provisioned",
        handleId: GMAIL_HANDLE,
      },
    });
    assert.equal(sealer.calls, 1);
    assert.equal(sealer.request?.clientId, record.bootstrap.desktopClientId);
    assert.equal(sealer.request?.binding.verificationHost, record.bootstrap.verificationHost);
    assert.equal(sealer.request?.binding.verificationTenant, record.owner.target.tenant);
    assert.equal(sealer.request?.binding.verificationTtlSeconds, 86_400);
    assert.deepEqual(sealer.request?.binding.target, {
      schemaVersion: 1,
      atsFamily: "workday",
      hostId: "host_abcdefghijklmnop",
      tenantId: "tenant_abcdefghijklmnop",
      postingId: "posting_abcdefghijklmnop",
    });
    assert.match(sealer.request?.binding.senderPolicyId ?? "", /^sender_policy_[0-9a-f]{32}$/u);
    assert.equal(acl.calls.length, 3);
    assert.equal(acl.calls[0]?.gmailRecord, undefined);
    assert.equal(acl.calls[1]?.ownerConfig, record.bootstrapInputPath);
    assert.equal(acl.calls[2]?.gmailRecord, join(record.secrets, `${GMAIL_HANDLE}.s2secret`));
    assert.equal(existsSync(join(record.secrets, `${GMAIL_HANDLE}.s2secret`)), true);
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("denial, mismatched policy, and existing Gmail handle fail before child", async () => {
  const record = await fixture();
  try {
    const denied = new Sealer();
    assert.deepEqual(await bootstrapS2GmailAuthorization(
      record.owner,
      record.bootstrap,
      {
        now: NOW,
        ownerConfigPath: record.ownerConfigPath,
        bootstrapInputPath: record.bootstrapInputPath,
        forbiddenRoots: [record.repository],
        aclAdmission: new AclAdmission([{
          ok: false,
          failure: { target: "owner_config", reason: "other_principal" },
        }]),
        sealer: denied,
      },
      new AbortController().signal,
    ), { ok: false, error: { code: "owner_config_invalid" } });
    assert.equal(denied.calls, 0);

    const mismatch = new Sealer();
    assert.deepEqual(await bootstrapS2GmailAuthorization(
      record.owner,
      { ...record.bootstrap, journeyId: "journey_fedcba9876543210" },
      {
        now: NOW,
        ownerConfigPath: record.ownerConfigPath,
        bootstrapInputPath: record.bootstrapInputPath,
        forbiddenRoots: [record.repository],
        aclAdmission: new AclAdmission(),
        sealer: mismatch,
      },
      new AbortController().signal,
    ), { ok: false, error: { code: "gmail_bootstrap_input_invalid" } });
    assert.equal(mismatch.calls, 0);

    await writeSecretRecord(record.secrets, {
      storageVersion: 1,
      schemaVersion: 1,
      handleId: GMAIL_HANDLE as never,
      journeyId: record.owner.journeyId as never,
      provider: "windows_dpapi_current_user_v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      issuedAt: NOW,
      expiresAt: GMAIL_EXPIRES,
      state: "active",
    }, Uint8Array.from([43]));
    const existing = new Sealer();
    assert.deepEqual(await bootstrapS2GmailAuthorization(
      record.owner,
      record.bootstrap,
      {
        now: NOW,
        ownerConfigPath: record.ownerConfigPath,
        bootstrapInputPath: record.bootstrapInputPath,
        forbiddenRoots: [record.repository],
        aclAdmission: new AclAdmission(),
        sealer: existing,
      },
      new AbortController().signal,
    ), { ok: false, error: { code: "gmail_handle_exists" } });
    assert.equal(existing.calls, 0);
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("rejects mixed F1/F2 expiries before child and cleans only a newly written Gmail record", async () => {
  const record = await fixture();
  try {
    const mixed = {
      ...record.owner,
      accountSecret: {
        ...record.owner.accountSecret,
        expiresAt: "2026-08-02T12:00:00.000Z",
      },
    };
    const mixedSealer = new Sealer();
    assert.deepEqual(await bootstrapS2GmailAuthorization(
      mixed,
      record.bootstrap,
      {
        now: NOW,
        ownerConfigPath: record.ownerConfigPath,
        bootstrapInputPath: record.bootstrapInputPath,
        forbiddenRoots: [record.repository],
        aclAdmission: new AclAdmission(),
        sealer: mixedSealer,
      },
      new AbortController().signal,
    ), { ok: false, error: { code: "owner_config_invalid" } });
    assert.equal(mixedSealer.calls, 0);

    const result = await bootstrapS2GmailAuthorization(
      record.owner,
      record.bootstrap,
      {
        now: NOW,
        ownerConfigPath: record.ownerConfigPath,
        bootstrapInputPath: record.bootstrapInputPath,
        forbiddenRoots: [record.repository],
        aclAdmission: new AclAdmission([
          { ok: true },
          { ok: true },
          { ok: false, failure: { target: "secret_record", reason: "other_principal" } },
        ]),
        sealer: new Sealer(),
      },
      new AbortController().signal,
    );
    assert.deepEqual(result, { ok: false, error: { code: "gmail_record_acl_invalid" } });
    assert.equal(existsSync(join(record.secrets, `${GMAIL_HANDLE}.s2secret`)), false);
    assert.equal(existsSync(join(record.secrets, `${ACCOUNT_HANDLE}.s2secret`)), true);
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hunt-gmail-bootstrap-"));
  const repository = join(root, "repository");
  const runtime = join(root, "runtime");
  const secrets = join(root, "secrets");
  const evidence = join(root, "evidence");
  for (const path of [repository, runtime, secrets, evidence]) mkdirSync(path);
  const owner = ownerInputs(runtime, secrets, evidence);
  const ownerConfigPath = join(runtime, "owner-inputs.json");
  const bootstrapInputPath = join(runtime, "gmail-bootstrap-input.json");
  const bootstrap = {
    schemaVersion: 1 as const,
    contractRevision: "s2-gmail-bootstrap-v1" as const,
    revisionId: owner.revisionId,
    journeyId: owner.journeyId,
    gmailHandleId: owner.gmailAuthorization.handleId,
    desktopClientId: "1234567890-example1.apps.googleusercontent.com",
    verificationHost: "wd5.myworkday.com",
  };
  writeFileSync(ownerConfigPath, JSON.stringify(owner));
  writeFileSync(bootstrapInputPath, JSON.stringify(bootstrap));
  await writeSecretRecord(secrets, {
    storageVersion: 1,
    schemaVersion: 1,
    handleId: ACCOUNT_HANDLE as never,
    journeyId: owner.journeyId as never,
    provider: "windows_dpapi_current_user_v1",
    purpose: "account_credentials",
    consumer: "credential_mutation_adapter",
    scope: "account_access",
    issuedAt: NOW,
    expiresAt: ACCOUNT_EXPIRES,
    state: "active",
  }, Uint8Array.from([2, 3, 5]));
  return { root, repository, runtime, secrets, evidence, ownerConfigPath, bootstrapInputPath, owner, bootstrap };
}

function ownerInputs(runtime: string, secrets: string, evidence: string): RealRunOwnerInputsV1 {
  const journeyId = "journey_abcdefghijklmnop";
  const revisionId = "revision_abcdefghijklmnop";
  return {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId,
    journeyId,
    accountMode: "fresh_create",
    target: {
      handleId: "target_ref_abcdefghijklmnop",
      url: "https://acme.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345",
      host: "acme.wd5.myworkdayjobs.invalid",
      tenant: "acme",
      posting: "R12345",
    },
    profileRef: "profile_ref_abcdefghijklmnop",
    resumeRef: "resume_ref_abcdefghijklmnop",
    recipientBindingId: "recipient_abcdefghijklmnop",
    roots: {
      runtime: { rootId: "runtime_root_abcdefghijklmnop", path: runtime, access: "current_user_only" },
      secrets: { rootId: "secrets_root_abcdefghijklmnop", path: secrets, access: "current_user_only" },
      evidence: { rootId: "evidence_root_abcdefghijklmnop", path: evidence, access: "current_user_only" },
    },
    policy: { cleanupLeaseHours: 24, retentionDays: 30 },
    approval: {
      schemaVersion: 1,
      approvalId: "approval_abcdefghijklmnop",
      journeyId,
      revisionId,
      approved: true,
      liveAccess: true,
      approvedAt: "2026-08-01T11:00:00.000Z",
      expiresAt: ACCOUNT_EXPIRES,
      ownerId: "owner_abcdefghijklmnop",
      runtimeOperatorId: "owner_abcdefghijklmnop",
      secretCustodianId: "owner_abcdefghijklmnop",
      evidenceCustodianId: "owner_abcdefghijklmnop",
    },
    adapters: { secretStore: "windows-dpapi-current-user-v1", mailboxProvider: "gmail-api-v1" },
    accountSecret: {
      schemaVersion: 1,
      handleId: ACCOUNT_HANDLE,
      journeyId,
      provider: "windows-dpapi-current-user-v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      scope: "account_access",
      expiresAt: ACCOUNT_EXPIRES,
    },
    gmailAuthorization: {
      schemaVersion: 1,
      handleId: GMAIL_HANDLE,
      journeyId,
      provider: "windows-dpapi-current-user-v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      expiresAt: GMAIL_EXPIRES,
    },
  };
}
