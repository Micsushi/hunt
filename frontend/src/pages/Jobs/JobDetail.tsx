import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useJobDetail, useResumeAttempts, useAdjacentJobs } from '@/hooks/useJobDetail'
import { useUiStore } from '@/store/ui'
import {
  deleteJob,
  openAttemptResumeReview,
  openJobResumeReview,
  patchJob,
  requeueJob,
  setJobPriority,
} from '@/api/jobs'
import {
  enqueueFletcherJob,
  fetchSystemStatus,
  verifyEasyApply,
  type EasyApplyVerifyResult,
} from '@/api/control'
import { logHumanCommand } from '@/api/humanCommandLog'
import { StatusBadge } from '@/components/StatusBadge'
import { discoveryLabel } from '@/utils/discovery'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import styles from './JobDetail.module.css'
import type { JobDetail, JobsQuery, SortDirection, SortField } from '@/types/job'
import { get, post } from '@/api/client'

const REVIEW_QUERY_STORAGE_KEY = 'hunt.jobs.reviewQuery'

type EditableField =
  | 'company'
  | 'title'
  | 'location'
  | 'level'
  | 'category'
  | 'is_remote'
  | 'description'
  | 'description_source'
  | 'operator_notes'
  | 'operator_tag'

function effectiveReviewParams(p: URLSearchParams): URLSearchParams {
  if (p.toString()) return p
  const stored = sessionStorage.getItem(REVIEW_QUERY_STORAGE_KEY)
  return new URLSearchParams(stored ?? '')
}

function adjacentQueryFromParams(p: URLSearchParams): JobsQuery {
  const limit = parseInt(p.get('limit') || '', 10)
  const page = parseInt(p.get('page') || '', 10)
  return {
    source: p.get('source') || 'all',
    status: p.get('status') || 'all',
    q: p.get('q') || '',
    tag: p.get('tag') || '',
    category: p.get('category') || '',
    ats_type: p.get('ats_type') || '',
    sort: (p.get('sort') || 'date_scraped') as SortField,
    direction: (p.get('direction') || 'desc') as SortDirection,
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(Number.isFinite(page) ? { page } : {}),
  }
}

// ── Inline field (text / textarea / select) ──────────────────────────────────

interface InlineFieldProps {
  label: string
  value: string | number | null | undefined
  field: EditableField
  onSave: (field: EditableField, value: string) => Promise<void>
  mono?: boolean
  type?: 'text' | 'textarea' | 'select'
  options?: { label: string; value: string }[]
  placeholder?: string
}

