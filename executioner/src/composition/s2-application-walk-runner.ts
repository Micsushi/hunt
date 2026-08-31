import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApplicationCheckpoint } from "../ats/workday/application/page-walk.ts";
import {
  disposeResumeArtifact,
} from "../contracts/index.ts";
import {
  earliestStage2Cause,
  stage2CausalCode,
  stage2CausalError,
} from "../contracts/s2-causal-error.ts";
import {
  s2StableErrorPolicy,
  type S2StableErrorCode,
} from "../contracts/s2-common-wire.ts";
import type { Stage2UnsealedAccountProofResult } from
  "./s2-account-verified-runner.ts";
import {
  createQuestionAnswerLearningCapture,
  type QuestionAnswerLearningCapture,
} from
  "../live/evidence/question-answer-learning.ts";
import type { RealRunRuntimeBinding } from "../live/preflight/private/runtime-binding.ts";
import {
  createPrivateRealRunAdmission,
} from "../live/preflight/private/runtime-binding.ts";
import type { WindowsAclAdmissionResult, WindowsAclAdmissionPaths } from "../live/preflight/private/windows-acl.ts";
import type { RealRunOwnerInputsV1 } from "../live/preflight/types.ts";
import { writeApplicationWalkEvidence } from "../live/evidence/application-walk-evidence.ts";
import {
  runStage2ApplicationWalk,
  type Stage2ApplicationWalkDependencies,
  type Stage2ApplicationWalkInput,
  type Stage2ApplicationWalkResult,
} from "../live/runner/application-walk.ts";
import {
  FileBackedStage2ApplicationOwnerSourceResolver,
  type Stage2ApplicationOwnerSourceResolver,
  type Stage2ApplicationOwnerSources,
} from "./private/s2-application-owner-source.ts";
import {
  inspectCleanSourceRevision,
  type CleanSourceRevision,
} from "./private/s2-clean-source-revision.ts";
import { matchesStage2OwnerStorageBinding } from "./private/s2-owner-storage-binding.ts";
import { readStablePrivateFile } from "./private/s2-stable-private-file.ts";

export interface Stage2ApplicationWalkProductionOptions {
  readonly configPath: string;
  readonly evidenceRoot: string;
  readonly checkpoint: ApplicationCheckpoint;
}

export interface Stage2ApplicationWalkProductionBinding {
  bind(
    options: Stage2ApplicationWalkProductionOptions,
    signal: AbortSignal,
  ): Promise<{
    readonly input: Stage2ApplicationWalkInput;
    readonly dependencies: Stage2ApplicationWalkDependencies;
    readonly account?: {
      verify(signal: AbortSignal): Promise<Stage2UnsealedAccountProofResult>;
    };
  }>;
}

export interface Stage2ApplicationWalkRuntimeBindingRequest {
  readonly owner: RealRunOwnerInputsV1;
  readonly ownerBinding: RealRunRuntimeBinding;
  readonly ownerSources: Stage2ApplicationOwnerSources;
  readonly sourceRevision: string;
  readonly configSha256: string;
  readonly questionLearning?: QuestionAnswerLearningCapture;
}

export interface Stage2ApplicationWalkRuntimeBinding {
  bind(
    request: Stage2ApplicationWalkRuntimeBindingRequest,
    signal: AbortSignal,
  ): Promise<Omit<Stage2ApplicationWalkDependencies, "evidence"> & {
    readonly account?: {
      verify(signal: AbortSignal): Promise<Stage2UnsealedAccountProofResult>;
    };
  }>;
}

export interface Stage2ApplicationWalkProductionBindingOptions {
  readonly runtime: Stage2ApplicationWalkRuntimeBinding;
  readonly outerProcessCleanup?: boolean;
  readonly resolver?: Stage2ApplicationOwnerSourceResolver;
  readonly inspectSource?: () => CleanSourceRevision;
  readonly now?: () => string;
  readonly aclAdmission?: {
    admit(paths: WindowsAclAdmissionPaths): WindowsAclAdmissionResult;
  };
}

