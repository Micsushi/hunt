import { useState } from 'react'
import { useSummary } from '@/hooks/useSummary'
import { useUiStore } from '@/store/ui'
import { requeueErrors, requeueStaleProcessing, bulkRequeue } from '@/api/ops'
import {
  fetchC1Queue,
  fetchC1DiscoveryHealth,
  fetchC1Status,
  fetchLinkedInAccounts,
  fetchSettings,
  saveLinkedInAccount,
  saveSetting,
  triggerC1Enrich,
  triggerC1Reauth,
  triggerC1Scrape,
  type ComponentId,
} from '@/api/control'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SystemStatusPanel } from '@/pages/Control/SystemStatus'
import styles from './Ops.module.css'
import { coverageRows } from './discoveryCoverage'
import { CompanyPreview } from './CompanyPreview'

function coverageIssue(error: string | null): string {
  if (!error) return 'None reported'
  const cooldown = 'jobright_cooldown_until_'
  if (error.startsWith(cooldown)) {
    const until = new Date(error.slice(cooldown.length))
    if (!Number.isNaN(until.getTime()))
      return `JobRight limit reached. Retry after ${until.toLocaleString()}.`
  }
  const messages: Record<string, string> = {
    http_403: 'The site denied access. Listings could not be checked.',
    http_404: 'The careers address was not found. Its configured URL needs checking.',
    http_429: 'The site limited requests. C1 will retry later.',
    http_500: 'The site returned a server error. C1 will retry later.',
    security_checkpoint: 'The site requires a security check. Automated access is unavailable.',
    career_adapter_unavailable: 'This careers page is not supported yet.',
    ambiguous_career_boards:
      'More than one hiring board was found. Choose the intended board in configuration.',
    posting_details_unverified: 'Listings found; full job details still need verification.',
    posting_date_unknown: 'Listings found, but their posting dates are not published or verified.',
    catalog_total_unknown:
      'Listings found, but the site does not confirm the complete catalog size.',
    catalog_count_mismatch: 'Page counts did not match. This scan is incomplete.',
    detail_identity_mismatch: 'A posting did not match its listing. Its details remain unverified.',
    pagination_not_verified: 'More pages may remain. This scan is incomplete.',
    catalog_changed_during_scan: 'The job list changed during the scan. C1 will retry later.',
    repeated_page: 'The site repeated a page. More results may remain.',
    jobright_hourly_refresh_limit:
      'JobRight hourly limit reached. C1 will wait an hour before retrying.',
    jobright_sign_in_required: 'Sign in to JobRight again and save its session.',
    jobright_browser_not_configured: 'Save a JobRight session before searching this source.',
    jobright_browser_crashed:
      'The JobRight browser stopped unexpectedly. Saved results are retained.',
    recommendation_coverage_only: 'Saved recommendations only; not the complete JobRight catalog.',
    saved_recommendations_exhausted:
      'Reached the end of saved recommendations, not the full catalog.',
    page_limit_reached: 'Stopped at the requested page limit. More results may remain.',
    pagination_repeated: 'The site repeated a page. More results may remain.',
    application_links_not_verified: 'Listings found; application links still need verification.',
  }
  return messages[error] ?? error.replace(/_/g, ' ')
}

const REQUEUE_BUTTONS = [
  {
    label: 'LinkedIn: both',
    source: 'linkedin',
    codes: ['auth_expired', 'rate_limited'],
    primary: true,
  },
  { label: 'LinkedIn: expired session', source: 'linkedin', codes: ['auth_expired'] },
  { label: 'LinkedIn: rate limited', source: 'linkedin', codes: ['rate_limited'] },
  { label: 'Indeed: rate limited', source: 'indeed', codes: ['rate_limited'] },
  { label: 'All sources: both', source: 'all', codes: ['auth_expired', 'rate_limited'] },
]

const BULK_STATUS_OPTIONS = [
  { value: 'failed', label: 'Failed' },
  { value: 'failed_url', label: 'Failed URL' },
  { value: 'failed_description', label: 'Failed description' },
  { value: 'failed_enrichment', label: 'Failed enrichment' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'blocked_verified', label: 'Blocked verified' },
  { value: 'processing', label: 'Processing' },
  { value: 'pending', label: 'Pending enrichment' },
]

