import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  type TailorResult,
  fetchC2Status,
  fetchSettings,
  tailorResume,
  triggerC2Generate,
} from '@/api/control'
import { useUiStore } from '@/store/ui'
import {
  RESUME_DONE_NOTIFICATION_KEY,
  notifyResumeDone,
  settingEnabled,
} from '@/utils/notifications'
import styles from './Fletcher.module.css'

const FLETCHER_FORM_STORAGE_KEY = 'hunt.fletcher.optionBForm'
const FLETCHER_JOB_ID_STORAGE_KEY = 'hunt.fletcher.optionAJobId'

function readStoredText(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function readStoredOptionBForm(): { jobDetails: string; personalDetails: string } {
  try {
    const raw = localStorage.getItem(FLETCHER_FORM_STORAGE_KEY)
    if (!raw) return { jobDetails: '', personalDetails: '' }
    const parsed = JSON.parse(raw) as Partial<{ jobDetails: string; personalDetails: string }>
    return {
      jobDetails: typeof parsed.jobDetails === 'string' ? parsed.jobDetails : '',
      personalDetails: typeof parsed.personalDetails === 'string' ? parsed.personalDetails : '',
    }
  } catch {
    return { jobDetails: '', personalDetails: '' }
  }
}

export function FletcherPage() {
  const [jobId, setJobId] = useState(() => readStoredText(FLETCHER_JOB_ID_STORAGE_KEY))
  const [jobIdResult, setJobIdResult] = useState<unknown>(null)
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()

  const [jobDetails, setJobDetails] = useState(() => readStoredOptionBForm().jobDetails)
  const [personalDetails, setPersonalDetails] = useState(
    () => readStoredOptionBForm().personalDetails,
  )
  const [resumeFile, setResumeFile] = useState<File | null>(null)
  const [tailorResult, setTailorResult] = useState<TailorResult | null>(null)
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

  const { data: c2Settings } = useQuery({
    queryKey: ['component-settings', 'c2'],
    queryFn: () => fetchSettings('c2'),
    staleTime: 30_000,
  })

  const resumeDoneNotificationsEnabled = settingEnabled(
    c2Settings?.settings.find((s) => s.key === RESUME_DONE_NOTIFICATION_KEY)?.value,
  )

  useEffect(() => {
    try {
      localStorage.setItem(FLETCHER_JOB_ID_STORAGE_KEY, jobId)
    } catch {
      // Ignore storage failures; the form should still work.
    }
  }, [jobId])

  useEffect(() => {
    try {
      localStorage.setItem(
        FLETCHER_FORM_STORAGE_KEY,
        JSON.stringify({ jobDetails, personalDetails }),
      )
    } catch {
      // Ignore storage failures; the form should still work.
    }
  }, [jobDetails, personalDetails])

  const generate = useMutation({
    mutationFn: (id: number) => triggerC2Generate(id),
    onSuccess: (res) => {
      setJobIdResult(res)
      showToast('Resume generation finished')
      notifyResumeDone({
        enabled: resumeDoneNotificationsEnabled,
        title: 'Hunt resume ready',
        body: `Queued job ${jobId || 'resume'} finished generating.`,
      })
      qc.invalidateQueries({ queryKey: ['c2-status'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Generation failed', 'error'),
  })

  const tailor = useMutation({
    mutationFn: () => tailorResume({ jobDetails, personalDetails, resume: resumeFile }),
    onSuccess: (result) => {
      setTailorResult(result)
      if (result.errorType) {
        showToast(result.error ?? 'Tailoring skipped', 'error')
      } else if (result.withSummary || result.noSummary) {
        showToast(result.withSummary ? 'Both versions ready' : 'Resume ready - click to download')
      } else {
        showToast('Tailoring finished without a PDF', 'error')
      }
      notifyResumeDone({
        enabled: resumeDoneNotificationsEnabled && !result.errorType,
        title: result.withSummary || result.noSummary ? 'Hunt resume ready' : 'Hunt tailoring finished',
        body: result.withSummary
          ? 'Fletcher generated both resume versions.'
          : result.noSummary
            ? 'Fletcher generated the no-summary resume.'
            : 'Fletcher finished without a PDF.',
      })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Tailor failed', 'error'),
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
    setTailorResult(null)
    tailor.mutate()
  }

  const serviceOnline = !statusError && !!statusData

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
          {statusLoading ? 'Checking…' : serviceOnline ? 'Service online' : 'Service offline'}
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
              {generate.isPending ? 'Requesting…' : 'Generate'}
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
                placeholder="Paste the job title, company, and full description here…"
              />
            </label>
            <label className={styles.field}>
              Personal details
              <textarea
                className={styles.textarea}
                value={personalDetails}
                onChange={(e) => setPersonalDetails(e.target.value)}
                placeholder="Your background, skills, or notes to guide the tailoring…"
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
              disabled={tailor.isPending}
              onClick={submitTailor}
              style={{ alignSelf: 'flex-start' }}
            >
              {tailor.isPending ? 'Generating…' : 'Generate PDF'}
            </button>
          </div>
          {tailorResult ? (
            <div className={styles.downloadGroup}>
              {tailorResult.errorType ? (
                <div className={styles.llmErrorBanner}>
                  <strong>{tailorResult.errorType}</strong> - no resume was generated.
                  <span className={styles.llmErrorDetail}>{tailorResult.error}</span>
                </div>
              ) : null}
              {tailorResult.llmError ? (
                <div className={styles.llmErrorBanner}>
                  <strong>LLM unavailable</strong> - resume returned without tailoring.
                  <span className={styles.llmErrorDetail}>{tailorResult.llmError}</span>
                </div>
              ) : null}
              {tailorResult.noSummary ? (
                <a
                  className={styles.downloadLink}
                  href={URL.createObjectURL(tailorResult.noSummary)}
                  download="resume_no_summary.pdf"
                >
                  ↓ Download (no summary)
                </a>
              ) : null}
              {tailorResult.withSummary ? (
                <a
                  className={styles.downloadLink}
                  href={URL.createObjectURL(tailorResult.withSummary)}
                  download="resume_with_summary.pdf"
                >
                  ↓ Download (with summary)
                </a>
              ) : null}
              {tailorResult.log ? (
                <a
                  className={`${styles.downloadLink} ${styles.downloadLinkLog}`}
                  href={URL.createObjectURL(tailorResult.log)}
                  download="pipeline_log.txt"
                >
                  ↓ Download log
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
