import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchC1Config,
  fetchSettings,
  saveC1Config,
  saveSetting,
  testC1Discord,
  type C1Config,
  type C1ConfigUpdates,
  type ComponentSetting,
} from '@/api/control'
import { useUiStore } from '@/store/ui'
import {
  RESUME_DONE_NOTIFICATION_KEY,
  browserNotificationsSupported,
  requestBrowserNotificationPermission,
  settingEnabled,
} from '@/utils/notifications'
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

function parseRequiredInteger(raw: string, label: string, min = 1, max?: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    const range = max === undefined ? `${min} or greater` : `between ${min} and ${max}`
    throw new Error(`${label} must be a whole number ${range}.`)
  }
  return value
}

function settingListValue(
  settings: ComponentSetting[] | undefined,
  key: string,
  defaults: string[],
): string {
  const raw = getSettingValue(settings, key)
  if (!raw) return listToText(defaults)
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return listToText(parsed.map(String).filter(Boolean))
  } catch {
    // Older/manual settings may be newline or comma separated.
  }
  return listToText(
    raw
      .replace(/,/g, '\n')
      .split('\n')
      .map((s: string) => s.trim())
      .filter(Boolean),
  )
}

type FeedbackTone = 'pending' | 'success' | 'error'

interface SaveFeedback {
  tone: FeedbackTone
  message: string
}

function FormStatus({
  pending,
  error,
  success,
}: {
  pending: boolean
  error: unknown
  success: string
}) {
  const feedback: SaveFeedback | null = pending
    ? { tone: 'pending', message: 'Saving changes...' }
    : error
      ? {
          tone: 'error',
          message:
            error instanceof Error ? `Save failed: ${error.message}` : 'Save failed. Try again.',
        }
      : success
        ? { tone: 'success', message: success }
        : null

  if (!feedback) return null

  return (
    <span
      className={`${styles.formStatus} ${styles[`formStatus${feedback.tone.charAt(0).toUpperCase()}${feedback.tone.slice(1)}`]}`}
      role={feedback.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {feedback.message}
    </span>
  )
}

function SettingsLoadingState({ label }: { label: string }) {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite" aria-busy="true">
      <span className={styles.loadingLine} />
      <span>{label}</span>
    </div>
  )
}

