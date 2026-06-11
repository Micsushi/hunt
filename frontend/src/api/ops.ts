import { post } from './client'
import { logHumanCommand } from './humanCommandLog'

export function requeueErrors(payload: {
  source: string
  error_codes: string[]
}): Promise<{ status: string; updated: number }> {
  void logHumanCommand({
    action: 'c0.ops.requeue_errors',
    buttonId: 'requeue-transient-errors',
    details: {
      source: payload.source,
      errorCodes: payload.error_codes,
    },
  })
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
  void logHumanCommand({
    action: payload.dry_run ? 'c0.ops.bulk_requeue_count' : 'c0.ops.bulk_requeue',
    buttonId: payload.dry_run ? 'bulk-requeue-dry-run' : 'bulk-requeue-run',
    details: {
      source: payload.source,
      status: payload.status,
      targetStatuses: payload.target_statuses,
      dryRun: payload.dry_run,
      hasQuery: Boolean(payload.q),
      hasTag: Boolean(payload.tag),
    },
  })
  return post('/api/ops/bulk-requeue', payload)
}

export function requeueStaleProcessing(): Promise<{ status: string; updated: number }> {
  void logHumanCommand({
    action: 'c0.ops.requeue_stale_processing',
    buttonId: 'requeue-stale-processing',
  })
  return post('/api/ops/requeue-stale-processing', {})
}
