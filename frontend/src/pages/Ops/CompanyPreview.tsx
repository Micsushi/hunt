import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { previewCompany } from '@/api/control'
import styles from './Ops.module.css'
import { discoveryLabel } from '@/utils/discovery'

export function CompanyPreview() {
  const [company, setCompany] = useState('')
  const [url, setUrl] = useState('')
  const preview = useMutation({ mutationFn: () => previewCompany(company.trim(), url.trim()) })
  const result = preview.data
  return (
    <details className={styles.coverage}>
      <summary>Preview an employer</summary>
      <p>Check a careers page and sample matching jobs before adding it to scheduled searches.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          preview.mutate()
        }}
      >
        <div className={styles.formGrid}>
          <label className={styles.field}>
            Company
            <input
              required
              disabled={preview.isPending}
              className={styles.input}
              value={company}
              onChange={(event) => {
                setCompany(event.target.value)
                preview.reset()
              }}
            />
          </label>
          <label className={styles.field}>
            Careers URL
            <input
              required
              disabled={preview.isPending}
              type="url"
              className={styles.input}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                preview.reset()
              }}
              placeholder="https://example.com/careers"
            />
          </label>
        </div>
        <button className={styles.btn} disabled={preview.isPending} type="submit">
          {preview.isPending ? 'Checking careers page…' : 'Preview jobs'}
        </button>
      </form>
      {preview.isError && <p role="alert">{preview.error.message}</p>}
      {result && (
        <div role="status">
          <p>
            {result.status === 'ok'
              ? 'Catalog checked.'
              : result.status === 'needs_setup'
                ? 'Choose which published boards to add.'
                : result.status === 'needs_scan'
                  ? 'This platform needs a full scheduled scan.'
                  : 'Coverage could not be fully verified.'}{' '}
            Nothing has been saved.
          </p>
          {result.plan && <p>Hiring platform: {result.plan.method}.</p>}
          {result.error && <p>Check result: {result.error.replace(/_/g, ' ')}.</p>}
          {!!result.plan?.boards?.length && (
            <ul>
              {result.plan.boards.map((board) => (
                <li key={board.url}>
                  <a href={board.url} target="_blank" rel="noreferrer">
                    {board.method}: {board.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {!!result.sample.length && (
            <ul>
              {result.sample.map((job) => (
                <li key={job.job_url}>
                  <a href={job.job_url} target="_blank" rel="noreferrer">
                    {job.title}
                  </a>{' '}
                  · {job.location || 'Location not published'}
                  {job.discovery_suppressed_reason && <> · {discoveryLabel(job)}</>}
                </li>
              ))}
            </ul>
          )}
          {result.status === 'ok' && result.sample.length === 0 && (
            <p>No jobs matched the current search settings.</p>
          )}
        </div>
      )}
    </details>
  )
}
