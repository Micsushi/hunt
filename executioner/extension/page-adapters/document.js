import { observeWorkdayDocument } from '../workday-page.js';
import { observeFormDocument } from '../form-page.js';

export const workdayNoticeMarkers = '[data-automation-id="inputAlert"],[data-automation-id*="error" i]';
export const applicationAttachmentControls = 'input[type=file],[role=group][aria-labelledby=upload-label-resume]';

/** OneClick uses a separate shadow root for each field inside its application component. */
export function smartRecruitersForm(deepQuery, composedClosest, visible) {
  if (location.origin !== 'https://jobs.smartrecruiters.com' ||
      !/^\/oneclick-ui\/company\/[\w-]+\/publication\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/i.test(location.pathname.replace(/\/screening\/?$/, ''))) return;
  const activeForms = () => deepQuery(document,'oc-oneclick-form').filter(form => composedClosest(form,'main') &&
    !composedClosest(form,'[hidden],[inert],[aria-hidden=true]'));
  const forms = activeForms();
  const owner = forms.length === 1 ? forms[0] : null;
  const originalUrl=location.href;
  const current = () => {
    if (location.href!==originalUrl || !owner?.isConnected) return false;
    const forms = activeForms();
    return forms.length === 1 && forms[0] === owner && !deepQuery(document,'input[type=password]').some(visible);
  };
  if (!current()) return {owner:null, region:()=>null};
  const region = element => {
    if (!owner.isConnected || element.hasAttribute('form') || composedClosest(element,'oc-oneclick-form') !== owner ||
        composedClosest(element,'oc-easy-apply,oc-apply-with-resume')) return null;
    if (element.type === 'file') {
      const uploads = deepQuery(owner,'oc-resume-upload');
      if (uploads.length !== 1 || composedClosest(element,'oc-resume-upload') !== uploads[0] ||
          !composedClosest(element,'spl-dropzone[data-test=resume-upload]')) return null;
    }
    return owner;
  };
  const upload = element => {
    const zone=composedClosest(element,'spl-dropzone[data-test=resume-upload]');
    if (!zone?.shadowRoot || region(element)!==owner) return null;
    const uploadOwner=composedClosest(zone,'oc-resume-upload'), root=zone.shadowRoot;
    const items=()=>root.querySelectorAll('li.c-spl-file-list-item');
    const occupied=items().length>0;
    let acknowledgedItem;
    const matchingItem = name => {
      if (!current() || !zone.isConnected || zone.shadowRoot!==root || deepQuery(owner,'oc-resume-upload').length!==1 ||
          composedClosest(zone,'oc-resume-upload')!==uploadOwner || composedClosest(uploadOwner,'oc-oneclick-form')!==owner ||
          deepQuery(uploadOwner,'spl-dropzone[data-test=resume-upload]').length!==1 || !zone.matches('[data-test=resume-upload]') ||
          composedClosest(zone,'[hidden],[inert],[aria-hidden=true],[aria-busy=true],[aria-invalid=true]') ||
          deepQuery(uploadOwner,'[aria-busy=true],[role=progressbar],[aria-invalid=true],[role=alert]').some(visible) ||
          deepQuery(root,'*').some(node=>visible(node) && /\b(?:uploading|upload failed|upload error|invalid file)\b/i.test(node.innerText||''))) return false;
      const entries=items(), entry=entries[0];
      if (entries.length!==1 || !entry.parentElement?.matches('ul.c-spl-file-list') || !visible(entry)) return false;
      const names=entry.querySelectorAll('.c-spl-file-list-item-label-container span.c-spl-file-list-item-name');
      const buttons=deepQuery(entry,'button');
      if (names.length!==1 || !visible(names[0]) || names[0].textContent.trim()!==name || buttons.length!==1 ||
          !visible(buttons[0]) || buttons[0].disabled || buttons[0].getAttribute('aria-disabled')==='true' ||
          !composedClosest(buttons[0],'spl-button') || buttons[0].getAttribute('aria-label')!=='Delete file '+name) return false;
      return entry;
    };
    return {occupied, filenameVisible:name=>!!matchingItem(name), acknowledged(name) {
      const entry = !occupied && matchingItem(name);
      if (!entry || acknowledgedItem && acknowledgedItem !== entry) return false;
      acknowledgedItem=entry;
      return true;
    }};
  };
  // The phone component snapshots its initial value on focus and validates the edit on blur.
  const writePhone = (element, value, write) => {
    if (element.type !== 'tel' || document.activeElement !== document.body ||
        !composedClosest(element, 'spl-phone-field') || !current() || region(element) !== owner) return false;
    const before = element.value;
    element.focus({preventScroll:true});
    try {
      if (!current() || region(element) !== owner || !element.isConnected ||
          element.getRootNode().activeElement !== element || element.disabled || element.readOnly || element.value !== before) {
        throw new Error('The phone field changed before the edit.');
      }
      write(element,value);
    } finally {
      if (element.getRootNode().activeElement === element) element.blur();
    }
    return true;
  };
  return {owner, region, current, upload, writePhone};
}

export function observeCurrentDocument() {
  return /\.(myworkdayjobs|myworkdaysite)\.com$/.test(location.hostname) ? observeWorkdayDocument() : observeFormDocument(applicationAttachmentControls);
}
