/** The employer destroys its upload controls when the operator advances to screening. */
export function jobviteScreeningPanel(number = 2) {
  if (location.hostname !== 'jobs.jobvite.com' || !/^\/[^/]+\/job\/[^/]+\/apply\/?$/.test(location.pathname)) return;
  const panels = [...document.querySelectorAll(`[ng-form="scopeData.step${number}"][ng-if="showStep(${number})"]`)]
    .filter(panel => panel.getClientRects().length && getComputedStyle(panel).visibility === 'visible' && !panel.closest('[hidden],[inert],[aria-hidden=true]'));
  if (!panels.length) return;
  const form = panels.length === 1 && panels[0].closest('form[name="scopeData.applyForm"][ng-submit="submitApplication()"]');
  const article = form && form.closest('article[ng-controller="JVApply"]');
  return article && article.querySelectorAll('form[name="scopeData.applyForm"]').length === 1 ? panels[0] : null;
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
  next.addEventListener('click', event => {
    observe(observer.takeRecords());
    if (!event.isTrusted || state.busy || controller.signal.aborted || !attachment || !accepted() || !active() ||
        next.disabled || next.type !== 'button' || next.form !== form || next.getAttribute('ng-click') !== 'nextStep()' ||
        (next.getAttribute('aria-label') || next.textContent).trim().toLowerCase() !== 'next' ||
        !first.matches(firstSelector) || form.querySelectorAll(firstSelector).length !== 1 ||
        !first.isConnected || jobviteScreeningPanel() !== undefined) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => { pending = false; if (!first.isConnected && !second) invalidate(); }, 3000);
  }, options);
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
}
