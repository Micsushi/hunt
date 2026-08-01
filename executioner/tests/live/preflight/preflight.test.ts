import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  admitRealRunPreflight,
  type RealRunOwnerInputsV1,
} from "../../../src/live/preflight/index.ts";

const NOW = "2026-08-01T12:00:00.000Z";
const LATER = "2026-08-02T12:00:00.000Z";
const JOURNEY_ID = "journey_abcdefghijklmnop";
const REVISION_ID = "revision_abcdefghijklmnop";

interface Fixture {
  readonly root: string;
  readonly forbidden: string;
  readonly input: RealRunOwnerInputsV1;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-preflight-"));
  const forbidden = join(root, "repository");
  const runtime = join(root, "external-runtime");
  const secrets = join(root, "external-secrets");
  const evidence = join(root, "external-evidence");
  for (const path of [forbidden, runtime, secrets, evidence]) {
    mkdirSync(path);
  }

  return {
    root,
    forbidden,
    input: {
      schemaVersion: 1,
      contractRevision: "s2-owner-inputs-v1",
      revisionId: REVISION_ID,
      journeyId: JOURNEY_ID,
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
        runtime: {
          rootId: "runtime_root_abcdefghijklmnop",
          path: runtime,
          access: "current_user_only",
        },
        secrets: {
          rootId: "secrets_root_abcdefghijklmnop",
          path: secrets,
          access: "current_user_only",
        },
        evidence: {
          rootId: "evidence_root_abcdefghijklmnop",
          path: evidence,
          access: "current_user_only",
        },
      },
      policy: {
        cleanupLeaseHours: 24,
        retentionDays: 30,
      },
      approval: {
        schemaVersion: 1,
        approvalId: "approval_abcdefghijklmnop",
        journeyId: JOURNEY_ID,
        revisionId: REVISION_ID,
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
        handleId: "secret_handle_accountabcdefghijkl",
        journeyId: JOURNEY_ID,
        provider: "windows-dpapi-current-user-v1",
        purpose: "account_credentials",
        consumer: "credential_mutation_adapter",
        scope: "account_access",
        expiresAt: LATER,
      },
      gmailAuthorization: {
        schemaVersion: 1,
        handleId: "secret_handle_gmailabcdefghijklmn",
        journeyId: JOURNEY_ID,
        provider: "windows-dpapi-current-user-v1",
        purpose: "gmail_oauth",
        consumer: "gmail_auth_executor",
        scope: "mailbox_verification",
        expiresAt: LATER,
      },
    },
  };
}

function admit(value: unknown, record: Fixture) {
  return admitRealRunPreflight(value, {
    now: NOW,
    forbiddenRoots: [record.forbidden],
  });
}

