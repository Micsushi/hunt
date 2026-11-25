import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { timeAgo } from '@/utils/time'
import {
  detailsFilter,
  enrichmentIssue,
  fitFilters,
  jobEnrichmentLabel,
  jobFitTags,
  jobReviewStatus,
  matchHoldReason,
  shortEnrichmentLabel,
  verifiedApplyLink,
} from '@/utils/discovery'
import { fetchFitReview, jobsQueryParams as queryToParams, requestFitReview } from '@/api/jobs'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useJobs } from '@/hooks/useJobs'
import { applicationState, useJobEdits } from '@/hooks/useJobEdits'
import type { ApplicationStatus } from '@/api/jobs'
import { useSummary } from '@/hooks/useSummary'
import { useUiStore } from '@/store/ui'
import { Filters } from '@/components/Filters'
import { Pagination } from '@/components/Pagination'
import { BulkBar } from '@/components/BulkBar'
import { InlineEnrichment } from './InlineEnrichment'
import styles from './Jobs.module.css'
import type { FitReviewRun, JobsQuery, SortField, SortDirection, Job } from '@/types/job'

const MOCK = import.meta.env.VITE_MOCK_BACKEND === 'true'
const REVIEW_QUERY_STORAGE_KEY = 'hunt.jobs.reviewQuery'
const JOBS_QUERY_STORAGE_KEY = 'hunt.jobs.query'

const JOB_VIEWS = [
  ['matches', 'My matches'],
  ['all', 'All jobs'],
  ['history', 'Application history'],
] as const

function queryFromParams(p: URLSearchParams): JobsQuery {
  const view = p.get('view') === 'all' ? 'all' : p.get('view') === 'history' ? 'history' : 'matches'
  const matchStatus = p.get('match_status')
  const sort = (p.get('sort') || (view === 'matches' ? 'fit_tier' : 'date_scraped')) as SortField
  return {
    view,
    match_days: boundedParam(p.get('match_days'), view === 'matches' ? 14 : 0, 365),
    company_limit: boundedParam(p.get('company_limit'), 2, 20),
    match_status:
      matchStatus === 'ready' || matchStatus === 'needs_verification' ? matchStatus : 'all',
    details: detailsFilter(p.get('details')),
    ...fitFilters(p),
    source: p.get('source') || 'all',
    status: p.get('status') || 'all',
    q: p.get('q') || '',
    tag: p.get('tag') || '',
    category: p.get('category') || '',
    ats_type: p.get('ats_type') || '',
    sort,
    direction: (p.get('direction') || (sort === 'fit_tier' ? 'asc' : 'desc')) as SortDirection,
    limit: Math.max(1, parseInt(p.get('limit') || '50', 10) || 50),
    page: Math.max(1, parseInt(p.get('page') || '1', 10) || 1),
  }
}

function boundedParam(value: string | null, fallback: number, max: number) {
  if (value === null || !/^\d+$/.test(value)) return fallback
  return Math.min(Number(value), max)
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

// Display order matches the table cells.
const COL_TIPS: Record<string, string> = {
  Title: 'Job title',
  Company: 'Employer name',
  Posted: 'Employer posting date',
  Links: 'View listing or apply page',
  Status: 'Fit and application readiness',
  Enrichment: 'Description and direct application link',
  Added: 'When this job was scraped',
}

const COL_SORT_KEYS: Record<string, SortField | undefined> = {
  Posted: 'date_posted',
  Company: 'company',
  Title: 'title',
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
  } else if (field === 'date_posted') {
    av = a.date_posted || a.date_scraped
    bv = b.date_posted || b.date_scraped
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
      aria-sort={
        sortKey
          ? active
            ? localSort?.dir === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'
          : undefined
      }
    >
      {sortKey ? (
        <button
          type="button"
          className={styles.sortButton}
          onClick={() => onLocalSort({ field: sortKey, dir: nextDir })}
        >
          {label}
          {active && <span aria-hidden="true">{localSort?.dir === 'asc' ? ' ↑' : ' ↓'}</span>}
        </button>
      ) : (
        label
      )}
    </th>
  )
}

const FIT_REVIEW_QUERY = ['fit-review-run']

function reviewRunLabel(run: FitReviewRun | undefined): string | null {
  switch (run?.status) {
    case 'queued':
      return 'Review queued'
    case 'running':
      return `${run.trigger === 'backfill' ? 'Backlog review' : 'Agent review'} in progress${run.reviewed ? ` · ${run.reviewed} checked` : ''}`
    case 'completed':
      return `Reviewed ${run.reviewed ?? 0} jobs · ${run.new_visible_count ?? 0} new matches`
    case 'failed':
      return run.reason ? `Review failed · ${run.reason}` : 'Review failed'
    case 'unconfirmed':
      return 'Review result unconfirmed'
    default:
      return null
  }
}

