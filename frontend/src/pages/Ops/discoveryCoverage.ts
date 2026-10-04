import type { fetchC1DiscoveryHealth } from '@/api/control'

type Health = Awaited<ReturnType<typeof fetchC1DiscoveryHealth>>

export function coverageRows(data: Health | undefined) {
  const rows = new Map((data?.sources ?? []).map((row) => [row.source, row]))
  for (const company of data?.company_fetch_queue ?? []) {
    const source = `company:${company.company}`
    rows.set(source, {
      source,
      status: company.state,
      coverage: company.coverage,
      lead_count: company.lead_count,
      last_error: company.last_error,
      checked_at: rows.get(source)?.checked_at ?? '',
    })
  }
  return [...rows.values()].sort((a, b) => a.source.localeCompare(b.source))
}