test("admits one closed owner config and returns a value-free dry report", () => {
  const record = fixture();
  try {
    const result = admit(record.input, record);
    assert.deepEqual(result, {
      ok: true,
      report: {
        schemaVersion: 1,
        kind: "ready",
        contractRevision: "s2-owner-inputs-v1",
        revisionId: REVISION_ID,
        journeyId: JOURNEY_ID,
        accountMode: "fresh_create",
        approvalId: "approval_abcdefghijklmnop",
        targetHandleId: "target_ref_abcdefghijklmnop",
        profileRef: "profile_ref_abcdefghijklmnop",
        resumeRef: "resume_ref_abcdefghijklmnop",
        recipientBindingId: "recipient_abcdefghijklmnop",
        rootIds: {
          runtime: "runtime_root_abcdefghijklmnop",
          secrets: "secrets_root_abcdefghijklmnop",
          evidence: "evidence_root_abcdefghijklmnop",
        },
        secretHandleIds: {
          account: "secret_handle_accountabcdefghijkl",
          gmail: "secret_handle_gmailabcdefghijklmn",
        },
        adapters: {
          secretStore: "windows-dpapi-current-user-v1",
          mailboxProvider: "gmail-api-v1",
        },
        cleanupLeaseHours: 24,
        retentionDays: 30,
        approvedTargetDimensions: ["host", "tenant", "posting"],
      },
    });

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      record.input.target.url,
      record.input.target.host,
      record.input.target.tenant,
      record.input.target.posting,
      record.input.roots.runtime.path,
      record.input.roots.secrets.path,
      record.input.roots.evidence.path,
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("accepts the frozen sign-in mode without widening account policy", () => {
  const record = fixture();
  try {
    const result = admit({ ...record.input, accountMode: "sign_in" }, record);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.report.accountMode, "sign_in");
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("rejects missing, extra, and unversioned owner input fields", () => {
  const record = fixture();
  try {
    const { schemaVersion: _schemaVersion, ...missing } = record.input;
    for (const value of [missing, { ...record.input, unexpected: true }]) {
      assert.deepEqual(admit(value, record), {
        ok: false,
        error: { code: "owner_config_invalid", dimension: "schema" },
      });
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("rejects unsafe target URLs and exact identity mismatches", () => {
  const record = fixture();
  try {
    const cases = [
      { url: "http://acme.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345" },
      { url: "https://user:pw@acme.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345" },
      { url: "https://acme.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345?token=x" },
      { url: "https://acme.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345#apply" },
      { url: "https://foreign.wd5.myworkdayjobs.invalid/en-US/Careers/job/Example_R12345" },
      { host: "foreign.wd5.myworkdayjobs.invalid" },
      { tenant: "foreign" },
      { posting: "R99999" },
      { url: "https://acme.example.invalid/en-US/Careers/job/Example_R12345" },
    ];
    for (const target of cases) {
      assert.deepEqual(
        admit({ ...record.input, target: { ...record.input.target, ...target } }, record),
        { ok: false, error: { code: "owner_config_invalid", dimension: "target" } },
      );
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("rejects relative, repository, overlapping, and reparse roots", () => {
  const record = fixture();
  try {
    const replaceRoot = (
      name: "runtime" | "secrets" | "evidence",
      path: string,
    ) => ({
      ...record.input,
      roots: {
        ...record.input.roots,
        [name]: { ...record.input.roots[name], path },
      },
    });

    assert.deepEqual(admit(replaceRoot("runtime", "relative-root"), record), {
      ok: false,
      error: { code: "runtime_root_invalid", dimension: "absolute" },
    });
    assert.deepEqual(admit(replaceRoot("runtime", record.forbidden), record), {
      ok: false,
      error: { code: "runtime_root_invalid", dimension: "repository" },
    });
    assert.deepEqual(
      admit(replaceRoot("secrets", record.input.roots.runtime.path), record),
      { ok: false, error: { code: "secret_root_invalid", dimension: "overlap" } },
    );

    const link = join(record.root, "runtime-link");
    symlinkSync(record.input.roots.runtime.path, link, "junction");
    assert.deepEqual(admit(replaceRoot("runtime", link), record), {
      ok: false,
      error: { code: "runtime_root_invalid", dimension: "reparse" },
    });
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("rejects mismatched approval, retention, adapter, and secret metadata", () => {
  const record = fixture();
  try {
    const cases: readonly [unknown, string][] = [
      [{ ...record.input, policy: { cleanupLeaseHours: 23, retentionDays: 30 } }, "retention"],
      [{ ...record.input, adapters: { ...record.input.adapters, mailboxProvider: "imap-v1" } }, "mailbox_provider"],
      [{ ...record.input, approval: { ...record.input.approval, liveAccess: false } }, "approval"],
      [{ ...record.input, approval: { ...record.input.approval, secretCustodianId: "owner_otherabcdefghijkl" } }, "approval"],
      [{ ...record.input, accountSecret: { ...record.input.accountSecret, journeyId: "journey_otherabcdefghijkl" } }, "account_secret"],
      [{ ...record.input, accountSecret: { ...record.input.accountSecret, consumer: "gmail_auth_executor" } }, "account_secret"],
      [{ ...record.input, accountSecret: { ...record.input.accountSecret, scope: "mailbox_verification" } }, "account_secret"],
      [{ ...record.input, gmailAuthorization: { ...record.input.gmailAuthorization, provider: "other-v1" } }, "gmail_authorization"],
      [{ ...record.input, gmailAuthorization: { ...record.input.gmailAuthorization, expiresAt: "2026-08-01T11:59:59.000Z" } }, "gmail_authorization"],
    ];
    for (const [value, dimension] of cases) {
      assert.deepEqual(admit(value, record), {
        ok: false,
        error: { code: "owner_config_invalid", dimension },
      });
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("failure reports do not echo rejected values", () => {
  const record = fixture();
  try {
    const rejected = resolve(record.forbidden, "private-child");
    const result = admit(
      {
        ...record.input,
        roots: {
          ...record.input.roots,
          evidence: { ...record.input.roots.evidence, path: rejected },
        },
      },
      record,
    );
    assert.deepEqual(result, {
      ok: false,
      error: { code: "evidence_root_invalid", dimension: "missing" },
    });
    assert.equal(JSON.stringify(result).includes(rejected), false);
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("fails closed when repository boundary roots are missing or unreadable", () => {
  const record = fixture();
  try {
    for (const forbiddenRoots of [[], [join(record.root, "missing-repository")]]) {
      assert.deepEqual(
        admitRealRunPreflight(record.input, { now: NOW, forbiddenRoots }),
        {
          ok: false,
          error: {
            code: "owner_config_invalid",
            dimension: "repository_scope",
          },
        },
      );
    }
  } finally {
    rmSync(record.root, { recursive: true, force: true });
  }
});

test("the operator runbook keeps preflight dry and owner inputs external", () => {
  const readme = readFileSync(resolve("README.md"), "utf8").replace(/\s+/gu, " ");
  for (const statement of [
    "## Stage 2 real-run preflight",
    "outside the repository and every worktree",
    "does not launch a browser, contact Gmail or Workday, or resolve a secret",
    "windows-dpapi-current-user-v1",
    "gmail-api-v1",
    "24-hour crash-recovery lease",
    "30-day retention ceiling",
    "Never copy the owner input file into the repository",
  ]) {
    assert.equal(readme.includes(statement), true, statement);
  }
});
