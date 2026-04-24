export type EnrichmentStatus =
  | 'pending'
  | 'processing'
  | 'done'
  | 'done_verified'
  | 'failed'
  | 'blocked'
  | 'blocked_verified'

export type JobSource = 'linkedin' | 'indeed'
export type ApplyType = 'external_apply' | 'easy_apply' | 'unknown'

/** Row returned by GET /api/jobs (list view — no description by default) */
export interface Job {
  id: number
  title: string
  company: string
  location: string | null
  source: JobSource
  job_url: string | null
  apply_url: string | null
  apply_type: ApplyType | null
  apply_host: string | null
  ats_type: string | null
  auto_apply_eligible: 0 | 1 | null
  enrichment_status: EnrichmentStatus | null
  enrichment_attempts: number
  enriched_at: string | null
  last_enrichment_error: string | null
  last_enrichment_started_at: string | null
  next_enrichment_retry_at: string | null
  priority: 0 | 1
  date_posted: string | null
  date_scraped: string | null
  is_remote: 0 | 1 | null
  level: string | null
  category: string | null
  operator_notes: string | null
  operator_tag: string | null
  // Resume fields
  latest_resume_jd_usable: 0 | 1 | null
  latest_resume_jd_usable_reason: string | null
  selected_resume_ready_for_c3: 0 | 1 | null
}

/** Row returned by GET /api/jobs/:id (includes description + artifact paths) */
export interface JobDetail extends Job {
  description: string | null
  last_artifact_dir: string | null
  last_artifact_screenshot_path: string | null
  last_artifact_html_path: string | null
  last_artifact_text_path: string | null
  latest_resume_job_description_path: string | null
  latest_resume_keywords_path: string | null
  latest_resume_flags: string | null
  selected_resume_version_id: number | null
  selected_resume_pdf_path: string | null
  selected_resume_tex_path: string | null
  selected_resume_selected_at: string | null
}

/** Resume attempt row from fletcher.db */
export interface ResumeAttempt {
  id: number
  job_id: number
  status: string
  role_family: string | null
  job_level: string | null
  model_name: string | null
  base_resume_name: string | null
  jd_usable: 0 | 1 | null
  jd_usable_reason: string | null
  concern_flags: string | null
  pdf_path: string | null
  tex_path: string | null
  keywords_path: string | null
  created_at: string | null
  is_selected_for_c3: boolean
  is_latest_useful: boolean
}

export type SortField =
  | 'id'
  | 'date_scraped'
  | 'company'
  | 'title'
  | 'enrichment_status'
  | 'apply_type'
  | 'enrichment_attempts'
  | 'next_enrichment_retry_at'
  | 'enriched_at'
  | 'last_enrichment_error'
  | 'source'

export type SortDirection = 'asc' | 'desc'

export interface JobsQuery {
  source?: string
  status?: string
  limit?: number
  page?: number
  q?: string
  tag?: string
  sort?: SortField
  direction?: SortDirection
}
