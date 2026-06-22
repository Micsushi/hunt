import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  batchDownloadFletcherJobs,
  cancelFletcherJob,
  cancelFletcherJobs,
  clearGeneratedResumes,
  deleteFletcherJob,
  enqueueFletcherJob,
  fetchFletcherJobs,
  fetchC2Status,
  moveFletcherJob,
} from '@/api/control'
import type { FletcherBatchArtifact } from '@/api/control'
import { useUiStore } from '@/store/ui'
import styles from './Fletcher.module.css'
import {
  loadPersistedFletcherResumeFile,
  savePersistedFletcherResumeFile,
} from './persistedResumeFile'
import type { FletcherQueueItem } from './review/types'

const FLETCHER_FORM_STORAGE_KEY = 'hunt.fletcher.optionBForm'
const FLETCHER_JOB_ID_STORAGE_KEY = 'hunt.fletcher.optionAJobId'
const FLETCHER_DISPLAY_PROGRESS_STORAGE_KEY = 'hunt.fletcher.displayedProgress'
const ACTIVE_FLETCHER_STATUSES = new Set(['queued', 'running', 'cancel_requested'])
const FLETCHER_QUEUE_ACTIVE_REFETCH_MS = 5000
const FLETCHER_QUEUE_IDLE_REFETCH_MS = 30000
const FLETCHER_PROGRESS_TICK_MS = 50
const FLETCHER_PROGRESS_CRUISE_STEP_MS = 500
const FLETCHER_PROGRESS_FINAL_STEP_MS = 200
const FLETCHER_PROGRESS_SLOW_DELAY_MULTIPLIER = 1.5
const FLETCHER_PROGRESS_VERY_SLOW_DELAY_MULTIPLIER = 2
const FLETCHER_PROGRESS_VERY_SLOW_AT = 95
const FLETCHER_PROGRESS_CAP_MIN = 80
const FLETCHER_PROGRESS_CAP_MAX = 90
const FLETCHER_COMPLETION_HOLD_MS = 500
const BATCH_ARTIFACT_OPTIONS: { id: FletcherBatchArtifact; label: string }[] = [
  { id: 'log', label: 'Logs' },
  { id: 'starting_pdf', label: 'Starting PDF' },
  { id: 'no_summary_pdf', label: 'Resume PDF : no summary' },
  { id: 'with_summary_pdf', label: 'Resume PDF : with summary' },
  { id: 'starting_tex', label: 'Starting TeX' },
  { id: 'no_summary_tex', label: 'TeX : no summary' },
  { id: 'with_summary_tex', label: 'TeX : with summary' },
]

type FletcherJobsCache = { jobs: FletcherQueueItem[] }

