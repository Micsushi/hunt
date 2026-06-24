import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { timeAgo } from '@/utils/time'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useJobs } from '@/hooks/useJobs'
import { useSummary } from '@/hooks/useSummary'
import { useUiStore } from '@/store/ui'
import { Filters } from '@/components/Filters'
import { Pagination } from '@/components/Pagination'
import { BulkBar } from '@/components/BulkBar'
import { StatusBadge } from '@/components/StatusBadge'
import styles from './Jobs.module.css'
import type { JobsQuery, SortField, SortDirection, Job } from '@/types/job'

const MOCK = import.meta.env.VITE_MOCK_BACKEND === 'true'
const REVIEW_QUERY_STORAGE_KEY = 'hunt.jobs.reviewQuery'
const JOBS_QUERY_STORAGE_KEY = 'hunt.jobs.query'

function queryFromParams(p: URLSearchParams): JobsQuery {
  return {
    source: p.get('source') || 'all',
    status: p.get('status') || 'all',
    q: p.get('q') || '',
    tag: p.get('tag') || '',
    category: p.get('category') || '',
    ats_type: p.get('ats_type') || '',
    sort: (p.get('sort') || 'date_scraped') as SortField,
    direction: (p.get('direction') || 'desc') as SortDirection,
    limit: parseInt(p.get('limit') || '50', 10),
    page: parseInt(p.get('page') || '1', 10),
  }
}

function queryToParams(q: JobsQuery): URLSearchParams {
  const p = new URLSearchParams()
  if (q.source) p.set('source', q.source)
  if (q.status) p.set('status', q.status)
  if (q.q) p.set('q', q.q)
  if (q.tag) p.set('tag', q.tag)
  if (q.category) p.set('category', q.category)
  if (q.ats_type) p.set('ats_type', q.ats_type)
  if (q.sort) p.set('sort', q.sort)
  if (q.direction) p.set('direction', q.direction)
  if (q.limit) p.set('limit', String(q.limit))
  if (q.page) p.set('page', String(q.page))
  return p
}

function storedJobsQueryParams(): URLSearchParams | null {
  try {
    const stored = localStorage.getItem(JOBS_QUERY_STORAGE_KEY)
    return stored ? new URLSearchParams(stored) : null
  } catch {
    return null
  }
}

function saveJobsQueryParams(params: URLSearchParams) {
  try {
    localStorage.setItem(JOBS_QUERY_STORAGE_KEY, params.toString())
  } catch {
    // Ignore storage failures; URL state still works.
  }
}

function initialJobsQuery(searchParams: URLSearchParams): JobsQuery {
  if (searchParams.toString()) return queryFromParams(searchParams)
  const stored = storedJobsQueryParams()
  return queryFromParams(stored ?? searchParams)
}

function mockDownloadHref(format: 'csv' | 'json'): string {
  const content =
    format === 'csv'
      ? 'id,company,title,status\n1,Acme Corp,Senior Software Engineer,done\n'
      : JSON.stringify(
          [{ id: 1, company: 'Acme Corp', title: 'Senior Software Engineer', status: 'done' }],
          null,
          2,
        )
  const type = format === 'csv' ? 'text/csv' : 'application/json'
  return `data:${type};charset=utf-8,${encodeURIComponent(content)}`
}

// Columns and their sort keys (Attempts removed)
const COL_TIPS: Record<string, string> = {
  ID: 'Database row ID',
  Company: 'Employer name',
  Title: 'Job title',
  Links: 'View listing or apply page',
  Enrichment: 'Current enrichment status',
  'Apply type': '"external_apply" = company ATS. "easy_apply" = LinkedIn - we skip those.',
  Added: 'When this job was scraped',
}

const COL_SORT_KEYS: Record<string, SortField | undefined> = {
  ID: 'id',
  Company: 'company',
  Title: 'title',
  Enrichment: 'enrichment_status',
  'Apply type': 'apply_type',
  Added: 'date_scraped',
}

type LocalSort = { field: string; dir: 'asc' | 'desc' }

