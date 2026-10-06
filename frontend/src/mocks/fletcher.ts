import type {
  FletcherQueueItem,
  ResumeDocument,
  ResumeReviewPackage,
} from '@/pages/Fletcher/review/types'

const original: ResumeDocument = {
  source_path: 'example.tex',
  preamble: '',
  header: { name: 'Example Candidate', contact_line: 'Edmonton, AB | candidate@example.com' },
  summary: '',
  education: {
    entry: {
      entry_id: 'degree',
      institution_and_degree: 'Example University, Computer Science',
      date_text: '2026',
    },
    bullets: [],
  },
  experience: [
    {
      entry_id: 'engineer',
      title_company_location: 'Software Engineer, Example Labs',
      date_text: '2024–2026',
      bullets: ['Built Python services for internal tools.'],
    },
  ],
  projects: [
    {
      entry_id: 'project',
      project_title: 'Search project',
      date_or_link_text: '2026',
      bullets: ['Built a searchable job catalog.'],
    },
  ],
  skills: { languages: ['Python', 'SQL'], frameworks: ['FastAPI'], developer_tools: ['Git'] },
}
const generated = structuredClone(original)
generated.experience[0].bullets[0] = 'Built Python APIs for internal tools using FastAPI.'

export const MOCK_REVIEW: ResumeReviewPackage = {
  review_id: 'example',
  source: {
    input_kind: 'tex',
    input_filename: 'example.tex',
    import_status: 'ok',
    import_warnings: [],
  },
  job: { title: 'Backend Engineer', company: 'Example Labs', description_hash: 'example' },
  llm: { provider: 'ollama', model: 'example', cloud: false },
  keywords: { present: ['Python'], missing: ['Kubernetes'], raw: ['Python', 'Kubernetes'] },
  versions: {
    no_summary: {
      original,
      generated,
      current: generated,
      pdf_url: '',
      tex_url: '',
      dirty: false,
      document_revision: 0,
      compiled_revision: 0,
      compiled_document_revision: 0,
      compile_status: 'ok',
    },
  },
  log_url: '',
}

export const MOCK_FLETCHER_JOBS: FletcherQueueItem[] = [
  {
    queue_item_id: 'example-complete',
    status: 'succeeded',
    position: 1,
    revision: 1,
    created_at: '2026-10-05T18:00:00Z',
    started_at: '2026-10-05T18:00:01Z',
    finished_at: '2026-10-05T18:01:00Z',
    input: {
      title: 'Backend Engineer',
      company: 'Example Labs',
      resume_filename: 'example.tex',
      description: 'Build Python services.',
    },
    progress: { percent: 100 },
    result: { review_id: 'example', compile_status: 'ok' },
    error: null,
  },
  {
    queue_item_id: 'example-failed',
    status: 'failed',
    position: 2,
    revision: 1,
    created_at: '2026-10-05T18:02:00Z',
    started_at: '2026-10-05T18:02:01Z',
    finished_at: '2026-10-05T18:03:00Z',
    input: {
      title: 'Platform Engineer',
      company: 'Example Company',
      resume_filename: 'example.tex',
    },
    progress: { percent: 20 },
    result: {},
    error: 'Model connection timed out. Check the provider in Settings and retry.',
  },
]
