function shortId(prefix) {
  const random = crypto?.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${random}`;
}

function cleanId(value) {
  return String(value || "").trim();
}

function actorFromTriggeredBy(triggeredBy = "") {
  const value = String(triggeredBy || "").toLowerCase();
  if (value.includes("popup")) {
    return { type: "human", surface: "popup" };
  }
  if (
    value.includes("content") ||
    value.includes("prompt") ||
    value.includes("detected_page")
  ) {
    return { type: "human", surface: "content_prompt" };
  }
  if (value.includes("c4") || value.includes("poll")) {
    return { type: "system", surface: "c4_poll" };
  }
  if (value.includes("batch") || value.includes("script")) {
    return { type: "script", surface: "batch_runner" };
  }
  return null;
}

export function inferC3Actor({ payload = {}, sender = {}, actor = null } = {}) {
  if (actor?.type || actor?.surface) {
    return {
      type: actor.type || "system",
      id: cleanId(actor.id),
      surface: actor.surface || "background",
    };
  }
  if (payload.actor?.type || payload.actor?.surface) {
    return {
      type: payload.actor.type || "system",
      id: cleanId(payload.actor.id),
      surface: payload.actor.surface || "background",
    };
  }
  const inferred = actorFromTriggeredBy(payload.triggeredBy);
  if (inferred) {
    return { id: "", ...inferred };
  }
  if (sender?.tab?.id) {
    return { type: "human", id: "", surface: "content_prompt" };
  }
  return { type: "human", id: "", surface: "popup" };
}

export function buildC3CommandContext({
  commandName,
  payload = {},
  sender = {},
  state = {},
  actor = null,
} = {}) {
  const settings = state.settings || {};
  const commandId = cleanId(payload.commandId) || shortId("cmd");
  const traceId = cleanId(payload.traceId) || shortId("trace");
  const resolvedActor = inferC3Actor({ payload, sender, actor });
  const agentId = cleanId(payload.agentId) || cleanId(settings.agentId);
  const laneId = cleanId(payload.laneId) || cleanId(settings.laneId);
  const sessionId =
    cleanId(payload.sessionId) ||
    cleanId(settings.sessionId) ||
    shortId("session");
  const leaseId = cleanId(payload.leaseId) || cleanId(settings.leaseId);

  return {
    commandName,
    commandId,
    traceId,
    agentId,
    laneId,
    sessionId,
    leaseId,
    actor: {
      ...resolvedActor,
      id: resolvedActor.id || agentId || "human_local",
    },
    tabId: payload.tabId || sender?.tab?.id || 0,
    url: payload.url || sender?.tab?.url || "",
    triggeredBy: payload.triggeredBy || "",
  };
}

export function c3CommandContextForEvent(context = {}) {
  return {
    agent_id: context.agentId || "",
    lane_id: context.laneId || "",
    session_id: context.sessionId || "",
    lease_id: context.leaseId || "",
    command_id: context.commandId || "",
    trace_id: context.traceId || "",
    actor: context.actor || { type: "system", id: "", surface: "background" },
  };
}
