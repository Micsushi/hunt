import { useState } from 'react'
import { useLogs } from '@/hooks/useLogs'
import { timeAgo } from '@/utils/time'
import styles from './Logs.module.css'

function JsonExpander({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  if (value === null || value === undefined || value === '') return <span className={styles.muted}>-</span>
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const short = text.length > 96 ? text.slice(0, 96) + '…' : text
  return (
    <span>
      <button className={styles.expandBtn} onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'}</button>
      {open
        ? <pre className={styles.jsonPre}>{(() => { try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text } })()}</pre>
        : <span className={styles.monoSm}>{short}</span>
      }
    </span>
  )
}

type ServiceTab = 'all' | 'c0' | 'c1' | 'c2' | 'c3' | 'c4' | 'db'

const SERVICE_TABS: { key: ServiceTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'c0', label: 'C0' },
  { key: 'c1', label: 'C1' },
  { key: 'c2', label: 'C2' },
  { key: 'c3', label: 'C3 bridge' },
  { key: 'c4', label: 'C4' },
  { key: 'db', label: 'DB' },
]

const LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG']
const TIME_WINDOWS = [
  { key: '1h', label: '1h' },
  { key: '6h', label: '6h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
]

export function LogsPage() {
  const [tab, setTab] = useState<ServiceTab>('all')
  const [search, setSearch] = useState('')
  const [levels, setLevels] = useState<string[]>(['ERROR', 'WARN', 'INFO'])
  const [since, setSince] = useState('24h')
  const [limit, setLimit] = useState(100)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const { data, isLoading, error, dataUpdatedAt, refetch } = useLogs(
    { service: tab, levels, since, limit },
    autoRefresh ? 15_000 : false,
  )

  function toggleLevel(level: string) {
    setLevels(prev => prev.includes(level) ? prev.filter(v => v !== level) : [...prev, level])
  }

  if (isLoading) return <div className={styles.loading}>Loading…</div>
  if (error || !data) return <div className={styles.error}>Failed to load logs.</div>

  const { summary, activity } = data
  const li = summary.auth?.linkedin ?? {}
  const authOk = li.available !== false
  const done = (summary.counts_by_status['done'] ?? 0) + (summary.counts_by_status['done_verified'] ?? 0)
  const failed = summary.counts_by_status['failed'] ?? 0

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.heroTitle}>Logs &amp; health</h1>
          <p className={styles.heroMeta}>
            Auth · queue · runtime state · audit
            {dataUpdatedAt ? ` · updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}
          </p>
        </div>
        <button className={styles.refreshBtn} onClick={() => refetch()}>Refresh</button>
      </div>

      {/* Auth banner */}
      <div className={`${styles.authBanner} ${authOk ? styles.authOk : styles.authBad}`}>
        <span className={styles.authDot} />
        <div>
          <strong>{authOk ? 'LinkedIn auth ready' : 'LinkedIn auth needs refresh'}</strong>
          {!authOk && <p className={styles.authSub}>Run: <code>DISPLAY=:98 ./hunter.sh auth-save --channel chrome</code></p>}
          {li.updated_at && <p className={styles.authSub}>Last updated: {timeAgo(li.updated_at)}</p>}
          {li.last_error && <p className={styles.authErr}>Last error: {li.last_error}</p>}
        </div>
      </div>

      {/* Stat row */}
      <div className={styles.statRow}>
        {[
          { label: 'Total',      val: summary.total },
          { label: 'Pending',    val: summary.pending_count },
          { label: 'Processing', val: summary.processing_count },
          { label: 'Blocked',    val: summary.blocked_count },
          { label: 'Failed',     val: failed },
          { label: 'Done',       val: done },
          { label: 'Stale',      val: summary.stale_processing_count },
          { label: 'Retry due',  val: summary.retry_ready_count },
        ].map(({ label, val }) => (
          <div key={label} className={styles.statCell}>
            <span className={styles.statVal}>{val}</span>
            <span className={styles.statLabel}>{label}</span>
          </div>
        ))}
      </div>

      <div className={styles.controls}>
        <div className={styles.tabs}>
          {SERVICE_TABS.map(t => (
            <button key={t.key} className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <input
          className={styles.search}
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className={styles.controls}>
        <div className={styles.tabs}>
          {LEVELS.map(level => (
            <button
              key={level}
              className={`${styles.tab} ${levels.includes(level) ? styles.tabActive : ''}`}
              onClick={() => toggleLevel(level)}
            >
              {level}
            </button>
          ))}
        </div>
        <div className={styles.tabs}>
          {TIME_WINDOWS.map(w => (
            <button key={w.key} className={`${styles.tab} ${since === w.key ? styles.tabActive : ''}`} onClick={() => { setSince(w.key); setLimit(100) }}>
              {w.label}
            </button>
          ))}
        </div>
        <label className={styles.toggle}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          Auto-refresh
        </label>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Activity (last {activity.hours}h)</h2>
        <div className={styles.activityRow}>
          <span>Enriched: <strong>{activity.done_or_verified}</strong></span>
          <span>Failed: <strong>{activity.failed_scraped_window}</strong></span>
          <span>Scraped: <strong>{activity.rows_scraped_window}</strong></span>
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Event stream</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Time</th><th>Level</th><th>Service</th><th>Message</th><th>Detail</th></tr></thead>
            <tbody>
              {data.logs
                .filter(row => !search || `${row.message} ${JSON.stringify(row.detail ?? '')}`.toLowerCase().includes(search.toLowerCase()))
                .map((row, i) => (
                  <tr key={`${row.service}-${row.level}-${row.at ?? 'na'}-${i}`}>
                    <td className={styles.ts} title={row.at ?? undefined}>{timeAgo(row.at)}</td>
                    <td><span className={`${styles.levelBadge} ${styles[`level${row.level}`]}`}>{row.level}</span></td>
                    <td className={styles.serviceTag}>{row.service.toUpperCase()}</td>
                    <td>{row.message}</td>
                    <td><JsonExpander value={row.detail} /></td>
                  </tr>
                ))}
              {data.logs.length === 0 ? (
                <tr><td colSpan={5} className={styles.muted}>No log rows match this filter.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <button className={styles.loadMore} onClick={() => setLimit(v => v + 100)}>Load more</button>
      </div>

      {/* Monitoring endpoints */}
      {tab === 'all' && (
        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Monitoring endpoints</h2>
          <div className={styles.endpointRow}>
            <a href="/health"      target="_blank" rel="noreferrer" className={styles.endLink}>GET /health</a>
            <a href="/api/summary" target="_blank" rel="noreferrer" className={styles.endLink}>GET /api/summary</a>
            <a href="/metrics"     target="_blank" rel="noreferrer" className={styles.endLink}>GET /metrics</a>
          </div>
        </div>
      )}
    </div>
  )
}
