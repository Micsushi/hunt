import type { Page } from 'playwright';
import { createHash } from 'node:crypto';
import { ApplicationPause } from './application-contract.ts';
import { pause } from './application-wait.ts';
import type { MatchedPageResult } from './page-matching.ts';

const ordinarySkips = new Set(['saved_value_already_present','selected_resume_already_present','optional_field']);
const attachmentSkips = new Set(['uploaded_attachment_requires_review','resume_upload_already_attempted_review_attachment']);

export async function advanceJobviteScreening(page:Page, url:string, resume:Buffer, report:MatchedPageResult, signal:AbortSignal) {
  if (new URL(url).hostname !== 'jobs.jobvite.com' || page.url() !== url) return false;
  const attachment = report.resume === 'unverified' && report.skipped.some(row=>row.label==='Resume' && attachmentSkips.has(row.reason));
  if (report.resume !== 'verified' && !attachment ||
      report.componentFailure && !(attachment && report.componentFailure.component==='uploads' && report.componentFailure.operation==='verify_attachment') ||
      report.skipped.some(row=>!ordinarySkips.has(row.reason) && !(attachment && row.label==='Resume' && attachmentSkips.has(row.reason)))) return false;

  signal.throwIfAborted();
  const selectedHash = createHash('sha256').update(resume).digest('hex');
  const claim = await page.evaluateHandle(({url,selectedHash}) => location.href === url
    ? (globalThis as any).__huntC3PartialFill?.resumeAttempt?.claimJobviteNext?.(selectedHash) ?? null : null,{url,selectedHash});
  try {
    if (!await claim.evaluate(value=>!!value)) return false;
    const button = await claim.getProperty('button');
    try {
      signal.throwIfAborted();
      const next = button.asElement();
      if (!next) return false;
      await next.click({timeout:2500});
      if (!await claim.evaluate(value=>value.clicked())) throw new ApplicationPause('The Jobvite Next control changed. Inspect the application before retrying.');
    } finally { await button.dispose(); }
  } finally {
    await claim.evaluate(value=>value?.release()).catch(()=>{});
    await claim.dispose();
  }
  const deadline = Date.now() + 3500;
  do {
    signal.throwIfAborted();
    const result = await page.evaluate(url=>{
      if (location.href!==url) return 'changed';
      const receipt=(globalThis as any).__huntC3PartialFill?.resumeAttempt;
      if (receipt?.acknowledgedPanel?.()?.matches('[ng-form="scopeData.step2"]')) return 'screening';
      return receipt?.jobviteRejected?.() ? 'rejected' : 'waiting';
    },url);
    if (result==='screening') return true;
    if (result==='rejected') throw new ApplicationPause('Jobvite stayed on the first step and requested more information. Open View Full Application Form to check the employer’s requirements. The attached PDF contents remain unverified.');
    if (result==='changed') break;
    await pause(signal);
  } while (Date.now()<deadline);
  throw new ApplicationPause('C3 clicked Next once. The employer screening step could not be confirmed. Inspect the draft before retrying.');
}
