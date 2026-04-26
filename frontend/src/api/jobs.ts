import { get, patch, post, del } from './client'
import type { Job, JobDetail, JobsQuery, ResumeAttempt } from '@/types/job'

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

export function fetchJobs(q: JobsQuery = {}): Promise<Job[]> {
  return get<Job[]>(`/api/jobs?${buildParams(q)}`)
}

export function fetchJobCount(q: Omit<JobsQuery, 'limit' | 'page' | 'sort' | 'direction'>): Promise<{ count: number }> {
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

export function requeueJob(id: number): Promise<{ status: string }> {
  return post(`/api/jobs/${id}/requeue`)
}

export function setJobPriority(id: number, runNext: boolean): Promise<{ status: string }> {
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
  operator_notes: string | null
  operator_tag: string | null
}>

export function patchJob(id: number, fields: PatchableJobFields): Promise<{ status: string }> {
  return patch(`/api/jobs/${id}`, fields)
}

export function fetchAdjacentJobs(id: number): Promise<{ prev_id: number | null; next_id: number | null }> {
  return get(`/api/jobs/${id}/adjacent`)
}

export function deleteJob(id: number): Promise<{ status: string }> {
  return del(`/api/jobs/${id}`)
}


export function bulkSelection(payload: {
  action: 'requeue' | 'set_status' | 'delete'
  job_ids: number[]
  enrichment_status?: string
  confirm_delete?: boolean
}): Promise<{ status: string; updated: number }> {
  return post('/api/jobs/bulk-selection', payload)
}
