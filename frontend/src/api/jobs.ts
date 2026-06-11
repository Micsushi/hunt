import { get, patch, post, del } from './client'
import { logHumanCommand } from './humanCommandLog'
import type { JobDetail, JobsQuery, JobsResponse, ResumeAttempt } from '@/types/job'
import type { ResumeReviewPackage } from '@/pages/Fletcher/review/types'

function buildParams(q: JobsQuery): string {
  const p = new URLSearchParams()
  if (q.source) p.set('source', q.source)
  if (q.status) p.set('status', q.status)
  if (q.limit !== undefined) p.set('limit', String(q.limit))
  if (q.page !== undefined) p.set('page', String(q.page))
  if (q.q) p.set('q', q.q)
  if (q.tag) p.set('tag', q.tag)
  if (q.category) p.set('category', q.category)
  if (q.ats_type) p.set('ats_type', q.ats_type)
  if (q.sort) p.set('sort', q.sort)
  if (q.direction) p.set('direction', q.direction)
  return p.toString()
}

export function fetchJobs(q: JobsQuery = {}): Promise<JobsResponse> {
  return get<JobsResponse>(`/api/jobs?${buildParams(q)}`)
}

export function fetchJobCount(
  q: Omit<JobsQuery, 'limit' | 'page' | 'sort' | 'direction'>,
): Promise<{ count: number }> {
  const p = new URLSearchParams()
  if (q.source) p.set('source', q.source)
  if (q.status) p.set('status', q.status)
  if (q.q) p.set('q', q.q)
  if (q.tag) p.set('tag', q.tag)
  if (q.category) p.set('category', q.category)
  if (q.ats_type) p.set('ats_type', q.ats_type)
  return get<{ count: number }>(`/api/jobs/count?${p.toString()}`)
}

export function fetchJob(id: number): Promise<JobDetail> {
  return get<JobDetail>(`/api/jobs/${id}`)
}

export function fetchResumeAttempts(jobId: number): Promise<ResumeAttempt[]> {
  return get<ResumeAttempt[]>(`/api/jobs/${jobId}/attempts`)
}

export function openJobResumeReview(jobId: number): Promise<ResumeReviewPackage> {
  return post<ResumeReviewPackage>(`/api/jobs/${jobId}/resume/review`, {})
}

export function openAttemptResumeReview(attemptId: number): Promise<ResumeReviewPackage> {
  return post<ResumeReviewPackage>(`/api/attempts/${attemptId}/review`, {})
}

export function requeueJob(id: number): Promise<{ status: string }> {
  void logHumanCommand({
    action: 'c0.job.requeue',
    buttonId: 'requeue-job',
    details: { jobId: id },
  })
  return post(`/api/jobs/${id}/requeue`)
}

export function setJobPriority(id: number, runNext: boolean): Promise<{ status: string }> {
  void logHumanCommand({
    action: runNext ? 'c0.job.set_priority' : 'c0.job.clear_priority',
    buttonId: runNext ? 'job-run-next' : 'job-clear-priority',
    details: { jobId: id, runNext },
  })
  return post(`/api/jobs/${id}/priority`, { run_next: runNext })
}

export function setJobOperatorMeta(
  id: number,
  data: { operator_notes?: string | null; operator_tag?: string | null },
): Promise<{ status: string }> {
  return post(`/api/jobs/${id}/operator-meta`, data)
}

export type PatchableJobFields = Partial<{
  company: string | null
  title: string | null
  location: string | null
  level: string | null
  category: string | null
  is_remote: number | null
  description: string | null
  description_source: string | null
  operator_notes: string | null
  operator_tag: string | null
}>

export function patchJob(id: number, fields: PatchableJobFields): Promise<{ status: string }> {
  void logHumanCommand({
    action: 'c0.job.patch',
    buttonId: 'edit-job-field',
    details: {
      jobId: id,
      fields: Object.keys(fields),
    },
  })
  return patch(`/api/jobs/${id}`, fields)
}

export function fetchAdjacentJobs(
  id: number,
  q: JobsQuery = {},
): Promise<{ prev_id: number | null; next_id: number | null }> {
  const params = buildParams(q)
  return get(`/api/jobs/${id}/adjacent${params ? `?${params}` : ''}`)
}

export function deleteJob(id: number): Promise<{ status: string }> {
  void logHumanCommand({
    action: 'c0.job.delete',
    buttonId: 'delete-job',
    details: { jobId: id },
  })
  return del(`/api/jobs/${id}`)
}

export function bulkSelection(payload: {
  action: 'requeue' | 'set_status' | 'delete'
  job_ids: number[]
  enrichment_status?: string
  confirm_delete?: boolean
}): Promise<{ status: string; updated: number }> {
  void logHumanCommand({
    action: `c0.jobs.bulk_${payload.action}`,
    buttonId: 'jobs-bulk-action',
    details: {
      action: payload.action,
      count: payload.job_ids.length,
      enrichmentStatus: payload.enrichment_status || '',
      confirmDelete: Boolean(payload.confirm_delete),
    },
  })
  return post('/api/jobs/bulk-selection', payload)
}
