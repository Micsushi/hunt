// Chrome and Playwright serialize this function into the selected document.
export function observeWorkdayDocument(installForAccountActions = false) {
  function readPage() {
    const visible = e => e instanceof HTMLElement && e.isConnected && e.getClientRects().length > 0 &&
      getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden],[inert],[aria-hidden="true"]');
    const all = selector => [...document.querySelectorAll(selector)].filter(visible);
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
    return {version:'workday-page-v1',documentKey:String(performance.timeOrigin),kind,signals,conflicts:ambiguous ? signals.filter(s=>['sign_in_form','create_account_form','application_root','review_root','verification_marker','verification_message','password_reset_form','password_reset_required','account_exists_response','credential_rejection'].includes(s)) : []};
  }

  if (installForAccountActions === true) {
    // chrome.scripting executes account operations in the extension's isolated world.
    // Install the reader, never a saved result: every operation reads at the point of use.
    globalThis.__huntC3ObserveWorkday = readPage;
    return true;
  }
  return readPage();
}
