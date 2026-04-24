import { useState } from 'react'
import { useSummary } from '@/hooks/useSummary'
import { useUiStore } from '@/store/ui'
import { requeueErrors, requeueStaleProcessing, bulkRequeue } from '@/api/ops'
import { useQueryClient } from '@tanstack/react-query'
import styles from './Ops.module.css'

const REQUEUE_BUTTONS = [
  { label: 'LinkedIn: auth_expired + rate_limited', source: 'linkedin', codes: ['auth_expired', 'rate_limited'], primary: true },
  { label: 'LinkedIn: auth_expired only',           source: 'linkedin', codes: ['auth_expired'] },
  { label: 'LinkedIn: rate_limited only',           source: 'linkedin', codes: ['rate_limited'] },
  { label: 'Indeed: rate_limited',                  source: 'indeed',   codes: ['rate_limited'] },
  { label: 'All sources: both codes',               source: 'all',      codes: ['auth_expired', 'rate_limited'] },
]

const BULK_STATUS_OPTIONS = [
  { value: 'failed',           label: 'Failed' },
  { value: 'blocked',          label: 'Blocked' },
  { value: 'blocked_verified', label: 'Blocked verified' },
  { value: 'processing',       label: 'Processing' },
  { value: 'pending',          label: 'Pending enrichment' },
]

