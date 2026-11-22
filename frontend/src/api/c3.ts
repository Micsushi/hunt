import { post } from './client'
import { browserC3, type BrowserC3Import, type BrowserC3Status } from './browserC3'

// Keep these UI hints aligned with C3 genericApplicationTarget; export validates again.
export function isGenericApplicationUrl(value: string | null | undefined) {
  if (!value) return false
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      /%2f|%5c/i.test(url.pathname)
    )
      return false
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
    if (host === 'canonical.com')
      return /^\/careers\/\d+(?=\/[\w-]+(?:\/application)?$|$)/.test(path)
    if (host === 'jobs.smartrecruiters.com') {
      if (/^\/[\w-]+\/\d+(?:-[\w-]+)?$/.test(path)) return true
      const publication =
        /^\/oneclick-ui\/company\/([\w-]+)\/publication\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:\/screening)?$/i.exec(
          path,
        )
      return (
        !!publication &&
        url.searchParams.getAll('dcr_ci').every((tenant) => tenant === publication[1])
      )
    }
    if (['amazon.jobs', 'www.amazon.jobs'].includes(host))
      return /^\/(?:[a-z-]+\/)?(?:applicant\/)?jobs\/\d+\/[\w-]+$/i.test(path)
  } catch {
    /* Invalid URLs remain ineligible. */
  }
  return false
}

export function supportsQueuedApplication(
  family: string | null | undefined,
  value: string | null | undefined,
) {
  if (!value) return false
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      /%2f|%5c/i.test(url.pathname)
    )
      return false
    const { hostname: host, pathname: path } = url
    switch (family) {
      case 'workday':
        return (
          /^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(host) &&
          /\/job\/.+/i.test(path)
        )
      case 'workable':
        return (
          host === 'apply.workable.com' && /^\/[^/]+\/j\/[A-Za-z0-9]+(?:\/apply)?\/?$/.test(path)
        )
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
  } catch {
    /* Invalid URLs cannot be queued. */
  }
  return false
}

async function exportApplications(jobIds: number[]) {
  const bundle = await post<{ jobs: { sourceJobId: number; url: string }[] }>(
    '/api/c3/handoff/export',
    {
      job_ids: jobIds,
    },
  )
  const ids = bundle?.jobs?.map((job) => job.sourceJobId)
  if (!ids?.length || ids.some((id) => !jobIds.includes(id)) || new Set(ids).size !== ids.length)
    throw new Error('The exported applications do not match your selection.')
  return bundle
}

export async function sendApplicationsToBrowser(jobIds: number[]) {
  const state = await browserC3<BrowserC3Status>('status')
  if (!state.connected || !state.configured)
    throw new Error('Connect Hunt C3 and save your profile in the local workspace first.')
  const bundle = await exportApplications(jobIds)
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
    currentPageIds: bundle.jobs
      .filter((job) => isGenericApplicationUrl(job.url))
      .map((job) => job.sourceJobId),
  }
}

export async function downloadApplicationHandoff(jobIds: number[]) {
  const bundle = await exportApplications(jobIds)
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'hunt-applications.hunt.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return bundle.jobs.map((job) => ({
    id: job.sourceJobId,
    currentPage: isGenericApplicationUrl(job.url),
  }))
}
