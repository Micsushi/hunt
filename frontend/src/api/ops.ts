import { post } from './client'

export function requeueErrors(payload: {
  source: string
  error_codes: string[]
}): Promise<{ status: string; updated: number }> {
  return post('/api/ops/requeue-errors', payload)
}

export function bulkRequeue(payload: {
  source: string | null
  status: string
  q: string
  tag: string
  target_statuses: string[]
  dry_run: boolean
}): Promise<{ status: string; updated?: number; count?: number; dry_run: boolean }> {
  return post('/api/ops/bulk-requeue', payload)
}

export function requeueStaleProcessing(): Promise<{ status: string; updated: number }> {
  return post('/api/ops/requeue-stale-processing', {})
}
