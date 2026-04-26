import { useState, useEffect, useCallback, useRef } from 'react'
import { timeAgo } from '@/utils/time'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useJobs } from '@/hooks/useJobs'
import { useSummary } from '@/hooks/useSummary'
import { useUiStore } from '@/store/ui'
import { Filters } from '@/components/Filters'
import { Pagination } from '@/components/Pagination'
import { BulkBar } from '@/components/BulkBar'
import { StatusBadge } from '@/components/StatusBadge'
import { bulkRequeue } from '@/api/ops'
import { useQueryClient } from '@tanstack/react-query'
import styles from './Jobs.module.css'
import type { JobsQuery, SortField, SortDirection, Job } from '@/types/job'

function queryFromParams(p: URLSearchParams): JobsQuery {
  return {
    source:    p.get('source')    || 'all',
    status:    p.get('status')    || 'all',
    q:         p.get('q')         || '',
    tag:       p.get('tag')       || '',
    category:  p.get('category')  || '',
    ats_type:  p.get('ats_type')  || '',
    sort:      (p.get('sort')     || 'date_scraped') as SortField,
    direction: (p.get('direction')|| 'desc') as SortDirection,
    limit:     parseInt(p.get('limit')  || '50', 10),
    page:      parseInt(p.get('page')   || '1',  10),
  }
}

function queryToParams(q: JobsQuery): URLSearchParams {
  const p = new URLSearchParams()
  if (q.source)    p.set('source', q.source)
  if (q.status)    p.set('status', q.status)
  if (q.q)         p.set('q', q.q)
  if (q.tag)       p.set('tag', q.tag)
  if (q.category)  p.set('category', q.category)
  if (q.ats_type)  p.set('ats_type', q.ats_type)
  if (q.sort)      p.set('sort', q.sort)
  if (q.direction) p.set('direction', q.direction)
  if (q.limit)     p.set('limit', String(q.limit))
  if (q.page)      p.set('page', String(q.page))
  return p
}

const COL_TIPS: Record<string, string> = {
  ID:           'Database row ID',
  Company:      'Employer name',
  Title:        'Job title',
  Links:        'View listing or apply page',
  Enrichment:   'Current enrichment status',
  'Apply type': '"external_apply" = company ATS. "easy_apply" = LinkedIn — we skip those.',
  Attempts:     'How many enrichment attempts on this row',
  Added:        'When this job was scraped',
}

function Th({ label, sortKey, query, onChange }: {
  label: string
  sortKey?: SortField
  query: JobsQuery
  onChange: (q: Partial<JobsQuery>) => void
}) {
  const active = sortKey && query.sort === sortKey
  const nextDir = active && query.direction === 'asc' ? 'desc' : 'asc'
  return (
    <th
      className={sortKey ? styles.sortable : ''}
      title={COL_TIPS[label] ?? label}
      onClick={sortKey ? () => onChange({ sort: sortKey, direction: nextDir, page: 1 }) : undefined}
    >
      {label}
      {active && <span aria-hidden="true">{query.direction === 'asc' ? ' ↑' : ' ↓'}</span>}
    </th>
  )
}

