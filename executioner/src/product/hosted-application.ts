import { applicationAttachmentControls } from '../../extension/page-adapters/document.js';
import { observeFormDocument } from '../../extension/form-page.js';
import { createHash } from 'node:crypto';
import { preserveAshbyChoices, searchLeverLocation, verifyAshbyAutocomplete } from './hosted-autocomplete.ts';
import { inspectHostedFields } from './hosted-field-observation.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { disposeResumeArtifact } from '../contracts/index.ts';
import { createPageAnswerPlanner, matchLocationOption, type PageQuestion } from './page-answer-planner.ts';
import { isRecruitmentTermsConsent, protectedQuestionCategory } from '../form/questions/protected.ts';
import type { ApplicationFieldObservation } from '../form/answers/application-types.ts';
import { effectiveProfileFacts, productSources } from './sources.ts';
import { resolveQuestion } from '../form/questions/catalog.ts';
import { applicationTarget } from './target.ts';
import { ApplicationPause, AttachmentPreviewUnavailable, type ProductInput, type ResumeUploadReceipt } from './application-contract.ts';
import { hasHostedResume, prepareHostedResume, verifyHostedAttachments } from './uploads/hosted.ts';
import { createMatchingBacklog, type MatchingObservation } from './matching-backlog.ts';

export { inspectHostedFields };

const submitName = /^(submit application|submit|send application|envoyer la candidature)$/i;

// A numeric-only display loses the currency and period, even when the amount survives.
function displaysSavedSalary(label: string, displayed: string, saved: unknown): boolean {
  if (!/^(?:salary expectations?|desired salary)\s*[?*]?$/i.test(label.trim()) || typeof saved !== 'string') return false;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(displayed)) return false;
  const amount = /^(?:CAD|USD)\s*\$?\s*(\d+|\d{1,3}(?:,\d{3})+)\s+per (?:year|hour)$/i.exec(saved.trim());
  return amount?.[1]?.replaceAll(',', '') === displayed.replaceAll(',', '');
}
/** Hosted routes require a current application form, not merely an email input at an /apply URL. */
export async function observeHostedPage(page: Page) {
  return page.evaluate(observeFormDocument, applicationAttachmentControls);
}

function requireHostedApplication(observation: Awaited<ReturnType<typeof observeHostedPage>>) {
  if (observation.kind !== 'application') throw new ApplicationPause(observation.kind === 'security_challenge'
    ? 'The employer shows a security challenge. Complete it in the selected tab, then retry.'
    : observation.kind === 'loading' ? 'The employer form is still loading. The draft is preserved; inspect the tab before retrying.'
    : 'The current page is not an identified application form. Inspect the selected tab; C3 has not inferred a form from its URL.');
}

export async function hostedReviewDigest(page: Page, expectedResumeSha256?: string): Promise<string> {
  return (await hostedReviewSnapshot(page, expectedResumeSha256)).digest;
}

