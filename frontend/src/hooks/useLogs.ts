import { useQuery } from '@tanstack/react-query'
import { fetchLogsQuery, type LogsQuery } from '@/api/summary'

export function useLogs(query: LogsQuery = {}, refetchInterval: false | number = false) {
  return useQuery({
    queryKey: ['logs', query],
    queryFn: () => fetchLogsQuery(query),
    refetchInterval,
    staleTime: 10_000,
  })
}
