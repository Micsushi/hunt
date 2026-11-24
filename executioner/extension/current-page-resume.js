// Resolve exactly the document shown in the popup, including a previously
// selected library PDF or a resume pinned to this application.
export function resolvePageResume(metadata, preference, url) {
  const current=metadata?.currentPage, queued=metadata?.queued;
  const archived=metadata?.trashedResumes??[];
  const preferred=preference && preference.url===url && preference.sha256 ? preference : null;
  const options=[current,queued,...metadata?.resumes??[],...archived];
  const match=preferred && options.find(item=>item?.sha256===preferred.sha256 &&
    (!preferred.jobId || item.jobId===preferred.jobId || item.sha256===queued?.sha256));
  const defaultArchived=!metadata?.currentPageBound && archived.some(item=>item.sha256===current?.sha256);
  const activeResume=match || (!defaultArchived && current) || null;
  const useQueued=Boolean(match && queued?.source==='selected' && queued.jobId &&
    match.sha256===queued.sha256 && queued.sha256!==current?.sha256);
  return {
    activeResume,
    currentPageJobId:useQueued ? queued.jobId : undefined,
    selectedResumeSha256:match && !useQueued && match.sha256!==current?.sha256 ? match.sha256 : undefined,
    stalePreference:Boolean(preferred && !match)
  };
}
