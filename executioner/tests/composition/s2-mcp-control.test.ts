import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { generatedOperationId, journeyId, mcpRequestId, upstreamJobId, upstreamProfileId, upstreamResumeId } from "../../src/contracts/index.ts";
import { applicationProfileFactIds as profileFactIds } from "../../src/profile/application-profile.ts";

const journey = journeyId("journey_abcdefghijklmnop");
const target = upstreamJobId("target_ref_abcdefghijklmnop");
const resume = upstreamResumeId("resume_ref_abcdefghijklmnop");
const profile = upstreamProfileId("profile_ref_abcdefghijklmnop");

interface RetentionScenario {
  readonly preserveAccepted: boolean;
  readonly leaseExpiryAt: string;
  readonly calls: string[];
  readonly observedExpiry: string[];
  releaseAt: number;
  closeCalls: number;
}

let activeRetentionScenario: RetentionScenario | undefined;

const browserFreeDefaultBinding = {
  async bind(invocation: any) {
    const scenario = activeRetentionScenario;
    assert.ok(scenario);
    scenario.calls.push("bind");
    const owner = JSON.parse(readFileSync(invocation.args.configPath, "utf8"));
    return {
      account: {
        async verify() {
          scenario.calls.push("account");
          return {
            ok: true as const,
            proof: {
              schemaVersion: 1 as const,
              proofRevision: "s2-account-session-proof-v1" as const,
              status: "unsealed" as const,
              sourceRevision: invocation.source.sourceRevision,
              configSha256: invocation.config.configSha256,
              revisionId: invocation.config.revisionId,
              approvalId: invocation.config.approvalId,
              journeyId: invocation.config.journeyId,
              targetHandleId: invocation.config.targetHandleId,
              accountState: "application_ready" as const,
              independentlyObservedVerifiedState: true as const,
              verificationProof: "credential_sign_in" as const,
              provider: "workday-auth" as const,
              consumedCandidateCount: 0 as const,
              messageBodyRetained: false as const,
              submitActivated: false as const,
            },
          };
        },
      },
      recovery: { async pending() { return null; } },
      application: {
        async run() {
          return {
            ok: false as const,
            error: {
              completedPages: 0,
              failure: { code: "page_incomplete" },
            },
          } as never;
        },
      },
      review: { async capture() { throw new Error("review must not be reached"); } },
      privacy: { async forbiddenTokens() { return []; } },
      cleanup: {
        async preserve() {
          scenario.calls.push("preserve");
          return scenario.preserveAccepted;
        },
        retentionExpiresAt() {
          const expiry = new Date(Math.min(
            Date.parse(owner.approval.expiresAt),
            Date.parse(scenario.leaseExpiryAt),
          )).toISOString();
          scenario.observedExpiry.push(expiry);
          return expiry;
        },
        async release() {
          scenario.calls.push("release");
          scenario.releaseAt = Date.now();
          return false;
        },
        async close(_signal: AbortSignal, accepted?: boolean) {
          scenario.calls.push(`close:${accepted === true ? "accepted" : "fallback"}`);
          scenario.closeCalls += 1;
          return true;
        },
      },
    };
  },
};

// Replace only the default binding module boundary before composition imports it.
// The MCP composition still selects its real default runner path.
mock.module(import.meta.resolve("../../src/acceptance/s2-production-binding.ts"), {
  namedExports: {
    stage2RealJourneyRuntimeBinding: browserFreeDefaultBinding,
  },
});
const {
  createStage2McpFromPreparedRun,
  captureStage2PreparedMcpRun,
} = await import("../../src/composition/s2-mcp-control.ts");

