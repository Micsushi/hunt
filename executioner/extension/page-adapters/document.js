import { observeWorkdayDocument } from '../workday-page.js';
import { observeFormDocument } from '../form-page.js';

export const workdayNoticeMarkers = '[data-automation-id="inputAlert"],[data-automation-id*="error" i]';
export const applicationAttachmentControls = 'input[type=file],[role=group][aria-labelledby=upload-label-resume]';

/** OneClick uses a separate shadow root for each field inside its application component. */
export function smartRecruitersForm(deepQuery, composedClosest, visible) {
  if (location.origin !== 'https://jobs.smartrecruiters.com' ||
      !/^\/oneclick-ui\/company\/[\w-]+\/publication\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/i.test(location.pathname)) return;
  const forms = deepQuery(document,'oc-oneclick-form').filter(form => composedClosest(form,'main') &&
    !composedClosest(form,'[hidden],[inert],[aria-hidden=true]'));
  const owner = forms.length === 1 ? forms[0] : null;
  if (!owner || deepQuery(owner,'input[type=password]').some(visible)) return {owner:null, region:()=>null};
  const uploads = deepQuery(owner,'oc-resume-upload');
  return {owner, region:element => {
    if (!owner.isConnected || element.hasAttribute('form') || composedClosest(element,'oc-oneclick-form') !== owner ||
        composedClosest(element,'oc-easy-apply,oc-apply-with-resume')) return null;
    if (element.type === 'file' && (uploads.length !== 1 || composedClosest(element,'oc-resume-upload') !== uploads[0] ||
        !composedClosest(element,'spl-dropzone[data-test=resume-upload]'))) return null;
    return owner;
  }};
}

export function observeCurrentDocument() {
  return /\.(myworkdayjobs|myworkdaysite)\.com$/.test(location.hostname) ? observeWorkdayDocument() : observeFormDocument(applicationAttachmentControls);
}