export async function hostedReviewSnapshot(page: Page, expectedResumeSha256?: string, resumeExpected?: boolean, resumeUpload?: ResumeUploadReceipt): Promise<{ digest: string; resumeExpected: boolean }> {
  requireHostedApplication(await observeHostedPage(page));
  const fields = await inspectHostedFields(page);
  const submit = page.getByRole('button', { name: submitName });
  if (!fields.length || await submit.count() !== 1 || !await submit.isVisible() || !await submit.isEnabled()) throw new ApplicationPause('The application is not ready for review.');
  const upload = await verifyHostedAttachments(page, fields, resumeExpected, resumeUpload, expectedResumeSha256);
  for (const f of fields) {
    const filled = f.kind === 'file' ? upload.filledKeys.has(f.key) : f.kind === 'checkbox' || f.kind === 'radio' ? f.checked : !!f.value.trim();
    if (f.required && !filled || !f.valid) throw new ApplicationPause('Required or invalid fields remain. Inspect the application.');
  }
  const invalidProxy = await page.locator('input[aria-hidden=true][required]').evaluateAll(es=>es.some(raw=>{const e=raw as HTMLInputElement;return !e.disabled && !e.validity.valid && e.closest('[class*=select],[data-input-type=select]')?.getClientRects().length}));
  if(invalidProxy)throw new ApplicationPause('A required dropdown has not committed its backing value.');
  if (await page.locator('[aria-invalid=true]:visible,[role=alert]:visible').filter({hasText:/required|invalid|error|failed/i}).count()) throw new ApplicationPause('The employer is showing a validation error.');
  const backing = await page.locator('input[type=hidden],select').evaluateAll(es=>es.map(raw=>{const e=raw as HTMLInputElement|HTMLSelectElement;return {name:e.name,value:e instanceof HTMLSelectElement?[...e.selectedOptions].map(o=>o.value):e.value}}));
  const digest = createHash('sha256').update(page.url()).update(JSON.stringify(backing)).update(JSON.stringify(upload.attachments)).update(JSON.stringify(upload.receipt)).update(JSON.stringify(fields.map(f => ({key:f.key,label:f.label,value:f.value,checked:f.checked,files:f.files,required:f.required})))).digest('hex');
  return { digest, resumeExpected: upload.resumeExpected };
}

