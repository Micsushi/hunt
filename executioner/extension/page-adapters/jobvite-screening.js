/** The employer destroys its upload controls when the operator advances to screening. */
export function jobviteScreeningPanel(number = 2, forPreparation = false) {
  if (location.hostname !== 'jobs.jobvite.com' || !/^\/[^/]+\/job\/[^/]+\/apply\/?$/.test(location.pathname)) return;
  const panels = [...document.querySelectorAll(`[ng-form="scopeData.step${number}"][ng-if="showStep(${number})"]`)]
    .filter(panel => panel.getClientRects().length && getComputedStyle(panel).visibility === 'visible' && !panel.closest('[hidden],[inert],[aria-hidden=true]'));
  if (!panels.length) return;
  const form = panels.length === 1 && panels[0].closest('form[name="scopeData.applyForm"][ng-submit="submitApplication()"]');
  const article = form && form.closest('article[ng-controller="JVApply"]');
  if (!article || article.querySelectorAll('form[name="scopeData.applyForm"]').length !== 1) return null;
  if (forPreparation) {
    const next = form.querySelectorAll('[ng-click="nextStep()"]');
    const resume = panels[0].querySelectorAll('#attachResume[ng-controller="JVApplyWith"] button[jv-add-attachment][attachment-label="Resume"][on-success="sendResume(type, res)"]');
    if (number !== 1 || resume.length !== 1 || next.length !== 1 || next[0].type !== 'button' ||
        next[0].form !== form || !(next[0].getClientRects().length) || next[0].closest('[hidden],[inert],[aria-hidden=true]') ||
        (next[0].getAttribute('aria-label') || next[0].textContent).trim().toLowerCase() !== 'next') return null;
  }
  return panels[0];
}

// A retained employer row can identify a displayed name without proving who uploaded it or which bytes it holds.
export function jobviteRetainedResume(panel, fileName) {
  const rows = panel?.querySelectorAll('#attachResume[ng-controller="JVApplyWith"] li[ng-if="resumeName"]');
  if (!rows?.length) return;
  const names = rows[0].querySelectorAll('span[jv-focus-on="resumeName"][ng-click="editOrPreviewResume()"]');
  const name = names[0];
  const visibleMatch = panel.querySelectorAll('#attachResume[ng-controller="JVApplyWith"]').length === 1 &&
    rows.length === 1 && names.length === 1 && name.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) &&
    !name.closest('[hidden],[inert],[aria-hidden=true]') &&
    name.innerText.trim() === fileName;
  return visibleMatch ? 'resume_filename_visible_contents_unverified' : 'existing_attachment_preserved';
}

export function jobviteResumeAcknowledgment(panel, fileName, detached = false) {
  if (panel.matches('[aria-busy=true],[aria-invalid=true]') ||
      panel.querySelector('[aria-busy=true],[aria-invalid=true],[role=progressbar]') ||
      /\b(?:uploading|upload failed|upload error|invalid file)\b/i.test(panel.innerText)) return;
  const shown = selector => [...panel.querySelectorAll(selector)].filter(node => detached || node.getClientRects().length &&
    getComputedStyle(node).visibility === 'visible' && !node.closest('[hidden],[inert],[aria-hidden=true]'));
  const names = shown('span[jv-focus-on="resumeName"][ng-click="editOrPreviewResume()"]');
  const removes = shown('a[href=""][ng-click="removeResume()"]');
  const row = names[0]?.closest('li[ng-if="resumeName"]');
  if (row && names.length === 1 && removes.length === 1 && row === removes[0].closest('li[ng-if="resumeName"]') && names[0].textContent.trim() === fileName &&
      removes[0].textContent.trim().toLowerCase() === 'remove') return {label:names[0], remove:removes[0]};
}

