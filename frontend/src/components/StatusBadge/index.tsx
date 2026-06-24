import styles from './StatusBadge.module.css'
import type { EnrichmentStatus } from '@/types/job'

const LABELS: Record<string, string> = {
  pending: 'Pending enrichment',
  processing: 'Processing',
  done: 'Done',
  done_verified: 'Done (verified)',
  failed: 'Failed',
  failed_url: 'Failed URL',
  failed_description: 'Failed description',
  failed_enrichment: 'Failed enrichment',
  blocked: 'Blocked',
  blocked_verified: 'Blocked (verified)',
}

const TOOLTIPS: Record<string, string> = {
  pending: 'Waiting to be picked up by the enrichment worker',
  processing: 'Currently being enriched - a worker has claimed this row',
  done: 'Enrichment succeeded: description and apply URL resolved',
  done_verified: 'Enrichment verified by a second pass',
  failed: 'Enrichment failed - check last_enrichment_error for the reason',
  failed_url: 'Description may exist, but no confident external apply URL was found',
  failed_description: 'Apply URL may exist, but no usable job description was found',
  failed_enrichment: 'Both description and apply URL enrichment failed',
  blocked: 'Blocked by LinkedIn auth, rate limits, or anti-bot detection',
  blocked_verified: 'Blocked and manually confirmed - needs operator attention',
}

interface Props {
  status: EnrichmentStatus | string | null | undefined
  size?: 'sm' | 'md'
}

export function StatusBadge({ status, size = 'md' }: Props) {
  const key = (status ?? '').toString().trim()
  const label = LABELS[key] ?? (key.replace(/_/g, ' ') || 'Unknown')
  const tip = TOOLTIPS[key]
  return (
    <span
      className={`${styles.badge} ${styles[key] ?? styles.unknown} ${size === 'sm' ? styles.sm : ''}`}
      title={tip}
    >
      {label}
    </span>
  )
}
