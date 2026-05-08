export type ReviewVersionName = 'starting' | 'no_summary' | 'with_summary'

export interface ResumeHeader {
  name: string
  contact_line: string
}

export interface EducationEntry {
  entry_id: string
  institution_and_degree: string
  date_text: string
}

export interface EducationSection {
  entry: EducationEntry
  bullets: string[]
}

export interface ExperienceEntry {
  entry_id: string
  title_company_location: string
  date_text: string
  bullets: string[]
}

export interface ProjectEntry {
  entry_id: string
  project_title: string
  date_or_link_text: string
  bullets: string[]
}

export interface SkillsSection {
  languages: string[]
  frameworks: string[]
  developer_tools: string[]
}

export interface ResumeDocument {
  source_path: string
  preamble: string
  header: ResumeHeader
  summary: string
  education: EducationSection
  experience: ExperienceEntry[]
  projects: ProjectEntry[]
  skills: SkillsSection
  section_order?: string[]
}

export interface ResumeReviewVersion {
  original: ResumeDocument
  generated: ResumeDocument
  current: ResumeDocument
  pdf_url: string
  tex_url: string
  dirty: boolean
  compiled_revision: number
  compile_status?: string | null
}

export interface ResumeReviewPackage {
  review_id: string
  source: {
    input_kind: string
    input_filename: string
    import_status: 'ok' | 'warning' | 'failed'
    import_warnings: string[]
  }
  job: {
    title: string
    company: string
    description_hash: string
  }
  llm?: {
    provider: string
    model: string
    cloud: boolean
  }
  keywords: {
    raw?: string[]
    present?: string[]
    missing?: string[]
    rag_scores?: KeywordScore[]
  }
  versions: Partial<Record<ReviewVersionName, ResumeReviewVersion>>
  log_url: string
}

export interface KeywordScore {
  keyword: string
  tier?: string
  status?: string
  score?: number
  bullet_idx?: number | null
}

export interface FletcherQueueItem {
  queue_item_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'cancel_requested' | string
  position: number
  revision: number
  created_at: string | null
  started_at: string | null
  finished_at: string | null
  input: {
    job_id?: number | null
    title?: string
    company?: string
    description?: string
    resume_filename?: string
    options?: Record<string, unknown>
  }
  progress: {
    current_step?: string
    event_id?: number
    percent?: number
    log_tail?: string[]
  }
  result: {
    review_id?: string | null
    pdf_url?: string | null
    tex_url?: string | null
    log_url?: string | null
  }
  error: string | null
}
