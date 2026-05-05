import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { type TailorResult, fetchC2Status, tailorResume, triggerC2Generate } from '@/api/control'
import { useUiStore } from '@/store/ui'
import styles from './Fletcher.module.css'

export function FletcherPage() {
  const [jobId, setJobId] = useState('')
  const [jobIdResult, setJobIdResult] = useState<unknown>(null)
  const showToast = useUiStore((s) => s.showToast)
  const qc = useQueryClient()

  const [jobDetails, setJobDetails] = useState('')
  const [personalDetails, setPersonalDetails] = useState('')
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

  const generate = useMutation({
    mutationFn: (id: number) => triggerC2Generate(id),
    onSuccess: (res) => {
      setJobIdResult(res)
      showToast('Generation requested')
      qc.invalidateQueries({ queryKey: ['c2-status'] })
    },
    onError: (e) => showToast(e instanceof Error ? e.message : 'Generation failed', 'error'),
  })

  const tailor = useMutation({
    mutationFn: () => tailorResume({ jobDetails, personalDetails, resume: resumeFile }),
    onSuccess: (result) => {
      setTailorResult(result)
      showToast(result.withSummary ? 'Both versions ready' : 'Resume ready - click to download')
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
