import type { FitRole, FitSeniority, FitTier, Job, JobDetailsFilter } from '@/types/job'

export const fitTierLabels: Record<FitTier, string> = {
  p1: 'P1 · New grad and junior software / ML',
  p2: 'P2 · Software / ML internships',
  p3: 'P3 · Data science and analytics',
  p4: 'P4 · IT',
  p5: 'P5 · Business and tech-adjacent',
  outside_scope: 'Outside scope',
}

export const fitRoleLabels: Record<FitRole, string> = {
  software: 'Software',
  ml_engineering: 'ML engineering',
  data: 'Data science and analytics',
  it: 'IT',
  business: 'Business and tech-adjacent',
  other: 'Other',
  unknown: 'Unclear role',
}

export const fitSeniorityLabels: Record<FitSeniority, string> = {
  intern: 'Intern / co-op',
  new_grad: 'New grad',
  junior: 'Junior',
  above_junior: 'Above junior',
  unknown: 'Unclear seniority',
}

function knownFitValue<T extends string>(value: string | null, labels: Record<T, string>) {
  return value && Object.prototype.hasOwnProperty.call(labels, value) ? (value as T) : undefined
}

export function fitFilters(params: URLSearchParams) {
  return {
    tier: knownFitValue(params.get('tier'), fitTierLabels),
    role: knownFitValue(params.get('role'), fitRoleLabels),
    seniority: knownFitValue(params.get('seniority'), fitSeniorityLabels),
  }
}

export function jobFitTags(job: Job, includeTier = true): string {
  const tier = job.fit_tier ?? job.fit_review?.tier
  return [
    includeTier && (tier === 'outside_scope' ? 'Outside scope' : tier?.toUpperCase()),
    job.personal_fit_role && fitRoleLabels[job.personal_fit_role],
    job.personal_fit_seniority && fitSeniorityLabels[job.personal_fit_seniority],
  ]
    .filter(Boolean)
    .join(' · ')
}

export const detailQualityLabels: Record<string, string> = {
  enriched: 'Description + link',
  partial: 'Missing details',
  failed: 'No details',
}

export const enrichmentLabels: Record<JobDetailsFilter, string> = {
  all: 'Any enrichment',
  complete: 'Complete',
  description: 'Description missing',
  link: 'Application link unverified',
  both: 'Description and link needed',
}

export function detailsFilter(value: string | null): JobDetailsFilter {
  if (value === 'complete' || value === 'description' || value === 'link' || value === 'both')
    return value
  return 'all'
}

export function verifiedApplyLink(job: Job): boolean {
  return Boolean(
    job.apply_type === 'external_apply' &&
    job.auto_apply_eligible &&
    job.apply_url?.trim() &&
    ['done', 'done_verified'].includes(job.enrichment_status ?? ''),
  )
}

export function jobEnrichmentLabel(job: Job & { description?: string | null }): string {
  const hasDescription = Boolean(job.description?.trim() || job.has_description)
  const hasLink = verifiedApplyLink(job)
  if (hasDescription) return enrichmentLabels[hasLink ? 'complete' : 'link']
  return enrichmentLabels[hasLink ? 'description' : 'both']
}

export function shortEnrichmentLabel(job: Job): string {
  if (job.enrichment_status === 'processing') return 'Checking'
  if (job.has_description) return verifiedApplyLink(job) ? 'Complete' : 'Link check'
  return verifiedApplyLink(job) ? 'No description' : 'Both needed'
}

export function enrichmentIssue(job: Job): string | null {
  if (verifiedApplyLink(job)) return null
  const error = job.last_enrichment_error?.toLowerCase()
  if (error === 'job_removed') return 'Posting closed'
  if (job.enrichment_status === 'processing') return 'Checking the application link'
  if (error?.includes('429') || error?.includes('rate_limited')) return 'Source rate limit'
  if (error?.includes('login') || error?.includes('sign_in')) return 'Source needs sign-in'
  if (error?.includes('403') || error?.includes('checkpoint')) return 'Source blocked access'
  if (error?.includes('timeout')) return 'Source check timed out'
  return null
}