test("default MCP production journey retains, expires, and falls back without replacing its error", async () => {
  const fixture = preparedFixture();
  try {
    const nativeOwnerAdmission = process.platform === "win32";
    if (nativeOwnerAdmission) protectFixtureForCurrentUser(fixture);
    // Start the retention clock after native ACL setup, not during it.
    const now = Date.now();
    const approvalExpiryAt = new Date(now + 3_000).toISOString();
    const leaseExpiryAt = new Date(now + 6_000).toISOString();
    const approvedAt = new Date(now - 100).toISOString();
    const admittedAt = new Date(now - 50).toISOString();
    const scenario: RetentionScenario = {
      preserveAccepted: true,
      leaseExpiryAt,
      calls: [],
      observedExpiry: [],
      releaseAt: 0,
      closeCalls: 0,
    };
    activeRetentionScenario = scenario;
    const owner = JSON.parse(readFileSync(fixture.paths.ownerConfig, "utf8"));
    Object.assign(owner.approval, { approvedAt, expiresAt: approvalExpiryAt });
    owner.accountSecret.expiresAt = approvalExpiryAt;
    owner.gmailAuthorization.expiresAt = approvalExpiryAt;
    writeFileSync(fixture.paths.ownerConfig, JSON.stringify(owner));
    const profilePath = join(fixture.paths.runtime, "application-profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.approvedAt = approvedAt;
    writeFileSync(profilePath, JSON.stringify(profile));
    const prepared = captureStage2PreparedMcpRun(fixture.args, {
      inspectSource: () => ({
        repositoryRoot: fixture.repositoryRoot,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      }),
      now: () => admittedAt,
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });
    // Native capture requires Windows filesystem permissions; the same fixture
    // exercises the default runner with its captured approval on other systems.
    const api = createStage2McpFromPreparedRun(fixture.args, {
      ...(nativeOwnerAdmission ? {} : { capture: () => prepared }),
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId("operation_defaultmcppath01"),
      }),
    });
    const start = await api.handle({
      schemaVersion: 2,
      requestId: mcpRequestId("request-start-default"),
      method: "start_journey",
      params: {
        jobId: prepared.bound.targetHandleId,
        resumeId: prepared.bound.resumeRef,
        profileId: prepared.bound.profileRef,
      },
    }, new AbortController().signal);
    assert.ok(start.ok && start.value.ok, JSON.stringify(start));

    let result: Awaited<ReturnType<typeof api.handle>> | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      result = await api.handle({
        schemaVersion: 2,
        requestId: mcpRequestId(`request-result-default-${attempt}`),
        method: "journey_result",
        params: { journeyId: prepared.bound.journeyId },
      }, new AbortController().signal);
      if (result.ok && result.value.ok && result.value.result.kind === "terminal") break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    assert.ok(result?.ok && result.value.ok && result.value.result.kind === "terminal", JSON.stringify(result));
    assert.deepEqual(result.value.result.terminal, {
      schemaVersion: 4,
      journeyId: prepared.bound.journeyId,
      status: "failed",
      completedPages: 0,
      errorCode: "page_incomplete",
    });
    assert.deepEqual(scenario.calls.slice(0, 3), ["bind", "account", "preserve"]);
    assert.deepEqual(scenario.observedExpiry, [new Date(Math.min(
      Date.parse(approvalExpiryAt),
      Date.parse(leaseExpiryAt),
    )).toISOString()]);
    for (let attempt = 0; attempt < 300 && scenario.closeCalls === 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(scenario.releaseAt > 0, true);
    assert.equal(scenario.releaseAt >= Date.parse(approvalExpiryAt), true);
    assert.equal(scenario.closeCalls, 1);
    assert.deepEqual(scenario.calls, ["bind", "account", "preserve", "release", "close:fallback"]);
    assert.equal(scenario.releaseAt < Date.parse(leaseExpiryAt), true);
  } finally {
    activeRetentionScenario = undefined;
    fixture.cleanup();
  }
});

