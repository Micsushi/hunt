import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { mock } from "node:test";

import {
  generatedOperationId,
  journeyId,
  mcpRequestId,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  type McpRequest,
} from "../../src/contracts/index.ts";
import { runStage2RealJourney } from "../../src/acceptance/s2-journey.ts";
import { readStage2TerminalArtifact, writeStage2TerminalArtifact } from
  "../../src/acceptance/s2-terminal-artifact.ts";
import { completeWorkdayProfilePage } from
  "../../src/ats/workday/application/profile/index.ts";
import { createValueFreeRunTrace, readValueFreeRunTrace } from
  "../../src/live/evidence/value-free-run-trace.ts";
import { applicationProfileFactIds as profileFactIds } from
  "../../src/profile/application-profile.ts";

const args = {
  configPath: resolve("protected", "transient", "run_20260810_abcdefghijklmnop", "owner-input.json"),
  evidenceRoot: resolve("protected", "retained", "run_20260810_abcdefghijklmnop", "evidence"),
};
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

function capture() {
  return {
    invocation: {
      args,
      source: {
        repositoryRoot: resolve("repository"),
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      },
      config: {
        configSha256: "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
        contractRevision: "s2-owner-inputs-v1",
        revisionId: "revision_abcdefghijklmnop",
        approvalId: "approval_abcdefghijklmnop",
        journeyId: journey,
        targetHandleId: target,
      },
    },
    bound: {
      journeyId: journey,
      targetHandleId: target,
      resumeRef: resume,
      profileRef: profile,
    },
  };
}

function request(requestId: string, jobId = target): McpRequest {
  return {
    schemaVersion: 2,
    requestId: mcpRequestId(requestId),
    method: "start_journey",
    params: { jobId, resumeId: resume, profileId: profile },
  };
}

test("prepared-run MCP composition retains paths out of band and runs only exact opaque bindings", async () => {
  let runs = 0;
  const api = createStage2McpFromPreparedRun(args, {
    capture(preparedArgs) {
      assert.deepEqual(preparedArgs, args);
      return capture();
    },
    nextOperationId: () => ({
      ok: true,
      value: generatedOperationId("operation_abcdefghijklmnop"),
    }),
    async run(invocation) {
      runs += 1;
      assert.deepEqual(invocation, capture().invocation);
      return {
        ok: true,
        acceptance: {} as never,
        terminal: {
          schemaVersion: 4,
          journeyId: journey,
          status: "review_reached",
          completedPages: 3,
        },
      };
    },
  });

  const denied = await api.handle(
    request("request-denied", upstreamJobId("target_ref_wrongwrongwrong1")),
    new AbortController().signal,
  );
  assert.equal(denied.ok, true);
  if (!denied.ok || denied.value.ok) return;
  assert.equal(denied.value.error.code, "journey_input_invalid");
  assert.equal(runs, 0);

  const accepted = await api.handle(
    request("request-accepted"),
    new AbortController().signal,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.value.ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  const serialized = JSON.stringify(accepted.value);
  assert.equal(serialized.includes(args.configPath), false);
  assert.equal(serialized.includes(args.evidenceRoot), false);
  assert.doesNotMatch(serialized, /selector|submit|https?:/iu);
});

test("prepared-run MCP maps manual intervention and cancellation to factual v4 terminals", async () => {
  for (const [code, status] of [
    ["mfa", "blocked"],
    ["operation_cancelled", "cancelled"],
  ] as const) {
    const api = createStage2McpFromPreparedRun(args, {
      capture,
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId(`operation_${code.padEnd(16, "x")}`),
      }),
      async run() {
        return {
          ok: false as const,
          code,
          terminal: code === "operation_cancelled"
            ? {
                schemaVersion: 4 as const,
                journeyId: journey,
                status: "cancelled" as const,
                completedPages: 0,
              }
            : {
                schemaVersion: 4 as const,
                journeyId: journey,
                status: "blocked" as const,
                completedPages: 0,
                factualOutcome: {
                  source: "account_access" as const,
                  result: { kind: "manual_intervention" as const, reason: code },
                },
              },
        };
      },
    });
    await api.handle(request(`request-start-${code}`), new AbortController().signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await api.handle({
      schemaVersion: 2,
      requestId: mcpRequestId(`request-result-${code}`),
      method: "journey_result",
      params: { journeyId: journey },
    }, new AbortController().signal);
    assert.equal(result.ok, true);
    if (!result.ok || !result.value.ok || result.value.result.kind !== "terminal") continue;
    assert.equal(result.value.result.terminal.status, status);
    if (code === "mfa") {
      assert.deepEqual(result.value.result.terminal, {
        schemaVersion: 4,
        journeyId: journey,
        status: "blocked",
        completedPages: 0,
        factualOutcome: {
          source: "account_access",
          result: { kind: "manual_intervention", reason: "mfa" },
        },
      });
    }
  }
});