function InlineField({
  label,
  value,
  field,
  onSave,
  mono,
  type = 'text',
  options,
  placeholder,
}: InlineFieldProps) {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const cacheKey = ['job-field-draft', id, field]
  const [recovery] = useState(() => qc.getQueryData<string>(cacheKey))
  const [editing, setEditing] = useState(recovery !== undefined)
  const [draft, setDraft] = useState(recovery ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const pending = useRef(false)
  const cancelled = useRef(false)
  const mounted = useRef(false)
  const restoreFocus = useRef(false)
  const draftRef = useRef(draft)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (editing) {
      const key = ['job-field-draft', id, field]
      qc.setQueryDefaults(key, { gcTime: Infinity })
      qc.setQueryData(key, draft)
    }
  }, [qc, id, field, editing, draft])
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false
      buttonRef.current?.focus()
    }
  }, [editing])

  function updateDraft(value: string) {
    draftRef.current = value
    setDraft(value)
  }

  function startEdit() {
    cancelled.current = false
    setError('')
    updateDraft(value != null ? String(value) : '')
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function closeEdit() {
    restoreFocus.current =
      inputRef.current?.parentElement?.contains(document.activeElement) ?? false
    qc.removeQueries({ queryKey: cacheKey, exact: true })
    setEditing(false)
  }

  async function commit() {
    if (pending.current || cancelled.current) return
    if (draft === (value != null ? String(value) : '')) {
      closeEdit()
      return
    }
    const submitted = draft
    pending.current = true
    setSaving(true)
    setError('')
    try {
      await onSave(field, submitted)
      if (mounted.current && draftRef.current === submitted) closeEdit()
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : 'Save failed')
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }

  function cancel() {
    if (pending.current) return
    cancelled.current = true
    closeEdit()
  }

  function onBlur(event: React.FocusEvent) {
    if (error) return
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.parentElement?.contains(event.relatedTarget)
    )
      return
    void commit()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
    if (e.key === 'Enter' && type !== 'textarea') {
      e.preventDefault()
      void commit()
    }
  }

  const display = value != null && value !== '' ? String(value) : null

  return (
    <div
      className={`${styles.inlineField} ${styles.inlineFieldEditable} ${type === 'textarea' ? styles.inlineFieldBlock : ''}`}
    >
      {label && <span className={styles.inlineLabel}>{label}</span>}
      {editing ? (
        type === 'select' && options ? (
          <select
            ref={inputRef as React.Ref<HTMLSelectElement>}
            className={styles.inlineInput}
            aria-label={label || 'Description'}
            value={draft}
            onChange={(e) => updateDraft(e.target.value)}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : type === 'textarea' ? (
          <textarea
            ref={inputRef as React.Ref<HTMLTextAreaElement>}
            className={`${styles.inlineInput} ${styles.inlineTextarea}`}
            aria-label={label || 'Description'}
            value={draft}
            onChange={(e) => updateDraft(e.target.value)}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            rows={8}
            placeholder={placeholder}
          />
        ) : (
          <input
            ref={inputRef as React.Ref<HTMLInputElement>}
            className={styles.inlineInput}
            aria-label={label || 'Description'}
            value={draft}
            onChange={(e) => updateDraft(e.target.value)}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
          />
        )
      ) : (
        <button
          className={`${styles.inlineValue} ${mono ? styles.mono : ''} ${type === 'textarea' ? styles.inlineValueBlock : ''}`}
          onClick={startEdit}
          ref={buttonRef}
          title="Click to edit"
        >
          {display ?? (
            <span className={styles.inlinePlaceholder}>{placeholder ?? 'Click to edit...'}</span>
          )}
          <span className={styles.editHint}>✎</span>
        </button>
      )}
      {editing && (
        <div className={styles.inlineRecovery}>
          {error && <p role="alert">{error}. Your draft is preserved.</p>}
          <button className={styles.actionBtn} disabled={saving} onClick={() => void commit()}>
            {saving ? 'Saving...' : error ? 'Retry save' : 'Save'}
          </button>
          <button className={styles.actionBtn} disabled={saving} onClick={cancel}>
            Cancel edit
          </button>
          <small>Drafts stay with this job during this session.</small>
        </div>
      )}
    </div>
  )
}

// ── Readonly field ────────────────────────────────────────────────────────────

function ReadonlyField({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className={styles.inlineField}>
      <span className={styles.inlineLabel}>{label}</span>
      <span className={`${styles.inlineValueReadonly} ${mono ? styles.mono : ''}`}>
        {value ?? '-'}
      </span>
    </div>
  )
}

// ── Service status chip ───────────────────────────────────────────────────────