function ReviewControl() {
  const client = useQueryClient()
  const run = useQuery({
    queryKey: FIT_REVIEW_QUERY,
    queryFn: fetchFitReview,
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.status ?? '') ? 2_000 : 15_000,
  })
  const request = useMutation({
    mutationFn: requestFitReview,
    onSuccess: (state) => client.setQueryData(FIT_REVIEW_QUERY, state),
  })
  const status = run.data?.status
  const runId = run.data?.id
  const reviewed = run.data?.reviewed ?? 0
  const statusRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (reviewed > 0 || status === 'completed') {
      void client.invalidateQueries({ queryKey: ['jobs'] })
      void client.invalidateQueries({ queryKey: ['job'] })
    }
  }, [client, reviewed, runId, status])
  const busy =
    request.isPending || run.isPending || run.isError || status === 'queued' || status === 'running'
  return (
    <div className={styles.reviewControls}>
      <button
        type="button"
        className={styles.reviewButton}
        disabled={busy}
        onClick={() => {
          if (busy) return
          statusRef.current?.focus()
          request.mutate()
        }}
      >
        Run agent review
      </button>
      <span ref={statusRef} tabIndex={-1} role="status" className={styles.reviewState}>
        {request.isPending
          ? 'Requesting review…'
          : run.isError
            ? 'Review status unavailable'
            : reviewRunLabel(run.data)}
      </span>
      {request.isError && <span role="alert">Could not queue the review. Try again.</span>}
    </div>
  )
}

