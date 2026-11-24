import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLogs } from '@/hooks/useLogs'
import { timeAgo } from '@/utils/time'
import styles from './Logs.module.css'

function JsonExpander({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  if (value === null || value === undefined || value === '')
    return <span className={styles.muted}>-</span>
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (
    <span>
      <button className={styles.expandBtn} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide details' : 'Details'}
      </button>
      {open ? (
        <pre className={styles.jsonPre}>
          {(() => {
            try {
              return JSON.stringify(JSON.parse(text), null, 2)
            } catch {
              return text
            }
          })()}
        </pre>
      ) : null}
    </span>
  )
}

type ServiceTab = 'all' | 'c0' | 'c1' | 'c2' | 'db'

const SERVICE_TABS: { key: ServiceTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'c0', label: 'C0' },
  { key: 'c1', label: 'C1' },
  { key: 'c2', label: 'C2' },
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
  const { data, isFetching, error, refetch } = useLogs(
    { service: tab, levels, since, limit },
    autoRefresh ? 15_000 : false,
  )

  function toggleLevel(level: string) {
    setLevels((prev) => (prev.includes(level) ? prev.filter((v) => v !== level) : [...prev, level]))
  }

  const summary = data?.summary
  const activity = data?.activity
  const li = summary?.auth?.linkedin
  const authOk = li?.available === true
  const authMissing = li?.available !== true && li?.available !== false
  const visibleLogs =
    data?.logs.filter(
      (row) =>
        levels.includes(row.level) &&
        `${row.message} ${JSON.stringify(row.detail ?? '')}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    ) ?? []

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <h1 className={styles.heroTitle}>Logs &amp; health</h1>
        <button
          className={styles.refreshBtn}
          aria-disabled={isFetching}
          onClick={() => {
            if (!isFetching) void refetch({ cancelRefetch: false })
          }}
        >
          {isFetching ? 'Refreshing…' : error ? 'Retry logs' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {data
            ? 'Could not refresh logs. Showing the last loaded results. Retry for current events.'
            : 'Could not load logs.'}
        </p>
      )}
      {!data && !error && <p role="status">Loading…</p>}
      {data && summary && activity && (
        <>
          {/* Auth banner */}
          <div
            className={`${styles.authBanner} ${authMissing ? styles.authUnknown : authOk ? styles.authOk : styles.authBad}`}
          >
            <span className={styles.authDot} />
            <div>
              <strong>
                {authMissing
                  ? 'LinkedIn access unknown'
                  : authOk
                    ? 'LinkedIn access ready'
                    : 'LinkedIn needs reconnection'}
              </strong>
              {!authOk && (
                <p className={styles.authSub}>
                  <Link to="/ops">Manage LinkedIn connection</Link>
                </p>
              )}
              {li?.last_error && <p className={styles.authErr}>Last error: {li.last_error}</p>}
            </div>
          </div>

          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Activity (last {activity.hours}h)</h2>
            <div className={styles.activityRow}>
              <span>
                Enriched: <strong>{activity.done_or_verified}</strong>
              </span>
              <span>
                Failed: <strong>{activity.failed_scraped_window}</strong>
              </span>
              <span>
                Scraped: <strong>{activity.rows_scraped_window}</strong>
              </span>
            </div>
          </div>

          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Event stream</h2>
            <div className={styles.filterBar}>
              <div className={styles.controls}>
                <div className={styles.tabs} role="group" aria-label="Service">
                  {SERVICE_TABS.map((t) => (
                    <button
                      key={t.key}
                      aria-pressed={tab === t.key}
                      className={`${styles.tab} ${tab === t.key ? styles.tabActive : ''}`}
                      onClick={() => setTab(t.key)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <input
                  className={styles.search}
                  aria-label="Search logs"
                  placeholder="Search events"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <div className={styles.controls}>
                <div className={styles.tabs} role="group" aria-label="Log level">
                  {LEVELS.map((level) => (
                    <button
                      key={level}
                      aria-pressed={levels.includes(level)}
                      className={`${styles.tab} ${levels.includes(level) ? styles.tabActive : ''}`}
                      onClick={() => toggleLevel(level)}
                    >
                      {level}
                    </button>
                  ))}
                </div>
                <div className={styles.tabs} role="group" aria-label="Time window">
                  {TIME_WINDOWS.map((w) => (
                    <button
                      key={w.key}
                      aria-pressed={since === w.key}
                      className={`${styles.tab} ${since === w.key ? styles.tabActive : ''}`}
                      onClick={() => {
                        setSince(w.key)
                        setLimit(100)
                      }}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                  />
                  Auto-refresh
                </label>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Level</th>
                    <th>Service</th>
                    <th>Message</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLogs.map((row, i) => (
                    <tr key={`${row.service}-${row.level}-${row.at ?? 'na'}-${i}`}>
                      <td className={styles.ts} title={row.at ?? undefined}>
                        {timeAgo(row.at)}
                      </td>
                      <td>
                        <span className={`${styles.levelBadge} ${styles[`level${row.level}`]}`}>
                          {row.level}
                        </span>
                      </td>
                      <td className={styles.serviceTag}>{row.service.toUpperCase()}</td>
                      <td>{row.message}</td>
                      <td>
                        <JsonExpander value={row.detail} />
                      </td>
                    </tr>
                  ))}
                  {visibleLogs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className={styles.muted}>
                        {levels.length
                          ? 'No events match these filters.'
                          : 'Choose a log level to see events.'}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {levels.length > 0 && data.logs.length >= limit && (
              <button className={styles.loadMore} onClick={() => setLimit((v) => v + 100)}>
                Load more
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
