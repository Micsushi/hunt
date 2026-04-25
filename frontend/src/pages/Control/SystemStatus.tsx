import { useQuery } from '@tanstack/react-query'
import { fetchSystemStatus, type ComponentStatus } from '@/api/control'
import styles from './Control.module.css'

function statusTone(status: string | undefined) {
  if (status === 'ok') return 'ok'
  if (status === 'unreachable') return 'bad'
  return status ? 'warn' : 'warn'
}

function StatusCard({ title, item }: { title: string; item?: ComponentStatus | { status: string; detail?: string } }) {
  const tone = statusTone(item?.status)
  const dotClass = tone === 'ok' ? styles.dotOk : tone === 'bad' ? styles.dotBad : styles.dotWarn
  const badgeClass = tone === 'ok' ? styles.badgeOk : tone === 'bad' ? styles.badgeBad : styles.badgeWarn
  const status = item?.status ?? 'unknown'
  const pending = 'pending_fills' in (item ?? {}) ? (item as ComponentStatus).pending_fills : null

  return (
    <div className={`${styles.panel} ${styles.statusCard}`}>
      <div className={styles.statusTop}>
        <span className={styles.componentName}>{title}</span>
        <span className={`${styles.badge} ${badgeClass}`}>{status}</span>
      </div>
      <div className={styles.statusLine}>
        <span className={`${styles.dot} ${dotClass}`} aria-hidden="true" />
        <span>{pending !== null && pending !== undefined ? `${pending} pending fill${pending === 1 ? '' : 's'}` : 'reachable check'}</span>
      </div>
      {'url' in (item ?? {}) && (item as ComponentStatus).url ? (
        <div className={`${styles.meta} ${styles.mono}`}>{(item as ComponentStatus).url}</div>
      ) : null}
    </div>
  )
}

export function SystemStatusPanel() {
  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ['system-status'],
    queryFn: fetchSystemStatus,
    refetchInterval: 30_000,
    staleTime: 10_000,
  })

  return (
    <section className={styles.page}>
      <div className={styles.hero}>
        <div>
          <h1 className={styles.heroTitle}>System status</h1>
          <div className={styles.heroMeta}>
            {dataUpdatedAt ? `updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : 'waiting for status'}
          </div>
        </div>
      </div>
      {isLoading ? <div className={styles.panel}>Loading status...</div> : null}
      {error ? <div className={`${styles.panel} ${styles.panelStrong}`}>Status check failed.</div> : null}
      {data ? (
        <div className={styles.grid}>
          <StatusCard title="DB" item={data.db} />
          <StatusCard title="C1 Hunter" item={data.components.c1} />
          <StatusCard title="C2 Fletcher" item={data.components.c2} />
          <StatusCard title="C3 Executioner" item={data.components.c3} />
          <StatusCard title="C4 Coordinator" item={data.components.c4} />
        </div>
      ) : null}
    </section>
  )
}
