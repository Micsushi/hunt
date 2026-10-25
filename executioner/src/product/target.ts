export type AtsFamily = "workday" | "greenhouse" | "lever" | "ashby" | "workable";
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
    } else throw new Error("Supported job links: Workday, Greenhouse, Lever, Ashby, and Workable hosted postings.");
  }
  if (!posting || /%2f|%5c/i.test(posting)) throw new Error("Job identity is invalid.");
  if(url.hostname === "boards.greenhouse.io") url.hostname = "job-boards.greenhouse.io";
  url.hash = ""; url.search = "";
  return { url: url.href, key: `${url.hostname}/${posting}`, host: url.hostname, posting, ats };
}
