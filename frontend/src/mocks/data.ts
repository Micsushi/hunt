import type { ComponentSetting, LinkedInAccount, SystemStatus } from '@/api/control'
import type { BreakdownData, DailyDigest, QueueAgeData, TimelineData, VelocityData } from '@/api/summary'
import type { Job, JobDetail, ResumeAttempt } from '@/types/job'
import type { AuthStatus, LogsData, QueueSummary } from '@/types/summary'

const now = new Date().toISOString()

export const MOCK_AUTH: AuthStatus = {
  authenticated: true,
  username: 'dev',
}

export const MOCK_JOBS: Job[] = [
  {
    id: 1,
    title: 'Senior Software Engineer',
    company: 'Acme Corp',
    location: 'Remote',
    source: 'linkedin',
    job_url: 'https://example.com/jobs/1',
    apply_url: 'https://example.com/apply/1',
    apply_type: 'external_apply',
    apply_host: 'example.com',
    ats_type: 'greenhouse',
    auto_apply_eligible: 1,
    enrichment_status: 'done',
    enrichment_attempts: 1,
    enriched_at: now,
    last_enrichment_error: null,
    last_enrichment_started_at: null,
    next_enrichment_retry_at: null,
    priority: 0,
    date_posted: null,
    date_scraped: now,
    is_remote: 1,
    level: 'Senior',
    category: 'engineering',
    operator_notes: null,
    operator_tag: 'mock',
    latest_resume_jd_usable: 1,
    latest_resume_jd_usable_reason: null,
    selected_resume_ready_for_c3: 1,
  },
  {
    id: 2,
    title: 'Staff Engineer',
    company: 'Globex',
    location: 'Vancouver, BC',
    source: 'indeed',
    job_url: 'https://example.com/jobs/2',
    apply_url: 'https://example.com/apply/2',
    apply_type: 'unknown',
    apply_host: 'example.com',
    ats_type: null,
    auto_apply_eligible: 0,
    enrichment_status: 'pending',
    enrichment_attempts: 0,
    enriched_at: null,
    last_enrichment_error: null,
    last_enrichment_started_at: null,
    next_enrichment_retry_at: null,
    priority: 0,
    date_posted: null,
    date_scraped: now,
    is_remote: 0,
    level: 'Staff',
    category: 'engineering',
    operator_notes: null,
    operator_tag: null,
    latest_resume_jd_usable: null,
    latest_resume_jd_usable_reason: null,
    selected_resume_ready_for_c3: 0,
  },
]

export const MOCK_JOB_DETAIL: JobDetail = {
  ...MOCK_JOBS[0],
  description: 'Mock job description for UI-only development.',
  description_source: 'manual',
  last_artifact_dir: null,
  last_artifact_screenshot_path: null,
  last_artifact_html_path: null,
  last_artifact_text_path: null,
  latest_resume_job_description_path: null,
  latest_resume_keywords_path: null,
  latest_resume_flags: null,
  selected_resume_version_id: null,
  selected_resume_pdf_path: null,
  selected_resume_tex_path: null,
  selected_resume_selected_at: null,
}

export const MOCK_ATTEMPTS: ResumeAttempt[] = []

export const MOCK_SUMMARY: QueueSummary = {
  total: 2,
  ready_count: 1,
  pending_count: 1,
  retry_ready_count: 0,
  processing_count: 0,
  blocked_count: 0,
  stale_processing_count: 0,
  oldest_processing_started_at: null,
  counts_by_status: { done: 1, pending: 1 },
  source_counts: { linkedin: 1, indeed: 1 },
  failure_counts: {},
  auth: {
    linkedin: {
      available: true,
      status: 'mock',
      updated_at: now,
      last_error: null,
    },
  },
  events: {},
}

export const MOCK_LOGS: LogsData = {
  summary: MOCK_SUMMARY,
  activity: { hours: 24, done_or_verified: 1, failed_scraped_window: 0, rows_scraped_window: 2 },
  runtime_state: [],
  audit: [],
  logs: [
    { at: now, service: 'c0', level: 'INFO', message: 'mock mode active', detail: null },
    { at: now, service: 'c1', level: 'INFO', message: 'job discovery disabled in mock mode', detail: null },
  ],
}

export const MOCK_SYSTEM_STATUS: SystemStatus = {
  status: 'mock',
  db: { status: 'mock', detail: 'not connected in UI-only mode' },
  components: {
    c0: { component: 'c0', status: 'ok', status_code: 200, url: 'mock://c0' },
    c1: { component: 'c1', status: 'unreachable', status_code: null, url: 'mock://c1' },
    c2: { component: 'c2', status: 'unreachable', status_code: null, url: 'mock://c2' },
    c3: { component: 'c3', status: 'unreachable', status_code: null, pending_fills: 0, url: 'mock://c3' },
    c4: { component: 'c4', status: 'unreachable', status_code: null, url: 'mock://c4' },
  },
}

export const MOCK_BREAKDOWN: BreakdownData = {
  field: 'enrichment_status',
  data: [
    { label: 'done', count: 1 },
    { label: 'pending', count: 1 },
  ],
}

export const MOCK_TIMELINE: TimelineData = {
  days: 30,
  data: [
    { day: now.slice(0, 10), source: 'linkedin', count: 1 },
    { day: now.slice(0, 10), source: 'indeed', count: 1 },
  ],
}

export const MOCK_DAILY: DailyDigest = {
  date: now.slice(0, 10),
  scraped_today: 2,
  enriched_today: 1,
  failed_today: 0,
  enriched_24h: 1,
  failed_24h: 0,
  scraped_24h: 2,
}

export const MOCK_VELOCITY: VelocityData = {
  enriched_24h: 1,
  enriched_prev_24h: 0,
  scraped_24h: 2,
  jobs_per_hour: 0.1,
  delta: 1,
}

export const MOCK_QUEUE_AGE: QueueAgeData = {
  count: 1,
  oldest_hours: 2,
  p50_hours: 2,
  p90_hours: 2,
  over_24h: 0,
}

export const MOCK_SETTINGS: { settings: ComponentSetting[] } = {
  settings: [
    {
      component: 'c1',
      key: 'mock_mode',
      value: 'true',
      value_type: 'boolean',
      secret: false,
      has_value: true,
      updated_at: now,
      updated_by: 'mock',
    },
  ],
}

export const MOCK_LINKEDIN_ACCOUNTS: { accounts: LinkedInAccount[] } = {
  accounts: [
    {
      id: 1,
      username: 'mock@example.com',
      display_name: 'Mock LinkedIn',
      active: true,
      auth_state: 'mock',
      last_auth_check: now,
      last_auth_error: null,
      created_at: now,
      updated_at: now,
      has_password: false,
    },
  ],
}

export const MOCK_C1_STATUS = { status: 'mock', service: 'hunter' }
export const MOCK_C1_QUEUE = { pending: 1, processing: 0, retry_ready: 0 }
export const MOCK_C2_STATUS = { status: 'mock', service: 'fletcher' }
export const MOCK_C4_STATUS = { status: 'unreachable', service: 'coordinator' }
export const MOCK_C4_RUNS = { runs: [] }
export const MOCK_PENDING_FILLS = { fills: [] }
