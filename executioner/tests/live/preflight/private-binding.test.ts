import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";

import * as publicPreflight from "../../../src/live/preflight/index.ts";
import { createPrivateRealRunAdmission } from "../../../src/live/preflight/private/runtime-binding.ts";
import type { RealRunOwnerInputsV1 } from "../../../src/live/preflight/types.ts";
import type {
  WindowsAclAdmissionPaths,
  WindowsAclAdmissionResult,
} from "../../../src/live/preflight/private/windows-acl.ts";

class RecordingAclAdmission {
  readonly #result: WindowsAclAdmissionResult;
  paths?: WindowsAclAdmissionPaths;

  constructor(result: WindowsAclAdmissionResult = { ok: true }) {
    this.#result = result;
  }

  admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult {
    this.paths = paths;
    return this.#result;
  }
}

test("the private binding captures raw browser inputs without public serialization", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-binding-"));
  try {
    const forbidden = join(root, "repository");
    const runtime = join(root, "runtime");
    const secrets = join(root, "secrets");
    const evidence = join(root, "evidence");
    for (const path of [forbidden, runtime, secrets, evidence]) mkdirSync(path);
    const input = ownerInputs(runtime, secrets, evidence);
    const ownerConfigPath = join(runtime, "owner-inputs.json");
    const accountRecord = join(secrets, `${input.accountSecret.handleId}.s2secret`);
    writeFileSync(ownerConfigPath, "{}");
    writeFileSync(accountRecord, "record");
    const aclAdmission = new RecordingAclAdmission();

    const admitted = createPrivateRealRunAdmission(input, {
      now: "2026-08-01T12:00:00.000Z",
      forbiddenRoots: [forbidden],
      ownerConfigPath,
      aclAdmission,
    });
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;

    const runtimeValues = admitted.binding.forPersistentBrowser();
    assert.equal(runtimeValues.targetUrl, input.target.url);
    assert.equal(runtimeValues.admittedAt, "2026-08-01T12:00:00.000Z");
    assert.equal(runtimeValues.leaseExpiresAt, "2026-08-02T12:00:00.000Z");
    assert.equal(isAbsolute(runtimeValues.profilePath), true);
    assert.equal(relative(runtime, runtimeValues.profilePath).startsWith(".."), false);
    assert.equal(runtimeValues.profilePath.includes(input.journeyId), true);

    const serialized = JSON.stringify(admitted);
    for (const raw of [input.target.url, runtimeValues.profilePath, runtime, secrets, evidence]) {
      assert.equal(serialized.includes(raw), false);
    }
    assert.deepEqual(Object.keys(admitted.binding), []);
    assert.deepEqual(aclAdmission.paths, {
      runtime,
      secrets,
      evidence,
      ownerConfig: ownerConfigPath,
      accountRecord,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the private admission maps ACL denial before constructing a browser binding", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-binding-acl-"));
  try {
    const forbidden = join(root, "repository");
    const runtime = join(root, "runtime");
    const secrets = join(root, "secrets");
    const evidence = join(root, "evidence");
    for (const path of [forbidden, runtime, secrets, evidence]) mkdirSync(path);
    const ownerConfigPath = join(runtime, "owner-inputs.json");
    writeFileSync(ownerConfigPath, "{}");
    const input = ownerInputs(runtime, secrets, evidence);

    for (const [target, code] of [
      ["runtime_root", "runtime_root_invalid"],
      ["secret_root", "secret_root_invalid"],
      ["secret_record", "secret_root_invalid"],
      ["evidence_root", "evidence_root_invalid"],
      ["owner_config", "owner_config_invalid"],
    ] as const) {
      const admitted = createPrivateRealRunAdmission(input, {
        now: "2026-08-01T12:00:00.000Z",
        forbiddenRoots: [forbidden],
        ownerConfigPath,
        aclAdmission: new RecordingAclAdmission({
          ok: false,
          failure: { target, reason: "other_principal" },
        }),
      });
      assert.deepEqual(admitted, {
        ok: false,
        error: { code, dimension: "acl" },
      });
      assert.equal(JSON.stringify(admitted).includes(ownerConfigPath), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the public preflight barrel does not export the private constructor", () => {
  assert.equal("createPrivateRealRunAdmission" in publicPreflight, false);
  assert.equal("RealRunRuntimeBinding" in publicPreflight, false);
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
      expiresAt: "2026-08-02T12:00:00.000Z",
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
      handleId: "secret_handle_accountabcdefghijkl",
      journeyId,
      provider: "windows-dpapi-current-user-v1",
      purpose: "account_credentials",
      consumer: "credential_mutation_adapter",
      scope: "account_access",
      expiresAt: "2026-08-02T12:00:00.000Z",
    },
    gmailAuthorization: {
      schemaVersion: 1,
      handleId: "secret_handle_gmailabcdefghijklmn",
      journeyId,
      provider: "windows-dpapi-current-user-v1",
      purpose: "gmail_oauth",
      consumer: "gmail_auth_executor",
      scope: "mailbox_verification",
      expiresAt: "2026-08-02T12:00:00.000Z",
    },
  };
}
