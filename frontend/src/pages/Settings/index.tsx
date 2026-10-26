import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchC1Config,
  fetchC2RuntimeSettings,
  saveSettings,
  type SettingUpdate,
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

// Refresh clean fields while retaining edits made after a save started.
function useDraftValue<T>(saved: T, reset = 0) {
  const [value, setValue] = useState(saved)
  const [previous, setPrevious] = useState({ saved, reset })
  if (previous.saved !== saved || previous.reset !== reset) {
    setPrevious({ saved, reset })
    if (value === previous.saved || previous.reset !== reset) setValue(saved)
  }
  return [value, setValue] as const
}

function useMounted() {
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}

function changedSettings(
  settings: ComponentSetting[],
  entries: Array<[string, string, string?, boolean?]>,
  defaults: Record<string, string> = {},
): SettingUpdate[] {
  return entries
    .filter(([key, value, , secret]) =>
      secret
        ? Boolean(value.trim())
        : value !== (getSettingValue(settings, key) ?? defaults[key] ?? ''),
    )
    .map(([key, value, value_type = 'text', secret = false]) => ({
      component: 'c2',
      key,
      value,
      value_type,
      secret,
      expected: getSetting(settings, key) ?? null,
    }))
}

function useBatchSave(
  setSettings: React.Dispatch<React.SetStateAction<ComponentSetting[] | null>>,
) {
  const qc = useQueryClient()
  const showToast = useUiStore((s) => s.showToast)
  const mounted = useMounted()
  const inFlight = useRef(false)
  const [syncRetry, setSyncRetry] = useState<SettingUpdate[]>([])
  const [syncWarnings, setSyncWarnings] = useState<string[]>([])
  const mutation = useMutation({
    mutationFn: saveSettings,
    onSuccess: (result, submitted) => {
      if (!mounted.current) return
      setSettings((previous) => [
        ...(previous ?? []).filter(
          (row) => !result.settings.some((saved) => saved.key === row.key),
        ),
        ...result.settings,
      ])
      if (submitted.some((row) => row.key.startsWith('option_a_'))) {
        setSyncWarnings(result.warnings)
        setSyncRetry(
          result.warnings.length
            ? submitted
                .filter((row) => row.key.startsWith('option_a_'))
                .map((row) => ({ ...row, expected: getSetting(result.settings, row.key) ?? null }))
            : [],
        )
      }
      void qc.invalidateQueries({ queryKey: ['component-settings', 'c2'] })
      void qc.invalidateQueries({ queryKey: ['c2-runtime-settings'] })
      showToast(
        result.warnings.length ? 'Settings saved; template sync needs retry.' : 'Settings saved',
        result.warnings.length ? 'error' : 'ok',
      )
    },
  })
  async function save(updates: SettingUpdate[]) {
    if (inFlight.current || !updates.length) return null
    inFlight.current = true
    try {
      return await mutation.mutateAsync(updates)
    } catch {
      return null
    } finally {
      inFlight.current = false
    }
  }
  return { mutation, save, syncRetry, syncWarnings }
}

// ---- sub-panels ------------------------------------------------------------