export function JobsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState<JobsQuery>(() => initialJobsQuery(searchParams))
  const { data, isLoading, isFetching, isError, isPlaceholderData, refetch } = useJobs(query)
  const jobs = useMemo(() => data?.items ?? [], [data])
  const total = data?.total ?? 0
  const { data: summary } = useSummary(60_000)
  const { selectedIds, toggleSelect, selectAll, clearSelection, setSelectionQuery } = useUiStore()
  const selectionReady = !isLoading && !isError && !isPlaceholderData
  const headingRef = useRef<HTMLHeadingElement>(null)
  const countRef = useRef<HTMLSpanElement>(null)
  const editTrigger = useRef<HTMLButtonElement | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const edits = useJobEdits()
  function closeEditor() {
    setEditingId(null)
    requestAnimationFrame(() => {
      if (editTrigger.current?.isConnected) editTrigger.current.focus()
      else countRef.current?.focus()
    })
  }
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
    setSelectionQuery(nextParams.toString())
    setFocusIdx(-1) // eslint-disable-line react-hooks/set-state-in-effect
    setLocalSort(null) // reset page-local sort when filters change
  }, [query]) // eslint-disable-line

  useEffect(() => {
    if (!data || isFetching || isError || isPlaceholderData) return
    const selection = useUiStore.getState()
    if (selection.selectedJobsQuery !== queryToParams(query).toString()) return
    const visible = new Set(data.items.map((job) => job.id))
    const retained = [...selection.selectedIds].filter((id) => visible.has(id))
    if (retained.length !== selection.selectedIds.size) selection.selectAll(retained)
  }, [data, isFetching, isError, isPlaceholderData, query, selectedIds])

  const updateQuery = useCallback((patch: Partial<JobsQuery>) => {
    setQuery((prev) => ({ ...prev, ...patch }))
  }, [])

  if (data && !isFetching && !isError && !isPlaceholderData) {
    const lastPage = Math.max(1, Math.ceil(total / (query.limit ?? 50)))
    if ((query.page ?? 1) > lastPage) setQuery({ ...query, page: lastPage })
  }

  // Client-side sorted display jobs (only sorts current page)
  const displayJobs = useMemo(() => {
    if (!localSort) return jobs
    return [...jobs].sort((a, b) => compareJobs(a, b, localSort.field, localSort.dir))
  }, [jobs, localSort])

  // Keyboard j/k/Enter navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (
        e.defaultPrevented ||
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        target?.closest(
          'input, textarea, select, button, a, [role="dialog"], [contenteditable]:not([contenteditable="false"])',
        )
      )
        return
      if (e.key === 'Enter' && target?.closest('button, a, [role="button"]')) return
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
        const id = row?.dataset.jobId
        if (id) {
          e.preventDefault()
          navigate(`/jobs/${id}${detailSearch}`)
        }
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

  const isMatches = query.view === 'matches'
  const columns = isMatches
    ? ['Title', 'Company', 'Posted', 'Tier', 'Status', 'Enrichment', 'Links']
    : ['Title', 'Company', 'Posted', 'Tier', 'Status', 'Enrichment', 'Links', 'Added']

  function renderJob(job: Job, idx: number) {
    const checked = selectedIds.has(job.id)
    const jobState = jobReviewStatus(job)
    const hold = matchHoldReason(job.fit_review)
    const tags = jobFitTags(job, false)
    const issue = enrichmentIssue(job)
    const hasVerifiedLink = verifiedApplyLink(job)
    const state = applicationState(job).status
    const tier = job.fit_tier ?? job.fit_review?.tier
    const shortStatus = jobState.startsWith('Awaiting')
      ? 'Review'
      : jobState === 'Fit needs more information'
        ? 'Needs info'
        : jobState
    return (
      <tr
        key={job.id}
        data-job-id={job.id}
        className={`${styles.jobRow} ${idx === focusIdx ? styles.focused : ''}`}
        data-selected={checked || undefined}
        onClick={() => navigate(`/jobs/${job.id}${detailSearch}`)}
      >
        <td onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={checked}
            disabled={!selectionReady}
            onChange={() => toggleSelect(job.id)}
            aria-label={`Select job ${job.id}`}
          />
        </td>
        <td className={styles.titleCell} title={job.title ?? undefined}>
          <Link to={`/jobs/${job.id}${detailSearch}`} onClick={(event) => event.stopPropagation()}>
            {job.title || `Job #${job.id}`}
          </Link>
          {tags && <small>{tags}</small>}
        </td>
        <td className={styles.companyCell} title={job.company ?? undefined}>
          {job.company ?? '-'}
        </td>
        <td className={styles.postedCell}>
          {job.date_posted ? (
            <time dateTime={job.date_posted}>{job.date_posted.slice(0, 10)}</time>
          ) : (
            'Date unknown'
          )}
        </td>
        <td className={styles.tierCell}>
          {tier && (
            <span
              className={styles.tierTag}
              title={tier === 'outside_scope' ? 'Outside scope' : undefined}
            >
              {tier === 'outside_scope' ? 'Out' : tier.toUpperCase()}
            </span>
          )}
        </td>
        <td className={styles.statusCell} onClick={(event) => event.stopPropagation()}>
          <select
            className={styles.rowSelect}
            value={state}
            title={jobState}
            aria-label={`Status for ${job.title}`}
            data-confirmed={jobState === 'Confirmed' || undefined}
            disabled={edits.pending || !selectionReady}
            onChange={async (event) => {
              const control = event.currentTarget
              if (await edits.changeStatus(job, control.value as ApplicationStatus)) {
                if (!control.isConnected && document.activeElement === document.body)
                  countRef.current?.focus()
              }
            }}
          >
            <option value="new">{state === 'new' ? shortStatus : 'Not applied'}</option>
            <option value="applied">Applied</option>
            <option value="canceled">Canceled</option>
          </select>
          {hold && <small>{hold}</small>}
        </td>
        <td className={styles.enrichmentCell} onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={styles.enrichmentTag}
            title={[jobEnrichmentLabel(job), issue].filter(Boolean).join(' · ')}
            aria-label={`Edit enrichment for ${job.title}: ${jobEnrichmentLabel(job)}`}
            aria-expanded={editingId === job.id}
            disabled={editingId !== null || edits.pending || !selectionReady}
            onClick={(event) => {
              editTrigger.current = event.currentTarget
              setEditingId(job.id)
            }}
          >
            {shortEnrichmentLabel(job)}
          </button>
        </td>
        <td className={styles.linksCell} onClick={(e) => e.stopPropagation()}>
          {job.job_url && (!isMatches || !hasVerifiedLink) && (
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
          {job.apply_url &&
            (!isMatches ||
              hasVerifiedLink ||
              job.last_enrichment_error === 'manual_apply_url_unverified') && (
              <a
                href={job.apply_url}
                target="_blank"
                rel="noreferrer"
                title="Apply page"
                className={styles.extLink}
              >
                {hasVerifiedLink ? 'Apply ↗' : 'Link ↗'}
              </a>
            )}
        </td>
        {!isMatches && (
          <td className={styles.addedCell} title={job.date_scraped ?? undefined}>
            {timeAgo(job.date_scraped)}
          </td>
        )}
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
        <h1 ref={headingRef} tabIndex={-1} className={styles.heroTitle}>
          Jobs
        </h1>
        <ReviewControl />
      </section>

      {isError && (
        <div className={styles.notice} role="alert">
          <span>
            {data
              ? 'Could not refresh jobs. Showing the last loaded results. Retry before selecting jobs.'
              : 'Could not load jobs. Your filters are unchanged.'}
          </span>
          <button
            className={styles.exportBtn}
            disabled={isFetching}
            onClick={() => {
              headingRef.current?.focus()
              void refetch()
            }}
          >
            {isFetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      <div className={styles.views} role="group" aria-label="Jobs view">
        {JOB_VIEWS.map(([view, label]) => (
          <button
            key={view}
            type="button"
            aria-pressed={query.view === view}
            onClick={() => {
              if (view === query.view) return
              updateQuery({
                view,
                match_days: view === 'matches' ? 14 : 0,
                company_limit: 2,
                match_status: 'all',
                details: 'all',
                tier: undefined,
                role: undefined,
                seniority: undefined,
                status: 'all',
                sort: view === 'matches' ? 'fit_tier' : 'date_scraped',
                direction: view === 'matches' ? 'asc' : 'desc',
                page: 1,
              })
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <Filters
        query={query}
        onChange={updateQuery}
        statusCounts={statusCounts}
        sourceCounts={summary?.source_counts}
        isFetching={isFetching && !isLoading}
      />

      {/* Export row */}
      <div className={styles.exportRow}>
        <span role="status" className="muted" ref={countRef} tabIndex={-1}>
          {isLoading
            ? 'Loading jobs…'
            : isPlaceholderData
              ? 'Showing previous results while loading this view…'
              : isError && !data
                ? ''
                : `${jobs.length} of ${total} jobs`}
        </span>
        {(['undo', 'redo'] as const).map(
          (action) =>
            edits[action] && (
              <button
                type="button"
                key={action}
                className={styles.exportBtn}
                disabled={edits.pending}
                title={edits[action]?.title}
                onClick={async () => {
                  if (await edits.historyAction(action)) countRef.current?.focus()
                }}
              >
                {action === 'undo' ? 'Undo' : 'Redo'}
              </button>
            ),
        )}
        <span className={styles.exportRowLabel}>Export</span>
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
      {edits.error && (
        <p role="alert" className={styles.editError}>
          {edits.error}
        </p>
      )}
      {editingId !== null && (
        <InlineEnrichment
          jobId={editingId}
          pending={edits.pending}
          close={closeEditor}
          save={edits.changeEnrichment}
        />
      )}
      <div
        className={styles.tableWrap}
        role="region"
        aria-label="Jobs table"
        aria-keyshortcuts="J K Enter"
        tabIndex={0}
      >
        <table className={`${styles.table} ${isMatches ? styles.matchesTable : ''}`}>
          <thead>
            <tr>
              <th scope="col" className={styles.selectHead}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  disabled={!selectionReady}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked && !allChecked
                  }}
                  onChange={() => (allChecked ? clearSelection() : selectAll(allIds))}
                  aria-label="Select all rows on this page"
                  id="jobs-select-page"
                  title="Select or deselect all rows on this page"
                />
                <label htmlFor="jobs-select-page" className={styles.selectPageLabel}>
                  Select page
                </label>
              </th>
              <th className={styles.mobileHead} colSpan={columns.length}>
                <select
                  aria-label="Sort this page"
                  value={localSort ? `${localSort.field}:${localSort.dir}` : ''}
                  onChange={(event) => {
                    const [field, dir] = event.target.value.split(':')
                    setLocalSort(field ? { field, dir: dir === 'desc' ? 'desc' : 'asc' } : null)
                  }}
                >
                  <option value="">Sort this page</option>
                  {columns
                    .filter((label) => COL_SORT_KEYS[label])
                    .map((label) => {
                      const field = COL_SORT_KEYS[label]
                      return (
                        <optgroup key={field} label={label}>
                          <option value={`${field}:asc`}>{label} ↑</option>
                          <option value={`${field}:desc`}>{label} ↓</option>
                        </optgroup>
                      )
                    })}
                </select>
              </th>
              {columns.map((label) => (
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
                <td
                  colSpan={columns.length + 1}
                  style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}
                >
                  Loading…
                </td>
              </tr>
            ) : displayJobs.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}
                >
                  {isError
                    ? 'Jobs are unavailable. Retry above.'
                    : query.view === 'matches'
                      ? 'No matching jobs to show.'
                      : 'No jobs match this filter.'}
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

      <BulkBar disabled={!selectionReady || [...selectedIds].some((id) => !allIds.includes(id))} />
    </div>
  )
}
