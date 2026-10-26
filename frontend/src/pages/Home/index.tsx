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
  Legend,
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

const SOURCE_COLORS: Record<string, string> = {
  linkedin: '#60a5fa',
  indeed: '#34d399',
  unknown: '#6b7280',
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
    { key: 'db', label: 'DB', ok: data?.db?.status === 'ok', path: '/logs' },
    { key: 'c1', label: 'C1 Hunter', ok: data?.components?.c1?.status === 'ok', path: '/ops' },
    {
      key: 'c2',
      label: 'C2 Fletcher',
      ok: data?.components?.c2?.status === 'ok',
      path: '/fletcher',
    },
    {
      key: 'c3',
      label: 'Applications',
      ok: false,
      path: '/executioner',
    },
  ]

  return (
    <div className={styles.serviceStrip}>
      {items.map((item) => {
        const state = item.key === 'c3' || isError || !data ? 'unknown' : item.ok ? 'ok' : 'error'
        return (
          <button
            key={item.key}
            className={`${styles.servicePill} ${styles[`service_${state}`]}`}
            onClick={() => navigate(item.path)}
            title={
              item.key === 'c3'
                ? 'Open the application queue; its current connection is checked there.'
                : `${item.label}: ${state}`
            }
          >
            <span className={`${styles.serviceDot} ${styles[`dot_${state}`]}`} />
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

function PanelFeedback({ name, query }: { name: string; query: UseQueryResult }) {
  const { data, isPending, isFetching, isError, refetch } = query
  const message = isFetching
    ? data === undefined
      ? `Loading ${name}...`
      : `Refreshing ${name}... Showing last loaded data.`
    : isError
      ? data === undefined
        ? `Could not load ${name}.`
        : `Could not refresh ${name}. Showing last loaded data.`
      : isPending
        ? `Waiting to load ${name}.`
        : ''
  return (
    <div className={styles.panelFeedback}>
      <span role="status" className={isError && !isFetching ? styles.panelFailure : undefined}>
        {message}
      </span>
      <button
        type="button"
        className={styles.panelRetry}
        aria-disabled={isFetching}
        onClick={() => {
          if (!isFetching) void refetch({ cancelRefetch: false })
        }}
      >
        {isError ? `Retry ${name}` : `Refresh ${name}`}
      </button>
    </div>
  )
}

function SearchCoverage({ event }: { event?: { value: string } | null }) {
  let message = 'Search coverage unknown. Saved-job counts do not confirm source availability.'
  try {
    const recorded = JSON.parse(event?.value ?? 'null')
    const {
      search_tasks: total,
      failed_tasks: failed,
      partial_tasks: partial = 0,
      interrupted,
      scraped_total: leads,
    } = recorded?.details ?? {}
    if (interrupted)
      message = 'The last C1 search stopped before completing. Saved jobs have been kept.'
    else if (recorded?.code === 'scrape_failed')
      message = 'The last recorded C1 search failed. Saved jobs have been kept.'
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
          ? `The last recorded C1 search was unavailable: all ${total} queries failed.`
          : failed > 0
            ? `The last recorded C1 search had partial coverage: ${failed} of ${total} queries failed.`
            : partial > 0
              ? `The last recorded C1 search has incomplete coverage for ${partial} of ${total} queries.`
              : leads === 0
                ? `The last recorded C1 search returned no matching leads from ${total} configured queries.`
                : `The last recorded C1 search completed ${total} configured queries without reported failures.`
    }
  } catch {
    /* Older or malformed records do not establish coverage. */
  }
  return (
    <div className={styles.panelFeedback}>
      <p role="status">{message} Other discovery sources are not verified here.</p>
      <Link to="/logs">Check search activity</Link>
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
  const chartData = (data?.data ?? []).slice(0, 10).map((row) => ({
    ...row,
    displayLabel:
      field === 'enrichment_status' ? (detailQualityLabels[row.label] ?? row.label) : row.label,
  }))

  function handleSliceClick(entry: { label: string }) {
    if (field === 'enrichment_status') navigate(`/jobs?status=${entry.label}`)
    else if (field === 'source') navigate(`/jobs?source=${entry.label}`)
    else if (field === 'category') navigate(`/jobs?category=${encodeURIComponent(entry.label)}`)
    else if (field === 'ats_type') navigate(`/jobs?ats_type=${encodeURIComponent(entry.label)}`)
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
              style={{ cursor: 'pointer' }}
            >
              {chartData.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
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
  const raw = data?.data ?? []
  const dayMap: Record<string, Record<string, number>> = {}
  for (const r of raw) {
    if (!dayMap[r.day]) dayMap[r.day] = {}
    dayMap[r.day][r.source] = (dayMap[r.day][r.source] ?? 0) + r.count
  }
  const sources = [...new Set(raw.map((r) => r.source))]
  const chartData = Object.entries(dayMap).map(([day, counts]) => ({
    day: day.slice(5),
    ...counts,
  }))

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
            <Legend wrapperStyle={{ fontSize: '0.82rem', color: 'var(--muted)', paddingTop: 6 }} />
            {sources.map((s) => (
              <Bar
                key={s}
                dataKey={s}
                stackId="a"
                fill={SOURCE_COLORS[s] ?? '#7a9e80'}
                radius={sources.indexOf(s) === sources.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
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
        <h2 className={styles.panelTitle}>Daily digest</h2>
        <span className={styles.meta}>{data?.date ?? 'today'}</span>
      </div>
      <PanelFeedback name="daily digest" query={query} />
      {data && (
        <div className={styles.statGrid}>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{data?.scraped_today ?? '-'}</span>
            <span className={styles.statLbl}>Scraped today</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal} style={{ color: 'var(--good)' }}>
              {data?.enriched_today ?? '-'}
            </span>
            <span className={styles.statLbl}>Enriched today</span>
          </div>
          <div className={styles.statBox}>
            <span
              className={styles.statVal}
              style={{ color: data?.failed_today ? 'var(--danger)' : undefined }}
            >
              {data?.failed_today ?? '-'}
            </span>
            <span className={styles.statLbl}>Failed today</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{data?.scraped_24h ?? '-'}</span>
            <span className={styles.statLbl}>Scraped 24h</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal} style={{ color: 'var(--good)' }}>
              {data?.enriched_24h ?? '-'}
            </span>
            <span className={styles.statLbl}>Enriched 24h</span>
          </div>
          <div className={styles.statBox}>
            <span
              className={styles.statVal}
              style={{ color: data?.failed_24h ? 'var(--danger)' : undefined }}
            >
              {data?.failed_24h ?? '-'}
            </span>
            <span className={styles.statLbl}>Failed 24h</span>
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
        <span className={styles.meta}>vs previous 24h</span>
      </div>
      <PanelFeedback name="pipeline velocity" query={query} />
      {data && (
        <div className={styles.statGrid}>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{data?.jobs_per_hour ?? '-'}</span>
            <span className={styles.statLbl}>Jobs / hour</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal} style={{ color: 'var(--good)' }}>
              {data?.enriched_24h ?? '-'}
            </span>
            <span className={styles.statLbl}>Enriched 24h</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal}>{data?.scraped_24h ?? '-'}</span>
            <span className={styles.statLbl}>Scraped 24h</span>
          </div>
          <div className={styles.statBox}>
            <span className={styles.statVal} style={{ color: arrowColor }}>
              {arrow} {Math.abs(delta)}
            </span>
            <span className={styles.statLbl}>vs prev 24h</span>
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
        <span className={styles.meta}>{data?.count ?? '-'} pending</span>
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

  if (!summary)
    return (
      <div className={styles.page}>
        <section className={styles.hero}>
          <h1 className={styles.heroTitle}>Overview</h1>
        </section>
        <PanelFeedback name="overview" query={query} />
      </div>
    )

  const detailCounts = summary.detail_quality_counts ?? {
    enriched:
      (summary.counts_by_status['done'] ?? 0) + (summary.counts_by_status['done_verified'] ?? 0),
    partial: 0,
    failed: summary.counts_by_status['failed'] ?? 0,
    description_only: 0,
    url_only: 0,
  }
  const done = detailCounts.enriched
  const partial = detailCounts.partial
  const failed = detailCounts.failed
  const authAvailable = summary.auth?.linkedin?.available
  const authOk = authAvailable === true

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Overview</h1>
      </section>

      <PanelFeedback name="overview" query={query} />
      <ServiceStrip />
      <SearchCoverage event={summary.events?.hunt_last_scrape_end} />

      <section className={styles.cards}>
        <Card
          label="Total jobs"
          value={summary.total}
          onClick={() => navigate('/jobs?status=all')}
        />
        <Card
          label="Pending enrich"
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
          label="LinkedIn auth"
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
    </div>
  )
}