export function watchJobviteScreening(receipt, binding, state) {
  if (binding?.kind !== 'jobvite' || !binding.valid()) return;
  const form = receipt.region;
  const article = form.closest?.('article[ng-controller="JVApply"]');
  const firstSelector = '[ng-form="scopeData.step1"][ng-if="showStep(1)"]';
  const first = binding.trigger.closest(firstSelector);
  const owner = binding.trigger.closest('#attachResume[ng-controller="JVApplyWith"]');
  if (!article || !first || !owner || !first.contains(owner) || !form.contains(first) || binding.trigger.getAttribute('on-success') !== 'sendResume(type, res)' ||
      !form.matches('form[name="scopeData.applyForm"][ng-submit="submitApplication()"]')) return;
  const nextButtons = form.querySelectorAll('button[type=button][ng-click="nextStep()"]');
  if (nextButtons.length !== 1 || nextButtons[0].form !== form) return;
  const next = nextButtons[0], doc = document;
  const active = () => doc === document && location.href === receipt.url && state.resumeAttempt === receipt &&
    article.isConnected && form.closest('article[ng-controller="JVApply"]') === article &&
    article.querySelectorAll('form[name="scopeData.applyForm"]').length === 1 && form.name === 'scopeData.applyForm' &&
    form.getAttribute('ng-submit') === 'submitApplication()';
  const accepted = () => receipt.selectedFileAccepted && receipt.fileSha256 && state.fileEvents?.get(receipt.element) === receipt.file &&
    (!receipt.element.files?.length || receipt.element.files.length === 1 && receipt.element.files[0] === receipt.file);
  const controller = new AbortController();
  const options = {capture:true, signal:controller.signal};
  let attachment, pending = false, second, timer;
  const invalidate = () => {
    attachment = second = null;
    observer.disconnect();
    controller.abort();
    clearTimeout(timer);
  };
  const secondValid = () => !!second && second.closest('form') === form && !form.querySelector(firstSelector) &&
    ![...second.querySelectorAll('input[type=file]')].some(input=>input.files?.length) && jobviteScreeningPanel() === second;
  const observe = (records = []) => {
    if (!active()) { invalidate(); return; }
    // Angular can remove a failed/replaced receipt and the entire step in one
    // task. Only removal of the intact original panel is evidence of Next.
    if (attachment && records.some(record => {
      if (record.type !== 'childList') return false;
      return [...record.removedNodes].some(node => {
        if (node === first && pending && !second) return false;
        return node.contains(attachment.label) || node.contains(attachment.remove) || second && node.contains(second);
      });
    })) { invalidate(); return; }
    if (second) {
      if (!secondValid()) invalidate();
      return;
    }
    if (pending && !first.isConnected) {
      const panel = jobviteScreeningPanel();
      const finalReceipt = jobviteResumeAcknowledgment(owner, receipt.file.name, true);
      if (panel && panel.closest('form') === form && !form.querySelector(firstSelector) &&
          first.contains(owner) && finalReceipt?.label === attachment.label && finalReceipt.remove === attachment.remove) {
        second = panel; clearTimeout(timer);
      }
      return;
    }
    if (!form.contains(first) || !first.contains(owner)) { invalidate(); return; }
    const current = jobviteResumeAcknowledgment(owner, receipt.file.name);
    if (attachment && (!current || current.label !== attachment.label || current.remove !== attachment.remove)) {
      invalidate(); return;
    }
    if (current && accepted()) attachment = current;
  };
  const observer = new MutationObserver(observe);
  // An existing receipt, even one with the same filename, cannot identify this write.
  if ([...first.querySelectorAll('[jv-focus-on="resumeName"],[ng-click="removeResume()"]')].some(e=>e.getClientRects().length)) return;
  observer.observe(article,{subtree:true,childList:true,characterData:true,attributes:true});
  const checkFile = event => {
    if (event.target?.type === 'file' && (event.target !== receipt.element ||
        event.target.files?.length !== 1 || event.target.files[0] !== receipt.file)) invalidate();
  };
  for (const type of ['input','change']) {
    doc.addEventListener(type, checkFile, options);
    receipt.element.addEventListener(type, checkFile, options);
  }
  first.addEventListener('click', event => {
    if (attachment && event.target.closest?.('[ng-click="removeResume()"],[jv-add-attachment][attachment-label="Resume"]')) invalidate();
  },options);
  let queuedAttempts = 0, disclosureOpened = false, queuedClick;
  next.addEventListener('click', event => {
    observe(observer.takeRecords());
    if (!event.isTrusted || state.busy || controller.signal.aborted || !attachment || !accepted() || !active() ||
        next.disabled || next.type !== 'button' || next.form !== form || next.getAttribute('ng-click') !== 'nextStep()' ||
        (next.getAttribute('aria-label') || next.textContent).trim().toLowerCase() !== 'next' ||
        !first.matches(firstSelector) || form.querySelectorAll(firstSelector).length !== 1 ||
        !first.isConnected || jobviteScreeningPanel() !== undefined) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => { pending = false; if (!first.isConnected && !second) invalidate(); }, queuedClick === event ? 10_000 : 3000);
    queuedClick = null;
  }, options);
  receipt.jobviteNextPending = () => pending && !controller.signal.aborted && active() && accepted();
  receipt.acknowledgedPanel = () => {
    const records = observer.takeRecords();
    if (records.length) observe(records);
    if (controller.signal.aborted || !active() || !accepted()) return null;
    if (second) return secondValid() ? second : null;
    if (!attachment || !form.contains(first) || !first.contains(owner) || jobviteScreeningPanel(1) !== first ||
        jobviteScreeningPanel() !== undefined) return null;
    const current = jobviteResumeAcknowledgment(owner,receipt.file.name);
    return current?.label === attachment.label && current.remove === attachment.remove ? first : null;
  };
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible' &&
    !el.closest('[hidden],[inert],[aria-hidden=true]');
  const disclosure = () => {
    const links = [...form.querySelectorAll('.jv-apply-form-actions .jv-apply-error a[ng-click="showAllFields = true"]')].filter(visible);
    const link = links.length === 1 && links[0];
    return link && link.closest('form') === form && link.getAttribute('href') === '' &&
      !link.hasAttribute('target') && link.textContent.trim().toLowerCase() === 'view full application form' ? link : null;
  };
  const firstReady = () => !state.busy && receipt.acknowledgedPanel() === first &&
    ![...document.querySelectorAll('[role=dialog],dialog[open]')].some(visible) &&
    ![...form.querySelectorAll('button[type=submit],input[type=submit]')].some(visible);
  receipt.jobviteRejected = () => {
    if (!queuedAttempts || !firstReady() || !disclosure()) return false;
    pending = false;
    clearTimeout(timer);
    return queuedAttempts === 2 && disclosureOpened ? 'retry-rejected' : 'rejected';
  };
  const required = () => [...first.querySelectorAll('input:required,textarea:required,select:required,input[aria-required=true],textarea[aria-required=true],select[aria-required=true]')].filter(visible);
  receipt.jobviteExpanded = () => disclosureOpened && firstReady() && !disclosure() && required().length > 0;
  const claim = (button,ready,onClick) => {
    if (!ready()) return null;
    const guard = new AbortController();
    const opts = {capture:true,signal:guard.signal};
    let clicked = false;
    const stop = event => {event.preventDefault();event.stopImmediatePropagation();};
    window.addEventListener('click',event=>{
      if (clicked || !event.isTrusted || !event.composedPath().includes(button) || !ready()) { stop(event); return; }
      clicked = true; onClick(event);
    },opts);
    window.addEventListener('submit',stop,opts);
    const timeout=setTimeout(()=>guard.abort(),5000);
    return {button,clicked:()=>clicked,release:()=>{clearTimeout(timeout);guard.abort();}};
  };
  receipt.claimJobviteDisclosure = selectedHash => {
    const link = disclosure();
    if (!link) return null;
    return claim(link,()=>queuedAttempts===1 && !disclosureOpened && selectedHash===receipt.fileSha256 &&
      firstReady() && disclosure()===link && required().length===0,()=>{disclosureOpened=true;});
  };
  receipt.claimJobviteNext = (selectedHash,verifiedFields) => {
    const ready = () => !pending && selectedHash === receipt.fileSha256 && firstReady() && !disclosure() &&
      next.form === form && form.contains(next) && form.querySelectorAll('button[ng-click="nextStep()"]').length === 1 &&
      next.type === 'button' && next.getAttribute('ng-click') === 'nextStep()' && !next.hasAttribute('formaction') &&
      !next.disabled && next.getAttribute('aria-disabled') !== 'true' &&
      (next.getAttribute('aria-label') || next.textContent).trim().toLowerCase() === 'next' && visible(next) &&
      ![...first.querySelectorAll('input:invalid,select:invalid,textarea:invalid,[aria-invalid=true],[aria-busy=true]')].some(visible);
    return claim(next,()=>{
      if (!ready()) return false;
      if (queuedAttempts===0) return true;
      const fields=required();
      return queuedAttempts===1 && receipt.jobviteExpanded() && fields.length===Object.keys(verifiedFields).length &&
        fields.every(e=>e.validity.valid && e.getAttribute('aria-invalid')!=='true' && !!e.value.trim() &&
          verifiedFields[state.matchingIds?.get(e)] === e.value);
    },event=>{queuedAttempts++; queuedClick=event;});
  };
}
