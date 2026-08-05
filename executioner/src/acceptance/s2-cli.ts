import {
  parseStage2RealAcceptanceArgs,
  runStage2RealAcceptance,
  type Stage2AcceptanceGatePorts,
} from "./s2-gate.ts";

export interface Stage2AcceptanceCliResult {
  readonly exitCode: 0 | 1 | 2 | 130;
  readonly output: string;
}

export async function executeStage2AcceptanceCli(
  values: readonly string[],
  ports: Stage2AcceptanceGatePorts,
  signal?: AbortSignal,
): Promise<Stage2AcceptanceCliResult> {
  let args;
  try {
    args = parseStage2RealAcceptanceArgs(values);
  } catch {
    return terminal(2, {
      status: "failed",
      code: "runner_admission_failed",
      cleanup: "not_started",
    });
  }
  const result = await runStage2RealAcceptance(args, ports, signal);
  if (!result.ok) {
    return terminal(result.code === "operation_cancelled" ? 130 : 1, {
      status: "failed",
      code: result.code,
      cleanup: result.cleanup,
    });
  }
  return terminal(0, {
    status: "passed",
    checkpoint: result.manifest.checkpoint,
    sourceRevision: result.manifest.sourceRevision,
    configSha256: result.manifest.configSha256,
    revisionId: result.manifest.revisionId,
    submitActivated: result.manifest.submitActivated,
    privacyScan: result.manifest.privacyScan,
    cleanup: "exact_finalization_passed",
  });
}

function terminal(
  exitCode: 0 | 1 | 2 | 130,
  value: Readonly<Record<string, unknown>>,
): Stage2AcceptanceCliResult {
  return Object.freeze({ exitCode, output: `${JSON.stringify(value)}\n` });
}