function preparedFixture(
  expiresAt = "2026-08-11T00:00:00.000Z",
  approvedAt = "2026-08-10T00:00:00.000Z",
) {
  const root = mkdtempSync(join(tmpdir(), "hunt-s2-mcp-capture-"));
  const repositoryRoot = join(root, "repository");
  const storage = join(root, "storage");
  const runKey = "run_20260810_abcdefghijklmnop";
  const transient = join(storage, "transient", runKey);
  const runtime = join(transient, "runtime");
  const secrets = join(transient, "secrets");
  const evidence = join(storage, "retained", runKey, "evidence");
  for (const path of [repositoryRoot, runtime, secrets, evidence]) {
    mkdirSync(path, { recursive: true });
  }
  const secret = (
    handleId: string,
    purpose: "account_credentials" | "gmail_oauth",
    consumer: "credential_mutation_adapter" | "gmail_auth_executor",
    scope: "account_access" | "mailbox_verification",
  ) => ({
    schemaVersion: 1,
    handleId,
    journeyId: journey,
    provider: "windows-dpapi-current-user-v1",
    purpose,
    consumer,
    scope,
    expiresAt,
  });
  const owner = {
    schemaVersion: 1,
    contractRevision: "s2-owner-inputs-v1",
    revisionId: "revision_abcdefghijklmnop",
    journeyId: journey,
    accountMode: "sign_in",
    target: {
      handleId: target,
      url: "https://example.wd1.myworkdayjobs.invalid/en-US/Careers/job/Test_P12345",
      host: "example.wd1.myworkdayjobs.invalid",
      tenant: "example",
      posting: "P12345",
    },
    profileRef: profile,
    resumeRef: resume,
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
      journeyId: journey,
      revisionId: "revision_abcdefghijklmnop",
      approved: true,
      liveAccess: true,
      approvedAt,
      expiresAt,
      ownerId: "owner_abcdefghijklmnop",
      runtimeOperatorId: "owner_abcdefghijklmnop",
      secretCustodianId: "owner_abcdefghijklmnop",
      evidenceCustodianId: "owner_abcdefghijklmnop",
    },
    adapters: {
      secretStore: "windows-dpapi-current-user-v1",
      mailboxProvider: "gmail-api-v1",
    },
    accountSecret: secret(
      "secret_handle_account123456789",
      "account_credentials",
      "credential_mutation_adapter",
      "account_access",
    ),
    gmailAuthorization: secret(
      "secret_handle_gmail12345678901",
      "gmail_oauth",
      "gmail_auth_executor",
      "mailbox_verification",
    ),
  };
  const configPath = join(transient, "owner-input.json");
  writeFileSync(configPath, JSON.stringify(owner));
  const resumeBytes = Buffer.from("%PDF-1.7\nMCP production fixture\n");
  const resumeSha256 = createHash("sha256").update(resumeBytes).digest("hex");
  writeFileSync(join(runtime, "application-resume.pdf"), resumeBytes);
  writeFileSync(join(runtime, "application-profile.json"), JSON.stringify({
    schemaVersion: 1,
    sourceRevision: "s2-application-owner-source-v1",
    scope: "application_completion",
    revisionId: "revision_abcdefghijklmnop",
    approvalId: "approval_abcdefghijklmnop",
    journeyId: "journey_abcdefghijklmnop",
    targetHandleId: "target_ref_abcdefghijklmnop",
    profileRef: "profile_ref_abcdefghijklmnop",
    resumeRef: "resume_ref_abcdefghijklmnop",
    approvedAt,
    resume: {
      resumeId: "resume_ref_abcdefghijklmnop",
      sha256: resumeSha256,
      sizeBytes: resumeBytes.byteLength,
      fileType: "pdf",
    },
    profile: {
      profileId: "profile_ref_abcdefghijklmnop",
      revision: 1,
      facts: [{
        factId: "given_name",
        value: "Fixture",
        provenance: "owner_provided",
        lane: "live_owner_fact",
      }],
      unsetFactIds: profileFactIds.filter((factId) => factId !== "given_name"),
      discoveredFields: [],
    },
    profilePlan: {
      mode: "live",
      pageType: "profile",
      fields: [{
        fieldId: "identity.given_name",
        questionType: "identity",
        answerType: "text",
        allowedOptions: [],
        answer: {
          kind: "answered",
          value: "Fixture",
          provenance: "owner_provided",
          lane: "live_owner_fact",
        },
      }],
      repeatables: [],
    },
    narrative: { revision: "narrative-v1" },
  }));
  return {
    root,
    repositoryRoot,
    args: { configPath, evidenceRoot: evidence },
    paths: { runtime, secrets, evidence, ownerConfig: configPath },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function protectFixtureForCurrentUser(fixture: ReturnType<typeof preparedFixture>): void {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($index in 0..2) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($current)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', $inherit, $propagation, $allow))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', $inherit, $propagation, $allow))
  [System.IO.Directory]::SetAccessControl($paths[$index], $acl)
}
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', 'Allow'))
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', 'Allow'))
[System.IO.File]::SetAccessControl($paths[3], $acl)
`;
  const result = spawnSync(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      input: JSON.stringify([
        fixture.paths.runtime,
        fixture.paths.secrets,
        fixture.paths.evidence,
        fixture.paths.ownerConfig,
      ]),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      // A cold PowerShell process can exceed ten seconds on a hosted Windows runner.
      timeout: 60_000,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0);
}
