import { useEffect, useRef, useCallback } from 'react'
import styles from './Filters.module.css'
import type { FitTier, JobDetailsFilter, JobsQuery, SortField } from '@/types/job'
import {
  detailQualityLabels,
  detailsFilter,
  fitRoleLabels,
  fitSeniorityLabels,
} from '@/utils/discovery'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'ready', label: 'Ready for enrichment' },
  { value: 'enriched', label: detailQualityLabels.enriched },
  { value: 'partial', label: detailQualityLabels.partial },
  { value: 'pending', label: 'Pending enrich' },
  { value: 'processing', label: 'Processing' },
  { value: 'done', label: 'Done' },
  { value: 'done_verified', label: 'Done verified' },
  { value: 'failed', label: detailQualityLabels.failed },
  { value: 'failed_url', label: 'Failed URL' },
  { value: 'failed_description', label: 'Failed description' },
  { value: 'failed_enrichment', label: 'Failed enrichment' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'blocked_verified', label: 'Blocked verified' },
]

const HISTORY_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'applied', label: 'Applied' },
  { value: 'canceled', label: 'Canceled' },
]

const SOURCE_OPTIONS = [
  { value: 'all', label: 'All sources' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'indeed', label: 'Indeed' },
]

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'fit_tier', label: 'Fit tier' },
  { value: 'review_status', label: 'Status' },
  { value: 'enrichment_details', label: 'Enrichment details' },
  { value: 'date_posted', label: 'Posting date' },
  { value: 'date_scraped', label: 'Date added' },
  { value: 'company', label: 'Company' },
  { value: 'title', label: 'Title' },
  { value: 'enrichment_status', label: 'Enrichment status' },
  { value: 'next_enrichment_retry_at', label: 'Next retry' },
  { value: 'enriched_at', label: 'Enriched at' },
  { value: 'id', label: 'ID' },
]

const TIER_OPTIONS: Record<FitTier, string> = {
  p1: 'P1 · New grad',
  p2: 'P2 · Intern',
  p3: 'P3 · Data',
  p4: 'P4 · IT',
  p5: 'P5 · Other',
  outside_scope: 'Outside scope',
}

const ROLE_OPTIONS = {
  ...fitRoleLabels,
  ml_engineering: 'ML',
  data: 'Data',
  business: 'Business tech',
}

const ENRICHMENT_OPTIONS: Record<JobDetailsFilter, string> = {
  all: 'Any details',
  complete: 'Complete',
  description: 'No description',
  link: 'Link unverified',
  both: 'Both needed',
}

interface Props {
  query: JobsQuery
  onChange: (q: Partial<JobsQuery>) => void
  statusCounts?: Record<string, number>
  sourceCounts?: Record<string, number>
  isFetching?: boolean
}

