import { useQuery } from '@tanstack/react-query'
import { fetchPendingFills } from '@/api/control'
import { timeAgo } from '@/utils/time'
import styles from './Executioner.module.css'

export function ExecutionerPage() {
  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ['pending-fills'],
    queryFn: fetchPendingFills,
    refetchInterval: 15_000,
  })
  const fills = data?.fills ?? []

  return (
    <div className={styles.page}>
      <section>
        <h1 className={styles.heroTitle}>Executioner</h1>
        <div className={styles.heroMeta}>
          C3 — Chrome extension bridge
          {dataUpdatedAt ? ` · updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}
        </div>
      </section>

      <div className={styles.healthPanel}>
        Extension heartbeat: <strong>not wired</strong> — status will show once the extension posts back.
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Pending fills</h2>
          <span className={`${styles.badge} ${fills.length ? styles.badgeWarn : styles.badgeOk}`}>{fills.length}</span>
        </div>
        {isLoading ? <p className={styles.meta}>Loading…</p> : null}
        {error ? <p className={styles.meta} style={{ color: 'var(--danger)' }}>Bridge unreachable</p> : null}
        {!isLoading && !error && fills.length === 0 ? (
          <p className={styles.meta}>No pending browser fills.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Job</th>
                  <th>ATS</th>
                  <th>Queued</th>
                </tr>
              </thead>
              <tbody>
                {fills.map(fill => (
                  <tr key={fill.run_id}>
                    <td className={styles.mono}>{fill.run_id}</td>
                    <td>{fill.job_id ?? '—'}</td>
                    <td>{fill.ats_type ?? 'unknown'}</td>
                    <td className={styles.mono} style={{ color: 'var(--muted)' }}
                        title={(fill as Record<string, unknown>).created_at as string | undefined}>
                      {timeAgo((fill as Record<string, unknown>).created_at as string | null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
