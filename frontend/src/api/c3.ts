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
    if (host === 'jobs.smartrecruiters.com')
      return (
        /^\/[\w-]+\/\d+(?:-[\w-]+)?$/.test(path) ||
        /^\/oneclick-ui\/company\/[\w-]+\/publication\/[a-f0-9-]{36}$/i.test(path)
      )
    if (['amazon.jobs', 'www.amazon.jobs'].includes(host))
      return /^\/(?:[a-z-]+\/)?(?:applicant\/)?jobs\/\d+\/[\w-]+$/i.test(path)
  } catch {
    /* Invalid URLs remain ineligible. */
  }
  return false
}

export async function sendApplicationsToBrowser(jobIds: number[]) {
  const state = await browserC3<BrowserC3Status>('status')
  if (!state.connected || !state.configured)
    throw new Error('Connect Hunt C3 and save your profile in the local workspace first.')
  const bundle = await post('/api/c3/handoff/export', { job_ids: jobIds })
  await browserC3('preview', bundle)
  const result = await browserC3<BrowserC3Import>('import', bundle)
  if (
    !Array.isArray(result?.jobs) ||
    result.jobs.length !== jobIds.length ||
    jobIds.some(
      (id) =>
        result.jobs.filter((job) => job.sourceJobId === id && job.status === 'paused').length !== 1,
    )
  ) {
    throw new Error('Transfer not confirmed. Check the local C3 workspace before retrying.')
  }
  return result
}

export async function downloadApplicationHandoff(jobIds: number[]) {
  const bundle = await post('/api/c3/handoff/export', { job_ids: jobIds })
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'hunt-applications.hunt.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