test("prepared-run MCP preserves the journey's exact factual terminal and page count", async () => {
  const exactTerminal = {
    schemaVersion: 4 as const,
    journeyId: journey,
    status: "blocked" as const,
    completedPages: 2,
    factualOutcome: {
      source: "target_identity" as const,
      result: {
        kind: "posting_unavailable" as const,
        reason: "closed" as const,
      },
    },
  };
  const api = createStage2McpFromPreparedRun(args, {
    capture,
    nextOperationId: () => ({
      ok: true,
      value: generatedOperationId("operation_exactterminal0001"),
    }),
    async run() {
      return {
        ok: false,
        code: "account_verification_failed",
        terminal: exactTerminal,
      } as never;
    },
  });
  await api.handle(request("request-exact-start"), new AbortController().signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const result = await api.handle({
    schemaVersion: 2,
    requestId: mcpRequestId("request-exact-result"),
    method: "journey_result",
    params: { journeyId: journey },
  }, new AbortController().signal);
  assert.equal(result.ok, true);
  if (!result.ok || !result.value.ok || result.value.result.kind !== "terminal") return;
  assert.deepEqual(result.value.result.terminal, exactTerminal);
});

test("default MCP production journey retains, expires, and falls back without replacing its error", async () => {
  const approvalExpiryAt = new Date(Date.now() + 3_000).toISOString();
  const leaseExpiryAt = new Date(Date.now() + 6_000).toISOString();
  const approvedAt = new Date(Date.now() - 100).toISOString();
  const admittedAt = new Date(Date.now() - 50).toISOString();
  const fixture = preparedFixture(approvalExpiryAt, approvedAt);
  const scenario: RetentionScenario = {
    preserveAccepted: true,
    leaseExpiryAt,
    calls: [],
    observedExpiry: [],
    releaseAt: 0,
    closeCalls: 0,
  };
  activeRetentionScenario = scenario;
  try {
    protectFixtureForCurrentUser(fixture);
    const prepared = captureStage2PreparedMcpRun(fixture.args, {
      inspectSource: () => ({
        repositoryRoot: fixture.repositoryRoot,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      }),
      now: () => admittedAt,
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });
    const api = createStage2McpFromPreparedRun(fixture.args, {
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
    assert.equal(start.ok, true);
    if (!start.ok || !start.value.ok) return;

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
    assert.equal(result?.ok, true);
    if (!result?.ok || !result.value.ok || result.value.result.kind !== "terminal") return;
    assert.deepEqual(result.value.result.terminal, {
      schemaVersion: 4,
      journeyId: prepared.bound.journeyId,
      status: "failed",
      completedPages: 0,
      errorCode: "page_incomplete",
    });
    assert.deepEqual(scenario.calls, ["bind", "account", "preserve"]);
    assert.deepEqual(scenario.observedExpiry, [new Date(Math.min(
      Date.parse(approvalExpiryAt),
      Date.parse(leaseExpiryAt),
    )).toISOString()]);
    for (let attempt = 0; attempt < 300 && scenario.closeCalls === 0; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(scenario.releaseAt > 0, true);
    assert.equal(scenario.closeCalls, 1);
    assert.deepEqual(scenario.calls, ["bind", "account", "preserve", "release", "close:fallback"]);
    assert.equal(scenario.releaseAt < Date.parse(leaseExpiryAt), true);
  } finally {
    activeRetentionScenario = undefined;
    fixture.cleanup();
  }
});

test("default MCP production result preserves artifact persistence failure beside its primary terminal", async () => {
  const primaryTerminal = {
    schemaVersion: 4 as const,
    journeyId: journey,
    status: "failed" as const,
    completedPages: 0,
    errorCode: "owner_config_invalid" as const,
  };
  const api = createStage2McpFromPreparedRun(args, {
    capture: () => capture(),
    nextOperationId: () => ({
      ok: true,
      value: generatedOperationId("operation_defaultmcpaux0001"),
    }),
    async run(invocation, signal) {
      return runStage2RealJourney(invocation, undefined, {
        now: () => "2026-08-23T15:00:00.000Z",
        async writeAcceptance() {},
        async writeTerminalArtifact() {
          throw new Error("injected terminal artifact persistence failure");
        },
      }, signal);
    },
  });
  const start = await api.handle(request("request-aux-start"), new AbortController().signal);
  assert.equal(start.ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const result = await api.handle({
    schemaVersion: 2,
    requestId: mcpRequestId("request-aux-result"),
    method: "journey_result",
    params: { journeyId: journey },
  }, new AbortController().signal);
  assert.deepEqual(result, {
    ok: true,
    value: {
      schemaVersion: 4,
      requestId: "request-aux-result",
      ok: true,
      result: {
        kind: "terminal",
        terminal: primaryTerminal,
        terminalArtifactErrorCode: "terminal_artifact_persistence_failed",
      },
    },
  });
});

test("browser-free production mismatch bridges learning, retention, terminal, and completion storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-release-readiness-composed-"));
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot);
  const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
  const mismatch = {
    code: "profile_metadata_reconciliation_failed" as const,
    mismatches: [{
      fieldId: "profile.address.country",
      uiBehavior: "search_select" as const,
      uiVariant: "workday_search_select_v2",
      reasons: ["option_catalog" as const],
    }],
  };
  const blocked = await completeWorkdayProfilePage(
    { mode: "live", pageType: "profile", fields: [], repeatables: [] },
    {
      async inspect() { throw new TypeError("profile metadata reconciliation failed"); },
      metadataReconciliationFailure: () => mismatch,
      async commit() {},
      async addOwnedRow() { throw new TypeError("not used"); },
      async removeOwnedRow() { throw new TypeError("not used"); },
    },
    AbortSignal.any([]),
  );
  assert.equal(blocked.kind, "blocked");
  if (blocked.kind !== "blocked" || blocked.learningConversion === undefined) return;
  const trace = createValueFreeRunTrace(evidenceRoot, () => undefined);
  trace("profile_reconciliation_blocked", {
    learningConversion: blocked.learningConversion.kind,
    executionMode: blocked.learningConversion.executionMode,
    testOnly: blocked.learningConversion.testOnly,
    mutationAllowed: blocked.learningConversion.mutationAllowed,
    defaultsGenerated: blocked.learningConversion.defaultsGenerated,
    learningFieldIds: blocked.learningConversion.fieldIds,
    learningFieldReasons: blocked.learningConversion.affected.flatMap(({ fieldId, reasons }) =>
      reasons.map((reason) => `${fieldId}.${reason}`)
    ),
  });

  const calls: string[] = [];
  const acceptanceWrites: unknown[] = [];
  const invocation = {
    args: { configPath: join(root, "owner-input.json"), evidenceRoot },
    source: { repositoryRoot: root, sourceRevision },
    config: {
      configSha256: "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      contractRevision: "s2-owner-inputs-v1",
      revisionId: "revision_abcdefghijklmnop",
      approvalId: "approval_abcdefghijklmnop",
      journeyId: journey,
      targetHandleId: target,
    },
  } as const;
  const result = await runStage2RealJourney(invocation, {
    async bind() {
      return {
        account: {
          async verify() {
            return {
              ok: true as const,
              proof: {
                schemaVersion: 1 as const,
                proofRevision: "s2-account-session-proof-v1" as const,
                status: "unsealed" as const,
                sourceRevision,
                configSha256: invocation.config.configSha256,
                revisionId: invocation.config.revisionId,
                approvalId: invocation.config.approvalId,
                journeyId: invocation.config.journeyId,
                targetHandleId: invocation.config.targetHandleId,
                accountState: "application_ready" as const,
                independentlyObservedVerifiedState: true as const,
                verificationProof: "application_state_observed" as const,
                provider: "workday-state" as const,
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
            calls.push("application:mismatch");
            return {
              ok: false as const,
              error: { completedPages: 1, failure: { code: "page_incomplete" } },
            } as never;
          },
        },
        review: { async capture() { throw new Error("review must not run"); } },
        privacy: { async forbiddenTokens() { return ["value-free"]; } },
        cleanup: {
          async preserve() { calls.push("preserve"); return true; },
          retentionExpiresAt() { return new Date(Date.now() + 20).toISOString(); },
          async release() { calls.push("release"); return true; },
          async close() { calls.push("close"); return true; },
        },
      };
    },
  }, {
    now: () => "2026-08-23T15:00:00.000Z",
    async writeAcceptance(_root, value) { acceptanceWrites.push(value); },
    async writeTerminalArtifact(rootValue, value) {
      writeStage2TerminalArtifact(rootValue, value);
    },
  }, new AbortController().signal);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "pre_review_failed");
  assert.equal(result.terminal.status, "failed");
  if (result.terminal.status !== "failed") return;
  assert.equal(result.terminal.errorCode, "page_incomplete");
  assert.deepEqual(acceptanceWrites, []);
  assert.deepEqual(calls, ["application:mismatch", "preserve"]);
  for (let attempt = 0; attempt < 40 && !calls.includes("release"); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.equal(calls.includes("release"), true);
  assert.deepEqual(readStage2TerminalArtifact(evidenceRoot).terminal, result.terminal);
  assert.deepEqual(readValueFreeRunTrace(join(evidenceRoot, "value-free-trace.ndjson"))[0]?.details, {
    learningConversion: "profile_ui_learning",
    executionMode: "synthetic_test_non_submittable",
    testOnly: true,
    mutationAllowed: false,
    defaultsGenerated: false,
    learningFieldIds: ["profile.address.country"],
    learningFieldReasons: ["profile.address.country.option_catalog"],
  });
  rmSync(root, { recursive: true, force: true });
});

test("prepared-run capture admits one exact owner config and evidence binding", () => {
  const fixture = preparedFixture();
  try {
    const captured = captureStage2PreparedMcpRun(fixture.args, {
      inspectSource: () => ({
        repositoryRoot: fixture.repositoryRoot,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      }),
      now: () => "2026-08-10T12:00:00.000Z",
      aclAdmission: { admit: () => ({ ok: true as const }) },
    });
    assert.deepEqual(captured.bound, {
      journeyId: journey,
      targetHandleId: target,
      resumeRef: resume,
      profileRef: profile,
    });
    assert.equal(
      captured.invocation.config.configSha256,
      createHash("sha256").update(readFileSync(fixture.args.configPath)).digest("hex"),
    );
    assert.throws(() => captureStage2PreparedMcpRun({
      ...fixture.args,
      evidenceRoot: join(fixture.root, "wrong-evidence"),
    }, {
      inspectSource: () => ({
        repositoryRoot: fixture.repositoryRoot,
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      }),
      now: () => "2026-08-10T12:00:00.000Z",
      aclAdmission: { admit: () => ({ ok: true as const }) },
    }), /preparation denied/u);
  } finally {
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
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0);
}
