import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchC1Config,
  saveC1Config,
  testC1Discord,
  type C1Config,
  type C1ConfigUpdates,
} from '@/api/control'
import { useUiStore } from '@/store/ui'
import styles from './Settings.module.css'

// ---- helpers ---------------------------------------------------------------

function listToText(items: string[]): string {
  return items.join('\n')
}

function textToList(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ---- sub-panels ------------------------------------------------------------

function DiscoveryFilters({
  cfg,
  onSave,
  saving,
}: {
  cfg: C1Config
  onSave: (u: C1ConfigUpdates) => void
  saving: boolean
}) {
  const [watchlist, setWatchlist] = useState(() => listToText(cfg.watchlist))
  const [blacklist, setBlacklist] = useState(() => listToText(cfg.title_blacklist))

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Discovery filters</h2>
      </div>
      <label className={styles.field}>
        Watchlist — priority companies (one per line)
        <span className={styles.fieldHint}>
          Jobs from these companies get priority=1 and trigger a Discord alert on scrape.
        </span>
        <textarea
          className={styles.textarea}
          value={watchlist}
          onChange={(e) => setWatchlist(e.target.value)}
          rows={10}
        />
      </label>
      <label className={styles.field}>
        Title blacklist — phrases to exclude (one per line)
        <span className={styles.fieldHint}>
          Jobs whose title contains any of these phrases are filtered out during scrape.
        </span>
        <textarea
          className={styles.textarea}
          value={blacklist}
          onChange={(e) => setBlacklist(e.target.value)}
          rows={10}
        />
      </label>
      <div className={styles.footer}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={() =>
            onSave({
              watchlist: textToList(watchlist),
              title_blacklist: textToList(blacklist),
            })
          }
        >
          {saving ? 'Saving…' : 'Save filters'}
        </button>
      </div>
    </div>
  )
}

function SearchConfig({
  cfg,
  onSave,
  saving,
}: {
  cfg: C1Config
  onSave: (u: C1ConfigUpdates) => void
  saving: boolean
}) {
  const laneNames = Object.keys(cfg.search_terms)
  const [lanes, setLanes] = useState<Record<string, string>>(() =>
    Object.fromEntries(laneNames.map((k) => [k, listToText(cfg.search_terms[k])])),
  )
  const [locations, setLocations] = useState(() => listToText(cfg.locations))
  const [linkedinOn, setLinkedinOn] = useState(() => cfg.sites.includes('linkedin'))
  const [indeedOn, setIndeedOn] = useState(() => cfg.sites.includes('indeed'))

  function updateLane(name: string, val: string) {
    setLanes((prev) => ({ ...prev, [name]: val }))
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Search configuration</h2>
      </div>
      <div className={styles.lanesGrid}>
        {laneNames.map((name) => (
          <label key={name} className={styles.field}>
            {name.charAt(0).toUpperCase() + name.slice(1)} lane — search queries
            <textarea
              className={styles.textarea}
              value={lanes[name] ?? ''}
              onChange={(e) => updateLane(name, e.target.value)}
            />
          </label>
        ))}
      </div>
      <label className={styles.field}>
        Locations (one per line)
        <textarea
          className={styles.textarea}
          value={locations}
          onChange={(e) => setLocations(e.target.value)}
          rows={4}
        />
      </label>
      <div className={styles.field}>
        Job boards
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={linkedinOn}
            onChange={(e) => setLinkedinOn(e.target.checked)}
          />
          LinkedIn
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={indeedOn}
            onChange={(e) => setIndeedOn(e.target.checked)}
          />
          Indeed
        </label>
      </div>
      <div className={styles.footer}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={() => {
            const sites: string[] = []
            if (linkedinOn) sites.push('linkedin')
            if (indeedOn) sites.push('indeed')
            onSave({
              search_terms: Object.fromEntries(
                Object.entries(lanes).map(([k, v]) => [k, textToList(v)]),
              ),
              locations: textToList(locations),
              sites,
            })
          }}
        >
          {saving ? 'Saving…' : 'Save search config'}
        </button>
      </div>
    </div>
  )
}