const reasons: Record<string, string> = {
  title_blacklist: 'Excluded by title rules',
  experienced_title: 'More senior than your target roles',
  geography_unverified: 'Location eligibility needs checking',
  outside_canada: 'Outside Canada',
  outside_search_geography: 'Outside your selected countries',
  career_stage_excluded: 'Outside your selected experience levels',
  remote_work_unverified: 'Remote work is not confirmed',
  employment_type_unverified: 'Employment type is not published',
  employment_type_excluded: 'Outside your selected employment types',
  outside_search_lanes: 'Outside your target roles',
  easy_apply_ineligible: 'Easy Apply is excluded',
  linkedin_only_apply_path: 'Only a LinkedIn application link is available',
  duplicate_canonical_job: 'Duplicate listing retained for history',
  removed_requisition: 'Previously removed requisition',
  possible_removed_requisition: 'May match a previously removed posting',
  employer_month_cap: 'Employer monthly limit reached',
  posting_date_unknown: 'Posting date unknown',
}

export function discoveryLabel(
  job: Pick<Job, 'discovery_suppressed_reason' | 'discovery_policy_version'>,
): string {
  const reason = job.discovery_suppressed_reason
  if (reason) return reasons[reason] ?? `Set aside: ${reason.replace(/_/g, ' ')}`
  return job.discovery_policy_version ? 'Passes discovery rules' : 'Discovery fit not checked'
}

const fitLabels: Record<NonNullable<Job['fit_review']>['stage'], string> = {
  awaiting_review: 'Awaiting AI review',
  awaiting_tags: 'Awaiting tier review',
  outside_review_window: 'Filtered before AI · Outside review window',
  filtered_before_ai: 'Filtered before AI',
  needs_information: 'AI reviewed · Needs more information',
  ai_rejected: 'Rejected by AI',
  approved_visible: 'AI approved · In My matches',
  approved_company_limit: 'AI approved · Held by company limit',
  approved_waiting_for_verification: 'AI approved',
  approved_outside_window: 'AI approved · Outside posting period',
  approved_filtered: 'AI approved · Filtered by Hunt',
  approved_applied: 'AI approved · Already applied',
  approved_canceled: 'AI approved · Canceled',
  application_history: 'Application history',
}

export function fitReviewLabel(fit: Job['fit_review']): string | null {
  if (!fit) return null
  const label = fitLabels[fit.stage]
  if (fit.stage === 'approved_waiting_for_verification' && fit.reason === 'geography_unverified') {
    return 'AI approved · Location still unverified'
  }
  if (fit.reason && (fit.stage === 'filtered_before_ai' || fit.stage === 'approved_filtered')) {
    const reason = fit.reason === 'posting_closed' ? 'Posting closed' : reasons[fit.reason]
    return reason ? `${label} · ${reason}` : label
  }
  return label
}

export function matchHoldReason(fit: Job['fit_review']): string | null {
  if (fit?.stage === 'approved_company_limit') return 'Held by company limit'
  if (fit?.stage === 'approved_outside_window') return 'Outside My matches date range'
  if (fit?.stage === 'approved_filtered' && fit.reason === 'posting_date_unknown')
    return 'Posting date unknown'
  return null
}

export function jobReviewStatus(job: Job): string {
  const state = job.status?.toLowerCase()
  if (state === 'applied') return 'Applied'
  if (state === 'canceled' || state === 'cancelled') return 'Canceled'
  const error = job.last_enrichment_error
  if (error === 'job_removed') return 'Posting closed'
  if (job.apply_type === 'easy_apply') return 'Easy Apply only'
  const fit = job.fit_review
  if (fit?.stage === 'awaiting_tags') return 'Awaiting tier review'
  if (fit?.stage === 'ai_rejected' || job.personal_fit === 'no') return 'Doesn’t match'
  if (fit?.stage === 'needs_information' || job.personal_fit === 'deferred')
    return 'Fit needs more information'
  if (fit?.stage === 'awaiting_review') return 'Awaiting agent review'
  if (
    fit?.stage === 'filtered_before_ai' ||
    (fit?.stage === 'approved_filtered' && fit.reason !== 'posting_date_unknown')
  )
    return (fit.reason && reasons[fit.reason]) || 'Excluded by job filters'
  if (job.discovery_suppressed_reason === 'geography_unverified') return 'Location needs checking'
  return fit?.stage.startsWith('approved_') || job.personal_fit === 'yes'
    ? 'Confirmed'
    : 'Awaiting agent review'
}
