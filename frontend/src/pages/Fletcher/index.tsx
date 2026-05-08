import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  batchDownloadFletcherJobs,
  cancelFletcherJob,
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
const ACTIVE_FLETCHER_STATUSES = new Set(['queued', 'running', 'cancel_requested'])
const FLETCHER_QUEUE_ACTIVE_REFETCH_MS = 5000
const FLETCHER_QUEUE_IDLE_REFETCH_MS = 30000
const BATCH_ARTIFACT_OPTIONS: { id: FletcherBatchArtifact; label: string }[] = [
  { id: 'log', label: 'Logs' },
  { id: 'starting_pdf', label: 'Starting PDF' },
  { id: 'no_summary_pdf', label: 'Resume PDF : no summary' },
  { id: 'with_summary_pdf', label: 'Resume PDF : with summary' },
  { id: 'starting_tex', label: 'Starting TeX' },
  { id: 'no_summary_tex', label: 'TeX : no summary' },
  { id: 'with_summary_tex', label: 'TeX : with summary' },
]

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
  return [job.input.title || 'Ad-hoc resume', job.input.company].filter(Boolean).join(' : ')
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

function nextSmoothedProgress(current: number, target: number): number {
  if (target <= current) return target
  const gap = target - current
  const step = Math.max(0.2, Math.min(0.8, gap * 0.04))
  return Math.min(target, current + step)
}

function runTimeMillis(value: string | null | undefined): number {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
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
      qc.invalidateQueries({ queryKey: ['fletcher-jobs'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Queue failed', 'error'),
  })

  const enqueue = useMutation({
    mutationFn: () => enqueueFletcherJob({ description: jobDetails, resume: resumeFile }),
    onSuccess: () => {
      showToast('Fletcher job queued')
      setJobDetails('')
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
  const activeJobs = useMemo(
    () => jobs.filter((job) => ACTIVE_FLETCHER_STATUSES.has(job.status)),
    [jobs],
  )
  const [displayedProgress, setDisplayedProgress] = useState<Record<string, number>>({})
  const historyJobs = useMemo(
    () =>
      jobs
        .filter((job) => !ACTIVE_FLETCHER_STATUSES.has(job.status))
        .sort((a, b) => runTimeMillis(b.finished_at) - runTimeMillis(a.finished_at)),
    [jobs],
  )
  const [historySearch, setHistorySearch] = useState('')
  const [detailJob, setDetailJob] = useState<FletcherQueueItem | null>(null)
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

  useEffect(() => {
    const timer = window.setInterval(() => {
      const activeTargets = new Map(
        activeJobs
          .map((job) => [job.queue_item_id, fletcherProgressPercent(job)] as const)
          .filter((entry): entry is readonly [string, number] => entry[1] !== null),
      )
      if (!activeTargets.size) {
        setDisplayedProgress((current) => (Object.keys(current).length ? {} : current))
        return
      }
      setDisplayedProgress((current) => {
        let changed = false
        const next: Record<string, number> = {}
        for (const [queueItemId, target] of activeTargets) {
          const currentValue = current[queueItemId] ?? Math.min(target, 1)
          const smoothed = nextSmoothedProgress(currentValue, target)
          next[queueItemId] = smoothed
          if (Math.abs(smoothed - currentValue) > 0.001) changed = true
        }
        if (Object.keys(current).some((queueItemId) => !activeTargets.has(queueItemId))) {
          changed = true
        }
        return changed ? next : current
      })
    }, 200)
    return () => window.clearInterval(timer)
  }, [activeJobs])

  function toggleHistorySelection(queueItemId: string, checked: boolean) {
    setSelectedHistoryIds((current) => {
      if (checked) return current.includes(queueItemId) ? current : [...current, queueItemId]
      return current.filter((id) => id !== queueItemId)
    })
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
        <div className={styles.queueList}>
          {activeJobs.length ? (
            activeJobs.map((job) => {
              const progressPercent = fletcherProgressPercent(job)
              const displayedPercent =
                progressPercent === null
                  ? null
                  : Math.round(displayedProgress[job.queue_item_id] ?? progressPercent)
              return (
                <article className={styles.queueCard} key={job.queue_item_id}>
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
                    {job.status !== 'queued' && displayedPercent !== null ? (
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
                        <button className={styles.btn} onClick={() => onCancel(job.queue_item_id)}>
                          Cancel
                        </button>
                      </>
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
        <div className={styles.queueList}>
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
              const pdfUrl =
                job.result.pdf_url ||
                (reviewId ? `/api/fletcher/reviews/${reviewId}/versions/no_summary/pdf` : null)
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
                  <div className={styles.queueActions}>
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
                    <button
                      className={`${styles.btn} ${styles.btnDanger}`}
                      disabled={deleteHistory.isPending}
                      onClick={() => deleteOneHistory(job.queue_item_id, title)}
                    >
                      Delete
                    </button>
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
  const pdfUrl =
    job.result.pdf_url ||
    (reviewId ? `/api/fletcher/reviews/${reviewId}/versions/no_summary/pdf` : null)
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

        {job.error ? (
          <div className={styles.detailBlock}>
            <h3>Error</h3>
            <pre>{job.error}</pre>
          </div>
        ) : null}

        <div className={styles.detailBlock}>
          <h3>{job.input.job_id ? 'Job details' : 'Job description'}</h3>
          <pre>{description || 'No job description was stored for this run.'}</pre>
        </div>
      </section>
    </div>
  )
}
