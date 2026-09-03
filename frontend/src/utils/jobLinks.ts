const LINKEDIN_JOB_PATH = /^\/jobs\/view\/(?:.*-)?(\d{8,})\/?$/i

export function linkedInListingUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (hostname !== 'linkedin.com' && !hostname.endsWith('.linkedin.com')) return url

    const match = parsed.pathname.match(LINKEDIN_JOB_PATH)
    if (!match) return url

    const authenticatedUrl = new URL('https://www.linkedin.com/jobs/collections/recommended/')
    authenticatedUrl.searchParams.set('currentJobId', match[1])
    return authenticatedUrl.toString()
  } catch {
    return url
  }
}
