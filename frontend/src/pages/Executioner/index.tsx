import styles from './Executioner.module.css'
import { useQuery } from '@tanstack/react-query'
import { get } from '@/api/client'
import { browserC3, usesBrowserC3, type BrowserC3Status } from '@/api/browserC3'
import { Link } from 'react-router-dom'

function LocalApplications() {
  const connection = useQuery({
    queryKey: ['browser-c3-connection'],
    queryFn: () => browserC3<BrowserC3Status>('status'),
    retry: false,
    refetchOnWindowFocus: false,
  })
  return (
    <section className={styles.unavailable}>
      <h1>Applications</h1>
      <p role={connection.isError ? 'alert' : 'status'}>
        {connection.isFetching
          ? 'Checking local C3…'
          : connection.error instanceof Error
            ? connection.error.message
            : connection.data?.connected
              ? connection.data.configured
                ? 'Connected to local C3.'
                : 'Connected. Save your profile in the local workspace.'
              : 'Open Hunt C3 and connect to the local app.'}
      </p>
      <p>
        Review drafts using <strong>Open workspace</strong> in the extension.{' '}
        <Link to="/jobs">Choose jobs to send</Link>.
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
        Check connection
      </button>
    </section>
  )
}

export function ExecutionerPage() {
  return usesBrowserC3() ? <LocalApplications /> : <ServerApplications />
}

function ServerApplications() {
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  const connection = useQuery({
    queryKey: ['c3-connection'],
    queryFn: () => get('/api/c3/state'),
    retry: false,
    refetchOnWindowFocus: false,
  })
  if (connection.isPending && !connection.isFetched) return <p role="status">Connecting to C3…</p>
  if (connection.isError || !connection.data)
    return (
      <section className={styles.unavailable}>
        <h1>Applications</h1>
        <p role={connection.isFetching ? 'status' : 'alert'}>
          {connection.isFetching ? 'Connecting to C3…' : 'Application workspace unavailable.'}
        </p>
        <p>
          {isLocalHost ? (
            'Start the C3 app, then retry.'
          ) : (
            <>
              In the Hunt C3 extension, choose <strong>Open workspace</strong>.
            </>
          )}
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
