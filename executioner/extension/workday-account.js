// Runs in the employer's isolated main-frame world, never another extension's frame.
export function workdayAccountPage(request) {
  let observation;
  const result = value => ({...value, observation});
  const fail = reason => result({ state: 'blocked', reason });
  const visible = e => e instanceof HTMLElement && e.isConnected && e.getClientRects().length > 0 &&
    getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden],[inert],[aria-hidden="true"]');
  const ready = e => visible(e) && !e.matches(':disabled,[aria-disabled="true"]');
  const all = selector => [...document.querySelectorAll(selector)].filter(visible);
  const one = selector => { const matches = all(selector); return matches.length === 1 ? matches[0] : null; };
  const ids = names => names.map(name => `[data-automation-id="${name}"]`).join(',');
  // This read-only observation is also used by the application engine. Never infer it from the last action.
  const text = e => (e.textContent ?? '').replace(/\s+/g,' ').trim();
  const exact = (selector, pattern) => all(selector).some(e => pattern.test(text(e)));
  const applicationIds = ['applyFlowMyInfoPage','applyFlowMyExperiencePage','applyFlowMyExpPage','applyFlowPrimaryQuestionsPage','applyFlowSecondaryQuestionsPage','applyFlowSupplementaryQuestionsPage','applyFlowPrimaryQuestionnairePage','applyFlowApplicationQuestionsPage','applyFlowVoluntaryDisclosuresPage','applyFlowSelfIdentifyPage','takeAssessmentPage'];
  const application = all(ids(applicationIds));
  const review = all(ids(['applyFlowReviewPage']));
  const accountRoots = ids(['signInPage','signInContent','createAccountPage']) + ',[data-automation-id="signInFormo"]';
  const accountMessages = accountRoots + ',[role="alert"],[data-automation-id="errorMessage"]';
  const signIn = all(accountRoots).some(e => e.querySelector('[data-automation-id="signInSubmitButton"]'));
  const createAccount = all(accountRoots).some(e => e.querySelector('[data-automation-id="createAccountSubmitButton"]'));
  const signals = [];
  const has = (name, condition) => { if (condition) signals.push(name); return !!condition; };
  const security = has('security_marker', all(ids(['captchaChallenge','mfaChallenge','securityChallenge','accessDeniedPage'])).length || all('iframe[title="hCaptcha"],iframe[title="reCAPTCHA"]').length);
  const closed = has('closed_marker', all(ids(['jobNotFoundPage','jobClosedPage','jobRemovedPage','jobUnavailablePage'])).length) ||
    has('not_found_message', exact('h1,h2,[role="heading"],[data-automation-id="errorMessage"]', /^The page you are looking for doesn[\u2019']t exist\.?$/i));
  const completed = has('already_applied_message', exact('[data-automation-id="applyFlowPage"], [role="alert"], main', /^You[\u2019']ve already applied for this job\.$/i) ||
    all('[data-automation-id="applyFlowPage"] p,[data-automation-id="applyFlowPage"] div,[role="alert"] p').some(e => /^You[\u2019']ve already applied for this job\.$/i.test(text(e)))) ||
    has('completed_marker', all(ids(['applicationSubmittedPage','applicationConfirmationPage'])).length);
  const errorHeading = exact('h1,h2,h3,[role="heading"],div,p,span', /^Something went wrong\.?$/i);
  const refreshMessage = exact('div,p,span', /^Please refresh the page and then try again\.$/i);
  const siteError = has('refresh_error', refreshMessage && (errorHeading || all('[data-automation-id="applyFlowPage"]').length > 0)) ||
    has('service_unavailable', document.body?.innerText.trim() === '{"503":"service-unavailable"}');
  // A coded page failure does not authorize refresh: the visible draft may be unsaved.
  const codedError = has('coded_page_error', all('[role="alert"],[role="alertdialog"],[data-automation-id="inputAlert"],[data-automation-id*="error" i],[class*="error-summary" i],[id*="error-summary" i],[class*="errorsummary" i],[id*="errorsummary" i]').some(node => {
    const excluded = 'input,textarea,select,option,script,style,noscript,template,label,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="listbox"],[role="option"]';
    const rendered = e => {
      if (!visible(e) || e.closest(excluded)) return false;
      for (let owner=e; owner; owner=owner.parentElement) if (getComputedStyle(owner).opacity === '0') return false;
      return true;
    };
    if (!rendered(node)) return false;
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let content='',part,count=0;
    while ((part=walker.nextNode())) {
      if (++count>2000) return false;
      if (!part.parentElement || !rendered(part.parentElement)) continue;
      content+=' '+part.textContent;
      if (content.length>6000) return false;
    }
    return /^(?:Error Page Error\s*-\s*Error Code:\s*[A-Z0-9][A-Z0-9|._:-]{0,255}\s*)+$/i.test(content.replace(/\s+/g,' ').trim());
  }));
  const verification = has('verification_marker', all(ids(['emailVerificationPage','verifyEmailPage'])).length) ||
    has('verification_message', exact(accountMessages, /verify your account before you sign in|request a verification email|an email has been sent to you\./i));
  const reset = has('password_reset_form', all(ids(['forgotPasswordPage','resetPasswordPage','forgotPasswordConfirmationPage'])).length ||
    all('[data-automation-id="resetPasswordButton"]').length === 1 && all('input[data-automation-id="email"]').length === 1 ||
    all('form[data-automation-id="signInFormo"]').some(e=>e.querySelector('[data-automation-id="resetPasswordButton"]'))) ||
    has('password_reset_required', exact('[role="alert"]', /You need to reset your password due to an administrator request\./i));
  const exists = has('account_exists_response', createAccount && exact('[data-automation-id="accountAlreadyExistsError"],[data-automation-id="errorMessage"],[role="alert"]', /already exists|already have an account|account exists/i));
  const rejected = has('credential_rejection', signIn && (all(ids(['accountNotFoundError','invalidCredentialsError'])).some(e=>text(e)) ||
    exact(accountMessages, /You may have entered the wrong email address or password|(?:incorrect|invalid) (?:email|password|credentials)/i)));
  const unknownAlert = has('unrecognized_account_alert', (signIn || createAccount) && !verification && !reset && !exists && !rejected && all('[data-automation-id="errorMessage"],[role="alert"]').some(e=>text(e)));
  const loading = has('loading_marker', document.readyState === 'loading' || all('[data-automation-id="applyFlowLoadingPage"],[data-automation-id="loadingSpinner"],[data-automation-id="loadingIndicator"],[data-automation-id="applyFlowPage"][aria-busy="true"],[data-automation-id="authPage"][aria-busy="true"]').length);
  has('sign_in_form', signIn); has('create_account_form', createAccount);
  has('application_root', application.length); has('review_root', review.length);
  signals.push(...application.map(root=>'root_'+root.getAttribute('data-automation-id').toLowerCase()));
  const entryLink = has('entry_link', all('a[href],button').filter(e=>/^(Apply|Apply Now|Apply Manually|Start Your Application|Continue Application)$/.test(text(e))).length === 1);
  const entry = has('entry_control', all(ids(['applyManually','applyManuallyButton','SignInWithEmailButton','jobPostingHeader','jobPostingDescription','signInLink','createAccountLink'])).length) || entryLink;
  const roots=[...application,...review];
  const ambiguous = signIn && createAccount || roots.length > 1 && roots.filter(candidate=>roots.every(root=>candidate===root || candidate.contains(root))).length!==1 ||
    [verification,reset,exists,rejected].filter(Boolean).length>1;
  const kind = security ? 'security_challenge' : codedError ? 'employer_coded_error' : siteError ? 'employer_error' : closed ? 'closed' : completed ? 'completed' : ambiguous ? 'unknown' :
    verification ? 'email_verification' : reset ? 'password_reset' : exists ? 'account_exists' : rejected ? 'credential_rejected' : loading ? 'loading' :
    unknownAlert ? 'unknown' : createAccount ? 'create_account' : signIn ? 'sign_in' : review.length ? 'review' : application.length ? 'application' : entry ? 'entry' : 'unknown';
  observation = {version:'workday-page-v1',documentKey:String(performance.timeOrigin),kind,signals,conflicts:ambiguous ? signals.filter(s=>['sign_in_form','create_account_form','application_root','review_root','verification_marker','verification_message','password_reset_form','password_reset_required','account_exists_response','credential_rejection'].includes(s)) : []};
  if (request.operation === 'observe') return observation;
  if (window !== window.top || Date.now() >= request.expiresAt || location.href !== request.expectedUrl) return fail('document_changed');
  const expected = new URL(request.jobUrl);
  const current = new URL(location.href);
  const posting = url => url.pathname.match(/\/job\/(.+)/i)?.[1]?.replace(/(?:\/(?:apply|applyManually))+\/?$/i, '').replace(/\/$/, '').split('/').at(-1);
  const redirect = current.searchParams.get('redirect');
  const redirectTarget = redirect ? new URL(redirect, current.origin) : null;
  const boundLogin = /\/login\/?$/i.test(current.pathname) && redirectTarget?.origin === expected.origin && posting(redirectTarget) === posting(expected);
  if (current.origin !== expected.origin || posting(current) !== posting(expected) && !boundLogin) return fail('target_changed');
  const blocked = {security_challenge:'security_check',closed:'unavailable',completed:'completed',employer_error:'employer_error',employer_coded_error:'employer_coded_error',email_verification:'verification',password_reset:'reset',credential_rejected:'rejected'};
  if (request.operation === 'recover_employer_error') {
    if (kind !== 'employer_error') return fail('document_changed');
    location.reload();
    return result({state:'reloading'});
  }
  if (blocked[kind]) return fail(blocked[kind]);
  if (kind === 'loading' || kind === 'unknown' && (ambiguous || unknownAlert)) return result({state:kind});
  if (kind === 'application' || kind === 'review') return result({state:'application'});
  // Workday hides the inner submit button from accessibility and exposes its click_filter owner.
  const markers = [...document.querySelectorAll('[data-automation-id="signInSubmitButton"]')];
  const marker = markers.length === 1 ? markers[0] : null;
  const create = one('[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="createAccountSubmitButton"]) [data-automation-id="click_filter"][role="button"]');
  const button = create ?? (marker ? one('[data-automation-id="noCaptchaWrapper"]:has([data-automation-id="signInSubmitButton"]) [data-automation-id="click_filter"][role="button"]') : null);
  const root = button?.closest('[data-automation-id="createAccountPage"],[data-automation-id="signInPage"],form[data-automation-id="signInFormo"],[data-automation-id="signInContent"]');
  const email = one('input[data-automation-id="email"]');
  const password = one('input[data-automation-id="password"]');
  const confirm = one('input[data-automation-id="verifyPassword"]');
  const consent = one('input[data-automation-id="createAccountCheckbox"]');
  const owned = root && button && !(create && marker) && root.contains(email) && root.contains(password);
  const editable = field => field instanceof HTMLInputElement && ready(field) && !field.readOnly;
  const fieldsReady = owned && visible(button) && editable(email) && ['email','text'].includes(email.type) && editable(password) && password.type === 'password' && (!create || root.contains(confirm) && editable(confirm) && confirm.type === 'password');
  if (request.operation !== 'inspect' && kind === 'account_exists' && request.operation !== 'navigate') return fail('account_exists');
  if (request.operation === 'fill_page') {
    if (!fieldsReady) return fail('fields_not_ready');
    if (typeof request.email !== 'string' || !request.email || request.email.length > 320 ||
        typeof request.password !== 'string' || !request.password || request.password.length > 4096) return fail('invalid_request');
    if (email.value.trim() && email.value.trim().toLowerCase() !== request.email.toLowerCase()) return fail('account_email_conflict');
    const fields = [[email, request.email, 'email'], [password, request.password, 'password'],
      ...(create ? [[confirm, request.password, 'confirm']] : [])];
    const filled = [];
    for (const [field, value, name] of fields) {
      if (field.value !== value) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
        field.dispatchEvent(new Event('input', {bubbles:true}));
        field.dispatchEvent(new Event('change', {bubbles:true}));
        filled.push({field:name});
      }
      if (!field.isConnected || field.value !== value) return fail('values_changed');
    }
    if (create && consent && request.acceptCreationTerms === true) {
      if (!root.contains(consent) || !ready(consent) || consent.type !== 'checkbox') return fail('consent');
      if (!consent.checked) {consent.click();filled.push({field:'account_terms'});}
      if (!consent.isConnected || !consent.checked) return fail('consent');
    }
    if (!fields.every(([field,value]) => field.isConnected && field.value === value)) return fail('values_changed');
    return {state:'account_filled',filled,termsChecked:!!consent?.checked};
  }
  if (request.operation === 'accept_creation_terms') {
    if (!create || !fieldsReady || !root.contains(consent) || !ready(consent) || consent.type !== 'checkbox') return fail('consent');
    if (!consent.checked) consent.click();
    return {state:'consent_set',verified:consent.isConnected && consent.checked};
  }
  if (request.operation === 'fill' || request.operation === 'click') {
    if ((request.accountMode === 'create') !== !!create) return fail('document_changed');
    if (!fieldsReady) return fail('fields_not_ready');
    if (request.operation === 'fill') {
      if (!(create ? ['email','password','confirm'] : ['email','password']).includes(request.field) || typeof request.value !== 'string' || !request.value || request.value.length > 4096) return fail('invalid_request');
      const field = request.field === 'email' ? email : request.field === 'confirm' ? confirm : password;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, request.value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return { state: 'filled', verified: field.isConnected && field.value === request.value };
    }
    // Recheck both values in the same operation as the sole Sign In click.
    if (!ready(button)) return fail('fields_not_ready');
    if (create && consent && !consent.checked) return fail('consent');
    if (email.value !== request.email || password.value !== request.password || create && confirm.value !== request.password) return fail('values_changed');
    button.click();
    return { state: 'clicked' };
  }
  if (request.operation === 'inspect') {
    if (kind === 'account_exists') return result({state:'account_exists'});
    if (create) return result({state:'create_account',ready:!!fieldsReady,clickReady:!!fieldsReady && ready(button),consentRequired:!!consent && !consent.checked});
    if (request.preferCreate && ready(one('[data-automation-id="createAccountLink"]'))) return result({state:'navigation',action:'show_create_account'});
    if (marker) return result({ state: 'sign_in', ready: !!fieldsReady, clickReady: !!fieldsReady && ready(button) });
  }
  const navigation = [
    ...(request.preferCreate ? [['show_create_account', ids(['createAccountLink'])]] : []),
    ['show_sign_in', ids(['signInLink','SignInWithEmailButton'])],
    ['apply_manually', ids(['applyManually','applyManuallyButton']) + ',a[href$="/apply/applyManually"]'],
  ];
  let action, control;
  for (const [name, selector] of navigation) {
    const candidate = one(selector);
    if (candidate && ready(candidate)) { action = name; control = candidate; break; }
  }
  if (!control && !marker && !create) {
    const candidates = [...document.querySelectorAll('a[href]')].filter(e => ready(e) && /^(Apply|Apply Now|Apply Manually|Start Your Application|Continue Application)$/.test(e.textContent.trim()));
    if (candidates.length === 1) { control = candidates[0]; action = control.textContent.trim() === 'Continue Application' ? 'continue_application' : 'open_application'; }
  }
  if (request.operation === 'navigate') {
    if (!control || action !== request.action) return fail('navigation_changed');
    if (control instanceof HTMLButtonElement && control.form && control.type !== 'button') return fail('navigation_changed');
    if (control instanceof HTMLAnchorElement) {
      const destination = new URL(control.href);
      if (destination.origin !== expected.origin || posting(destination) !== posting(expected) || control.target && control.target !== '_self') return fail('target_changed');
    }
    control.click();
    return { state: 'navigated' };
  }
  if (control) return result({ state: 'navigation', action });
  if (create) return fail('creation');
  return result({ state: 'unknown' });
}

export async function workdayAccountCommand(chrome, sessions, attached, pageActionTabs, params, connection) {
  const job = new URL(params.url);
  if (job.protocol !== 'https:' || job.username || job.password || job.port || !/^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(job.hostname) || !/\/job\//i.test(job.pathname)) throw new Error('Use the selected Workday application.');
  if (typeof params.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(params.runId)) throw new Error('Invalid sign-in operation.');
  if (params.operation === 'cancel') {
    for (const [tabId, owner] of sessions) if (owner.runId === params.runId && owner.connection === connection) { sessions.delete(tabId); pageActionTabs.delete(tabId); }
    return {};
  }
  if (params.operation === 'begin') {
    let tab;
    if (params.tabId) {
      try { tab = await chrome.tabs.get(params.tabId); }
      catch (error) { if (!/No tab with id/i.test(error.message)) throw error; }
    }
    if (params.existingOnly && (!tab || tab.discarded || tab.pendingUrl || tab.url !== params.expectedUrl)) throw new Error('The selected account page changed. Inspect it again.');
    tab ??= await chrome.tabs.create({ url: job.href, active: false });
    if (attached.has(tab.id) || pageActionTabs.has(tab.id) || sessions.has(tab.id)) throw new Error('C3 is already operating this tab.');
    const owner = { connection, runId: params.runId, url: params.url, expiresAt: Date.now() + 300_000, busy: false };
    sessions.set(tab.id, owner);
    pageActionTabs.add(tab.id);
    try {
      const deadline = Date.now() + 30_000;
      while (tab.status !== 'complete' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); tab = await chrome.tabs.get(tab.id); }
      if (tab.status !== 'complete' || connection.readyState !== 1 || sessions.get(tab.id) !== owner) throw new Error('The application connection changed while opening.');
      return { tabId: tab.id };
    } catch (error) {
      if (sessions.get(tab.id) === owner) { sessions.delete(tab.id); pageActionTabs.delete(tab.id); }
      throw error;
    }
  }
  const owner = sessions.get(params.tabId);
  if (!owner || owner.connection !== connection || owner.runId !== params.runId || owner.url !== params.url) throw new Error('The sign-in operation is no longer active.');
  if (params.operation === 'end') { sessions.delete(params.tabId); pageActionTabs.delete(params.tabId); return {}; }
  if (owner.busy || Date.now() >= owner.expiresAt || connection.readyState !== 1) throw new Error('The sign-in operation expired or is busy.');
  owner.busy = true;
  try {
    const tab = await chrome.tabs.get(params.tabId);
    if (sessions.get(params.tabId) !== owner || connection.readyState !== 1) throw new Error('The sign-in operation was cancelled.');
    if (new URL(tab.url).origin !== job.origin) throw new Error('The selected application moved to another site.');
    if (params.operation === 'verification_navigation' || params.operation === 'return_to_job') {
      const destination = new URL(params.operation === 'return_to_job' ? owner.url : params.destination);
      if (destination.origin !== job.origin || destination.username || destination.password || destination.protocol !== 'https:') throw new Error('Verification target mismatch.');
      if (destination.href === tab.url && tab.status === 'complete') return {state:'navigated'};
      const before = await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'ISOLATED',func:()=>true,args:[]});
      const beforeDocument = before.find(item=>item.frameId===0)?.documentId;
      if (!beforeDocument) throw new Error('The account document could not be identified.');
      if (sessions.get(tab.id) !== owner || connection.readyState !== 1) throw new Error('The account operation was cancelled.');
      await chrome.tabs.update(tab.id, {url:destination.href});
      const navigationDeadline = Date.now() + 30_000;
      for (;;) {
        if (sessions.get(tab.id) !== owner || connection.readyState !== 1) throw new Error('The account operation was cancelled.');
        const current = await chrome.tabs.get(tab.id);
        if (new URL(current.url).origin !== job.origin) throw new Error('The account page moved to another site.');
        if (current.status === 'complete' && current.url !== tab.url) break;
        if (current.status === 'complete') {
          const observed = await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'ISOLATED',func:()=>true,args:[]}).catch(()=>[]);
          const document = observed.find(item=>item.frameId===0)?.documentId;
          if (document && document !== beforeDocument) break;
        }
        if (Date.now() >= navigationDeadline) throw new Error('Verification navigation did not settle.');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      return {state:'navigated'};
    }
    if (params.operation === 'recover_employer_error') {
      if (!params.documentId || params.expectedUrl !== tab.url || tab.pendingUrl) throw new Error('Inspect the employer error first.');
      const observed = await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[params.documentId]},world:'ISOLATED',func:workdayAccountPage,
        args:[{operation:'recover_employer_error',jobUrl:owner.url,expectedUrl:tab.url,expiresAt:Date.now()+5000}]});
      const current = observed.find(item=>item.frameId===0);
      if (current?.documentId !== params.documentId || current?.result?.state !== 'reloading' ||
          sessions.get(tab.id) !== owner || connection.readyState !== 1) throw new Error('The employer error changed.');
      const deadline = Date.now()+30_000;
      while (Date.now()<deadline) {
        if (sessions.get(tab.id) !== owner || connection.readyState !== 1) throw new Error('The account operation was cancelled.');
        const latest=await chrome.tabs.get(tab.id);
        if (new URL(latest.url).origin !== job.origin) throw new Error('The employer page changed.');
        if (latest.status==='complete' && !latest.pendingUrl) {
          const documents=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'ISOLATED',func:()=>true}).catch(()=>[]);
          const documentId=documents.find(item=>item.frameId===0)?.documentId;
          if (documentId && documentId !== params.documentId) return {state:'reloaded'};
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      return {state:'loading'};
    }
    if (tab.pendingUrl || tab.status !== 'complete') return {state:'loading',observation:{version:'workday-page-v1',documentKey:'0',kind:'loading',signals:['tab_loading'],conflicts:[]}};
    const request = { ...params, jobUrl: params.url, expectedUrl: params.expectedUrl ?? tab.url, expiresAt: Math.min(owner.expiresAt, Date.now() + 5000, params.expiresAt ?? Infinity) };
    if (params.operation !== 'inspect' && !params.documentId) throw new Error('Inspect the sign-in document first.');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, ...(params.documentId ? { documentIds: [params.documentId] } : { frameIds: [0] }) },
      world: 'ISOLATED', func: workdayAccountPage, args: [request],
    });
    const result = results.find(item => item.frameId === 0);
    if (!result?.documentId || !result.result) throw new Error('The sign-in document could not be inspected.');
    return { ...result.result, ...(result.result.observation ? {observation:{...result.result.observation,documentId:result.documentId}} : {}), documentId: result.documentId, url: tab.url };
  } catch {
    // Never return browser errors that might contain credential arguments.
    throw new Error('C3 could not access the sign-in document. Check Hunt has access to this employer site, then inspect the tab before retrying.');
  } finally { owner.busy = false; }
}
