import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapS2AccountSecret,
  type AccountCiphertextSealer,
} from "../../src/composition/s2-account-bootstrap.ts";
import type { RealRunOwnerInputsV1 } from "../../src/live/preflight/types.ts";
import type {
  WindowsAclAdmissionPaths,
  WindowsAclAdmissionResult,
} from "../../src/live/preflight/private/windows-acl.ts";

const NOW = "2026-08-01T12:00:00.000Z";
const LATER = "2026-08-02T12:00:00.000Z";
const ACCOUNT_HANDLE = "secret_handle_0123456789abcdef0123456789abcdef";
const GMAIL_HANDLE = "secret_handle_fedcba9876543210fedcba9876543210";

class AclAdmission {
  readonly #results: readonly WindowsAclAdmissionResult[];
  calls: WindowsAclAdmissionPaths[] = [];

  constructor(results: readonly WindowsAclAdmissionResult[] = [{ ok: true }, { ok: true }]) {
    this.#results = results;
  }

  admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult {
    this.calls.push(paths);
    return this.#results[this.calls.length - 1] ?? { ok: true };
  }
}

class Sealer implements AccountCiphertextSealer {
  calls = 0;
  entropy?: Uint8Array;

  async seal(entropy: Readonly<Uint8Array>): Promise<Uint8Array> {
    this.calls += 1;
    this.entropy = Uint8Array.from(entropy);
    return Uint8Array.from([79, 83, 89]);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hunt-account-bootstrap-"));
  const forbidden = join(root, "repository");
  const runtime = join(root, "runtime");
  const secrets = join(root, "secrets");
  const evidence = join(root, "evidence");
  for (const path of [forbidden, runtime, secrets, evidence]) mkdirSync(path);
  const ownerConfigPath = join(runtime, "owner-inputs.json");
  const input = ownerInputs(runtime, secrets, evidence);
  writeFileSync(ownerConfigPath, JSON.stringify(input));
  return { root, forbidden, runtime, secrets, evidence, ownerConfigPath, input };
}

test("preflights and ACL-checks before sealing the exact configured account handle", async () => {
  const record = fixture();
  try {
    const acl = new AclAdmission();
    const sealer = new Sealer();
    const result = await bootstrapS2AccountSecret(record.input, {
      now: NOW,
      ownerConfigPath: record.ownerConfigPath,
      forbiddenRoots: [record.forbidden],
      aclAdmission: acl,
      sealer,
    }, new AbortController().signal);

    assert.deepEqual(result, {
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "account_secret_provisioned",
        handleId: ACCOUNT_HANDLE,
      },
    });
    assert.equal(sealer.calls, 1);
    const metadata = JSON.parse(new TextDecoder().decode(sealer.entropy));
    assert.equal(metadata.handleId, ACCOUNT_HANDLE);
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.issuedAt, NOW);
    assert.equal(metadata.purpose, "account_credentials");
    assert.equal(metadata.consumer, "credential_mutation_adapter");
    assert.equal(acl.calls.length, 2);
    assert.equal(acl.calls[0]?.accountRecord, undefined);
    assert.equal(
      acl.calls[1]?.accountRecord,
      join(record.secrets, `${ACCOUNT_HANDLE}.s2secret`),
    );
    assert.equal(JSON.stringify(result).includes(record.secrets), false);
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("preflight denial and an existing handle fail before secure UI", async () => {
  const record = fixture();
  try {
    const deniedSealer = new Sealer();
    assert.deepEqual(await bootstrapS2AccountSecret(record.input, {
      now: NOW,
      ownerConfigPath: record.ownerConfigPath,
      forbiddenRoots: [record.forbidden],
      aclAdmission: new AclAdmission([{
        ok: false,
        failure: { target: "secret_root", reason: "other_principal" },
      }]),
      sealer: deniedSealer,
    }, new AbortController().signal), {
      ok: false,
      error: { code: "secret_root_invalid" },
    });
    assert.equal(deniedSealer.calls, 0);

    writeFileSync(join(record.secrets, `${ACCOUNT_HANDLE}.s2secret`), "existing");
    const existingSealer = new Sealer();
    assert.deepEqual(await bootstrapS2AccountSecret(record.input, {
      now: NOW,
      ownerConfigPath: record.ownerConfigPath,
      forbiddenRoots: [record.forbidden],
      aclAdmission: new AclAdmission(),
      sealer: existingSealer,
    }, new AbortController().signal), {
      ok: false,
      error: { code: "account_handle_exists" },
    });
    assert.equal(existingSealer.calls, 0);
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("post-write ACL denial removes the exact record and emits no path", async () => {
  const record = fixture();
  try {
    const result = await bootstrapS2AccountSecret(record.input, {
      now: NOW,
      ownerConfigPath: record.ownerConfigPath,
      forbiddenRoots: [record.forbidden],
      aclAdmission: new AclAdmission([
        { ok: true },
        { ok: false, failure: { target: "secret_record", reason: "other_principal" } },
      ]),
      sealer: new Sealer(),
    }, new AbortController().signal);
    assert.deepEqual(result, {
      ok: false,
      error: { code: "account_record_acl_invalid" },
    });
    assert.equal(
      existsSync(join(record.secrets, `${ACCOUNT_HANDLE}.s2secret`)),
      false,
    );
    assert.equal(JSON.stringify(result).includes(record.secrets), false);
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

function ownerInputs(
  runtime: string,
  secrets: string,
  evidence: string,
): RealRunOwnerInputsV1 {
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
      expiresAt: LATER,
      ownerId: "owner_abcdefghijklmnop",
      runtimeOperatorId: "owner_abcdefghijklmnop",
      secretCustodianId: "owner_abcdefghijklmnop",
      evidenceCustodianId: "owner_abcdefghijklmnop",
    },
    adapters: {
      secretStore: "windows-dpapi-current-user-v1",
      mailboxProvider: "gmail-api-v1",
    },
    accountSecret: {
      schemaVersion: 1,
      handleId: ACCOUNT_HANDLE,
      journeyId,
      provider: "windows-dpapi-current-user-v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      scope: "account_access",
      expiresAt: LATER,
    },
    gmailAuthorization: {
      schemaVersion: 1,
      handleId: GMAIL_HANDLE,
      journeyId,
      provider: "windows-dpapi-current-user-v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      expiresAt: LATER,
    },
  };
}
