import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApplicationCheckpoint } from "../ats/workday/application/page-walk.ts";
import { disposeResumeArtifact } from "../contracts/index.ts";
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
  }>;
}

export interface Stage2ApplicationWalkRuntimeBindingRequest {
  readonly owner: RealRunOwnerInputsV1;
  readonly ownerBinding: RealRunRuntimeBinding;
  readonly ownerSources: Stage2ApplicationOwnerSources;
  readonly sourceRevision: string;
}

export interface Stage2ApplicationWalkRuntimeBinding {
  bind(
    request: Stage2ApplicationWalkRuntimeBindingRequest,
    signal: AbortSignal,
  ): Promise<Omit<Stage2ApplicationWalkDependencies, "evidence">>;
}

export interface Stage2ApplicationWalkProductionBindingOptions {
  readonly runtime: Stage2ApplicationWalkRuntimeBinding;
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
      if (signal.aborted) throw new TypeError("application binding denied");
      const executionerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
      const source = (dependencies.inspectSource ?? (() =>
        inspectCleanSourceRevision(executionerRoot)))();
      const config = readStablePrivateFile(options.configPath, 64 * 1024);
      const configPath = config.canonicalPath;
      const value = readOwnerConfig(config.bytes);
      const now = (dependencies.now ?? (() => new Date().toISOString()))();
      const admission = createPrivateRealRunAdmission(value, {
        now,
        forbiddenRoots: [source.repositoryRoot],
        ownerConfigPath: configPath,
        ...(dependencies.aclAdmission === undefined
          ? {}
          : { aclAdmission: dependencies.aclAdmission }),
      });
      if (!admission.ok) throw new TypeError("application binding denied");
      const owner = value as RealRunOwnerInputsV1;
      if (!matchesStage2OwnerStorageBinding({
        ownerConfigPath: configPath,
        runtimeRoot: owner.roots.runtime.path,
        ownerEvidenceRoot: owner.roots.evidence.path,
        requestedEvidenceRoot: options.evidenceRoot,
      })) throw new TypeError("application binding denied");
      const resolver = dependencies.resolver ??
        new FileBackedStage2ApplicationOwnerSourceResolver({
          forbiddenRoots: [source.repositoryRoot],
        });
      const resolvedOwnerSources = await resolver.resolve({
        runtimeRoot: owner.roots.runtime.path,
        revisionId: owner.revisionId,
        approvalId: owner.approval.approvalId,
        journeyId: owner.journeyId,
        targetHandleId: owner.target.handleId,
        profileRef: owner.profileRef,
        resumeRef: owner.resumeRef,
        approvedAt: owner.approval.approvedAt,
      }, signal);
      let ownerSources: typeof resolvedOwnerSources | undefined = resolvedOwnerSources;
      let sensitiveValues: readonly string[] | undefined = applicationSensitiveValues(
        owner,
        resolvedOwnerSources,
        configPath,
      );
      let runtime: Omit<Stage2ApplicationWalkDependencies, "evidence">;
      try {
        runtime = await dependencies.runtime.bind({
          owner,
          ownerBinding: admission.binding,
          ownerSources: resolvedOwnerSources,
          sourceRevision: source.sourceRevision,
        }, signal);
      } catch {
        disposeOwnerResume(resolvedOwnerSources);
        ownerSources = undefined;
        sensitiveValues = undefined;
        throw new TypeError("application binding denied");
      }
      return Object.freeze({
        input: Object.freeze({
          sourceRevision: source.sourceRevision,
          revisionId: owner.revisionId,
          approvalId: owner.approval.approvalId,
          journeyId: owner.journeyId as Stage2ApplicationWalkInput["journeyId"],
          targetHandleId: owner.target.handleId,
          stopAfter: options.checkpoint,
        }),
        dependencies: Object.freeze({
          ...runtime,
          cleanup: Object.freeze({
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
                if (!cleaned || accepted !== undefined) sensitiveValues = undefined;
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
    return await runStage2ApplicationWalk(
      resolved.input,
      resolved.dependencies,
      signal,
    );
  } catch {
    return {
      ok: false,
      code: signal.aborted ? "operation_cancelled" : "owner_config_invalid",
    };
  }
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
