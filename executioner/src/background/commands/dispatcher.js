import { postLedgerEvent } from "../../shared/api.js";
import { assertKnownC3Command } from "./registry.js";
import { c3CommandContextForEvent } from "./context.js";

function eventId() {
  const random = crypto?.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 18)
    : Math.random().toString(36).slice(2, 20);
  return `evt_${random}`;
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: true };
  }
  const attempt = result.attempt || {};
  const audit = result.result?.audit || result.audit || {};
  return {
    ok: result.ok !== false,
    reason: result.reason || "",
    message: result.message || "",
    attemptId: attempt.id || attempt.attemptId || result.attemptId || "",
    auditSummary:
      result.auditSummary ||
      audit.summary ||
      result.result?.auditSummary ||
      result.result?.summary ||
      "",
    filledFieldCount: Number(
      attempt.filledFieldCount || result.result?.filledFieldCount || 0,
    ),
    pendingLlmFieldCount: Number(result.result?.pendingLlmFieldCount || 0),
    manualReviewRequired: Boolean(attempt.manualReviewRequired),
  };
}

export async function emitC3CommandEvent({
  settings = {},
  command,
  context,
  eventType,
  payload = {},
} = {}) {
  if (!settings?.ledgerEnabled) {
    return { ok: false, skipped: true, reason: "ledger_disabled" };
  }
  try {
    return await postLedgerEvent(settings, {
      event_id: eventId(),
      ts: new Date().toISOString(),
      component: "c3",
      event_type: eventType,
      ...c3CommandContextForEvent(context),
      payload: {
        command: command?.name || context?.commandName || "",
        tabId: context?.tabId || 0,
        url: context?.url || "",
        triggeredBy: context?.triggeredBy || "",
        ...payload,
      },
      redaction: { applied: true, rules: [] },
    });
  } catch (error) {
    console.warn("C3 ledger event post failed:", error);
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function dispatchC3Command({
  commandName,
  settings = {},
  context,
  handler,
  payload = {},
} = {}) {
  const command = assertKnownC3Command(commandName);
  await emitC3CommandEvent({
    settings,
    command,
    context,
    eventType: "command.requested",
    payload: { input: payload },
  });
  await emitC3CommandEvent({
    settings,
    command,
    context,
    eventType: "command.started",
  });
  try {
    const result = await handler({ command, commandContext: context });
    const receipt = {
      commandId: context.commandId,
      traceId: context.traceId,
      command: command.name,
      ...summarizeResult(result),
    };
    await emitC3CommandEvent({
      settings,
      command,
      context,
      eventType: "command.completed",
      payload: { receipt },
    });
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return { ...result, commandReceipt: receipt };
    }
    return result;
  } catch (error) {
    await emitC3CommandEvent({
      settings,
      command,
      context,
      eventType: "command.failed",
      payload: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}