function SettingsErrorState({
  title,
  description,
  onRetry,
}: {
  title: string
  description: string
  onRetry: () => void
}) {
  return (
    <div className={styles.errorState} role="alert">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button className={styles.btn} type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
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
  const [companyBlocklist, setCompanyBlocklist] = useState(() =>
    listToText(cfg.company_blocklist ?? []),
  )
  const [blacklist, setBlacklist] = useState(() => listToText(cfg.title_blacklist))

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h3 className={styles.panelTitle}>Discovery filters</h3>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          Priority companies (one per line)
          <span className={styles.fieldHint}>
            Jobs from these companies get priority=1 and trigger a Discord alert on scrape.
          </span>
          <textarea
            className={styles.textarea}
            value={watchlist}
            onChange={(e) => setWatchlist(e.target.value)}
            rows={8}
          />
        </label>
        <label className={styles.field}>
          Blocked companies (one per line)
          <span className={styles.fieldHint}>
            Exact normalized matches are discarded after scraping and never written to the database.
          </span>
          <textarea
            className={styles.textarea}
            value={companyBlocklist}
            onChange={(e) => setCompanyBlocklist(e.target.value)}
            rows={8}
          />
        </label>
      </div>
      <label className={styles.field}>
        Blocked title phrases (one per line)
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
              company_blocklist: textToList(companyBlocklist),
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
  const laneNames = Array.from(
    new Set(['engineering', 'data', ...Object.keys(cfg.target_job_titles)]),
  )
  const [lanes, setLanes] = useState<Record<string, string>>(() =>
    Object.fromEntries(laneNames.map((k) => [k, listToText(cfg.target_job_titles[k] ?? [])])),
  )
  const [experienceLevels, setExperienceLevels] = useState(() => new Set(cfg.experience_levels))
  const [locations, setLocations] = useState(() => listToText(cfg.locations))
  const [linkedinOn, setLinkedinOn] = useState(() => cfg.sites.includes('linkedin'))
  const [indeedOn, setIndeedOn] = useState(() => cfg.sites.includes('indeed'))

  function updateLane(name: string, val: string) {
    setLanes((prev) => ({ ...prev, [name]: val }))
  }

  function toggleExperienceLevel(level: string) {
    setExperienceLevels((previous) => {
      const next = new Set(previous)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h3 className={styles.panelTitle}>Search targeting</h3>
          <p className={styles.panelDescription}>
            Define the role titles and career levels Hunt should require when matching jobs.
          </p>
        </div>
      </div>
      <div className={styles.lanesGrid}>
        {laneNames.map((name) => (
          <label key={name} className={styles.field}>
            {name.charAt(0).toUpperCase() + name.slice(1)} lane — Target job titles
            <span className={styles.fieldHint}>One role title per line.</span>
            <textarea
              className={styles.textarea}
              value={lanes[name] ?? ''}
              onChange={(e) => updateLane(name, e.target.value)}
            />
          </label>
        ))}
      </div>
      <fieldset className={styles.experienceFieldset}>
        <legend>Experience levels</legend>
        <p className={styles.fieldHint}>
          Hunt expands each selected level into the aliases shown below and deduplicates overlapping
          queries.
        </p>
        <div className={styles.experienceGrid}>
          {[
            ['internship', 'Internship', 'Intern, internship, co-op, and student searches'],
            [
              'junior',
              'Junior',
              'Junior, entry level, associate, Level 1, L1, and role I/1 variants, including Level One',
            ],
            ['new_grad', 'New graduate', 'New grad, graduate, and entry level'],
          ].map(([value, label, hint]) => (
            <label key={value} className={styles.experienceChoice}>
              <input
                type="checkbox"
                checked={experienceLevels.has(value)}
                onChange={() => toggleExperienceLevel(value)}
              />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className={styles.matchingNote}>
        A result must match both a configured role title and a selected experience level. If either
        list is empty, discovery will not return matches.
      </p>
      <label className={styles.field}>
        Locations (one per line)
        <textarea
          className={styles.textarea}
          value={locations}
          onChange={(e) => setLocations(e.target.value)}
          rows={4}
        />
      </label>
      <fieldset className={styles.experienceFieldset}>
        <legend>Job boards</legend>
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
      </fieldset>
      <div className={styles.footer}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={() => {
            const sites: string[] = []
            if (linkedinOn) sites.push('linkedin')
            if (indeedOn) sites.push('indeed')
            onSave({
              target_job_titles: Object.fromEntries(
                Object.entries(lanes).map(([k, v]) => [k, textToList(v)]),
              ),
              experience_levels: ['internship', 'junior', 'new_grad'].filter((level) =>
                experienceLevels.has(level),
              ),
              locations: textToList(locations),
              sites,
            })
          }}
        >
          {saving ? 'Saving…' : 'Save targeting'}
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
  const [linkedinMaxWorkers, setLinkedinMaxWorkers] = useState(
    String(cfg.linkedin_discovery_max_workers ?? 1),
  )
  const [linkedinQueriesPerRun, setLinkedinQueriesPerRun] = useState(
    String(cfg.linkedin_queries_per_run ?? 4),
  )
  const [linkedinResultsWanted, setLinkedinResultsWanted] = useState(
    String(cfg.linkedin_results_wanted ?? 25),
  )
  const [linkedinFetchDescription, setLinkedinFetchDescription] = useState(
    cfg.linkedin_fetch_description ?? false,
  )
  const [linkedinCooldownMin, setLinkedinCooldownMin] = useState(
    String(cfg.linkedin_discovery_cooldown_minutes),
  )
  const [enrichAfterScrape, setEnrichAfterScrape] = useState(cfg.enrich_after_scrape)
  const [batchLimit, setBatchLimit] = useState(String(cfg.enrichment_batch_limit))
  const [timeoutMs, setTimeoutMs] = useState(String(cfg.enrichment_timeout_ms))
  const [maxAttempts, setMaxAttempts] = useState(String(cfg.enrichment_max_attempts))
  const [validationError, setValidationError] = useState<string | null>(null)

  function handleSave() {
    try {
      const updates: C1ConfigUpdates = {
        run_interval_seconds: parseRequiredInteger(intervalSec, 'Run interval', 60),
        results_wanted: parseRequiredInteger(resultsWanted, 'Indeed results per search'),
        hours_old: parseRequiredInteger(hoursOld, 'Hours-old lookback'),
        max_workers: parseRequiredInteger(maxWorkers, 'Non-LinkedIn parallel workers'),
        linkedin_discovery_max_workers: parseRequiredInteger(
          linkedinMaxWorkers,
          'LinkedIn parallel workers',
          1,
          2,
        ),
        linkedin_queries_per_run: parseRequiredInteger(
          linkedinQueriesPerRun,
          'LinkedIn searches per cycle',
          1,
          20,
        ),
        linkedin_results_wanted: parseRequiredInteger(
          linkedinResultsWanted,
          'LinkedIn results per search',
          1,
          50,
        ),
        linkedin_fetch_description: linkedinFetchDescription,
        linkedin_discovery_cooldown_minutes: parseRequiredInteger(
          linkedinCooldownMin,
          'LinkedIn rate-limit cooldown',
        ),
        enrich_after_scrape: enrichAfterScrape,
        enrichment_batch_limit: parseRequiredInteger(batchLimit, 'Enrichment batch limit'),
        enrichment_timeout_ms: parseRequiredInteger(timeoutMs, 'Enrichment timeout', 5000),
        enrichment_max_attempts: parseRequiredInteger(maxAttempts, 'Max enrichment attempts'),
      }
      setValidationError(null)
      onSave(updates)
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Enter valid run settings.')
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h3 className={styles.panelTitle}>Run settings</h3>
          <p className={styles.panelDescription}>
            Keep routine sources fast while tightly bounding LinkedIn discovery traffic.
          </p>
        </div>
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
          Indeed results per search
          <span className={styles.fieldHint}>
            Maximum listings to fetch from each non-LinkedIn search (default 500).
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
          Non-LinkedIn parallel workers
          <span className={styles.fieldHint}>
            Concurrent workers for other sources (default 10).
          </span>
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
      <fieldset className={styles.experienceFieldset}>
        <legend>LinkedIn discovery limits</legend>
        <p className={styles.matchingNote}>
          With the defaults, Hunt rotates through four LinkedIn searches per cycle, runs them one at
          a time, caps each at 25 results, and leaves descriptions for the enrichment stage.
        </p>
        <div className={styles.gridTwo}>
          <label className={styles.field}>
            LinkedIn searches per cycle
            <span className={styles.fieldHint}>
              Remaining targeting queries rotate into later cycles (default 4).
            </span>
            <input
              type="number"
              className={styles.input}
              value={linkedinQueriesPerRun}
              onChange={(e) => setLinkedinQueriesPerRun(e.target.value)}
              min={1}
              max={20}
            />
          </label>
          <label className={styles.field}>
            LinkedIn results per search
            <span className={styles.fieldHint}>
              A lower cap reduces pagination and downstream requests (default 25).
            </span>
            <input
              type="number"
              className={styles.input}
              value={linkedinResultsWanted}
              onChange={(e) => setLinkedinResultsWanted(e.target.value)}
              min={1}
              max={50}
            />
          </label>
          <label className={styles.field}>
            LinkedIn parallel workers
            <span className={styles.fieldHint}>
              Keep this at one to avoid concurrent request bursts (maximum 2).
            </span>
            <input
              type="number"
              className={styles.input}
              value={linkedinMaxWorkers}
              onChange={(e) => setLinkedinMaxWorkers(e.target.value)}
              min={1}
              max={2}
            />
          </label>
          <label className={styles.field}>
            LinkedIn rate-limit cooldown (minutes)
            <span className={styles.fieldHint}>
              After the first LinkedIn 429, stop queued searches and pause future cycles.
            </span>
            <input
              type="number"
              className={styles.input}
              value={linkedinCooldownMin}
              onChange={(e) => setLinkedinCooldownMin(e.target.value)}
              min={1}
            />
          </label>
        </div>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={linkedinFetchDescription}
            onChange={(e) => setLinkedinFetchDescription(e.target.checked)}
          />
          <span>
            Fetch descriptions during LinkedIn discovery
            <span className={styles.fieldHint}>
              Leave off. It adds one LinkedIn request per listing; enrichment can fetch details
              later.
            </span>
          </span>
        </label>
      </fieldset>
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
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save run settings'}
        </button>
        {validationError && (
          <span className={`${styles.formStatus} ${styles.formStatusError}`} role="alert">
            Run settings were not saved: {validationError}
          </span>
        )}
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
        <h3 className={styles.panelTitle}>Alert thresholds</h3>
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

function getSettingValue(settings: ComponentSetting[] | undefined, key: string): string | null {
  return settings?.find((s) => s.key === key)?.value ?? null
}

function getSetting(
  settings: ComponentSetting[] | undefined,
  key: string,
): ComponentSetting | null {
  return settings?.find((s) => s.key === key) ?? null
}

function AppNotificationSettings() {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const supported = browserNotificationsSupported()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['component-settings', 'c2'],
    queryFn: () => fetchSettings('c2'),
    staleTime: 30_000,
  })

  const enabled = settingEnabled(getSettingValue(data?.settings, RESUME_DONE_NOTIFICATION_KEY))
  const permission = supported ? Notification.permission : 'denied'

  const mutation = useMutation({
    mutationFn: saveSetting,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['component-settings', 'c2'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Save failed', 'error'),
  })

  async function toggle(next: boolean) {
    if (next) {
      const nextPermission = await requestBrowserNotificationPermission()
      if (nextPermission !== 'granted') {
        showToast('Windows notification permission was not granted', 'error')
        return
      }
    }
    mutation.mutate(
      {
        component: 'c2',
        key: RESUME_DONE_NOTIFICATION_KEY,
        value: String(next),
        value_type: 'boolean',
        secret: false,
      },
      {
        onSuccess: () =>
          showToast(next ? 'Resume notifications enabled' : 'Resume notifications disabled'),
      },
    )
  }

  if (isLoading) return <SettingsLoadingState label="Loading notification settings..." />
  if (isError || !data) {
    return (
      <SettingsErrorState
        title="Notification settings are unavailable."
        description="Check the C0 settings API, then try loading this preference again."
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h3 className={styles.panelTitle}>App notifications</h3>
      </div>
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!supported || mutation.isPending}
          onChange={(e) => toggle(e.target.checked)}
        />
        Windows notification when Fletcher finishes a resume
      </label>
      <p className={styles.fieldHint}>
        {supported
          ? `Browser permission: ${permission}. Notifications fire when this Hunt tab receives the completed generation response.`
          : 'This browser does not support desktop notifications.'}
      </p>
      <FormStatus
        pending={mutation.isPending}
        error={mutation.error}
        success={mutation.isSuccess ? 'Notification preference saved.' : ''}
      />
    </div>
  )
}

const C2_LLM_PROVIDER_KEY = 'llm_provider'
const C2_LLM_MODEL_KEY = 'llm_model'
const C2_LLM_TIMEOUT_SEC_KEY = 'llm_timeout_sec'
const C2_CLOUD_CONFIRM_KEY = 'cloud_llm_confirm'
const C2_OLLAMA_HOST_KEY = 'ollama_host'
const C2_OLLAMA_MODEL_KEY = 'ollama_model'
const C2_OLLAMA_TIMEOUT_SEC_KEY = 'ollama_timeout_sec'
const C2_OLLAMA_KEEP_ALIVE_KEY = 'ollama_keep_alive'
const C2_BULLET_REWRITE_PARALLELISM_KEY = 'bullet_rewrite_parallelism'
const C2_BULLET_REWRITE_MIN_AVAILABLE_MB_KEY = 'bullet_rewrite_min_available_mb'
const C2_BULLET_REWRITE_MAX_MEMORY_PCT_KEY = 'bullet_rewrite_max_memory_pct'
const C2_OPENAI_API_KEY = 'openai_api_key'
const C2_OPENROUTER_API_KEY = 'openrouter_api_key'
const C2_ANTHROPIC_API_KEY = 'anthropic_api_key'
const C2_GEMINI_API_KEY = 'gemini_api_key'

function C2ProviderRuntimeSettings() {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['component-settings', 'c2', 'runtime'],
    queryFn: () => fetchSettings('c2'),
    staleTime: 30_000,
  })

  const [provider, setProvider] = useState('ollama')
  const [model, setModel] = useState('')
  const [timeoutSec, setTimeoutSec] = useState('300')
  const [cloudConfirm, setCloudConfirm] = useState(false)
  const [ollamaHost, setOllamaHost] = useState('http://127.0.0.1:11434')
  const [ollamaModel, setOllamaModel] = useState('gemma4:e4b')
  const [ollamaTimeoutSec, setOllamaTimeoutSec] = useState('300')
  const [ollamaKeepAlive, setOllamaKeepAlive] = useState('-1')
  const [rewriteParallelism, setRewriteParallelism] = useState('5')
  const [rewriteMinAvailableMb, setRewriteMinAvailableMb] = useState('4096')
  const [rewriteMaxMemoryPct, setRewriteMaxMemoryPct] = useState('85')
  const [openaiKey, setOpenaiKey] = useState('')
  const [openrouterKey, setOpenrouterKey] = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [geminiKey, setGeminiKey] = useState('')

  const settings = data?.settings
  const openaiStored = Boolean(getSetting(settings, C2_OPENAI_API_KEY)?.has_value)
  const openrouterStored = Boolean(getSetting(settings, C2_OPENROUTER_API_KEY)?.has_value)
  const anthropicStored = Boolean(getSetting(settings, C2_ANTHROPIC_API_KEY)?.has_value)
  const geminiStored = Boolean(getSetting(settings, C2_GEMINI_API_KEY)?.has_value)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProvider(getSettingValue(settings, C2_LLM_PROVIDER_KEY) ?? 'ollama')
    setModel(getSettingValue(settings, C2_LLM_MODEL_KEY) ?? '')
    setTimeoutSec(getSettingValue(settings, C2_LLM_TIMEOUT_SEC_KEY) ?? '300')
    setCloudConfirm(settingEnabled(getSettingValue(settings, C2_CLOUD_CONFIRM_KEY)))
    setOllamaHost(getSettingValue(settings, C2_OLLAMA_HOST_KEY) ?? 'http://127.0.0.1:11434')
    setOllamaModel(getSettingValue(settings, C2_OLLAMA_MODEL_KEY) ?? 'gemma4:e4b')
    setOllamaTimeoutSec(getSettingValue(settings, C2_OLLAMA_TIMEOUT_SEC_KEY) ?? '300')
    setOllamaKeepAlive(getSettingValue(settings, C2_OLLAMA_KEEP_ALIVE_KEY) ?? '-1')
    setRewriteParallelism(getSettingValue(settings, C2_BULLET_REWRITE_PARALLELISM_KEY) ?? '5')
    setRewriteMinAvailableMb(
      getSettingValue(settings, C2_BULLET_REWRITE_MIN_AVAILABLE_MB_KEY) ?? '4096',
    )
    setRewriteMaxMemoryPct(getSettingValue(settings, C2_BULLET_REWRITE_MAX_MEMORY_PCT_KEY) ?? '85')
  }, [settings])

  const mutation = useMutation({
    mutationFn: async () => {
      const textSettings = [
        [C2_LLM_PROVIDER_KEY, provider],
        [C2_LLM_MODEL_KEY, model],
        [C2_LLM_TIMEOUT_SEC_KEY, timeoutSec],
        [C2_OLLAMA_HOST_KEY, ollamaHost],
        [C2_OLLAMA_MODEL_KEY, ollamaModel],
        [C2_OLLAMA_TIMEOUT_SEC_KEY, ollamaTimeoutSec],
        [C2_OLLAMA_KEEP_ALIVE_KEY, ollamaKeepAlive],
        [C2_BULLET_REWRITE_PARALLELISM_KEY, rewriteParallelism],
        [C2_BULLET_REWRITE_MIN_AVAILABLE_MB_KEY, rewriteMinAvailableMb],
        [C2_BULLET_REWRITE_MAX_MEMORY_PCT_KEY, rewriteMaxMemoryPct],
      ] as const
      for (const [key, value] of textSettings) {
        await saveSetting({ component: 'c2', key, value, value_type: 'text', secret: false })
      }
      await saveSetting({
        component: 'c2',
        key: C2_CLOUD_CONFIRM_KEY,
        value: String(cloudConfirm),
        value_type: 'boolean',
        secret: false,
      })
      const secretSettings = [
        [C2_OPENAI_API_KEY, openaiKey],
        [C2_OPENROUTER_API_KEY, openrouterKey],
        [C2_ANTHROPIC_API_KEY, anthropicKey],
        [C2_GEMINI_API_KEY, geminiKey],
      ] as const
      for (const [key, value] of secretSettings) {
        if (!value.trim()) continue
        await saveSetting({ component: 'c2', key, value, value_type: 'text', secret: true })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['component-settings', 'c2'] })
      qc.invalidateQueries({ queryKey: ['component-settings', 'c2', 'runtime'] })
      setOpenaiKey('')
      setOpenrouterKey('')
      setAnthropicKey('')
      setGeminiKey('')
      showToast('Saved C2 provider and runtime settings')
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Save failed', 'error'),
  })

  if (isLoading) return <SettingsLoadingState label="Loading provider and runtime settings..." />
  if (isError || !data) {
    return (
      <SettingsErrorState
        title="Provider settings are unavailable."
        description="Check the C0 settings API, then try loading Fletcher runtime values again."
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h3 className={styles.panelTitle}>C2 provider and runtime</h3>
        <span className={styles.panelMeta}>Secrets are stored redacted</span>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          LLM provider
          <select
            className={styles.input}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="heuristic">heuristic</option>
            <option value="ollama">ollama</option>
            <option value="codex">codex oauth</option>
            <option value="openai">openai</option>
            <option value="openrouter">openrouter</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
          </select>
        </label>
        <label className={styles.field}>
          Provider model override
          <input
            className={styles.input}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Generic LLM timeout seconds
          <input
            type="number"
            className={styles.input}
            value={timeoutSec}
            min={1}
            onChange={(e) => setTimeoutSec(e.target.value)}
          />
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={cloudConfirm}
            onChange={(e) => setCloudConfirm(e.target.checked)}
          />
          Allow cloud LLM providers to receive resume and job description text
        </label>
      </div>
      <div className={styles.notice}>
        Cloud providers stay blocked until this confirmation is enabled. API keys are write-only:
        saved keys show as present, never as readable text.
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          OpenAI API key {openaiStored ? '(saved)' : ''}
          <input
            className={styles.input}
            type="password"
            value={openaiKey}
            onChange={(e) => setOpenaiKey(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          OpenRouter API key {openrouterStored ? '(saved)' : ''}
          <input
            className={styles.input}
            type="password"
            value={openrouterKey}
            onChange={(e) => setOpenrouterKey(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Anthropic API key {anthropicStored ? '(saved)' : ''}
          <input
            className={styles.input}
            type="password"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Gemini API key {geminiStored ? '(saved)' : ''}
          <input
            className={styles.input}
            type="password"
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
          />
        </label>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          Ollama host
          <input
            className={styles.input}
            value={ollamaHost}
            onChange={(e) => setOllamaHost(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Ollama model
          <input
            className={styles.input}
            value={ollamaModel}
            onChange={(e) => setOllamaModel(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Ollama timeout seconds
          <input
            type="number"
            className={styles.input}
            value={ollamaTimeoutSec}
            min={1}
            onChange={(e) => setOllamaTimeoutSec(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Ollama keep alive
          <input
            className={styles.input}
            value={ollamaKeepAlive}
            onChange={(e) => setOllamaKeepAlive(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Bullet rewrite parallelism
          <input
            type="number"
            className={styles.input}
            value={rewriteParallelism}
            min={1}
            onChange={(e) => setRewriteParallelism(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Rewrite minimum available memory MB
          <input
            type="number"
            className={styles.input}
            value={rewriteMinAvailableMb}
            min={0}
            onChange={(e) => setRewriteMinAvailableMb(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Rewrite max memory percent
          <input
            type="number"
            className={styles.input}
            value={rewriteMaxMemoryPct}
            min={1}
            max={100}
            onChange={(e) => setRewriteMaxMemoryPct(e.target.value)}
          />
        </label>
      </div>
      <div className={styles.footer}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Saving...' : 'Save provider settings'}
        </button>
        <FormStatus
          pending={mutation.isPending}
          error={mutation.error}
          success={mutation.isSuccess ? 'Provider and runtime settings saved.' : ''}
        />
      </div>
    </div>
  )
}

const JOB_METADATA_ROLE_FAMILIES_KEY = 'job_metadata_role_families'
const JOB_METADATA_JOB_LEVELS_KEY = 'job_metadata_job_levels'
const C2_TARGET_LANE_POLICY_KEY = 'target_lane_policy'
const C2_UNSUPPORTED_TARGET_EXAMPLES_KEY = 'unsupported_target_examples'
const C2_BLOCKED_KEYWORDS_KEY = 'blocked_keywords'
const C2_KEYWORD_KEEP_POLICY_KEY = 'keyword_keep_policy'
const C2_KEYWORD_IGNORE_POLICY_KEY = 'keyword_ignore_policy'
const C2_SUMMARY_KEYWORD_POLICY_KEY = 'summary_keyword_policy'
const C2_SKILL_ADDITION_POLICY_KEY = 'skill_addition_policy'
const C2_SUMMARY_GOOD_EXAMPLE_KEY = 'summary_good_example'
const C2_SUMMARY_BANNED_PHRASES_KEY = 'summary_banned_phrases'
const C2_REWRITE_STRATEGY_KEY = 'rewrite_strategy'
const C2_REWRITE_KEYWORD_FIT_POLICY_KEY = 'rewrite_keyword_fit_policy'
const C2_REWRITE_BULLET_POLICY_KEY = 'rewrite_bullet_policy'
const C2_REWRITE_LENGTH_POLICY_KEY = 'rewrite_length_policy'
const C2_REWRITE_ACTION_KEYWORD_POLICY_KEY = 'rewrite_action_keyword_policy'
const C2_DEFAULT_TARGET_TITLE_KEY = 'default_target_title'
const C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY = 'keyword_selection_max_keywords'
const C2_KEYWORD_SELECTION_MIN_WORDS_KEY = 'keyword_selection_min_words'
const C2_KEYWORD_SELECTION_MAX_WORDS_KEY = 'keyword_selection_max_words'
const C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY = 'job_metadata_prompt_max_chars'
const C2_JOB_METADATA_MIN_CONFIDENCE_KEY = 'job_metadata_min_confidence'
const C2_SKILL_ADDITION_LIMIT_KEY = 'skill_addition_limit'
const DEFAULT_JOB_METADATA_ROLE_FAMILIES = [
  'software',
  'data',
  'pm',
  'infrastructure',
  'firmware',
  'general',
  'unknown',
]
const DEFAULT_JOB_METADATA_JOB_LEVELS = [
  'intern',
  'new_grad',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'manager',
  'director',
  'executive',
  'unknown',
]
const C2_TARGET_LANE_POLICY =
  'Continue for jobs that match the configured resume/search lane. Reject only when the posting is clearly outside that lane.'
const C2_UNSUPPORTED_TARGET_EXAMPLES = [
  'non-computer civil engineering',
  'non-computer mechanical engineering',
  'non-computer chemical or process engineering',
  'municipal infrastructure',
  'CAD drafting',
]
const C2_BLOCKED_KEYWORDS = [
  'android studio',
  'xcode',
  'vs code',
  'vscode',
  'visual studio code',
  'visual studio',
  'intellij',
  'intellij idea',
  'pycharm',
  'webstorm',
  'phpstorm',
  'rubymine',
  'clion',
  'rider',
  'eclipse',
  'netbeans',
  'sublime text',
  'atom',
  'vim',
  'neovim',
  'emacs',
]
const C2_KEYWORD_KEEP_POLICY =
  'Keep role-relevant resume bullet keywords from the job description, including concrete skills, tools, methods, platforms, domain-relevant work traits, and short capability phrases.'
const C2_KEYWORD_IGNORE_POLICY =
  'Ignore job titles, role labels, seniority, employment type, company names, locations, compensation, hiring logistics, full sentences, vague nouns, and blocked keywords.'
const C2_SUMMARY_KEYWORD_POLICY =
  'Pick only exact candidate keywords that improve resume-level positioning for this job. Skip job titles, degrees, majors, role labels, awkward domain claims, and pure stuffing.'
const C2_SKILL_ADDITION_POLICY =
  'Good additions are concrete skills that fit one existing resume skill category, such as tools, methods, platforms, libraries, databases, operating systems, protocols, or short capability phrases. Ignore job titles, qualities, responsibilities, degrees, majors, disciplines, logistics, business-domain phrases, vague concepts, and blocked keywords.'
const C2_SUMMARY_GOOD_EXAMPLE =
  'Candidate with delivery experience across production systems, automation, and cross-functional feedback loops.'
const C2_SUMMARY_BANNED_PHRASES = [
  'motivated',
  'eager',
  'passionate',
  'aspiring',
  'seeking to apply',
  'excited to',
  'looking to',
  'hoping to',
]
const C2_REWRITE_STRATEGY =
  'Try these strategies in order. Stop after the first strategy that produces a coherent, natural rewrite:\nFirst strategy: REPLACE. If a keyword names the same type of technology, method, or concept as something already in the bullet, replace or substitute naturally.\nSecond strategy: REWORD. If replacement does not work, reword or restructure the bullet so the original work and the keyword appear together naturally. The keyword must fit the actual work described by the original bullet.\nThird strategy: ADD SENTENCE. If one or more keywords still fit but cannot be included by replacement or rewording, add at most one new sentence anywhere in the bullet. The new sentence must be directly about the original work. Pack multiple remaining keywords into that one sentence only if they fit naturally.\nFinal strategy: STOP. Any remaining keywords that do not fit cleanly go in keywords_skipped. Do not force them.'
const C2_REWRITE_KEYWORD_FIT_POLICY =
  '- Judge each requested keyword independently. A bullet can support some keywords and reject or skip others.\n- Accept same-work adjacent framing: same work context, same outcome, and coherent technology, method, or workflow family.\n- The keyword does not need to appear explicitly in the original when it still describes the same kind of work.\n- Reject or skip keywords that change the project, domain, outcome, scope, responsibility, or tool/workflow use.\n- Prefer additive related phrasing only when coherent; avoid unnatural slash pairs or false pairings.\n- Reject or skip incoherent term pairings, unrelated technology claims, definitions of technologies, and keyword-stuffing appendages.'
const C2_REWRITE_BULLET_POLICY =
  '- Preserve original facts, metrics, numbers, scope, outcomes, and core meaning.\n- Preserve the original order and Google XYZ-style structure when possible: outcome or metric first, then action, method, tool, or scope.\n- Use at most one new sentence, and only when it is directly about the original work.\n- Prefer natural replacement or rewording before adding text.\n- Skip a keyword when the final bullet would be awkward, vague, less believable, or forced.'
const C2_REWRITE_LENGTH_POLICY =
  '- Keep the rewrite close to the original length, never more than {max_length_percent} percent longer unless needed for grammar.'
const C2_REWRITE_ACTION_KEYWORD_POLICY =
  "- Keep an action keyword's action and object visibly together.\n- Monitor keywords may become monitoring plus the same object when that fits the bullet.\n- Automate keywords may become automating or automation plus the same object when that fits the bullet.\n- Do not count scattered words as using an action keyword."
const C2_DEFAULT_TARGET_TITLE = 'Target Role'
const C2_KEYWORD_SELECTION_MAX_KEYWORDS = '30'
const C2_KEYWORD_SELECTION_MIN_WORDS = '1'
const C2_KEYWORD_SELECTION_MAX_WORDS = '3'
const C2_JOB_METADATA_PROMPT_MAX_CHARS = '3000'
const C2_JOB_METADATA_MIN_CONFIDENCE = '0.8'
const C2_SKILL_ADDITION_LIMIT = '3'
const C2_OPTION_A_MIN_EXPERIENCE_KEY = 'option_a_min_experience'
const C2_OPTION_A_MAX_EXPERIENCE_KEY = 'option_a_max_experience'
const C2_OPTION_A_MIN_PROJECTS_KEY = 'option_a_min_projects'
const C2_OPTION_A_MAX_PROJECTS_KEY = 'option_a_max_projects'
const C2_OPTION_A_MAX_EXPERIENCE_BULLETS_KEY = 'option_a_max_experience_bullets'
const C2_OPTION_A_MAX_PROJECT_BULLETS_KEY = 'option_a_max_project_bullets'
const C2_OPTION_A_EXPERIENCE_POSITION_BONUS_KEY = 'option_a_experience_position_bonus'
const C2_OPTION_A_PROJECT_POSITION_BONUS_KEY = 'option_a_project_position_bonus'
const C2_OPTION_A_BULLET_POSITION_BONUS_KEY = 'option_a_bullet_position_bonus'
const C2_OPTION_A_MIN_EXPERIENCE = '2'
const C2_OPTION_A_MAX_EXPERIENCE = '4'
const C2_OPTION_A_MIN_PROJECTS = '1'
const C2_OPTION_A_MAX_PROJECTS = '3'
const C2_OPTION_A_MAX_EXPERIENCE_BULLETS = '6'
const C2_OPTION_A_MAX_PROJECT_BULLETS = '4'
const C2_OPTION_A_EXPERIENCE_POSITION_BONUS = '0.12'
const C2_OPTION_A_PROJECT_POSITION_BONUS = '0.08'
const C2_OPTION_A_BULLET_POSITION_BONUS = '0.08'

function JobMetadataSettings() {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['component-settings', 'c2', 'job-metadata'],
    queryFn: () => fetchSettings('c2'),
    staleTime: 30_000,
  })
  const [roleFamilies, setRoleFamilies] = useState('')
  const [jobLevels, setJobLevels] = useState('')
  const [targetLanePolicy, setTargetLanePolicy] = useState('')
  const [unsupportedExamples, setUnsupportedExamples] = useState('')
  const [blockedKeywords, setBlockedKeywords] = useState('')
  const [keywordKeepPolicy, setKeywordKeepPolicy] = useState('')
  const [keywordIgnorePolicy, setKeywordIgnorePolicy] = useState('')
  const [summaryKeywordPolicy, setSummaryKeywordPolicy] = useState('')
  const [skillAdditionPolicy, setSkillAdditionPolicy] = useState('')
  const [summaryGoodExample, setSummaryGoodExample] = useState('')
  const [summaryBannedPhrases, setSummaryBannedPhrases] = useState('')
  const [rewriteStrategy, setRewriteStrategy] = useState('')
  const [rewriteKeywordFitPolicy, setRewriteKeywordFitPolicy] = useState('')
  const [rewriteBulletPolicy, setRewriteBulletPolicy] = useState('')
  const [rewriteLengthPolicy, setRewriteLengthPolicy] = useState('')
  const [rewriteActionKeywordPolicy, setRewriteActionKeywordPolicy] = useState('')
  const [defaultTargetTitle, setDefaultTargetTitle] = useState('')
  const [keywordSelectionMaxKeywords, setKeywordSelectionMaxKeywords] = useState('')
  const [keywordSelectionMinWords, setKeywordSelectionMinWords] = useState('')
  const [keywordSelectionMaxWords, setKeywordSelectionMaxWords] = useState('')
  const [jobMetadataPromptMaxChars, setJobMetadataPromptMaxChars] = useState('')
  const [jobMetadataMinConfidence, setJobMetadataMinConfidence] = useState('')
  const [skillAdditionLimit, setSkillAdditionLimit] = useState('')
  const [optionAMinExperience, setOptionAMinExperience] = useState('')
  const [optionAMaxExperience, setOptionAMaxExperience] = useState('')
  const [optionAMinProjects, setOptionAMinProjects] = useState('')
  const [optionAMaxProjects, setOptionAMaxProjects] = useState('')
  const [optionAMaxExperienceBullets, setOptionAMaxExperienceBullets] = useState('')
  const [optionAMaxProjectBullets, setOptionAMaxProjectBullets] = useState('')
  const [optionAExperiencePositionBonus, setOptionAExperiencePositionBonus] = useState('')
  const [optionAProjectPositionBonus, setOptionAProjectPositionBonus] = useState('')
  const [optionABulletPositionBonus, setOptionABulletPositionBonus] = useState('')

  const roleFamilyText = settingListValue(
    data?.settings,
    JOB_METADATA_ROLE_FAMILIES_KEY,
    DEFAULT_JOB_METADATA_ROLE_FAMILIES,
  )
  const jobLevelText = settingListValue(
    data?.settings,
    JOB_METADATA_JOB_LEVELS_KEY,
    DEFAULT_JOB_METADATA_JOB_LEVELS,
  )
  const targetLanePolicyText =
    getSettingValue(data?.settings, C2_TARGET_LANE_POLICY_KEY) ?? C2_TARGET_LANE_POLICY
  const unsupportedExamplesText = settingListValue(
    data?.settings,
    C2_UNSUPPORTED_TARGET_EXAMPLES_KEY,
    C2_UNSUPPORTED_TARGET_EXAMPLES,
  )
  const blockedKeywordText = settingListValue(
    data?.settings,
    C2_BLOCKED_KEYWORDS_KEY,
    C2_BLOCKED_KEYWORDS,
  )
  const keywordKeepPolicyText =
    getSettingValue(data?.settings, C2_KEYWORD_KEEP_POLICY_KEY) ?? C2_KEYWORD_KEEP_POLICY
  const keywordIgnorePolicyText =
    getSettingValue(data?.settings, C2_KEYWORD_IGNORE_POLICY_KEY) ?? C2_KEYWORD_IGNORE_POLICY
  const summaryKeywordPolicyText =
    getSettingValue(data?.settings, C2_SUMMARY_KEYWORD_POLICY_KEY) ?? C2_SUMMARY_KEYWORD_POLICY
  const skillAdditionPolicyText =
    getSettingValue(data?.settings, C2_SKILL_ADDITION_POLICY_KEY) ?? C2_SKILL_ADDITION_POLICY
  const summaryGoodExampleText =
    getSettingValue(data?.settings, C2_SUMMARY_GOOD_EXAMPLE_KEY) ?? C2_SUMMARY_GOOD_EXAMPLE
  const summaryBannedPhraseText = settingListValue(
    data?.settings,
    C2_SUMMARY_BANNED_PHRASES_KEY,
    C2_SUMMARY_BANNED_PHRASES,
  )
  const rewriteStrategyText =
    getSettingValue(data?.settings, C2_REWRITE_STRATEGY_KEY) ?? C2_REWRITE_STRATEGY
  const rewriteKeywordFitPolicyText =
    getSettingValue(data?.settings, C2_REWRITE_KEYWORD_FIT_POLICY_KEY) ??
    C2_REWRITE_KEYWORD_FIT_POLICY
  const rewriteBulletPolicyText =
    getSettingValue(data?.settings, C2_REWRITE_BULLET_POLICY_KEY) ?? C2_REWRITE_BULLET_POLICY
  const rewriteLengthPolicyText =
    getSettingValue(data?.settings, C2_REWRITE_LENGTH_POLICY_KEY) ?? C2_REWRITE_LENGTH_POLICY
  const rewriteActionKeywordPolicyText =
    getSettingValue(data?.settings, C2_REWRITE_ACTION_KEYWORD_POLICY_KEY) ??
    C2_REWRITE_ACTION_KEYWORD_POLICY
  const defaultTargetTitleText =
    getSettingValue(data?.settings, C2_DEFAULT_TARGET_TITLE_KEY) ?? C2_DEFAULT_TARGET_TITLE
  const keywordSelectionMaxKeywordsText =
    getSettingValue(data?.settings, C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY) ??
    C2_KEYWORD_SELECTION_MAX_KEYWORDS
  const keywordSelectionMinWordsText =
    getSettingValue(data?.settings, C2_KEYWORD_SELECTION_MIN_WORDS_KEY) ??
    C2_KEYWORD_SELECTION_MIN_WORDS
  const keywordSelectionMaxWordsText =
    getSettingValue(data?.settings, C2_KEYWORD_SELECTION_MAX_WORDS_KEY) ??
    C2_KEYWORD_SELECTION_MAX_WORDS
  const jobMetadataPromptMaxCharsText =
    getSettingValue(data?.settings, C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY) ??
    C2_JOB_METADATA_PROMPT_MAX_CHARS
  const jobMetadataMinConfidenceText =
    getSettingValue(data?.settings, C2_JOB_METADATA_MIN_CONFIDENCE_KEY) ??
    C2_JOB_METADATA_MIN_CONFIDENCE
  const skillAdditionLimitText =
    getSettingValue(data?.settings, C2_SKILL_ADDITION_LIMIT_KEY) ?? C2_SKILL_ADDITION_LIMIT
  const optionAMinExperienceText =
    getSettingValue(data?.settings, C2_OPTION_A_MIN_EXPERIENCE_KEY) ?? C2_OPTION_A_MIN_EXPERIENCE
  const optionAMaxExperienceText =
    getSettingValue(data?.settings, C2_OPTION_A_MAX_EXPERIENCE_KEY) ?? C2_OPTION_A_MAX_EXPERIENCE
  const optionAMinProjectsText =
    getSettingValue(data?.settings, C2_OPTION_A_MIN_PROJECTS_KEY) ?? C2_OPTION_A_MIN_PROJECTS
  const optionAMaxProjectsText =
    getSettingValue(data?.settings, C2_OPTION_A_MAX_PROJECTS_KEY) ?? C2_OPTION_A_MAX_PROJECTS
  const optionAMaxExperienceBulletsText =
    getSettingValue(data?.settings, C2_OPTION_A_MAX_EXPERIENCE_BULLETS_KEY) ??
    C2_OPTION_A_MAX_EXPERIENCE_BULLETS
  const optionAMaxProjectBulletsText =
    getSettingValue(data?.settings, C2_OPTION_A_MAX_PROJECT_BULLETS_KEY) ??
    C2_OPTION_A_MAX_PROJECT_BULLETS
  const optionAExperiencePositionBonusText =
    getSettingValue(data?.settings, C2_OPTION_A_EXPERIENCE_POSITION_BONUS_KEY) ??
    C2_OPTION_A_EXPERIENCE_POSITION_BONUS
  const optionAProjectPositionBonusText =
    getSettingValue(data?.settings, C2_OPTION_A_PROJECT_POSITION_BONUS_KEY) ??
    C2_OPTION_A_PROJECT_POSITION_BONUS
  const optionABulletPositionBonusText =
    getSettingValue(data?.settings, C2_OPTION_A_BULLET_POSITION_BONUS_KEY) ??
    C2_OPTION_A_BULLET_POSITION_BONUS

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoleFamilies(roleFamilyText)
    setJobLevels(jobLevelText)
    setTargetLanePolicy(targetLanePolicyText)
    setUnsupportedExamples(unsupportedExamplesText)
    setBlockedKeywords(blockedKeywordText)
    setKeywordKeepPolicy(keywordKeepPolicyText)
    setKeywordIgnorePolicy(keywordIgnorePolicyText)
    setSummaryKeywordPolicy(summaryKeywordPolicyText)
    setSkillAdditionPolicy(skillAdditionPolicyText)
    setSummaryGoodExample(summaryGoodExampleText)
    setSummaryBannedPhrases(summaryBannedPhraseText)
    setRewriteStrategy(rewriteStrategyText)
    setRewriteKeywordFitPolicy(rewriteKeywordFitPolicyText)
    setRewriteBulletPolicy(rewriteBulletPolicyText)
    setRewriteLengthPolicy(rewriteLengthPolicyText)
    setRewriteActionKeywordPolicy(rewriteActionKeywordPolicyText)
    setDefaultTargetTitle(defaultTargetTitleText)
    setKeywordSelectionMaxKeywords(keywordSelectionMaxKeywordsText)
    setKeywordSelectionMinWords(keywordSelectionMinWordsText)
    setKeywordSelectionMaxWords(keywordSelectionMaxWordsText)
    setJobMetadataPromptMaxChars(jobMetadataPromptMaxCharsText)
    setJobMetadataMinConfidence(jobMetadataMinConfidenceText)
    setSkillAdditionLimit(skillAdditionLimitText)
    setOptionAMinExperience(optionAMinExperienceText)
    setOptionAMaxExperience(optionAMaxExperienceText)
    setOptionAMinProjects(optionAMinProjectsText)
    setOptionAMaxProjects(optionAMaxProjectsText)
    setOptionAMaxExperienceBullets(optionAMaxExperienceBulletsText)
    setOptionAMaxProjectBullets(optionAMaxProjectBulletsText)
    setOptionAExperiencePositionBonus(optionAExperiencePositionBonusText)
    setOptionAProjectPositionBonus(optionAProjectPositionBonusText)
    setOptionABulletPositionBonus(optionABulletPositionBonusText)
  }, [
    roleFamilyText,
    jobLevelText,
    targetLanePolicyText,
    unsupportedExamplesText,
    blockedKeywordText,
    keywordKeepPolicyText,
    keywordIgnorePolicyText,
    summaryKeywordPolicyText,
    skillAdditionPolicyText,
    summaryGoodExampleText,
    summaryBannedPhraseText,
    rewriteStrategyText,
    rewriteKeywordFitPolicyText,
    rewriteBulletPolicyText,
    rewriteLengthPolicyText,
    rewriteActionKeywordPolicyText,
    defaultTargetTitleText,
    keywordSelectionMaxKeywordsText,
    keywordSelectionMinWordsText,
    keywordSelectionMaxWordsText,
    jobMetadataPromptMaxCharsText,
    jobMetadataMinConfidenceText,
    skillAdditionLimitText,
    optionAMinExperienceText,
    optionAMaxExperienceText,
    optionAMinProjectsText,
    optionAMaxProjectsText,
    optionAMaxExperienceBulletsText,
    optionAMaxProjectBulletsText,
    optionAExperiencePositionBonusText,
    optionAProjectPositionBonusText,
    optionABulletPositionBonusText,
  ])

  const mutation = useMutation({
    mutationFn: async () => {
      await saveSetting({
        component: 'c2',
        key: JOB_METADATA_ROLE_FAMILIES_KEY,
        value: JSON.stringify(textToList(roleFamilies)),
        value_type: 'json',
        secret: false,
      })
      await saveSetting({
        component: 'c2',
        key: JOB_METADATA_JOB_LEVELS_KEY,
        value: JSON.stringify(textToList(jobLevels)),
        value_type: 'json',
        secret: false,
      })
      const textSettings = [
        [C2_TARGET_LANE_POLICY_KEY, targetLanePolicy],
        [C2_KEYWORD_KEEP_POLICY_KEY, keywordKeepPolicy],
        [C2_KEYWORD_IGNORE_POLICY_KEY, keywordIgnorePolicy],
        [C2_SUMMARY_KEYWORD_POLICY_KEY, summaryKeywordPolicy],
        [C2_SKILL_ADDITION_POLICY_KEY, skillAdditionPolicy],
        [C2_SUMMARY_GOOD_EXAMPLE_KEY, summaryGoodExample],
        [C2_REWRITE_STRATEGY_KEY, rewriteStrategy],
        [C2_REWRITE_KEYWORD_FIT_POLICY_KEY, rewriteKeywordFitPolicy],
        [C2_REWRITE_BULLET_POLICY_KEY, rewriteBulletPolicy],
        [C2_REWRITE_LENGTH_POLICY_KEY, rewriteLengthPolicy],
        [C2_REWRITE_ACTION_KEYWORD_POLICY_KEY, rewriteActionKeywordPolicy],
        [C2_DEFAULT_TARGET_TITLE_KEY, defaultTargetTitle],
        [C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY, keywordSelectionMaxKeywords],
        [C2_KEYWORD_SELECTION_MIN_WORDS_KEY, keywordSelectionMinWords],
        [C2_KEYWORD_SELECTION_MAX_WORDS_KEY, keywordSelectionMaxWords],
        [C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY, jobMetadataPromptMaxChars],
        [C2_JOB_METADATA_MIN_CONFIDENCE_KEY, jobMetadataMinConfidence],
        [C2_SKILL_ADDITION_LIMIT_KEY, skillAdditionLimit],
        [C2_OPTION_A_MIN_EXPERIENCE_KEY, optionAMinExperience],
        [C2_OPTION_A_MAX_EXPERIENCE_KEY, optionAMaxExperience],
        [C2_OPTION_A_MIN_PROJECTS_KEY, optionAMinProjects],
        [C2_OPTION_A_MAX_PROJECTS_KEY, optionAMaxProjects],
        [C2_OPTION_A_MAX_EXPERIENCE_BULLETS_KEY, optionAMaxExperienceBullets],
        [C2_OPTION_A_MAX_PROJECT_BULLETS_KEY, optionAMaxProjectBullets],
        [C2_OPTION_A_EXPERIENCE_POSITION_BONUS_KEY, optionAExperiencePositionBonus],
        [C2_OPTION_A_PROJECT_POSITION_BONUS_KEY, optionAProjectPositionBonus],
        [C2_OPTION_A_BULLET_POSITION_BONUS_KEY, optionABulletPositionBonus],
      ] as const
      for (const [key, value] of textSettings) {
        await saveSetting({
          component: 'c2',
          key,
          value,
          value_type: 'text',
          secret: false,
        })
      }
      const listSettings = [
        [C2_UNSUPPORTED_TARGET_EXAMPLES_KEY, unsupportedExamples],
        [C2_BLOCKED_KEYWORDS_KEY, blockedKeywords],
        [C2_SUMMARY_BANNED_PHRASES_KEY, summaryBannedPhrases],
      ] as const
      for (const [key, value] of listSettings) {
        await saveSetting({
          component: 'c2',
          key,
          value: JSON.stringify(textToList(value)),
          value_type: 'json',
          secret: false,
        })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['component-settings', 'c2'] })
      qc.invalidateQueries({ queryKey: ['component-settings', 'c2', 'job-metadata'] })
      showToast('Saved C2 job metadata values')
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Save failed', 'error'),
  })

  if (isLoading) return <SettingsLoadingState label="Loading resume policy settings..." />
  if (isError || !data) {
    return (
      <SettingsErrorState
        title="Resume policy settings are unavailable."
        description="Check the C0 settings API, then try loading Fletcher metadata values again."
        onRetry={() => void refetch()}
      />
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h3 className={styles.panelTitle}>C2 job metadata</h3>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          Role family values
          <span className={styles.fieldHint}>
            Allowed JSON labels for Fletcher metadata prompts and resume routing.
          </span>
          <textarea
            className={styles.textarea}
            value={roleFamilies}
            onChange={(e) => setRoleFamilies(e.target.value)}
            rows={8}
          />
        </label>
        <label className={styles.field}>
          Job level values
          <span className={styles.fieldHint}>
            Allowed level labels shared by metadata prompts and downstream C2 records.
          </span>
          <textarea
            className={styles.textarea}
            value={jobLevels}
            onChange={(e) => setJobLevels(e.target.value)}
            rows={8}
          />
        </label>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          Default target title
          <span className={styles.fieldHint}>
            Used when Option B has no usable title. Avoid role-specific hardcoded fallbacks.
          </span>
          <input
            className={styles.input}
            value={defaultTargetTitle}
            onChange={(e) => setDefaultTargetTitle(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          Unsupported target examples
          <span className={styles.fieldHint}>
            One per line. Used with the target-lane policy for queued jobs.
          </span>
          <textarea
            className={styles.textarea}
            value={unsupportedExamples}
            onChange={(e) => setUnsupportedExamples(e.target.value)}
            rows={6}
          />
        </label>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          Keyword max count
          <span className={styles.fieldHint}>Maximum keywords returned by extraction.</span>
          <input
            type="number"
            className={styles.input}
            value={keywordSelectionMaxKeywords}
            onChange={(e) => setKeywordSelectionMaxKeywords(e.target.value)}
            min={0}
          />
        </label>
        <label className={styles.field}>
          Keyword min words
          <span className={styles.fieldHint}>Minimum words per extracted keyword.</span>
          <input
            type="number"
            className={styles.input}
            value={keywordSelectionMinWords}
            onChange={(e) => setKeywordSelectionMinWords(e.target.value)}
            min={0}
          />
        </label>
        <label className={styles.field}>
          Keyword max words
          <span className={styles.fieldHint}>Maximum words per extracted keyword.</span>
          <input
            type="number"
            className={styles.input}
            value={keywordSelectionMaxWords}
            onChange={(e) => setKeywordSelectionMaxWords(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Metadata prompt max chars
          <span className={styles.fieldHint}>
            First job-description characters used for metadata fill.
          </span>
          <input
            type="number"
            className={styles.input}
            value={jobMetadataPromptMaxChars}
            onChange={(e) => setJobMetadataPromptMaxChars(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Minimum confidence
          <span className={styles.fieldHint}>
            Confidence threshold used in metadata and prompt policy.
          </span>
          <input
            type="number"
            className={styles.input}
            value={jobMetadataMinConfidence}
            onChange={(e) => setJobMetadataMinConfidence(e.target.value)}
            min={0}
            max={1}
            step={0.1}
          />
        </label>
        <label className={styles.field}>
          Skill addition limit
          <span className={styles.fieldHint}>Maximum Technical Skills additions per resume.</span>
          <input
            type="number"
            className={styles.input}
            value={skillAdditionLimit}
            onChange={(e) => setSkillAdditionLimit(e.target.value)}
            min={0}
          />
        </label>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          Option A min jobs
          <span className={styles.fieldHint}>Lower bound for master resume job buckets.</span>
          <input
            type="number"
            className={styles.input}
            value={optionAMinExperience}
            onChange={(e) => setOptionAMinExperience(e.target.value)}
            min={0}
            max={4}
          />
        </label>
        <label className={styles.field}>
          Option A max jobs
          <span className={styles.fieldHint}>Upper bound before compile fitting.</span>
          <input
            type="number"
            className={styles.input}
            value={optionAMaxExperience}
            onChange={(e) => setOptionAMaxExperience(e.target.value)}
            min={0}
            max={4}
          />
        </label>
        <label className={styles.field}>
          Option A min projects
          <span className={styles.fieldHint}>Lower bound for master resume project buckets.</span>
          <input
            type="number"
            className={styles.input}
            value={optionAMinProjects}
            onChange={(e) => setOptionAMinProjects(e.target.value)}
            min={0}
            max={3}
          />
        </label>
        <label className={styles.field}>
          Option A max projects
          <span className={styles.fieldHint}>Upper bound before compile fitting.</span>
          <input
            type="number"
            className={styles.input}
            value={optionAMaxProjects}
            onChange={(e) => setOptionAMaxProjects(e.target.value)}
            min={0}
            max={3}
          />
        </label>
        <label className={styles.field}>
          Job bullet cap
          <span className={styles.fieldHint}>Max selected bullets per experience bucket.</span>
          <input
            type="number"
            className={styles.input}
            value={optionAMaxExperienceBullets}
            onChange={(e) => setOptionAMaxExperienceBullets(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Project bullet cap
          <span className={styles.fieldHint}>Max selected bullets per project bucket.</span>
          <input
            type="number"
            className={styles.input}
            value={optionAMaxProjectBullets}
            onChange={(e) => setOptionAMaxProjectBullets(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Job position bonus
          <span className={styles.fieldHint}>Retention boost for earlier jobs.</span>
          <input
            type="number"
            className={styles.input}
            value={optionAExperiencePositionBonus}
            onChange={(e) => setOptionAExperiencePositionBonus(e.target.value)}
            min={0}
            step={0.01}
          />
        </label>
        <label className={styles.field}>
          Bullet position bonus
          <span className={styles.fieldHint}>Retention boost for earlier bullets in a bucket.</span>
          <input
            type="number"
            className={styles.input}
            value={optionABulletPositionBonus}
            onChange={(e) => setOptionABulletPositionBonus(e.target.value)}
            min={0}
            step={0.01}
          />
        </label>
        <label className={styles.field}>
          Project position bonus
          <span className={styles.fieldHint}>Retention boost for earlier projects.</span>
          <input
            type="number"
            className={styles.input}
            value={optionAProjectPositionBonus}
            onChange={(e) => setOptionAProjectPositionBonus(e.target.value)}
            min={0}
            step={0.01}
          />
        </label>
      </div>
      <details className={styles.advancedSettings}>
        <summary className={styles.advancedSummary}>
          <span>Advanced prompt and rewrite policy</span>
          <small>Long-form instructions used by Fletcher generation</small>
        </summary>
        <div className={styles.advancedBody}>
          <label className={styles.field}>
            Target-lane policy
            <span className={styles.fieldHint}>
              Queue-only policy for deciding whether weak-RAG jobs are outside the configured lane.
            </span>
            <textarea
              className={styles.textarea}
              value={targetLanePolicy}
              onChange={(e) => setTargetLanePolicy(e.target.value)}
              rows={4}
            />
          </label>
          <label className={styles.field}>
            Keyword keep policy
            <textarea
              className={styles.textarea}
              value={keywordKeepPolicy}
              onChange={(e) => setKeywordKeepPolicy(e.target.value)}
              rows={4}
            />
          </label>
          <label className={styles.field}>
            Keyword ignore policy
            <textarea
              className={styles.textarea}
              value={keywordIgnorePolicy}
              onChange={(e) => setKeywordIgnorePolicy(e.target.value)}
              rows={4}
            />
          </label>
          <label className={styles.field}>
            Summary keyword policy
            <textarea
              className={styles.textarea}
              value={summaryKeywordPolicy}
              onChange={(e) => setSummaryKeywordPolicy(e.target.value)}
              rows={4}
            />
          </label>
          <label className={styles.field}>
            Skill addition policy
            <textarea
              className={styles.textarea}
              value={skillAdditionPolicy}
              onChange={(e) => setSkillAdditionPolicy(e.target.value)}
              rows={4}
            />
          </label>
          <label className={styles.field}>
            Summary good example
            <textarea
              className={styles.textarea}
              value={summaryGoodExample}
              onChange={(e) => setSummaryGoodExample(e.target.value)}
              rows={3}
            />
          </label>
          <div className={styles.gridTwo}>
            <label className={styles.field}>
              Summary banned phrases
              <textarea
                className={styles.textarea}
                value={summaryBannedPhrases}
                onChange={(e) => setSummaryBannedPhrases(e.target.value)}
                rows={6}
              />
            </label>
            <label className={styles.field}>
              Blocked keywords
              <textarea
                className={styles.textarea}
                value={blockedKeywords}
                onChange={(e) => setBlockedKeywords(e.target.value)}
                rows={6}
              />
            </label>
          </div>
          <label className={styles.field}>
            Rewrite strategy
            <span className={styles.fieldHint}>
              Ordered tactics for bullet generation. Keep accept/reject rules in rewrite policy.
            </span>
            <textarea
              className={styles.textarea}
              value={rewriteStrategy}
              onChange={(e) => setRewriteStrategy(e.target.value)}
              rows={8}
            />
          </label>
          <label className={styles.field}>
            Rewrite keyword fit policy
            <textarea
              className={styles.textarea}
              value={rewriteKeywordFitPolicy}
              onChange={(e) => setRewriteKeywordFitPolicy(e.target.value)}
              rows={7}
            />
          </label>
          <label className={styles.field}>
            Rewrite bullet policy
            <textarea
              className={styles.textarea}
              value={rewriteBulletPolicy}
              onChange={(e) => setRewriteBulletPolicy(e.target.value)}
              rows={7}
            />
          </label>
          <div className={styles.gridTwo}>
            <label className={styles.field}>
              Rewrite length policy
              <span className={styles.fieldHint}>
                Use {'{max_length_percent}'} where the configured percentage should appear.
              </span>
              <textarea
                className={styles.textarea}
                value={rewriteLengthPolicy}
                onChange={(e) => setRewriteLengthPolicy(e.target.value)}
                rows={4}
              />
            </label>
            <label className={styles.field}>
              Rewrite action keyword policy
              <textarea
                className={styles.textarea}
                value={rewriteActionKeywordPolicy}
                onChange={(e) => setRewriteActionKeywordPolicy(e.target.value)}
                rows={6}
              />
            </label>
          </div>
        </div>
      </details>
      <div className={styles.footer}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Saving...' : 'Save metadata values'}
        </button>
        <FormStatus
          pending={mutation.isPending}
          error={mutation.error}
          success={mutation.isSuccess ? 'Resume metadata and policy settings saved.' : ''}
        />
      </div>
    </div>
  )
}

// ---- main page -------------------------------------------------------------

type SettingsTab = 'targeting' | 'automation' | 'resume' | 'system'
type C1Section = 'filters' | 'search' | 'run' | 'alerts'

interface SettingsTabDefinition {
  id: SettingsTab
  label: string
  owner: string
  description: string
  heading: string
  summary: string
  persistence: string
}

const SETTINGS_TABS: SettingsTabDefinition[] = [
  {
    id: 'targeting',
    label: 'Targeting',
    owner: 'C1',
    description: 'Roles, companies, locations',
    heading: 'Choose what Hunt looks for',
    summary:
      'Set search lanes, priority companies, exclusions, locations, and the job boards that feed discovery.',
    persistence: 'C1 file-backed settings',
  },
  {
    id: 'automation',
    label: 'Automation',
    owner: 'C1',
    description: 'Cadence, limits, alerts',
    heading: 'Control the discovery cycle',
    summary:
      'Tune scrape and enrichment cadence, worker limits, retry behavior, and operational alert thresholds.',
    persistence: 'C1 file-backed settings',
  },
  {
    id: 'resume',
    label: 'Resume',
    owner: 'C2',
    description: 'Providers, quality, policy',
    heading: 'Shape Fletcher output',
    summary:
      'Configure model access, runtime guardrails, resume metadata, selection limits, and generation policy.',
    persistence: 'C2 database-backed settings',
  },
  {
    id: 'system',
    label: 'System',
    owner: 'App',
    description: 'Notifications, integrations',
    heading: 'Connect operator feedback',
    summary:
      'Manage local completion notifications and verify shared services used for pipeline alerts.',
    persistence: 'Browser and integration settings',
  },
]

const C1_SECTION_LABELS: Record<C1Section, string> = {
  filters: 'Discovery filters',
  search: 'Search configuration',
  run: 'Run settings',
  alerts: 'Alert thresholds',
}

export function SettingsPage() {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<SettingsTab>('targeting')
  const [savingSection, setSavingSection] = useState<C1Section | null>(null)
  const [c1Feedback, setC1Feedback] = useState<SaveFeedback | null>(null)
  const [testingDiscord, setTestingDiscord] = useState(false)
  const [discordResult, setDiscordResult] = useState<string | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

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
    refetch,
  } = useQuery({
    queryKey: ['c1-config'],
    queryFn: fetchC1Config,
    staleTime: 30_000,
  })

  const mutation = useMutation({
    mutationFn: ({ updates }: { section: C1Section; updates: C1ConfigUpdates }) =>
      saveC1Config(updates),
    onMutate: ({ section }) => {
      setSavingSection(section)
      setC1Feedback({ tone: 'pending', message: `Saving ${C1_SECTION_LABELS[section]}...` })
    },
    onSuccess: (res, { section }) => {
      showToast(`Saved: ${res.updated_keys.join(', ')}`)
      setC1Feedback({
        tone: 'success',
        message: `${C1_SECTION_LABELS[section]} saved. ${res.updated_keys.length} setting${res.updated_keys.length === 1 ? '' : 's'} updated.`,
      })
      qc.invalidateQueries({ queryKey: ['c1-config'] })
    },
    onError: (e, { section }) => {
      const message = e instanceof Error ? e.message : 'Save failed'
      setC1Feedback({
        tone: 'error',
        message: `${C1_SECTION_LABELS[section]} were not saved: ${message}. Try again.`,
      })
      showToast(message, 'error')
    },
    onSettled: () => setSavingSection(null),
  })

  function save(section: C1Section, updates: C1ConfigUpdates) {
    mutation.mutate({ section, updates })
  }

  function c1Content(tab: 'targeting' | 'automation') {
    if (isLoading) {
      return <SettingsLoadingState label="Loading C1 configuration..." />
    }
    if (error || !cfg) {
      return (
        <SettingsErrorState
          title="C1 configuration is unavailable."
          description="Check that the C1 service is running, then try loading these settings again."
          onRetry={() => void refetch()}
        />
      )
    }
    return (
      <>
        <aside className={styles.notice}>
          <div>
            <strong>Activation</strong>
            <p>
              Changes are saved to C1's config file. Restart the C1 scheduler to activate worker,
              interval, source, and request-limit changes; an active cycle keeps its current values.
            </p>
          </div>
          <span className={styles.configPath}>{cfg.config_file}</span>
        </aside>
        {c1Feedback && (
          <div
            className={`${styles.saveBanner} ${styles[`saveBanner${c1Feedback.tone.charAt(0).toUpperCase()}${c1Feedback.tone.slice(1)}`]}`}
            role={c1Feedback.tone === 'error' ? 'alert' : 'status'}
            aria-live="polite"
          >
            {c1Feedback.message}
          </div>
        )}
        {tab === 'targeting' ? (
          <>
            <SearchConfig
              cfg={cfg}
              saving={savingSection === 'search'}
              onSave={(u) => save('search', u)}
            />
            <DiscoveryFilters
              cfg={cfg}
              saving={savingSection === 'filters'}
              onSave={(u) => save('filters', u)}
            />
          </>
        ) : (
          <>
            <RunSettings
              cfg={cfg}
              saving={savingSection === 'run'}
              onSave={(u) => save('run', u)}
            />
            <AlertSettings
              cfg={cfg}
              saving={savingSection === 'alerts'}
              onSave={(u) => save('alerts', u)}
            />
          </>
        )}
      </>
    )
  }

  function selectTab(nextTab: SettingsTab) {
    setActiveTab(nextTab)
    setC1Feedback(null)
  }

  function activateTab(index: number) {
    const nextIndex = (index + SETTINGS_TABS.length) % SETTINGS_TABS.length
    selectTab(SETTINGS_TABS[nextIndex].id)
    tabRefs.current[nextIndex]?.focus()
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      activateTab(index + 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      activateTab(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      activateTab(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      activateTab(SETTINGS_TABS.length - 1)
    }
  }

  const activeDefinition = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0]

  const integrationsContent = (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h3 className={styles.panelTitle}>Discord alerts</h3>
          <p className={styles.panelDescription}>
            Verify that C1 can reach the configured webhook before relying on pipeline alerts.
          </p>
        </div>
      </div>
      <button
        className={styles.btn}
        type="button"
        disabled={testingDiscord}
        onClick={handleTestDiscord}
      >
        {testingDiscord ? 'Sending...' : 'Test Discord webhook'}
      </button>
      {discordResult && (
        <p
          className={`${styles.formStatus} ${discordResult.startsWith('Failed') ? styles.formStatusError : styles.formStatusSuccess}`}
          role={discordResult.startsWith('Failed') ? 'alert' : 'status'}
          aria-live="polite"
        >
          {discordResult}
        </p>
      )}
    </div>
  )

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <h1 className={styles.heroTitle}>Settings</h1>
          <p className={styles.heroMeta}>
            Tune the pipeline by outcome. Every save is scoped to the section you are editing.
          </p>
        </div>
        <div className={styles.heroSummary} aria-label="Settings overview">
          <span>4 focused areas</span>
          <span>Section-level saves</span>
        </div>
      </section>

      <div className={styles.tabBar} role="tablist" aria-label="Settings areas">
        {SETTINGS_TABS.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-controls={`settings-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            ref={(node) => {
              tabRefs.current[index] = node
            }}
            className={`${styles.tabButton} ${activeTab === tab.id ? styles.tabButtonActive : ''}`}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            <span className={styles.tabLabel}>
              {tab.label}
              <small>{tab.owner}</small>
            </span>
            <span className={styles.tabDescription}>{tab.description}</span>
          </button>
        ))}
      </div>

      <section
        className={styles.tabPanel}
        role="tabpanel"
        id={`settings-panel-${activeTab}`}
        aria-labelledby={`settings-tab-${activeTab}`}
        tabIndex={0}
      >
        <header className={styles.sectionHeader}>
          <div>
            <h2>{activeDefinition.heading}</h2>
            <p>{activeDefinition.summary}</p>
          </div>
          <span className={styles.persistenceBadge}>{activeDefinition.persistence}</span>
        </header>

        {activeTab === 'targeting' && c1Content('targeting')}
        {activeTab === 'automation' && c1Content('automation')}
        {activeTab === 'resume' && (
          <>
            <C2ProviderRuntimeSettings />
            <JobMetadataSettings />
          </>
        )}
        {activeTab === 'system' && (
          <>
            <AppNotificationSettings />
            {integrationsContent}
          </>
        )}
      </section>
    </div>
  )
}
