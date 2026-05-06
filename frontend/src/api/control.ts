import { get, patch, post } from './client'

const MOCK = import.meta.env.VITE_MOCK_BACKEND === 'true'

export type ComponentId = 'c0' | 'c1' | 'c2' | 'c3' | 'c4'

export interface ComponentStatus {
  component: ComponentId
  status: 'ok' | 'error' | 'unreachable' | string
  status_code?: number | null
  url?: string
  pending_fills?: number | null
  detail?: unknown
}

export interface SystemStatus {
  status: string
  db: { status: string; detail?: string }
  components: Record<ComponentId, ComponentStatus>
}

export interface ComponentSetting {
  component: ComponentId
  key: string
  value: string | null
  value_type: string
  secret: boolean
  has_value: boolean
  updated_at: string | null
  updated_by: string | null
}

export interface LinkedInAccount {
  id: number
  username: string
  display_name: string | null
  active: boolean
  auth_state: string
  last_auth_check: string | null
  last_auth_error: string | null
  created_at: string | null
  updated_at: string | null
  has_password: boolean
}

export interface C4Run {
  id?: string
  run_id?: string
  job_id?: number
  status?: string
  updated_at?: string
  created_at?: string
  [key: string]: unknown
}

export interface PendingFill {
  run_id: string
  job_id?: number
  ats_type?: string
  [key: string]: unknown
}

export function fetchSystemStatus(): Promise<SystemStatus> {
  return get<SystemStatus>('/api/system/status')
}

export function fetchSettings(component?: ComponentId): Promise<{ settings: ComponentSetting[] }> {
  const qs = component ? `?component=${encodeURIComponent(component)}` : ''
  return get<{ settings: ComponentSetting[] }>(`/api/settings${qs}`)
}

export function saveSetting(payload: {
  component: ComponentId
  key: string
  value: string
  value_type?: string
  secret?: boolean
}): Promise<{ setting: ComponentSetting }> {
  return post('/api/settings', payload)
}

export function fetchLinkedInAccounts(): Promise<{ accounts: LinkedInAccount[] }> {
  return get<{ accounts: LinkedInAccount[] }>('/api/linkedin/accounts')
}

export function saveLinkedInAccount(payload: {
  username: string
  display_name?: string
  active?: boolean
}): Promise<{ account: LinkedInAccount }> {
  return post('/api/linkedin/accounts', payload)
}

export function fetchC1Status(): Promise<unknown> {
  return get('/api/gateway/c1/status')
}

export function fetchC1Queue(): Promise<unknown> {
  return get('/api/gateway/c1/queue')
}

export function triggerC1Scrape(): Promise<unknown> {
  return post('/api/gateway/c1/scrape', {})
}

export function triggerC1Enrich(limit = 25): Promise<unknown> {
  return post('/api/gateway/c1/enrich', { limit })
}

export function triggerC1Reauth(accountId: number): Promise<unknown> {
  return post(`/api/gateway/c1/accounts/${accountId}/reauth`, {})
}

export function fetchC2Status(): Promise<unknown> {
  return get('/api/gateway/c2/status')
}

export function triggerC2Generate(jobId: number): Promise<unknown> {
  return post('/api/gateway/c2/generate', { job_id: jobId })
}

export type TailorResult = {
  noSummary: Blob | null
  withSummary: Blob | null
  log: Blob | null
  llmError: string | null
  errorType: string | null
  error: string | null
}

function _b64ToBlob(b64: string): Blob {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: 'application/pdf' })
}

export function tailorResume(params: {
  jobDetails: string
  personalDetails: string
  resume?: File | null
}): Promise<TailorResult> {
  if (MOCK) {
    const text = [
      'Hunt mock tailored resume',
      '',
      'Job details:',
      params.jobDetails || '(empty)',
      '',
      'Personal details:',
      params.personalDetails || '(empty)',
    ].join('\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    return Promise.resolve({
      noSummary: blob,
      withSummary: null,
      log: null,
      llmError: null,
      errorType: null,
      error: null,
    })
  }

  const form = new FormData()
  form.append('job_details', params.jobDetails)
  form.append('personal_details', params.personalDetails)
  if (params.resume) form.append('resume', params.resume)
  return fetch('/api/fletcher/tailor', { method: 'POST', credentials: 'include', body: form }).then(
    async (r) => {
      if (!r.ok) {
        const text = await r.text().catch(() => r.statusText)
        throw new Error(text || r.statusText)
      }
      const json = await r.json()
      return {
        noSummary: json.no_summary ? _b64ToBlob(json.no_summary) : null,
        withSummary: json.with_summary ? _b64ToBlob(json.with_summary) : null,
        log: json.log ? new Blob([atob(json.log)], { type: 'text/plain' }) : null,
        llmError: json.llm_error ?? null,
        errorType: json.error_type ?? null,
        error: json.error ?? null,
      }
    },
  )
}

export function fetchC4Status(): Promise<unknown> {
  return get('/api/gateway/c4/status')
}

export function fetchC4Runs(): Promise<{ runs: C4Run[] }> {
  return get('/api/gateway/c4/runs?limit=20')
}

export function triggerC4Run(jobId: number): Promise<unknown> {
  return post('/api/gateway/c4/run', { job_id: jobId })
}

export function approveC4Run(
  runId: string,
  decision: 'approve' | 'deny',
  reason: string,
): Promise<unknown> {
  return post(`/api/gateway/c4/runs/${encodeURIComponent(runId)}/approve`, {
    decision,
    approved_by: 'c0',
    reason,
  })
}

export function fetchPendingFills(): Promise<{ fills: PendingFill[] }> {
  return get('/api/c3/pending-fills')
}

export interface C1Config {
  config_file: string
  config_file_exists: boolean
  watchlist: string[]
  title_blacklist: string[]
  search_terms: Record<string, string[]>
  locations: string[]
  sites: string[]
  max_workers: number
  results_wanted: number
  hours_old: number
  run_interval_seconds: number
  enrich_after_scrape: boolean
  enrichment_batch_limit: number
  enrichment_timeout_ms: number
  enrichment_max_attempts: number
  enrichment_alert_failure_rate_percent: number
  enrichment_alert_cooldown_minutes: number
}

export type C1ConfigUpdates = Partial<Omit<C1Config, 'config_file' | 'config_file_exists'>>

export interface ConfigSaveResult {
  saved: boolean
  config_file: string
  updated_keys: string[]
  config: Record<string, unknown>
}

export function fetchC1Config(): Promise<C1Config> {
  return get<C1Config>('/api/gateway/c1/config')
}

export function saveC1Config(updates: C1ConfigUpdates): Promise<ConfigSaveResult> {
  return patch<ConfigSaveResult>('/api/gateway/c1/config', updates)
}

export function testC1Discord(): Promise<{ sent: boolean; status_code?: number }> {
  return post('/api/gateway/c1/test-discord', {})
}

export interface EasyApplyVerifyResult {
  pass: boolean
  job_id: number
  failures: string[]
  apply_type: string | null
  auto_apply_eligible: number | null
  enrichment_status: string | null
}

export function verifyEasyApply(jobId: number): Promise<EasyApplyVerifyResult> {
  return post<EasyApplyVerifyResult>(`/api/jobs/${jobId}/verify-easy-apply`, {})
}