function RunSettings({
  cfg,
  onSave,
  saving,
}: {
  cfg: C1Config
  onSave: (u: C1ConfigUpdates) => void
  saving: boolean
}) {
  const [intervalSec, setIntervalSec] = useState(String(cfg.run_interval_seconds))
  const [resultsWanted, setResultsWanted] = useState(String(cfg.results_wanted))
  const [hoursOld, setHoursOld] = useState(String(cfg.hours_old))
  const [maxWorkers, setMaxWorkers] = useState(String(cfg.max_workers))
  const [enrichAfterScrape, setEnrichAfterScrape] = useState(cfg.enrich_after_scrape)
  const [batchLimit, setBatchLimit] = useState(String(cfg.enrichment_batch_limit))
  const [timeoutMs, setTimeoutMs] = useState(String(cfg.enrichment_timeout_ms))
  const [maxAttempts, setMaxAttempts] = useState(String(cfg.enrichment_max_attempts))

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Run settings</h2>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          Run interval (seconds)
          <span className={styles.fieldHint}>
            How often the scrape+enrich cycle repeats (default 600).
          </span>
          <input
            type="number"
            className={styles.input}
            value={intervalSec}
            onChange={(e) => setIntervalSec(e.target.value)}
            min={60}
          />
        </label>
        <label className={styles.field}>
          Results wanted per search
          <span className={styles.fieldHint}>
            Max listings to fetch per search term (default 500).
          </span>
          <input
            type="number"
            className={styles.input}
            value={resultsWanted}
            onChange={(e) => setResultsWanted(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Hours old (lookback window)
          <span className={styles.fieldHint}>
            Only fetch jobs posted within this many hours (default 24).
          </span>
          <input
            type="number"
            className={styles.input}
            value={hoursOld}
            onChange={(e) => setHoursOld(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Max parallel workers
          <span className={styles.fieldHint}>Concurrent scrape/enrich workers (default 10).</span>
          <input
            type="number"
            className={styles.input}
            value={maxWorkers}
            onChange={(e) => setMaxWorkers(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Enrichment batch limit
          <span className={styles.fieldHint}>Jobs enriched per cycle (default 25).</span>
          <input
            type="number"
            className={styles.input}
            value={batchLimit}
            onChange={(e) => setBatchLimit(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Enrichment timeout (ms)
          <span className={styles.fieldHint}>Playwright page timeout per job (default 45000).</span>
          <input
            type="number"
            className={styles.input}
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
            min={5000}
          />
        </label>
        <label className={styles.field}>
          Max enrichment attempts
          <span className={styles.fieldHint}>Retries before marking a job failed (default 4).</span>
          <input
            type="number"
            className={styles.input}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.target.value)}
            min={1}
          />
        </label>
      </div>
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={enrichAfterScrape}
          onChange={(e) => setEnrichAfterScrape(e.target.checked)}
        />
        Auto-enrich after each scrape
      </label>
      <div className={styles.footer}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={() =>
            onSave({
              run_interval_seconds: parseInt(intervalSec, 10),
              results_wanted: parseInt(resultsWanted, 10),
              hours_old: parseInt(hoursOld, 10),
              max_workers: parseInt(maxWorkers, 10),
              enrich_after_scrape: enrichAfterScrape,
              enrichment_batch_limit: parseInt(batchLimit, 10),
              enrichment_timeout_ms: parseInt(timeoutMs, 10),
              enrichment_max_attempts: parseInt(maxAttempts, 10),
            })
          }
        >
          {saving ? 'Saving…' : 'Save run settings'}
        </button>
      </div>
    </div>
  )
}

function AlertSettings({
  cfg,
  onSave,
  saving,
}: {
  cfg: C1Config
  onSave: (u: C1ConfigUpdates) => void
  saving: boolean
}) {
  const [failureRate, setFailureRate] = useState(String(cfg.enrichment_alert_failure_rate_percent))
  const [cooldownMin, setCooldownMin] = useState(String(cfg.enrichment_alert_cooldown_minutes))

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Alert thresholds</h2>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          High failure rate threshold (%)
          <span className={styles.fieldHint}>
            Discord alert fires when enrichment failure rate exceeds this (default 50%).
          </span>
          <input
            type="number"
            className={styles.input}
            value={failureRate}
            onChange={(e) => setFailureRate(e.target.value)}
            min={1}
            max={100}
          />
        </label>
        <label className={styles.field}>
          Alert cooldown (minutes)
          <span className={styles.fieldHint}>
            Minimum time between repeat Discord failure alerts (default 60).
          </span>
          <input
            type="number"
            className={styles.input}
            value={cooldownMin}
            onChange={(e) => setCooldownMin(e.target.value)}
            min={1}
          />
        </label>
      </div>
      <div className={styles.footer}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={() =>
            onSave({
              enrichment_alert_failure_rate_percent: parseInt(failureRate, 10),
              enrichment_alert_cooldown_minutes: parseInt(cooldownMin, 10),
            })
          }
        >
          {saving ? 'Saving…' : 'Save alert settings'}
        </button>
      </div>
    </div>
  )
}

// ---- main page -------------------------------------------------------------

export function SettingsPage() {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const [savingSection, setSavingSection] = useState<string | null>(null)
  const [testingDiscord, setTestingDiscord] = useState(false)
  const [discordResult, setDiscordResult] = useState<string | null>(null)

  async function handleTestDiscord() {
    setTestingDiscord(true)
    setDiscordResult(null)
    try {
      await testC1Discord()
      setDiscordResult('Webhook OK: test message sent.')
      showToast('Discord test sent')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Test failed'
      setDiscordResult(`Failed: ${msg}`)
      showToast(msg, 'error')
    } finally {
      setTestingDiscord(false)
    }
  }

  const {
    data: cfg,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['c1-config'],
    queryFn: fetchC1Config,
    staleTime: 30_000,
  })

  const mutation = useMutation({
    mutationFn: saveC1Config,
    onSuccess: (res) => {
      showToast(`Saved: ${res.updated_keys.join(', ')}`)
      qc.invalidateQueries({ queryKey: ['c1-config'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Save failed', 'error'),
    onSettled: () => setSavingSection(null),
  })

  function save(section: string, updates: C1ConfigUpdates) {
    setSavingSection(section)
    mutation.mutate(updates)
  }

  if (isLoading) {
    return (
      <div className={styles.page}>
        <section className={styles.hero}>
          <h1 className={styles.heroTitle}>Settings</h1>
        </section>
        <div className={styles.panel}>
          <p className="muted">Loading config from C1…</p>
        </div>
      </div>
    )
  }

  if (error || !cfg) {
    return (
      <div className={styles.page}>
        <section className={styles.hero}>
          <h1 className={styles.heroTitle}>Settings</h1>
        </section>
        <div className={styles.panel}>
          <p className={styles.errorMsg}>Could not load C1 config. Is the C1 service running?</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Settings</h1>
        <p className={styles.heroMeta}>
          C1 runtime configuration — changes persist to file on the C1 host.
        </p>
      </section>

      <div className={styles.notice}>
        Changes take effect on the next C1 scrape/enrich cycle. Restart C1 to apply scalar settings
        (intervals, limits) immediately.
        <br />
        Config file: <span className={styles.configPath}>{cfg.config_file}</span>
      </div>

      <DiscoveryFilters
        cfg={cfg}
        saving={savingSection === 'filters'}
        onSave={(u) => save('filters', u)}
      />

      <SearchConfig
        cfg={cfg}
        saving={savingSection === 'search'}
        onSave={(u) => save('search', u)}
      />

      <RunSettings cfg={cfg} saving={savingSection === 'run'} onSave={(u) => save('run', u)} />

      <AlertSettings
        cfg={cfg}
        saving={savingSection === 'alerts'}
        onSave={(u) => save('alerts', u)}
      />

      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Integrations</h2>
        </div>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
          Verify Discord webhook is configured and reachable. Sends a test message via C1.
        </p>
        <button className={styles.btn} disabled={testingDiscord} onClick={handleTestDiscord}>
          {testingDiscord ? 'Sending…' : 'Test Discord webhook'}
        </button>
        {discordResult && <p style={{ marginTop: 8, fontSize: '0.88rem' }}>{discordResult}</p>}
      </div>
    </div>
  )
}