export async function fillHostedApplication(page: Page, input: ProductInput, signal: AbortSignal, progress: (stage: string) => void) {
  const target = applicationTarget(input.url);
  const assertTarget = () => { signal.throwIfAborted(); if (applicationTarget(page.url()).key !== target.key) throw new ApplicationPause('The tab moved to a different job.'); };
  assertTarget();
  if (target.ats === 'lever' && !/\/apply\/?$/.test(new URL(page.url()).pathname)) await page.goto(target.url.replace(/\/$/,'')+'/apply', {waitUntil:'domcontentloaded'});
  if (target.ats === 'ashby' && !/\/application\/?$/.test(new URL(page.url()).pathname)) await page.goto(target.url.replace(/\/$/,'')+'/application', {waitUntil:'domcontentloaded'});
  if(target.ats==='workable'&&!/\/apply\/?$/.test(new URL(page.url()).pathname))await page.goto(target.url.replace(/\/$/,'')+'/apply/',{waitUntil:'domcontentloaded'});
  if(target.ats==='workable'){const decline=page.getByRole('button',{name:'Decline all',exact:true});if(await decline.isVisible().catch(()=>false))await decline.click();}
  const readyDeadline=Date.now()+30_000;
  let observation=await observeHostedPage(page);
  while (observation.kind !== 'application' && Date.now()<readyDeadline) {
    assertTarget();
    if (observation.kind === 'security_challenge' || observation.signals.includes('account_or_code_control')) requireHostedApplication(observation);
    await page.waitForTimeout(250);
    observation=await observeHostedPage(page);
  }
  requireHostedApplication(observation);
  const sources = productSources(input.profile, input.resume);
  const facts = effectiveProfileFacts(input.profile);
  const matching=createMatchingBacklog(input.learningRoot,input.url,facts,'C3.1',sources.profileQuery.ownerDefaults);
  let pendingMatch:MatchingObservation|undefined;
  const resumeSha256 = createHash('sha256').update(input.resume).digest('hex');
  let resumeExpected = input.resumeExpected;
  let resumeUpload=input.resumeUpload;
  let pendingPreview: {error: AttachmentPreviewUnavailable; documentKey: string} | undefined;
  const history: {label:string;kind:string;required:boolean;options:string[];result:string;question:ReturnType<typeof resolveQuestion>;answerKind?:string;lane?:string}[] = [];
  const postingEmployer = target.ats === 'ashby' ? await page.locator('script[type="application/ld+json"]').evaluateAll((scripts, id) => {
    const names = new Set<string>();
    for (const script of scripts) {
      try {
        const job = JSON.parse(script.textContent ?? '');
        if (job?.['@type'] === 'JobPosting' && job.identifier?.value === id &&
            job.hiringOrganization?.['@type'] === 'Organization' && typeof job.hiringOrganization.name === 'string' &&
            job.hiringOrganization.name.trim()) names.add(job.hiringOrganization.name.trim());
      } catch { /* Other structured data does not identify this posting. */ }
    }
    return names.size === 1 ? [...names][0] : undefined;
  }, target.posting.split('/')[1]) : undefined;
  const planAnswer = createPageAnswerPlanner(sources, facts, matching.company, postingEmployer);
  const fact = (id: string) => facts.find(f => f.factId === id)?.value;
  const known = new Map<string,string>();
  const cookieDialog=page.getByRole('dialog',{name:'Cookie Consent',exact:true});
  try {
    if(target.ats==='workable')await page.addLocatorHandler(cookieDialog,async dialog=>{await dialog.getByRole('button',{name:'Decline all',exact:true}).click();});
    let lastState='',unchanged=0;
    for (let pass = 0; pass < 32; pass++) {
      assertTarget();
      const pageObservation=await observeHostedPage(page);
      if(input.learningRoot) {mkdirSync(input.learningRoot,{recursive:true});writeFileSync(join(input.learningRoot,'page-observation.json'),JSON.stringify(pageObservation));}
      requireHostedApplication(pageObservation);
      if (pendingPreview && pendingPreview.documentKey !== pageObservation.documentKey) throw pendingPreview.error;
      progress('Filling application');
      const fields = (await inspectHostedFields(page)).sort((a,b)=>Number(b.kind==='file')-Number(a.kind==='file'));
      if (target.ats === 'ashby') await preserveAshbyChoices(page, fields);
      if (!resumeExpected && await hasHostedResume(page, fields)) {
        input.onResumeObserved?.();
        resumeExpected = true;
      }
      const state=JSON.stringify(fields);unchanged=state===lastState?unchanged+1:0;lastState=state;
      if(unchanged>2)throw new ApplicationPause('The application is not making progress.');
      let changed = false;
      for (const snapshotField of fields) {
        let f = snapshotField;
        assertTarget();
        if (!f.label) { if(f.required) throw new ApplicationPause('A required field has no readable question label.'); continue; }
        const identity = JSON.stringify([f.key,f.label,f.kind,f.required,f.options]);
        if (known.has(identity)) {
          const previous=known.get(identity);
          if(previous==='optional'||previous==='unanswered'&&!f.value||previous===`existing:${f.value}`||previous==='file'&&f.files>0||String(f.kind==='checkbox'?f.checked:f.value)===previous)continue;
          known.delete(identity);
        }
        const loc = page.locator(`[data-c3-hosted="${f.key}"]`);
        const currentFields = await inspectHostedFields(page);
        const current = currentFields.find(x => x.key === f.key);
        if (!current || current.label !== f.label || current.kind !== f.kind) { changed = true; break; }
        f = current;
        if (pendingPreview && f.required && f.kind !== 'file') {
          const freshPage = await observeHostedPage(page);
          requireHostedApplication(freshPage);
          if (freshPage.documentKey !== pendingPreview.documentKey) throw pendingPreview.error;
        }
        const matchObservation:MatchingObservation={pageId:page.url(),fieldId:f.key,question:f.label,control:f.kind,
          options:f.options,required:f.required,outcome:'observed',constraints:{inputType:f.inputType,
            min:f.min,max:f.max,step:f.step,minLength:f.minLength,maxLength:f.maxLength,pattern:f.pattern,readOnly:f.readOnly}};
        matching.record(matchObservation);
        if (protectedQuestionCategory(f.label, undefined, f.options) === 'consent' && !isRecruitmentTermsConsent(f.label)) {
          const answered = f.kind==='checkbox' ? f.checked : !!f.value.trim();
          if(answered || !f.required){known.set(identity,answered?'existing':'optional');continue;}
          throw new ApplicationPause('This application requires a consent decision. Choose it yourself on the employer page, then retry.');
        }
        if (!f.required) { known.set(identity,'optional'); continue; }
        if (f.buttonConflict) throw new ApplicationPause('The employer shows an inconsistent choice. Inspect it before retrying.');
        if (f.kind === 'file') {
          if (pendingPreview) continue;
          try {
            const upload = await prepareHostedResume(page, loc, f, input.resume, resumeSha256, resumeUpload, receipt => {
              resumeUpload = receipt;
              input.onResumeUpload?.(receipt);
            });
            known.set(identity, 'file');
            if (upload === 'existing') continue;
          } catch (error) {
            if (!(error instanceof AttachmentPreviewUnavailable)) throw error;
            pendingPreview = {error, documentKey:pageObservation.documentKey};
          }
          // Upload parsers can remount other controls. Start with a fresh page observation.
          changed = true;
          break;
        }
        if (f.valid && f.value && (f.kind === 'combobox' || f.kind === 'location' && await loc.evaluate(e =>
          location.hostname === 'jobs.lever.co' && e.matches('#location-input.location-input[name=location]')))) {
          matching.record({...matchObservation, observedAnswer:f.value, provisional:true, outcome:'unconfirmed', reason:'existing_selection_preserved'});
          known.set(identity, `existing:${f.value}`);
          continue;
        }
        if (f.kind === 'location' || f.kind === 'combobox' && (/location.*city|^(?:current )?location$/i.test(f.label) || await loc.evaluate(e=>e.closest('[data-field-path="_systemfield_location"]')!==null))) {
          const city = fact('city');
          if (typeof city !== 'string') throw new ApplicationPause('Add your location to the profile.');
          let searchText = city;
          const leverSearch = target.host === 'jobs.lever.co' && await loc.evaluate(e => e.matches('#location-input.location-input[name=location]'));
          const leverReady = !leverSearch || await searchLeverLocation(loc, city);
          if (!leverSearch) { await loc.fill(''); if(target.ats==='lever')await loc.pressSequentially(city,{delay:30});else await loc.fill(city); }
          const choiceOwner = await loc.getAttribute('aria-controls');
          const choices = leverSearch ? loc.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " application-field ")][1]').locator('.dropdown-results > div.dropdown-location:visible:not(:has(button,a[href],input,select,textarea))')
            : f.kind === 'location' ? page.locator('.dropdown-results .dropdown-location:visible')
            : choiceOwner ? page.locator(`[id=${JSON.stringify(choiceOwner)}] [role=option]:visible`)
            : page.locator('[role=listbox]:visible [role=option]:visible');
          try {
            if (!leverReady) throw new ApplicationPause('The employer did not return fresh location suggestions.');
            await choices.first().waitFor({state:'visible',timeout:10000});
          }
          catch {
            const qualified=[city,fact('region'),fact('country')].filter(value=>typeof value==='string'&&value.trim()).join(', ');
            if(qualified===city)throw new ApplicationPause('The employer did not return location suggestions. Choose your location on the employer page, then retry.');
            searchText = qualified;
            if (leverSearch) {
              if (!await searchLeverLocation(loc, qualified)) throw new ApplicationPause('The employer did not return fresh location suggestions.');
            }
            else { await loc.fill('');await loc.pressSequentially(qualified,{delay:30}); }
            try { await choices.first().waitFor({state:'visible',timeout:10000}); }
            catch { throw new ApplicationPause('The employer did not return location suggestions. Choose your location on the employer page, then retry.'); }
          }
          const labels = await choices.allTextContents();
          const exact = matchLocationOption(labels, city, fact('region'), fact('country'));
          const index = exact >= 0 ? exact : sources.profilePlan.mode === 'synthetic_test_non_submittable' ? 0 : -1;
          if(index<0)throw new ApplicationPause('Choose the exact location from the employer suggestions.');
          const expected=labels[index]!.trim();
          const ownedChoice=async()=>{
            const owner=await loc.getAttribute('aria-controls');
            if (owner !== choiceOwner) throw new ApplicationPause('The location menu changed. Inspect the selected location before retrying.');
            const options=owner?page.locator(`[id=${JSON.stringify(owner)}] [role=option]:visible`):choices;
            return options.filter({hasText:new RegExp('^'+expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')});
          };
          try {
            const choice = await ownedChoice();
            const target = await choice.elementHandle({timeout:3000});
            if (!target) throw new ApplicationPause('The location menu changed.');
            try {
              const placement = await target.evaluate((option, {key, owner, labels, expected, index, exact, searchText, locationWidget}) => {
                const hit = () => {
                  const box = option.getBoundingClientRect();
                  return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                };
                const obstruction = hit();
                const intercepted = !!obstruction && !option.contains(obstruction);
                if (!locationWidget && !owner && !intercepted) return 'unchanged';
                const inputs = document.querySelectorAll<HTMLInputElement>('[data-c3-hosted="' + CSS.escape(key) + '"]');
                const input = inputs[0];
                if (inputs.length !== 1 || !input || labels.filter(label => label.trim() === expected).length !== 1) return 'changed';
                const field = input.closest('.application-field');
                const menus = () => owner ? document.querySelectorAll('[id="' + CSS.escape(owner) + '"]') : field?.querySelectorAll('.dropdown-results');
                const menu = menus()?.[0];
                const owned = () => {
                  const currentMenus = menus();
                  if (!menu || !input.isConnected || !option.isConnected || !menu.contains(option) ||
                      currentMenus?.length !== 1 || currentMenus[0] !== menu || input.getAttribute('aria-controls') !== owner || input.value !== searchText ||
                      (!owner && (input.closest('.application-field') !== field || field?.querySelectorAll('#location-input').length !== 1 || input.id !== 'location-input'))) return false;
                  const options = [...menu.querySelectorAll(owner ? '[role=option]' : '.dropdown-location')].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
                  return options.length === labels.length && options[index] === option && options.every((node,i) => node.textContent === labels[i]);
                };
                if (!owned()) return 'changed';
                if (!intercepted) return 'unchanged';
                if (exact < 0 || obstruction.closest('dialog,[role=dialog],[aria-modal=true]')) return 'blocked';
                let header: Element | null = obstruction;
                while (header) {
                  const box = header.getBoundingClientRect();
                  const namedHeader = header.matches('header,[role=banner]') || [...header.classList].some(name => /(?:^|[-_])header(?:$|[-_])/i.test(name));
                  if (namedHeader && box.top <= 1 && box.bottom > 0 && box.bottom < innerHeight &&
                      ['fixed','sticky'].includes(getComputedStyle(header).position)) break;
                  header = header.parentElement;
                }
                if (!header) return 'blocked';
                option.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
                if (!owned()) return 'changed';
                return option.contains(hit()) ? 'centered' : 'blocked';
              }, {key:f.key, owner:choiceOwner, labels, expected, index, exact, searchText, locationWidget:f.kind==='location'});
              if (placement === 'changed') throw new ApplicationPause('The location menu changed. Inspect the selected location before retrying.');
              if (placement === 'blocked') throw new Error('Another element intercepts pointer events on the location choice.');
              assertTarget();
              if (leverSearch) {
                if (exact < 0 || await loc.inputValue() !== searchText || await choice.count() !== 1) throw new ApplicationPause('The location choice changed.');
                await choice.click({timeout:10000});
              } else await target.click({timeout:3000});
            } finally { await target.dispose(); }
          }
          catch(error) {
            const detail = error instanceof Error ? error.message : '';
            const result = /intercepts pointer events/i.test(detail) ? 'location_click_intercepted'
              : /strict mode violation/i.test(detail) ? 'location_click_ambiguous'
              : /detached|not attached/i.test(detail) ? 'location_click_detached'
              : /not stable/i.test(detail) ? 'location_click_unstable'
              : /not visible/i.test(detail) ? 'location_click_hidden'
              : error instanceof Error && error.name === 'TimeoutError' ? 'location_click_timeout'
              : 'location_click_failed';
            history.push({label:f.label,kind:f.kind,required:f.required,options:[],question:resolveQuestion(f.label),result});
            // Ashby can restore focus to the prior country control after opening this menu.
            if(target.ats!=='ashby' || await loc.evaluate(e=>e===document.activeElement) || await loc.inputValue()!=='' || await choices.count()>0) {
              throw new ApplicationPause('Timeout or control change while selecting the location. Choose the exact location on the employer page, then retry.');
            }
            await loc.fill(expected);
            await choices.first().waitFor({state:'visible',timeout:10000});
            if(!await loc.evaluate(e=>e===document.activeElement))throw error;
            await (await ownedChoice()).click({timeout:3000});
          }
          await loc.blur();
          if (target.ats === 'ashby') await verifyAshbyAutocomplete(loc, expected);
          if((await inspectHostedFields(page)).find(x=>x.key===f.key)?.value!==expected)throw new ApplicationPause('The location selection did not persist.');
          if(f.kind==='location' && !await page.locator('#selected-location').inputValue())throw new ApplicationPause('Location backing value is missing.');
          known.set(identity,expected);changed=true;continue;
        }
        let options = f.options;
        let popup: ReturnType<Page['locator']> | undefined;
        if (f.kind === 'combobox') {
          await loc.click();
          if(target.ats==='ashby' && await loc.evaluate(e=>e.classList.contains('ashby-application-form-input-autocomplete')) && await loc.getAttribute('aria-expanded')==='false') {
            const toggle=loc.locator('..').locator('button');
            if(await toggle.count()!==1)throw new ApplicationPause('The dropdown opener is ambiguous.');
            await toggle.click();
          }
          const owner = await loc.getAttribute('aria-controls');
          const menus=owner ? page.locator(`[id=${JSON.stringify(owner)}]`) : page.locator('[role=listbox]:visible');
          if(await menus.count()>1)throw new ApplicationPause('The dropdown does not identify one option menu.');
          popup = menus.locator('[role=option]:not([aria-disabled=true])');
          await popup.first().waitFor({state:'visible',timeout:5000}).catch(()=>{});
          if(await menus.count()>1)throw new ApplicationPause('The dropdown does not identify one option menu.');
          options = (await popup.allTextContents()).map(x=>x.trim()).filter(Boolean);
          if (!options.length) {
            await loc.press('Escape');
            if (f.value && f.valid) { known.set(identity,`existing:${f.value}`); continue; }
            if (!f.required) { known.set(identity,'optional'); continue; }
            throw new ApplicationPause('A required dropdown did not expose its choices.');
          }
        }
        const behavior = f.kind==='date'?'date':f.kind==='radio'?'radio':f.kind === 'buttons' || f.kind === 'combobox' || f.kind==='multicheck' ? 'listbox' : f.kind === 'checkbox' ? 'checkbox' : f.kind === 'textarea' ? 'textarea' : f.kind === 'select' ? 'select' : 'text';
        const constraints: ApplicationFieldObservation['constraints'] = behavior==='text'||behavior==='textarea'?{inputType:/\b(?:url|website|linkedin(?: profile)?)\b/i.test(f.label)&&f.inputType==='text'?'url':['email','url','number'].includes(f.inputType)?f.inputType as 'email'|'url'|'number':'text',min:Number.isFinite(f.min)?f.min:null,max:Number.isFinite(f.max)?f.max:null,step:Number.isFinite(f.step)?f.step:null,minLength:f.minLength>=0?f.minLength:null,maxLength:f.maxLength>=0?f.maxLength:null,pattern:f.pattern||null,readOnly:f.readOnly}:undefined;
        const observation: PageQuestion = {
          ...matchObservation, formId: f.formId, options, control: behavior, constraints,
          ...(f.kind === 'multicheck' ? {widget: 'multi-checkbox'} : {}),
          state: (f.kind === 'checkbox' ? f.checked : Boolean(f.value)) ? 'populated' : 'empty',
          signature: identity, selected: f.kind === 'checkbox' ? f.checked : f.value, valid: f.valid,
        };
        matching.record(observation);
        const peers = currentFields.map(field => ({question: field.label, selected: field.value, formId: field.formId}));
        const plan = await planAnswer(observation, peers, signal);
        const expected = plan.answer ?? (f.kind === 'combobox' ? plan.query : undefined) ?? null;
        history.push({label:f.label,kind:f.kind,required:f.required,options,question:resolveQuestion(f.label),
          answerKind:plan.answerKind,lane:plan.lane,result:expected === null ? plan.reason : 'resolved'});
        if (expected === null) {
          if (f.kind === 'combobox') await loc.press('Escape');
          known.set(identity, f.value && f.valid ? `existing:${f.value}` : 'unanswered');
          continue;
        }
        pendingMatch = {...matchObservation, options, chosenAnswer: expected, provisional: plan.provisional,
          outcome: 'attempted', reason: plan.reason};
        const salary = f.kind === 'text' && expected === fact('salary_expectations') ? expected : undefined;
        if (f.valid && displaysSavedSalary(f.label, f.value, salary)) {
          matching.record({...pendingMatch, observedAnswer:f.value, provisional:true, outcome:'unconfirmed', reason:'salary_units_need_review'});
          pendingMatch=undefined;
          known.set(identity, `existing:${f.value}`);
          continue;
        }
        if (f.valid && ((f.kind === 'checkbox' && f.checked === expected) ||
          (f.kind !== 'checkbox' && f.kind !== 'combobox' && f.value === expected))) {
          matching.record({...pendingMatch,outcome:'verified',reason:'existing_value_confirmed'});pendingMatch=undefined;
          known.set(identity,String(expected)); continue;
        }
        if (f.kind === 'multicheck' && f.value && f.value !== expected) {
          throw new ApplicationPause('This selection differs from your saved answer. Review the checked choices before retrying.');
        }
        matching.record(pendingMatch);
        if(f.kind==='radio') {const radios=page.locator(`input[type=radio][name=${JSON.stringify(f.name)}]`);const index=options.indexOf(String(expected));if(index<0||options.lastIndexOf(String(expected))!==index)throw new ApplicationPause('Radio choice is ambiguous.');const radio=radios.nth(index);if(await radio.getAttribute('aria-hidden')==='true')await radio.locator('xpath=ancestor::label[1]').click();else await radio.check();if(!await radios.nth(index).evaluate((e:HTMLInputElement)=>e.closest('[role=radio]')?e.closest('[role=radio]')!.getAttribute('aria-checked')==='true':e.checked))throw new ApplicationPause('The radio answer did not persist.');}
        else if(f.kind==='multicheck'){const index=options.indexOf(String(expected));if(index<0)throw new ApplicationPause('Checkbox group answer is missing.');const boxes=loc.locator('input[type=checkbox]');const box=boxes.nth(index);if(await box.getAttribute('aria-hidden')==='true')await box.locator('xpath=ancestor::*[@role="checkbox"][1]').click();else await box.setChecked(true);if(!await box.evaluate((e:HTMLInputElement)=>e.closest('[role=checkbox]')?e.closest('[role=checkbox]')!.getAttribute('aria-checked')==='true':e.checked))throw new ApplicationPause('Checkbox group answer did not persist.');}
        else if(f.kind==='buttons') { await loc.getByRole('button',{name:String(expected),exact:true}).click(); if((await inspectHostedFields(page)).find(field=>field.key===f.key && field.label===f.label)?.value!==expected)throw new ApplicationPause('The selected answer did not persist.'); }
        else if(f.kind==='select') { await loc.selectOption({label:String(expected)}); if(await loc.locator('option:checked').textContent()!==expected)throw new ApplicationPause('The selected answer did not persist.'); }
        else if(f.kind==='combobox') { const choice=popup!.filter({hasText:new RegExp('^'+String(expected).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')});if(await choice.count()!==1)throw new ApplicationPause('Dropdown choice is ambiguous.');await choice.click();await loc.blur();if(target.ats==='ashby')await verifyAshbyAutocomplete(loc,String(expected));const after=(await inspectHostedFields(page)).find(x=>x.key===f.key);if(after?.value!==expected){await loc.click();const selected=popup!.locator('xpath=self::*[@aria-selected="true"]');if(await selected.count()!==1||(await selected.innerText()).trim()!==expected)throw new ApplicationPause('The selected dropdown answer could not be verified.');await loc.press('Escape');await loc.blur();} }
        else if(f.kind==='checkbox') { await loc.setChecked(expected===true);if(await loc.isChecked()!==(expected===true))throw new ApplicationPause('The checkbox answer did not persist.'); }
        else if(f.kind==='date' && f.inputType==='date') {await loc.fill(String(expected));await loc.blur();if(await loc.inputValue()!==expected)throw new ApplicationPause('The selected date did not persist.');}
        else if(f.kind==='date') {const [year,month,day]=String(expected).split('-');const display=`${month}/${day}/${year}`;await loc.fill('');await loc.pressSequentially(`${month}${day}${year}`);await loc.blur();if(await loc.inputValue()!==display)throw new ApplicationPause('The selected date did not persist.');}
        else {
          await loc.fill(String(expected));
          await loc.blur();
          const readback = await loc.inputValue();
          if (displaysSavedSalary(f.label, readback, salary)) {
            const current = (await inspectHostedFields(page)).find(field=>field.key===f.key && field.label===f.label && field.kind===f.kind);
            if (!current?.valid || current.value!==readback) throw new ApplicationPause('The salary amount did not persist.');
            matching.record({...pendingMatch, observedAnswer:readback, provisional:true, outcome:'unconfirmed', reason:'salary_units_need_review'});
            pendingMatch=undefined;
            known.set(identity,`existing:${readback}`);
            changed=true;
            continue;
          }
          const same = readback===String(expected) || (/phone/i.test(f.label) && readback.replace(/\D/g,'')===String(expected).replace(/\D/g,''));
          if (!same) throw new ApplicationPause('The text answer did not persist.');
        }
        const committed=(await inspectHostedFields(page)).find(x=>x.key===f.key&&x.label===f.label);
        matching.record({...pendingMatch,outcome:'verified',reason:'product_readback_confirmed'});pendingMatch=undefined;
        known.set(identity,String(f.kind==='checkbox'?committed?.checked:committed?.value??expected)); changed = true;
      }
      if (!changed && pendingPreview) throw pendingPreview.error;
      if (!changed) {assertTarget();progress('Verifying application');const snapshot=await hostedReviewSnapshot(page,resumeSha256,resumeExpected,resumeUpload);const digest=snapshot.digest;await page.waitForTimeout(500);assertTarget();if((await hostedReviewSnapshot(page,resumeSha256,resumeExpected,resumeUpload)).digest!==digest)continue;return {reviewDigest:digest,resumeExpected:snapshot.resumeExpected,completedPages:1,needsOwnerReview:matching.needsReview||history.some(answer=>answer.lane==='synthetic_test_default')||[...known.values()].some(value=>['optional','unanswered','existing'].includes(value)||value.startsWith('existing:'))};}
      await page.waitForTimeout(300);
    }
    throw new ApplicationPause('The form kept changing. Inspect the remaining fields.');
  } catch(error) {
    if(pendingMatch)matching.record({...pendingMatch,outcome:'unconfirmed',reason:'fill_not_confirmed'});
    throw error;
  } finally {
    if(target.ats==='workable')await page.removeLocatorHandler(cookieDialog).catch(()=>{});
    disposeResumeArtifact(sources.resumeIntent.artifact);
    if(input.learningRoot){mkdirSync(input.learningRoot,{recursive:true});writeFileSync(join(input.learningRoot,'hosted-questions.json'),JSON.stringify({ats:target.ats,questions:history},null,2));}
  }
}
