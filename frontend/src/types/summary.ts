export interface LinkedInAuth {
  available: boolean
  status: string | null
  updated_at: string | null
  last_error: string | null
}

export interface QueueSummary {
  total: number
  ready_count: number
  pending_count: number
  retry_ready_count: number
  processing_count: number
  blocked_count: number
  stale_processing_count: number
  oldest_processing_started_at: string | null
  counts_by_status: Record<string, number>
  source_counts: Record<string, number>
  failure_counts: Record<string, number>
  auth: {
    linkedin: LinkedInAuth
  }
  events: Record<string, { value: string; updated_at: string } | null>
}

export interface ActivityStats {
  hours: number
  done_or_verified: number
  failed_scraped_window: number
  rows_scraped_window: number
}

export interface RuntimeStateRow {
  key: string
  value: string | null
  updated_at: string | null
}

export interface AuditEntry {
  at: string
  action: string
  detail: Record<string, unknown> | null
}

export interface LogRow {
  at: string | null
  service: 'c0' | 'c1' | 'c2' | 'c3' | 'c4' | 'db'
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  message: string
  detail: unknown
}

export interface LogsData {
  summary: QueueSummary
  activity: ActivityStats
  runtime_state: RuntimeStateRow[]
  audit: AuditEntry[]
  logs: LogRow[]
}

export interface AuthStatus {
  authenticated: boolean
  username: string | null
}
