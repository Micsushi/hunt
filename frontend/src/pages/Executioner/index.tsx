import { useQuery } from '@tanstack/react-query'
import { fetchPendingFills } from '@/api/control'
import { timeAgo } from '@/utils/time'
import styles from './Executioner.module.css'


export function ExecutionerPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['pending-fills'],
    queryFn: fetchPendingFills,
    refetchInterval: 15_000,
    retry: false,
  })
  const fills = data?.fills ?? []
  const bridgeOnline = !isError && !!data

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.heroTitle}>Executioner</h1>
          <div className={styles.heroMeta}>C3 — Chrome extension bridge</div>
        </div>
        <div className={`${styles.statusPill} ${bridgeOnline ? styles.statusPillOnline : styles.statusPillOffline}`}>
          <span className={styles.statusDot} />
          {isLoading ? 'Checking…' : bridgeOnline ? 'Bridge online' : 'Bridge offline'}
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Pending fills</h2>
          <span className={`${styles.badge} ${fills.length ? styles.badgeWarn : styles.badgeOk}`}>{fills.length}</span>
        </div>
        {isLoading ? <p className={styles.meta}>Loading…</p> : null}
        {isError ? <p className={styles.meta} style={{ color: 'var(--danger)' }}>Bridge unreachable — extension not connected</p> : null}
        {!isLoading && !isError && fills.length === 0 ? (
          <p className={styles.meta}>No pending browser fills. The extension will pick up tasks automatically when runs are triggered.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Run</th><th>Job</th><th>ATS</th><th>Queued</th></tr></thead>
              <tbody>
                {fills.map(fill => (
                  <tr key={fill.run_id}>
                    <td className={styles.mono}>{fill.run_id}</td>
                    <td>{fill.job_id ?? '—'}</td>
                    <td>{fill.ats_type ?? 'unknown'}</td>
                    <td className={styles.mono} style={{ color: 'var(--muted)' }}>
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
