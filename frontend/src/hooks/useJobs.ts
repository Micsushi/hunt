import { useQuery } from '@tanstack/react-query'
import { fetchJobs } from '@/api/jobs'
import type { JobsQuery, JobsResponse } from '@/types/job'

const EMPTY: JobsResponse = { items: [], total: 0 }

export function useJobs(query: JobsQuery) {
  return useQuery({
    queryKey: ['jobs', query],
    queryFn: () => fetchJobs(query),
    staleTime: 15_000,
    placeholderData: (prev) => prev ?? EMPTY,
  })
}