function compareJobs(a: Job, b: Job, field: string, dir: 'asc' | 'desc'): number {
  let av: string | number | null = null
  let bv: string | number | null = null

  if (field === 'id') {
    av = a.id
    bv = b.id
  } else if (field === 'company') {
    av = a.company ?? ''
    bv = b.company ?? ''
  } else if (field === 'title') {
    av = a.title ?? ''
    bv = b.title ?? ''
  } else if (field === 'enrichment_status') {
    av = a.enrichment_status ?? ''
    bv = b.enrichment_status ?? ''
  } else if (field === 'apply_type') {
    av = a.apply_type ?? ''
    bv = b.apply_type ?? ''
  } else if (field === 'date_scraped') {
    av = a.date_scraped ?? ''
    bv = b.date_scraped ?? ''
  }

  let cmp: number
  if (typeof av === 'number' && typeof bv === 'number') {
    cmp = av - bv
  } else {
    cmp = String(av ?? '').localeCompare(String(bv ?? ''))
  }
  return dir === 'asc' ? cmp : -cmp
}

function Th({
  label,
  sortKey,
  localSort,
  onLocalSort,
}: {
  label: string
  sortKey?: SortField
  localSort: LocalSort | null
  onLocalSort: (s: LocalSort) => void
}) {
  const active = sortKey && localSort?.field === sortKey
  const nextDir = active && localSort?.dir === 'asc' ? 'desc' : 'asc'
  return (
    <th
      className={sortKey ? styles.sortable : ''}
      title={COL_TIPS[label] ?? label}
      onClick={sortKey ? () => onLocalSort({ field: sortKey, dir: nextDir }) : undefined}
    >
      {label}
      {active && <span aria-hidden="true">{localSort?.dir === 'asc' ? ' ↑' : ' ↓'}</span>}
    </th>
  )
}

