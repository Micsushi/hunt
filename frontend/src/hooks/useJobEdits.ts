import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { editJobEnrichment, setApplicationStatus } from '@/api/jobs'
import type { ApplicationState, ApplicationStatus, JobEnrichmentFields } from '@/api/jobs'
import type { Job } from '@/types/job'

type JobChange = { jobId: number; title: string } & (
  | { kind: 'status'; before: ApplicationState; after: ApplicationState }
  | { kind: 'enrichment'; before: JobEnrichmentFields; after: JobEnrichmentFields }
)
type History = { undo: JobChange[]; redo: JobChange[] }
const key = ['job-edit-history']

export function applicationState(job: Job): ApplicationState {
  return {
    status:
      job.status === 'applied'
        ? 'applied'
        : job.status === 'canceled' || job.status === 'cancelled'
          ? 'canceled'
          : 'new',
    application_date: job.application_date ?? null,
  }
}

export function useJobEdits() {
  const client = useQueryClient()
  const { data } = useQuery<History>({
    queryKey: key,
    enabled: false,
    initialData: { undo: [], redo: [] },
    gcTime: Infinity,
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)

  async function save(change: JobChange, action: 'save' | 'undo' | 'redo') {
    if (saving.current) return false
    saving.current = true
    setPending(true)
    setError('')
    try {
      const target = action === 'undo' ? change.before : change.after
      const expected = action === 'undo' ? change.after : change.before
      let saved = change
      if (change.kind === 'status' && 'status' in target && 'status' in expected) {
        const result = await setApplicationStatus(
          change.jobId,
          target.status,
          expected,
          action === 'save' ? undefined : target.application_date,
        )
        if (action === 'save') saved = { ...change, after: result }
      } else if (
        change.kind === 'enrichment' &&
        'description' in target &&
        'description' in expected
      ) {
        await editJobEnrichment(change.jobId, target, expected)
      }
      client.setQueryData<History>(key, (state) => {
        const { undo, redo } = state ?? { undo: [], redo: [] }
        if (action === 'undo') return { undo: undo.slice(0, -1), redo: [...redo, change] }
        if (action === 'redo') return { undo: [...undo, change], redo: redo.slice(0, -1) }
        return { undo: [...undo.slice(-19), saved], redo: [] }
      })
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the job.')
      return false
    } finally {
      await Promise.all(
        [['jobs'], ['job', change.jobId], ['job-adjacent']].map((queryKey) =>
          client.invalidateQueries({ queryKey }),
        ),
      )
      saving.current = false
      setPending(false)
    }
  }

  function historyAction(action: 'undo' | 'redo') {
    const entries = client.getQueryData<History>(key)?.[action]
    const entry = entries?.[entries.length - 1]
    return entry ? save(entry, action) : Promise.resolve(false)
  }

  return {
    pending,
    error,
    undo: data?.undo[data.undo.length - 1],
    redo: data?.redo[data.redo.length - 1],
    historyAction,
    changeStatus: (job: Job, status: ApplicationStatus) =>
      save(
        {
          kind: 'status',
          jobId: job.id,
          title: job.title,
          before: applicationState(job),
          after: { status, application_date: null },
        },
        'save',
      ),
    changeEnrichment: (job: Job, before: JobEnrichmentFields, after: JobEnrichmentFields) =>
      save(
        {
          kind: 'enrichment',
          jobId: job.id,
          title: job.title,
          before,
          after,
        },
        'save',
      ),
  }
}
