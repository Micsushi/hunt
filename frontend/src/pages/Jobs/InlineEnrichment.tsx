import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchJob } from '@/api/jobs'
import type { JobEnrichmentFields } from '@/api/jobs'
import type { JobDetail } from '@/types/job'
import { enrichmentIssue, jobEnrichmentLabel } from '@/utils/discovery'
import styles from './Jobs.module.css'

interface Props {
  jobId: number
  pending: boolean
  close: () => void
  save: (
    job: JobDetail,
    before: JobEnrichmentFields,
    after: JobEnrichmentFields,
  ) => Promise<boolean>
}

export function InlineEnrichment({ jobId, pending, close, save }: Props) {
  const query = useQuery({ queryKey: ['job', jobId], queryFn: () => fetchJob(jobId) })
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [jobId])
  return (
    <section className={styles.enrichmentEditor} aria-labelledby="inline-enrichment-title">
      <header>
        <h2 ref={heading} tabIndex={-1} id="inline-enrichment-title">
          {query.data?.title ?? 'Edit enrichment'}
        </h2>
        <button type="button" onClick={close} disabled={pending}>
          Close
        </button>
      </header>
      {query.isPending ? (
        <p role="status">Loading enrichment…</p>
      ) : query.isError ? (
        <p role="alert">
          Could not load enrichment.{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : (
        <EnrichmentForm key={jobId} job={query.data} save={save} pending={pending} close={close} />
      )}
    </section>
  )
}

function EnrichmentForm({
  job,
  save,
  pending,
  close,
}: Pick<Props, 'save' | 'pending' | 'close'> & { job: JobDetail }) {
  const [before] = useState<JobEnrichmentFields>(() => ({
    description: job.description,
    description_source: job.description_source,
    apply_url: job.apply_url,
  }))
  const [description, setDescription] = useState(before.description ?? '')
  const [link, setLink] = useState(before.apply_url ?? '')
  const descriptionChanged = description !== (before.description ?? '')
  const url = link.trim() || null
  const changed = descriptionChanged || url !== before.apply_url
  const checking = job.enrichment_status === 'processing'
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        if (!changed || pending || checking) return
        const after = {
          description: descriptionChanged ? description.trim() || null : before.description,
          description_source: descriptionChanged
            ? description.trim()
              ? 'manual'
              : null
            : before.description_source,
          apply_url: url,
        }
        if (await save(job, before, after)) close()
      }}
    >
      <p>{[jobEnrichmentLabel(job), enrichmentIssue(job)].filter(Boolean).join(' · ')}</p>
      <label>
        Job description
        <textarea
          rows={4}
          value={description}
          disabled={pending || checking}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        Employer application URL
        <input
          type="url"
          value={link}
          disabled={pending || checking}
          onChange={(event) => setLink(event.target.value)}
        />
      </label>
      {url !== before.apply_url && <p>A changed link needs verification.</p>}
      <button type="submit" disabled={!changed || pending || checking}>
        {pending ? 'Saving…' : 'Save enrichment'}
      </button>
    </form>
  )
}
