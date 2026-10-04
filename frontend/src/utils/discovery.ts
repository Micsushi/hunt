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
  employer_month_cap: 'Employer monthly limit reached',
}

export function discoveryLabel(
  job: Pick<Job, 'discovery_suppressed_reason' | 'discovery_policy_version'>,
): string {
  const reason = job.discovery_suppressed_reason
  if (reason) return reasons[reason] ?? `Set aside: ${reason.replace(/_/g, ' ')}`
  return job.discovery_policy_version ? 'Passes discovery rules' : 'Discovery fit not checked'
}