function DiscoveryFilters({
  cfg,
  onSave,
  saving,
  error,
  onReload,
}: {
  cfg: C1Config
  onSave: (u: C1ConfigUpdates) => void
  saving: boolean
  error: string | null
  onReload: () => void
}) {
  const [watchlist, setWatchlist] = useDraftValue(listToText(cfg.watchlist))
  const [blacklist, setBlacklist] = useDraftValue(listToText(cfg.title_blacklist))

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Discovery filters</h2>
      </div>
      <label className={styles.field}>
        Watchlist - priority companies (one per line)
        <span className={styles.fieldHint}>
          Matching companies are prioritized and trigger a Discord alert.
        </span>
        <textarea
          className={styles.textarea}
          value={watchlist}
          onChange={(e) => setWatchlist(e.target.value)}
          rows={10}
        />
      </label>
      <label className={styles.field}>
        Title blacklist - phrases to exclude (one per line)
        <textarea
          className={styles.textarea}
          value={blacklist}
          onChange={(e) => setBlacklist(e.target.value)}
          rows={10}
        />
      </label>
      {error && (
        <p className={styles.errorMsg} role="alert">
          {error} Your draft is preserved.
        </p>
      )}
      <div className={styles.footer}>
        {error && (
          <button className={styles.btn} disabled={saving} onClick={onReload}>
            Discard C1 drafts and reload
          </button>
        )}
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
  error,
  onReload,
}: {
  cfg: C1Config
  onSave: (u: C1ConfigUpdates) => void
  saving: boolean
  error: string | null
  onReload: () => void
}) {
  const configuredRoles = useMemo(
    () => (cfg.targeting_configured ? (cfg.target_job_titles ?? {}) : (cfg.search_terms ?? {})),
    [cfg.targeting_configured, cfg.target_job_titles, cfg.search_terms],
  )
  const [experienceLevels, setExperienceLevels] = useDraftValue(
    useMemo(() => new Set(cfg.experience_levels ?? []), [cfg.experience_levels]),
  )
  const [lanes, setLanes] = useDraftValue<Record<string, string>>(
    useMemo(
      () =>
        Object.fromEntries(
          Object.keys(configuredRoles).map((k) => [k, listToText(configuredRoles[k])]),
        ),
      [configuredRoles],
    ),
  )
  const laneNames = Object.keys(lanes)
  const [newLane, setNewLane] = useDraftValue('')
  const [countries, setCountries] = useDraftValue(listToText(cfg.discovery_countries ?? ['Canada']))
  const [indeedCountry, setIndeedCountry] = useDraftValue(cfg.country_indeed ?? 'Canada')
  const [employmentTypes, setEmploymentTypes] = useDraftValue(
    listToText(cfg.employment_types ?? []),
  )
  const [experienced, setExperienced] = useDraftValue(cfg.include_experienced_roles ?? false)
  const [remoteOnly, setRemoteOnly] = useDraftValue(cfg.remote_only ?? false)
  const [locations, setLocations] = useDraftValue(listToText(cfg.locations))
  const [linkedinOn, setLinkedinOn] = useDraftValue(cfg.sites.includes('linkedin'))
  const [indeedOn, setIndeedOn] = useDraftValue(cfg.sites.includes('indeed'))

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
            {name.charAt(0).toUpperCase() + name.slice(1)} lane - search queries
            <textarea
              className={styles.textarea}
              value={lanes[name] ?? ''}
              onChange={(e) => updateLane(name, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className={styles.field}>
        <label className={styles.field}>
          New job group
          <input
            className={styles.input}
            value={newLane}
            onChange={(event) => setNewLane(event.target.value)}
            placeholder="Healthcare, teaching, trades…"
          />
        </label>
        <button
          className={styles.btn}
          disabled={
            !newLane.trim() ||
            Object.prototype.hasOwnProperty.call(lanes, newLane.trim().toLowerCase())
          }
          onClick={() => {
            updateLane(newLane.trim().toLowerCase(), '')
            setNewLane('')
          }}
        >
          Add job group
        </button>
      </div>
      {cfg.targeting_configured && (
        <fieldset className={styles.experienceFieldset}>
          <legend>Career levels</legend>
          <p className={styles.fieldHint}>
            Choose levels to require in job titles. Leave all unchecked for any level; senior roles
            also require the option below.
          </p>
          {(
            [
              ['internship', 'Internship'],
              ['junior', 'Junior'],
              ['new_grad', 'New graduate'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={experienceLevels.has(value)}
                onChange={() =>
                  setExperienceLevels((previous) => {
                    const next = new Set(previous)
                    if (next.has(value)) next.delete(value)
                    else next.add(value)
                    return next
                  })
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      <label className={styles.field}>
        Eligible countries (one per line)
        <span className={styles.fieldHint}>
          Leave empty to include all countries. Regional sources still cover their own markets.
        </span>
        <textarea
          className={styles.textarea}
          value={countries}
          onChange={(event) => setCountries(event.target.value)}
          rows={3}
        />
      </label>
      <label className={styles.field}>
        Indeed market
        <input
          className={styles.input}
          value={indeedCountry}
          onChange={(event) => setIndeedCountry(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        Employment types (one per line)
        <span className={styles.fieldHint}>
          Leave empty for all types. Examples: full time, part time, contract. Jobs with unknown
          types need checking when this filter is set.
        </span>
        <textarea
          className={styles.textarea}
          value={employmentTypes}
          onChange={(event) => setEmploymentTypes(event.target.value)}
          rows={3}
        />
      </label>
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={experienced}
          onChange={(event) => setExperienced(event.target.checked)}
        />
        Include senior and experienced roles
      </label>
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={remoteOnly}
          onChange={(event) => setRemoteOnly(event.target.checked)}
        />
        Require confirmed remote work
      </label>
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
      {error && (
        <p className={styles.errorMsg} role="alert">
          {error} Your draft is preserved.
        </p>
      )}
      <div className={styles.footer}>
        {error && (
          <button className={styles.btn} disabled={saving} onClick={onReload}>
            Discard C1 drafts and reload
          </button>
        )}
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={() => {
            const sites: string[] = []
            if (linkedinOn) sites.push('linkedin')
            if (indeedOn) sites.push('indeed')
            onSave({
              ...(cfg.targeting_configured
                ? {
                    target_job_titles: Object.fromEntries(
                      Object.entries(lanes).map(([k, v]) => [k, textToList(v)]),
                    ),
                    experience_levels: Array.from(experienceLevels),
                  }
                : {
                    search_terms: Object.fromEntries(
                      Object.entries(lanes).map(([k, v]) => [k, textToList(v)]),
                    ),
                  }),
              locations: textToList(locations),
              discovery_countries: textToList(countries),
              country_indeed: indeedCountry.trim(),
              employment_types: textToList(employmentTypes),
              include_experienced_roles: experienced,
              remote_only: remoteOnly,
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
  error,
  onReload,
}: {
  cfg: C1Config
  onSave: (u: C1ConfigUpdates) => void
  saving: boolean
  error: string | null
  onReload: () => void
}) {
  const [intervalSec, setIntervalSec] = useDraftValue(String(cfg.run_interval_seconds))
  const [resultsWanted, setResultsWanted] = useDraftValue(String(cfg.results_wanted))
  const [hoursOld, setHoursOld] = useDraftValue(String(cfg.hours_old))
  const [maxWorkers, setMaxWorkers] = useDraftValue(String(cfg.max_workers))
  const [enrichAfterScrape, setEnrichAfterScrape] = useDraftValue(cfg.enrich_after_scrape)
  const [batchLimit, setBatchLimit] = useDraftValue(String(cfg.enrichment_batch_limit))
  const [timeoutMs, setTimeoutMs] = useDraftValue(String(cfg.enrichment_timeout_ms))
  const [maxAttempts, setMaxAttempts] = useDraftValue(String(cfg.enrichment_max_attempts))

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Run settings</h2>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          Run interval (seconds)
          <input
            type="number"
            className={styles.input}
            value={intervalSec}
            onChange={(e) => setIntervalSec(e.target.value)}
            min={60}
          />
        </label>
        <label className={styles.field}>
          Maximum results per search
          <input
            type="number"
            className={styles.input}
            value={resultsWanted}
            onChange={(e) => setResultsWanted(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Maximum posting age (hours)
          <input
            type="number"
            className={styles.input}
            value={hoursOld}
            onChange={(e) => setHoursOld(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Parallel workers
          <input
            type="number"
            className={styles.input}
            value={maxWorkers}
            onChange={(e) => setMaxWorkers(e.target.value)}
            min={1}
          />
        </label>
        <label className={styles.field}>
          Jobs to enrich per cycle
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
      {error && (
        <p className={styles.errorMsg} role="alert">
          {error} Your draft is preserved.
        </p>
      )}
      <div className={styles.footer}>
        {error && (
          <button className={styles.btn} disabled={saving} onClick={onReload}>
            Discard C1 drafts and reload
          </button>
        )}
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={() =>
            onSave({
              run_interval_seconds: intervalSec.trim() ? Number(intervalSec) : NaN,
              results_wanted: resultsWanted.trim() ? Number(resultsWanted) : NaN,
              hours_old: hoursOld.trim() ? Number(hoursOld) : NaN,
              max_workers: maxWorkers.trim() ? Number(maxWorkers) : NaN,
              enrich_after_scrape: enrichAfterScrape,
              enrichment_batch_limit: batchLimit.trim() ? Number(batchLimit) : NaN,
              enrichment_timeout_ms: timeoutMs.trim() ? Number(timeoutMs) : NaN,
              enrichment_max_attempts: maxAttempts.trim() ? Number(maxAttempts) : NaN,
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
  error,
  onReload,
}: {
  cfg: C1Config
  onSave: (u: C1ConfigUpdates) => void
  saving: boolean
  error: string | null
  onReload: () => void
}) {
  const [failureRate, setFailureRate] = useDraftValue(
    String(cfg.enrichment_alert_failure_rate_percent),
  )
  const [cooldownMin, setCooldownMin] = useDraftValue(String(cfg.enrichment_alert_cooldown_minutes))

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Alert thresholds</h2>
      </div>
      <div className={styles.gridTwo}>
        <label className={styles.field}>
          High failure rate threshold (%)
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
          <input
            type="number"
            className={styles.input}
            value={cooldownMin}
            onChange={(e) => setCooldownMin(e.target.value)}
            min={1}
          />
        </label>
      </div>
      {error && (
        <p className={styles.errorMsg} role="alert">
          {error} Your draft is preserved.
        </p>
      )}
      <div className={styles.footer}>
        {error && (
          <button className={styles.btn} disabled={saving} onClick={onReload}>
            Discard C1 drafts and reload
          </button>
        )}
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={saving}
          onClick={() =>
            onSave({
              enrichment_alert_failure_rate_percent: failureRate.trim() ? Number(failureRate) : NaN,
              enrichment_alert_cooldown_minutes: cooldownMin.trim() ? Number(cooldownMin) : NaN,
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

  const { data } = useQuery({
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

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>App notifications</h2>
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
    </div>
  )
}

const C2_LLM_PROVIDER_KEY = 'llm_provider'
const C2_LLM_MODEL_KEY = 'llm_model'
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
  const query = useQuery({
    queryKey: ['component-settings', 'c2', 'runtime'],
    queryFn: () => fetchSettings('c2'),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
  const runtime = useQuery({
    queryKey: ['c2-runtime-settings'],
    queryFn: fetchC2RuntimeSettings,
    staleTime: 30_000,
    retry: false,
  })
  const [settings, setSettings] = useState<ComponentSetting[] | null>(null)
  if (settings === null && query.data) setSettings(query.data.settings)
  const [reset, setReset] = useState(0)
  const mounted = useMounted()
  const { mutation, save } = useBatchSave(setSettings)
  const [provider, setProvider] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_LLM_PROVIDER_KEY) ?? '',
    reset,
  )
  const [model, setModel] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_LLM_MODEL_KEY) ?? '',
    reset,
  )
  const [cloudConfirm, setCloudConfirm] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_CLOUD_CONFIRM_KEY) ?? '',
    reset,
  )
  const [ollamaHost, setOllamaHost] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_OLLAMA_HOST_KEY) ?? '',
    reset,
  )
  const [ollamaModel, setOllamaModel] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_OLLAMA_MODEL_KEY) ?? '',
    reset,
  )
  const [ollamaTimeoutSec, setOllamaTimeoutSec] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_OLLAMA_TIMEOUT_SEC_KEY) ?? '',
    reset,
  )
  const [ollamaKeepAlive, setOllamaKeepAlive] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_OLLAMA_KEEP_ALIVE_KEY) ?? '',
    reset,
  )
  const [rewriteParallelism, setRewriteParallelism] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_BULLET_REWRITE_PARALLELISM_KEY) ?? '',
    reset,
  )
  const [rewriteMinAvailableMb, setRewriteMinAvailableMb] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_BULLET_REWRITE_MIN_AVAILABLE_MB_KEY) ?? '',
    reset,
  )
  const [rewriteMaxMemoryPct, setRewriteMaxMemoryPct] = useDraftValue(
    getSettingValue(settings ?? undefined, C2_BULLET_REWRITE_MAX_MEMORY_PCT_KEY) ?? '',
    reset,
  )
  const [openaiKey, setOpenaiKey] = useState('')
  const openaiStored = Boolean(getSetting(settings ?? undefined, C2_OPENAI_API_KEY)?.has_value)
  const [openrouterKey, setOpenrouterKey] = useState('')
  const openrouterStored = Boolean(
    getSetting(settings ?? undefined, C2_OPENROUTER_API_KEY)?.has_value,
  )
  const [anthropicKey, setAnthropicKey] = useState('')
  const anthropicStored = Boolean(
    getSetting(settings ?? undefined, C2_ANTHROPIC_API_KEY)?.has_value,
  )
  const [geminiKey, setGeminiKey] = useState('')
  const geminiStored = Boolean(getSetting(settings ?? undefined, C2_GEMINI_API_KEY)?.has_value)
  const updates = changedSettings(settings ?? [], [
    [C2_LLM_PROVIDER_KEY, provider, 'text'],
    [C2_LLM_MODEL_KEY, model, 'text'],
    [C2_CLOUD_CONFIRM_KEY, cloudConfirm, 'boolean'],
    [C2_OLLAMA_HOST_KEY, ollamaHost, 'text'],
    [C2_OLLAMA_MODEL_KEY, ollamaModel, 'text'],
    [C2_OLLAMA_TIMEOUT_SEC_KEY, ollamaTimeoutSec, 'text'],
    [C2_OLLAMA_KEEP_ALIVE_KEY, ollamaKeepAlive, 'text'],
    [C2_BULLET_REWRITE_PARALLELISM_KEY, rewriteParallelism, 'text'],
    [C2_BULLET_REWRITE_MIN_AVAILABLE_MB_KEY, rewriteMinAvailableMb, 'text'],
    [C2_BULLET_REWRITE_MAX_MEMORY_PCT_KEY, rewriteMaxMemoryPct, 'text'],
    [C2_OPENAI_API_KEY, openaiKey, 'text', true],
    [C2_OPENROUTER_API_KEY, openrouterKey, 'text', true],
    [C2_ANTHROPIC_API_KEY, anthropicKey, 'text', true],
    [C2_GEMINI_API_KEY, geminiKey, 'text', true],
  ]).filter((item) => !runtime.data?.environment_overrides[item.key])
  async function submit() {
    const submitted = updates
    const result = await save(submitted)
    if (!result || !mounted.current) return
    if (submitted.some((item) => item.key === C2_OPENAI_API_KEY))
      setOpenaiKey((current) =>
        current === submitted.find((item) => item.key === C2_OPENAI_API_KEY)?.value ? '' : current,
      )
    if (submitted.some((item) => item.key === C2_OPENROUTER_API_KEY))
      setOpenrouterKey((current) =>
        current === submitted.find((item) => item.key === C2_OPENROUTER_API_KEY)?.value
          ? ''
          : current,
      )
    if (submitted.some((item) => item.key === C2_ANTHROPIC_API_KEY))
      setAnthropicKey((current) =>
        current === submitted.find((item) => item.key === C2_ANTHROPIC_API_KEY)?.value
          ? ''
          : current,
      )
    if (submitted.some((item) => item.key === C2_GEMINI_API_KEY))
      setGeminiKey((current) =>
        current === submitted.find((item) => item.key === C2_GEMINI_API_KEY)?.value ? '' : current,
      )
  }
  async function reload() {
    const result = await query.refetch()
    if (!result.data || result.isError || !mounted.current) return
    setSettings(result.data.settings)
    setReset((value) => value + 1)
    setOpenaiKey('')
    setOpenrouterKey('')
    setAnthropicKey('')
    setGeminiKey('')
    mutation.reset()
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Model and runtime</h2>
      </div>

      {!settings && (
        <p role={query.isError ? 'alert' : 'status'}>
          {query.isError
            ? 'Could not load saved provider settings.'
            : 'Loading saved provider settings…'}
        </p>
      )}
      {query.isError && (
        <button className={styles.btn} onClick={() => void query.refetch()}>
          Retry saved settings
        </button>
      )}
      <div className={styles.notice}>
        {runtime.data ? (
          <>
            Effective provider: {runtime.data.values.llm_provider}. Cloud access:{' '}
            {runtime.data.values.cloud_llm_confirm === 'true' ? 'allowed' : 'blocked'}.
            {Object.entries(runtime.data.environment_overrides).map(([key, env]) => (
              <p key={key}>
                {key.replace(/_/g, ' ')} is controlled by {env}.
              </p>
            ))}
          </>
        ) : (
          <span>
            {runtime.isError
              ? 'Could not read the active C2 runtime.'
              : 'Checking the active C2 runtime…'}
          </span>
        )}
        {runtime.isError && (
          <button className={styles.btn} onClick={() => void runtime.refetch()}>
            Retry runtime status
          </button>
        )}
        <p>Blank overrides inherit the service configuration. Only edited fields are saved.</p>
      </div>
      <fieldset disabled={!settings} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <div className={styles.gridTwo}>
          <label className={styles.field}>
            LLM provider
            <select
              className={styles.input}
              value={
                runtime.data?.environment_overrides.llm_provider
                  ? runtime.data.values.llm_provider
                  : provider
              }
              disabled={Boolean(runtime.data?.environment_overrides.llm_provider)}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="">Use service environment/default</option>
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
              value={
                runtime.data?.environment_overrides.llm_model
                  ? runtime.data.values.llm_model
                  : model
              }
              disabled={Boolean(runtime.data?.environment_overrides.llm_model)}
              placeholder={runtime.data?.values.llm_model || 'Provider default'}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            Cloud provider permission
            <select
              className={styles.input}
              value={
                runtime.data?.environment_overrides.cloud_llm_confirm
                  ? runtime.data.values.cloud_llm_confirm
                  : cloudConfirm
              }
              disabled={Boolean(runtime.data?.environment_overrides.cloud_llm_confirm)}
              onChange={(e) => setCloudConfirm(e.target.value)}
            >
              <option value="">Use service environment/default</option>
              <option value="true">Allow resume and job text to cloud providers</option>
              <option value="false">Block cloud providers</option>
            </select>
          </label>
        </div>
        <div className={styles.notice}>
          Cloud permission can be set by the service environment. API keys are write-only: saved
          keys show as present, never as readable text.
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
              placeholder={runtime.data?.values.ollama_host || 'Service environment/default'}
              onChange={(e) => setOllamaHost(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            Ollama model
            <input
              className={styles.input}
              value={ollamaModel}
              placeholder={runtime.data?.values.ollama_model || 'Service environment/default'}
              onChange={(e) => setOllamaModel(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            Ollama timeout seconds
            <input
              type="number"
              className={styles.input}
              value={ollamaTimeoutSec}
              placeholder={runtime.data?.values.ollama_timeout_sec || 'Service environment/default'}
              min={1}
              onChange={(e) => setOllamaTimeoutSec(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            Ollama keep alive
            <input
              className={styles.input}
              value={ollamaKeepAlive}
              placeholder={runtime.data?.values.ollama_keep_alive || 'Service environment/default'}
              onChange={(e) => setOllamaKeepAlive(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            Bullet rewrite parallelism
            <input
              type="number"
              className={styles.input}
              value={rewriteParallelism}
              placeholder={
                runtime.data?.values.bullet_rewrite_parallelism || 'Service environment/default'
              }
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
              placeholder={
                runtime.data?.values.bullet_rewrite_min_available_mb ||
                'Service environment/default'
              }
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
              placeholder={
                runtime.data?.values.bullet_rewrite_max_memory_pct || 'Service environment/default'
              }
              min={1}
              max={100}
              onChange={(e) => setRewriteMaxMemoryPct(e.target.value)}
            />
          </label>
        </div>

        {mutation.error && (
          <p className={styles.errorMsg} role="alert">
            {mutation.error.message} Your draft is preserved.
          </p>
        )}
        <div className={styles.footer}>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={mutation.isPending || !settings || !updates.length}
            onClick={() => void submit()}
          >
            {mutation.isPending ? 'Saving...' : 'Save provider settings'}
          </button>
          <button
            className={styles.btn}
            disabled={mutation.isPending}
            onClick={() => void reload()}
          >
            Discard draft and reload
          </button>
        </div>
      </fieldset>
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
  const query = useQuery({
    queryKey: ['component-settings', 'c2', 'job-metadata'],
    queryFn: () => fetchSettings('c2'),
    staleTime: 30_000,
  })

  const [settings, setSettings] = useState<ComponentSetting[] | null>(null)
  if (settings === null && query.data) setSettings(query.data.settings)
  const [reset, setReset] = useState(0)
  const mounted = useMounted()
  const roleFamilyText = settingListValue(
    settings ?? undefined,
    JOB_METADATA_ROLE_FAMILIES_KEY,
    DEFAULT_JOB_METADATA_ROLE_FAMILIES,
  )
  const jobLevelText = settingListValue(
    settings ?? undefined,
    JOB_METADATA_JOB_LEVELS_KEY,
    DEFAULT_JOB_METADATA_JOB_LEVELS,
  )
  const targetLanePolicyText =
    getSettingValue(settings ?? undefined, C2_TARGET_LANE_POLICY_KEY) ?? C2_TARGET_LANE_POLICY
  const unsupportedExamplesText = settingListValue(
    settings ?? undefined,
    C2_UNSUPPORTED_TARGET_EXAMPLES_KEY,
    C2_UNSUPPORTED_TARGET_EXAMPLES,
  )
  const blockedKeywordText = settingListValue(
    settings ?? undefined,
    C2_BLOCKED_KEYWORDS_KEY,
    C2_BLOCKED_KEYWORDS,
  )
  const keywordKeepPolicyText =
    getSettingValue(settings ?? undefined, C2_KEYWORD_KEEP_POLICY_KEY) ?? C2_KEYWORD_KEEP_POLICY
  const keywordIgnorePolicyText =
    getSettingValue(settings ?? undefined, C2_KEYWORD_IGNORE_POLICY_KEY) ?? C2_KEYWORD_IGNORE_POLICY
  const summaryKeywordPolicyText =
    getSettingValue(settings ?? undefined, C2_SUMMARY_KEYWORD_POLICY_KEY) ??
    C2_SUMMARY_KEYWORD_POLICY
  const skillAdditionPolicyText =
    getSettingValue(settings ?? undefined, C2_SKILL_ADDITION_POLICY_KEY) ?? C2_SKILL_ADDITION_POLICY
  const summaryGoodExampleText =
    getSettingValue(settings ?? undefined, C2_SUMMARY_GOOD_EXAMPLE_KEY) ?? C2_SUMMARY_GOOD_EXAMPLE
  const summaryBannedPhraseText = settingListValue(
    settings ?? undefined,
    C2_SUMMARY_BANNED_PHRASES_KEY,
    C2_SUMMARY_BANNED_PHRASES,
  )
  const rewriteStrategyText =
    getSettingValue(settings ?? undefined, C2_REWRITE_STRATEGY_KEY) ?? C2_REWRITE_STRATEGY
  const rewriteKeywordFitPolicyText =
    getSettingValue(settings ?? undefined, C2_REWRITE_KEYWORD_FIT_POLICY_KEY) ??
    C2_REWRITE_KEYWORD_FIT_POLICY
  const rewriteBulletPolicyText =
    getSettingValue(settings ?? undefined, C2_REWRITE_BULLET_POLICY_KEY) ?? C2_REWRITE_BULLET_POLICY
  const rewriteLengthPolicyText =
    getSettingValue(settings ?? undefined, C2_REWRITE_LENGTH_POLICY_KEY) ?? C2_REWRITE_LENGTH_POLICY
  const rewriteActionKeywordPolicyText =
    getSettingValue(settings ?? undefined, C2_REWRITE_ACTION_KEYWORD_POLICY_KEY) ??
    C2_REWRITE_ACTION_KEYWORD_POLICY
  const defaultTargetTitleText =
    getSettingValue(settings ?? undefined, C2_DEFAULT_TARGET_TITLE_KEY) ?? C2_DEFAULT_TARGET_TITLE
  const keywordSelectionMaxKeywordsText =
    getSettingValue(settings ?? undefined, C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY) ??
    C2_KEYWORD_SELECTION_MAX_KEYWORDS
  const keywordSelectionMinWordsText =
    getSettingValue(settings ?? undefined, C2_KEYWORD_SELECTION_MIN_WORDS_KEY) ??
    C2_KEYWORD_SELECTION_MIN_WORDS
  const keywordSelectionMaxWordsText =
    getSettingValue(settings ?? undefined, C2_KEYWORD_SELECTION_MAX_WORDS_KEY) ??
    C2_KEYWORD_SELECTION_MAX_WORDS
  const jobMetadataPromptMaxCharsText =
    getSettingValue(settings ?? undefined, C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY) ??
    C2_JOB_METADATA_PROMPT_MAX_CHARS
  const jobMetadataMinConfidenceText =
    getSettingValue(settings ?? undefined, C2_JOB_METADATA_MIN_CONFIDENCE_KEY) ??
    C2_JOB_METADATA_MIN_CONFIDENCE
  const skillAdditionLimitText =
    getSettingValue(settings ?? undefined, C2_SKILL_ADDITION_LIMIT_KEY) ?? C2_SKILL_ADDITION_LIMIT
  const optionAMinExperienceText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_MIN_EXPERIENCE_KEY) ??
    C2_OPTION_A_MIN_EXPERIENCE
  const optionAMaxExperienceText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_MAX_EXPERIENCE_KEY) ??
    C2_OPTION_A_MAX_EXPERIENCE
  const optionAMinProjectsText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_MIN_PROJECTS_KEY) ?? C2_OPTION_A_MIN_PROJECTS
  const optionAMaxProjectsText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_MAX_PROJECTS_KEY) ?? C2_OPTION_A_MAX_PROJECTS
  const optionAMaxExperienceBulletsText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_MAX_EXPERIENCE_BULLETS_KEY) ??
    C2_OPTION_A_MAX_EXPERIENCE_BULLETS
  const optionAMaxProjectBulletsText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_MAX_PROJECT_BULLETS_KEY) ??
    C2_OPTION_A_MAX_PROJECT_BULLETS
  const optionAExperiencePositionBonusText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_EXPERIENCE_POSITION_BONUS_KEY) ??
    C2_OPTION_A_EXPERIENCE_POSITION_BONUS
  const optionAProjectPositionBonusText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_PROJECT_POSITION_BONUS_KEY) ??
    C2_OPTION_A_PROJECT_POSITION_BONUS
  const optionABulletPositionBonusText =
    getSettingValue(settings ?? undefined, C2_OPTION_A_BULLET_POSITION_BONUS_KEY) ??
    C2_OPTION_A_BULLET_POSITION_BONUS

  const [roleFamilies, setRoleFamilies] = useDraftValue(roleFamilyText, reset)
  const [jobLevels, setJobLevels] = useDraftValue(jobLevelText, reset)
  const [targetLanePolicy, setTargetLanePolicy] = useDraftValue(targetLanePolicyText, reset)
  const [unsupportedExamples, setUnsupportedExamples] = useDraftValue(
    unsupportedExamplesText,
    reset,
  )
  const [blockedKeywords, setBlockedKeywords] = useDraftValue(blockedKeywordText, reset)
  const [keywordKeepPolicy, setKeywordKeepPolicy] = useDraftValue(keywordKeepPolicyText, reset)
  const [keywordIgnorePolicy, setKeywordIgnorePolicy] = useDraftValue(
    keywordIgnorePolicyText,
    reset,
  )
  const [summaryKeywordPolicy, setSummaryKeywordPolicy] = useDraftValue(
    summaryKeywordPolicyText,
    reset,
  )
  const [skillAdditionPolicy, setSkillAdditionPolicy] = useDraftValue(
    skillAdditionPolicyText,
    reset,
  )
  const [summaryGoodExample, setSummaryGoodExample] = useDraftValue(summaryGoodExampleText, reset)
  const [summaryBannedPhrases, setSummaryBannedPhrases] = useDraftValue(
    summaryBannedPhraseText,
    reset,
  )
  const [rewriteStrategy, setRewriteStrategy] = useDraftValue(rewriteStrategyText, reset)
  const [rewriteKeywordFitPolicy, setRewriteKeywordFitPolicy] = useDraftValue(
    rewriteKeywordFitPolicyText,
    reset,
  )
  const [rewriteBulletPolicy, setRewriteBulletPolicy] = useDraftValue(
    rewriteBulletPolicyText,
    reset,
  )
  const [rewriteLengthPolicy, setRewriteLengthPolicy] = useDraftValue(
    rewriteLengthPolicyText,
    reset,
  )
  const [rewriteActionKeywordPolicy, setRewriteActionKeywordPolicy] = useDraftValue(
    rewriteActionKeywordPolicyText,
    reset,
  )
  const [defaultTargetTitle, setDefaultTargetTitle] = useDraftValue(defaultTargetTitleText, reset)
  const [keywordSelectionMaxKeywords, setKeywordSelectionMaxKeywords] = useDraftValue(
    keywordSelectionMaxKeywordsText,
    reset,
  )
  const [keywordSelectionMinWords, setKeywordSelectionMinWords] = useDraftValue(
    keywordSelectionMinWordsText,
    reset,
  )
  const [keywordSelectionMaxWords, setKeywordSelectionMaxWords] = useDraftValue(
    keywordSelectionMaxWordsText,
    reset,
  )
  const [jobMetadataPromptMaxChars, setJobMetadataPromptMaxChars] = useDraftValue(
    jobMetadataPromptMaxCharsText,
    reset,
  )
  const [jobMetadataMinConfidence, setJobMetadataMinConfidence] = useDraftValue(
    jobMetadataMinConfidenceText,
    reset,
  )
  const [skillAdditionLimit, setSkillAdditionLimit] = useDraftValue(skillAdditionLimitText, reset)
  const [optionAMinExperience, setOptionAMinExperience] = useDraftValue(
    optionAMinExperienceText,
    reset,
  )
  const [optionAMaxExperience, setOptionAMaxExperience] = useDraftValue(
    optionAMaxExperienceText,
    reset,
  )
  const [optionAMinProjects, setOptionAMinProjects] = useDraftValue(optionAMinProjectsText, reset)
  const [optionAMaxProjects, setOptionAMaxProjects] = useDraftValue(optionAMaxProjectsText, reset)
  const [optionAMaxExperienceBullets, setOptionAMaxExperienceBullets] = useDraftValue(
    optionAMaxExperienceBulletsText,
    reset,
  )
  const [optionAMaxProjectBullets, setOptionAMaxProjectBullets] = useDraftValue(
    optionAMaxProjectBulletsText,
    reset,
  )
  const [optionAExperiencePositionBonus, setOptionAExperiencePositionBonus] = useDraftValue(
    optionAExperiencePositionBonusText,
    reset,
  )
  const [optionAProjectPositionBonus, setOptionAProjectPositionBonus] = useDraftValue(
    optionAProjectPositionBonusText,
    reset,
  )
  const [optionABulletPositionBonus, setOptionABulletPositionBonus] = useDraftValue(
    optionABulletPositionBonusText,
    reset,
  )

  const { mutation, save, syncRetry, syncWarnings } = useBatchSave(setSettings)
  const updates = changedSettings(
    settings ?? [],
    [
      [JOB_METADATA_ROLE_FAMILIES_KEY, JSON.stringify(textToList(roleFamilies)), 'json'],
      [JOB_METADATA_JOB_LEVELS_KEY, JSON.stringify(textToList(jobLevels)), 'json'],
      [C2_TARGET_LANE_POLICY_KEY, targetLanePolicy, 'text'],
      [C2_KEYWORD_KEEP_POLICY_KEY, keywordKeepPolicy, 'text'],
      [C2_KEYWORD_IGNORE_POLICY_KEY, keywordIgnorePolicy, 'text'],
      [C2_SUMMARY_KEYWORD_POLICY_KEY, summaryKeywordPolicy, 'text'],
      [C2_SKILL_ADDITION_POLICY_KEY, skillAdditionPolicy, 'text'],
      [C2_SUMMARY_GOOD_EXAMPLE_KEY, summaryGoodExample, 'text'],
      [C2_REWRITE_STRATEGY_KEY, rewriteStrategy, 'text'],
      [C2_REWRITE_KEYWORD_FIT_POLICY_KEY, rewriteKeywordFitPolicy, 'text'],
      [C2_REWRITE_BULLET_POLICY_KEY, rewriteBulletPolicy, 'text'],
      [C2_REWRITE_LENGTH_POLICY_KEY, rewriteLengthPolicy, 'text'],
      [C2_REWRITE_ACTION_KEYWORD_POLICY_KEY, rewriteActionKeywordPolicy, 'text'],
      [C2_DEFAULT_TARGET_TITLE_KEY, defaultTargetTitle, 'text'],
      [C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY, keywordSelectionMaxKeywords, 'text'],
      [C2_KEYWORD_SELECTION_MIN_WORDS_KEY, keywordSelectionMinWords, 'text'],
      [C2_KEYWORD_SELECTION_MAX_WORDS_KEY, keywordSelectionMaxWords, 'text'],
      [C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY, jobMetadataPromptMaxChars, 'text'],
      [C2_JOB_METADATA_MIN_CONFIDENCE_KEY, jobMetadataMinConfidence, 'text'],
      [C2_SKILL_ADDITION_LIMIT_KEY, skillAdditionLimit, 'text'],
      [C2_OPTION_A_MIN_EXPERIENCE_KEY, optionAMinExperience, 'text'],
      [C2_OPTION_A_MAX_EXPERIENCE_KEY, optionAMaxExperience, 'text'],
      [C2_OPTION_A_MIN_PROJECTS_KEY, optionAMinProjects, 'text'],
      [C2_OPTION_A_MAX_PROJECTS_KEY, optionAMaxProjects, 'text'],
      [C2_OPTION_A_MAX_EXPERIENCE_BULLETS_KEY, optionAMaxExperienceBullets, 'text'],
      [C2_OPTION_A_MAX_PROJECT_BULLETS_KEY, optionAMaxProjectBullets, 'text'],
      [C2_OPTION_A_EXPERIENCE_POSITION_BONUS_KEY, optionAExperiencePositionBonus, 'text'],
      [C2_OPTION_A_PROJECT_POSITION_BONUS_KEY, optionAProjectPositionBonus, 'text'],
      [C2_OPTION_A_BULLET_POSITION_BONUS_KEY, optionABulletPositionBonus, 'text'],
      [C2_UNSUPPORTED_TARGET_EXAMPLES_KEY, JSON.stringify(textToList(unsupportedExamples)), 'json'],
      [C2_BLOCKED_KEYWORDS_KEY, JSON.stringify(textToList(blockedKeywords)), 'json'],
      [C2_SUMMARY_BANNED_PHRASES_KEY, JSON.stringify(textToList(summaryBannedPhrases)), 'json'],
    ],
    {
      [JOB_METADATA_ROLE_FAMILIES_KEY]: JSON.stringify(textToList(roleFamilyText)),
      [JOB_METADATA_JOB_LEVELS_KEY]: JSON.stringify(textToList(jobLevelText)),
      [C2_TARGET_LANE_POLICY_KEY]: targetLanePolicyText,
      [C2_KEYWORD_KEEP_POLICY_KEY]: keywordKeepPolicyText,
      [C2_KEYWORD_IGNORE_POLICY_KEY]: keywordIgnorePolicyText,
      [C2_SUMMARY_KEYWORD_POLICY_KEY]: summaryKeywordPolicyText,
      [C2_SKILL_ADDITION_POLICY_KEY]: skillAdditionPolicyText,
      [C2_SUMMARY_GOOD_EXAMPLE_KEY]: summaryGoodExampleText,
      [C2_REWRITE_STRATEGY_KEY]: rewriteStrategyText,
      [C2_REWRITE_KEYWORD_FIT_POLICY_KEY]: rewriteKeywordFitPolicyText,
      [C2_REWRITE_BULLET_POLICY_KEY]: rewriteBulletPolicyText,
      [C2_REWRITE_LENGTH_POLICY_KEY]: rewriteLengthPolicyText,
      [C2_REWRITE_ACTION_KEYWORD_POLICY_KEY]: rewriteActionKeywordPolicyText,
      [C2_DEFAULT_TARGET_TITLE_KEY]: defaultTargetTitleText,
      [C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY]: keywordSelectionMaxKeywordsText,
      [C2_KEYWORD_SELECTION_MIN_WORDS_KEY]: keywordSelectionMinWordsText,
      [C2_KEYWORD_SELECTION_MAX_WORDS_KEY]: keywordSelectionMaxWordsText,
      [C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY]: jobMetadataPromptMaxCharsText,
      [C2_JOB_METADATA_MIN_CONFIDENCE_KEY]: jobMetadataMinConfidenceText,
      [C2_SKILL_ADDITION_LIMIT_KEY]: skillAdditionLimitText,
      [C2_OPTION_A_MIN_EXPERIENCE_KEY]: optionAMinExperienceText,
      [C2_OPTION_A_MAX_EXPERIENCE_KEY]: optionAMaxExperienceText,
      [C2_OPTION_A_MIN_PROJECTS_KEY]: optionAMinProjectsText,
      [C2_OPTION_A_MAX_PROJECTS_KEY]: optionAMaxProjectsText,
      [C2_OPTION_A_MAX_EXPERIENCE_BULLETS_KEY]: optionAMaxExperienceBulletsText,
      [C2_OPTION_A_MAX_PROJECT_BULLETS_KEY]: optionAMaxProjectBulletsText,
      [C2_OPTION_A_EXPERIENCE_POSITION_BONUS_KEY]: optionAExperiencePositionBonusText,
      [C2_OPTION_A_PROJECT_POSITION_BONUS_KEY]: optionAProjectPositionBonusText,
      [C2_OPTION_A_BULLET_POSITION_BONUS_KEY]: optionABulletPositionBonusText,
      [C2_UNSUPPORTED_TARGET_EXAMPLES_KEY]: JSON.stringify(textToList(unsupportedExamplesText)),
      [C2_BLOCKED_KEYWORDS_KEY]: JSON.stringify(textToList(blockedKeywordText)),
      [C2_SUMMARY_BANNED_PHRASES_KEY]: JSON.stringify(textToList(summaryBannedPhraseText)),
    },
  )
  async function reload() {
    const result = await query.refetch()
    if (!result.data || result.isError || !mounted.current) return
    setSettings(result.data.settings)
    setReset((value) => value + 1)
    mutation.reset()
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>C2 job metadata</h2>
      </div>
      {!settings && (
        <p role={query.isError ? 'alert' : 'status'}>
          {query.isError
            ? 'Could not load saved metadata settings.'
            : 'Loading saved metadata settings…'}
        </p>
      )}
      {query.isError && (
        <button className={styles.btn} onClick={() => void query.refetch()}>
          Retry saved metadata
        </button>
      )}
      <fieldset disabled={!settings} style={{ border: 0, padding: 0, minWidth: 0 }}>
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
            <span className={styles.fieldHint}>
              Retention boost for earlier bullets in a bucket.
            </span>
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

        {mutation.error && (
          <p className={styles.errorMsg} role="alert">
            {mutation.error.message} Your draft is preserved.
          </p>
        )}
        {!!syncWarnings.length && (
          <div role="alert" className={styles.errorMsg}>
            {syncWarnings.join(' ')}
            <button
              className={styles.btn}
              disabled={mutation.isPending}
              onClick={() => void save(syncRetry)}
            >
              Retry template sync
            </button>
          </div>
        )}
        <div className={styles.footer}>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={mutation.isPending || !settings || !updates.length}
            onClick={() => void save(updates)}
          >
            {mutation.isPending ? 'Saving...' : 'Save metadata values'}
          </button>
          <button
            className={styles.btn}
            disabled={mutation.isPending}
            onClick={() => void reload()}
          >
            Discard draft and reload
          </button>
        </div>
      </fieldset>
    </div>
  )
}

// ---- main page -------------------------------------------------------------

type SettingsTab = 'c1' | 'c2' | 'integrations'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'c1', label: 'Hunter' },
  { id: 'c2', label: 'Fletcher' },
  { id: 'integrations', label: 'Integrations' },
]

export function SettingsPage() {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const mounted = useMounted()
  const saving = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [errorSection, setErrorSection] = useState<string | null>(null)
  const [configReset, setConfigReset] = useState(0)
  const [activeTab, setActiveTab] = useState<SettingsTab>('c2')
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
    refetch,
  } = useQuery({
    queryKey: ['c1-config'],
    queryFn: fetchC1Config,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })

  const mutation = useMutation({
    mutationFn: saveC1Config,
    onSuccess: (res) => {
      if (!mounted.current) return
      showToast(`Saved: ${res.updated_keys.join(', ')}`)
      qc.setQueryData<C1Config>(['c1-config'], (previous) =>
        previous ? { ...previous, ...res.config, revision: res.revision } : previous,
      )
    },
    onError: (e) => {
      if (mounted.current) setSaveError(e.message)
    },
    onSettled: () => {
      saving.current = false
      if (mounted.current) setSavingSection(null)
    },
  })

  function save(section: string, updates: C1ConfigUpdates) {
    if (saving.current || !cfg) return
    setErrorSection(section)
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value !== 'number') continue
      const minimum = key.startsWith('enrichment_alert_')
        ? 0
        : key === 'run_interval_seconds'
          ? 60
          : key === 'enrichment_timeout_ms'
            ? 5000
            : 1
      if (
        !Number.isInteger(value) ||
        value < minimum ||
        (key === 'enrichment_alert_failure_rate_percent' && value > 100)
      ) {
        showToast(`Enter a valid whole number for ${key.replace(/_/g, ' ')}.`, 'error')
        return
      }
    }
    if (!cfg.revision) {
      setSaveError('C1 must be updated to support checked settings saves. Your draft is preserved.')
      return
    }
    saving.current = true
    setSaveError(null)
    setSavingSection(section)
    mutation.mutate({ ...updates, expected_revision: cfg.revision })
  }

  async function reloadConfig() {
    const result = await refetch()
    if (!result.data || result.isError || !mounted.current) return
    setConfigReset((value) => value + 1)
    setSaveError(null)
  }

  const c1Content = (() => {
    if (isLoading) {
      return (
        <div className={styles.panel}>
          <p className="muted">Loading config from C1...</p>
        </div>
      )
    }
    if (!cfg) {
      return (
        <div className={styles.panel}>
          <p className={styles.errorMsg} role="alert">
            Could not load C1 config. Your settings have not been changed.
          </p>
          <button className={styles.btn} onClick={() => void refetch()}>
            Retry C1 settings
          </button>
        </div>
      )
    }
    return (
      <>
        <div className={styles.notice}>
          Saved changes take effect after restarting C1 and its scheduler. The current scan keeps
          its existing settings.
        </div>
        <DiscoveryFilters
          error={errorSection === 'filters' ? saveError : null}
          onReload={() => void reloadConfig()}
          cfg={cfg}
          saving={mutation.isPending && savingSection === 'filters'}
          onSave={(u) => save('filters', u)}
        />
        <SearchConfig
          error={errorSection === 'search' ? saveError : null}
          onReload={() => void reloadConfig()}
          cfg={cfg}
          saving={mutation.isPending && savingSection === 'search'}
          onSave={(u) => save('search', u)}
        />
        <RunSettings
          error={errorSection === 'run' ? saveError : null}
          onReload={() => void reloadConfig()}
          cfg={cfg}
          saving={mutation.isPending && savingSection === 'run'}
          onSave={(u) => save('run', u)}
        />
        <AlertSettings
          error={errorSection === 'alerts' ? saveError : null}
          onReload={() => void reloadConfig()}
          cfg={cfg}
          saving={mutation.isPending && savingSection === 'alerts'}
          onSave={(u) => save('alerts', u)}
        />
      </>
    )
  })()

  const integrationsContent = (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>Integrations</h2>
      </div>
      <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
        Sends a test message to the configured Discord channel.
      </p>
      <button className={styles.btn} disabled={testingDiscord} onClick={handleTestDiscord}>
        {testingDiscord ? 'Sending...' : 'Test Discord webhook'}
      </button>
      {discordResult && <p style={{ marginTop: 8, fontSize: '0.88rem' }}>{discordResult}</p>}
    </div>
  )

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Settings</h1>
      </section>

      <div className={styles.tabBar} role="group" aria-label="Settings components">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={activeTab === tab.id}
            className={`${styles.tabButton} ${activeTab === tab.id ? styles.tabButtonActive : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div hidden={activeTab !== 'c1'}>
        {error && cfg && (
          <p role="alert" className={styles.errorMsg}>
            Could not refresh C1 settings. Your draft is preserved.
          </p>
        )}
        <div key={configReset}>{c1Content}</div>
      </div>

      <div hidden={activeTab !== 'c2'}>
        <C2ProviderRuntimeSettings />
        <AppNotificationSettings />
        <details className={styles.panel}>
          <summary className={styles.sectionSummary}>Advanced tailoring rules</summary>
          <JobMetadataSettings />
        </details>
      </div>

      <div hidden={activeTab !== 'integrations'}>{integrationsContent}</div>
    </div>
  )
}
