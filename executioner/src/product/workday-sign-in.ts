import { workdayObservationMessage, type WorkdayPageObservation } from '../ats/workday/page-observation.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApplicationPause, type ProductInput } from './application-contract.ts';
import type { AccountEvent } from './account-journal.ts';
import type { Page } from 'playwright';

export interface WorkdayAccountOptions {
  url: string; tabId?: number; credentials?: ProductInput['credentials']; signal: AbortSignal;
  preferCreate?: boolean;
  acceptCreationTerms?: boolean;
  verificationSince?: number;
  verifyEmail?: (page: Pick<Page, 'url'|'goto'>, since: number, signal: AbortSignal) => Promise<void>;
  record(event: AccountEvent, trace?: string, observation?: WorkdayPageObservation): void;
  onTab(tabId: number): void;
}

/** Current-page account filling shares the protected transport, without navigating or registering. */
export async function fillWorkdayAccountCurrentPage(call: (method:string, params?:Record<string,unknown>)=>Promise<any>,
  request:{operation:string;tabId:number;expectedUrl:string;documentId?:string;expiresAt:number},
  credentials:ProductInput['credentials'], acceptCreationTerms:boolean) {
  const current = new URL(request.expectedUrl);
  if (!/^[a-z0-9-]+\.[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/i.test(current.hostname)) return undefined;
  const job = /\/login\/?$/i.test(current.pathname) && current.searchParams.has('redirect')
    ? new URL(current.searchParams.get('redirect')!, current.origin) : current;
  if (job.origin !== current.origin || !/\/job\//i.test(job.pathname) || job.username || job.password) return undefined;
  const status = await call('agentStatus');
  if (!status?.capabilities?.includes('workday-account-fill-v1') || !status.capabilities.includes('workday-page-v1')) throw new Error('Reload the updated Hunt extension to fill account pages.');
  const base = {url:job.href,tabId:request.tabId,expectedUrl:request.expectedUrl,runId:randomUUID(),expiresAt:request.expiresAt};
  let opened = false;
  try {
    await call('workdayAccount',{...base,operation:'begin',existingOnly:true}); opened = true;
    const state = await call('workdayAccount',{...base,operation:'inspect',fillOnly:true});
    const observed = state.observation;
    if (request.operation === 'inspect' && state.state === 'application' && state.documentId &&
        observed?.version === 'workday-page-v1' && observed.conflicts?.length === 0 &&
        ((observed.kind === 'application' && observed.signals?.includes('application_root')) ||
         (observed.kind === 'review' && observed.signals?.includes('review_root')))) {
      return {priorWorkdayPage:observed.kind as 'application'|'review'};
    }
    if (state.observation && !['application','review','entry','create_account','sign_in'].includes(state.observation.kind)) {
      if (request.operation === 'inspect' && state.documentId) return {tabId:request.tabId,url:request.expectedUrl,documentId:state.documentId,operation:request.operation,
        observation:state.observation,filled:[],skipped:[{label:'Employer page',reason:state.observation.kind}],incomplete:true,canUndo:false,canRedo:false,frames:[]};
      throw new ApplicationPause(workdayObservationMessage(state.observation) ?? 'The employer page is loading or its state is unclear. Inspect it again before filling.');
    }
    if (!['create_account','sign_in'].includes(state.state)) return undefined;
    if (request.operation !== 'inspect' && state.documentId !== request.documentId) throw new Error('The account page changed. Inspect it again before filling.');
    if (request.operation === 'undo' || request.operation === 'redo') throw new Error('Account passwords are not stored in fill history.');
    let filled:unknown[] = [];
    if (request.operation === 'fill') {
      if (!credentials?.email || !credentials.password) throw new Error('Save your account details in Hunt before filling this page.');
      const result = await call('workdayAccount',{...base,documentId:state.documentId,operation:'fill_page',
        email:credentials.email,password:credentials.password,acceptCreationTerms});
      if (result.state !== 'account_filled') throw new Error(result.reason === 'account_email_conflict'
        ? 'This page uses a different email from your saved account. Check the email before filling.'
        : 'Account fields were not fully verified. Check the page before continuing.');
      filled = result.filled;
    }
    return {tabId:request.tabId,url:request.expectedUrl,documentId:state.documentId,operation:request.operation,
      accountPage:true,observation:state.observation,filled,skipped:[],incomplete:false,canUndo:false,canRedo:false,frames:[]};
  } finally {if(opened) await call('workdayAccount',{...base,operation:'end'});}
}

/** The production account flow never attaches a debugger while entering credentials. */
export async function prepareWorkdayAccount(call: (method: string, params?: Record<string, unknown>) => Promise<any>, options: WorkdayAccountOptions): Promise<void> {
  const { signal, record } = options;
  signal.throwIfAborted();
  const status = await call('agentStatus');
  if (!status.capabilities?.includes('workday-account-v1') || !status.capabilities.includes('workday-page-v1')) throw new ApplicationPause('Reload the updated Hunt extension before signing in. Your draft is preserved.');
  if (options.preferCreate && !status.capabilities?.includes('workday-create-account-v1')) throw new ApplicationPause('Reload Hunt to activate account creation. Your draft is preserved.');
  const runId = randomUUID();
  const base = { url: options.url, tabId: options.tabId, runId };
  let opened = false, attempted = false, authenticated = false, creationAttempted = false, verificationAttempted = false;
  let signInClickConfirmed = false;
  let preferCreate = options.preferCreate === true;
  let creationSince = options.verificationSince ?? 0;
  let rejected = false;
  let employerRecovery = false, lastObservation = '';
  let latestObservation: WorkdayPageObservation | undefined;
  let deadline = Date.now() + 90_000;
  const navigation = new Map<string, number>();
  const cancel = () => { void call('workdayAccount', { ...base, operation: 'cancel' }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const command = async (params: Record<string, unknown>) => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new ApplicationPause('The account page did not settle. Inspect the tab before retrying.');
    let result;
    try { result = await call('workdayAccount', { ...base, ...params }); }
    catch { throw new ApplicationPause('The sign-in connection was interrupted. Inspect the tab before retrying; C3 will not repeat the sign-in click automatically.'); }
    // Retain the decisive inner readiness observation too, without recording credentials.
    if (params.operation === 'inspect' && result.observation) {
      latestObservation = result.observation;
      const key = JSON.stringify([result.documentId, result.observation]);
      if (key !== lastObservation) { record('page_observed', undefined, result.observation); lastObservation = key; }
    }
    return result;
  };
  const blocked: Record<string, string> = {
    unavailable: 'This posting is no longer available. Choose another job at this employer.',
    security_check: 'Complete the employer security check, then retry.',
    verification: 'The employer requires email verification. Complete it in this tab, then retry.',
    reset: 'The employer requires password recovery. C3 has not requested or changed a password.',
    creation: 'The account creation form needs review. C3 has not created an account.',
    consent: 'Review the employer account terms in this tab, then retry. C3 has not accepted them.',
    rejected: 'The employer rejected sign-in. Check the account details before retrying.',
    fields_not_ready: 'The sign-in fields are not ready. Inspect the tab before retrying.',
    values_changed: 'The sign-in fields changed after filling. C3 has not clicked Sign In.',
    completed: 'The employer shows this application as already applied or completed. C3 will stop here.',
    employer_coded_error: 'Workday is showing a coded page error. C3 has paused without refreshing or submitting; the current page is preserved.',
    employer_error: 'Workday is still showing an employer error after refreshing. Account access remains unconfirmed; no credential click was repeated.',
  };
  const check = (result: any) => {
    if (result.state === 'blocked' && result.reason === 'rejected' && !rejected) {
      rejected = true;
      record('sign_in_rejected');
    }
    if (result.state === 'blocked') throw new ApplicationPause(blocked[result.reason] ?? 'The selected sign-in form changed. Inspect the tab before retrying.');
  };
  const recoverLateSignIn = async (failure: {state:string;reason?:string}) => {
    if (!signInClickConfirmed || creationAttempted || failure.state !== 'blocked' ||
        !['document_changed','navigation_changed'].includes(failure.reason ?? '')) return false;
    record('sign_in_diagnostic', 'submit_late_' + failure.reason);
    // The original tab and operation lease stay bound. Only inspect during the transition.
    const until = Math.min(deadline, Date.now() + 3000);
    while (Date.now() < until) {
      const current = await command({operation:'inspect'});
      signal.throwIfAborted();
      if (Date.now() >= until) return false;
      const observation = current.observation;
      if (current.state === 'application') {
        const expected = new URL(options.url), landed = URL.parse(current.url);
        const postingPath = (url: URL) => url.pathname.replace(/(?:\/(?:apply|applyManually))+\/?$/i, '').replace(/\/$/, '');
        if (!landed || landed.origin !== expected.origin || landed.username || landed.password ||
            postingPath(landed) !== postingPath(expected) || !current.documentId || observation?.documentId !== current.documentId ||
            observation.version !== 'workday-page-v1' || observation.conflicts?.length !== 0 ||
            !Array.isArray(observation.signals) || observation.signals.some((value:string) =>
              !['application_root','review_root','entry_link','entry_control'].includes(value) && !value.startsWith('root_')) ||
            !(observation.kind === 'application' && observation.signals?.includes('application_root') ||
              observation.kind === 'review' && observation.signals?.includes('review_root'))) return false;
        return true;
      }
      if (current.state === 'blocked') check(current);
      if (!['loading','unknown'].includes(current.state) || !observation ||
          !['loading','unknown'].includes(observation.kind) || observation.conflicts?.length !== 0 ||
          observation.signals?.some((value:string) => !['tab_loading','loading_marker'].includes(value))) return false;
      await delay(150, undefined, {signal});
    }
    return false;
  };
  const applicationOpened = () => {
    if (attempted || creationAttempted) { record('sign_in_transition_observed'); record('application_opened'); }
    authenticated = true;
  };
  try {
    const start = await command({ operation: 'begin' });
    base.tabId = start.tabId; opened = true; options.onTab(start.tabId);
    let fieldDeadline = 0, fieldDocument = '';
    while (Date.now() < deadline) {
      const state = await command({ operation: 'inspect', preferCreate });
      if (state.observation?.kind === 'employer_error' && !employerRecovery) {
        employerRecovery = true;
        record('employer_recovery_started');
        await command({operation:'recover_employer_error',documentId:state.documentId,expectedUrl:state.url});
        // Recovery never resets the credential-attempt guards, including after a new document.
        continue;
      }
      if (state.observation?.kind === 'credential_rejected' || state.state === 'blocked' && state.reason === 'rejected') { rejected = true; record('sign_in_rejected'); }
      if (state.state === 'blocked' && state.reason === 'verification' && creationSince > 0 && !verificationAttempted && options.verifyEmail) {
        verificationAttempted = true;
        deadline = Date.now() + 150_000;
        record('verification_started');
        try {
          await options.verifyEmail({url:()=>options.url,goto:async destination=>{
            await command({operation:'verification_navigation',destination});
            return null;
          }}, creationSince, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          record('verification_blocked');
          throw new ApplicationPause('C3 could not obtain and open a matching employer verification email. The account is unconfirmed; no new registration or password change was attempted.');
        }
        record('verification_link_opened');
        await delay(1500, undefined, {signal});
        await command({operation:'return_to_job'});
        preferCreate = false;
        await delay(1000, undefined, {signal});
        continue;
      }
      if (await recoverLateSignIn(state)) {applicationOpened(); return;}
      check(state);
      if (verificationAttempted && attempted && (state.state==='sign_in' || state.state==='navigation' && state.action==='show_sign_in')) {
        throw new ApplicationPause('C3 opened the verification link, but the employer still requests sign-in. Check the account in this tab before retrying.');
      }
      if (state.state === 'account_exists') {
        const observed=state.observation;
        if (!creationAttempted && (!state.documentId || observed?.version!=='workday-page-v1' || observed.kind!=='account_exists' ||
            observed.conflicts?.length!==0 || !observed.signals?.includes('create_account_form') || !observed.signals.includes('account_exists_response'))) {
          throw new ApplicationPause('C3 could not confirm the employer account-exists notice. Inspect the account page before retrying.');
        }
        preferCreate = false; creationSince = 0;
      }
      if (state.state === 'application') {
        applicationOpened(); return;
      }
      const document = { documentId: state.documentId, expectedUrl: state.url };
      const openSignIn = state.state === 'account_exists' || (state.state === 'create_account' && !preferCreate && !creationAttempted);
      const action = openSignIn ? 'show_sign_in' : state.state === 'navigation' ? state.action : undefined;
      const fieldKey=`${state.documentId}:${state.state}`;
      if (fieldKey!==fieldDocument) {fieldDeadline=0;fieldDocument=fieldKey;}
      const creating = state.state === 'create_account';
      if ((state.state === 'sign_in' && !attempted) || (creating && preferCreate && !creationAttempted)) {
        fieldDeadline ||= Date.now() + 5000;
        if (!state.ready) {
          if (Date.now() >= fieldDeadline) throw new ApplicationPause(blocked.fields_not_ready!);
        } else {
          if (!options.credentials?.email || !options.credentials.password) throw new ApplicationPause('Add account credentials, then retry this job.');
          if (creating && state.consentRequired) {
            if (!options.acceptCreationTerms) throw new ApplicationPause(blocked.consent!);
            record('creation_terms_attempted');
            const consent = await command({operation:'accept_creation_terms',...document});
            check(consent);
            if (!consent.verified) throw new ApplicationPause(blocked.consent!);
          }
          record(creating ? 'creation_fields_started' : 'sign_in_fields_started');
          const accountMode = creating ? 'create' : 'sign_in';
          const fields: ('email'|'password'|'confirm')[] = creating ? ['email','password','confirm'] : ['email','password'];
          const waitForReady = async (readiness: 'ready'|'clickReady') => {
            const readyDeadline = Date.now() + 5000;
            for (;;) {
              // Every retry remains pinned to the original document; no field or click is repeated.
              const observed = await command({ operation: 'inspect', ...document });
              check(observed);
              if (observed.documentId && observed.documentId !== document.documentId || observed.url && observed.url !== document.expectedUrl) {
                throw new ApplicationPause('The account document changed. Inspect the tab before retrying.');
              }
              const conflicts = observed.observation?.conflicts?.length > 0;
              if (conflicts || observed.state !== state.state && observed.state !== 'loading') {
                const detail = conflicts ? 'conflicting account states' : observed.observation?.signals?.includes('unrecognized_account_alert')
                  ? 'an unrecognized account alert' : String(observed.state).replaceAll('_', ' ');
                throw new ApplicationPause(`The account page now shows ${detail}. Inspect the tab before retrying.`);
              }
              if (observed.state === state.state && observed[readiness]) return;
              if (Date.now() >= readyDeadline) throw new ApplicationPause(observed.state === 'loading'
                ? 'The account page is still loading. C3 has not clicked Sign In; inspect the tab before retrying.' : blocked.fields_not_ready!);
              await delay(100, undefined, { signal });
            }
          };
          for (const field of fields) {
            await waitForReady('ready');
            const result = await command({ operation: 'fill', ...document, accountMode, field, value: options.credentials[field==='confirm'?'password':field] });
            check(result);
            if (result.state !== 'filled' || !result.verified) { record('sign_in_fields_failed'); throw new ApplicationPause('The sign-in field did not retain its value. Inspect the tab before retrying.'); }
            record('sign_in_diagnostic', `submit_script_${field}_verified`);
          }
          await waitForReady('clickReady');
          signal.throwIfAborted();
          record(creating ? 'creation_attempted' : 'sign_in_attempted');
          if (creating) { creationAttempted = true; creationSince = Date.now(); } else attempted = true;
          const clicked = await command({ operation: 'click', ...document, accountMode, email: options.credentials.email, password: options.credentials.password });
          check(clicked);
          if (clicked.state !== 'clicked') throw new ApplicationPause('Sign-in was not confirmed. Inspect the tab before retrying.');
          if (creating) preferCreate = false;
          else signInClickConfirmed = true;
          record('sign_in_diagnostic', 'submit_script_click_succeeded');
          if (clicked.submitEvent === true) record('sign_in_diagnostic', 'submit_dom_event_observed');
          if (clicked.invalidEvent === true) record('sign_in_diagnostic', 'submit_dom_validation_blocked');
        }
      } else if (action && (!attempted || action === 'continue_application')) {
        // Workday can reuse one document for entry and the return from registration.
        const returningToSignIn = action === 'show_sign_in' && creationAttempted;
        const key = JSON.stringify([state.documentId, state.url, action, returningToSignIn]);
        const clickedAt = navigation.get(key);
        if (clickedAt !== undefined) {
          if (Date.now() - clickedAt >= 30_000) throw new ApplicationPause('The employer did not advance after opening sign-in. Inspect the tab before retrying.');
          await delay(250, undefined, {signal});
          continue;
        }
        navigation.set(key, Date.now());
        // A notice left by an earlier session identifies the sign-in route, not which email was used.
        if (state.state === 'account_exists' && creationAttempted) record('account_exists');
        const navigated = await command({ operation: 'navigate', ...document, action, preferCreate });
        if (await recoverLateSignIn(navigated)) {applicationOpened(); return;}
        check(navigated);
      }
      await delay(500, undefined, { signal });
    }
    const pageState = latestObservation ? `The last observed employer state was ${latestObservation.kind.replaceAll('_',' ')}.` : 'The employer page did not settle.';
    const accountAction = attempted || creationAttempted
      ? 'A sign-in or registration was attempted. Inspect the tab before retrying.'
      : 'C3 did not attempt sign-in or registration during this run. Inspect the tab before retrying.';
    throw new ApplicationPause(`Account access is unconfirmed. ${pageState} ${accountAction}`);
  } catch (error) {
    if ((attempted || creationAttempted) && !authenticated && !rejected) record(creationAttempted && !attempted ? 'creation_uncertain' : 'sign_in_uncertain');
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (opened) await call('workdayAccount', { ...base, operation: 'end' }).catch(() => {});
  }
}
