import { useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useJobDetail, useResumeAttempts, useAdjacentJobs } from '@/hooks/useJobDetail'
import { useUiStore } from '@/store/ui'
import { requeueJob, setJobPriority, patchJob, deleteJob } from '@/api/jobs'
import { triggerC2Generate, fetchSystemStatus } from '@/api/control'
import { StatusBadge } from '@/components/StatusBadge'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import styles from './JobDetail.module.css'

type EditableField =
  | 'company' | 'title' | 'location' | 'level' | 'category' | 'is_remote'
  | 'description' | 'description_source' | 'operator_notes' | 'operator_tag'

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

function InlineField({ label, value, field, onSave, mono, type = 'text', options, placeholder }: InlineFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)

  function startEdit() {
    setDraft(value != null ? String(value) : '')
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  async function commit() {
    if (draft === (value != null ? String(value) : '')) { setEditing(false); return }
    setSaving(true)
    try { await onSave(field, draft) } finally { setSaving(false); setEditing(false) }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') setEditing(false)
    if (e.key === 'Enter' && type !== 'textarea') commit()
  }

  const display = value != null && value !== '' ? String(value) : null

  return (
    <div className={`${styles.inlineField} ${styles.inlineFieldEditable} ${type === 'textarea' ? styles.inlineFieldBlock : ''}`}>
      {label && <span className={styles.inlineLabel}>{label}</span>}
      {editing ? (
        type === 'select' && options ? (
          <select ref={inputRef as React.Ref<HTMLSelectElement>} className={styles.inlineInput}
            value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : type === 'textarea' ? (
          <textarea ref={inputRef as React.Ref<HTMLTextAreaElement>}
            className={`${styles.inlineInput} ${styles.inlineTextarea}`}
            value={draft} onChange={e => setDraft(e.target.value)}
            onBlur={commit} onKeyDown={onKeyDown} disabled={saving} rows={8} placeholder={placeholder} />
        ) : (
          <input ref={inputRef as React.Ref<HTMLInputElement>} className={styles.inlineInput}
            value={draft} onChange={e => setDraft(e.target.value)}
            onBlur={commit} onKeyDown={onKeyDown} disabled={saving} placeholder={placeholder} />
        )
      ) : (
        <button
          className={`${styles.inlineValue} ${mono ? styles.mono : ''} ${type === 'textarea' ? styles.inlineValueBlock : ''}`}
          onClick={startEdit} title="Click to edit"
        >
          {display ?? <span className={styles.inlinePlaceholder}>{placeholder ?? 'Click to edit...'}</span>}
          <span className={styles.editHint}>✎</span>
        </button>
      )}
    </div>
  )
}



// ── Readonly field ────────────────────────────────────────────────────────────

function ReadonlyField({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className={styles.inlineField}>
      <span className={styles.inlineLabel}>{label}</span>
      <span className={`${styles.inlineValueReadonly} ${mono ? styles.mono : ''}`}>{value ?? '-'}</span>
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
    <span className={`${styles.serviceChip} ${ok ? styles.serviceOk : unknown ? styles.serviceUnknown : styles.serviceDown}`}>
      <span className={styles.serviceDot} />
      {label}: {unknown ? 'unknown' : ok ? 'online' : 'offline'}
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>()
  const jobId = parseInt(id ?? '0', 10)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const showToast = useUiStore(s => s.showToast)
  const [generating, setGenerating] = useState(false)

  const { data: job, isLoading, error } = useJobDetail(jobId)
  const { data: attempts = [] } = useResumeAttempts(jobId)
  const { data: adjacent } = useAdjacentJobs(jobId)

  if (isLoading) return <div className={styles.loading}>Loading...</div>
  if (error || !job) return (
    <div className={styles.errorPage}>
      <p>Job not found or failed to load.</p>
      <button className={styles.backBtn} onClick={() => navigate('/jobs')}>Back to jobs</button>
    </div>
  )

  async function handleFieldSave(field: EditableField, value: string) {
    try {
      const payload: Record<string, string | number | null> = {}
      if (field === 'is_remote') {
        payload[field] = value === 'Yes' ? 1 : value === 'No' ? 0 : null
      } else {
        payload[field] = value.trim() || null
      }
      await patchJob(jobId, payload)
      showToast('Saved')
      qc.invalidateQueries({ queryKey: ['job', jobId] })
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Update failed', 'error')
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
      showToast('Job deleted')
      navigate('/jobs')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Delete failed', 'error')
    }
  }

  async function handleGenerate() {
    setGenerating(true)
    try {
      await triggerC2Generate(jobId)
      showToast('Resume generation triggered')
      setTimeout(() => qc.invalidateQueries({ queryKey: ['resume-attempts', jobId] }), 2000)
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Generate failed', 'error')
    } finally {
      setGenerating(false)
    }
  }

  const remoteDisplay = job.is_remote === 1 ? 'Yes' : job.is_remote === 0 ? 'No' : ''
  const descriptionSource = (job as Record<string, unknown>).description_source as string | null | undefined

  return (
    <div className={styles.page}>

      {/* Top menu card */}
      <div className={styles.menuCard}>
        <button className={styles.backBtn} onClick={() => navigate(-1)}>← Back</button>
        <span className={styles.headerId}>#{job.id}</span>
        <div className={styles.navBtns}>
          <button className={styles.navBtn}
            onClick={() => adjacent?.prev_id != null && navigate(`/jobs/${adjacent.prev_id}`)}
            disabled={adjacent?.prev_id == null} title="Previous job">‹</button>
          <button className={styles.navBtn}
            onClick={() => adjacent?.next_id != null && navigate(`/jobs/${adjacent.next_id}`)}
            disabled={adjacent?.next_id == null} title="Next job">›</button>
        </div>
        <div className={styles.menuLinks}>
          {job.job_url && <a href={job.job_url} target="_blank" rel="noreferrer" className={styles.extBtn}>Listing ↗</a>}
          {job.apply_url && <a href={job.apply_url} target="_blank" rel="noreferrer" className={styles.extBtn}>Apply ↗</a>}
        </div>
        <button className={styles.deleteBtn} onClick={handleDelete}>Delete</button>
      </div>

      {/* Two-column body */}
      <div className={styles.body}>

        {/* Left: fields + description */}
        <div className={styles.col}>
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Job fields</h2>
            <div className={styles.fieldList}>
              <InlineField label="Company"  field="company"        value={job.company}        onSave={handleFieldSave} />
              <InlineField label="Title"    field="title"          value={job.title}          onSave={handleFieldSave} />
              <InlineField label="Location" field="location"       value={job.location}       onSave={handleFieldSave} />
              <InlineField label="Level"    field="level"          value={job.level}          onSave={handleFieldSave} />
              <InlineField label="Category" field="category"       value={job.category}       onSave={handleFieldSave} />
              <InlineField label="Remote"   field="is_remote"      value={remoteDisplay}      onSave={handleFieldSave}
                type="select"
                options={[{ label: '-', value: '' }, { label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }]}
              />
              <ReadonlyField label="Source"     value={job.source} />
              <ReadonlyField label="Apply type" value={job.apply_type?.replace(/_/g, ' ')} />
              <ReadonlyField label="ATS type"   value={job.ats_type} />
              <ReadonlyField label="Apply host" value={job.apply_host} mono />
              <ReadonlyField label="Auto-apply" value={job.auto_apply_eligible === 1 ? 'Yes' : 'No'} />
              <ReadonlyField label="Posted"     value={job.date_posted} />
              <ReadonlyField label="Scraped"    value={job.date_scraped} />
              <InlineField label="Tag"   field="operator_tag"   value={job.operator_tag}   onSave={handleFieldSave}
                placeholder="e.g. applied, skip, followup" />
              <InlineField label="Notes" field="operator_notes" value={job.operator_notes} onSave={handleFieldSave}
                type="textarea" placeholder="Free-form notes..." />
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Job description</h2>
              <div className={styles.jdMeta}>
                {descriptionSource === 'scraped' && <span className={styles.scrapedBadge}>Scraped</span>}
                {descriptionSource === 'manual' && <span className={styles.manualBadge}>Manual</span>}
                <label className={styles.lockToggle} title="When locked, enrichment will not overwrite this description">
                  <input
                    type="checkbox"
                    checked={descriptionSource === 'manual'}
                    onChange={async e => {
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
              <ReadonlyField label="Status"       value={<StatusBadge status={job.enrichment_status} />} />
              <ReadonlyField label="Attempts"     value={job.enrichment_attempts} />
              <ReadonlyField label="Enriched at"  value={job.enriched_at} />
              <ReadonlyField label="Last started" value={job.last_enrichment_started_at} />
              <ReadonlyField label="Next retry"   value={job.next_enrichment_retry_at} />
              {job.last_enrichment_error && (
                <ReadonlyField label="Last error" value={job.last_enrichment_error} mono />
              )}
            </div>
            <div className={styles.panelActions}>
              <button className={styles.actionBtn} onClick={handleRequeue}
                disabled={!['linkedin','indeed'].includes(job.source ?? '')}>
                Requeue
              </button>
              {job.priority ? (
                <button className={`${styles.actionBtn} ${styles.actionBtnSecondary}`} onClick={() => handlePriority(false)}>
                  Clear priority
                </button>
              ) : (
                <button className={`${styles.actionBtn} ${styles.actionBtnSecondary}`} onClick={() => handlePriority(true)}>
                  Run next
                </button>
              )}
            </div>
            {(job.last_artifact_screenshot_path || job.last_artifact_html_path || job.last_artifact_text_path) && (
              <div className={styles.artifactLinks} style={{ marginTop: 10 }}>
                {job.last_artifact_screenshot_path && <a href={`/api/jobs/${jobId}/artifacts/screenshot`} target="_blank" rel="noreferrer" className={styles.artifactBtn}>Screenshot ↗</a>}
                {job.last_artifact_html_path && <a href={`/api/jobs/${jobId}/artifacts/html`} target="_blank" rel="noreferrer" className={styles.artifactBtn}>HTML ↗</a>}
                {job.last_artifact_text_path && <a href={`/api/jobs/${jobId}/artifacts/text`} target="_blank" rel="noreferrer" className={styles.artifactBtn}>Text ↗</a>}
              </div>
            )}
          </div>

          <div className={styles.panel}>
            <div className={styles.panelTitleRow}>
              <h2 className={styles.panelTitle}>Resume</h2>
              <ServiceChip label="Fletcher" componentKey="c2" />
            </div>
            <div className={styles.fieldList}>
              <ReadonlyField label="JD usable"     value={job.latest_resume_jd_usable === 1 ? 'Yes' : job.latest_resume_jd_usable === 0 ? 'No' : '-'} />
              <ReadonlyField label="Usable reason" value={job.latest_resume_jd_usable_reason} />
              <ReadonlyField label="Ready for C3"  value={job.selected_resume_ready_for_c3 === 1 ? 'Yes' : 'No'} />
            </div>
            <div className={styles.panelActions}>
              <button className={styles.actionBtn} onClick={handleGenerate} disabled={generating}>
                {generating ? 'Generating...' : 'Generate resume'}
              </button>
            </div>
            {attempts.length > 0 && (
              <div className={styles.artifactLinks} style={{ marginTop: 10 }}>
                <a href={`/api/jobs/${jobId}/resume/selected-pdf`} target="_blank" rel="noreferrer" className={styles.artifactBtn}>Selected PDF ↗</a>
                <a href={`/api/jobs/${jobId}/resume/selected-tex`} target="_blank" rel="noreferrer" className={styles.artifactBtn}>Selected TeX ↗</a>
                <a href={`/api/jobs/${jobId}/resume/keywords`} target="_blank" rel="noreferrer" className={styles.artifactBtn}>Keywords ↗</a>
              </div>
            )}
            {attempts.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 8 }}>Generation history</p>
                {attempts.map(a => (
                  <div key={a.id} className={styles.attemptCard}>
                    <div className={styles.attemptHeader}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <StatusBadge status={a.status} size="sm" />
                        {a.is_selected_for_c3 && <span className={styles.selectedBadge}>Selected</span>}
                        {!a.is_selected_for_c3 && a.is_latest_useful && <span className={styles.usefulBadge}>Useful</span>}
                        <span className="muted" style={{ fontSize: '0.75rem' }}>#{a.id} · {a.created_at}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 5 }}>
                        {a.pdf_path && <a href={`/api/attempts/${a.id}/pdf`} target="_blank" rel="noreferrer" className={`${styles.artifactBtn} ${styles.artifactBtnPrimary}`}>PDF ↗</a>}
                        {a.tex_path && <a href={`/api/attempts/${a.id}/tex`} target="_blank" rel="noreferrer" className={styles.artifactBtn}>TeX ↗</a>}
                        <a href={`/api/attempts/${a.id}/llm`} target="_blank" rel="noreferrer" className={styles.artifactBtn}>LLM ↗</a>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: '0.8rem' }}>
                      <span className="muted">Family: <strong>{a.role_family ?? '-'}</strong></span>
                      <span className="muted">Level: <strong>{a.job_level ?? '-'}</strong></span>
                      <span className="muted">JD OK: <strong>{a.jd_usable === 1 ? 'yes' : a.jd_usable === 0 ? 'no' : '-'}</strong></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {attempts.length === 0 && (
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: 12 }}>No attempts yet.</p>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
