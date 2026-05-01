import {
  MOCK_ATTEMPTS,
  MOCK_AUTH,
  MOCK_BREAKDOWN,
  MOCK_C1_QUEUE,
  MOCK_C1_STATUS,
  MOCK_C2_STATUS,
  MOCK_C4_RUNS,
  MOCK_C4_STATUS,
  MOCK_DAILY,
  MOCK_JOB_DETAIL,
  MOCK_JOBS,
  MOCK_LINKEDIN_ACCOUNTS,
  MOCK_LOGS,
  MOCK_PENDING_FILLS,
  MOCK_QUEUE_AGE,
  MOCK_SETTINGS,
  MOCK_SUMMARY,
  MOCK_SYSTEM_STATUS,
  MOCK_TIMELINE,
  MOCK_VELOCITY,
} from './data'

const EXACT_GET_ROUTES: Record<string, unknown> = {
  '/auth/me': MOCK_AUTH,
  '/api/jobs': MOCK_JOBS,
  '/api/jobs/count': { count: MOCK_JOBS.length },
  '/api/summary': MOCK_SUMMARY,
  '/api/logs': MOCK_LOGS,
  '/api/system/status': MOCK_SYSTEM_STATUS,
  '/api/settings': MOCK_SETTINGS,
  '/api/linkedin/accounts': MOCK_LINKEDIN_ACCOUNTS,
  '/api/gateway/c1/status': MOCK_C1_STATUS,
  '/api/gateway/c1/queue': MOCK_C1_QUEUE,
  '/api/gateway/c2/status': MOCK_C2_STATUS,
  '/api/gateway/c4/status': MOCK_C4_STATUS,
  '/api/gateway/c4/runs': MOCK_C4_RUNS,
  '/api/c3/pending-fills': MOCK_PENDING_FILLS,
}

function matchRoute(path: string): unknown | undefined {
  const url = new URL(path, window.location.origin)
  const clean = url.pathname
  if (EXACT_GET_ROUTES[clean] !== undefined) return EXACT_GET_ROUTES[clean]
  if (clean === '/api/summary/breakdown') return MOCK_BREAKDOWN
  if (clean === '/api/summary/timeline') return MOCK_TIMELINE
  if (clean === '/api/summary/daily') return MOCK_DAILY
  if (clean === '/api/summary/velocity') return MOCK_VELOCITY
  if (clean === '/api/summary/queue_age') return MOCK_QUEUE_AGE
  if (/^\/api\/jobs\/\d+$/.test(clean)) return MOCK_JOB_DETAIL
  if (/^\/api\/jobs\/\d+\/attempts$/.test(clean)) return MOCK_ATTEMPTS
  if (/^\/api\/jobs\/\d+\/adjacent$/.test(clean)) return { prev_id: null, next_id: MOCK_JOBS[1]?.id ?? null }
  return undefined
}

function wait() {
  return new Promise(resolve => setTimeout(resolve, 80))
}

export async function mockGet<T>(path: string): Promise<T> {
  await wait()
  const data = matchRoute(path)
  if (data === undefined) throw new Error(`[mock] No stub for GET ${path}`)
  return data as T
}

export async function mockPost<T>(path: string): Promise<T> {
  await wait()
  if (path === '/auth/logout') return {} as T
  if (path === '/api/settings') return { ok: true } as T
  if (path === '/api/linkedin/accounts') return { ok: true } as T
  if (path === '/api/jobs/bulk-selection') return { status: 'ok', updated: 0 } as T
  if (path === '/api/ops/bulk-requeue') return { status: 'ok', updated: 0, count: 0, dry_run: true } as T
  if (path.startsWith('/api/jobs/') && path.endsWith('/priority')) return { status: 'ok' } as T
  if (path.startsWith('/api/jobs/') && path.endsWith('/operator-meta')) return { status: 'ok' } as T
  if (path.startsWith('/api/jobs/') && path.endsWith('/requeue')) return { status: 'ok' } as T
  if (path.startsWith('/api/gateway/')) return { status: 'mock' } as T
  if (path.startsWith('/api/ops/')) return { status: 'ok', updated: 0 } as T
  return {} as T
}

export async function mockPatch<T>(): Promise<T> {
  await wait()
  return { status: 'ok' } as T
}

export async function mockDel<T>(): Promise<T> {
  await wait()
  return { status: 'ok' } as T
}
