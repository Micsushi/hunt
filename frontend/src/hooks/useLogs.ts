import { useQuery } from '@tanstack/react-query'
import { fetchLogs } from '@/api/summary'

export function useLogs(refetchInterval = 30_000) {
  return useQuery({
    queryKey: ['logs'],
    queryFn: fetchLogs,
    refetchInterval,
    staleTime: 10_000,
  })
}
