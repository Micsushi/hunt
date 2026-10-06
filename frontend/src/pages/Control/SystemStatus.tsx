import { useQuery } from '@tanstack/react-query'
import { fetchSystemStatus } from '@/api/control'
import styles from '@/pages/Ops/Ops.module.css'

export function SystemStatusPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['system-status'],
    queryFn: fetchSystemStatus,
    refetchInterval: 30_000,
    staleTime: 10_000,
  })

  return (
    <details className={styles.panel}>
      <summary className={styles.sectionSummary}>Service status</summary>
      {isLoading ? <p role="status">Checking services…</p> : null}
      {error ? <p role="alert">Could not reach the services. Try again shortly.</p> : null}
      {data ? (
        <dl className={styles.serviceStatus}>
          {[
            ['Database', data.db.status],
            ['Hunter', data.components.c1.status],
            ['Fletcher', data.components.c2.status],
          ].map(([name, status]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{status === 'ok' ? 'Online' : status === 'unreachable' ? 'Offline' : status}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </details>
  )
}
