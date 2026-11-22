import { smartRecruitersPublication } from './smartrecruiters-target.ts';

export type AtsFamily = "workday" | "greenhouse" | "lever" | "ashby" | "workable";

// Persisted rows can retain either public Amazon hostname after an upgrade.
export const canonicalPostingKey = (key: string) => key.replace(/^www\.amazon\.jobs(?=\/jobs\/\d+$)/u, 'amazon.jobs');

/** Explicit unfamiliar application targets. These never use the hosted Review or Submit path. */
export function genericApplicationTarget(input: string): {
  url: string; key: string; host: string; posting: string; ats: "generic";
} {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      /%2f|%5c/i.test(url.pathname)) throw new Error("Use an exact HTTPS application link.");
  const host = url.hostname;
  const pathname = url.pathname.replace(/\/$/, "");
  let posting: string | undefined;
  if (host === "ats.rippling.com" || host === "ats.us1.rippling.com") {
    posting = pathname.match(/^\/[\w-]+\/jobs\/[a-f0-9-]{36}(?=\/apply$|$)/i)?.[0];
  } else if (host.endsWith(".bamboohr.com")) {
    posting = pathname.match(/^\/careers\/\d+$/)?.[0];
  } else if (host.endsWith(".applytojob.com")) {
    posting = pathname.match(/^\/apply\/[\w-]+(?:\/[\w-]+)?$/)?.[0]?.split("/").slice(0, 3).join("/");
  } else if (host.endsWith(".recruitee.com")) {
    posting = pathname.match(/^\/o\/[\w-]+(?=\/c\/new$|$)/)?.[0];
  } else if (host === "jobs.jobvite.com") {
    posting = pathname.match(/^\/[\w-]+\/job\/[\w-]+(?=\/apply$|$)/)?.[0];
  } else if (host === "job-boards.anz.greenhouse.io") {
    posting = pathname.match(/^\/[\w-]+\/jobs\/\d+$/)?.[0];
  } else if (host === "forms-formulaires.alpha.canada.ca") {
    posting = pathname.match(/^\/(?:en|fr)\/id\/[\w-]+$/)?.[0];
  } else if (host === "canonical.com") {
    posting = pathname.match(/^\/careers\/\d+(?=\/[\w-]+(?:\/application)?$|$)/)?.[0];
  } else if (host === "jobs.smartrecruiters.com") {
    posting = pathname.match(/^\/[\w-]+\/\d+(?:-[\w-]+)?$/)?.[0]?.match(/^\/[^/]+\/\d+/)?.[0] ??
      smartRecruitersPublication(url)?.base;
  } else if (host === "www.amazon.jobs" || host === "amazon.jobs") {
    const id = pathname.match(/^\/(?:[a-z-]+\/)?(?:applicant\/)?jobs\/(\d+)\/[\w-]+$/i)?.[1];
    posting = id ? `/jobs/${id}` : undefined;
  }
  if (!posting) throw new Error("Use a supported posting or an explicitly recognized public application form.");
  url.hash = "";
  return { url: url.href, key: canonicalPostingKey(`${host}${posting}`), host, posting, ats: "generic" };
}

export function productApplicationTarget(input: string) {
  try {
    return applicationTarget(input);
  } catch {
    return genericApplicationTarget(input);
  }
}
export function applicationTarget(input: string): { url: string; key: string; host: string; posting: string; ats: AtsFamily } {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Enter a complete job link."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Use an HTTPS job link without credentials or a custom port.");
  let ats: AtsFamily, posting: string;
  if (/^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(url.hostname)) {
    ats = "workday";
    const match = url.pathname.match(/\/job\/(.+)/i);
    if (!match) throw new Error("Use a specific job posting link.");
    posting = match[1]!.replace(/(?:\/(?:apply|applyManually))+\/?$/i, "").replace(/\/$/, "").split("/").at(-1)!;
  } else {
    const parts = url.pathname.split("/").filter(Boolean);
    if (["job-boards.greenhouse.io", "boards.greenhouse.io", "job-boards.eu.greenhouse.io"].includes(url.hostname) && parts.length === 3 && parts[1] === "jobs" && /^\d+$/.test(parts[2]!)) {
      ats = "greenhouse"; posting = `${parts[0]}/${parts[2]}`;
    } else if(url.hostname==="apply.workable.com" && /^\/[^/]+\/j\/[A-Z0-9]+(?:\/apply)?\/?$/i.test(url.pathname)){
      ats="workable";posting=`${parts[0]}/${parts[2]}`;
    } else if (["jobs.lever.co", "jobs.eu.lever.co", "jobs.ashbyhq.com"].includes(url.hostname) && parts.length >= 2 && parts.length <= 3 && /^[a-f0-9-]{36}$/i.test(parts[1]!) && (!parts[2] || ["apply", "application"].includes(parts[2]))) {
      ats = url.hostname === "jobs.ashbyhq.com" ? "ashby" : "lever";
      posting = `${parts[0]}/${parts[1]}`;
    } else throw new Error("For other sites, open the application and choose Fill current page. Queued preparation supports Workday, Greenhouse, Lever, Ashby and Workable.");
  }
  if (!posting || /%2f|%5c/i.test(posting)) throw new Error("Job identity is invalid.");
  if(url.hostname === "boards.greenhouse.io") url.hostname = "job-boards.greenhouse.io";
  url.hash = ""; url.search = "";
  return { url: url.href, key: `${url.hostname}/${posting}`, host: url.hostname, posting, ats };
}

export function matchingContext(url?:string) {
  if (!url) return {url:null,company:null};
  const parsed=new URL(url);
  const publication = smartRecruitersPublication(parsed);
  if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Invalid application address');
  parsed.username='';parsed.password='';parsed.hash='';
  for (const key of [...parsed.searchParams.keys()]) if (!/^(?:jobid|job_id|requisitionid|requisition_id|gh_jid)$/iu.test(key)) parsed.searchParams.delete(key);
  const company=/\.(?:myworkdayjobs|myworkdaysite)\.com$/iu.test(parsed.hostname)
    ? parsed.hostname.split('.')[0]! : publication?.company ?? parsed.pathname.split('/').filter(Boolean)[0] ?? parsed.hostname;
  return {url:parsed.href,company};
}