export function createStage2ApplicationWalkProductionBinding(
  dependencies: Stage2ApplicationWalkProductionBindingOptions,
): Stage2ApplicationWalkProductionBinding {
  return Object.freeze({
    async bind(
      options: Stage2ApplicationWalkProductionOptions,
      signal: AbortSignal,
    ) {
      if (signal.aborted) {
        throw stage2CausalError("cancellation", "operation_cancelled");
      }
      const executionerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
      const source = causalStep("source_admission", "owner_config_invalid", () =>
        (dependencies.inspectSource ?? (() => inspectCleanSourceRevision(executionerRoot)))()
      );
      const config = causalStep("source_admission", "owner_config_invalid", () =>
        readStablePrivateFile(options.configPath, 64 * 1024)
      );
      const configPath = config.canonicalPath;
      const configSha256 = createHash("sha256").update(config.bytes).digest("hex");
      const value = causalStep("source_admission", "owner_config_invalid", () =>
        readOwnerConfig(config.bytes)
      );
      const now = (dependencies.now ?? (() => new Date().toISOString()))();
      const admission = causalStep("source_admission", "owner_config_invalid", () =>
        createPrivateRealRunAdmission(value, {
        now,
        forbiddenRoots: [source.repositoryRoot],
        ownerConfigPath: configPath,
        ...(dependencies.aclAdmission === undefined
          ? {}
          : { aclAdmission: dependencies.aclAdmission }),
        })
      );
      if (!admission.ok) {
        throw stage2CausalError("source_admission", "owner_config_invalid");
      }
      const owner = value as RealRunOwnerInputsV1;
      if (!causalStep("source_admission", "owner_config_invalid", () =>
        matchesStage2OwnerStorageBinding({
        ownerConfigPath: configPath,
        runtimeRoot: owner.roots.runtime.path,
        ownerEvidenceRoot: owner.roots.evidence.path,
        requestedEvidenceRoot: options.evidenceRoot,
        })
      )) throw stage2CausalError("source_admission", "owner_config_invalid");
      const resolver = dependencies.resolver ??
        new FileBackedStage2ApplicationOwnerSourceResolver({
          forbiddenRoots: [source.repositoryRoot],
        });
      const resolvedOwnerSources = await causalStepAsync(
        "source_admission",
        "owner_config_invalid",
        async () => await resolver.resolve({
          runtimeRoot: owner.roots.runtime.path,
          revisionId: owner.revisionId,
          approvalId: owner.approval.approvalId,
          journeyId: owner.journeyId,
          targetHandleId: owner.target.handleId,
          profileRef: owner.profileRef,
          resumeRef: owner.resumeRef,
          approvedAt: owner.approval.approvedAt,
        }, signal),
      );
      let ownerSources: typeof resolvedOwnerSources | undefined = resolvedOwnerSources;
      let sensitiveValues: readonly string[] | undefined = applicationSensitiveValues(
        owner,
        resolvedOwnerSources,
        configPath,
      );
      let runtime: Awaited<ReturnType<Stage2ApplicationWalkRuntimeBinding["bind"]>>;
      try {
        const questionLearning = createQuestionAnswerLearningCapture({
          root: owner.roots.evidence.path,
          mode: resolvedOwnerSources.profilePlan.mode,
          executionPolicy: resolvedOwnerSources.executionPolicy,
          sensitiveValues: resolvedOwnerSources.sensitiveValues,
        });
        runtime = await dependencies.runtime.bind({
          owner,
          ownerBinding: admission.binding,
          ownerSources: resolvedOwnerSources,
          sourceRevision: source.sourceRevision,
          configSha256,
          questionLearning,
        }, signal);
      } catch (error) {
        disposeOwnerResume(resolvedOwnerSources);
        ownerSources = undefined;
        sensitiveValues = undefined;
        throw stage2CausalError(
          signal.aborted ? "cancellation" : "browser_launch_binding",
          signal.aborted ? "operation_cancelled" : "browser_session_missing",
          error,
        );
      }
      const { account, ...walkRuntime } = runtime;
      return Object.freeze({
        input: Object.freeze({
          executionPolicy: resolvedOwnerSources.executionPolicy,
          sourceRevision: source.sourceRevision,
          configSha256,
          revisionId: owner.revisionId,
          approvalId: owner.approval.approvalId,
          journeyId: owner.journeyId as Stage2ApplicationWalkInput["journeyId"],
          targetHandleId: owner.target.handleId,
          stopAfter: options.checkpoint,
        }),
        dependencies: Object.freeze({
          ...walkRuntime,
          cleanup: Object.freeze({
            ...(runtime.cleanup.preserve === undefined ? {} : {
              preserve: async (cleanupSignal: AbortSignal): Promise<boolean> =>
                await runtime.cleanup.preserve!(cleanupSignal),
            }),
            ...(runtime.cleanup.release === undefined ? {} : {
              release: async (cleanupSignal: AbortSignal): Promise<boolean> => {
                let released = false;
                try {
                  released = await runtime.cleanup.release!(cleanupSignal);
                  return released;
                } finally {
                  if (released && ownerSources !== undefined) {
                    disposeOwnerResume(ownerSources);
                    ownerSources = undefined;
                    sensitiveValues = undefined;
                  }
                }
              },
            }),
            ...(runtime.cleanup.retentionExpiresAt === undefined ? {} : {
              retentionExpiresAt: runtime.cleanup.retentionExpiresAt,
            }),
            async close(
              cleanupSignal: AbortSignal,
              accepted?: boolean,
            ): Promise<boolean> {
              let cleaned = false;
              try {
                cleaned = await runtime.cleanup.close(cleanupSignal, accepted);
                return cleaned;
              } finally {
                if (ownerSources !== undefined) disposeOwnerResume(ownerSources);
                ownerSources = undefined;
                if (
                  (!cleaned && !(accepted === true && dependencies.outerProcessCleanup === true)) ||
                  accepted === false
                ) sensitiveValues = undefined;
              }
            },
          }),
          evidence: Object.freeze({
            async write(
              acceptance: Parameters<
                Stage2ApplicationWalkDependencies["evidence"]["write"]
              >[0],
            ): Promise<void> {
              if (sensitiveValues === undefined) {
                throw new TypeError("application evidence source revoked");
              }
              try {
                await writeApplicationWalkEvidence({
                  root: options.evidenceRoot,
                  acceptance,
                  sensitiveValues,
                });
              } finally {
                sensitiveValues = undefined;
              }
            },
          }),
        }),
        ...(account === undefined ? {} : { account }),
      });
    },
  });
}

