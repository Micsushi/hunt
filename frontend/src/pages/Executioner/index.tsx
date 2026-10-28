import styles from './Executioner.module.css'
import { useQuery } from '@tanstack/react-query'
import { get } from '@/api/client'

export function ExecutionerPage() {
  const connection = useQuery({
    queryKey: ['c3-connection'],
    queryFn: () => get('/api/c3/state'),
    retry: false,
    refetchOnWindowFocus: false,
  })
  if (connection.isPending && !connection.isFetched)
    return <p role="status">Connecting to C3…</p>
  if (connection.isError || !connection.data)
    return (
      <section className={styles.unavailable}>
        <h1>Applications</h1>
        <p role={connection.isFetching ? 'status' : 'alert'}>
          {connection.isFetching
            ? 'Connecting to Hunt’s local C3 service…'
            : 'Hunt cannot reach its local C3 service.'}
        </p>
        <p>
          On your computer, open the <strong>Hunt C3</strong> extension, connect it to your local C3
          service, and choose <strong>Open workspace</strong>.
        </p>
        <p>
          This embedded workspace requires C3 to run alongside Hunt’s backend. Starting C3 on your
          computer does not connect it to a remote Hunt server. For a local Hunt setup, start C3
          alongside the backend, then retry.
        </p>
        <button
          className={styles.retryButton}
          type="button"
          aria-disabled={connection.isFetching}
          aria-busy={connection.isFetching}
          onClick={() => {
            if (!connection.isFetching) void connection.refetch({ cancelRefetch: false })
          }}
        >
          {connection.isFetching ? 'Connecting…' : 'Retry connection'}
        </button>
      </section>
    )
  return <iframe className={styles.workspace} title="C3 applications" src="/api/c3/" />
}
