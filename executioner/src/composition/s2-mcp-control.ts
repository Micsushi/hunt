import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGeneratedIdAllocator,
  journeyId,
  upstreamJobId,
  upstreamProfileId,
  upstreamResumeId,
  type OperationId,
  type OperationIdentityError,
  type PortResult,
} from "../contracts/index.ts";
import {
  createStage2McpControl,
  type Stage2McpBoundJourney,
  type Stage2McpControl,
} from "../control/mcp/stage2-control.ts";
import {
  createPrivateRealRunAdmission,
} from "../live/preflight/private/runtime-binding.ts";
import type { WindowsAclAdmissionPaths, WindowsAclAdmissionResult } from "../live/preflight/private/windows-acl.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import {
  runStage2RealJourney,
  type Stage2RealJourneyInvocation,
  type Stage2RealJourneyRuntimeBinding,
  type Stage2RealJourneyResult,
} from "../acceptance/s2-journey.ts";
import { writeStage2ReviewAcceptance } from "../acceptance/s2-local.ts";
import { stage2RealJourneyRuntimeBinding } from "../acceptance/s2-production-binding.ts";
import type { Stage2RealAcceptanceArgs } from "../acceptance/s2-gate.ts";
import {
  inspectCleanSourceRevision,
  type CleanSourceRevision,
} from "./private/s2-clean-source-revision.ts";
import { matchesStage2OwnerStorageBinding } from "./private/s2-owner-storage-binding.ts";
import { readStablePrivateFile } from "./private/s2-stable-private-file.ts";

export interface Stage2PreparedMcpCapture {
  readonly invocation: Stage2RealJourneyInvocation;
  readonly bound: Stage2McpBoundJourney;
}

export interface Stage2PreparedMcpCaptureOptions {
  readonly inspectSource?: () => CleanSourceRevision;
  readonly now?: () => string;
  readonly aclAdmission?: {
    admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult;
  };
}

export interface Stage2McpCompositionDependencies {
  readonly capture?: (args: Stage2RealAcceptanceArgs) => Stage2PreparedMcpCapture;
  readonly journeyBinding?: Stage2RealJourneyRuntimeBinding;
  readonly nextOperationId?: () => PortResult<OperationId, OperationIdentityError>;
  readonly run?: (
    invocation: Stage2RealJourneyInvocation,
    signal: AbortSignal,
  ) => Promise<Stage2RealJourneyResult>;
}

export function createStage2McpFromPreparedRun(
  args: Stage2RealAcceptanceArgs,
  dependencies: Stage2McpCompositionDependencies = {},
): Stage2McpControl {
  const captured = (dependencies.capture ?? captureStage2PreparedMcpRun)(args);
  const run = dependencies.run ?? ((invocation, signal) =>
    runPreparedJourney(invocation, signal, dependencies.journeyBinding));
  const ids = createGeneratedIdAllocator({
    next: () => randomBytes(16).toString("hex"),
  });
  return createStage2McpControl({
    bound: captured.bound,
    nextOperationId: dependencies.nextOperationId ?? ids.operationId,
    run: async (signal) => (await run(captured.invocation, signal)).terminal,
  });
}

export function captureStage2PreparedMcpRun(
  args: Stage2RealAcceptanceArgs,
  options: Stage2PreparedMcpCaptureOptions = {},
): Stage2PreparedMcpCapture {
  const executionerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const source = (options.inspectSource ?? (() =>
    inspectCleanSourceRevision(executionerRoot)))();
  const config = readStablePrivateFile(args.configPath, 64 * 1024);
  const configSha256 = createHash("sha256").update(config.bytes).digest("hex");
  let value: unknown;
  try {
    value = JSON.parse(config.bytes.toString("utf8"));
  } catch {
    throw new TypeError("Stage 2 MCP preparation denied");
  } finally {
    config.bytes.fill(0);
  }
  const admission = createPrivateRealRunAdmission(value, {
    now: (options.now ?? (() => new Date().toISOString()))(),
    forbiddenRoots: [source.repositoryRoot],
    ownerConfigPath: config.canonicalPath,
    ...(options.aclAdmission === undefined
      ? {}
      : { aclAdmission: options.aclAdmission }),
  });
  if (!admission.ok) throw new TypeError("Stage 2 MCP preparation denied");
  const owner = value as RealRunOwnerInputsV1;
  if (!matchesStage2OwnerStorageBinding({
    ownerConfigPath: config.canonicalPath,
    runtimeRoot: owner.roots.runtime.path,
    ownerEvidenceRoot: owner.roots.evidence.path,
    requestedEvidenceRoot: args.evidenceRoot,
  })) throw new TypeError("Stage 2 MCP preparation denied");

  const report = admission.report;
  const bound = Object.freeze({
    journeyId: journeyId(report.journeyId),
    targetHandleId: upstreamJobId(report.targetHandleId),
    resumeRef: upstreamResumeId(report.resumeRef),
    profileRef: upstreamProfileId(report.profileRef),
  });
  return Object.freeze({
    bound,
    invocation: Object.freeze({
      args: Object.freeze({
        configPath: config.canonicalPath,
        evidenceRoot: args.evidenceRoot,
      }),
      source: Object.freeze({
        repositoryRoot: source.repositoryRoot,
        sourceRevision: source.sourceRevision,
      }),
      config: Object.freeze({
        configSha256,
        contractRevision: report.contractRevision,
        revisionId: report.revisionId,
        approvalId: report.approvalId,
        journeyId: bound.journeyId,
        targetHandleId: bound.targetHandleId,
      }),
    }),
  });
}

async function runPreparedJourney(
  invocation: Stage2RealJourneyInvocation,
  signal: AbortSignal,
  binding: Stage2RealJourneyRuntimeBinding = stage2RealJourneyRuntimeBinding,
): Promise<Stage2RealJourneyResult> {
  return runStage2RealJourney(
    invocation,
    binding,
    {
      now: () => new Date().toISOString(),
      writeAcceptance: async (root, value) => {
        writeStage2ReviewAcceptance(root, value, []);
      },
    },
    signal,
  );
}
