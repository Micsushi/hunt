import { observeWorkdayDocument } from '../workday-page.js';
import { observeFormDocument } from '../form-page.js';

export const workdayNoticeMarkers = '[data-automation-id="inputAlert"],[data-automation-id*="error" i]';
export const applicationAttachmentControls = 'input[type=file],[role=group][aria-labelledby=upload-label-resume]';

/** OneClick uses a separate shadow root for each field inside its application component. */
export function smartRecruitersForm(deepQuery, composedClosest, visible) {
  if (location.origin !== 'https://jobs.smartrecruiters.com' ||
      !/^\/oneclick-ui\/company\/[\w-]+\/publication\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/i.test(location.pathname.replace(/\/screening\/?$/, ''))) return;
  const screening = /\/screening\/?$/.test(location.pathname);
  const formSelector = screening ? 'oc-screening-questions' : 'oc-oneclick-form';
  const activeForms = () => deepQuery(document,formSelector).filter(form => composedClosest(form,'main') &&
    !composedClosest(form,'[hidden],[inert],[aria-hidden=true]'));
  const forms = activeForms();
  const owner = forms.length === 1 ? forms[0] : null;
  const originalUrl=location.href;
  const current = () => {
    if (location.href!==originalUrl || !owner?.isConnected) return false;
    const forms = activeForms();
    return forms.length === 1 && forms[0] === owner && !deepQuery(document,'input[type=password]').some(visible) &&
      (!screening || deepQuery(owner,'oc-screening-questions-form').length === 1 && deepQuery(owner,'oc-nav-screening-questions').length === 1);
  };
  if (!current()) return {owner:null, region:()=>null};
  const region = element => {
    if (!owner.isConnected || element.hasAttribute('form') || composedClosest(element,formSelector) !== owner ||
        composedClosest(element,'oc-easy-apply,oc-apply-with-resume')) return null;
    if (screening) return element.type !== 'file' &&
      composedClosest(element,'oc-screening-questions-form,oc-consent-decisions') ? owner : null;
    if (element.type === 'file') {
      const uploads = deepQuery(owner,'oc-resume-upload');
      if (uploads.length !== 1 || composedClosest(element,'oc-resume-upload') !== uploads[0] ||
          !composedClosest(element,'spl-dropzone[data-test=resume-upload]')) return null;
    }
    return owner;
  };
  const personalReady = () => {
    if (screening || !current()) return false;
    const personal = deepQuery(owner,'oc-personal-information');
    if (personal.length > 1) return false;
    const owned = e => !e.form && !composedClosest(e,'form,[role=form],[inert]') && region(e)===owner;
    const fields = deepQuery(personal[0] ?? owner,'input').filter(e => owned(e) && visible(e) && !composedClosest(e,'[hidden],[aria-hidden=true]'));
    const uploads = deepQuery(owner,'input[type=file]').filter(owned);
    const email = e => e.matches('[type=email],[autocomplete=email]');
    return fields.some(e => !email(e) && (personal.length ? e.type==='text' : e.matches('[autocomplete=given-name],[autocomplete=family-name]'))) &&
      fields.some(email) && uploads.length===1 &&
      !composedClosest(composedClosest(uploads[0],'spl-dropzone[data-test=resume-upload]'),'[hidden],[aria-hidden=true]');
  };
  const upload = element => {
    const zone=composedClosest(element,'spl-dropzone[data-test=resume-upload]');
    if (!zone?.shadowRoot || region(element)!==owner) return null;
    const uploadOwner=composedClosest(zone,'oc-resume-upload'), root=zone.shadowRoot;
    const items=()=>root.querySelectorAll('li.c-spl-file-list-item');
    const occupied=items().length>0;
    let acknowledgedItem, selectedFile, selectionChanged = false, observation;
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
    const invalidateSelection = () => {
      selectionChanged = true;
      observation?.abort();
    };
    const differentInput = input => input.files?.length &&
      (input!==element || input.files.length!==1 || input.files[0]!==selectedFile);
    const currentSelection = () => {
      if (selectedFile && !selectionChanged && deepQuery(root,'input[type=file]').some(differentInput)) invalidateSelection();
      return !!selectedFile && !selectionChanged;
    };
    const watchSelection = file => {
      selectedFile = file;
      observation = new AbortController();
      const options = {capture:true,signal:observation.signal};
      const observeInput = event => {
        const input = event.composedPath()[0];
        if (input?.matches?.('input[type=file]') && differentInput(input)) invalidateSelection();
      };
      root.addEventListener('input',observeInput,options);
      root.addEventListener('change',observeInput,options);
      root.addEventListener('drop',event=>{
        if (event.dataTransfer?.files.length) invalidateSelection();
      },options);
      root.addEventListener('click',event=>{
        const path = event.composedPath();
        if (acknowledgedItem && path.includes(acknowledgedItem) && path.some(node=>
          node?.matches?.('button[aria-label]') && node.getAttribute('aria-label')==='Delete file '+file.name)) invalidateSelection();
      },options);
    };
    return {occupied, filenameVisible:name=>!!matchingItem(name), watchSelection, currentSelection, acknowledged(name) {
      if (!currentSelection()) return false;
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
  const stepStatus = () => {
    if (screening) return {smartRecruitersScreening:true};
    if (deepQuery(owner,'oc-personal-information').length === 1 &&
        deepQuery(owner,'oc-nav-first-page footer[data-test=footer] oc-button[data-test=footer-next]').length === 1) {
      return {smartRecruitersFirstStep:true};
    }
    return {};
  };
  return {owner, region, current, upload, writePhone, screening, personalReady, stepStatus};
}

/** Read the OneClick screening footer without interacting with it or inferring form completeness. */
export function smartRecruitersScreeningFooter(expectedUrl) {
  if (!expectedUrl || location.href !== expectedUrl || location.origin !== 'https://jobs.smartrecruiters.com') return;
  const url = new URL(expectedUrl);
  const company = /^\/oneclick-ui\/company\/([\w-]+)\/publication\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\/screening\/?$/i.exec(url.pathname)?.[1];
  if (!company || url.username || url.password || url.searchParams.getAll('dcr_ci').some(value => value !== company)) return;
  const only = (root, selector) => {
    const matches = root?.querySelectorAll(selector);
    return matches?.length === 1 ? matches[0] : null;
  };
  const owner = only(document, 'main oc-screening-questions');
  const footer = only(owner, 'oc-nav-screening-questions');
  const action = only(footer, 'oc-button[data-test=footer-submit]');
  const host = only(action, 'spl-button');
  const button = only(host?.shadowRoot, 'button');
  const hidden = '[hidden],[inert],[aria-hidden=true]';
  const bounds = button?.getBoundingClientRect();
  if (!only(owner, 'oc-screening-questions-form') || !button || button.closest(hidden) || host.closest(hidden) ||
      !bounds.width || !bounds.height || !button.checkVisibility({opacityProperty:true,visibilityProperty:true}) ||
      !/^submit(?: application)?$/i.test(host.innerText.trim())) return 'unknown';
  const disabled = '[disabled],[aria-disabled=true]';
  return button.matches(':disabled') || button.closest(disabled) || host.closest(disabled) ? 'disabled' : 'enabled';
}

export function observeCurrentDocument(inspectedUrl) {
  if (/\.(myworkdayjobs|myworkdaysite)\.com$/.test(location.hostname)) return observeWorkdayDocument();
  const observed = observeFormDocument(applicationAttachmentControls);
  const footer = smartRecruitersScreeningFooter(inspectedUrl);
  if (!footer || observed.kind === 'security_challenge' || observed.kind === 'loading' || observed.signals.includes('account_or_code_control')) return observed;
  const signals = observed.signals.filter(signal => signal !== 'submission_control' && signal !== 'application_submit');
  if (footer !== 'unknown') signals.push('submission_control');
  return {...observed, kind: footer === 'unknown' ? 'unknown' : 'application', signals, screeningSubmissionControl:footer};
}
