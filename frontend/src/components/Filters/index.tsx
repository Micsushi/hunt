import { useState, useEffect } from 'react'
import styles from './Filters.module.css'
import type { JobsQuery, SortField } from '@/types/job'

const STATUS_OPTIONS = [
  { value: 'all',              label: 'All statuses' },
  { value: 'ready',            label: 'Ready' },
  { value: 'pending',          label: 'Pending enrich' },
  { value: 'processing',       label: 'Processing' },
  { value: 'done',             label: 'Done' },
  { value: 'done_verified',    label: 'Done verified' },
  { value: 'failed',           label: 'Failed' },
  { value: 'blocked',          label: 'Blocked' },
  { value: 'blocked_verified', label: 'Blocked verified' },
]

const SOURCE_OPTIONS = [
  { value: 'all',      label: 'All sources' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'indeed',   label: 'Indeed' },
]

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'date_scraped',             label: 'Date scraped' },
  { value: 'company',                  label: 'Company' },
  { value: 'title',                    label: 'Title' },
  { value: 'enrichment_status',        label: 'Enrichment status' },
  { value: 'apply_type',               label: 'Apply type' },
  { value: 'enrichment_attempts',      label: 'Attempts' },
  { value: 'next_enrichment_retry_at', label: 'Next retry' },
  { value: 'enriched_at',              label: 'Enriched at' },
  { value: 'id',                       label: 'ID' },
]

interface Props {
  query: JobsQuery
  onChange: (q: Partial<JobsQuery>) => void
  statusCounts?: Record<string, number>
}

export function Filters({ query, onChange, statusCounts }: Props) {
  const [search, setSearch] = useState(query.q ?? '')
  const [tag, setTag] = useState(query.tag ?? '')

  // Sync local inputs when parent resets the query (e.g. URL navigation).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSearch(query.q ?? '') }, [query.q])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setTag(query.tag ?? '') }, [query.tag])

  function submit() {
    onChange({ q: search.trim(), tag: tag.trim(), page: 1 })
  }

  function reset() {
    setSearch('')
    setTag('')
    onChange({ source: 'all', status: 'all', q: '', tag: '', sort: 'date_scraped', direction: 'desc', page: 1, limit: 50 })
  }

  return (
    <div className={styles.wrap}>
      {/* Status chips */}
      <div className={styles.chips}>
        {STATUS_OPTIONS.map(o => {
          const count = statusCounts?.[o.value]
          const active = (query.status ?? 'all') === o.value
          return (
            <button
              key={o.value}
              className={`${styles.chip} ${active ? styles.active : ''}`}
              onClick={() => onChange({ status: o.value, page: 1 })}
              title={`Filter by: ${o.label}`}
            >
              {o.label}{count !== undefined && o.value !== 'all' ? ` (${count})` : ''}
            </button>
          )
        })}
      </div>

      {/* Search row */}
      <div className={styles.row}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search company, title, description, URL…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          aria-label="Search jobs"
        />
        <input
          className={styles.tagInput}
          type="text"
          placeholder="Tag filter"
          value={tag}
          onChange={e => setTag(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          aria-label="Filter by tag"
        />
        <select
          className={styles.select}
          value={query.source ?? 'all'}
          onChange={e => onChange({ source: e.target.value, page: 1 })}
          aria-label="Filter by source"
          title="Job source: LinkedIn or Indeed"
        >
          {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          className={styles.select}
          value={query.sort ?? 'date_scraped'}
          onChange={e => onChange({ sort: e.target.value as SortField, page: 1 })}
          aria-label="Sort by"
          title="Column to sort by"
        >
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          className={styles.dirBtn}
          onClick={() => onChange({ direction: query.direction === 'asc' ? 'desc' : 'asc', page: 1 })}
          title={`Sort direction: ${query.direction === 'asc' ? 'ascending (click for descending)' : 'descending (click for ascending)'}`}
        >
          {query.direction === 'asc' ? '↑ Asc' : '↓ Desc'}
        </button>
        <button className={styles.applyBtn} onClick={submit} title="Apply search and tag filters">Search</button>
        <button className={styles.resetBtn} onClick={reset} title="Reset all filters to defaults">Reset</button>
      </div>

      {/* Row count / limit selector */}
      <div className={styles.limitRow}>
        <span className="muted" style={{ fontSize: '0.88rem' }}>Rows per page:</span>
        {[25, 50, 100].map(n => (
          <button
            key={n}
            className={`${styles.limitBtn} ${(query.limit ?? 50) === n ? styles.active : ''}`}
            onClick={() => onChange({ limit: n, page: 1 })}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}