export function OpsPage() {
  const { data: summary } = useSummary(30_000)
  const showToast = useUiStore(s => s.showToast)
  const qc = useQueryClient()
  const [loadingBtn, setLoadingBtn] = useState<string | null>(null)
  const [staleResult, setStaleResult] = useState<string | null>(null)
  const [bulkStatuses, setBulkStatuses] = useState<string[]>(['failed'])
  const [bulkDryResult, setBulkDryResult] = useState<string | null>(null)

  const failureCounts = summary?.failure_counts ?? {}
  const authN = failureCounts['auth_expired'] ?? 0
  const rateN = failureCounts['rate_limited'] ?? 0
  const staleN = summary?.stale_processing_count ?? 0

  async function handleRequeue(source: string, codes: string[], key: string) {
    setLoadingBtn(key)
    try {
      const res = await requeueErrors({ source, error_codes: codes })
      showToast(`Requeued ${res.updated} row(s)`)
      qc.invalidateQueries({ queryKey: ['summary'] })
      qc.invalidateQueries({ queryKey: ['jobs'] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Requeue failed', 'error')
    } finally {
      setLoadingBtn(null)
    }
  }

  async function handleStale() {
    setLoadingBtn('stale')
    try {
      const res = await requeueStaleProcessing()
      setStaleResult(`Updated ${res.updated} row(s)`)
      showToast(`Stale reset: ${res.updated} row(s)`)
      qc.invalidateQueries({ queryKey: ['summary'] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Stale reset failed', 'error')
    } finally {
      setLoadingBtn(null)
    }
  }

  async function handleBulk(dry: boolean) {
    if (!bulkStatuses.length) { showToast('Select at least one status', 'error'); return }
    setLoadingBtn(dry ? 'bulk-dry' : 'bulk-run')
    try {
      const res = await bulkRequeue({ source: null, status: 'all', q: '', tag: '', target_statuses: bulkStatuses, dry_run: dry })
      if (dry) {
        setBulkDryResult(`Would requeue ${res.count} row(s)`)
      } else {
        showToast(`Requeued ${res.updated} row(s)`)
        setBulkDryResult(null)
        qc.invalidateQueries({ queryKey: ['summary'] })
        qc.invalidateQueries({ queryKey: ['jobs'] })
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Bulk requeue failed', 'error')
    } finally {
      setLoadingBtn(null)
    }
  }

  function toggleBulkStatus(val: string) {
    setBulkStatuses(prev => prev.includes(val) ? prev.filter(s => s !== val) : [...prev, val])
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Operator console</h1>
        <p className="muted">
          Bulk requeue for common enrichment failures, stale processing reset, and bulk filter operations.
          API reference at the bottom.
        </p>
      </section>

      {/* Transient failures */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Transient failures: one-click requeue</h2>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 8 }}>
          Moves failed rows back to pending (clears retry timers). Use after auth is refreshed or a rate-limit window has passed.
        </p>
        <p style={{ fontSize: '0.88rem', marginBottom: 14 }}>
          Current failed counts: <strong>auth_expired</strong> {authN} · <strong>rate_limited</strong> {rateN}
        </p>
        <div className={styles.buttons}>
          {REQUEUE_BUTTONS.map(btn => {
            const key = `${btn.source}-${btn.codes.join(',')}`
            return (
              <button
                key={key}
                className={`${styles.btn} ${btn.primary ? styles.btnPrimary : ''}`}
                onClick={() => handleRequeue(btn.source, btn.codes, key)}
                disabled={loadingBtn === key}
                title={`Requeue ${btn.source} rows with error codes: ${btn.codes.join(', ')}`}
              >
                {loadingBtn === key ? 'Working…' : btn.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Stale processing */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Stale processing reset</h2>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 8 }}>
          Rows stuck in "processing" state are moved back to "pending". Use when a worker crashed mid-enrichment.
        </p>
        <p style={{ fontSize: '0.88rem', marginBottom: 14 }}>
          Current stale processing rows: <strong>{staleN}</strong>
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleStale}
            disabled={loadingBtn === 'stale'}
            title="Move all stale processing rows back to pending"
          >
            {loadingBtn === 'stale' ? 'Working…' : 'Requeue stale processing'}
          </button>
          {staleResult && <span className="muted" style={{ fontSize: '0.88rem' }}>{staleResult}</span>}
        </div>
      </div>

      {/* Bulk requeue */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Bulk requeue by status</h2>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
          Moves all rows with the selected statuses back to pending. Operates across all sources.
          Server caps batch size. Use dry run first to count before committing.
        </p>
        <div className={styles.checkboxRow}>
          {BULK_STATUS_OPTIONS.map(o => (
            <label key={o.value} className={styles.checkLabel} title={`Include ${o.label} rows in the requeue`}>
              <input
                type="checkbox"
                checked={bulkStatuses.includes(o.value)}
                onChange={() => toggleBulkStatus(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className={styles.btn} onClick={() => handleBulk(true)} disabled={!!loadingBtn} title="Count how many rows would be moved without changing anything">
            {loadingBtn === 'bulk-dry' ? 'Counting…' : 'Count only (dry run)'}
          </button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => handleBulk(false)} disabled={!!loadingBtn} title="Move all matching rows to pending">
            {loadingBtn === 'bulk-run' ? 'Working…' : 'Requeue matching rows'}
          </button>
          {bulkDryResult && <span className="muted" style={{ fontSize: '0.88rem' }}>{bulkDryResult}</span>}
        </div>
      </div>

      {/* API reference */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>API reference</h2>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 10 }}>
          All POST endpoints accept JSON. Include the session cookie (set by logging in).
        </p>
        <pre className={styles.apiRef}>{`POST /api/ops/requeue-errors
  { "source": "linkedin", "error_codes": ["auth_expired", "rate_limited"] }

POST /api/ops/bulk-requeue
  { "source": null, "status": "all", "q": "", "tag": "",
    "target_statuses": ["failed", "blocked"], "dry_run": false }

POST /api/ops/requeue-stale-processing
  {}

POST /api/jobs/bulk-selection
  { "action": "requeue"|"set_status"|"delete",
    "job_ids": [1,2,3],
    "enrichment_status": "pending",   // only for set_status
    "confirm_delete": true }          // only for delete

CLI equivalent:
  python3 scripts/hunterctl.py requeue-retryable
  python3 scripts/hunterctl.py requeue-errors --error-code auth_expired`}
        </pre>
      </div>
    </div>
  )
}
