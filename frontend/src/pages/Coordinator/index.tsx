import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { approveC4Run, fetchC4Runs, fetchC4Status, triggerC4Run } from '@/api/control'
import { useUiStore } from '@/store/ui'
import { timeAgo } from '@/utils/time'
import styles from '@/pages/Control/Control.module.css'

export function CoordinatorPage() {
  const [jobId, setJobId] = useState('')
  const [reason, setReason] = useState('operator reviewed')
  const [lastResult, setLastResult] = useState<unknown>(null)
  const qc = useQueryClient()
  const showToast = useUiStore(s => s.showToast)

  const status = useQuery({ queryKey: ['c4-status'], queryFn: fetchC4Status, refetchInterval: 30_000, retry: false })
  const runs = useQuery({ queryKey: ['c4-runs'], queryFn: fetchC4Runs, refetchInterval: 15_000, retry: false })

  const startRun = useMutation({
    mutationFn: (id: number) => triggerC4Run(id),
    onSuccess: res => { setLastResult(res); showToast('Run started'); qc.invalidateQueries({ queryKey: ['c4-runs'] }) },
    onError: e => showToast(e instanceof Error ? e.message : 'Run start failed', 'error'),
  })
  const approveRun = useMutation({
    mutationFn: ({ runId, decision }: { runId: string; decision: 'approve' | 'deny' }) => approveC4Run(runId, decision, reason),
    onSuccess: res => { setLastResult(res); showToast('Decision sent'); qc.invalidateQueries({ queryKey: ['c4-runs'] }) },
    onError: e => showToast(e instanceof Error ? e.message : 'Decision failed', 'error'),
  })

  function submitRun() {
    const id = Number(jobId)
    if (!Number.isInteger(id) || id < 1) { showToast('Job ID required', 'error'); return }
    startRun.mutate(id)
  }

  const runRows = runs.data?.runs ?? []
  const serviceOnline = !status.error && !!status.data

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.heroTitle}>Coordinator</h1>
          <div className={styles.heroMeta}>C4 runs and approvals</div>
        </div>
        <div className={`${styles.statusPill} ${serviceOnline ? styles.statusPillOnline : styles.statusPillOffline}`}>
          <span className={styles.statusDot} />
          {status.isLoading ? 'Checking…' : serviceOnline ? 'Service online' : 'Service offline'}
        </div>
      </div>

      <div className={`${styles.panel} ${styles.panelStrong}`}>
        <h2 className={styles.panelTitle}>Start run</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end' }}>
            <label className={styles.field}>Job ID
              <input className={styles.input} value={jobId} inputMode="numeric" onChange={e => setJobId(e.target.value)} />
            </label>
            <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={startRun.isPending} onClick={submitRun}>
              {startRun.isPending ? 'Starting…' : 'Start'}
            </button>
          </div>
          <label className={styles.field}>Approval reason
            <input className={styles.input} value={reason} onChange={e => setReason(e.target.value)} />
          </label>
        </div>
        {lastResult ? <pre className={styles.pre} style={{ marginTop: 12 }}>{JSON.stringify(lastResult, null, 2)}</pre> : null}
      </div>

      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Recent runs</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Run</th><th>Job</th><th>Status</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              {runRows.length === 0
                ? <tr><td colSpan={5} className={styles.meta} style={{ padding: '12px 10px' }}>No runs yet.</td></tr>
                : runRows.map(run => {
                  const runId = String(run.id ?? run.run_id ?? '')
                  return (
                    <tr key={runId}>
                      <td className={styles.mono}>{runId}</td>
                      <td>{run.job_id ?? '-'}</td>
                      <td>{run.status ?? 'unknown'}</td>
                      <td className={styles.mono}>{timeAgo(String(run.updated_at ?? run.created_at ?? ''))}</td>
                      <td>
                        <div className={styles.actions}>
                          <button className={styles.btn} disabled={!runId || approveRun.isPending} onClick={() => approveRun.mutate({ runId, decision: 'approve' })}>Approve</button>
                          <button className={`${styles.btn} ${styles.btnDanger}`} disabled={!runId || approveRun.isPending} onClick={() => approveRun.mutate({ runId, decision: 'deny' })}>Deny</button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
