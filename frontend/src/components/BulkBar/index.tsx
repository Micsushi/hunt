import { useEffect, useRef, useState } from 'react'
import { useUiStore } from '@/store/ui'
import { bulkSelection } from '@/api/jobs'
import { useQueryClient } from '@tanstack/react-query'
import styles from './BulkBar.module.css'
import { ApiError, post } from '@/api/client'
import { downloadApplicationHandoff, sendApplicationsToBrowser } from '@/api/c3'
import { usesBrowserC3 } from '@/api/browserC3'
import { Link, useNavigate } from 'react-router-dom'

type HandoffOutcome = {
  sourceJobId: number
  status: 'confirmed' | 'unconfirmed' | 'not_sent' | 'rejected'
}
type HandoffResult = { selection: Set<number>; outcomes: HandoffOutcome[]; message: string }

const STATUS_CHOICES = [
  { value: 'pending', label: 'Pending enrichment' },
  { value: 'processing', label: 'Processing' },
  { value: 'failed', label: 'Failed' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'blocked_verified', label: 'Blocked verified' },
  { value: 'done', label: 'Done' },
  { value: 'done_verified', label: 'Done verified' },
]

export function BulkBar({ disabled = false }: { disabled?: boolean }) {
  const navigate = useNavigate()
  const { selectedIds, clearSelection, selectAll, showToast } = useUiStore()
  const qc = useQueryClient()
  const [action, setAction] = useState('')
  const [status, setStatus] = useState('pending')
  const [loading, setLoading] = useState(false)
  const active = useRef(false)
  const pending = useRef(false)
  const [applicationBatch, setApplicationBatch] = useState<number[]>([])
  const [result, setResult] = useState<HandoffResult | null>(null)
  const runButton = useRef<HTMLButtonElement>(null)
  const recoveryButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (
      result &&
      (document.activeElement === runButton.current || document.activeElement === document.body)
    ) {
      recoveryButton.current?.focus()
    }
  }, [result])
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const ids = Array.from(selectedIds)
  const n = ids.length

  const awaitingReview = action === 'apply' && result?.selection === selectedIds
  const unsent =
    result?.outcomes.filter((item) => item.status === 'not_sent').map((item) => item.sourceJobId) ??
    []

  if (n === 0 && !loading && !result) return null

  async function run() {
    if (disabled || pending.current || awaitingReview || n === 0) return
    if (['apply', 'download-applications'].includes(action) && n > 30) {
      showToast('Select up to 30 jobs for one application batch', 'error')
      return
    }
    if (!action) {
      showToast('Choose an action', 'error')
      return
    }
    if (action === 'delete') {
      if (!confirm(`Delete ${n} job row(s)? This cannot be undone.`)) return
    }
    pending.current = true
    setLoading(true)
    setApplicationBatch(action === 'apply' ? ids : [])
    if (action === 'apply') setResult(null)
    try {
      if (action === 'download-applications') {
        await downloadApplicationHandoff(ids)
        if (active.current)
          showToast(
            'Download started. In your local C3 workspace, open Applications and import this file.',
          )
        return
      }
      if (action === 'apply') {
        if (usesBrowserC3()) {
          const transferred = await sendApplicationsToBrowser(ids)
          if (active.current) {
            setResult({
              selection: selectedIds,
              outcomes: ids.map((sourceJobId) => ({ sourceJobId, status: 'confirmed' })),
              message: transferred.workspaceOpened
                ? 'Applications added paused. Continue in the local C3 workspace.'
                : 'Applications added paused. In Hunt C3, choose Open workspace.',
            })
          }
          return
        }
        await post('/api/c3/handoff', { job_ids: ids })
        if (active.current) {
          if (useUiStore.getState().selectedIds === selectedIds) {
            clearSelection()
            navigate('/executioner')
          } else {
            setResult({
              selection: selectedIds,
              outcomes: ids.map((sourceJobId) => ({ sourceJobId, status: 'confirmed' })),
              message: 'Batch confirmed in Applications. Your new selection is unchanged.',
            })
          }
        }
        return
      }
      const res = await bulkSelection({
        action: action as 'requeue' | 'set_status' | 'delete',
        job_ids: ids,
        enrichment_status: action === 'set_status' ? status : undefined,
        confirm_delete: action === 'delete' ? true : undefined,
      })
      if (active.current) {
        showToast(`Updated ${res.updated} row(s)`)
        if (useUiStore.getState().selectedIds === selectedIds) clearSelection()
      }
      qc.invalidateQueries({ queryKey: ['jobs'] })
      qc.invalidateQueries({ queryKey: ['summary'] })
    } catch (e) {
      if (active.current) {
        if (action === 'apply') {
          const outcomes =
            e instanceof ApiError
              ? (e.data as { outcomes?: HandoffOutcome[] } | undefined)?.outcomes
              : undefined
          const valid =
            Array.isArray(outcomes) &&
            outcomes.length === ids.length &&
            ids.every(
              (id) =>
                outcomes.filter(
                  (item) =>
                    item?.sourceJobId === id &&
                    ['confirmed', 'unconfirmed', 'not_sent', 'rejected'].includes(item.status),
                ).length === 1,
            )
          setResult({
            selection: selectedIds,
            outcomes: valid
              ? outcomes
              : ids.map((sourceJobId) => ({ sourceJobId, status: 'unconfirmed' })),
            message:
              e instanceof Error
                ? e.message
                : 'Handoff could not be confirmed. Check Applications.',
          })
        } else showToast(e instanceof Error ? e.message : 'Action failed', 'error')
      }
    } finally {
      pending.current = false
      if (active.current) setLoading(false)
    }
  }

  return (
    <div className={styles.bar} role="region" aria-label="Bulk actions">
      <span className={styles.count}>{n} selected</span>

      <label className={styles.label}>
        Action
        <select
          disabled={loading}
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className={styles.select}
        >
          <option value="">Choose…</option>
          <option value="requeue">Requeue enrichment</option>
          <option value="apply">
            {usesBrowserC3() ? 'Send to local C3' : 'Fill applications'}
          </option>
          <option value="download-applications">Download application file</option>
          <option value="set_status">Set enrichment status</option>
          <option value="delete">Delete jobs</option>
        </select>
      </label>

      {action === 'set_status' && (
        <label className={styles.label}>
          New status
          <select
            disabled={loading}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={styles.select}
          >
            {STATUS_CHOICES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        ref={runButton}
        className={styles.runBtn}
        onClick={run}
        disabled={disabled || loading || !action || n === 0 || awaitingReview}
      >
        {loading ? 'Working…' : 'Run action'}
      </button>

      <button className={styles.clearBtn} onClick={clearSelection} aria-label="Clear selected jobs">
        Clear
      </button>
      {loading && applicationBatch.length > 0 && (
        <p className={styles.result} role="status">
          Sending jobs {applicationBatch.map((id) => `#${id}`).join(', ')}. Stops before submission.
        </p>
      )}
      {result && (
        <div className={styles.result}>
          <p role="status">{result.message}</p>
          <ul>
            {result.outcomes.map((item) => (
              <li key={item.sourceJobId}>
                <Link to={`/jobs/${item.sourceJobId}`}>Job #{item.sourceJobId}</Link>:{' '}
                <span>
                  {
                    {
                      confirmed: 'Confirmed in Applications',
                      unconfirmed: 'Not confirmed. Check Applications.',
                      not_sent: 'Not sent',
                      rejected: 'Rejected. Open the job to resolve the issue.',
                    }[item.status]
                  }
                </span>
              </li>
            ))}
          </ul>
          <button
            ref={recoveryButton}
            className={styles.clearBtn}
            onClick={() => navigate('/executioner')}
          >
            View Applications
          </button>
          {unsent.length > 0 && (
            <button
              className={styles.clearBtn}
              disabled={loading}
              onClick={() => {
                selectAll(unsent)
                setAction('apply')
              }}
            >
              Select unsent jobs
            </button>
          )}
        </div>
      )}
    </div>
  )
}
