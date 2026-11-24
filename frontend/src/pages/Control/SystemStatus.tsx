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

  const services = data
    ? [
        ['Database', data.db.status],
        ['Hunter', data.components.c1.status],
        ['Fletcher', data.components.c2.status],
      ]
    : []
  const warning = error
    ? 'Check unavailable'
    : services.some(([, status]) => status !== 'ok')
      ? 'Needs attention'
      : null

  return (
    <details className={styles.panel}>
      <summary className={styles.sectionSummary}>
        Service status{warning && <span> ({warning})</span>}
      </summary>
      {isLoading ? <p role="status">Checking services…</p> : null}
      {error ? <p role="alert">Could not reach the services. Try again shortly.</p> : null}
      {data ? (
        <dl className={styles.serviceStatus}>
          {services.map(([name, status]) => (
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
