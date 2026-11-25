export type EnrichmentStatus =
  | 'pending'
  | 'processing'
  | 'done'
  | 'done_verified'
  | 'failed'
  | 'failed_url'
  | 'failed_description'
  | 'failed_enrichment'
  | 'blocked'
  | 'blocked_verified'

export type FitReviewStage =
  | 'awaiting_review'
  | 'awaiting_tags'
  | 'outside_review_window'
  | 'filtered_before_ai'
  | 'needs_information'
  | 'ai_rejected'
  | 'approved_visible'
  | 'approved_company_limit'
  | 'approved_waiting_for_verification'
  | 'approved_outside_window'
  | 'approved_filtered'
  | 'approved_applied'
  | 'approved_canceled'
  | 'application_history'

export interface FitReviewRun {
  id?: string
  trigger?: 'manual' | 'scheduled' | 'backfill'
  status: 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'unconfirmed'
  reviewed?: number
  new_visible_count?: number
  reason?: string
}

export type JobSource = string
export type ApplyType = 'external_apply' | 'easy_apply' | 'unknown'
export type FitTier = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'outside_scope'
export type FitRole =
  | 'software'
  | 'ml_engineering'
  | 'data'
  | 'it'
  | 'business'
  | 'other'
  | 'unknown'
export type FitSeniority = 'intern' | 'new_grad' | 'junior' | 'above_junior' | 'unknown'

/** Row returned by GET /api/jobs (list view - no description by default) */
export interface Job {
  id: number
  status?: string | null
  application_date?: string | null
  personal_fit?: 'yes' | 'no' | 'deferred' | null
  personal_fit_role?: FitRole | null
  personal_fit_seniority?: FitSeniority | null
  fit_tier?: FitTier | null
  fit_review?: { stage: FitReviewStage; reason: string | null; tier?: FitTier | null } | null
  title: string
  company: string
  location: string | null
  source: JobSource
  job_url: string | null
  has_description?: boolean | 0 | 1
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
  discovery_suppressed_reason?: string | null
  discovery_policy_version?: number | null
  // Resume fields
  latest_resume_jd_usable: 0 | 1 | null
  latest_resume_jd_usable_reason: string | null
  selected_resume_ready_for_c3: 0 | 1 | null
}

/** Row returned by GET /api/jobs/:id (includes description + artifact paths) */
export interface JobDetail extends Job {
  status?: string | null
  discovery_suppressed_reason?: string | null
  description: string | null
  description_source: string | null
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
  | 'date_posted'
  | 'fit_tier'
  | 'review_status'
  | 'enrichment_details'
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
export type JobDetailsFilter = 'all' | 'complete' | 'description' | 'link' | 'both'

export interface JobsQuery {
  view?: 'all' | 'matches' | 'history'
  match_days?: number
  company_limit?: number
  match_status?: 'all' | 'ready' | 'needs_verification'
  details?: JobDetailsFilter
  tier?: FitTier
  role?: FitRole
  seniority?: FitSeniority
  source?: string
  status?: string
  limit?: number
  page?: number
  q?: string
  tag?: string
  category?: string
  ats_type?: string
  sort?: SortField
  direction?: SortDirection
}

export interface JobsResponse {
  items: Job[]
  total: number
}
