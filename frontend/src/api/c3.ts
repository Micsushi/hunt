import { post } from './client'
import { browserC3, type BrowserC3Import, type BrowserC3Status } from './browserC3'

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
  } catch {
    /* Invalid URLs cannot be queued. */
  }
  return false
}

async function exportApplications(jobIds: number[]) {
  const bundle = await post<{ jobs: { sourceJobId: number }[] }>('/api/c3/handoff/export', {
    job_ids: jobIds,
  })
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
  return result
}

export async function downloadApplicationHandoff(jobIds: number[]) {
  const bundle = await exportApplications(jobIds)
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'hunt-applications.hunt.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return bundle.jobs.map((job) => job.sourceJobId)
}
