import { useQuery } from '@tanstack/react-query'
import { fetchSummary } from '@/api/summary'

export function useSummary(refetchInterval = 30_000) {
  return useQuery({
    queryKey: ['summary'],
    queryFn: fetchSummary,
    refetchInterval,
    staleTime: 10_000,
  })
}
