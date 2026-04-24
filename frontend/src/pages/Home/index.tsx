import { useNavigate } from 'react-router-dom'
import { useSummary } from '@/hooks/useSummary'
import { Card } from '@/components/Card'
import { StatusBadge } from '@/components/StatusBadge'
import styles from './Home.module.css'
import type { Job } from '@/types/job'
import { useQuery } from '@tanstack/react-query'
import { fetchJobs } from '@/api/jobs'

function QuickList({ title, jobs, tooltip }: { title: string; jobs: Job[]; tooltip: string }) {
  const navigate = useNavigate()
  if (jobs.length === 0) {
    return (
      <div className={styles.panel}>
        <h2 className={styles.panelTitle} title={tooltip}>{title}</h2>
        <p className="muted" style={{ fontSize: '0.9rem' }}>No rows right now.</p>
      </div>
    )
  }
  return (
    <div className={styles.panel}>
      <h2 className={styles.panelTitle} title={tooltip}>{title}</h2>
      <div className={styles.quickList}>
        {jobs.map(j => (
          <div
            key={j.id}
            className={styles.quickRow}
            onClick={() => navigate(`/jobs/${j.id}`)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && navigate(`/jobs/${j.id}`)}
            title={`Open job #${j.id}`}
          >
            <span className={styles.jobId} aria-label="Job ID">#{j.id}</span>
            <span className={styles.jobCompany}>{j.company ?? '—'}</span>
            <span className={styles.jobTitle}>{j.title ?? '—'}</span>
            <StatusBadge status={j.enrichment_status} size="sm" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const { data: summary, isLoading, error } = useSummary()

  const { data: readyJobs = [] }   = useQuery({ queryKey: ['jobs', { status: 'ready',   limit: 8 }], queryFn: () => fetchJobs({ status: 'ready',   limit: 8 }), staleTime: 30_000 })
  const { data: blockedJobs = [] } = useQuery({ queryKey: ['jobs', { status: 'blocked', limit: 8 }], queryFn: () => fetchJobs({ status: 'blocked', limit: 8 }), staleTime: 30_000 })
  const { data: failedJobs = [] }  = useQuery({ queryKey: ['jobs', { status: 'failed',  limit: 8 }], queryFn: () => fetchJobs({ status: 'failed',  limit: 8 }), staleTime: 30_000 })

  if (isLoading) return <div className={styles.loading}>Loading…</div>
  if (error || !summary) return <div className={styles.error}>Failed to load summary.</div>

  const done = (summary.counts_by_status['done'] ?? 0) + (summary.counts_by_status['done_verified'] ?? 0)
  const failed = summary.counts_by_status['failed'] ?? 0
  const authOk = summary.auth?.linkedin?.available !== false

  const statusCounts = summary.counts_by_status

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Overview</h1>
        <p className="muted">
          Quick entry to filtered job lists and a sample of rows that need attention.
          Full counts and auth detail: <a href="/logs" onClick={e => { e.preventDefault(); navigate('/logs') }}>Logs</a>.
          Bulk operations: <a href="/ops" onClick={e => { e.preventDefault(); navigate('/ops') }}>Ops</a>.
        </p>
      </section>

      {/* Stat cards */}
      <section className={styles.cards}>
        <Card
          label="Total jobs"
          value={summary.total}
          tooltip="All job rows in the database"
          onClick={() => navigate('/jobs?status=all')}
        />
        <Card
          label="Pending enrich"
          value={summary.pending_count}
          tooltip="Waiting to be picked up by the enrichment worker"
          onClick={() => navigate('/jobs?status=pending')}
          accent={summary.pending_count > 0}
        />
        <Card
          label="Enriched"
          value={done}
          tooltip="Successfully enriched (done + done_verified)"
          onClick={() => navigate('/jobs?status=done')}
        />
        <Card
          label="Failed"
          value={failed}
          tooltip="Enrichment failed — check error codes in Logs or Ops"
          onClick={() => navigate('/jobs?status=failed')}
          danger={failed > 0}
        />
        <Card
          label="Blocked"
          value={summary.blocked_count}
          tooltip="Blocked by LinkedIn anti-bot, auth expiry, or rate limits"
          onClick={() => navigate('/jobs?status=blocked')}
          warning={summary.blocked_count > 0}
        />
        <Card
          label="LinkedIn auth"
          value={authOk ? 'Ready' : 'Login needed'}
          tooltip={authOk
            ? 'LinkedIn auth state is saved and available for enrichment'
            : 'LinkedIn auth has expired — run hunter auth-save to refresh'}
          onClick={() => navigate('/logs')}
          danger={!authOk}
        />
      </section>

      {/* Jump strip */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Jump into the queue</h2>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
          {summary.total} total · {summary.ready_count} ready · {summary.pending_count} pending · {failed} failed · {done} done
        </p>
        <div className={styles.pills}>
          {[
            { label: 'All jobs',         status: 'all' },
            { label: 'Ready',            status: 'ready' },
            { label: 'Pending enrich',   status: 'pending' },
            { label: 'Processing',       status: 'processing' },
            { label: 'Failed',           status: 'failed' },
            { label: 'Blocked',          status: 'blocked' },
            { label: 'Done',             status: 'done' },
            { label: 'Done verified',    status: 'done_verified' },
          ].map(({ label, status }) => (
            <button
              key={status}
              className={styles.pill}
              onClick={() => navigate(`/jobs?status=${status}`)}
              title={`Show jobs with status: ${status}${statusCounts[status] !== undefined ? ` (${statusCounts[status]})` : ''}`}
            >
              {label}{statusCounts[status] !== undefined && status !== 'all' ? ` (${statusCounts[status]})` : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Quick lists */}
      <div className={styles.grid}>
        <QuickList title="Ready now" jobs={readyJobs} tooltip="Jobs enriched and ready for resume tailoring or apply" />
        <QuickList title="Blocked" jobs={blockedJobs} tooltip="Jobs where enrichment hit an auth wall or rate limit — needs operator attention" />
        <QuickList title="Failed" jobs={failedJobs} tooltip="Jobs where enrichment failed — check error codes and requeue from Ops" />
      </div>
    </div>
  )
}
