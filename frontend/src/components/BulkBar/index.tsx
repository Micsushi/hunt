import { useState } from 'react'
import { useUiStore } from '@/store/ui'
import { bulkSelection } from '@/api/jobs'
import { useQueryClient } from '@tanstack/react-query'
import styles from './BulkBar.module.css'

const STATUS_CHOICES = [
  { value: 'pending',          label: 'Pending enrichment' },
  { value: 'processing',       label: 'Processing' },
  { value: 'failed',           label: 'Failed' },
  { value: 'blocked',          label: 'Blocked' },
  { value: 'blocked_verified', label: 'Blocked verified' },
  { value: 'done',             label: 'Done' },
  { value: 'done_verified',    label: 'Done verified' },
]

export function BulkBar() {
  const { selectedIds, clearSelection, showToast } = useUiStore()
  const qc = useQueryClient()
  const [action, setAction] = useState('')
  const [status, setStatus] = useState('pending')
  const [loading, setLoading] = useState(false)
  const ids = Array.from(selectedIds)
  const n = ids.length

  if (n === 0) return null

  async function run() {
    if (!action) { showToast('Choose an action', 'error'); return }
    if (action === 'delete') {
      if (!confirm(`Delete ${n} job row(s)? This cannot be undone.`)) return
    }
    setLoading(true)
    try {
      const res = await bulkSelection({
        action: action as 'requeue' | 'set_status' | 'delete',
        job_ids: ids,
        enrichment_status: action === 'set_status' ? status : undefined,
        confirm_delete: action === 'delete' ? true : undefined,
      })
      showToast(`Updated ${res.updated} row(s)`)
      clearSelection()
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['summary'] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Action failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.bar} role="region" aria-label="Bulk actions">
      <span className={styles.count}>{n} selected</span>

      <label className={styles.label}>
        Action
        <select value={action} onChange={e => setAction(e.target.value)} className={styles.select}>
          <option value="">Choose…</option>
          <option value="requeue">Requeue for enrichment</option>
          <option value="set_status">Set enrichment status…</option>
          <option value="delete">Delete rows…</option>
        </select>
      </label>

      {action === 'set_status' && (
        <label className={styles.label}>
          New status
          <select value={status} onChange={e => setStatus(e.target.value)} className={styles.select}>
            {STATUS_CHOICES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}

      <button
        className={styles.runBtn}
        onClick={run}
        disabled={loading || !action}
        title="Apply the selected action to all checked rows"
      >
        {loading ? 'Working…' : 'Run action'}
      </button>

      <button
        className={styles.clearBtn}
        onClick={clearSelection}
        title="Deselect all rows"
      >
        Clear
      </button>
    </div>
  )
}