export function OpsPage() {
  const { data: summary } = useSummary(30_000)
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const [loadingBtn, setLoadingBtn] = useState<string | null>(null)
  const [staleResult, setStaleResult] = useState<string | null>(null)
  const [bulkStatuses, setBulkStatuses] = useState<string[]>(['failed'])
  const [bulkDryResult, setBulkDryResult] = useState<string | null>(null)
  const [settingComponent, setSettingComponent] = useState<ComponentId>('c1')
  const [settingKey, setSettingKey] = useState('')
  const [settingValue, setSettingValue] = useState('')
  const [settingSecret, setSettingSecret] = useState(false)
  const [accountUsername, setAccountUsername] = useState('')
  const [accountPassword, setAccountPassword] = useState('')
  const [accountName, setAccountName] = useState('')
  const [c1Result, setC1Result] = useState<unknown>(null)
  const [coverageSearch, setCoverageSearch] = useState('')
  const [coverageFilter, setCoverageFilter] = useState('attention')
  const discovery = useQuery({
    queryKey: ['c1-discovery-health'],
    queryFn: fetchC1DiscoveryHealth,
    refetchInterval: 15_000,
  })
  const checks = coverageRows(discovery.data)
  const scan = discovery.data?.scan
  const elapsed = scan?.started_at
    ? Math.max(
        0,
        Math.floor(
          ((scan.running ? discovery.dataUpdatedAt / 1000 : (scan.finished_at ?? scan.started_at)) -
            scan.started_at) /
            60,
        ),
      )
    : 0
  const completedChecks = checks.filter((row) => row.status === 'ok').length
  const visibleChecks = checks.filter(
    (row) =>
      (coverageFilter === 'all' || row.status !== 'ok') &&
      row.source.toLocaleLowerCase().includes(coverageSearch.trim().toLocaleLowerCase()),
  )

  const { data: accountsData } = useQuery({
    queryKey: ['linkedin-accounts'],
    queryFn: fetchLinkedInAccounts,
    staleTime: 20_000,
  })
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => fetchSettings(),
    staleTime: 20_000,
  })

  const accountMutation = useMutation({
    mutationFn: saveLinkedInAccount,
    onSuccess: () => {
      showToast('Account saved')
      setAccountUsername('')
      setAccountPassword('')
      setAccountName('')
      qc.invalidateQueries({ queryKey: ['linkedin-accounts'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Account save failed', 'error'),
  })

  const settingMutation = useMutation({
    mutationFn: saveSetting,
    onSuccess: () => {
      showToast('Setting saved')
      setSettingKey('')
      setSettingValue('')
      setSettingSecret(false)
      qc.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Setting save failed', 'error'),
  })

  const failureCounts = summary?.failure_counts ?? {}
  const authN = failureCounts['auth_expired'] ?? 0
  const rateN = failureCounts['rate_limited'] ?? 0
  const staleN = summary?.stale_processing_count ?? 0

  async function handleRequeue(source: string, codes: string[], key: string) {
    setLoadingBtn(key)
    try {
      const res = await requeueErrors({ source, error_codes: codes })
      showToast(`Requeued ${res.updated} row(s)`)
      qc.invalidateQueries({ queryKey: ['summary'] })
      qc.invalidateQueries({ queryKey: ['jobs'] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Requeue failed', 'error')
    } finally {
      setLoadingBtn(null)
    }
  }

  async function handleStale() {
    setLoadingBtn('stale')
    try {
      const res = await requeueStaleProcessing()
      setStaleResult(`Updated ${res.updated} row(s)`)
      showToast(`Stale reset: ${res.updated} row(s)`)
      qc.invalidateQueries({ queryKey: ['summary'] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Stale reset failed', 'error')
    } finally {
      setLoadingBtn(null)
    }
  }

  async function handleBulk(dry: boolean) {
    if (!bulkStatuses.length) {
      showToast('Select at least one status', 'error')
      return
    }
    setLoadingBtn(dry ? 'bulk-dry' : 'bulk-run')
    try {
      const res = await bulkRequeue({
        source: null,
        status: 'all',
        q: '',
        tag: '',
        target_statuses: bulkStatuses,
        dry_run: dry,
      })
      if (dry) {
        setBulkDryResult(`Would requeue ${res.count} row(s)`)
      } else {
        showToast(`Requeued ${res.updated} row(s)`)
        setBulkDryResult(null)
        qc.invalidateQueries({ queryKey: ['summary'] })
        qc.invalidateQueries({ queryKey: ['jobs'] })
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Bulk requeue failed', 'error')
    } finally {
      setLoadingBtn(null)
    }
  }

  function toggleBulkStatus(val: string) {
    setBulkStatuses((prev) => (prev.includes(val) ? prev.filter((s) => s !== val) : [...prev, val]))
  }

  async function runC1(label: string, fn: () => Promise<unknown>) {
    setLoadingBtn(label)
    try {
      const res = await fn()
      setC1Result(res)
      showToast(`${label} sent`)
      qc.invalidateQueries({ queryKey: ['system-status'] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : `${label} failed`, 'error')
    } finally {
      setLoadingBtn(null)
    }
  }

  function saveAccount() {
    if (!accountUsername.trim()) {
      showToast('Username required', 'error')
      return
    }
    accountMutation.mutate({
      username: accountUsername.trim(),
      password: accountPassword || undefined,
      display_name: accountName.trim() || undefined,
      active: true,
    })
  }

  function submitSetting() {
    if (!settingKey.trim()) {
      showToast('Setting key required', 'error')
      return
    }
    settingMutation.mutate({
      component: settingComponent,
      key: settingKey.trim(),
      value: settingValue,
      value_type: settingSecret ? 'secret' : 'string',
      secret: settingSecret,
    })
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Hunter</h1>
      </section>

      <div className={`${styles.panel} ${styles.panelStrong}`}>
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Job search</h2>
        </div>
        <div className={styles.buttons}>
          <button
            className={styles.btn}
            disabled={!!loadingBtn}
            onClick={() => runC1('status', fetchC1Status)}
          >
            Status
          </button>
          <button
            className={styles.btn}
            disabled={!!loadingBtn}
            onClick={() => runC1('queue', fetchC1Queue)}
          >
            Queue
          </button>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!!loadingBtn}
            onClick={() => runC1('Search', () => triggerC1Scrape(true))}
          >
            Search jobs
          </button>
          <button
            className={styles.btn}
            disabled={!!loadingBtn}
            onClick={() => runC1('enrich', () => triggerC1Enrich(25))}
          >
            Enrich 25
          </button>
          <button
            className={styles.btn}
            disabled={!!loadingBtn}
            onClick={() => runC1('drain', () => triggerC1Enrich(500))}
            title="Enrich up to 500 pending rows in one background run"
          >
            Enrich up to 500
          </button>
        </div>
        {c1Result ? (
          <details className={styles.coverage}>
            <summary>Response details</summary>
            <pre className={styles.apiRef}>{JSON.stringify(c1Result, null, 2)}</pre>
          </details>
        ) : null}
        <details className={styles.coverage} open>
          <summary>Search coverage</summary>
          {scan?.state && (
            <div className={styles.coverageNote}>
              <p role="status">
                {scan.running
                  ? scan.resumed
                    ? 'Scan resumed'
                    : 'Scan running'
                  : scan.state === 'completed'
                    ? 'Scan completed'
                    : 'Scan interrupted; saved progress will resume on the next matching scan'}
                . {scan.completed?.length ?? 0} steps completed · {elapsed} minutes.
                {scan.last_saved_at && (
                  <> Last saved: {new Date(scan.last_saved_at * 1000).toLocaleString()}.</>
                )}
              </p>
              {scan.running && Object.keys(scan.active ?? {}).length > 0 && (
                <details>
                  <summary>Currently searching ({Object.keys(scan.active ?? {}).length})</summary>
                  <ul>
                    {Object.entries(scan.active ?? {}).map(([name, since]) => (
                      <li key={name}>
                        {name.startsWith('company:')
                          ? name.slice(8).split(':http')[0]
                          : name
                              .replace(/^(board|public|query):/, '')
                              .replace(/[()']/g, '')
                              .replace(/_/g, ' ')}{' '}
                        · {Math.max(0, Math.floor((discovery.dataUpdatedAt / 1000 - since) / 60))}{' '}
                        minutes
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {discovery.isPending && <p role="status">Loading source results…</p>}
          {!!discovery.data?.unimplemented_sources?.length && (
            <p>
              Not yet scripted: {discovery.data.unimplemented_sources.join(', ')}. These sources
              have not been searched by this run.
            </p>
          )}
          {discovery.isError && (
            <p role="alert">
              Source results could not be loaded.{' '}
              <button className={styles.btn} onClick={() => discovery.refetch()}>
                Retry
              </button>
            </p>
          )}
          {discovery.data && checks.length === 0 && (
            <p>No source checks recorded yet. Run a search to collect results.</p>
          )}
          {!!checks.length && (
            <>
              <p className={styles.coverageNote}>
                {completedChecks} checks completed; {checks.length - completedChecks} need
                attention.
              </p>
              <div className={styles.formGrid}>
                <label className={styles.field}>
                  Find a source
                  <input
                    className={styles.input}
                    type="search"
                    value={coverageSearch}
                    onChange={(event) => setCoverageSearch(event.target.value)}
                  />
                </label>
                <label className={styles.field}>
                  Show checks
                  <select
                    className={styles.input}
                    value={coverageFilter}
                    onChange={(event) => setCoverageFilter(event.target.value)}
                  >
                    <option value="attention">Need attention</option>
                    <option value="all">All checks</option>
                  </select>
                </label>
              </div>
              <div
                className={`${styles.tableWrap} ${styles.coverageResults}`}
                tabIndex={0}
                role="region"
                aria-label="Source check results"
              >
                <table className={styles.table}>
                  <caption className={styles.coverageNote}>
                    Latest checks by source. Partial or failed checks do not mean there are no jobs.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Source / search</th>
                      <th scope="col">Coverage</th>
                      <th scope="col">Leads</th>
                      <th scope="col">Unfinished work</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleChecks.map((source) => (
                      <tr key={source.source}>
                        <td>{source.source.replace(/^company:/, '')}</td>
                        <td>
                          {source.status === 'ok'
                            ? 'Check completed'
                            : source.last_error === 'posting_date_unknown'
                              ? 'Catalog read; dates unknown'
                              : source.last_error === 'application_links_not_verified'
                                ? 'Leads found; links unverified'
                                : source.status === 'pending_manual'
                                  ? source.last_error === 'ambiguous_career_boards'
                                    ? 'Needs setup'
                                    : 'Not supported'
                                  : source.status.replace(/_/g, ' ')}
                        </td>
                        <td data-label="Leads">{source.lead_count}</td>
                        <td>{coverageIssue(source.last_error)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visibleChecks.length === 0 && (
                  <p role="status">
                    {coverageSearch.trim()
                      ? 'No checks match this search. Clear it or choose All checks.'
                      : 'No checks need attention. Choose All checks to see completed scans.'}
                  </p>
                )}
              </div>
            </>
          )}
        </details>
      </div>

      <div className={styles.panel}>
        <CompanyPreview />
      </div>

      <SystemStatusPanel />

      <details className={styles.panel}>
        <summary className={styles.sectionSummary}>Accounts and advanced settings</summary>
        <div className={styles.gridTwo}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>LinkedIn accounts</h2>
              <span className={styles.panelMeta}>{accountsData?.accounts.length ?? 0} saved</span>
            </div>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                Username
                <input
                  className={styles.input}
                  value={accountUsername}
                  onChange={(e) => setAccountUsername(e.target.value)}
                  placeholder="user@example.com"
                />
              </label>
              <label className={styles.field}>
                Display name
                <input
                  className={styles.input}
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="Primary"
                />
              </label>
              <label className={styles.field}>
                Password
                <input
                  className={styles.input}
                  value={accountPassword}
                  onChange={(e) => setAccountPassword(e.target.value)}
                  type="password"
                  autoComplete="new-password"
                  placeholder="Leave blank to keep existing"
                />
              </label>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={accountMutation.isPending}
                onClick={saveAccount}
              >
                Save account
              </button>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>State</th>
                    <th>Password</th>
                    <th>Active</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(accountsData?.accounts ?? []).map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div>{a.display_name || a.username}</div>
                        <div className="mono">{a.username}</div>
                      </td>
                      <td>{a.auth_state}</td>
                      <td>{a.has_password ? 'saved' : 'missing'}</td>
                      <td>{a.active ? 'yes' : 'no'}</td>
                      <td>
                        <button
                          className={styles.btn}
                          onClick={() => runC1('reauth', () => triggerC1Reauth(a.id))}
                        >
                          Reauth
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>Component settings</h2>
              <span className={styles.panelMeta}>{settingsData?.settings.length ?? 0} keys</span>
            </div>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                Component
                <select
                  className={styles.input}
                  value={settingComponent}
                  onChange={(e) => setSettingComponent(e.target.value as ComponentId)}
                >
                  {(['c0', 'c1', 'c2'] as ComponentId[]).map((c) => (
                    <option key={c} value={c}>
                      {c.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                Key
                <input
                  className={styles.input}
                  value={settingKey}
                  onChange={(e) => setSettingKey(e.target.value)}
                  placeholder="setting_key"
                />
              </label>
              <label className={styles.field}>
                Value
                <input
                  className={styles.input}
                  value={settingValue}
                  onChange={(e) => setSettingValue(e.target.value)}
                  placeholder="value"
                />
              </label>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={settingSecret}
                  onChange={() => setSettingSecret((v) => !v)}
                />
                Secret
              </label>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={settingMutation.isPending}
                onClick={submitSetting}
              >
                Save setting
              </button>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Key</th>
                    <th>Value</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {(settingsData?.settings ?? []).map((s) => (
                    <tr key={`${s.component}-${s.key}`}>
                      <td>{s.component.toUpperCase()}</td>
                      <td className="mono">{s.key}</td>
                      <td>
                        {s.secret ? (s.has_value ? 'redacted' : 'empty') : s.value || 'empty'}
                      </td>
                      <td className="mono">{s.updated_at ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </details>

      <details className={styles.panel}>
        <summary className={styles.sectionSummary}>Retry failed jobs</summary>
        {/* Transient failures */}
        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Expired sessions and rate limits</h2>
          <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 8 }}>
            Moves failed rows back to pending (clears retry timers). Use after auth is refreshed or
            a rate-limit window has passed.
          </p>
          <p style={{ fontSize: '0.88rem', marginBottom: 14 }}>
            Failed jobs: <strong>Expired session</strong> {authN} · <strong>Rate limited</strong>{' '}
            {rateN}
          </p>
          <div className={styles.buttons}>
            {REQUEUE_BUTTONS.map((btn) => {
              const key = `${btn.source}-${btn.codes.join(',')}`
              return (
                <button
                  key={key}
                  className={`${styles.btn} ${btn.primary ? styles.btnPrimary : ''}`}
                  onClick={() => handleRequeue(btn.source, btn.codes, key)}
                  disabled={loadingBtn === key}
                  title={`Requeue ${btn.source} rows with error codes: ${btn.codes.join(', ')}`}
                >
                  {loadingBtn === key ? 'Working…' : btn.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Stale processing */}
        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Interrupted jobs</h2>
          <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 8 }}>
            Rows stuck in "processing" state are moved back to "pending". Use when a worker crashed
            mid-enrichment.
          </p>
          <p style={{ fontSize: '0.88rem', marginBottom: 14 }}>
            Interrupted jobs: <strong>{staleN}</strong>
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleStale}
              disabled={loadingBtn === 'stale'}
              title="Move all stale processing rows back to pending"
            >
              {loadingBtn === 'stale' ? 'Working…' : 'Requeue stale processing'}
            </button>
            {staleResult && (
              <span className="muted" style={{ fontSize: '0.88rem' }}>
                {staleResult}
              </span>
            )}
          </div>
        </div>

        {/* Bulk requeue */}
        <div className={styles.panel}>
          <h2 className={styles.panelTitle}>Bulk requeue by status</h2>
          <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
            Moves all rows with the selected statuses back to pending. Operates across all sources.
            Server caps batch size. Use dry run first to count before committing.
          </p>
          <div className={styles.checkboxRow}>
            {BULK_STATUS_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={styles.checkLabel}
                title={`Include ${o.label} rows in the requeue`}
              >
                <input
                  type="checkbox"
                  checked={bulkStatuses.includes(o.value)}
                  onChange={() => toggleBulkStatus(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              className={styles.btn}
              onClick={() => handleBulk(true)}
              disabled={!!loadingBtn}
              title="Count how many rows would be moved without changing anything"
            >
              {loadingBtn === 'bulk-dry' ? 'Counting…' : 'Count matching jobs'}
            </button>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => handleBulk(false)}
              disabled={!!loadingBtn}
              title="Move all matching rows to pending"
            >
              {loadingBtn === 'bulk-run' ? 'Working…' : 'Requeue matching rows'}
            </button>
            {bulkDryResult && (
              <span className="muted" style={{ fontSize: '0.88rem' }}>
                {bulkDryResult}
              </span>
            )}
          </div>
        </div>
      </details>
      <details className={styles.panel}>
        <summary className={styles.sectionSummary}>API reference</summary>
        <pre className={styles.apiRef}>
          {`POST /api/ops/requeue-errors
  { "source": "linkedin", "error_codes": ["auth_expired", "rate_limited"] }

GET /api/system/status
GET /api/settings
GET /api/linkedin/accounts

POST /api/ops/bulk-requeue
  { "source": null, "status": "all", "q": "", "tag": "",
    "target_statuses": ["failed", "blocked"], "dry_run": false }

POST /api/ops/requeue-stale-processing
  {}

POST /api/jobs/bulk-selection
  { "action": "requeue"|"set_status"|"delete",
    "job_ids": [1,2,3],
    "enrichment_status": "pending",   // only for set_status
    "confirm_delete": true }          // only for delete

CLI equivalent:
  python3 scripts/hunterctl.py requeue-retryable
  python3 scripts/hunterctl.py requeue-errors --error-code auth_expired`}
        </pre>
      </details>
    </div>
  )
}
