import type { Page } from 'playwright';
import { createHash } from 'node:crypto';
import { ApplicationPause } from './application-contract.ts';
import { pause } from './application-wait.ts';
import type { MatchedPageResult } from './page-matching.ts';

const ordinarySkips = new Set(['saved_value_already_present','selected_resume_already_present','optional_field']);
const attachmentSkips = new Set(['uploaded_attachment_requires_review','resume_upload_already_attempted_review_attachment']);

export function isJobviteAttachmentWarning(row:{label:string;reason:string}) {
  return row.label==='Resume' && attachmentSkips.has(row.reason);
}

async function clickOwnedControl(page:Page, url:string, hash:string, disclosure:boolean, verifiedFields:Record<string,string>, signal:AbortSignal) {
  signal.throwIfAborted();
  const started=Date.now();
  const claim = await page.evaluateHandle(({url,hash,disclosure,verifiedFields})=>{
    const receipt=(globalThis as any).__huntC3PartialFill?.resumeAttempt;
    if (!receipt || location.href!==url) return null;
    return disclosure ? receipt.claimJobviteDisclosure?.(hash) ?? null : receipt.claimJobviteNext?.(hash,verifiedFields) ?? null;
  },{url,hash,disclosure,verifiedFields});
  try {
    if (!await claim.evaluate(value=>!!value)) return false;
    const handle = await claim.getProperty('button');
    try {
      signal.throwIfAborted();
      const button=handle.asElement(),remaining=2500-(Date.now()-started);
      if (!button || remaining<=0) return false;
      await button.click({timeout:remaining});
      if (!await claim.evaluate(value=>value.clicked())) throw new ApplicationPause('The Jobvite control changed. Inspect the application before retrying.');
    } finally { await handle.dispose(); }
  } finally {
    await claim.evaluate(value=>value?.release()).catch(()=>{});
    await claim.dispose();
  }
  return true;
}

export async function advanceJobviteScreening(page:Page, url:string, resume:Buffer, report:MatchedPageResult, signal:AbortSignal):Promise<'screening'|'expanded'|undefined> {
  if (new URL(url).hostname !== 'jobs.jobvite.com' || page.url() !== url) return;
  const attachment = report.resume === 'unverified' && report.skipped.some(isJobviteAttachmentWarning);
  if (report.resume !== 'verified' && !attachment ||
      report.componentFailure && !(attachment && report.componentFailure.component==='uploads' && report.componentFailure.operation==='verify_attachment') ||
      report.skipped.some(row=>!ordinarySkips.has(row.reason) && !(attachment && isJobviteAttachmentWarning(row)))) return;
  const verified:Record<string,string> = {};
  for (const row of report.matching ?? []) {
    if (row.required && row.outcome==='verified' && typeof row.observedAnswer==='string') verified[row.fieldId]=row.observedAnswer;
  }
  const hash = createHash('sha256').update(resume).digest('hex');
  if (!await clickOwnedControl(page,url,hash,false,verified,signal)) return;
  const deadline = Date.now() + 15_000;
  do {
    signal.throwIfAborted();
    const result = await page.evaluate(url=>{
      if (location.href!==url) return 'changed';
      const receipt=(globalThis as any).__huntC3PartialFill?.resumeAttempt;
      if (receipt?.acknowledgedPanel?.()?.matches('[ng-form="scopeData.step2"]')) return 'screening';
      const rejection = receipt?.jobviteRejected?.();
      if (rejection==='retry-rejected') return 'retry-rejected';
      if (rejection) return 'rejected';
      return receipt?.jobviteNextPending?.() ? 'waiting' : 'expired';
    },url);
    if (result==='screening') return 'screening';
    if (result==='retry-rejected') {
      throw new ApplicationPause('C3 clicked Next, opened the full Jobvite form, checked the required fields and clicked Next again. Jobvite still requests more information. Review the first step. The attached PDF contents remain unverified.');
    }
    if (result==='rejected') {
      if (await clickOwnedControl(page,url,hash,true,verified,signal)) {
        for (let n=0;n<4;n++) {
          signal.throwIfAborted();
          if (await page.evaluate(url=>location.href===url && (globalThis as any).__huntC3PartialFill?.resumeAttempt?.jobviteExpanded?.()===true,url)) return 'expanded';
          await pause(signal);
        }
      }
      throw new ApplicationPause('Jobvite stayed on the first step and requested more information. Review the employer’s full application form. The attached PDF contents remain unverified.');
    }
    if (result!=='waiting') break;
    await pause(signal);
  } while (Date.now()<deadline);
  throw new ApplicationPause('C3 clicked Next once. The employer screening step could not be confirmed. Inspect the draft before retrying.');
}
