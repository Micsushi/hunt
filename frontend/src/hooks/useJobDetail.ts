import { useQuery } from '@tanstack/react-query'
import { fetchJob, fetchResumeAttempts } from '@/api/jobs'

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