export function Filters({ query, onChange, statusCounts, sourceCounts, isFetching }: Props) {
  const isMatches = query.view === 'matches'
  const isHistory = query.view === 'history'
  const statusOptions = isHistory ? HISTORY_OPTIONS : STATUS_OPTIONS
  const defaultDays = isMatches ? 14 : 0
  const defaultSort = isMatches ? 'fit_tier' : 'date_scraped'
  const defaultDirection = isMatches ? 'asc' : 'desc'
  const period = query.match_days ?? defaultDays
  const companyLimit = query.company_limit ?? 2
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sourceOptions = [
    ...SOURCE_OPTIONS,
    ...Object.keys({ ...sourceCounts, ...(query.source ? { [query.source]: 0 } : {}) })
      .filter((source) => !SOURCE_OPTIONS.some((option) => option.value === source))
      .sort()
      .map((source) => ({
        value: source,
        label: source === 'jobright' ? 'JobRight' : source.replace(/_/g, ' '),
      })),
  ]

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

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
    if (searchRef.current) {
      searchRef.current.value = ''
      searchRef.current.focus()
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    onChange({
      source: 'all',
      status: 'all',
      q: '',
      tag: '',
      category: '',
      ats_type: '',
      sort: defaultSort,
      match_days: defaultDays,
      company_limit: 2,
      match_status: 'all',
      details: 'all',
      tier: undefined,
      role: undefined,
      seniority: undefined,
      direction: defaultDirection,
      page: 1,
      limit: 50,
    })
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.filterRow}>
        <div className={styles.searchAndReset}>
          <button
            type="button"
            className={styles.resetBtn}
            onClick={reset}
            aria-label="Reset job filters"
          >
            Reset
          </button>
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
                placeholder="Company or title"
                defaultValue={query.q ?? ''}
                onChange={handleSearchChange}
                aria-label="Search jobs"
              />
              {isFetching && <span className={styles.spinner} aria-hidden="true" />}
            </div>
          </div>
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel} htmlFor="jobs-period">
            Posting date
          </label>
          <select
            id="jobs-period"
            className={styles.select}
            value={period}
            onChange={(e) => onChange({ match_days: Number(e.target.value), page: 1 })}
          >
            <option value={0}>Any date</option>
            <option value={1}>Today</option>
            <option value={3}>Past 3 days</option>
            <option value={7}>Past week</option>
            <option value={14}>Past 2 weeks</option>
            <option value={30}>Past 30 days</option>
            <option value={90}>Past 90 days</option>
            {![0, 1, 3, 7, 14, 30, 90].includes(period) && (
              <option value={period}>Past {period} days</option>
            )}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel} htmlFor="jobs-tier">
            Fit tier
          </label>
          <select
            id="jobs-tier"
            className={styles.select}
            value={query.tier ?? ''}
            onChange={(e) =>
              onChange({ tier: (e.target.value || undefined) as JobsQuery['tier'], page: 1 })
            }
          >
            <option value="">All tiers</option>
            {Object.entries(TIER_OPTIONS)
              .filter(([key]) => !isMatches || key !== 'outside_scope')
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div className={`${styles.filterRow} ${styles.criteriaRow}`}>
        {isMatches ? (
          <>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel} htmlFor="jobs-company-limit">
                Per company
              </label>
              <select
                id="jobs-company-limit"
                className={styles.select}
                value={companyLimit}
                onChange={(e) => onChange({ company_limit: Number(e.target.value), page: 1 })}
              >
                <option value={0}>No limit</option>
                {[...new Set([1, 2, 3, 5, companyLimit])]
                  .filter(Boolean)
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'job' : 'jobs'}
                    </option>
                  ))}
              </select>
            </div>
            <div className={styles.filterGroup}>
              <label className={styles.filterLabel} htmlFor="jobs-match-status">
                Application link
              </label>
              <select
                id="jobs-match-status"
                className={styles.select}
                value={query.match_status ?? 'all'}
                onChange={(e) =>
                  onChange({ match_status: e.target.value as JobsQuery['match_status'], page: 1 })
                }
              >
                <option value="all">Any link status</option>
                <option value="ready">Verified link</option>
                <option value="needs_verification">Unverified link</option>
              </select>
            </div>
          </>
        ) : (
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel} htmlFor="jobs-status">
              {isHistory ? 'Application status' : 'Processing status'}
            </label>
            <select
              id="jobs-status"
              className={styles.select}
              value={query.status ?? 'all'}
              onChange={(e) => onChange({ status: e.target.value, page: 1 })}
            >
              {query.status && !statusOptions.some((option) => option.value === query.status) && (
                <option value={query.status}>{query.status.replace(/_/g, ' ')}</option>
              )}
              {statusOptions.map((option) => {
                const count = statusCounts?.[option.value]
                return (
                  <option key={option.value} value={option.value}>
                    {option.label}
                    {count !== undefined && option.value !== 'all' ? ` (${count})` : ''}
                  </option>
                )
              })}
            </select>
          </div>
        )}

        <div className={styles.filterGroup}>
          <label className={styles.filterLabel} htmlFor="jobs-enrichment">
            Enrichment
          </label>
          <select
            id="jobs-enrichment"
            className={styles.select}
            value={query.details ?? 'all'}
            onChange={(e) => onChange({ details: detailsFilter(e.target.value), page: 1 })}
          >
            {Object.entries(ENRICHMENT_OPTIONS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {(
          [
            ['role', 'Role type', ROLE_OPTIONS],
            ['seniority', 'Seniority', { ...fitSeniorityLabels, unknown: 'Unclear' }],
          ] as const
        ).map(([key, label, options]) => (
          <div className={styles.filterGroup} key={key}>
            <label className={styles.filterLabel} htmlFor={`jobs-${key}`}>
              {label}
            </label>
            <select
              id={`jobs-${key}`}
              className={styles.select}
              value={query[key] ?? ''}
              onChange={(e) => onChange({ [key]: e.target.value || undefined, page: 1 })}
            >
              <option value="">{key === 'role' ? 'All role types' : 'All levels'}</option>
              {Object.entries(options).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <details className={styles.displayOptions}>
        <summary>More filters and sort</summary>
        <div className={styles.filterRow}>
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
              {sourceOptions.map((o) => (
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
              value={query.sort ?? defaultSort}
              onChange={(e) =>
                onChange({
                  sort: e.target.value as SortField,
                  direction: e.target.value === 'fit_tier' ? 'asc' : 'desc',
                  page: 1,
                })
              }
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
            <span className={styles.filterLabel}>Order</span>
            <button
              className={styles.dirBtn}
              onClick={() =>
                onChange({ direction: query.direction === 'asc' ? 'desc' : 'asc', page: 1 })
              }
              aria-label={`Sort direction: ${query.direction === 'asc' ? 'ascending' : 'descending'}`}
              title={`Sort direction: ${query.direction === 'asc' ? 'ascending' : 'descending'}`}
            >
              {query.direction === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
          </div>
        </div>
        <div className={styles.limitRow}>
          <span className={styles.filterLabel}>Rows per page</span>
          {[25, 50, 100].map((n) => (
            <button
              key={n}
              className={`${styles.limitBtn} ${(query.limit ?? 50) === n ? styles.active : ''}`}
              aria-pressed={(query.limit ?? 50) === n}
              onClick={() => onChange({ limit: n, page: 1 })}
            >
              {n}
            </button>
          ))}
        </div>
      </details>
    </div>
  )
}
