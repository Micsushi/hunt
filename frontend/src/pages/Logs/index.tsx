import { useState } from 'react'
import { useLogs } from '@/hooks/useLogs'
import styles from './Logs.module.css'

const ERROR_CODE_TIPS: Record<string, string> = {
  auth_expired:        'LinkedIn session expired — run: hunter auth-save',
  rate_limited:        'LinkedIn rate limit hit — wait and requeue from Ops',
  automation_detected: 'LinkedIn anti-bot triggered — browser fingerprint issue',
  network_error:       'Network or DNS failure during enrichment',
  parse_error:         'Page HTML changed and parser could not extract data',
  timeout:             'Browser timed out loading the page',
}

function JsonExpander({ value }: { value: string | null }) {
  const [open, setOpen] = useState(false)
  if (!value) return <span className="muted">—</span>
  const short = value.length > 80 ? value.slice(0, 80) + '…' : value
  return (
    <span>
      <button className={styles.expandBtn} onClick={() => setOpen(o => !o)} title="Toggle full value">
        {open ? '▾' : '▸'}
      </button>
      {open
        ? <pre className={styles.jsonPre}>{(() => { try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value } })()}</pre>
        : <span className="mono" style={{ fontSize: '0.82rem' }}>{short}</span>
      }
    </span>
  )
}

