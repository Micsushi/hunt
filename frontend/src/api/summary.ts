import { get } from './client'
import type { QueueSummary, LogsData } from '@/types/summary'

export function fetchSummary(): Promise<QueueSummary> {
  return get<QueueSummary>('/api/summary')
}

export function fetchLogs(): Promise<LogsData> {
  return get<LogsData>('/api/logs')
}

export interface LogsQuery {
  service?: string
  levels?: string[]
  since?: string
  limit?: number
}

export function fetchLogsQuery(query: LogsQuery = {}): Promise<LogsData> {
  const p = new URLSearchParams()
  if (query.service && query.service !== 'all') p.set('service', query.service)
  if (query.since) p.set('since', query.since)
  if (query.limit) p.set('limit', String(query.limit))
  for (const level of query.levels ?? []) p.append('level', level)
  const qs = p.toString()
  return get<LogsData>(`/api/logs${qs ? `?${qs}` : ''}`)
}

export interface BreakdownItem { label: string; count: number }
export interface BreakdownData { field: string; data: BreakdownItem[] }

export function fetchBreakdown(field: string): Promise<BreakdownData> {
  return get<BreakdownData>(`/api/summary/breakdown?field=${field}`)
}

export interface TimelinePoint { day: string; source: string; count: number }
export interface TimelineData { days: number; data: TimelinePoint[] }

export function fetchTimeline(days: number): Promise<TimelineData> {
  return get<TimelineData>(`/api/summary/timeline?days=${days}`)
}

export interface DailyDigest {
  date: string
  scraped_today: number
  enriched_today: number
  failed_today: number
  enriched_24h: number
  failed_24h: number
  scraped_24h: number
}

export function fetchDailyDigest(): Promise<DailyDigest> {
  return get<DailyDigest>('/api/summary/daily')
}

export interface VelocityData {
  enriched_24h: number
  enriched_prev_24h: number
  scraped_24h: number
  jobs_per_hour: number
  delta: number
}

export function fetchVelocity(): Promise<VelocityData> {
  return get<VelocityData>('/api/summary/velocity')
}

export interface QueueAgeData {
  count: number
  oldest_hours: number | null
  p50_hours: number | null
  p90_hours: number | null
  over_24h: number
}

export function fetchQueueAge(): Promise<QueueAgeData> {
  return get<QueueAgeData>('/api/summary/queue_age')
}
