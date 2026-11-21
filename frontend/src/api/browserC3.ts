const websiteOrigin = 'https://agent-hunt-review.mshi.ca'
const extensionId = String(import.meta.env.VITE_C3_EXTENSION_ID ?? '')
const protocol = 'hunt-c3-handoff-v1'

type Reply = { ok: boolean; result?: unknown; code?: string }
type Runtime = {
  sendMessage: (id: string, message: unknown, callback: (reply: Reply | undefined) => void) => void
  lastError?: { message?: string }
}
export type BrowserC3Status = { connected: boolean; configured: boolean }
export type BrowserC3Import = {
  jobs: { id: string; sourceJobId: number; resumeVersion: string; status: 'paused' }[]
  workspaceOpened: boolean
}

export function usesBrowserC3() {
  return window.location.origin === websiteOrigin
}

export function browserC3Configured() {
  return usesBrowserC3() && /^[a-p]{32}$/.test(extensionId)
}

export async function browserC3<T>(
  operation: 'status' | 'preview' | 'import',
  bundle?: unknown,
): Promise<T> {
  if (!browserC3Configured())
    throw new Error('Website connection is not configured. Use Download for local C3.')
  // A URL must never redirect applicant files to an arbitrary installed extension.
  const hash = new URLSearchParams(window.location.hash.slice(1))
  if (hash.has('c3-extension')) {
    const supplied = hash.get('c3-extension')
    hash.delete('c3-extension')
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + (hash.size ? '#' + hash.toString() : ''),
    )
    if (supplied !== extensionId)
      throw new Error(
        'This website is configured for a different Hunt C3 extension. Use Download for local C3.',
      )
  }
  const runtime = (window as unknown as { chrome?: { runtime?: Runtime } }).chrome?.runtime
  if (!runtime?.sendMessage)
    throw new Error('Open Hunt in Chrome with the updated Hunt C3 extension connected.')
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () =>
        reject(
          new Error('No confirmation received. Check the local C3 workspace before retrying.'),
        ),
      22000,
    )
    try {
      runtime.sendMessage(
        extensionId,
        { protocol, operation, bundle, expiresAt: Date.now() + 20000 },
        (reply) => {
          window.clearTimeout(timer)
          if (runtime.lastError || !reply) {
            reject(
              new Error(
                'Hunt C3 did not respond. Open the extension and connect to the local app.',
              ),
            )
          } else if (!reply.ok) {
            const messages: Record<string, string> = {
              disconnected: 'Open Hunt C3 and connect to the local app.',
              update_required:
                'Update the local C3 app before sending applications. Download remains available.',
              rejected:
                'C3 rejected this transfer. Check the selected resume and existing application in the local workspace.',
              busy: 'Another transfer is in progress. Check the local workspace.',
            }
            reject(
              new Error(
                messages[reply.code ?? ''] ??
                  'Transfer not confirmed. Check the local C3 workspace before retrying.',
              ),
            )
          } else resolve(reply.result as T)
        },
      )
    } catch {
      window.clearTimeout(timer)
      reject(new Error('Hunt C3 is unavailable. Use Download for local C3.'))
    }
  })
}