function readStoredText(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function readStoredOptionBForm(): { jobDetails: string } {
  try {
    const raw = localStorage.getItem(FLETCHER_FORM_STORAGE_KEY)
    if (!raw) return { jobDetails: '' }
    const parsed = JSON.parse(raw) as Partial<{ jobDetails: string }>
    return {
      jobDetails: typeof parsed.jobDetails === 'string' ? parsed.jobDetails : '',
    }
  } catch {
    return { jobDetails: '' }
  }
}

function formatRunTime(value: string | null | undefined): string {
  if (!value) return 'Not started'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function fletcherTitle(job: FletcherQueueItem): string {
  return [job.input.title || 'Untitled pasted JD', job.input.company].filter(Boolean).join(' : ')
}

function fletcherLogFilename(job: FletcherQueueItem): string {
  const rawTime = job.finished_at || job.started_at || job.created_at || ''
  const match = rawTime.match(/(\d{4})\D+(\d{2})\D+(\d{2})\D+(\d{2})\D+(\d{2})\D+(\d{2})/)
  const timestamp = match
    ? `${match[1]}-${match[2]}-${match[3]}_${match[4]}-${match[5]}-${match[6]}`
    : new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')
  return `log_resume_generation_${timestamp}.log`
}

function fletcherProgressPercent(job: FletcherQueueItem): number | null {
  const value = job.progress.percent
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

interface DisplayedProgress {
  value: number
  lastTickAt: number
  currentTarget: number
  nextDelayMs: number
  preCompleteCap: number
  completedAt?: number
  activeInCurrentView?: boolean
}

function fletcherStepProgressTarget(job: FletcherQueueItem, progress: DisplayedProgress): number {
  const reportedPercent = fletcherProgressPercent(job) ?? 0
  if (job.status === 'succeeded' || reportedPercent >= 100) return 100
  if (job.status === 'failed' || job.status === 'cancelled') return progress.value
  if (progress.value < progress.preCompleteCap) return progress.preCompleteCap
  return Math.min(99, progress.value + 1)
}

function nextSmoothedProgress(progress: DisplayedProgress, target: number, now: number): number {
  const current = progress.value
  if (target <= current) return current
  if (now - progress.lastTickAt < progress.nextDelayMs) return current
  return Math.min(target, current + 1)
}

function fletcherProgressDelayMultiplier(value: number): number {
  return value >= FLETCHER_PROGRESS_VERY_SLOW_AT
    ? FLETCHER_PROGRESS_VERY_SLOW_DELAY_MULTIPLIER
    : FLETCHER_PROGRESS_SLOW_DELAY_MULTIPLIER
}

function runTimeMillis(value: string | null | undefined): number {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

function fletcherPreCompleteCap(queueItemId: string): number {
  let hash = 0
  for (let i = 0; i < queueItemId.length; i += 1) {
    hash = (hash * 31 + queueItemId.charCodeAt(i)) >>> 0
  }
  return (
    FLETCHER_PROGRESS_CAP_MIN + (hash % (FLETCHER_PROGRESS_CAP_MAX - FLETCHER_PROGRESS_CAP_MIN + 1))
  )
}

function readDisplayedProgress(): Record<string, DisplayedProgress> {
  try {
    const raw = localStorage.getItem(FLETCHER_DISPLAY_PROGRESS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Partial<DisplayedProgress>>
    const now = Date.now()
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([queueItemId, value]) => {
        const storedValue =
          typeof value.value === 'number' && Number.isFinite(value.value)
            ? Math.max(0, Math.min(100, Math.round(value.value)))
            : null
        if (storedValue === null) return []
        const preCompleteCap =
          typeof value.preCompleteCap === 'number' && Number.isFinite(value.preCompleteCap)
            ? Math.max(
                FLETCHER_PROGRESS_CAP_MIN,
                Math.min(FLETCHER_PROGRESS_CAP_MAX, Math.round(value.preCompleteCap)),
              )
            : fletcherPreCompleteCap(queueItemId)
        return [
          [
            queueItemId,
            {
              value: storedValue,
              lastTickAt: now,
              currentTarget:
                typeof value.currentTarget === 'number' && Number.isFinite(value.currentTarget)
                  ? Math.max(0, Math.min(100, Math.round(value.currentTarget)))
                  : storedValue,
              nextDelayMs:
                typeof value.nextDelayMs === 'number' && Number.isFinite(value.nextDelayMs)
                  ? Math.max(FLETCHER_PROGRESS_FINAL_STEP_MS, value.nextDelayMs)
                  : FLETCHER_PROGRESS_CRUISE_STEP_MS,
              preCompleteCap,
              completedAt:
                typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
                  ? value.completedAt
                  : undefined,
            },
          ],
        ]
      }),
    )
  } catch {
    return {}
  }
}

function historySearchText(job: FletcherQueueItem): string {
  return [
    fletcherTitle(job),
    job.status,
    job.input.description,
    job.input.resume_filename,
    job.error,
    formatRunTime(job.started_at || job.created_at),
    formatRunTime(job.finished_at),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function fletcherSourceLabel(job: FletcherQueueItem): string {
  return job.input.job_id ? `Option A : Hunt job ${job.input.job_id}` : 'Option B : pasted JD'
}

function fletcherQueueRefetchInterval(query: {
  state: { data?: { jobs?: FletcherQueueItem[] } }
}): number {
  const jobs = query.state.data?.jobs || []
  return jobs.some((job) => ACTIVE_FLETCHER_STATUSES.has(job.status))
    ? FLETCHER_QUEUE_ACTIVE_REFETCH_MS
    : FLETCHER_QUEUE_IDLE_REFETCH_MS
}

function upsertFletcherJob(cache: FletcherJobsCache | undefined, job: FletcherQueueItem) {
  const jobs = cache?.jobs || []
  const existingIndex = jobs.findIndex((item) => item.queue_item_id === job.queue_item_id)
  if (existingIndex >= 0) {
    return {
      jobs: jobs.map((item, index) => (index === existingIndex ? job : item)),
    }
  }
  return { jobs: [job, ...jobs] }
}

export function FletcherPage() {
  const [jobId, setJobId] = useState(() => readStoredText(FLETCHER_JOB_ID_STORAGE_KEY))
  const [jobIdResult, setJobIdResult] = useState<unknown>(null)
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()

  const [jobDetails, setJobDetails] = useState(() => readStoredOptionBForm().jobDetails)
  const resumeFile = useUiStore((s) => s.fletcherResumeFile)
  const setResumeFile = useUiStore((s) => s.setFletcherResumeFile)
  const [resumeStorageReady, setResumeStorageReady] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const {
    data: statusData,
    isLoading: statusLoading,
    isError: statusError,
  } = useQuery({
    queryKey: ['c2-status'],
    queryFn: fetchC2Status,
    refetchInterval: 30_000,
    retry: false,
  })

  const { data: queueData } = useQuery({
    queryKey: ['fletcher-jobs', 100],
    queryFn: () => fetchFletcherJobs(100),
    refetchInterval: fletcherQueueRefetchInterval,
  })

  useEffect(() => {
    try {
      localStorage.setItem(FLETCHER_JOB_ID_STORAGE_KEY, jobId)
    } catch {
      // Ignore storage failures; the form should still work.
    }
  }, [jobId])

  useEffect(() => {
    try {
      localStorage.setItem(FLETCHER_FORM_STORAGE_KEY, JSON.stringify({ jobDetails }))
    } catch {
      // Ignore storage failures; the form should still work.
    }
  }, [jobDetails])

  useEffect(() => {
    let cancelled = false
    loadPersistedFletcherResumeFile()
      .then((file) => {
        if (cancelled || !file) return
        if (!useUiStore.getState().fletcherResumeFile) {
          setResumeFile(file)
        }
      })
      .catch(() => {
        // Persistence is a convenience; the file picker still works without it.
      })
      .finally(() => {
        if (!cancelled) setResumeStorageReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [setResumeFile])

  useEffect(() => {
    if (!resumeStorageReady) return
    savePersistedFletcherResumeFile(resumeFile).catch(() => {
      // The selected file should still work for this session if persistence is unavailable.
    })
  }, [resumeFile, resumeStorageReady])

  const generate = useMutation({
    mutationFn: (id: number) => enqueueFletcherJob({ jobId: id }),
    onSuccess: (res) => {
      setJobIdResult(res)
      showToast('Fletcher job queued')
      qc.setQueriesData<FletcherJobsCache>({ queryKey: ['fletcher-jobs'] }, (cache) =>
        upsertFletcherJob(cache, res),
      )
      qc.invalidateQueries({ queryKey: ['fletcher-jobs'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Queue failed', 'error'),
  })

  const enqueue = useMutation({
    mutationFn: () => enqueueFletcherJob({ description: jobDetails, resume: resumeFile }),
    onSuccess: (res) => {
      showToast('Fletcher job queued')
      setJobDetails('')
      qc.setQueriesData<FletcherJobsCache>({ queryKey: ['fletcher-jobs'] }, (cache) =>
        upsertFletcherJob(cache, res),
      )
      qc.invalidateQueries({ queryKey: ['fletcher-jobs'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Queue failed', 'error'),
  })

  const moveJob = useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: 'up' | 'down' }) =>
      moveFletcherJob(id, direction),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fletcher-jobs'] }),
  })

  const cancelJob = useMutation({
    mutationFn: (id: string) => cancelFletcherJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fletcher-jobs'] }),
  })

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) setResumeFile(file)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
  }

  function submitJobId() {
    const id = Number(jobId)
    if (!Number.isInteger(id) || id < 1) {
      showToast('Job ID required', 'error')
      return
    }
    generate.mutate(id)
  }

  function submitTailor() {
    if (!jobDetails.trim()) {
      showToast('Job details required', 'error')
      return
    }
    if (!resumeFile) {
      showToast('Resume file required', 'error')
      return
    }
    enqueue.mutate()
  }

  const serviceOnline = !statusError && !!statusData
  const activeFletcherJobs = (queueData?.jobs || []).filter((job) =>
    ACTIVE_FLETCHER_STATUSES.has(job.status),
  )
  const matchingActiveJob = activeFletcherJobs.find(
    (job) => (job.input.description || '').trim() === jobDetails.trim(),
  )
  const optionBSubmitDisabled = enqueue.isPending || !!matchingActiveJob
  const optionBSubmitText = enqueue.isPending
    ? 'Queueing...'
    : matchingActiveJob?.status === 'running'
      ? 'Resume run in progress'
      : matchingActiveJob
        ? 'Resume run queued'
        : 'Queue resume run'

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.heroTitle}>Fletcher</h1>
          <div className={styles.heroMeta}>C2 - resume tailoring service</div>
        </div>
        <div
          className={`${styles.statusPill} ${serviceOnline ? styles.statusPillOnline : styles.statusPillOffline}`}
        >
          <span className={styles.statusDot} />
          {statusLoading ? 'Checking...' : serviceOnline ? 'Service online' : 'Service offline'}
        </div>
      </div>

      <div className={styles.workflowGrid}>
        {/* Path A */}
        <div className={styles.panel}>
          <div className={styles.workflowLabel}>Option A</div>
          <h2 className={styles.workflowTitle}>Generate for queued job</h2>
          <p className={styles.workflowDesc}>
            Trigger resume tailoring for a job already in the pipeline by its ID.
          </p>
          <div className={styles.formGrid} style={{ marginTop: 16 }}>
            <label className={styles.field}>
              Job ID
              <input
                className={styles.input}
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 14450"
              />
            </label>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={generate.isPending}
              onClick={submitJobId}
            >
              {generate.isPending ? 'Queueing...' : 'Queue resume run'}
            </button>
          </div>
          {jobIdResult ? (
            <pre className={styles.pre}>{JSON.stringify(jobIdResult, null, 2)}</pre>
          ) : null}
        </div>

        <div className={styles.orDivider}>or</div>

        {/* Path B */}
        <div className={styles.panel}>
          <div className={styles.workflowLabel}>Option B</div>
          <h2 className={styles.workflowTitle}>Tailor from description</h2>
          <p className={styles.workflowDesc}>
            Paste a job description and upload your resume to generate a tailored PDF.
          </p>
          <div className={styles.formGrid} style={{ marginTop: 16 }}>
            <label className={styles.field}>
              Job details
              <textarea
                className={styles.textarea}
                value={jobDetails}
                onChange={(e) => setJobDetails(e.target.value)}
                placeholder="Paste the job title, company, and full description here..."
              />
            </label>
            <label className={styles.field}>
              Resume file
              <div
                className={`${styles.fileRow} ${isDragging ? styles.fileRowDragging : ''}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
              >
                <label
                  className={`${styles.fileLabel} ${resumeFile ? styles.fileLabelActive : ''}`}
                >
                  {resumeFile ? resumeFile.name : 'Choose .pdf or .tex file'}
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".tex,.pdf"
                    className={styles.fileInput}
                    onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                {resumeFile ? (
                  <button
                    className={styles.btn}
                    onClick={() => {
                      setResumeFile(null)
                      if (fileRef.current) fileRef.current.value = ''
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </label>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={optionBSubmitDisabled}
              onClick={submitTailor}
              style={{ alignSelf: 'flex-start' }}
            >
              {optionBSubmitText}
            </button>
            {matchingActiveJob ? (
              <div className={styles.activeRunNotice}>
                This description already has a background run. Open it from the queue below when it
                finishes.
              </div>
            ) : activeFletcherJobs.length ? (
              <div className={styles.activeRunNotice}>
                {activeFletcherJobs.length} background run
                {activeFletcherJobs.length === 1 ? '' : 's'} active. You can still queue a different
                resume.
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <FletcherQueuePanel
        jobs={queueData?.jobs || []}
        onMove={(id, direction) => moveJob.mutate({ id, direction })}
        onCancel={(id) => cancelJob.mutate(id)}
      />
    </div>
  )
}

function FletcherQueuePanel({
  jobs,
  onMove,
  onCancel,
}: {
  jobs: FletcherQueueItem[]
  onMove: (id: string, direction: 'up' | 'down') => void
  onCancel: (id: string) => void
}) {
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()
  const [displayedProgress, setDisplayedProgress] = useState<Record<string, DisplayedProgress>>(
    () => readDisplayedProgress(),
  )
  const displayedProgressJobIds = useMemo(
    () => new Set(Object.keys(displayedProgress)),
    [displayedProgress],
  )
  const activeJobs = useMemo(() => {
    return jobs
      .filter((job) => {
        if (ACTIVE_FLETCHER_STATUSES.has(job.status)) return true
        return (
          job.status === 'succeeded' &&
          displayedProgressJobIds.has(job.queue_item_id) &&
          displayedProgress[job.queue_item_id]?.activeInCurrentView
        )
      })
      .sort((a, b) => {
        const aCompleting =
          a.status === 'succeeded' &&
          displayedProgressJobIds.has(a.queue_item_id) &&
          displayedProgress[a.queue_item_id]?.activeInCurrentView
        const bCompleting =
          b.status === 'succeeded' &&
          displayedProgressJobIds.has(b.queue_item_id) &&
          displayedProgress[b.queue_item_id]?.activeInCurrentView
        if (aCompleting !== bCompleting) return aCompleting ? -1 : 1
        return 0
      })
  }, [displayedProgress, displayedProgressJobIds, jobs])
  const completingProgressJobIds = useMemo(
    () =>
      new Set(
        jobs
          .filter(
            (job) =>
              job.status === 'succeeded' &&
              displayedProgressJobIds.has(job.queue_item_id) &&
              displayedProgress[job.queue_item_id]?.activeInCurrentView,
          )
          .map((job) => job.queue_item_id),
      ),
    [displayedProgress, displayedProgressJobIds, jobs],
  )
  const progressBlockedByFinishingJob = completingProgressJobIds.size > 0
  const historyBlockedJobIds = completingProgressJobIds
  const historyJobs = useMemo(
    () =>
      jobs
        .filter(
          (job) =>
            !ACTIVE_FLETCHER_STATUSES.has(job.status) &&
            !historyBlockedJobIds.has(job.queue_item_id),
        )
        .sort((a, b) => runTimeMillis(b.finished_at) - runTimeMillis(a.finished_at)),
    [historyBlockedJobIds, jobs],
  )
  const [historySearch, setHistorySearch] = useState('')
  const [detailJob, setDetailJob] = useState<FletcherQueueItem | null>(null)
  const [selectedActiveIds, setSelectedActiveIds] = useState<string[]>([])
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([])
  const [batchOptionsOpen, setBatchOptionsOpen] = useState(false)
  const [batchDownloading, setBatchDownloading] = useState(false)
  const [batchArtifacts, setBatchArtifacts] = useState<Record<FletcherBatchArtifact, boolean>>({
    log: true,
    starting_pdf: false,
    no_summary_pdf: true,
    with_summary_pdf: false,
    starting_tex: false,
    no_summary_tex: false,
    with_summary_tex: false,
  })
  const normalizedHistorySearch = historySearch.trim().toLowerCase()
  const visibleHistoryJobs = normalizedHistorySearch
    ? historyJobs.filter((job) => historySearchText(job).includes(normalizedHistorySearch))
    : historyJobs
  const historyIdSet = new Set(visibleHistoryJobs.map((job) => job.queue_item_id))
  const selectedHistoryIdsInView = selectedHistoryIds.filter((id) => historyIdSet.has(id))
  const selectedHistoryIdSet = new Set(selectedHistoryIdsInView)
  const allHistorySelected =
    visibleHistoryJobs.length > 0 &&
    visibleHistoryJobs.every((job) => selectedHistoryIdSet.has(job.queue_item_id))
  const activeIdSet = new Set(activeJobs.map((job) => job.queue_item_id))
  const selectedActiveIdsInView = selectedActiveIds.filter((id) => activeIdSet.has(id))
  const selectedActiveIdSet = new Set(selectedActiveIdsInView)
  const allActiveSelected =
    activeJobs.length > 0 && activeJobs.every((job) => selectedActiveIdSet.has(job.queue_item_id))
  const deleteHistory = useMutation({
    mutationFn: async (queueItemIds: string[]) => {
      await Promise.all(queueItemIds.map((id) => deleteFletcherJob(id)))
      return queueItemIds
    },
    onSuccess: (queueItemIds) => {
      setSelectedHistoryIds((current) => current.filter((id) => !queueItemIds.includes(id)))
      setDetailJob((current) =>
        current && queueItemIds.includes(current.queue_item_id) ? null : current,
      )
      qc.invalidateQueries({ queryKey: ['fletcher-jobs'] })
      showToast(
        `${queueItemIds.length} Fletcher histor${queueItemIds.length === 1 ? 'y entry' : 'y entries'} deleted`,
      )
    },
    onError: (e) =>
      showToast(e instanceof Error ? e.message : 'Delete Fletcher history failed', 'error'),
  })
  const clearResumes = useMutation({
    mutationFn: () => clearGeneratedResumes({ includeAdHoc: false, deleteArtifacts: true }),
    onSuccess: (result) => {
      setSelectedHistoryIds([])
      setDetailJob(null)
      qc.invalidateQueries({ queryKey: ['fletcher-jobs'] })
      showToast(
        `Cleared ${result.resume_attempts_deleted} resume attempt${
          result.resume_attempts_deleted === 1 ? '' : 's'
        } and ${result.fletcher_jobs_deleted} history run${
          result.fletcher_jobs_deleted === 1 ? '' : 's'
        }`,
      )
    },
    onError: (e) =>
      showToast(e instanceof Error ? e.message : 'Clear generated resumes failed', 'error'),
  })
  const cancelActive = useMutation({
    mutationFn: (queueItemIds: string[]) => cancelFletcherJobs(queueItemIds),
    onSuccess: (result) => {
      const cancelledIds = result.jobs.map((job) => job.queue_item_id)
      setSelectedActiveIds((current) => current.filter((id) => !cancelledIds.includes(id)))
      setDisplayedProgress((current) => {
        const next = { ...current }
        for (const id of cancelledIds) delete next[id]
        return next
      })
      setDetailJob((current) =>
        current && cancelledIds.includes(current.queue_item_id) ? null : current,
      )
      qc.invalidateQueries({ queryKey: ['fletcher-jobs'] })
      showToast(
        `Cancelled ${result.cancelled} Fletcher job${result.cancelled === 1 ? '' : 's'}`,
      )
    },
    onError: (e) =>
      showToast(e instanceof Error ? e.message : 'Cancel Fletcher jobs failed', 'error'),
  })

  useEffect(() => {
    try {
      const compact = Object.fromEntries(
        Object.entries(displayedProgress).map(([queueItemId, progress]) => [
          queueItemId,
          {
            value: progress.value,
            currentTarget: progress.currentTarget,
            nextDelayMs: progress.nextDelayMs,
            preCompleteCap: progress.preCompleteCap,
            completedAt: progress.completedAt,
          },
        ]),
      )
      if (Object.keys(compact).length) {
        localStorage.setItem(FLETCHER_DISPLAY_PROGRESS_STORAGE_KEY, JSON.stringify(compact))
      } else {
        localStorage.removeItem(FLETCHER_DISPLAY_PROGRESS_STORAGE_KEY)
      }
    } catch {
      // Ignore private-mode or quota failures. Progress smoothing is cosmetic.
    }
  }, [displayedProgress])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      const completingJobIds = new Set(
        jobs
          .filter(
            (job) =>
              job.status === 'succeeded' &&
              displayedProgress[job.queue_item_id] &&
              displayedProgress[job.queue_item_id]?.activeInCurrentView,
          )
          .map((job) => job.queue_item_id),
      )
      const progressJobs = jobs.filter((job) => {
        if (job.status === 'queued') return false
        if (completingJobIds.size && !completingJobIds.has(job.queue_item_id)) return false
        if (ACTIVE_FLETCHER_STATUSES.has(job.status)) return true
        return job.status === 'succeeded'
      })
      if (!progressJobs.length) {
        setDisplayedProgress((current) => (Object.keys(current).length ? {} : current))
        return
      }
      setDisplayedProgress((current) => {
        let changed = false
        const next: Record<string, DisplayedProgress> = {}
        const progressJobIds = new Set(progressJobs.map((job) => job.queue_item_id))
        for (const job of progressJobs) {
          const queueItemId = job.queue_item_id
          const existing = current[queueItemId]
          if (job.status === 'succeeded' && (!existing || !existing.activeInCurrentView)) {
            continue
          }
          const preCompleteCap = existing?.preCompleteCap ?? fletcherPreCompleteCap(queueItemId)
          const initialValue = existing ? existing.value : 1
          const initialProgress: DisplayedProgress = existing ?? {
            value: initialValue,
            lastTickAt: now,
            currentTarget: initialValue,
            nextDelayMs: FLETCHER_PROGRESS_CRUISE_STEP_MS,
            preCompleteCap,
            activeInCurrentView: ACTIVE_FLETCHER_STATUSES.has(job.status),
          }
          const target = fletcherStepProgressTarget(job, initialProgress)
          const currentProgress =
            target > initialProgress.currentTarget
              ? {
                  ...initialProgress,
                  currentTarget: target,
                  nextDelayMs:
                    target >= 100
                      ? FLETCHER_PROGRESS_FINAL_STEP_MS
                      : initialProgress.value < initialProgress.preCompleteCap
                        ? FLETCHER_PROGRESS_CRUISE_STEP_MS
                        : initialProgress.nextDelayMs,
                }
              : initialProgress
          const smoothed = nextSmoothedProgress(currentProgress, target, now)
          const ticked = smoothed !== currentProgress.value
          const completedAt =
            smoothed >= 100 ? (currentProgress.completedAt ?? now) : currentProgress.completedAt
          if (completedAt && now - completedAt > FLETCHER_COMPLETION_HOLD_MS) {
            changed = true
            continue
          }
          const nextDelayMs = ticked
            ? target >= 100 || smoothed < currentProgress.preCompleteCap
              ? target >= 100
                ? FLETCHER_PROGRESS_FINAL_STEP_MS
                : FLETCHER_PROGRESS_CRUISE_STEP_MS
              : currentProgress.nextDelayMs * fletcherProgressDelayMultiplier(smoothed)
            : currentProgress.nextDelayMs
          next[queueItemId] = {
            ...currentProgress,
            value: smoothed,
            lastTickAt: ticked ? now : currentProgress.lastTickAt,
            nextDelayMs,
            completedAt,
            activeInCurrentView:
              currentProgress.activeInCurrentView || ACTIVE_FLETCHER_STATUSES.has(job.status),
          }
          if (
            ticked ||
            completedAt !== currentProgress.completedAt ||
            currentProgress.currentTarget !== initialProgress.currentTarget ||
            currentProgress.nextDelayMs !== initialProgress.nextDelayMs
          ) {
            changed = true
          }
        }
        if (Object.keys(current).some((queueItemId) => !progressJobIds.has(queueItemId))) {
          changed = true
        }
        return changed ? next : current
      })
    }, FLETCHER_PROGRESS_TICK_MS)
    return () => window.clearInterval(timer)
  }, [displayedProgress, jobs])

  function toggleHistorySelection(queueItemId: string, checked: boolean) {
    setSelectedHistoryIds((current) => {
      if (checked) return current.includes(queueItemId) ? current : [...current, queueItemId]
      return current.filter((id) => id !== queueItemId)
    })
  }

  function toggleActiveSelection(queueItemId: string, checked: boolean) {
    setSelectedActiveIds((current) => {
      if (checked) return current.includes(queueItemId) ? current : [...current, queueItemId]
      return current.filter((id) => id !== queueItemId)
    })
  }

  function toggleAllActive(checked: boolean) {
    setSelectedActiveIds(checked ? activeJobs.map((job) => job.queue_item_id) : [])
  }

  function cancelSelectedActive() {
    if (!selectedActiveIdsInView.length) {
      showToast('Select at least one active run', 'error')
      return
    }
    const count = selectedActiveIdsInView.length
    if (!window.confirm(`Cancel ${count} active Fletcher run${count === 1 ? '' : 's'}?`)) {
      return
    }
    cancelActive.mutate(selectedActiveIdsInView)
  }

  function cancelOneActive(queueItemId: string) {
    cancelActive.mutate([queueItemId])
  }

  function toggleAllHistory(checked: boolean) {
    setSelectedHistoryIds(checked ? visibleHistoryJobs.map((job) => job.queue_item_id) : [])
  }

  function selectedBatchArtifacts(): FletcherBatchArtifact[] {
    return BATCH_ARTIFACT_OPTIONS.filter((option) => batchArtifacts[option.id]).map(
      (option) => option.id,
    )
  }

  async function downloadSelectedHistory() {
    const artifacts = selectedBatchArtifacts()
    if (!selectedHistoryIdsInView.length) {
      showToast('Select at least one history run', 'error')
      return
    }
    if (!artifacts.length) {
      showToast('Select at least one artifact type', 'error')
      return
    }
    setBatchDownloading(true)
    try {
      const blob = await batchDownloadFletcherJobs({
        queueItemIds: selectedHistoryIdsInView,
        artifacts,
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `fletcher_history_${new Date().toISOString().slice(0, 10)}.zip`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast('Fletcher history download started')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Batch download failed', 'error')
    } finally {
      setBatchDownloading(false)
    }
  }

  function deleteSelectedHistory() {
    if (!selectedHistoryIdsInView.length) {
      showToast('Select at least one history run', 'error')
      return
    }
    const count = selectedHistoryIdsInView.length
    if (!window.confirm(`Delete ${count} Fletcher history entr${count === 1 ? 'y' : 'ies'}?`)) {
      return
    }
    deleteHistory.mutate(selectedHistoryIdsInView)
  }

  function deleteOneHistory(queueItemId: string, title: string) {
    if (!window.confirm(`Delete Fletcher history entry: ${title}?`)) return
    deleteHistory.mutate([queueItemId])
  }

  function clearGeneratedJobResumes() {
    if (
      !window.confirm(
        'Clear all generated job resumes and Fletcher history for job-linked runs? Active runs will be skipped.',
      )
    ) {
      return
    }
    clearResumes.mutate()
  }

  return (
    <>
      <section className={styles.queuePanel}>
        <div className={styles.queueHeader}>
          <div>
            <h2 className={styles.workflowTitle}>Fletcher queue</h2>
            <div className={styles.workflowDesc}>Background resume runs continue across tabs.</div>
          </div>
          <span className={styles.meta}>
            {activeJobs.length} active job{activeJobs.length === 1 ? '' : 's'}
          </span>
        </div>
        {activeJobs.length ? (
          <div className={styles.batchToolbar}>
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={allActiveSelected}
                onChange={(e) => toggleAllActive(e.target.checked)}
              />
              Select all
            </label>
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={!selectedActiveIdsInView.length || cancelActive.isPending}
              onClick={cancelSelectedActive}
            >
              {cancelActive.isPending ? 'Cancelling...' : 'Cancel selected'}
            </button>
            {selectedActiveIdsInView.length ? (
              <button className={styles.btn} onClick={() => setSelectedActiveIds([])}>
                Clear
              </button>
            ) : null}
            <span className={styles.meta}>{selectedActiveIdsInView.length} selected</span>
          </div>
        ) : null}
        <div className={`${styles.queueList} ${styles.queueListScrollable}`}>
          {activeJobs.length ? (
            activeJobs.map((job) => {
              const progressPercent = fletcherProgressPercent(job)
              const localProgress = displayedProgress[job.queue_item_id]?.value
              const hasDisplayedProgress = typeof localProgress === 'number'
              const displayedPercent =
                typeof localProgress === 'number'
                  ? Math.round(localProgress)
                  : progressPercent === null
                    ? null
                    : Math.round(job.status === 'queued' ? progressPercent : 1)
              const showProgressBar =
                job.status !== 'queued' &&
                displayedPercent !== null &&
                (!progressBlockedByFinishingJob || hasDisplayedProgress)
              return (
                <article
                  className={`${styles.queueCard} ${styles.queueCardActiveSelectable}`}
                  key={job.queue_item_id}
                >
                  <label className={styles.historySelect}>
                    <input
                      type="checkbox"
                      checked={selectedActiveIdSet.has(job.queue_item_id)}
                      aria-label={`Select ${fletcherTitle(job)}`}
                      onChange={(e) => toggleActiveSelection(job.queue_item_id, e.target.checked)}
                    />
                  </label>
                  <div className={styles.queueCopy}>
                    <button
                      className={styles.queueTitleButton}
                      onClick={() => setDetailJob(job)}
                      title={fletcherTitle(job)}
                    >
                      {fletcherTitle(job)}
                    </button>
                    <div className={styles.meta}>
                      {job.status} : {job.progress.current_step || 'waiting'}
                    </div>
                    <div className={styles.meta}>Started: {formatRunTime(job.started_at)}</div>
                    {showProgressBar ? (
                      <div className={styles.progressRow}>
                        <div
                          className={styles.progressTrack}
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={displayedPercent}
                          aria-label={`${fletcherTitle(job)} progress`}
                        >
                          <div
                            className={styles.progressFill}
                            style={{ width: `${displayedPercent}%` }}
                          />
                        </div>
                        <span className={styles.progressText}>{displayedPercent}%</span>
                      </div>
                    ) : null}
                    {job.error ? (
                      <div className={`${styles.llmErrorDetail} ${styles.queueErrorPreview}`}>
                        {job.error}
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.queueActions}>
                    {job.status === 'queued' ? (
                      <>
                        <button
                          className={styles.btn}
                          onClick={() => onMove(job.queue_item_id, 'up')}
                        >
                          Up
                        </button>
                        <button
                          className={styles.btn}
                          onClick={() => onMove(job.queue_item_id, 'down')}
                        >
                          Down
                        </button>
                        <button
                          className={styles.btn}
                          disabled={cancelActive.isPending}
                          onClick={() => cancelOneActive(job.queue_item_id)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : null}
                    {job.status !== 'queued' ? (
                      <button
                        className={`${styles.btn} ${styles.btnDanger}`}
                        disabled={cancelActive.isPending}
                        onClick={() => cancelOneActive(job.queue_item_id)}
                      >
                        Cancel
                      </button>
                    ) : null}
                    {job.result.review_id ? (
                      <a className={styles.btn} href={`/fletcher/reviews/${job.result.review_id}`}>
                        Open workspace
                      </a>
                    ) : null}
                    <a
                      className={styles.btn}
                      href={`/api/fletcher/tailor/jobs/${job.queue_item_id}/log`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View log
                    </a>
                    <a
                      className={styles.btn}
                      href={`/api/fletcher/tailor/jobs/${job.queue_item_id}/log?download=1`}
                      download={fletcherLogFilename(job)}
                    >
                      Download log
                    </a>
                  </div>
                </article>
              )
            })
          ) : (
            <div className={styles.meta}>No active Fletcher jobs.</div>
          )}
        </div>
      </section>

      <section className={styles.queuePanel}>
        <div className={styles.queueHeader}>
          <div>
            <h2 className={styles.workflowTitle}>Fletcher history</h2>
            <div className={styles.workflowDesc}>
              Previous Option B runs are stored in the Hunt DB for this project.
            </div>
          </div>
          <span className={styles.meta}>
            {historyJobs.length} previous run{historyJobs.length === 1 ? '' : 's'}
          </span>
          <button
            className={`${styles.btn} ${styles.btnDanger}`}
            disabled={clearResumes.isPending}
            onClick={clearGeneratedJobResumes}
          >
            {clearResumes.isPending ? 'Clearing...' : 'Clear generated resumes'}
          </button>
        </div>
        {historyJobs.length ? (
          <>
            <div className={styles.historyFilterBar}>
              <label className={styles.historySearchField}>
                Search history
                <input
                  className={styles.input}
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search title, status, file, error, or time..."
                />
              </label>
              <span className={styles.meta}>
                Showing {visibleHistoryJobs.length} of {historyJobs.length}
              </span>
            </div>
            <div className={styles.batchToolbar}>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={allHistorySelected}
                  onChange={(e) => toggleAllHistory(e.target.checked)}
                />
                Select all
              </label>
              <button
                className={styles.btn}
                disabled={!selectedHistoryIdsInView.length}
                onClick={() => setBatchOptionsOpen((open) => !open)}
              >
                Download selected
              </button>
              <button
                className={`${styles.btn} ${styles.btnDanger}`}
                disabled={!selectedHistoryIdsInView.length || deleteHistory.isPending}
                onClick={deleteSelectedHistory}
              >
                {deleteHistory.isPending ? 'Deleting...' : 'Delete selected'}
              </button>
              {selectedHistoryIdsInView.length ? (
                <button className={styles.btn} onClick={() => setSelectedHistoryIds([])}>
                  Clear
                </button>
              ) : null}
              <span className={styles.meta}>{selectedHistoryIdsInView.length} selected</span>
            </div>
          </>
        ) : null}
        {batchOptionsOpen ? (
          <div className={styles.batchOptions}>
            <div className={styles.batchOptionGrid}>
              {BATCH_ARTIFACT_OPTIONS.map((option) => (
                <label className={styles.checkRow} key={option.id}>
                  <input
                    type="checkbox"
                    checked={batchArtifacts[option.id]}
                    onChange={(e) =>
                      setBatchArtifacts((current) => ({
                        ...current,
                        [option.id]: e.target.checked,
                      }))
                    }
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={batchDownloading}
              onClick={downloadSelectedHistory}
            >
              {batchDownloading ? 'Preparing ZIP...' : 'Download ZIP'}
            </button>
          </div>
        ) : null}
        <div className={`${styles.queueList} ${styles.queueListScrollable}`}>
          {visibleHistoryJobs.length ? (
            visibleHistoryJobs.map((job) => {
              const title = fletcherTitle(job)
              const reviewId = job.result.review_id
              const startingPdfUrl = reviewId
                ? `/api/fletcher/reviews/${reviewId}/versions/starting/pdf`
                : null
              const startingTexUrl = reviewId
                ? `/api/fletcher/reviews/${reviewId}/versions/starting/tex`
                : null
              const noSummaryPdfUnavailable =
                (!!job.result.compile_status && job.result.compile_status !== 'ok') ||
                (job.status === 'failed' && !job.result.pdf_url)
              const pdfUrl =
                job.result.pdf_url ||
                (!noSummaryPdfUnavailable && reviewId
                  ? `/api/fletcher/reviews/${reviewId}/versions/no_summary/pdf`
                  : null)
              const texUrl =
                job.result.tex_url ||
                (reviewId ? `/api/fletcher/reviews/${reviewId}/versions/no_summary/tex` : null)
              const selected = selectedHistoryIdSet.has(job.queue_item_id)
              return (
                <article
                  className={`${styles.queueCard} ${styles.queueCardSelectable}`}
                  key={job.queue_item_id}
                >
                  <label className={styles.historySelect}>
                    <input
                      type="checkbox"
                      checked={selected}
                      aria-label={`Select ${title}`}
                      onChange={(e) => toggleHistorySelection(job.queue_item_id, e.target.checked)}
                    />
                  </label>
                  <div className={styles.queueCopy}>
                    <button
                      className={styles.queueTitleButton}
                      onClick={() => setDetailJob(job)}
                      title={title}
                    >
                      {title}
                    </button>
                    <div className={styles.historyMetaGrid}>
                      <span>Status: {job.status}</span>
                      <span>Started: {formatRunTime(job.started_at || job.created_at)}</span>
                      <span>Finished: {formatRunTime(job.finished_at)}</span>
                    </div>
                    {job.error ? (
                      <div className={`${styles.llmErrorDetail} ${styles.queueErrorPreview}`}>
                        {job.error}
                      </div>
                    ) : null}
                  </div>
                  <div className={`${styles.queueActions} ${styles.historyActions}`}>
                    {reviewId ? (
                      <a className={styles.btn} href={`/fletcher/reviews/${reviewId}`}>
                        Open workspace
                      </a>
                    ) : null}
                    <a
                      className={styles.btn}
                      href={`/api/fletcher/tailor/jobs/${job.queue_item_id}/log?download=1`}
                      download={fletcherLogFilename(job)}
                    >
                      Download log
                    </a>
                    <button
                      className={`${styles.btn} ${styles.btnDanger}`}
                      disabled={deleteHistory.isPending}
                      onClick={() => deleteOneHistory(job.queue_item_id, title)}
                    >
                      Delete
                    </button>
                    <details className={styles.moreMenu}>
                      <summary aria-label={`More actions for ${title}`}>⋮</summary>
                      <div className={styles.moreMenuPanel}>
                        {startingPdfUrl ? <a href={startingPdfUrl}>Starting PDF</a> : null}
                        {startingTexUrl ? <a href={startingTexUrl}>Starting TeX</a> : null}
                        {pdfUrl ? <a href={pdfUrl}>PDF</a> : null}
                        {texUrl ? <a href={texUrl}>TeX</a> : null}
                        <a
                          href={`/api/fletcher/tailor/jobs/${job.queue_item_id}/log`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View log
                        </a>
                      </div>
                    </details>
                  </div>
                </article>
              )
            })
          ) : (
            <div className={styles.meta}>
              {historyJobs.length
                ? 'No Fletcher runs match this search.'
                : 'No completed Fletcher runs yet.'}
            </div>
          )}
        </div>
      </section>
      {detailJob ? (
        <FletcherJobDetailModal
          job={detailJob}
          onClose={() => setDetailJob(null)}
          onMove={onMove}
          onCancel={onCancel}
          onDelete={(jobToDelete) =>
            deleteOneHistory(jobToDelete.queue_item_id, fletcherTitle(jobToDelete))
          }
          deletePending={deleteHistory.isPending}
        />
      ) : null}
    </>
  )
}

function FletcherJobDetailModal({
  job,
  onClose,
  onMove,
  onCancel,
  onDelete,
  deletePending,
}: {
  job: FletcherQueueItem
  onClose: () => void
  onMove: (id: string, direction: 'up' | 'down') => void
  onCancel: (id: string) => void
  onDelete: (job: FletcherQueueItem) => void
  deletePending: boolean
}) {
  const title = fletcherTitle(job)
  const reviewId = job.result.review_id
  const startingPdfUrl = reviewId ? `/api/fletcher/reviews/${reviewId}/versions/starting/pdf` : null
  const startingTexUrl = reviewId ? `/api/fletcher/reviews/${reviewId}/versions/starting/tex` : null
  const noSummaryPdfUnavailable =
    (!!job.result.compile_status && job.result.compile_status !== 'ok') ||
    (job.status === 'failed' && !job.result.pdf_url)
  const pdfUrl =
    job.result.pdf_url ||
    (!noSummaryPdfUnavailable && reviewId
      ? `/api/fletcher/reviews/${reviewId}/versions/no_summary/pdf`
      : null)
  const texUrl =
    job.result.tex_url ||
    (reviewId ? `/api/fletcher/reviews/${reviewId}/versions/no_summary/tex` : null)
  const isActive = ACTIVE_FLETCHER_STATUSES.has(job.status)
  const description = (job.input.description || '').trim()
  const progressPercent = fletcherProgressPercent(job)

  return (
    <div className={styles.modalBackdrop} role="presentation" onClick={onClose}>
      <section
        className={styles.detailModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fletcher-job-detail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.detailHeader}>
          <div className={styles.detailHeaderCopy}>
            <div className={styles.workflowLabel}>{fletcherSourceLabel(job)}</div>
            <h2 className={styles.detailTitle} id="fletcher-job-detail-title">
              {title}
            </h2>
          </div>
          <button className={styles.btn} onClick={onClose}>
            Close
          </button>
        </div>

        <div className={styles.detailActionBar}>
          {job.status === 'queued' ? (
            <>
              <button className={styles.btn} onClick={() => onMove(job.queue_item_id, 'up')}>
                Up
              </button>
              <button className={styles.btn} onClick={() => onMove(job.queue_item_id, 'down')}>
                Down
              </button>
              <button className={styles.btn} onClick={() => onCancel(job.queue_item_id)}>
                Cancel
              </button>
            </>
          ) : null}
          {reviewId ? (
            <a className={styles.btn} href={`/fletcher/reviews/${reviewId}`}>
              Open workspace
            </a>
          ) : null}
          {startingPdfUrl ? (
            <a className={styles.btn} href={startingPdfUrl}>
              Starting PDF
            </a>
          ) : null}
          {startingTexUrl ? (
            <a className={styles.btn} href={startingTexUrl}>
              Starting TeX
            </a>
          ) : null}
          {pdfUrl ? (
            <a className={styles.btn} href={pdfUrl}>
              PDF
            </a>
          ) : null}
          {texUrl ? (
            <a className={styles.btn} href={texUrl}>
              TeX
            </a>
          ) : null}
          <a
            className={styles.btn}
            href={`/api/fletcher/tailor/jobs/${job.queue_item_id}/log`}
            target="_blank"
            rel="noreferrer"
          >
            View log
          </a>
          <a
            className={styles.btn}
            href={`/api/fletcher/tailor/jobs/${job.queue_item_id}/log?download=1`}
            download={fletcherLogFilename(job)}
          >
            Download log
          </a>
          {!isActive ? (
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={deletePending}
              onClick={() => onDelete(job)}
            >
              Delete
            </button>
          ) : null}
        </div>

        <div className={styles.detailBody}>
          <aside className={styles.detailMetaPanel}>
            <h3>Run Details</h3>
            <div className={styles.detailMetaGrid}>
              <div>
                <span>Status</span>
                <strong>{job.status}</strong>
              </div>
              <div>
                <span>Started</span>
                <strong>{formatRunTime(job.started_at || job.created_at)}</strong>
              </div>
              <div>
                <span>Finished</span>
                <strong>{formatRunTime(job.finished_at)}</strong>
              </div>
              <div>
                <span>Resume file</span>
                <strong>{job.input.resume_filename || '-'}</strong>
              </div>
              <div>
                <span>Queue ID</span>
                <strong>{job.queue_item_id}</strong>
              </div>
              {job.input.job_id ? (
                <div>
                  <span>Hunt job ID</span>
                  <strong>{job.input.job_id}</strong>
                </div>
              ) : null}
              {progressPercent !== null ? (
                <div>
                  <span>Progress</span>
                  <strong>{progressPercent}%</strong>
                </div>
              ) : null}
              {job.progress.current_step ? (
                <div>
                  <span>Step</span>
                  <strong>{job.progress.current_step}</strong>
                </div>
              ) : null}
            </div>
          </aside>

          <div className={styles.detailContentPanel}>
            {job.error ? (
              <div className={styles.detailBlock}>
                <h3>Error</h3>
                <pre>{job.error}</pre>
              </div>
            ) : null}

            <div className={`${styles.detailBlock} ${styles.detailDescriptionBlock}`}>
              <h3>{job.input.job_id ? 'Job details' : 'Job description'}</h3>
              <pre>{description || 'No job description was stored for this run.'}</pre>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
