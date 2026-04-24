import { get } from './client'
import type { QueueSummary, LogsData } from '@/types/summary'

export function fetchSummary(): Promise<QueueSummary> {
  return get<QueueSummary>('/api/summary')
}

export function fetchLogs(): Promise<LogsData> {
  return get<LogsData>('/api/logs')
}
