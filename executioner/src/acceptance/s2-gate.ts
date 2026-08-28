import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

const RUN_KEY = /^run_\d{8}_[a-z0-9]{16}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface Stage2RealAcceptanceArgs {
  readonly configPath: string;
  readonly evidenceRoot: string;
}

export interface Stage2SourceCapture {
  readonly repositoryRoot: string;
  readonly sourceRevision: string;
}

export interface Stage2ConfigCapture {
  readonly configSha256: string;
  readonly contractRevision: string;
  readonly revisionId: string;
  readonly approvalId: string;
  readonly journeyId: string;
  readonly targetHandleId: string;
}

export interface Stage2ReviewAcceptance extends Stage2ConfigCapture {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-review-acceptance-v1";
  readonly sourceRevision: string;
  readonly checkpoint: "review";
  readonly status: "passed";
  readonly reviewProof: "independently_verified";
  readonly submitPresent: true;
  readonly submitActivated: false;
  readonly privacyScan: "pass";
}

export interface Stage2AcceptanceManifest extends Stage2ConfigCapture {
  readonly schemaVersion: 1;
  readonly acceptanceRevision: "s2-real-acceptance-gate-v1";
  readonly status: "review_verified";
  readonly sourceRevision: string;
  readonly checkpoint: "review";
  readonly quality: "pass";
  readonly reviewProof: "independently_verified";
  readonly submitPresent: true;
  readonly submitActivated: false;
  readonly privacyScan: "pass";
  readonly cleanup: "pending_exact_finalization";
}

export interface Stage2AcceptanceGatePorts {
  source: { capture(): Promise<Stage2SourceCapture> };
  config: { capture(path: string): Promise<Stage2ConfigCapture> };
  quality: { run(signal?: AbortSignal): Promise<number> };
  journey: {
    run(args: Stage2RealAcceptanceArgs, signal?: AbortSignal): Promise<number>;
  };
  result: { read(evidenceRoot: string): Promise<Stage2ReviewAcceptance> };
  cleanup: {
    finalize(
      args: Stage2RealAcceptanceArgs,
      manifest: Stage2AcceptanceManifest,
    ): Promise<void>;
    sealFailure?(
      args: Stage2RealAcceptanceArgs,
      code: Stage2AcceptanceFailureCode,
    ): Promise<void>;
  };
}

export type Stage2AcceptanceFailureCode =
  | "preflight_failed"
  | "quality_failed"
  | "source_changed"
  | "config_changed"
  | "real_journey_failed"
  | "result_reconciliation_failed"
  | "cleanup_finalize_failed"
  | "operation_cancelled";

export type Stage2AcceptanceGateResult =
  | { readonly ok: true; readonly manifest: Stage2AcceptanceManifest }
  | {
      readonly ok: false;
      readonly code: Stage2AcceptanceFailureCode;
      readonly cleanup: "retained_for_exact_reconciliation";
    };

export function parseStage2RealAcceptanceArgs(
  values: readonly string[],
): Stage2RealAcceptanceArgs {
  if (values.length !== 6) invalid();
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      name === undefined || value === undefined || parsed.has(name) ||
      !["--config", "--stop-after", "--evidence-root"].includes(name) ||
      /[\0\r\n"]/u.test(value)
    ) invalid();
    parsed.set(name, value);
  }
  const configPath = parsed.get("--config");
  const evidenceRoot = parsed.get("--evidence-root");
  if (
    configPath === undefined || evidenceRoot === undefined ||
    parsed.get("--stop-after") !== "review" ||
    !canonicalAbsolute(configPath) || !canonicalAbsolute(evidenceRoot) ||
    !boundStorageLayout(configPath, evidenceRoot)
  ) invalid();
  return Object.freeze({ configPath, evidenceRoot });
}

export async function runStage2RealAcceptance(
  args: Stage2RealAcceptanceArgs,
  ports: Stage2AcceptanceGatePorts,
  signal?: AbortSignal,
): Promise<Stage2AcceptanceGateResult> {
  if (signal?.aborted) return failed("operation_cancelled");
  let initialSource: Stage2SourceCapture;
  let initialConfig: Stage2ConfigCapture;
  try {
    initialSource = exactSource(await ports.source.capture());
    initialConfig = exactConfig(await ports.config.capture(args.configPath));
    if (
      !outsideRoot(args.configPath, initialSource.repositoryRoot) ||
      !outsideRoot(args.evidenceRoot, initialSource.repositoryRoot)
    ) return failed("preflight_failed");
  } catch {
    return failed("preflight_failed");
  }

  const quality = await runBounded(() => ports.quality.run(signal));
  if (signal?.aborted || quality === 130) return failed("operation_cancelled");
  if (quality !== 0) return failed("quality_failed");

  const beforeJourney = await recapture(args, ports);
  if (beforeJourney === undefined) return failed("preflight_failed");
  const drift = changed(initialSource, initialConfig, beforeJourney);
  if (drift !== undefined) return failed(drift);

  const journey = await runBounded(() => ports.journey.run(args, signal));
  if (signal?.aborted || journey === 130) {
    return await failedAfterJourney(args, ports, "operation_cancelled");
  }
  if (journey !== 0) return await failedAfterJourney(args, ports, "real_journey_failed");

  const afterJourney = await recapture(args, ports);
  if (afterJourney === undefined) return await failedAfterJourney(args, ports, "preflight_failed");
  const finalDrift = changed(initialSource, initialConfig, afterJourney);
  if (finalDrift !== undefined) return await failedAfterJourney(args, ports, finalDrift);

  let acceptance: Stage2ReviewAcceptance;
  try {
    acceptance = await ports.result.read(args.evidenceRoot);
    if (!matches(acceptance, initialSource, initialConfig)) {
      return await failedAfterJourney(args, ports, "result_reconciliation_failed");
    }
  } catch {
    return await failedAfterJourney(args, ports, "result_reconciliation_failed");
  }
  if (signal?.aborted) return await failedAfterJourney(args, ports, "operation_cancelled");
  const manifest = acceptanceManifest(acceptance);
  try {
    await ports.cleanup.finalize(args, manifest);
  } catch {
    return failed("cleanup_finalize_failed");
  }
  return Object.freeze({ ok: true, manifest });
}

