import styles from './Executioner.module.css'
import { useQuery } from '@tanstack/react-query'
import { get } from '@/api/client'

export function ExecutionerPage() {
  const connection = useQuery({ queryKey: ['c3-connection'], queryFn: () => get('/api/c3/state'), retry: false, refetchOnWindowFocus: false })
  if (connection.isPending) return <p role="status">Connecting to C3…</p>
  if (connection.isError && !connection.data) return <section className={styles.unavailable}>
    <h1>Applications</h1>
    <p role="alert">C3 is unavailable. Start its local service and connect the browser extension.</p>
    <button type="button" disabled={connection.isFetching} onClick={() => connection.refetch()}>Retry connection</button>
  </section>
  return <iframe className={styles.workspace} title="C3 applications" src="/api/c3/" />
}
