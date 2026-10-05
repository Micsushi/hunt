import { access } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { getRepoRoot } from "../../generator/scripts/build-lib.mjs";
import { createCheck } from "./report-lib.mjs";

const testerFolders = ["ATS-Checker", "ats-screener", "Resume-Matcher", "ResumeParser"];
const resultStates = new Set(["executed_pass", "executed_warning", "executed_fail", "skipped"]);

export async function runTesterAdapter({
  id,
  required = false,
  timeoutMs = 30_000,
  preflight,
  execute,
  evaluate = () => ({ state: "executed_pass" }),
  nowImpl = performance.now.bind(performance)
}) {
  const started = nowImpl();
  const finish = (result) =>
    normalizeAdapterResult({
      adapter_id: id,
      required,
      duration_ms: Math.max(0, Math.round(nowImpl() - started)),
      ...result
    });

  let unavailable;
  try {
    unavailable = await preflight?.();
  } catch (error) {
    return finish({
      state: "skipped",
      failure_kind: "preflight_error",
      reason: error.message || "Tester preflight failed."
    });
  }
  if (unavailable) {
    const detail =
      typeof unavailable === "string"
        ? { reason: unavailable, failure_kind: "unavailable" }
        : unavailable;
    return finish({
      state: "skipped",
      failure_kind: detail.failure_kind || "unavailable",
      reason: detail.reason || "Tester capability is unavailable.",
      metadata: detail.metadata || {}
    });
  }

  try {
    const raw = await execute({ timeoutMs });
    const evaluated = evaluate(raw) || {};
    if (!resultStates.has(evaluated.state)) {
      const error = new Error("Tester adapter returned an invalid execution state.");
      error.code = "MALFORMED_OUTPUT";
      throw error;
    }
    return finish(evaluated);
  } catch (error) {
    return finish({
      state: "executed_fail",
      failure_kind:
        error.code === "ETIMEDOUT"
          ? "timeout"
          : error.code === "MALFORMED_OUTPUT"
            ? "malformed_output"
            : Number.isInteger(error.code)
              ? "nonzero_exit"
              : "execution_error",
      reason: error.message || "Tester execution failed."
    });
  }
}

export function adapterResultToCheck(result) {
  const prefix = `tester_${result.adapter_id.replaceAll("-", "_")}`;
  const requiredUnavailable = result.required && result.state === "skipped";
  const status =
    result.state === "executed_pass"
      ? "pass"
      : result.state === "executed_warning" || !result.required
        ? "warning"
        : "fail";
  const suffix = {
    executed_pass: "executed",
    executed_warning: "warning",
    executed_fail: "failed",
    skipped: "skipped"
  }[result.state];

  return createCheck({
    id: `${prefix}_${suffix}`,
    category: "tester_execution",
    severity: status === "fail" ? "blocker" : "low",
    status,
    evidence:
      result.reason ||
      (result.state === "executed_pass"
        ? `${result.adapter_id} executed successfully.`
        : `${result.adapter_id} execution needs review.`),
    suggestedFix:
      status === "pass"
        ? ""
        : "Provide the required artifact/runtime and rerun the selected tester.",
    metadata: {
      adapter_id: result.adapter_id,
      execution_state: result.state,
      required: result.required,
      required_capability_unavailable: requiredUnavailable,
      duration_ms: result.duration_ms,
      ...(result.failure_kind ? { failure_kind: result.failure_kind } : {}),
      ...result.metadata
    }
  });
}

export function sanitizeTesterDetail(value) {
  return String(value || "")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*=\s*\S+/gi, "[redacted]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "[path]")
    .replace(/\/(?:Users|home)\/[^\s]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function normalizeAdapterResult(result) {
  return {
    adapter_id: result.adapter_id,
    state: result.state,
    required: result.required,
    duration_ms: result.duration_ms,
    ...(result.failure_kind ? { failure_kind: result.failure_kind } : {}),
    ...(result.reason ? { reason: sanitizeTesterDetail(result.reason) } : {}),
    metadata: sanitizeMetadata(result.metadata || {})
  };
}

function sanitizeMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) => {
      if (typeof value === "string") return [[key, sanitizeTesterDetail(value)]];
      if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return [[key, value]];
      }
      return [];
    })
  );
}

export async function checkTesterSnapshots() {
  const checks = [];
  for (const folder of testerFolders) {
    checks.push(await checkTesterFolder(folder));
  }
  return checks;
}

async function checkTesterFolder(folder) {
  const path = join(getRepoRoot(), "testers", folder);
  try {
    await access(path);
    return createCheck({
      id: "tester_snapshot_present",
      category: "tester_integration",
      severity: "low",
      status: "pass",
      evidence: `Found tester snapshot ${folder}.`,
      metadata: { folder }
    });
  } catch {
    return createCheck({
      id: "tester_snapshot_missing",
      category: "tester_integration",
      severity: "medium",
      status: "warning",
      evidence: `Missing tester snapshot ${folder}.`,
      suggestedFix: "Restore the snapshot or update docs/tester-sources.md.",
      metadata: { folder }
    });
  }
}