async function failedAfterJourney(
  args: Stage2RealAcceptanceArgs,
  ports: Stage2AcceptanceGatePorts,
  code: Stage2AcceptanceFailureCode,
): Promise<Stage2AcceptanceGateResult> {
  if (ports.cleanup.sealFailure === undefined) return failed(code);
  try {
    await ports.cleanup.sealFailure(args, code);
    return failed(code);
  } catch {
    return failed("cleanup_finalize_failed");
  }
}

function outsideRoot(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path));
}

function acceptanceManifest(value: Stage2ReviewAcceptance): Stage2AcceptanceManifest {
  return Object.freeze({
    schemaVersion: 1,
    acceptanceRevision: "s2-real-acceptance-gate-v1",
    status: "review_verified",
    sourceRevision: value.sourceRevision,
    configSha256: value.configSha256,
    contractRevision: value.contractRevision,
    revisionId: value.revisionId,
    approvalId: value.approvalId,
    journeyId: value.journeyId,
    targetHandleId: value.targetHandleId,
    checkpoint: "review",
    quality: "pass",
    reviewProof: "independently_verified",
    submitPresent: true,
    submitActivated: false,
    privacyScan: "pass",
    cleanup: "pending_exact_finalization",
  });
}

async function recapture(
  args: Stage2RealAcceptanceArgs,
  ports: Stage2AcceptanceGatePorts,
): Promise<{
  readonly source: Stage2SourceCapture;
  readonly config: Stage2ConfigCapture;
} | undefined> {
  try {
    return Object.freeze({
      source: exactSource(await ports.source.capture()),
      config: exactConfig(await ports.config.capture(args.configPath)),
    });
  } catch {
    return undefined;
  }
}

function changed(
  initialSource: Stage2SourceCapture,
  initialConfig: Stage2ConfigCapture,
  current: { readonly source: Stage2SourceCapture; readonly config: Stage2ConfigCapture },
): "source_changed" | "config_changed" | undefined {
  if (
    initialSource.repositoryRoot !== current.source.repositoryRoot ||
    initialSource.sourceRevision !== current.source.sourceRevision
  ) return "source_changed";
  if (JSON.stringify(initialConfig) !== JSON.stringify(current.config)) return "config_changed";
  return undefined;
}

function matches(
  value: Stage2ReviewAcceptance,
  source: Stage2SourceCapture,
  config: Stage2ConfigCapture,
): boolean {
  try {
    return value.checkpoint === "review" && value.status === "passed" &&
      value.reviewProof === "independently_verified" && value.submitPresent === true &&
      value.submitActivated === false && value.privacyScan === "pass" &&
      value.sourceRevision === source.sourceRevision &&
      JSON.stringify(exactConfig(value)) === JSON.stringify(config);
  } catch {
    return false;
  }
}

function exactSource(value: Stage2SourceCapture): Stage2SourceCapture {
  if (
    !isAbsolute(value.repositoryRoot) || /[\0\r\n"]/u.test(value.repositoryRoot) ||
    !REVISION.test(value.sourceRevision)
  ) throw new TypeError("invalid source capture");
  return Object.freeze({
    repositoryRoot: normalize(value.repositoryRoot),
    sourceRevision: value.sourceRevision,
  });
}

function exactConfig(value: Stage2ConfigCapture): Stage2ConfigCapture {
  if (
    !SHA256.test(value.configSha256) ||
    !/^s2-owner-inputs-v\d+$/u.test(value.contractRevision) ||
    !/^revision_[A-Za-z0-9_-]{16,64}$/u.test(value.revisionId) ||
    !/^approval_[A-Za-z0-9_-]{16,64}$/u.test(value.approvalId) ||
    !/^journey_[A-Za-z0-9_-]{16,64}$/u.test(value.journeyId) ||
    !/^target_ref_[A-Za-z0-9_-]{16,64}$/u.test(value.targetHandleId)
  ) throw new TypeError("invalid config capture");
  return Object.freeze({
    configSha256: value.configSha256,
    contractRevision: value.contractRevision,
    revisionId: value.revisionId,
    approvalId: value.approvalId,
    journeyId: value.journeyId,
    targetHandleId: value.targetHandleId,
  });
}

async function runBounded(operation: () => Promise<number>): Promise<number> {
  try {
    const result = await operation();
    return Number.isInteger(result) && result >= 0 && result <= 255 ? result : 1;
  } catch {
    return 1;
  }
}

function failed(code: Stage2AcceptanceFailureCode): Stage2AcceptanceGateResult {
  return Object.freeze({
    ok: false,
    code,
    cleanup: "retained_for_exact_reconciliation",
  });
}

function boundStorageLayout(configPath: string, evidenceRoot: string): boolean {
  if (basename(configPath) !== "owner-input.json") return false;
  const transientRoot = dirname(configPath);
  const runKey = basename(transientRoot);
  const storageRoot = dirname(dirname(transientRoot));
  return RUN_KEY.test(runKey) && basename(dirname(transientRoot)) === "transient" &&
    comparable(evidenceRoot) === comparable(join(storageRoot, "retained", runKey, "evidence"));
}

function canonicalAbsolute(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value;
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function invalid(): never {
  throw new TypeError("invalid S2 acceptance arguments");
}
