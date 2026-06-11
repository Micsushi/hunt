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
  const component = payload.component || 'c0'
  const laneId = payload.laneId || ''
  const sessionId = payload.sessionId || ''
  const commandId = payload.commandId || ''
  const traceId = payload.traceId || ''
  const eventContext = {
    component,
    route,
    page,
    laneId,
    sessionId,
    commandId,
    traceId,
  }
  try {
    await fetch('/api/ledger/events', {
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
          route,
          page,
          action: payload.action,
          buttonId: payload.buttonId || '',
          details: payload.details || {},
        },
        redaction: { applied: true, rules: ['human_command_no_form_values'] },
      }),
    })
  } catch {
    // Human UI commands must never fail because the ledger is offline.
  }
}
