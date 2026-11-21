import { useMutation } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import styles from './Fletcher.module.css'

interface CheckReport {
  score: number | null
  passed_checks: number
  total_checks: number
  limitations: string
  job_specific: boolean
  checks: { id: string; status: string; evidence: string; suggested_fix: string }[]
}

export function ResumeCheck({
  resume,
  jobDetails,
  children,
}: {
  resume: File | null
  jobDetails: string
  children?: ReactNode
}) {
  const check = useMutation({
    mutationFn: async (input: { resume: File; jobDetails: string }) => {
      const body = new FormData()
      body.append('resume', input.resume)
      body.append('job_details', input.jobDetails)
      const response = await fetch('/api/fletcher/check', {
        method: 'POST',
        credentials: 'include',
        body,
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(typeof result.detail === 'string' ? result.detail : 'Resume check failed.')
      }
      return result as CheckReport
    },
  })
  const current = check.variables?.resume === resume && check.variables?.jobDetails === jobDetails
  const report = current ? check.data : undefined
  const passedChecks = report?.checks.filter((item) => item.status === 'pass') ?? []
  return (
    <section aria-label="Resume checks">
      <div className={styles.checkActions}>
        <button
          className={styles.btn}
          disabled={!resume || check.isPending}
          onClick={() => resume && check.mutate({ resume, jobDetails })}
        >
          {check.isPending ? 'Checking resume…' : 'Check resume'}
        </button>
        {children}
      </div>
      <p className={styles.workflowDesc}>Resume checks run locally.</p>
      <div className={styles.checkResults} aria-live="polite" aria-busy={check.isPending}>
        {current && check.error && <p role="alert">{check.error.message}</p>}
        {report && (
          <>
            <h3>
              {report.passed_checks} of {report.total_checks} local checks passed
            </h3>
            <ul>
              {report.checks
                .filter((item) => item.status !== 'pass')
                .map((item, index) => (
                  <li key={`${item.id}-${index}`}>
                    {item.status === 'fail' ? 'Failed' : 'Warning'}: {item.evidence}{' '}
                    {item.suggested_fix}
                  </li>
                ))}
            </ul>
            {passedChecks.length > 0 && (
              <details>
                <summary>Passed checks</summary>
                <ul>
                  {passedChecks.map((item, index) => (
                    <li key={`${item.id}-${index}`}>{item.evidence}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  )
}
