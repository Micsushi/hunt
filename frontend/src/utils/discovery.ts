import type { Job } from '@/types/job'

export const detailQualityLabels: Record<string, string> = {
  enriched: 'Description + link',
  partial: 'Missing details',
  failed: 'No details',
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
  outside_review_window: 'Filtered before AI · Outside review window',
  filtered_before_ai: 'Filtered before AI',
  needs_information: 'AI reviewed · Needs more information',
  ai_rejected: 'Rejected by AI',
  approved_visible: 'AI approved · In My matches',
  approved_company_limit: 'AI approved · Held by company limit',
  approved_waiting_for_verification: 'AI approved · Waiting for verification',
  approved_outside_window: 'AI approved · Outside review window',
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
