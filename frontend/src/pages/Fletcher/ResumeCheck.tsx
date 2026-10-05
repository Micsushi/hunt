import { useMutation } from '@tanstack/react-query'
import styles from './Fletcher.module.css'

interface CheckReport {
  score: number | null
  passed_checks: number
  total_checks: number
  limitations: string
  job_specific: boolean
  checks: { id: string; status: string; evidence: string; suggested_fix: string }[]
}

export function ResumeCheck({ resume, jobDetails }: { resume: File | null; jobDetails: string }) {
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
  return (
    <section aria-label="Resume checks">
      <button
        className={styles.btn}
        disabled={!resume || check.isPending}
        onClick={() => resume && check.mutate({ resume, jobDetails })}
      >
        {check.isPending ? 'Checking resume…' : 'Check resume'}
      </button>
      <p className={styles.workflowDesc}>
        Local checks only. Job details are optional. Checking does not edit your resume.
      </p>
      <div className={styles.checkResults} aria-live="polite" aria-busy={check.isPending}>
        {current && check.error && <p role="alert">{check.error.message}</p>}
        {report && (
          <>
            <h3>Local checks: {report.score}% passed</h3>
            <p>
              {report.passed_checks} of {report.total_checks} checks passed. {report.limitations}
            </p>
            {!report.job_specific && <p>Add job details to check keyword coverage.</p>}
            <ul>
              {report.checks
                .filter((item) => item.status !== 'pass')
                .map((item, index) => (
                  <li key={`${item.id}-${index}`}>
                    {item.evidence} {item.suggested_fix}
                  </li>
                ))}
            </ul>
            <details>
              <summary>All check results</summary>
              <ul>
                {report.checks.map((item, index) => (
                  <li key={`${item.id}-${index}`}>
                    {item.status}: {item.evidence}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>
    </section>
  )
}
