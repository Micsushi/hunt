export interface HumanCommandPayload {
  action: string
  buttonId?: string
  component?: string
  commandId?: string
  laneId?: string
  page?: string
  route?: string
  sessionId?: string
  surface?: string
  traceId?: string
  details?: Record<string, unknown>
}

function shortId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 18) ||
    Math.random().toString(36).slice(2, 20)
  return `${prefix}_${random}`
}

export async function logHumanCommand(payload: HumanCommandPayload): Promise<void> {
  const route = payload.route || globalThis.location?.pathname || ''
  const page = payload.page || globalThis.document?.title || ''
  const actionComponent = /^(c[0-2])\./.exec(payload.action)?.[1]
  const component = payload.component || actionComponent || 'c0'
  const laneId = payload.laneId || ''
  const sessionId = payload.sessionId || ''
  const commandId = payload.commandId || ''
  const traceId = payload.traceId || ''
  const eventContext = {
    component,
    route,
    page,
    ...(laneId ? { laneId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(commandId ? { commandId } : {}),
    ...(traceId ? { traceId } : {}),
  }
  try {
    await fetch('/api/audit/events', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        event_id: shortId('evt'),
        ts: new Date().toISOString(),
        component,
        event_type: 'human.command',
        actor: { type: 'human', id: 'human_local', surface: payload.surface || 'c0_ui' },
        lane_id: laneId,
        session_id: sessionId,
        command_id: commandId,
        trace_id: traceId,
        payload: {
          eventContext,
          action: payload.action,
          buttonId: payload.buttonId || '',
          details: payload.details || {},
        },
      }),
    })
  } catch {
    // Operator actions remain available if audit storage is temporarily offline.
  }
}
