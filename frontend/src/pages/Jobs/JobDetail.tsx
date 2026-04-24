import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useJobDetail, useResumeAttempts } from '@/hooks/useJobDetail'
import { useUiStore } from '@/store/ui'
import { requeueJob, setJobPriority, setJobOperatorMeta } from '@/api/jobs'
import { FieldGrid } from '@/components/FieldGrid'
import { StatusBadge } from '@/components/StatusBadge'
import { useQueryClient } from '@tanstack/react-query'
import styles from './JobDetail.module.css'

type Tab = 'overview' | 'description' | 'enrichment' | 'resume'

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const jobId = parseInt(id ?? '0', 10)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const showToast = useUiStore(s => s.showToast)
  const [tab, setTab] = useState<Tab>('overview')
  const [notes, setNotes] = useState<string | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [savingMeta, setSavingMeta] = useState(false)

  const { data: job, isLoading, error } = useJobDetail(jobId)
  const { data: attempts = [] } = useResumeAttempts(jobId)

  if (isLoading) return <div className={styles.loading}>Loading…</div>
  if (error || !job) return (
    <div className={styles.errorPage}>
      <p>Job not found or failed to load.</p>
      <button className={styles.backBtn} onClick={() => navigate('/jobs')}>Back to jobs</button>
    </div>
  )

  const noteVal = notes ?? (job.operator_notes ?? '')
  const tagVal  = tag  ?? (job.operator_tag  ?? '')

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
      showToast(runNext ? 'Marked as run next' : 'Priority flag cleared')
      qc.invalidateQueries({ queryKey: ['job', jobId] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed', 'error')
    }
  }

  async function handleSaveMeta() {
    setSavingMeta(true)
    try {
      await setJobOperatorMeta(jobId, { operator_notes: noteVal, operator_tag: tagVal })
      showToast('Saved')
      qc.invalidateQueries({ queryKey: ['job', jobId] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSavingMeta(false)
    }
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={() => navigate(-1)} title="Go back">← Back</button>
        <div className={styles.headerMain}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{job.title ?? 'Untitled'}</h1>
            {job.priority ? <span className={styles.priorityBadge} title="Flagged as run-next in the enrichment queue">Run next</span> : null}
          </div>
          <div className={styles.meta}>
            <span>{job.company ?? '—'}</span>
            {job.location && <span>· {job.location}</span>}
            <StatusBadge status={job.enrichment_status} />
            <span className="muted" style={{ fontSize: '0.83rem' }}>#{job.id} · {job.source}</span>
          </div>
          <div className={styles.links}>
            {job.job_url && <a href={job.job_url} target="_blank" rel="noreferrer" className={styles.extBtn} title="Open the original job listing">View listing ↗</a>}
            {job.apply_url && <a href={job.apply_url} target="_blank" rel="noreferrer" className={styles.extBtn} title={`Apply at ${job.apply_host ?? job.apply_url}`}>Apply ↗{job.apply_host ? ` (${job.apply_host})` : ''}</a>}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className={styles.tabs} role="tablist">
        {(['overview','description','enrichment','resume'] as Tab[]).map(t => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className={styles.section}>
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Job metadata</h2>
            <FieldGrid fields={[
              { label: 'ID',              value: job.id,           tooltip: 'Database row ID' },
              { label: 'Source',          value: job.source,       tooltip: 'Discovery source: linkedin or indeed' },
              { label: 'Company',         value: job.company },
              { label: 'Title',           value: job.title },
              { label: 'Location',        value: job.location },
              { label: 'Remote',          value: job.is_remote === 1 ? 'Yes' : job.is_remote === 0 ? 'No' : '—', tooltip: 'Whether the listing is flagged as remote' },
              { label: 'Level',           value: job.level,        tooltip: 'Seniority level from the listing' },
              { label: 'Category',        value: job.category },
              { label: 'Date posted',     value: job.date_posted },
              { label: 'Date scraped',    value: job.date_scraped, tooltip: 'When Hunt first found this listing' },
              { label: 'Apply type',      value: job.apply_type?.replace(/_/g,' '), tooltip: 'external_apply = company ATS. easy_apply = LinkedIn apply (skipped by automation).' },
              { label: 'ATS type',        value: job.ats_type,     tooltip: 'Applicant tracking system detected from the apply URL' },
              { label: 'Apply host',      value: job.apply_host,   tooltip: 'Domain of the apply URL', mono: true },
              { label: 'Auto-apply eligible', value: job.auto_apply_eligible === 1 ? 'Yes' : 'No', tooltip: 'Whether this job is eligible for automated apply (external only)' },
            ]} />
          </div>

          {/* Actions */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Actions</h2>
            <div className={styles.actions}>
              <button
                className={styles.actionBtn}
                onClick={handleRequeue}
                title="Reset enrichment status to pending so the worker picks it up again"
                disabled={!['linkedin','indeed'].includes(job.source ?? '')}
              >
                Requeue for enrichment
              </button>
              {job.priority ? (
                <button className={`${styles.actionBtn} ${styles.actionBtnSecondary}`} onClick={() => handlePriority(false)} title="Remove the run-next flag">
                  Clear priority flag
                </button>
              ) : (
                <button className={`${styles.actionBtn} ${styles.actionBtnSecondary}`} onClick={() => handlePriority(true)} title="Flag this row to be enriched before others">
                  Set as run next
                </button>
              )}
            </div>
          </div>

          {/* Operator notes */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Operator notes &amp; tag</h2>
            <div className={styles.metaForm}>
              <label className={styles.metaLabel}>
                Notes
                <textarea
                  className={styles.metaTextarea}
                  value={noteVal}
                  onChange={e => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Free-form notes visible in the jobs list…"
                />
              </label>
              <label className={styles.metaLabel}>
                Tag
                <input
                  className={styles.metaInput}
                  value={tagVal}
                  onChange={e => setTag(e.target.value)}
                  placeholder="Short categorical label for filtering"
                />
              </label>
              <button className={styles.actionBtn} onClick={handleSaveMeta} disabled={savingMeta}>
                {savingMeta ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'description' && (
        <div className={styles.section}>
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Job description</h2>
            {job.description
              ? <pre className={styles.descPre}>{job.description}</pre>
              : <p className="muted">No description saved yet — enrich the job first.</p>
            }
          </div>
        </div>
      )}

      {tab === 'enrichment' && (
        <div className={styles.section}>
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Enrichment status</h2>
            <FieldGrid fields={[
              { label: 'Status',          value: <StatusBadge status={job.enrichment_status} />, tooltip: 'Current enrichment lifecycle state' },
              { label: 'Attempts',        value: job.enrichment_attempts, tooltip: 'How many times enrichment has been tried' },
              { label: 'Enriched at',     value: job.enriched_at,         tooltip: 'When enrichment last succeeded' },
              { label: 'Last started',    value: job.last_enrichment_started_at, tooltip: 'When the last enrichment attempt started — if stuck in processing, this helps detect stale rows' },
              { label: 'Next retry at',   value: job.next_enrichment_retry_at, tooltip: 'Earliest time the worker will try this row again (backoff policy)' },
              { label: 'Last error',      value: job.last_enrichment_error, tooltip: 'Error code or message from the most recent failed attempt', mono: true, span: true },
            ]} />
          </div>

          {/* Failure artifacts */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Failure artifacts</h2>
            <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
              Screenshots, HTML snapshots, and text captures saved when enrichment was blocked.
            </p>
            {job.last_artifact_screenshot_path || job.last_artifact_html_path || job.last_artifact_text_path ? (
              <div className={styles.artifactLinks}>
                {job.last_artifact_screenshot_path && (
                  <a href={`/api/jobs/${jobId}/artifacts/screenshot`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="Open the screenshot saved when enrichment was blocked">
                    Screenshot ↗
                  </a>
                )}
                {job.last_artifact_html_path && (
                  <a href={`/api/jobs/${jobId}/artifacts/html`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="View the HTML snapshot of the page when enrichment was blocked">
                    HTML snapshot ↗
                  </a>
                )}
                {job.last_artifact_text_path && (
                  <a href={`/api/jobs/${jobId}/artifacts/text`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="View extracted text from the page when enrichment was blocked">
                    Text snapshot ↗
                  </a>
                )}
              </div>
            ) : (
              <p className="muted" style={{ fontSize: '0.88rem' }}>No failure artifacts saved for this job.</p>
            )}
          </div>
        </div>
      )}

      {tab === 'resume' && (
        <div className={styles.section}>
          {/* Keywords */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Resume status</h2>
            <FieldGrid fields={[
              { label: 'JD usable',     value: job.latest_resume_jd_usable === 1 ? 'Yes' : job.latest_resume_jd_usable === 0 ? 'No' : '—', tooltip: 'Whether the job description was good enough for resume tailoring' },
              { label: 'JD unusable reason', value: job.latest_resume_jd_usable_reason, tooltip: 'Why the description was rated unusable' },
              { label: 'Ready for C3',  value: job.selected_resume_ready_for_c3 === 1 ? 'Yes' : 'No', tooltip: 'Whether a resume is selected and ready for the Chrome extension to use' },
            ]} />
            {attempts.length > 0 && (
              <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <a href={`/api/jobs/${jobId}/resume/selected-pdf`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="Download the selected resume PDF">Selected PDF ↗</a>
                <a href={`/api/jobs/${jobId}/resume/selected-tex`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="View the selected resume LaTeX source">Selected TeX ↗</a>
                <a href={`/api/jobs/${jobId}/resume/keywords`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="View keywords extracted from the job description">Keywords JSON ↗</a>
              </div>
            )}
          </div>

          {/* Attempt history */}
          {attempts.length > 0 ? (
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>Generation history</h2>
              <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 12 }}>
                Each card is one tailoring run. Download PDF to get that version.
              </p>
              {attempts.map(a => (
                <div key={a.id} className={styles.attemptCard}>
                  <div className={styles.attemptHeader}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <StatusBadge status={a.status} size="sm" />
                      {a.is_selected_for_c3 && <span className={styles.selectedBadge} title="This version is selected for the Chrome extension to use">Selected for apply</span>}
                      {!a.is_selected_for_c3 && a.is_latest_useful && <span className={styles.usefulBadge} title="Most recent useful version">Useful</span>}
                      <span className="muted" style={{ fontSize: '0.8rem' }}>ID {a.id} · {a.created_at}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {a.pdf_path && <a href={`/api/attempts/${a.id}/pdf`} target="_blank" rel="noreferrer" className={`${styles.artifactBtn} ${styles.artifactBtnPrimary}`} title="Download this resume version as PDF">PDF ↗</a>}
                      {a.tex_path && <a href={`/api/attempts/${a.id}/tex`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="View the LaTeX source for this version">TeX ↗</a>}
                      {a.keywords_path && <a href={`/api/attempts/${a.id}/keywords`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="View keywords used for this version">Keywords ↗</a>}
                      <a href={`/api/attempts/${a.id}/llm`} target="_blank" rel="noreferrer" className={styles.artifactBtn} title="View the LLM prompt and response for this version">LLM I/O ↗</a>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: '0.83rem' }}>
                    <span className="muted">Family: <strong>{a.role_family ?? '—'}</strong></span>
                    <span className="muted">Level: <strong>{a.job_level ?? '—'}</strong></span>
                    <span className="muted">Model: <strong>{a.model_name ?? '—'}</strong></span>
                    <span className="muted">JD OK: <strong>{a.jd_usable === 1 ? 'yes' : a.jd_usable === 0 ? 'no' : '—'}</strong></span>
                  </div>
                  {a.jd_usable_reason && <p className="muted" style={{ fontSize: '0.83rem', marginTop: 6 }}>{a.jd_usable_reason}</p>}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.panel}>
              <h2 className={styles.panelTitle}>Generation history</h2>
              <p className="muted">No resume attempts yet. Run <code>fletch run generate-job {jobId}</code> to generate one.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
