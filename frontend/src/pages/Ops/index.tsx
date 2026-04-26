import { useState } from 'react'
import { useSummary } from '@/hooks/useSummary'
import { useUiStore } from '@/store/ui'
import { requeueErrors, requeueStaleProcessing, bulkRequeue } from '@/api/ops'
import {
  fetchC1Queue,
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

const REQUEUE_BUTTONS = [
  { label: 'LinkedIn: auth_expired + rate_limited', source: 'linkedin', codes: ['auth_expired', 'rate_limited'], primary: true },
  { label: 'LinkedIn: auth_expired only',           source: 'linkedin', codes: ['auth_expired'] },
  { label: 'LinkedIn: rate_limited only',           source: 'linkedin', codes: ['rate_limited'] },
  { label: 'Indeed: rate_limited',                  source: 'indeed',   codes: ['rate_limited'] },
  { label: 'All sources: both codes',               source: 'all',      codes: ['auth_expired', 'rate_limited'] },
]

const BULK_STATUS_OPTIONS = [
  { value: 'failed',           label: 'Failed' },
  { value: 'blocked',          label: 'Blocked' },
  { value: 'blocked_verified', label: 'Blocked verified' },
  { value: 'processing',       label: 'Processing' },
  { value: 'pending',          label: 'Pending enrichment' },
]

export function OpsPage() {
  const { data: summary } = useSummary(30_000)
  const showToast = useUiStore(s => s.showToast)
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
  const [accountName, setAccountName] = useState('')
  const [c1Result, setC1Result] = useState<unknown>(null)

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
      setAccountName('')
      qc.invalidateQueries({ queryKey: ['linkedin-accounts'] })
    },
    onError: e => showToast(e instanceof Error ? e.message : 'Account save failed', 'error'),
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
    onError: e => showToast(e instanceof Error ? e.message : 'Setting save failed', 'error'),
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
    if (!bulkStatuses.length) { showToast('Select at least one status', 'error'); return }
    setLoadingBtn(dry ? 'bulk-dry' : 'bulk-run')
    try {
      const res = await bulkRequeue({ source: null, status: 'all', q: '', tag: '', target_statuses: bulkStatuses, dry_run: dry })
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
    setBulkStatuses(prev => prev.includes(val) ? prev.filter(s => s !== val) : [...prev, val])
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
        <h1 className={styles.heroTitle}>Operator console</h1>
      </section>

      <SystemStatusPanel />

      <div className={`${styles.panel} ${styles.panelStrong}`}>
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Hunter controls</h2>
          <span className={styles.panelMeta}>C1 via C0 gateway</span>
        </div>
        <div className={styles.buttons}>
          <button className={styles.btn} disabled={!!loadingBtn} onClick={() => runC1('status', fetchC1Status)}>Status</button>
          <button className={styles.btn} disabled={!!loadingBtn} onClick={() => runC1('queue', fetchC1Queue)}>Queue</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!loadingBtn} onClick={() => runC1('scrape', triggerC1Scrape)}>Scrape</button>
          <button className={styles.btn} disabled={!!loadingBtn} onClick={() => runC1('enrich', () => triggerC1Enrich(25))}>Enrich 25</button>
        </div>
        {c1Result ? <pre className={styles.apiRef}>{JSON.stringify(c1Result, null, 2)}</pre> : null}
      </div>

      <div className={styles.gridTwo}>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>LinkedIn accounts</h2>
            <span className={styles.panelMeta}>{accountsData?.accounts.length ?? 0} saved</span>
          </div>
          <div className={styles.formGrid}>
            <label className={styles.field}>Username
              <input className={styles.input} value={accountUsername} onChange={e => setAccountUsername(e.target.value)} placeholder="user@example.com" />
            </label>
            <label className={styles.field}>Display name
              <input className={styles.input} value={accountName} onChange={e => setAccountName(e.target.value)} placeholder="Primary" />
            </label>
            <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={accountMutation.isPending} onClick={saveAccount}>Save account</button>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Account</th><th>State</th><th>Active</th><th></th></tr></thead>
              <tbody>
                {(accountsData?.accounts ?? []).map(a => (
                  <tr key={a.id}>
                    <td><div>{a.display_name || a.username}</div><div className="mono">{a.username}</div></td>
                    <td>{a.auth_state}</td>
                    <td>{a.active ? 'yes' : 'no'}</td>
                    <td><button className={styles.btn} onClick={() => runC1('reauth', () => triggerC1Reauth(a.id))}>Reauth</button></td>
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
            <label className={styles.field}>Component
              <select className={styles.input} value={settingComponent} onChange={e => setSettingComponent(e.target.value as ComponentId)}>
                {(['c0', 'c1', 'c2', 'c3', 'c4'] as ComponentId[]).map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
              </select>
            </label>
            <label className={styles.field}>Key
              <input className={styles.input} value={settingKey} onChange={e => setSettingKey(e.target.value)} placeholder="setting_key" />
            </label>
            <label className={styles.field}>Value
              <input className={styles.input} value={settingValue} onChange={e => setSettingValue(e.target.value)} placeholder="value" />
            </label>
            <label className={styles.checkLabel}>
              <input type="checkbox" checked={settingSecret} onChange={() => setSettingSecret(v => !v)} />
              Secret
            </label>
            <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={settingMutation.isPending} onClick={submitSetting}>Save setting</button>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Component</th><th>Key</th><th>Value</th><th>Updated</th></tr></thead>
              <tbody>
                {(settingsData?.settings ?? []).map(s => (
                  <tr key={`${s.component}-${s.key}`}>
                    <td>{s.component.toUpperCase()}</td>
                    <td className="mono">{s.key}</td>
                    <td>{s.secret ? (s.has_value ? 'redacted' : 'empty') : (s.value || 'empty')}</td>
                    <td className="mono">{s.updated_at ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Transient failures */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Transient failures: one-click requeue</h2>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 8 }}>
          Moves failed rows back to pending (clears retry timers). Use after auth is refreshed or a rate-limit window has passed.
        </p>
        <p style={{ fontSize: '0.88rem', marginBottom: 14 }}>
          Current failed counts: <strong>auth_expired</strong> {authN} · <strong>rate_limited</strong> {rateN}
        </p>
        <div className={styles.buttons}>
          {REQUEUE_BUTTONS.map(btn => {
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
        <h2 className={styles.panelTitle}>Stale processing reset</h2>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 8 }}>
          Rows stuck in "processing" state are moved back to "pending". Use when a worker crashed mid-enrichment.
        </p>
        <p style={{ fontSize: '0.88rem', marginBottom: 14 }}>
          Current stale processing rows: <strong>{staleN}</strong>
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
          {staleResult && <span className="muted" style={{ fontSize: '0.88rem' }}>{staleResult}</span>}
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
          {BULK_STATUS_OPTIONS.map(o => (
            <label key={o.value} className={styles.checkLabel} title={`Include ${o.label} rows in the requeue`}>
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
          <button className={styles.btn} onClick={() => handleBulk(true)} disabled={!!loadingBtn} title="Count how many rows would be moved without changing anything">
            {loadingBtn === 'bulk-dry' ? 'Counting…' : 'Count only (dry run)'}
          </button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => handleBulk(false)} disabled={!!loadingBtn} title="Move all matching rows to pending">
            {loadingBtn === 'bulk-run' ? 'Working…' : 'Requeue matching rows'}
          </button>
          {bulkDryResult && <span className="muted" style={{ fontSize: '0.88rem' }}>{bulkDryResult}</span>}
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>API reference</h2>
        <pre className={styles.apiRef}>{`POST /api/ops/requeue-errors
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
      </div>
    </div>
  )
}
