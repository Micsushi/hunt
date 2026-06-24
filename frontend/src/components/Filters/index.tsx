import { useEffect, useRef, useCallback } from 'react'
import styles from './Filters.module.css'
import type { JobsQuery, SortField } from '@/types/job'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'ready', label: 'Ready' },
  { value: 'enriched', label: 'Enriched' },
  { value: 'partial', label: 'Partial enriched' },
  { value: 'pending', label: 'Pending enrich' },
  { value: 'processing', label: 'Processing' },
  { value: 'done', label: 'Done' },
  { value: 'done_verified', label: 'Done verified' },
  { value: 'failed', label: 'Failed' },
  { value: 'failed_url', label: 'Failed URL' },
  { value: 'failed_description', label: 'Failed description' },
  { value: 'failed_enrichment', label: 'Failed enrichment' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'blocked_verified', label: 'Blocked verified' },
]

const SOURCE_OPTIONS = [
  { value: 'all', label: 'All sources' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'indeed', label: 'Indeed' },
]

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'date_scraped', label: 'Date scraped' },
  { value: 'company', label: 'Company' },
  { value: 'title', label: 'Title' },
  { value: 'enrichment_status', label: 'Enrichment status' },
  { value: 'apply_type', label: 'Apply type' },
  { value: 'next_enrichment_retry_at', label: 'Next retry' },
  { value: 'enriched_at', label: 'Enriched at' },
  { value: 'id', label: 'ID' },
]

interface Props {
  query: JobsQuery
  onChange: (q: Partial<JobsQuery>) => void
  statusCounts?: Record<string, number>
  isFetching?: boolean
}

export function Filters({ query, onChange, statusCounts, isFetching }: Props) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep search input in sync when query changes externally (e.g. reset)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchRef.current && searchRef.current.value !== (query.q ?? '')) {
      searchRef.current.value = query.q ?? ''
    }
  }, [query.q])

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        onChange({ q: val.trim(), page: 1 })
      }, 300)
    },
    [onChange],
  )

  function reset() {
    if (searchRef.current) searchRef.current.value = ''
    if (debounceRef.current) clearTimeout(debounceRef.current)
    onChange({
      source: 'all',
      status: 'all',
      q: '',
      tag: '',
      category: '',
      ats_type: '',
      sort: 'date_scraped',
      direction: 'desc',
      page: 1,
      limit: 50,
    })
  }

  return (
    <div className={styles.wrap}>
      {/* Status chips */}
      <div className={styles.chips}>
        {STATUS_OPTIONS.map((o) => {
          const count = statusCounts?.[o.value]
          const active = (query.status ?? 'all') === o.value
          return (
            <button
              key={o.value}
              className={`${styles.chip} ${active ? styles.active : ''}`}
              onClick={() => onChange({ status: o.value, page: 1 })}
              title={`Filter by: ${o.label}`}
            >
              {o.label}
              {count !== undefined && o.value !== 'all' ? ` (${count})` : ''}
            </button>
          )
        })}
      </div>

      {/* Filter row with labeled groups */}
      <div className={styles.filterRow}>
        <div className={`${styles.filterGroup} ${styles.filterGroupSearch}`}>
          <label className={styles.filterLabel} htmlFor="jobs-search">
            Search
          </label>
          <div className={styles.searchWrap}>
            <input
              id="jobs-search"
              ref={searchRef}
              className={styles.searchInput}
              type="text"
              placeholder="Company, title, description, URL…"
              defaultValue={query.q ?? ''}
              onChange={handleSearchChange}
              aria-label="Search jobs"
            />
            {isFetching && <span className={styles.spinner} aria-hidden="true" />}
          </div>
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel} htmlFor="jobs-source">
            Source
          </label>
          <select
            id="jobs-source"
            className={styles.select}
            value={query.source ?? 'all'}
            onChange={(e) => onChange({ source: e.target.value, page: 1 })}
            aria-label="Filter by source"
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel} htmlFor="jobs-sort">
            Sort by
          </label>
          <select
            id="jobs-sort"
            className={styles.select}
            value={query.sort ?? 'date_scraped'}
            onChange={(e) => onChange({ sort: e.target.value as SortField, page: 1 })}
            aria-label="Sort by"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>Order</label>
          <button
            className={styles.dirBtn}
            onClick={() =>
              onChange({ direction: query.direction === 'asc' ? 'desc' : 'asc', page: 1 })
            }
            title={`Sort direction: ${query.direction === 'asc' ? 'ascending' : 'descending'}`}
          >
            {query.direction === 'asc' ? '↑ Asc' : '↓ Desc'}
          </button>
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel}>&nbsp;</label>
          <button className={styles.resetBtn} onClick={reset} title="Reset all filters to defaults">
            Reset
          </button>
        </div>
      </div>

      {/* Row count selector */}
      <div className={styles.limitRow}>
        <span className={styles.filterLabel}>Rows per page</span>
        {[25, 50, 100].map((n) => (
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
