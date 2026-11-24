import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useSummary } from '@/hooks/useSummary'
import {
  fetchBreakdown,
  fetchTimeline,
  fetchDailyDigest,
  fetchVelocity,
  fetchQueueAge,
} from '@/api/summary'
import { fetchSystemStatus } from '@/api/control'
import { Card } from '@/components/Card'
import { detailQualityLabels } from '@/utils/discovery'
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts'
import styles from './Home.module.css'

const BREAKDOWN_FIELDS = [
  { key: 'enrichment_status', label: 'Status' },
  { key: 'category', label: 'Category' },
  { key: 'ats_type', label: 'ATS type' },
  { key: 'source', label: 'Source' },
]

const TIMELINE_WINDOWS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 60, label: '60d' },
  { days: 90, label: '90d' },
]

const PIE_COLORS = [
  '#60a5fa',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#a78bfa',
  '#fb923c',
  '#38bdf8',
  '#e879f9',
]

const SOURCE_NAMES: Record<string, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  jobright: 'JobRight',
  unknown: 'Unknown',
}

function sourceName(source: string) {
  return SOURCE_NAMES[source] ?? source.replace(/^employer_/, '').replace(/_/g, ' ')
}

function ServiceStrip() {
  const navigate = useNavigate()
  const { data, isError } = useQuery({
    queryKey: ['system-status'],
    queryFn: fetchSystemStatus,
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
  })

  const items = [
    { key: 'db', label: 'Database', status: data?.db?.status, path: '/logs' },
    { key: 'c1', label: 'Hunter', status: data?.components?.c1?.status, path: '/ops' },
    {
      key: 'c2',
      label: 'Fletcher',
      status: data?.components?.c2?.status,
      path: '/fletcher',
    },
  ]

  return (
    <div className={styles.serviceStrip}>
      {items.map((item) => {
        const state = isError || !item.status ? 'unknown' : item.status === 'ok' ? 'ok' : 'error'
        return (
          <button
            key={item.key}
            className={`${styles.servicePill} ${styles[`service_${state}`]}`}
            onClick={() => navigate(item.path)}
            title={`${item.label}: ${state}`}
          >
            <span className={`${styles.serviceDot} ${styles[`dot_${state}`]}`} />
            {item.label}
            {state === 'error' ? ' needs attention' : state === 'unknown' ? ' unknown' : ''}
          </button>
        )
      })}
    </div>
  )
}

function PanelFeedback({ name, query }: { name: string; query: UseQueryResult }) {
  const { data, isPending, isFetching, isError, refetch } = query
  const [retryFocused, setRetryFocused] = useState(false)
  if (!isError && !isPending && !retryFocused) return null

  const message = isError
    ? data === undefined
      ? `Could not load ${name}.`
      : `Could not refresh ${name}. Showing last loaded data.`
    : isPending
      ? `Loading ${name}…`
      : ''
  return (
    <div className={styles.panelFeedback}>
      <span role="status" className={isError && !isFetching ? styles.panelFailure : undefined}>
        {message}
      </span>
      {(isError || retryFocused) && (
        <button
          type="button"
          className={styles.panelRetry}
          aria-disabled={isFetching}
          onFocus={() => setRetryFocused(true)}
          onBlur={() => setRetryFocused(false)}
          onClick={() => {
            if (!isFetching) void refetch({ cancelRefetch: false })
          }}
        >
          {isFetching ? 'Refreshing…' : isError ? `Retry ${name}` : `Refresh ${name}`}
        </button>
      )}
    </div>
  )
}

function SearchCoverage({ event }: { event?: { value: string } | null }) {
  let message = 'Search coverage unknown.'
  try {
    const recorded = JSON.parse(event?.value ?? 'null')
    const {
      search_tasks: total,
      failed_tasks: failed,
      partial_tasks: partial = 0,
      interrupted,
      scraped_total: leads,
    } = recorded?.details ?? {}
    if (interrupted) message = 'Search interrupted. Saved jobs are available.'
    else if (recorded?.code === 'scrape_failed')
      message = 'Search failed. Saved jobs are available.'
    else if (
      recorded?.code === 'scrape_finished' &&
      Number.isInteger(total) &&
      total > 0 &&
      Number.isInteger(failed) &&
      failed >= 0 &&
      failed <= total
    ) {
      message =
        failed === total
          ? `All ${total} search queries failed.`
          : failed > 0
            ? `Partial coverage. ${failed} of ${total} queries failed.`
            : partial > 0
              ? `Incomplete coverage for ${partial} of ${total} queries.`
              : leads === 0
                ? `No matching leads from ${total} queries.`
                : `All ${total} queries completed.`
    }
  } catch {
    /* Older or malformed records do not establish coverage. */
  }
  return (
    <div className={styles.panelFeedback}>
      <p role="status">{message}</p>
      <Link to="/ops">View source checks</Link>
    </div>
  )
}

