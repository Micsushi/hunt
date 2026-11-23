import { post } from './client'
import { browserC3, type BrowserC3Import, type BrowserC3Status } from './browserC3'

export type HandoffOutcome = {
  sourceJobId: number
  status:
    | 'confirmed'
    | 'unconfirmed'
    | 'not_sent'
    | 'rejected'
    | 'current_page'
    | 'bound_current_page'
  reason?: string
}

export function handoffMessage(outcome: HandoffOutcome) {
  if (outcome.status === 'not_sent' && outcome.reason) return `Not sent. ${outcome.reason}`
  return (
    outcome.reason ??
    {
      confirmed: 'Confirmed in Applications',
      unconfirmed: 'Not confirmed. Check Applications.',
      not_sent: 'Not sent',
      rejected: 'Rejected. Open the job to resolve the issue.',
      current_page: 'Left out of the handoff. Open the employer site and use Fill current page.',
      bound_current_page:
        'Saved in Applications with the selected résumé. Open the draft and use Fill current page.',
    }[outcome.status]
  )
}

function postingUrl(value: string | null | undefined) {
  if (!value || value !== value.trim() || /[\\\p{Cc}]/u.test(value)) return
  const raw = /^https:\/\/([^/?#]+)([^?#]*)/i.exec(value)
  if (!raw || /%2f|%5c|\/(?:\.|%2e){1,2}(?:\/|$)/i.test(raw[2])) return
  try {
    const url = new URL(value)
    if (raw[1] === url.hostname && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(url.hostname)) return url
  } catch {
    /* A malformed link cannot identify an employer. */
  }
}

export function isManualApplicationUrl(value: string | null | undefined) {
  const url = postingUrl(value)
  return (
    !!url &&
    !/(?:^|\.)(?:myworkdayjobs\.com|myworkdaysite\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|rippling\.com|bamboohr\.com|applytojob\.com|recruitee\.com|jobvite\.com|smartrecruiters\.com|canonical\.com|amazon\.jobs|forms-formulaires\.alpha\.canada\.ca)(?=\.|$)/.test(
      url.hostname,
    )
  )
}

// Keep these UI hints aligned with C3 genericApplicationTarget; export validates again.
export function isGenericApplicationUrl(value: string | null | undefined) {
  const url = postingUrl(value)
  if (!url) return false
  const host = url.hostname,
    path = url.pathname.replace(/\/$/, '')
  if (['ats.rippling.com', 'ats.us1.rippling.com'].includes(host))
    return /^\/[\w-]+\/jobs\/[a-f0-9-]{36}(?=\/apply$|$)/i.test(path)
  if (host.endsWith('.bamboohr.com')) return /^\/careers\/\d+$/.test(path)
  if (host.endsWith('.applytojob.com')) return /^\/apply\/[\w-]+(?:\/[\w-]+)?$/.test(path)
  if (host.endsWith('.recruitee.com')) return /^\/o\/[\w-]+(?=\/c\/new$|$)/.test(path)
  if (host === 'jobs.jobvite.com') return /^\/[\w-]+\/job\/[\w-]+(?=\/apply$|$)/.test(path)
  if (host === 'job-boards.anz.greenhouse.io') return /^\/[\w-]+\/jobs\/\d+$/.test(path)
  if (host === 'forms-formulaires.alpha.canada.ca') return /^\/(?:en|fr)\/id\/[\w-]+$/.test(path)
  if (host === 'canonical.com') return /^\/careers\/\d+(?=\/[\w-]+(?:\/application)?$|$)/.test(path)
  if (host === 'jobs.smartrecruiters.com') {
    const tenant =
      /^\/([\w-]+)\/\d+(?:-[\w-]+)?$/.exec(path)?.[1] ??
      /^\/oneclick-ui\/company\/([\w-]+)\/publication\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:\/screening)?$/i.exec(
        path,
      )?.[1]
    return (
      !!tenant &&
      [...url.searchParams].every(
        ([key, value]) => key.toLowerCase() !== 'dcr_ci' || (key === 'dcr_ci' && value === tenant),
      )
    )
  }
  if (['amazon.jobs', 'www.amazon.jobs'].includes(host))
    return /^\/(?:[a-z-]+\/)?(?:applicant\/)?jobs\/\d+\/[\w-]+$/i.test(path)
  return false
}

export function supportsQueuedApplication(
  family: string | null | undefined,
  value: string | null | undefined,
) {
  const url = postingUrl(value)
  if (!url) return false
  const { hostname: host, pathname: path } = url
  switch (family) {
    case 'workday':
      return (
        /^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(host) &&
        /\/job\/.+/i.test(path)
      )
    case 'workable':
      return host === 'apply.workable.com' && /^\/[^/]+\/j\/[A-Za-z0-9]+(?:\/apply)?\/?$/.test(path)
    case 'greenhouse':
      return (
        [
          'job-boards.greenhouse.io',
          'boards.greenhouse.io',
          'job-boards.eu.greenhouse.io',
        ].includes(host) && /^\/[^/]+\/jobs\/\d+\/?$/.test(path)
      )
    case 'lever':
    case 'ashby':
      return (
        (family === 'ashby'
          ? host === 'jobs.ashbyhq.com'
          : ['jobs.lever.co', 'jobs.eu.lever.co'].includes(host)) &&
        /^\/[^/]+\/[A-Fa-f0-9-]{36}(?:\/(?:apply|application))?\/?$/.test(path)
      )
  }
  return false
}

async function exportApplications(jobIds: number[]) {
  type Bundle = { jobs: { sourceJobId: number; url: string }[] }
  const exported = await post<Bundle | { bundle: Bundle; omitted: HandoffOutcome[] }>(
    '/api/c3/handoff/export',
    {
      job_ids: jobIds,
      include_outcomes: true,
    },
  )
  const bundle = 'bundle' in exported ? exported.bundle : exported
  const ids = bundle?.jobs?.map((job) => job.sourceJobId)
  if (!ids?.length || ids.some((id) => !jobIds.includes(id)) || new Set(ids).size !== ids.length)
    throw new Error('The exported applications do not match your selection.')
  const omitted = jobIds
    .filter((id) => !ids.includes(id))
    .map(
      (sourceJobId) =>
        ('omitted' in exported ? exported.omitted : []).find(
          (row) => row.sourceJobId === sourceJobId,
        ) ?? { sourceJobId, status: 'not_sent' as const, reason: 'Check the saved posting link.' },
    )
  return { bundle, omitted }
}

export async function sendApplicationsToBrowser(jobIds: number[]) {
  const state = await browserC3<BrowserC3Status>('status')
  if (!state.connected || !state.configured)
    throw new Error('Connect Hunt C3 and save your profile in the local workspace first.')
  const { bundle, omitted } = await exportApplications(jobIds)
  await browserC3('preview', bundle)
  const result = await browserC3<BrowserC3Import>('import', bundle)
  if (
    !Array.isArray(result?.jobs) ||
    result.jobs.length !== bundle.jobs.length ||
    bundle.jobs.some(
      ({ sourceJobId: id }) =>
        result.jobs.filter((job) => job.sourceJobId === id && job.status === 'paused').length !== 1,
    )
  ) {
    throw new Error('Transfer not confirmed. Check the local C3 workspace before retrying.')
  }
  return {
    ...result,
    omitted,
    currentPageIds: bundle.jobs
      .filter((job) => isGenericApplicationUrl(job.url))
      .map((job) => job.sourceJobId),
  }
}

export async function downloadApplicationHandoff(jobIds: number[]) {
  const { bundle, omitted } = await exportApplications(jobIds)
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'hunt-applications.hunt.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return {
    omitted,
    jobs: bundle.jobs.map((job) => ({
      id: job.sourceJobId,
      currentPage: isGenericApplicationUrl(job.url),
    })),
  }
}
