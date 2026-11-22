import type { Locator, Page } from 'playwright';
import { ApplicationPause, type ResumeUploadReceipt, type WorkableReviewAttempt } from '../application-contract.ts';
import { recordComponentFailure } from '../component-diagnostics.ts';
import { selectClientResume, verifiedClientResume } from '../client-resume.ts';
import { uploadGreenhouseResume, verifiedGreenhouseResume } from '../greenhouse-resume.ts';
import { uploadWorkableResume, verifiedWorkableResume, unverifiedWorkablePreview, recheckWorkablePreview } from '../workable-resume.ts';
import { applicationTarget } from '../target.ts';

interface UploadField {
  kind: string;
  label: string;
  required: boolean;
  files: number;
  key: string;
}

const isResume = (field: UploadField) => /resume|cv/i.test(field.label);

async function hasGreenhouseAttachment(page: Page) {
  return applicationTarget(page.url()).ats === 'greenhouse' &&
    await page.locator('[role=group][aria-labelledby=upload-label-resume] button[aria-label="Remove file"]').count() > 0;
}

export async function hasHostedResume(page: Page, fields: UploadField[]) {
  try {
    return fields.some(field => field.kind === 'file' && field.required && isResume(field)) ||
      await hasGreenhouseAttachment(page);
  } catch (error) {
    recordComponentFailure(error, 'uploads', 'observe_attachment');
    throw error;
  }
}

export async function prepareHostedResume(
  page: Page, control: Locator, field: UploadField, resume: Buffer, sha256: string,
  previous: ResumeUploadReceipt | undefined, save: (receipt: ResumeUploadReceipt | undefined) => void,
): Promise<'existing' | 'prepared'> {
  try {
    if (!isResume(field)) throw new ApplicationPause('This application requires an additional attachment.');
    const ats = applicationTarget(page.url()).ats;
    const name = ats === 'workable' ? `Resume-${sha256.slice(0, 12)}.pdf` : 'Resume.pdf';
    const file = { name, mimeType: 'application/pdf', buffer: resume };
    if (ats === 'greenhouse' && await control.evaluate(e => e.closest('[data-allow-s3]')?.getAttribute('data-allow-s3')) !== 'false') {
      save(undefined);
      await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry =>
        entry.name.includes('/uncacheable_attributes/presigned_fields') && (entry as PerformanceResourceTiming).responseEnd > 0
      ), undefined, { timeout: 20000 });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      save(await uploadGreenhouseResume(page, file));
    } else if (ats === 'workable' && await control.getAttribute('data-ui') === 'resume') {
      if (await verifiedWorkableResume(page, previous, sha256, field.key)) return 'existing';
      save(await uploadWorkableResume(page, control, file));
    } else {
      save(await selectClientResume(page, control, file));
    }
    await page.waitForTimeout(800);
    return 'prepared';
  } catch (error) {
    recordComponentFailure(error, 'uploads', 'prepare_attachment');
    throw error;
  }
}

/** Re-read the current attachment on review or retry; a stale filename alone is insufficient. */
export async function verifyHostedAttachments(
  page: Page, fields: UploadField[], expected: boolean | undefined,
  receipt: ResumeUploadReceipt | undefined, expectedSha256?: string, review?: WorkableReviewAttempt,
) {
  try {
    if (await page.getByText(/Resume(?:-[a-f0-9]{12})?\.pdf failed to upload/i).count()) {
      throw new ApplicationPause('The resume upload failed.');
    }
    const resumeExpected = expected || await hasGreenhouseAttachment(page);
    let workableProof = await verifiedWorkableResume(page, receipt, expectedSha256);
    const fileFields = fields.filter(field => field.kind === 'file');
    if (!workableProof && applicationTarget(page.url()).ats === 'workable') {
      const requiredKeys = fileFields.filter(field => isResume(field) && field.required).map(field => field.key);
      if (await unverifiedWorkablePreview(page, requiredKeys, !!resumeExpected, expectedSha256 !== undefined)) {
        await recheckWorkablePreview(page, receipt, expectedSha256, review);
        workableProof = await verifiedWorkableResume(page, receipt, expectedSha256);
        if (!workableProof) throw new ApplicationPause('The resume changed after its preview was checked. Inspect the draft before reviewing.');
      }
    }
    const filledKeys = new Set(fileFields.filter(field => field.files > 0).map(field => field.key));
    const acknowledgedKeys = new Set<string>();
    if (workableProof) {
      for (const field of fileFields) {
        if (await verifiedWorkableResume(page, receipt, expectedSha256, field.key)) {
          filledKeys.add(field.key);
          acknowledgedKeys.add(field.key);
        }
      }
    }
    const resumeKeys = new Set(fileFields.filter(field => (field.required || field.files > 0) && isResume(field)).map(field => field.key));
    const confirmed = resumeExpected && (workableProof || resumeKeys.size === 0 && (
      await verifiedClientResume(page, receipt, expectedSha256) || await verifiedGreenhouseResume(page, receipt, expectedSha256)
    ));
    if (resumeExpected && !resumeKeys.size && !confirmed) {
      throw new ApplicationPause('The previously verified resume field is missing. Inspect the draft, then retry.');
    }
    const attachments = await page.locator('input[type=file]').evaluateAll(async (elements, keys) => Promise.all(
      elements.filter(element => keys.includes(element.getAttribute('data-c3-hosted') ?? '')).map(async element => ({
        key: element.getAttribute('data-c3-hosted'),
        files: await Promise.all([...(element as HTMLInputElement).files ?? []].map(async file => ({
          name: file.name,
          sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
            .map(byte => byte.toString(16).padStart(2, '0')).join(''),
        }))),
      }))
    ), fileFields.map(field => field.key));
    for (const key of acknowledgedKeys) resumeKeys.delete(key);
    if (expectedSha256 !== undefined) {
      for (const key of resumeKeys) {
        const controls = attachments.filter(attachment => attachment.key === key);
        if (controls.length === 1 && controls[0]!.files.length === 0 && !filledKeys.has(key)) {
          throw new ApplicationPause('The required resume is missing. Inspect the draft before retrying.');
        }
        if (controls.length !== 1 || controls[0]!.files.length !== 1 || controls[0]!.files[0]!.sha256 !== expectedSha256) {
          throw new ApplicationPause('The attached resume does not match the resume selected for this job. Inspect the draft, then retry.');
        }
      }
    }
    return { attachments, filledKeys, receipt: confirmed ? receipt : null, resumeExpected: resumeKeys.size > 0 || !!confirmed };
  } catch (error) {
    recordComponentFailure(error, 'uploads', 'verify_attachment');
    throw error;
  }
}
