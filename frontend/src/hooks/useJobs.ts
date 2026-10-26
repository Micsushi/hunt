import { useQuery } from '@tanstack/react-query'
import { fetchJobs } from '@/api/jobs'
import type { JobsQuery } from '@/types/job'

export function useJobs(query: JobsQuery) {
  return useQuery({
    queryKey: ['jobs', query],
    queryFn: () => fetchJobs(query),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  })
}
