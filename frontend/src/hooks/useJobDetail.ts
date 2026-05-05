import { useQuery } from '@tanstack/react-query'
import { fetchJob, fetchResumeAttempts, fetchAdjacentJobs } from '@/api/jobs'
import type { JobsQuery } from '@/types/job'

export function useJobDetail(id: number) {
  return useQuery({
    queryKey: ['job', id],
    queryFn: () => fetchJob(id),
    staleTime: 20_000,
  })
}

export function useResumeAttempts(jobId: number) {
  return useQuery({
    queryKey: ['resume-attempts', jobId],
    queryFn: () => fetchResumeAttempts(jobId),
    staleTime: 20_000,
  })
}

export function useAdjacentJobs(jobId: number, query: JobsQuery = {}) {
  return useQuery({
    queryKey: ['job-adjacent', jobId, query],
    queryFn: () => fetchAdjacentJobs(jobId, query),
    staleTime: 60_000,
  })
}