export function LogsPage() {
  const { data, isLoading, error, dataUpdatedAt } = useLogs(30_000)

  if (isLoading) return <div className={styles.loading}>Loading…</div>
  if (error || !data) return <div className={styles.error}>Failed to load logs.</div>

  const { summary, activity, runtime_state, audit } = data
  const li = summary.auth?.linkedin ?? {}
  const authOk = li.available !== false
  const done = (summary.counts_by_status['done'] ?? 0) + (summary.counts_by_status['done_verified'] ?? 0)

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Logs &amp; health</h1>
        <p className="muted">
          Auth status, queue counts, runtime events, and audit trail.
          Auto-refreshes every 30 seconds.
          {dataUpdatedAt ? <span style={{ marginLeft: 8, fontSize: '0.82rem' }}>Last updated: {new Date(dataUpdatedAt).toLocaleTimeString()}</span> : null}
        </p>
      </section>

      {/* LinkedIn auth status */}
      <div className={`${styles.authCard} ${authOk ? styles.authOk : styles.authBad}`}>
        <div className={styles.authHeader}>
          <span className={styles.authDot} aria-hidden="true" />
          <strong>{authOk ? 'LinkedIn auth ready' : 'LinkedIn auth needs refresh'}</strong>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: '0.9rem' }}>
          {authOk
            ? 'Saved LinkedIn session is available for unattended enrichment.'
            : 'LinkedIn enrichment is paused. Refresh with: DISPLAY=:98 ./hunter.sh auth-save --channel chrome'
          }
        </p>
        {li.updated_at && <p className="muted" style={{ fontSize: '0.82rem', marginTop: 6 }}>Last updated: {li.updated_at}</p>}
        {li.last_error && <p style={{ color: 'var(--danger)', fontSize: '0.82rem', marginTop: 4 }}>Last error: {li.last_error}</p>}
      </div>

      {/* Queue summary */}
      <div className={styles.gridThree}>
        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Queue summary</h2>
          <table className={styles.table}>
            <tbody>
              {[
                ['Total rows',         summary.total,                    'All job rows in the database'],
                ['Pending enrich',     summary.pending_count,            'Waiting to be picked up by the enrichment worker'],
                ['Retry due',          summary.retry_ready_count,        'Failed rows now eligible to retry (past their backoff timer)'],
                ['Processing',         summary.processing_count,         'Currently being enriched by a worker'],
                ['Blocked',            summary.blocked_count,            'Blocked by anti-bot, auth expiry, or rate limits'],
                ['Stale processing',   summary.stale_processing_count,   'Rows stuck in "processing" state longer than expected — may need a stale reset in Ops'],
                ['Enriched (done)',    done,                             'Successfully enriched (done + done_verified)'],
                ['Oldest processing',  summary.oldest_processing_started_at ?? '—', 'When the oldest currently-processing row started — helps detect stuck workers'],
              ].map(([label, value, tip]) => (
                <tr key={String(label)}>
                  <td className={styles.tableLabel} title={String(tip)}>{label} <span className={styles.tipIcon} aria-hidden="true">?</span></td>
                  <td className={styles.tableValue}>{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Counts by status</h2>
          <table className={styles.table}>
            <thead><tr><th>Status</th><th>Count</th></tr></thead>
            <tbody>
              {Object.entries(summary.counts_by_status).sort().map(([s, n]) => (
                <tr key={s}><td>{s.replace(/_/g, ' ')}</td><td>{n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Counts by source</h2>
          <table className={styles.table}>
            <thead><tr><th>Source</th><th>Count</th></tr></thead>
            <tbody>
              {Object.entries(summary.source_counts).sort().map(([s, n]) => (
                <tr key={s}><td>{s}</td><td>{n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Activity */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Activity (last {activity.hours}h)</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 10 }}>
          Done counts use enriched_at. Failed count uses date_scraped as a proxy.
        </p>
        <table className={styles.table}>
          <tbody>
            <tr><td title="Jobs enriched successfully in the last 24 hours">Done or verified</td><td>{activity.done_or_verified}</td></tr>
            <tr><td title="Jobs where enrichment failed (scraped in the same window)">Failed (scraped in window)</td><td>{activity.failed_scraped_window}</td></tr>
            <tr><td title="New jobs discovered in the last 24 hours">Rows scraped in window</td><td>{activity.rows_scraped_window}</td></tr>
          </tbody>
        </table>
      </div>

      {/* Failure breakdown */}
      {Object.keys(summary.failure_counts).length > 0 && (
        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Failure breakdown by error code</h2>
          <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 10 }}>
            Hover an error code for a description. Requeue from the Ops page.
          </p>
          <table className={styles.table}>
            <thead><tr><th>Error code</th><th>Count</th></tr></thead>
            <tbody>
              {Object.entries(summary.failure_counts).sort().map(([code, count]) => (
                <tr key={code}>
                  <td className="mono" style={{ fontSize: '0.88rem' }} title={ERROR_CODE_TIPS[code] ?? code}>{code}</td>
                  <td>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Runtime state */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Runtime state (recent)</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 10 }}>
          Latest entries from the runtime_state table — LinkedIn auth markers, rate-limit flags, and review audit tail.
          Click ▸ to expand the full value.
        </p>
        {runtime_state.length === 0
          ? <p className="muted">No runtime state rows.</p>
          : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>Key</th><th>Updated</th><th>Value</th></tr></thead>
                <tbody>
                  {runtime_state.map(row => (
                    <tr key={row.key}>
                      <td className="mono" style={{ fontSize: '0.83rem', whiteSpace: 'nowrap' }}>{row.key}</td>
                      <td className="mono" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap', color: 'var(--muted)' }}>{row.updated_at ?? '—'}</td>
                      <td><JsonExpander value={row.value} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>

      {/* Audit log */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Review audit (recent)</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 10 }}>
          Last writes from the control plane — bulk requeue, stale reset, priority changes.
        </p>
        {audit.length === 0
          ? <p className="muted">No audit entries yet.</p>
          : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead><tr><th>At</th><th>Action</th><th>Detail</th></tr></thead>
                <tbody>
                  {audit.map((entry, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{entry.at}</td>
                      <td style={{ fontWeight: 600, fontSize: '0.88rem' }}>{entry.action}</td>
                      <td><JsonExpander value={entry.detail ? JSON.stringify(entry.detail) : null} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>

      {/* Monitoring endpoints */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Monitoring endpoints</h2>
        <div className={styles.pills}>
          <a href="/health"   target="_blank" rel="noreferrer" className={styles.pill} title="Raw JSON health check — returns queue summary">GET /health (JSON)</a>
          <a href="/api/summary" target="_blank" rel="noreferrer" className={styles.pill} title="Full queue summary JSON used by this page">GET /api/summary</a>
          <a href="/metrics"  target="_blank" rel="noreferrer" className={styles.pill} title="Prometheus-format metrics for external monitoring">GET /metrics</a>
        </div>
      </div>
    </div>
  )
}