/**
 * CLI-facing F3 seam. A caller must inject the live application runtime through
 * createStage2ApplicationWalkProductionBinding. The default file resolver owns
 * opaque resume/profile resolution; the runtime owns fresh browser truth only.
 * No injected runtime means no browser or evidence effects.
 */
export async function runStage2ApplicationWalkFromOwnerConfig(
  options: Stage2ApplicationWalkProductionOptions,
  signal: AbortSignal,
  binding?: Stage2ApplicationWalkProductionBinding,
): Promise<Stage2ApplicationWalkResult> {
  if (binding === undefined || signal.aborted) {
    return {
      ok: false,
      code: signal.aborted ? "operation_cancelled" : "owner_config_invalid",
    };
  }
  try {
    const resolved = await binding.bind(options, signal);
    if (resolved.account !== undefined) {
      let account: Awaited<ReturnType<NonNullable<typeof resolved.account>["verify"]>>;
      try {
        account = await causalStepAsync(
          "authentication",
          "verification_input_invalid",
          async () => await resolved.account!.verify(signal),
        );
      } catch (error) {
        try {
          await resolved.dependencies.cleanup.close(new AbortController().signal);
        } catch {
          // Cleanup is secondary; the authenticated stage failure remains earliest.
        }
        throw error;
      }
      if (!account.ok) {
        try {
          await resolved.dependencies.cleanup.close(new AbortController().signal);
        } catch {
          // Cleanup is secondary; the provider/account fact remains earliest.
        }
        return account.fact === undefined
          ? { ok: false, code: stableAccountCode(account.code) }
          : { ok: false, code: account.fact.kind, fact: account.fact };
      }
    }
    return await runStage2ApplicationWalk(
      resolved.input,
      resolved.dependencies,
      signal,
    );
  } catch (error) {
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1") {
      const stage = earliestStage2Cause(error)?.layer ??
        (error instanceof TypeError && error.message === "external monitor process binding denied"
          ? "observer_evidence"
          : error instanceof TypeError && error.message === "application owner source denied"
          ? "source_admission"
          : "source_admission");
      try { process.stderr.write(`${JSON.stringify({ applicationBindingFailure: stage })}\n`); } catch {}
    }
    return {
      ok: false,
      code: signal.aborted
        ? "operation_cancelled"
        : stage2CausalCode(error, "owner_config_invalid"),
    };
  }
}

function causalStep<T>(
  layer: Parameters<typeof stage2CausalError>[0],
  code: S2StableErrorCode,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    throw stage2CausalError(layer, code, error);
  }
}

async function causalStepAsync<T>(
  layer: Parameters<typeof stage2CausalError>[0],
  code: S2StableErrorCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw stage2CausalError(layer, code, error);
  }
}

function stableAccountCode(value: string): S2StableErrorCode {
  return Object.hasOwn(s2StableErrorPolicy, value)
    ? value as S2StableErrorCode
    : "verification_input_invalid";
}

function readOwnerConfig(bytes: Buffer): unknown {
  try {
    if (
      bytes.byteLength < 2 ||
      bytes.byteLength > 64 * 1024 ||
      (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    ) throw new TypeError("application binding denied");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
  }
}

function applicationSensitiveValues(
  owner: RealRunOwnerInputsV1,
  sources: Stage2ApplicationOwnerSources,
  configPath: string,
): readonly string[] {
  const values = new Set<string>([
    owner.target.url,
    owner.target.host,
    owner.target.tenant,
    owner.target.posting,
    owner.roots.runtime.path,
    owner.roots.secrets.path,
    owner.roots.evidence.path,
    configPath,
    ...sources.sensitiveValues,
  ]);
  return Object.freeze([...values].filter((value) => value.length > 0));
}

function disposeOwnerResume(sources: Stage2ApplicationOwnerSources): void {
  disposeResumeArtifact(sources.resumeIntent.artifact);
}