export function JobsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState<JobsQuery>(() => initialJobsQuery(searchParams))
  const { data, isLoading, isFetching } = useJobs(query)
  const jobs = useMemo(() => data?.items ?? [], [data])
  const total = data?.total ?? 0
  const { data: summary } = useSummary(60_000)
  const { selectedIds, toggleSelect, selectAll, clearSelection } = useUiStore()
  const tbodyRef = useRef<HTMLTableSectionElement>(null)
  const [focusIdx, setFocusIdx] = useState(-1)
  const [localSort, setLocalSort] = useState<LocalSort | null>(null)
  const detailSearch = useMemo(() => {
    const value = queryToParams(query).toString()
    return value ? `?${value}` : ''
  }, [query])

  // Sync URL when query changes
  useEffect(() => {
    const nextParams = queryToParams(query)
    setSearchParams(nextParams, { replace: true })
    saveJobsQueryParams(nextParams)
    sessionStorage.setItem(REVIEW_QUERY_STORAGE_KEY, nextParams.toString())
    clearSelection()
    setFocusIdx(-1) // eslint-disable-line react-hooks/set-state-in-effect
    setLocalSort(null) // reset page-local sort when filters change
  }, [query]) // eslint-disable-line

  const updateQuery = useCallback((patch: Partial<JobsQuery>) => {
    setQuery((prev) => ({ ...prev, ...patch }))
  }, [])

  // Client-side sorted display jobs (only sorts current page)
  const displayJobs = useMemo(() => {
    if (!localSort) return jobs
    return [...jobs].sort((a, b) => compareJobs(a, b, localSort.field, localSort.dir))
  }, [jobs, localSort])

  // Keyboard j/k/Enter navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const rows = tbodyRef.current?.querySelectorAll('tr[data-job-id]') ?? []
      if (!rows.length) return
      if (e.key === 'j') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, rows.length - 1))
      }
      if (e.key === 'k') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
      }
      if (e.key === 'Enter' && focusIdx >= 0) {
        const row = rows[focusIdx] as HTMLElement
        const id = row.dataset.jobId
        if (id) navigate(`/jobs/${id}${detailSearch}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailSearch, focusIdx, navigate])

  useEffect(() => {
    const rows = tbodyRef.current?.querySelectorAll('tr[data-job-id]') ?? []
    rows.forEach((r, i) => r.classList.toggle(styles.focused, i === focusIdx))
    if (focusIdx >= 0)
      (rows[focusIdx] as HTMLElement)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusIdx, jobs])

  const allIds = jobs.map((j) => j.id)
  const allChecked = allIds.length > 0 && allIds.every((id) => selectedIds.has(id))
  const someChecked = allIds.some((id) => selectedIds.has(id))

  function renderJob(job: Job, idx: number) {
    const checked = selectedIds.has(job.id)
    return (
      <tr
        key={job.id}
        data-job-id={job.id}
        className={`${styles.jobRow} ${idx === focusIdx ? styles.focused : ''}`}
        onClick={() => navigate(`/jobs/${job.id}${detailSearch}`)}
      >
        <td onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleSelect(job.id)}
            aria-label={`Select job ${job.id}`}
          />
        </td>
        <td className={styles.idCell}>
          <a
            href={`/jobs/${job.id}${detailSearch}`}
            onClick={(e) => {
              e.preventDefault()
              navigate(`/jobs/${job.id}${detailSearch}`)
            }}
          >
            #{job.id}
          </a>
        </td>
        <td className={styles.companyCell} title={job.company ?? undefined}>
          {job.company ?? '-'}
        </td>
        <td className={styles.titleCell} title={job.title ?? undefined}>
          {job.title ?? '-'}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          {job.job_url && (
            <a
              href={job.job_url}
              target="_blank"
              rel="noreferrer"
              title="View original listing"
              className={styles.extLink}
            >
              Listing ↗
            </a>
          )}
          {job.job_url && job.apply_url && (
            <span style={{ color: 'var(--line)', margin: '0 4px' }}>|</span>
          )}
          {job.apply_url && (
            <a
              href={job.apply_url}
              target="_blank"
              rel="noreferrer"
              title="Apply page"
              className={styles.extLink}
            >
              Apply ↗
            </a>
          )}
        </td>
        <td>
          <StatusBadge status={job.enrichment_status} size="sm" />
        </td>
        <td className={styles.applyType}>{job.apply_type?.replace(/_/g, ' ') ?? '-'}</td>
        <td
          className="mono"
          style={{ fontSize: '0.8rem', color: 'var(--muted)' }}
          title={job.date_scraped ?? undefined}
        >
          {timeAgo(job.date_scraped)}
        </td>
      </tr>
    )
  }

  const statusCounts = useMemo(() => {
    if (!summary) return undefined
    return {
      ...summary.counts_by_status,
      enriched: summary.detail_quality_counts?.enriched ?? 0,
      partial: summary.detail_quality_counts?.partial ?? 0,
      failed: summary.detail_quality_counts?.failed ?? summary.counts_by_status.failed ?? 0,
    }
  }, [summary])

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Jobs</h1>
        <p className="muted">
          {isLoading ? 'Loading…' : `${jobs.length} of ${total} rows shown.`}
          {isFetching && !isLoading && (
            <span style={{ marginLeft: 8, color: 'var(--accent)' }}>Refreshing…</span>
          )}
          <span style={{ marginLeft: 8, color: 'var(--muted)', fontSize: '0.83rem' }}>
            Keyboard: <kbd className={styles.kbd}>j</kbd>/<kbd className={styles.kbd}>k</kbd> move ·{' '}
            <kbd className={styles.kbd}>Enter</kbd> open
          </span>
        </p>
      </section>

      <Filters
        query={query}
        onChange={updateQuery}
        statusCounts={statusCounts}
        isFetching={isFetching && !isLoading}
      />

      {/* Export row */}
      <div className={styles.exportRow}>
        <span className={styles.exportRowLabel}>Export current view</span>
        <a
          className={styles.exportBtn}
          href={
            MOCK
              ? mockDownloadHref('csv')
              : `/api/jobs/export?format=csv&${queryToParams(query).toString()}`
          }
          download={MOCK ? 'hunt-mock-jobs.csv' : undefined}
          title="Download current filtered results as CSV"
        >
          CSV ↓
        </a>
        <a
          className={styles.exportBtn}
          href={
            MOCK
              ? mockDownloadHref('json')
              : `/api/jobs/export?format=json&${queryToParams(query).toString()}`
          }
          download={MOCK ? 'hunt-mock-jobs.json' : undefined}
          title="Download current filtered results as JSON"
        >
          JSON ↓
        </a>
      </div>

      {/* Table */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th style={{ width: '2rem', textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked && !allChecked
                  }}
                  onChange={() => (allChecked ? clearSelection() : selectAll(allIds))}
                  aria-label="Select all rows on this page"
                  title="Select or deselect all rows on this page"
                />
              </th>
              {Object.keys(COL_TIPS).map((label) => (
                <Th
                  key={label}
                  label={label}
                  sortKey={COL_SORT_KEYS[label]}
                  localSort={localSort}
                  onLocalSort={setLocalSort}
                />
              ))}
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {isLoading ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
                  Loading…
                </td>
              </tr>
            ) : displayJobs.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>
                  No jobs match this filter.
                </td>
              </tr>
            ) : (
              displayJobs.map((j, i) => renderJob(j, i))
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={query.page ?? 1}
        total={total}
        limit={query.limit ?? 50}
        onChange={(page) => updateQuery({ page })}
      />

      <BulkBar />
    </div>
  )
}
