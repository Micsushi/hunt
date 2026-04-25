import { useQuery } from '@tanstack/react-query'
import { fetchPendingFills } from '@/api/control'
import styles from '@/pages/Control/Control.module.css'

// eslint-disable-next-line react-refresh/only-export-components
export const executionerPlugin = {
  path: '/executioner',
  navLabel: 'Executioner',
  tooltip: 'C3: Chrome extension status',
}

export function ExecutionerPage() {
  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ['pending-fills'],
    queryFn: fetchPendingFills,
    refetchInterval: 15_000,
  })
  const fills = data?.fills ?? []

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <h1 className={styles.heroTitle}>Executioner</h1>
          <div className={styles.heroMeta}>
            {dataUpdatedAt ? `updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : 'C3 bridge'}
          </div>
        </div>
      </section>

      <div className={`${styles.panel} ${styles.panelStrong}`}>
        <div className={styles.statusTop}>
          <h2 className={styles.panelTitle}>Pending fills</h2>
          <span className={`${styles.badge} ${fills.length ? styles.badgeWarn : styles.badgeOk}`}>{fills.length}</span>
        </div>
        {isLoading ? <p className={styles.meta}>Loading...</p> : null}
        {error ? <p className={styles.meta}>Bridge unavailable</p> : null}
        {fills.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Run</th><th>Job</th><th>ATS</th></tr></thead>
              <tbody>
                {fills.map(fill => (
                  <tr key={fill.run_id}>
                    <td className={styles.mono}>{fill.run_id}</td>
                    <td>{fill.job_id ?? '—'}</td>
                    <td>{fill.ats_type ?? 'unknown'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className={styles.meta}>No pending browser fills.</p>}
      </div>
    </div>
  )
}
