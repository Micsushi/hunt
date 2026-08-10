import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  generatedOperationId,
  journeyId,
  mcpRequestId,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  type McpRequest,
} from "../../src/contracts/index.ts";
import {
  createStage2McpFromPreparedRun,
  captureStage2PreparedMcpRun,
  type Stage2PreparedMcpCapture,
} from "../../src/composition/s2-mcp-control.ts";

const args = {
  configPath: resolve("protected", "transient", "run_20260810_abcdefghijklmnop", "owner-input.json"),
  evidenceRoot: resolve("protected", "retained", "run_20260810_abcdefghijklmnop", "evidence"),
};
const journey = journeyId("journey_abcdefghijklmnop");
const target = upstreamJobId("target_ref_abcdefghijklmnop");
const resume = upstreamResumeId("resume_ref_abcdefghijklmnop");
const profile = upstreamProfileId("profile_ref_abcdefghijklmnop");

function capture(): Stage2PreparedMcpCapture {
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

function preparedFixture() {
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
  const expiresAt = "2026-08-11T00:00:00.000Z";
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
      approvedAt: "2026-08-10T00:00:00.000Z",
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
  return {
    root,
    repositoryRoot,
    args: { configPath, evidenceRoot: evidence },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