function ServiceChip({ label, componentKey }: { label: string; componentKey: string }) {
  const { data } = useQuery({
    queryKey: ['system-status'],
    queryFn: fetchSystemStatus,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const status = (data?.components as Record<string, { status?: string }>)?.[componentKey]?.status
  const ok = status === 'ok'
  const unknown = !status
  return (
    <span
      className={`${styles.serviceChip} ${ok ? styles.serviceOk : unknown ? styles.serviceUnknown : styles.serviceDown}`}
    >
      <span className={styles.serviceDot} />
      {label}: {unknown ? 'unknown' : ok ? 'online' : 'offline'}
    </span>
  )
}

function ApplicationActions({ job }: { job: JobDetail }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const active = useRef(false)
  const pending = useRef(false)
  const [queuing, setQueuing] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  // Match the handoff gateway's families; it also validates the posting URL and resume.
  const supported = ['workday', 'greenhouse', 'lever', 'ashby', 'workable'].includes(job.ats_type ?? '')
  const connection = useQuery({
    queryKey: ['c3-job', job.id],
    queryFn: () => get<{ connected: boolean; configured: boolean; jobs: { id: string; sourceJobId?: number; stage: string; status: string }[] }>('/api/c3/state'),
    enabled: supported, retry: false, refetchInterval: 10000, refetchOnWindowFocus: false,
  })
  const application = connection.data?.jobs.find(item => item.sourceJobId === job.id)
  const blocked = ['applied', 'canceled', 'cancelled'].includes((job.status ?? '').trim().toLowerCase())
    ? 'This job is already applied or cancelled.'
    : job.discovery_suppressed_reason ? 'This job is excluded from discovery.'
    : !supported ? 'Supported application sites: Workday, Greenhouse, Lever, Ashby and Workable.'
    : job.apply_type !== 'external_apply' ? 'An external application is required.'
    : !['done', 'done_verified'].includes(job.enrichment_status ?? '') ? 'Finish discovery verification first.'
    : job.selected_resume_ready_for_c3 !== 1 || !job.selected_resume_pdf_path || !job.selected_resume_version_id ? 'Prepare and select a C2 resume first.'
    : connection.isError ? 'Application progress is unavailable. Retry the connection before filling.'
    : !connection.data ? 'Checking application service…'
    : !connection.data.configured ? 'Set up your profile in Applications first.' : ''

  async function handoff() {
    if (pending.current || blocked) return
    pending.current = true; setQueuing(true); setHandoffError('')
    try {
      await post('/api/c3/handoff', { job_ids: [job.id] })
      void qc.invalidateQueries({ queryKey: ['c3-job', job.id] })
      if (active.current) navigate('/executioner')
    } catch (error) {
      if (active.current) setHandoffError(error instanceof Error ? error.message : 'Could not queue application')
    } finally {
      pending.current = false
      if (active.current) setQueuing(false)
    }
  }

  return <div className={styles.applicationActions}>
    {application && <p role="status">{connection.isError ? 'Last known application' : 'Application'}: {application.stage}. <button className={styles.actionBtn} onClick={() => navigate('/executioner')}>View application</button></p>}
    {blocked && <p role="status">{blocked}</p>}
    {supported && connection.isError && <p role="alert">{connection.error.message} <button className={styles.actionBtn} disabled={connection.isFetching} onClick={() => connection.refetch()}>Retry connection</button></p>}
    {supported && !connection.isError && connection.data?.configured && !connection.data.connected && <p role="status">Browser extension disconnected. New applications will wait in the queue.</p>}
    {handoffError && <p role="alert">{handoffError} <button className={styles.actionBtn} onClick={() => navigate('/executioner')}>Check Applications</button></p>}
    <button className={styles.actionBtn} disabled={queuing || !!blocked} onClick={handoff}>{queuing ? 'Queuing…' : 'Fill application'}</button>
    <p>Stops before submission.</p>
  </div>
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const jobId = Number(id)
  if (!Number.isSafeInteger(jobId) || jobId <= 0)
    return (
      <div className={styles.errorPage}>
        <p role="alert">Invalid job address.</p>
        <button className={styles.backBtn} onClick={() => navigate('/jobs')}>
          Back to jobs
        </button>
      </div>
    )
  return <JobDetail key={jobId} jobId={jobId} />
}

function JobDetail({ jobId }: { jobId: number }) {
  const navigate = useNavigate()
  const active = useRef(false)
  const openingReview = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const [searchParams] = useSearchParams()
  const qc = useQueryClient()
  const showToast = useUiStore((s) => s.showToast)
  const [generating, setGenerating] = useState(false)
  const [openingReviewId, setOpeningReviewId] = useState<number | 'selected' | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<EasyApplyVerifyResult | null>(null)
  const effectiveParams = useMemo(() => effectiveReviewParams(searchParams), [searchParams])
  const adjacentQuery = useMemo(() => adjacentQueryFromParams(effectiveParams), [effectiveParams])
  const detailSearch = effectiveParams.toString() ? `?${effectiveParams.toString()}` : ''
  const jobsListPath = `/jobs${detailSearch}`

  const { data: job, isLoading, error, refetch, isFetching } = useJobDetail(jobId)
  const history = useResumeAttempts(jobId)
  const attempts = history.data ?? []
  const navigation = useAdjacentJobs(jobId, adjacentQuery)
  const adjacent = navigation.data

  if (isLoading) return <div className={styles.loading}>Loading...</div>
  if (!job)
    return (
      <div className={styles.errorPage}>
        <p role="alert">{error?.message || 'Job could not be loaded.'}</p>
        <button className={styles.backBtn} disabled={isFetching} onClick={() => void refetch()}>
          Retry job
        </button>
        <button className={styles.backBtn} onClick={() => navigate(jobsListPath)}>
          Back to jobs
        </button>
      </div>
    )

  const loadedJob = job

  async function handleFieldSave(field: EditableField, value: string) {
    try {
      const payload: Record<string, string | number | null> = {}
      if (field === 'is_remote') {
        payload[field] = value === 'Yes' ? 1 : value === 'No' ? 0 : null
      } else {
        payload[field] = value.trim() || null
      }
      await patchJob(jobId, payload)
      qc.setQueryData<JobDetail>(['job', jobId], (previous) =>
        previous ? { ...previous, ...payload } : previous,
      )
      if (active.current) showToast('Saved')
      void qc.invalidateQueries({ queryKey: ['job', jobId] })
    } catch (e) {
      if (active.current) showToast(e instanceof Error ? e.message : 'Update failed', 'error')
      throw e
    }
  }

  async function handleDescriptionSave(value: string) {
    try {
      const trimmed = value.trim()
      await patchJob(jobId, {
        description: trimmed || null,
        // auto-lock when saving text; if cleared, leave source as-is (user controls lock)
        ...(trimmed ? { description_source: 'manual' } : {}),
      })
      if (active.current)
        showToast(trimmed ? 'Description saved and locked' : 'Description cleared')
      qc.invalidateQueries({ queryKey: ['job', jobId] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed', 'error')
      throw e
    }
  }

  async function handleRequeue() {
    try {
      await requeueJob(jobId)
      showToast('Requeued for enrichment')
      qc.invalidateQueries({ queryKey: ['job', jobId] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Requeue failed', 'error')
    }
  }

  async function handlePriority(runNext: boolean) {
    try {
      await setJobPriority(jobId, runNext)
      showToast(runNext ? 'Marked as run next' : 'Priority cleared')
      qc.invalidateQueries({ queryKey: ['job', jobId] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed', 'error')
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete job #${jobId}? This cannot be undone.`)) return
    try {
      await deleteJob(jobId)
      qc.removeQueries({ queryKey: ['job', jobId], exact: true })
      qc.removeQueries({ queryKey: ['job-field-draft', String(jobId)] })
      void qc.invalidateQueries({ queryKey: ['job-adjacent'] })
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      showToast('Job deleted')
      if (active.current) navigate(jobsListPath)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Delete failed', 'error')
    }
  }

  async function handleVerifyEasyApply() {
    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = await verifyEasyApply(jobId)
      if (!active.current) return
      setVerifyResult(result)
      showToast(
        result.pass ? 'Easy Apply: PASS' : `Easy Apply: FAIL (${result.failures.length} issue(s))`,
        result.pass ? undefined : 'error',
      )
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Verify failed', 'error')
    } finally {
      setVerifying(false)
    }
  }

  async function handleGenerate() {
    setGenerating(true)
    try {
      await enqueueFletcherJob({ jobId })
      showToast('Resume run queued')
      qc.invalidateQueries({ queryKey: ['fletcher-jobs'] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Queue failed', 'error')
    } finally {
      setGenerating(false)
    }
  }

  async function handleOpenSelectedResumeReview() {
    if (openingReview.current) return
    openingReview.current = true
    setOpeningReviewId('selected')
    try {
      const review = await openJobResumeReview(jobId)
      if (active.current) navigate(`/fletcher/reviews/${review.review_id}`)
    } catch (e) {
      if (active.current)
        showToast(e instanceof Error ? e.message : 'Could not open resume review', 'error')
    } finally {
      openingReview.current = false
      if (active.current) setOpeningReviewId(null)
    }
  }

  async function handleOpenAttemptReview(attemptId: number) {
    if (openingReview.current) return
    openingReview.current = true
    setOpeningReviewId(attemptId)
    try {
      const review = await openAttemptResumeReview(attemptId)
      if (active.current) navigate(`/fletcher/reviews/${review.review_id}`)
    } catch (e) {
      if (active.current)
        showToast(e instanceof Error ? e.message : 'Could not open resume review', 'error')
    } finally {
      openingReview.current = false
      if (active.current) setOpeningReviewId(null)
    }
  }

  function logOpenApplyPage() {
    void logHumanCommand({
      action: 'c0.open_apply_page',
      buttonId: 'open-apply-page',
      component: 'c0',
      surface: 'c0_ui',
      details: {
        jobId,
        applyType: loadedJob.apply_type || '',
        atsType: loadedJob.ats_type || '',
        hasSelectedResume: loadedJob.selected_resume_ready_for_c3 === 1,
      },
    })
  }

  const remoteDisplay = job.is_remote === 1 ? 'Yes' : job.is_remote === 0 ? 'No' : ''
  const descriptionSource = job.description_source

  return (
    <div className={styles.page}>
      {error && (
        <p role="alert">
          Refresh failed. Showing the last loaded job.{' '}
          <button className={styles.actionBtn} disabled={isFetching} onClick={() => void refetch()}>
            Retry job
          </button>
        </p>
      )}
      {navigation.isError && (
        <p role="alert">
          Previous and next jobs could not be loaded.{' '}
          <button
            className={styles.actionBtn}
            disabled={navigation.isFetching}
            onClick={() => void navigation.refetch()}
          >
            Retry navigation
          </button>
        </p>
      )}
      {/* Top menu card */}
      <div className={styles.menuCard}>
        <button className={styles.backBtn} onClick={() => navigate(jobsListPath)}>
          ← Back
        </button>
        <span className={styles.headerId}>#{job.id}</span>
        <div className={styles.navBtns}>
          <button
            className={styles.navBtn}
            onClick={() =>
              adjacent?.prev_id != null && navigate(`/jobs/${adjacent.prev_id}${detailSearch}`)
            }
            disabled={navigation.isError || adjacent?.prev_id == null}
            title="Previous job"
          >
            ‹
          </button>
          <button
            className={styles.navBtn}
            onClick={() =>
              adjacent?.next_id != null && navigate(`/jobs/${adjacent.next_id}${detailSearch}`)
            }
            disabled={navigation.isError || adjacent?.next_id == null}
            title="Next job"
          >
            ›
          </button>
        </div>
        <div className={styles.menuLinks}>
          {job.job_url && (
            <a href={job.job_url} target="_blank" rel="noreferrer" className={styles.extBtn}>
              Listing ↗
            </a>
          )}
          {job.apply_url && (
            <a
              href={job.apply_url}
              target="_blank"
              rel="noreferrer"
              className={styles.extBtn}
              onClick={logOpenApplyPage}
            >
              Apply ↗
            </a>
          )}
        </div>
        <button className={styles.deleteBtn} onClick={handleDelete}>
          Delete
        </button>
      </div>

      {/* Two-column body */}
      <div className={styles.body}>
        {/* Left: fields + description */}
        <div className={styles.col}>
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Job fields</h2>
            <div className={styles.fieldList}>
              <InlineField
                label="Company"
                field="company"
                value={job.company}
                onSave={handleFieldSave}
              />
              <InlineField label="Title" field="title" value={job.title} onSave={handleFieldSave} />
              <InlineField
                label="Location"
                field="location"
                value={job.location}
                onSave={handleFieldSave}
              />
              <InlineField label="Level" field="level" value={job.level} onSave={handleFieldSave} />
              <InlineField
                label="Category"
                field="category"
                value={job.category}
                onSave={handleFieldSave}
              />
              <InlineField
                label="Remote"
                field="is_remote"
                value={remoteDisplay}
                onSave={handleFieldSave}
                type="select"
                options={[
                  { label: '-', value: '' },
                  { label: 'Yes', value: 'Yes' },
                  { label: 'No', value: 'No' },
                ]}
              />
              <ReadonlyField label="Source" value={job.source} />
              <ReadonlyField label="Discovery fit" value={discoveryLabel(job)} />
              <ReadonlyField label="Apply type" value={job.apply_type?.replace(/_/g, ' ')} />
              <ReadonlyField label="ATS type" value={job.ats_type} />
              <ReadonlyField label="Apply host" value={job.apply_host} mono />
              <ReadonlyField
                label="Auto-apply"
                value={job.auto_apply_eligible === 1 ? 'Yes' : 'No'}
              />
              <ReadonlyField label="Posted" value={job.date_posted} />
              <ReadonlyField label="Scraped" value={job.date_scraped} />
              <InlineField
                label="Tag"
                field="operator_tag"
                value={job.operator_tag}
                onSave={handleFieldSave}
                placeholder="e.g. applied, skip, followup"
              />
              <InlineField
                label="Notes"
                field="operator_notes"
                value={job.operator_notes}
                onSave={handleFieldSave}
                type="textarea"
                placeholder="Free-form notes..."
              />
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Job description</h2>
              <div className={styles.jdMeta}>
                {descriptionSource === 'scraped' && (
                  <span className={styles.scrapedBadge}>Scraped</span>
                )}
                {descriptionSource === 'manual' && (
                  <span className={styles.manualBadge}>Manual</span>
                )}
                <label
                  className={styles.lockToggle}
                  title="When locked, enrichment will not overwrite this description"
                >
                  <input
                    type="checkbox"
                    checked={descriptionSource === 'manual'}
                    onChange={async (e) => {
                      const locked = e.target.checked
                      try {
                        await patchJob(jobId, { description_source: locked ? 'manual' : null })
                        showToast(locked ? 'Description locked' : 'Enrichment can now overwrite')
                        qc.invalidateQueries({ queryKey: ['job', jobId] })
                      } catch {
                        showToast('Failed to update lock', 'error')
                      }
                    }}
                  />
                  Lock (prevent enrich overwrite)
                </label>
              </div>
            </div>
            <InlineField
              label=""
              field="description"
              value={job.description}
              onSave={handleDescriptionSave}
              type="textarea"
              placeholder="No description yet. Enrichment will fill this from the listing, or click to enter it manually."
            />
          </div>
        </div>

        {/* Right: enrichment + resume */}
        <div className={styles.col}>
          <div className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Enrichment</h2>
              <ServiceChip label="Hunter" componentKey="c1" />
            </div>
            <div className={styles.fieldList}>
              <ReadonlyField
                label="Status"
                value={<StatusBadge status={job.enrichment_status} />}
              />
              <ReadonlyField label="Attempts" value={job.enrichment_attempts} />
              <ReadonlyField label="Enriched at" value={job.enriched_at} />
              <ReadonlyField label="Last started" value={job.last_enrichment_started_at} />
              <ReadonlyField label="Next retry" value={job.next_enrichment_retry_at} />
              {job.last_enrichment_error && (
                <ReadonlyField label="Last error" value={job.last_enrichment_error} mono />
              )}
            </div>
            <div className={styles.panelActions}>
              <ApplicationActions key={job.id} job={job} />
              <button
                className={styles.actionBtn}
                onClick={handleRequeue}
                disabled={
                  !(
                    ['linkedin', 'indeed'].includes(job.source ?? '') ||
                    (Boolean(job.source) &&
                      [
                        'workday',
                        'greenhouse',
                        'lever',
                        'ashby',
                        'smartrecruiters',
                        'bamboohr',
                        'workable',
                      ].includes(job.ats_type ?? '') &&
                      job.status === 'new' &&
                      job.apply_type !== 'easy_apply')
                  )
                }
              >
                Requeue
              </button>
              {job.apply_type === 'easy_apply' && (
                <button
                  className={styles.actionBtn}
                  onClick={handleVerifyEasyApply}
                  disabled={verifying}
                  title="Verify C1 marks this Easy Apply job ineligible for external autofill"
                >
                  {verifying ? 'Verifying…' : 'Verify Easy Apply'}
                </button>
              )}
              {verifyResult && (
                <pre
                  style={{
                    fontSize: '0.78rem',
                    margin: '8px 0 0',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {verifyResult.pass ? 'PASS' : 'FAIL'}
                  {'\n'}
                  {verifyResult.failures.length > 0
                    ? verifyResult.failures.map((f) => `- ${f}`).join('\n')
                    : 'No issues found.'}
                </pre>
              )}
              {job.priority ? (
                <button
                  className={`${styles.actionBtn} ${styles.actionBtnSecondary}`}
                  onClick={() => handlePriority(false)}
                >
                  Clear priority
                </button>
              ) : (
                <button
                  className={`${styles.actionBtn} ${styles.actionBtnSecondary}`}
                  onClick={() => handlePriority(true)}
                >
                  Run next
                </button>
              )}
            </div>
            {(job.last_artifact_screenshot_path ||
              job.last_artifact_html_path ||
              job.last_artifact_text_path) && (
              <div className={styles.artifactLinks} style={{ marginTop: 10 }}>
                {job.last_artifact_screenshot_path && (
                  <a
                    href={`/api/jobs/${jobId}/artifacts/screenshot`}
                    target="_blank"
                    rel="noreferrer"
                    className={styles.artifactBtn}
                  >
                    Screenshot ↗
                  </a>
                )}
                {job.last_artifact_html_path && (
                  <a
                    href={`/api/jobs/${jobId}/artifacts/html`}
                    target="_blank"
                    rel="noreferrer"
                    className={styles.artifactBtn}
                  >
                    HTML ↗
                  </a>
                )}
                {job.last_artifact_text_path && (
                  <a
                    href={`/api/jobs/${jobId}/artifacts/text`}
                    target="_blank"
                    rel="noreferrer"
                    className={styles.artifactBtn}
                  >
                    Text ↗
                  </a>
                )}
              </div>
            )}
          </div>

          <div className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Resume</h2>
              <ServiceChip label="Fletcher" componentKey="c2" />
            </div>
            <div className={styles.fieldList}>
              <ReadonlyField
                label="JD usable"
                value={
                  job.latest_resume_jd_usable === 1
                    ? 'Yes'
                    : job.latest_resume_jd_usable === 0
                      ? 'No'
                      : '-'
                }
              />
              <ReadonlyField label="Usable reason" value={job.latest_resume_jd_usable_reason} />
              <ReadonlyField
                label="Ready for C3"
                value={job.selected_resume_ready_for_c3 === 1 ? 'Yes' : 'No'}
              />
            </div>
            <div className={styles.panelActions}>
              <button className={styles.actionBtn} onClick={handleGenerate} disabled={generating}>
                {generating ? 'Queueing...' : 'Tailor for saved job'}
              </button>
              <button
                className={styles.actionBtn}
                onClick={handleOpenSelectedResumeReview}
                disabled={attempts.length === 0 || openingReviewId !== null}
              >
                {openingReviewId === 'selected' ? 'Opening...' : 'Resume workspace'}
              </button>
            </div>
            {attempts.length > 0 && (
              <div className={styles.artifactLinks} style={{ marginTop: 10 }}>
                <a
                  href={`/api/jobs/${jobId}/resume/selected-pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.artifactBtn}
                >
                  Selected PDF ↗
                </a>
                <a
                  href={`/api/jobs/${jobId}/resume/selected-tex`}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.artifactBtn}
                >
                  Selected TeX ↗
                </a>
                <a
                  href={`/api/jobs/${jobId}/resume/keywords`}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.artifactBtn}
                >
                  Keywords ↗
                </a>
              </div>
            )}
            {history.isPending && <p role="status">Loading resume history...</p>}
            {history.isError && (
              <p role="alert">
                Resume history could not be loaded.{' '}
                {history.data ? 'Showing the last loaded attempts.' : ''}{' '}
                <button
                  className={styles.actionBtn}
                  disabled={history.isFetching}
                  onClick={() => void history.refetch()}
                >
                  Retry resume history
                </button>
              </p>
            )}
            {attempts.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 8 }}>
                  Generation history
                </p>
                {attempts.map((a) => (
                  <div key={a.id} className={styles.attemptCard}>
                    <div className={styles.attemptHeader}>
                      <div
                        style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
                      >
                        <StatusBadge status={a.status} size="sm" />
                        {a.is_selected_for_c3 && (
                          <span className={styles.selectedBadge}>Selected</span>
                        )}
                        {!a.is_selected_for_c3 && a.is_latest_useful && (
                          <span className={styles.usefulBadge}>Useful</span>
                        )}
                        <span className="muted" style={{ fontSize: '0.75rem' }}>
                          #{a.id} · {a.created_at}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 5 }}>
                        {a.pdf_path && (
                          <a
                            href={`/api/attempts/${a.id}/pdf`}
                            target="_blank"
                            rel="noreferrer"
                            className={`${styles.artifactBtn} ${styles.artifactBtnPrimary}`}
                          >
                            PDF ↗
                          </a>
                        )}
                        {a.tex_path && (
                          <button
                            className={styles.artifactBtn}
                            onClick={() => handleOpenAttemptReview(a.id)}
                            disabled={openingReviewId !== null}
                          >
                            {openingReviewId === a.id ? 'Opening...' : 'Resume workspace'}
                          </button>
                        )}
                        {a.tex_path && (
                          <a
                            href={`/api/attempts/${a.id}/tex`}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.artifactBtn}
                          >
                            TeX ↗
                          </a>
                        )}
                        <a
                          href={`/api/attempts/${a.id}/llm`}
                          target="_blank"
                          rel="noreferrer"
                          className={styles.artifactBtn}
                        >
                          LLM ↗
                        </a>
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: 12,
                        flexWrap: 'wrap',
                        marginTop: 6,
                        fontSize: '0.8rem',
                      }}
                    >
                      <span className="muted">
                        Family: <strong>{a.role_family ?? '-'}</strong>
                      </span>
                      <span className="muted">
                        Level: <strong>{a.job_level ?? '-'}</strong>
                      </span>
                      <span className="muted">
                        JD OK:{' '}
                        <strong>
                          {a.jd_usable === 1 ? 'yes' : a.jd_usable === 0 ? 'no' : '-'}
                        </strong>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {history.isSuccess && attempts.length === 0 && (
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: 12 }}>
                No attempts yet.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
