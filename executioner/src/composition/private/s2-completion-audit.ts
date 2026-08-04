import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createStage2DiagnosticsMcpFromEvidenceRoot } from "../s2-diagnostics-mcp.ts";
import { generatedOperationId } from "../../contracts/index.ts";
import type { JourneyId } from "../../contracts/index.ts";
import { readAccountAccessDiagnostics } from "../../live/evidence/account-access-diagnostics.ts";
import { readAccountAccessEvidence } from "../../live/evidence/account-access-evidence.ts";
import {
  readOperatorMonitorAcknowledgement,
  type OperatorMonitorClassification,
} from "../../live/evidence/operator-monitor-ack.ts";
import { writeAtomicJsonEvidence } from "../../live/evidence/private/atomic-json-evidence.ts";
import { readWindowsProcessAudit } from "../../live/evidence/windows-process-audit.ts";
import { stage2AuditMcpRequestIds } from "./s2-audit-request-ids.ts";

export interface Stage2AccountAccessCompletionAuditV1 {
  readonly schemaVersion: 1;
  readonly evidenceRevision: "s2-account-access-completion-v1";
  readonly status: "pass";
  readonly sourceRevision: string;
  readonly journeyId: JourneyId;
  readonly runStatus: "passed" | "blocked" | "failed";
  readonly acceptance: "present" | "not_applicable";
  readonly monitor: "acknowledged";
  readonly monitorClassification: OperatorMonitorClassification;
  readonly mcpStatus: "running" | "blocked" | "failed";
  readonly mcpResult: "journey_busy" | "terminal";
  readonly processCleanup: "pass";
  readonly privacyScan: "pass";
  readonly submitActivated: false;
}

export async function auditStage2AccountAccessCompletion(
  root: string,
): Promise<Stage2AccountAccessCompletionAuditV1> {
  try {
    const diagnostics = readAccountAccessDiagnostics(root);
    const monitor = readOperatorMonitorAcknowledgement(root);
    readWindowsProcessAudit(root);

    let acceptance: "present" | "not_applicable";
    if (diagnostics.status === "passed") {
      const packet = readAccountAccessEvidence(root);
      if (
        packet.sourceRevision !== diagnostics.sourceRevision ||
        packet.revisionId !== diagnostics.revisionId ||
        packet.journeyId !== diagnostics.journeyId ||
        (packet.accountOutcome === "application_ready" &&
          monitor.classification !== "application_ready") ||
        (packet.accountOutcome === "verification_required" &&
          monitor.classification !== "verification_required")
      ) denied();
      acceptance = "present";
    } else {
      if (existsSync(join(root, "acceptance.json"))) denied();
      if (!blockedMonitorMatches(diagnostics.terminal, monitor.classification)) denied();
      acceptance = "not_applicable";
    }

    const requestIds = stage2AuditMcpRequestIds(diagnostics.journeyId);
    const facade = createStage2DiagnosticsMcpFromEvidenceRoot({
      evidenceRoot: root,
      nextOperationId: () => ({
        ok: true,
        value: generatedOperationId(`operation_${randomBytes(16).toString("hex")}`),
      }),
    });
    const signal = new AbortController().signal;
    const statusResponse = await facade.handle({
      schemaVersion: 2,
      requestId: requestIds.status,
      method: "journey_status",
      params: { journeyId: diagnostics.journeyId },
    }, signal);
    const resultResponse = await facade.handle({
      schemaVersion: 2,
      requestId: requestIds.result,
      method: "journey_result",
      params: { journeyId: diagnostics.journeyId },
    }, signal);
    if (
      !statusResponse.ok ||
      !statusResponse.value.ok ||
      statusResponse.value.result.kind !== "status" ||
      statusResponse.value.result.progress.journeyId !== diagnostics.journeyId
    ) denied();
    const mcpStatus = statusResponse.value.result.progress.status;
    const expectedStatus = diagnostics.status === "passed" ? "running" : diagnostics.status;
    if (mcpStatus !== expectedStatus) denied();

    let mcpResult: "journey_busy" | "terminal";
    if (diagnostics.status === "passed") {
      if (
        !resultResponse.ok ||
        resultResponse.value.ok ||
        resultResponse.value.error.code !== "journey_busy"
      ) denied();
      mcpResult = "journey_busy";
    } else {
      if (
        !resultResponse.ok ||
        !resultResponse.value.ok ||
        resultResponse.value.result.kind !== "terminal" ||
        resultResponse.value.result.terminal.journeyId !== diagnostics.journeyId ||
        resultResponse.value.result.terminal.status !== diagnostics.status
      ) denied();
      mcpResult = "terminal";
    }

    const audit: Stage2AccountAccessCompletionAuditV1 = Object.freeze({
      schemaVersion: 1,
      evidenceRevision: "s2-account-access-completion-v1",
      status: "pass",
      sourceRevision: diagnostics.sourceRevision,
      journeyId: diagnostics.journeyId,
      runStatus: diagnostics.status,
      acceptance,
      monitor: "acknowledged",
      monitorClassification: monitor.classification,
      mcpStatus,
      mcpResult,
      processCleanup: "pass",
      privacyScan: diagnostics.privacyScan,
      submitActivated: diagnostics.submitActivated,
    });
    writeAtomicJsonEvidence({
      root,
      value: audit,
      sensitiveValues: [],
      label: "account-access-completion",
      fileName: "completion-audit.json",
    });
    return audit;
  } catch {
    return denied();
  }
}

function blockedMonitorMatches(
  terminal: ReturnType<typeof readAccountAccessDiagnostics>["terminal"],
  classification: OperatorMonitorClassification,
): boolean {
  if (terminal === null) return classification === "unknown";
  if (terminal.status !== "blocked") return classification === "unknown";
  const result = terminal.factualOutcome?.result;
  if (result?.kind === "posting_unavailable") {
    return classification === "posting_unavailable" || classification === "maintenance";
  }
  if (result?.kind === "manual_intervention") {
    return classification === "manual_action_required";
  }
  return classification === "unknown";
}

function denied(): never {
  throw new Error("completion audit denied");
}