export function JobsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState<JobsQuery>(() => queryFromParams(searchParams))
  const { data: jobs = [], isLoading, isFetching } = useJobs(query)
  const { data: summary } = useSummary(60_000)
  const { selectedIds, toggleSelect, selectAll, clearSelection } = useUiStore()
  const qc = useQueryClient()
  const tbodyRef = useRef<HTMLTableSectionElement>(null)
  const [focusIdx, setFocusIdx] = useState(-1)
  const [bulkDryResult, setBulkDryResult] = useState<string | null>(null)
  const showToast = useUiStore(s => s.showToast)

  // Sync URL when query changes
  useEffect(() => {
    setSearchParams(queryToParams(query), { replace: true })
    clearSelection()
    setFocusIdx(-1) // eslint-disable-line react-hooks/set-state-in-effect
  }, [query])  // eslint-disable-line

  const updateQuery = useCallback((patch: Partial<JobsQuery>) => {
    setQuery(prev => ({ ...prev, ...patch }))
  }, [])

  // Keyboard j/k/Enter navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const rows = tbodyRef.current?.querySelectorAll('tr[data-job-id]') ?? []
      if (!rows.length) return
      if (e.key === 'j') { e.preventDefault(); setFocusIdx(i => Math.min(i + 1, rows.length - 1)) }
      if (e.key === 'k') { e.preventDefault(); setFocusIdx(i => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && focusIdx >= 0) {
        const row = rows[focusIdx] as HTMLElement
        const id = row.dataset.jobId
        if (id) navigate(`/jobs/${id}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusIdx, navigate])

  useEffect(() => {
    const rows = tbodyRef.current?.querySelectorAll('tr[data-job-id]') ?? []
    rows.forEach((r, i) => r.classList.toggle(styles.focused, i === focusIdx))
    if (focusIdx >= 0) (rows[focusIdx] as HTMLElement)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusIdx, jobs])

  const allIds = jobs.map(j => j.id)
  const allChecked = allIds.length > 0 && allIds.every(id => selectedIds.has(id))
  const someChecked = allIds.some(id => selectedIds.has(id))

  async function runBulkRequeue(dry: boolean) {
    try {
      const res = await bulkRequeue({
        source: query.source === 'all' ? null : (query.source ?? null),
        status: query.status ?? 'all',
        q: query.q ?? '',
        tag: query.tag ?? '',
        target_statuses: ['failed', 'blocked', 'blocked_verified'],
        dry_run: dry,
      })
      if (dry) {
        setBulkDryResult(`Would requeue ${res.count} row(s)`)
      } else {
        showToast(`Requeued ${res.updated} row(s)`)
        qc.invalidateQueries({ queryKey: ['jobs'] })
        qc.invalidateQueries({ queryKey: ['summary'] })
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Bulk requeue failed', 'error')
    }
  }

  function renderJob(job: Job, idx: number) {
    const checked = selectedIds.has(job.id)
    return (
      <tr
        key={job.id}
        data-job-id={job.id}
        className={`${styles.jobRow} ${idx === focusIdx ? styles.focused : ''}`}
        onClick={() => navigate(`/jobs/${job.id}`)}
      >
        <td onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleSelect(job.id)}
            aria-label={`Select job ${job.id}`}
          />
        </td>
        <td className={styles.idCell}>
          <a href={`/jobs/${job.id}`} onClick={e => { e.preventDefault(); navigate(`/jobs/${job.id}`) }}>#{job.id}</a>
        </td>
        <td className={styles.companyCell} title={job.company ?? undefined}>{job.company ?? '-'}</td>
        <td className={styles.titleCell} title={job.title ?? undefined}>{job.title ?? '-'}</td>
        <td onClick={e => e.stopPropagation()}>
          {job.job_url && <a href={job.job_url} target="_blank" rel="noreferrer" title="View original listing" className={styles.extLink}>Listing ↗</a>}
          {job.job_url && job.apply_url && <span style={{ color: 'var(--line)', margin: '0 4px' }}>|</span>}
          {job.apply_url && <a href={job.apply_url} target="_blank" rel="noreferrer" title="Apply page" className={styles.extLink}>Apply ↗</a>}
        </td>
        <td><StatusBadge status={job.enrichment_status} size="sm" /></td>
        <td className={styles.applyType}>{job.apply_type?.replace(/_/g, ' ') ?? '-'}</td>
        <td className={styles.numCell}>{job.enrichment_attempts ?? 0}</td>
        <td className="mono" style={{ fontSize: '0.8rem', color: 'var(--muted)' }} title={job.date_scraped ?? undefined}>{timeAgo(job.date_scraped)}</td>
      </tr>
    )
  }

  const statusCounts = summary?.counts_by_status

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Jobs</h1>
        <p className="muted">
          {isLoading ? 'Loading…' : `${jobs.length} rows shown.`}
          {isFetching && !isLoading && <span style={{ marginLeft: 8, color: 'var(--accent)' }}>Refreshing…</span>}
          <span style={{ marginLeft: 8, color: 'var(--muted)', fontSize: '0.83rem' }}>
            Keyboard: <kbd className={styles.kbd}>j</kbd>/<kbd className={styles.kbd}>k</kbd> move · <kbd className={styles.kbd}>Enter</kbd> open
          </span>
        </p>
      </section>

      <Filters query={query} onChange={updateQuery} statusCounts={statusCounts} />

      {/* Advanced panel */}
      <details className={styles.advanced}>
        <summary className={styles.advSummary}>Advanced: bulk requeue by current filters</summary>
        <div className={styles.advBody}>
          <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
            Requeues all rows matching your current filters (source, status, search) that have status: failed, blocked, or blocked_verified.
            Server caps batch size.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className={styles.advBtn} onClick={() => runBulkRequeue(true)} title="Count how many rows would be requeued without changing anything">
              Count only (dry run)
            </button>
            <button className={`${styles.advBtn} ${styles.advBtnPrimary}`} onClick={() => runBulkRequeue(false)} title="Requeue all matching failed/blocked rows to pending">
              Requeue matching rows
            </button>
            {bulkDryResult && <span className="muted" style={{ fontSize: '0.88rem' }}>{bulkDryResult}</span>}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <a
              className={styles.exportBtn}
              href={`/api/jobs/export?format=csv&${queryToParams(query).toString()}`}
              title="Download current filtered results as CSV"
            >
              Download CSV
            </a>
            <a
              className={styles.exportBtn}
              href={`/api/jobs/export?format=json&${queryToParams(query).toString()}`}
              title="Download current filtered results as JSON"
            >
              Download JSON
            </a>
          </div>
        </div>
      </details>

      {/* Table */}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th style={{ width: '2rem', textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={el => { if (el) el.indeterminate = someChecked && !allChecked }}
                  onChange={() => allChecked ? clearSelection() : selectAll(allIds)}
                  aria-label="Select all rows on this page"
                  title="Select or deselect all rows on this page"
                />
              </th>
              {Object.keys(COL_TIPS).map(label => (
                <Th
                  key={label}
                  label={label}
                  sortKey={
                    label === 'ID'           ? 'id'                  :
                    label === 'Company'      ? 'company'             :
                    label === 'Title'        ? 'title'               :
                    label === 'Enrichment'   ? 'enrichment_status'   :
                    label === 'Apply type'   ? 'apply_type'          :
                    label === 'Attempts'     ? 'enrichment_attempts' :
                    label === 'Added'        ? 'date_scraped'        :
                    undefined
                  }
                  query={query}
                  onChange={updateQuery}
                />
              ))}
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {isLoading ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>Loading…</td></tr>
            ) : jobs.length === 0 ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: 'var(--muted)' }}>No jobs match this filter.</td></tr>
            ) : (
              jobs.map((j, i) => renderJob(j, i))
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={query.page ?? 1}
        totalRows={jobs.length >= (query.limit ?? 50) ? (query.page ?? 1) * (query.limit ?? 50) + 1 : (((query.page ?? 1) - 1) * (query.limit ?? 50)) + jobs.length}
        limit={query.limit ?? 50}
        onChange={page => updateQuery({ page })}
      />

      <BulkBar />
    </div>
  )
}
