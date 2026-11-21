import { observeWorkdayDocument } from '../workday-page.js';
import { observeFormDocument } from '../form-page.js';

export const workdayNoticeMarkers = '[data-automation-id="inputAlert"],[data-automation-id*="error" i]';
export const applicationAttachmentControls = 'input[type=file],[role=group][aria-labelledby=upload-label-resume]';

export function observeCurrentDocument() {
  return /\.(myworkdayjobs|myworkdaysite)\.com$/.test(location.hostname) ? observeWorkdayDocument() : observeFormDocument(applicationAttachmentControls);
}
