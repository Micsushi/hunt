// Structural evidence shared by hosted preparation and current-page inspection.
export function observeFormDocument(attachmentControls = 'input[type=file]') {
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden],[inert],[aria-hidden="true"]');
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const email = all('input[type=email],input[name=email],input[id=email]');
  const submit = all('button,input[type=submit]').filter(e => /^(submit application|submit|send application|envoyer la candidature)$/i.test(
    e.getAttribute('aria-label') || (e instanceof HTMLInputElement ? e.value : e.textContent?.trim()) || ''));
  const passwords = all('input[type=password],input[autocomplete=one-time-code]');
  const challenge = all('[role=dialog] iframe[title="hCaptcha"],[role=dialog] iframe[title="reCAPTCHA"]');
  const loading = document.readyState === 'loading' || all('form[aria-busy=true],[role=form][aria-busy=true]').length > 0;
  const ownerOf = element => element.hasAttribute('form') ? element.form : element.form ?? element.closest('form,[role=form]') ?? document.body;
  const owners = new Set(email.map(ownerOf));
  const submitOwner = submit.length === 1 ? ownerOf(submit[0]) : null;
  const sameForm = !!submitOwner && email.length > 0 && submit.length === 1 && owners.size === 1 && owners.has(submitOwner);
  const applicationSubmit=submit.length===1 && /application|candidature/i.test(submit[0].getAttribute('aria-label') || submit[0].textContent || submit[0].value || '');
  const identity = !!submitOwner && all('input:not([type=hidden]):not([type=email]):not([type=password])').some(e => ownerOf(e) === submitOwner && /name|firstname|lastname/i.test([e.getAttribute('name'),e.id,...(e instanceof HTMLInputElement ? [...e.labels??[]].map(label=>label.textContent) : [])].join(' ')));
  const attachment = !!submitOwner && [...document.querySelectorAll(attachmentControls)].some(e => ownerOf(e) === submitOwner);
  const application = sameForm && (applicationSubmit || identity || attachment);
  const accountOwners = new Set(passwords.map(ownerOf));
  const [accountForm] = accountOwners;
  const profileName = all('input:not([type=password]):not([type=email])').some(input =>
    ownerOf(input) === accountForm && (/^(?:given-name|family-name|name)$/i.test(input.autocomplete) ||
      [...input.labels ?? []].some(label => /^(?:(?:first|last|full|given|family)\s+)?name\s*[*✱]?$/i.test(label.innerText.trim()))));
  const registration = accountOwners.size === 1 && accountForm?.matches('form,[role=form]') &&
    passwords.every(input => input.type === 'password' && input.autocomplete !== 'current-password') &&
    (passwords.some(input => input.autocomplete === 'new-password') ||
      profileName && email.some(input => ownerOf(input) === accountForm) ||
      all('button,input[type=submit]').some(button => ownerOf(button) === accountForm &&
        /^(?:create (?:an? |your )?(?:account|profile)|sign up|register)$/i.test((button.innerText || button.value || '').trim())));
  const separateAccountForm = !!submitOwner && submitOwner !== document.body && (applicationSubmit || identity || attachment) &&
    email.some(input => ownerOf(input) === submitOwner) &&
    email.every(input => ownerOf(input) === submitOwner || accountOwners.has(ownerOf(input))) &&
    passwords.length > 0 && passwords.every(input => {
      const owner = ownerOf(input);
      return input.type === 'password' && owner && owner !== submitOwner && owner !== document.body &&
        owner.contains(input) && !input.closest('dialog,[role=dialog],[aria-modal=true]');
    });
  const signals = [registration ? 'profile_registration' : '', separateAccountForm ? 'separate_account_form' : '', email.length > 0 ? 'email_control' : '', submit.length === 1 ? 'submission_control' : '', sameForm ? 'shared_form' : '', applicationSubmit ? 'application_submit' : '', identity ? 'identity_control' : '', attachment ? 'attachment_control' : '', passwords.length ? 'account_or_code_control' : '', challenge.length ? 'security_challenge' : '', loading ? 'loading_marker' : ''].filter(Boolean);
  return {version:'hosted-page-v1',documentKey:String(performance.timeOrigin),kind:challenge.length ? 'security_challenge' : passwords.length ? 'unknown' : loading ? 'loading' : application ? 'application' : 'unknown',signals,conflicts:owners.size > 1 || submit.length > 1 ? ['multiple_form_candidates'] : []};
}

// Unknown standalone forms remain eligible for current-page filling.
export function currentPageInterruption(observation, action = 'fill', currentPage = false) {
  // Only the generic form observer admits unknown, non-account documents.
  if (observation.version !== 'hosted-page-v1') {
    if (observation.kind === 'application' || observation.kind === 'review') return;
  } else {
    if (action === 'undo' || action === 'redo') return;
    if (observation.kind !== 'loading' && observation.kind !== 'security_challenge' &&
        (!observation.signals.includes('account_or_code_control') || observation.signals.includes('separate_account_form') ||
          currentPage && observation.signals.includes('profile_registration') && !observation.signals.includes('loading_marker'))) return;
  }
  const reason = observation.kind === 'unknown' && observation.signals.includes('account_or_code_control')
    ? 'account_or_code_control' : observation.kind;
  const componentFailure = {component:'page_state', operation:'blocked_by_' + reason};
  const history = globalThis.__huntC3PartialFill;
  return {
    status:'partial', observation, incomplete:true, filled:[], matching:[],
    skipped:[{label:'Employer page', reason, componentFailure}], componentFailure,
    canUndo:!!history?.undo?.length, canRedo:!!history?.redo?.length,
  };
}