function BreakdownChart() {
  const navigate = useNavigate()
  const [field, setField] = useState('enrichment_status')
  const query = useQuery({
    queryKey: ['breakdown', field],
    queryFn: () => fetchBreakdown(field),
    staleTime: 60_000,
  })

  const { data } = query
  const rows = (data?.data ?? []).filter(({ count }) => count > 0)
  const limit = field === 'source' ? 6 : 10
  const chartData = rows.slice(0, limit).map((row) => ({
    ...row,
    displayLabel:
      field === 'enrichment_status'
        ? (detailQualityLabels[row.label] ?? row.label)
        : field === 'source'
          ? sourceName(row.label)
          : row.label,
  }))
  if (rows.length > limit) {
    chartData.push({
      label: '',
      displayLabel: 'Other',
      count: rows.slice(limit).reduce((total, row) => total + row.count, 0),
    })
  }

  function handleSliceClick(entry: { label: string }) {
    if (!entry.label) return
    const filter = field === 'enrichment_status' ? 'status' : field
    navigate(`/jobs?${new URLSearchParams({ [filter]: entry.label })}`)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Jobs breakdown</h2>
        <div className={styles.segmented}>
          {BREAKDOWN_FIELDS.map((f) => (
            <button
              key={f.key}
              className={`${styles.seg} ${field === f.key ? styles.segActive : ''}`}
              onClick={() => setField(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <PanelFeedback name="jobs breakdown" query={query} />
      {data === undefined ? null : chartData.length === 0 ? (
        <p className={styles.empty}>No data</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={chartData}
              dataKey="count"
              nameKey="displayLabel"
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={90}
              paddingAngle={2}
              onClick={(data) => handleSliceClick(data as unknown as { label: string })}
            >
              {chartData.map((_, i) => (
                <Cell
                  key={i}
                  fill={PIE_COLORS[i % PIE_COLORS.length]}
                  cursor={chartData[i].label ? 'pointer' : undefined}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: 'var(--panel-strong)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                color: 'var(--ink)',
                fontSize: '0.85rem',
              }}
              itemStyle={{ color: 'var(--ink)' }}
            />
          </PieChart>
        </ResponsiveContainer>
      )}
      <div className={styles.legend}>
        {chartData.map((d, i) => (
          <span key={d.label} className={styles.legendItem}>
            <span
              className={styles.legendDot}
              style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
            />
            {d.displayLabel} ({d.count})
          </span>
        ))}
      </div>
    </div>
  )
}

function TimelineChart() {
  const [days, setDays] = useState(30)
  const query = useQuery({
    queryKey: ['timeline', days],
    queryFn: () => fetchTimeline(days),
    staleTime: 60_000,
  })

  const { data } = query
  const totals = new Map<string, number>()
  for (const { day, count } of data?.data ?? []) {
    if (count > 0) totals.set(day, (totals.get(day) ?? 0) + count)
  }
  const chartData = Array.from(totals, ([day, count]) => ({ day: day.slice(5), count }))

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Jobs added over time</h2>
        <div className={styles.segmented}>
          {TIMELINE_WINDOWS.map((w) => (
            <button
              key={w.days}
              className={`${styles.seg} ${days === w.days ? styles.segActive : ''}`}
              onClick={() => setDays(w.days)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <PanelFeedback name="timeline" query={query} />
      {data === undefined ? null : chartData.length === 0 ? (
        <p className={styles.empty}>No data for this window</p>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
            <XAxis
              dataKey="day"
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--panel-strong)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                color: 'var(--ink)',
                fontSize: '0.85rem',
              }}
              cursor={{ fill: 'var(--panel-hover)' }}
            />
            <Bar dataKey="count" name="Jobs" fill="var(--accent)" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

function fmt(hours: number | null): string {
  if (hours === null) return '-'
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function DailyDigestPanel() {
  const query = useQuery({
    queryKey: ['daily-digest'],
    queryFn: fetchDailyDigest,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  const { data } = query
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Daily digest{data?.date ? ` · ${data.date} UTC` : ''}</h2>
      </div>
      <PanelFeedback name="daily digest" query={query} />
      {data && (
        <div className={styles.statGrid}>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{data?.scraped_today ?? '-'}</span>
            <span className={styles.statLbl}>Scraped</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal} style={{ color: 'var(--good)' }}>
              {data?.enriched_today ?? '-'}
            </span>
            <span className={styles.statLbl}>Enriched</span>
          </div>
          <div className={styles.statBox}>
            <span
              className={styles.statVal}
              style={{ color: data?.failed_today ? 'var(--danger)' : undefined }}
            >
              {data?.failed_today ?? '-'}
            </span>
            <span className={styles.statLbl}>Failed</span>
          </div>
        </div>
      )}
    </div>
  )
}

function PipelineVelocityPanel() {
  const query = useQuery({
    queryKey: ['velocity'],
    queryFn: fetchVelocity,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  const { data } = query
  const delta = data?.delta ?? 0
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→'
  const arrowColor = delta > 0 ? 'var(--good)' : delta < 0 ? 'var(--danger)' : 'var(--muted)'
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Pipeline velocity</h2>
      </div>
      <PanelFeedback name="pipeline velocity" query={query} />
      {data && (
        <div className={styles.statGrid}>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{data?.jobs_per_hour ?? '-'}</span>
            <span className={styles.statLbl}>Jobs / hour</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal} style={{ color: arrowColor }}>
              {arrow} {Math.abs(delta)}
            </span>
            <span className={styles.statLbl}>Enriched vs previous 24h</span>
          </div>
        </div>
      )}
    </div>
  )
}

function QueueAgePanel() {
  const query = useQuery({
    queryKey: ['queue-age'],
    queryFn: fetchQueueAge,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  const { data } = query
  const over24Pct = data && data.count > 0 ? Math.round((data.over_24h / data.count) * 100) : 0
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Queue age</h2>
      </div>
      <PanelFeedback name="queue age" query={query} />
      {data && (
        <div className={styles.statGrid}>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{fmt(data?.oldest_hours ?? null)}</span>
            <span className={styles.statLbl}>Oldest</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{fmt(data?.p50_hours ?? null)}</span>
            <span className={styles.statLbl}>P50</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{fmt(data?.p90_hours ?? null)}</span>
            <span className={styles.statLbl}>P90</span>
          </div>
          <div className={styles.statBox}>
            <span
              className={styles.statVal}
              style={{ color: over24Pct > 20 ? 'var(--warning)' : undefined }}
            >
              {data?.over_24h ?? '-'}
              {data && data.count > 0 ? (
                <span style={{ fontSize: '0.75rem', marginLeft: 4, color: 'var(--muted)' }}>
                  {over24Pct}%
                </span>
              ) : null}
            </span>
            <span className={styles.statLbl}>Over 24h</span>
          </div>
        </div>
      )}
    </div>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const query = useSummary()
  const { data: summary } = query

  const counts = summary?.counts_by_status
  const done =
    summary?.detail_quality_counts?.enriched ?? (counts?.done ?? 0) + (counts?.done_verified ?? 0)
  const partial = summary?.detail_quality_counts?.partial ?? 0
  const failed = summary?.detail_quality_counts?.failed ?? counts?.failed ?? 0
  const authAvailable = summary?.auth?.linkedin?.available
  const authOk = authAvailable === true

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Overview</h1>
      </section>

      <PanelFeedback name="overview" query={query} />
      {summary && (
        <>
          <ServiceStrip />
          <SearchCoverage event={summary.events?.hunt_last_scrape_end} />

          <section className={styles.cards}>
            <Card
              label="Total jobs"
              value={summary.total}
              onClick={() => navigate('/jobs?status=all')}
            />
            <Card
              label="Awaiting enrichment"
              value={summary.pending_count}
              onClick={() => navigate('/jobs?status=pending')}
              accent={summary.pending_count > 0}
            />
            <Card
              label={detailQualityLabels.enriched}
              value={done}
              onClick={() => navigate('/jobs?status=enriched')}
            />
            <Card
              label={detailQualityLabels.partial}
              value={partial}
              onClick={() => navigate('/jobs?status=partial')}
              warning={partial > 0}
            />
            <Card
              label={detailQualityLabels.failed}
              value={failed}
              onClick={() => navigate('/jobs?status=failed')}
              danger={failed > 0}
            />
            <Card
              label="Blocked"
              value={summary.blocked_count}
              onClick={() => navigate('/jobs?status=blocked')}
              warning={summary.blocked_count > 0}
            />
            <Card
              label="LinkedIn access"
              value={authOk ? 'Ready' : authAvailable === false ? 'Login needed' : 'Unknown'}
              onClick={() => navigate('/logs')}
              danger={authAvailable === false}
            />
          </section>

          <div className={styles.chartsRow}>
            <BreakdownChart />
            <TimelineChart />
          </div>

          <div className={styles.chartsRow3}>
            <DailyDigestPanel />
            <PipelineVelocityPanel />
            <QueueAgePanel />
          </div>
        </>
      )}
    </div>
  )
}
