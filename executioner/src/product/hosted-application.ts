import { createHash } from 'node:crypto';
import { annotateQuestionContext } from '../../extension/question-context.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { boundedText, browserTargetToken, fieldId, optionId, disposeResumeArtifact } from '../contracts/index.ts';
import { createApplicationAnswerResolver, provisionalUnboundedFieldAnswer } from '../form/answers/resolver.ts';
import { isRecruitmentTermsConsent } from '../ats/workday/application/questions/protected.ts';
import type { ApplicationFieldObservation } from '../form/answers/application-types.ts';
import { effectiveProfileFacts, productSources } from './sources.ts';
import { resolveQuestion } from '../form/questions/catalog.ts';
import { normalizeCatalogText } from '../form/questions/normalize.ts';
import { profileFieldValue } from './profile-field.ts';
import { canonicalCanadianRegion } from '../composition/private/s2-derived-profile-country.ts';
import { applicationTarget } from './target.ts';
import { ApplicationPause, type ProductInput, type ResumeUploadReceipt } from './engine.ts';
import { uploadGreenhouseResume, verifiedGreenhouseResume } from './greenhouse-resume.ts';
import { uploadWorkableResume, verifiedWorkableResume } from './workable-resume.ts';
import { selectClientResume, verifiedClientResume } from './client-resume.ts';
import { createMatchingBacklog, matchingContext, type MatchingObservation } from './matching-backlog.ts';

const controls = 'input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea,.ashby-application-form-input-yesno,[role=group][data-ui]:has(input[type=checkbox]),.application-field:has(>ul[data-qa=checkboxes])';
const submitName = /^(submit application|submit|send application|envoyer la candidature)$/i;
const handsOnCloudQuestion = normalizeCatalogText('Do you have any hands-on experience with Kubernetes, Docker, or cloud platforms (e.g., AWS, Azure, GCP)?');
const northAmericanLocationQuestion = normalizeCatalogText('This role requires employees to be based in the United States or Canada. Are you currently located in the U.S. or Canada?');
const averageGpaQuestion = normalizeCatalogText('What is your average GPA?');

/** Hosted routes require a current application form, not merely an email input at an /apply URL. */
export async function observeHostedPage(page: Page) {
  return page.evaluate(() => {
    const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden],[inert],[aria-hidden="true"]');
    const all = (selector: string) => [...document.querySelectorAll(selector)].filter(visible);
    const email = all('input[type=email],input[name=email],input[id=email]');
    const submit = all('button,input[type=submit]').filter(e => /^(submit application|submit|send application|envoyer la candidature)$/i.test(
      e.getAttribute('aria-label') || (e instanceof HTMLInputElement ? e.value : e.textContent?.trim()) || ''));
    const passwords = all('input[type=password],input[autocomplete=one-time-code]');
    const challenge = all('[role=dialog] iframe[title="hCaptcha"],[role=dialog] iframe[title="reCAPTCHA"]');
    const loading = document.readyState === 'loading' || all('form[aria-busy=true],[role=form][aria-busy=true]').length > 0;
    const owners=new Set(email.map(e=>e.closest('form,[role=form]') ?? document.body));
    const sameForm = email.length > 0 && submit.length === 1 && owners.size === 1 && owners.has(submit[0]!.closest('form,[role=form]') ?? document.body);
    const applicationSubmit=submit.length===1 && /application|candidature/i.test(submit[0]!.getAttribute('aria-label') || submit[0]!.textContent || (submit[0] as HTMLInputElement).value || '');
    const identity = all('input:not([type=hidden]):not([type=email]):not([type=password])').some(e => /name|firstname|lastname/i.test([e.getAttribute('name'),e.id,...(e instanceof HTMLInputElement ? [...e.labels??[]].map(label=>label.textContent) : [])].join(' ')));
    const attachment = document.querySelector('input[type=file],[role=group][aria-labelledby=upload-label-resume]') !== null;
    const application = sameForm && (applicationSubmit || identity || attachment);
    const signals = [email.length > 0 ? 'email_control' : '', submit.length === 1 ? 'submission_control' : '', sameForm ? 'shared_form' : '', applicationSubmit ? 'application_submit' : '', identity ? 'identity_control' : '', attachment ? 'attachment_control' : '', passwords.length ? 'account_or_code_control' : '', challenge.length ? 'security_challenge' : '', loading ? 'loading_marker' : ''].filter(Boolean);
    return {version:'hosted-page-v1',documentKey:String(performance.timeOrigin),kind:challenge.length ? 'security_challenge' : passwords.length ? 'unknown' : loading ? 'loading' : application ? 'application' : 'unknown',signals,conflicts:owners.size > 1 || submit.length > 1 ? ['multiple_form_candidates'] : []};
  });
}

function requireHostedApplication(observation: Awaited<ReturnType<typeof observeHostedPage>>) {
  if (observation.kind !== 'application') throw new ApplicationPause(observation.kind === 'security_challenge'
    ? 'The employer shows a security challenge. Complete it in the selected tab, then retry.'
    : observation.kind === 'loading' ? 'The employer form is still loading. The draft is preserved; inspect the tab before retrying.'
    : 'The current page is not an identified application form. Inspect the selected tab; C3 has not inferred a form from its URL.');
}

export async function inspectHostedFields(page: Page) {
  await page.evaluate(annotateQuestionContext);
  return page.locator(controls).evaluateAll(elements => {
    const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
    const clean = (s: string) => s.replace(/[✱*]/g, '').replace(/\s+/g, ' ').trim();
    const labelContent = (e: Element, includeAsterisk = false) => {
      const copy = e.cloneNode(true) as Element;
      copy.querySelectorAll('input,select,textarea,button,svg,[role=option],.dropdown-container,[hidden]').forEach(x => x.remove());
      copy.querySelectorAll('[aria-hidden=true]').forEach(x => {
        if (!includeAsterisk || !/^[✱*]$/.test(x.textContent?.trim() ?? '')) x.remove();
      });
      return copy.textContent ?? '';
    };
    const labelText = (e: Element) => clean(labelContent(e));
    const committedChoice = (e: HTMLInputElement) => {
      const control=e.closest('.select__control');
      const pill=control?.querySelector('[class*=single-value]')?.textContent?.trim() ||
        [...control?.querySelectorAll('.select__multi-value__label')??[]].map(node=>node.textContent?.trim()).join('; ');
      if(pill)return pill;
      const id=e.getAttribute('aria-controls'), menus=id?[...document.querySelectorAll(`[id="${CSS.escape(id)}"]`)]:[];
      const selected=menus.length===1?[...menus[0]!.querySelectorAll('[role=option][aria-selected=true]')]:[];
      const label=selected.length===1?selected[0]!.textContent?.trim():undefined;
      return e.getAttribute('aria-expanded')!=='true' && label && label===e.value.trim()?label:'';
    };
    const out = [];
    const radioVisible=(e:Element)=>visible(e)||!!e.closest('[role=radio]')&&visible(e.closest('[role=radio]')!);
    const selected=(e:HTMLInputElement)=>{const aria=e.closest('[role=radio],[role=checkbox]')?.getAttribute('aria-checked');return aria!==undefined&&aria!==null?aria==='true':e.checked;};
    const radioNames = new Set<string>();
    for (const [index, raw] of elements.entries()) {
      const e = raw as HTMLInputElement;
      if (e.getAttribute('aria-hidden')==='true' && e.tabIndex===-1 && e.closest('[class*=select],[data-input-type=select]')?.querySelector('[role=combobox]')) continue;
      if (e.disabled || e.type === 'hidden' || /captcha|beecatcher/i.test(e.name ?? '') || e.closest('.ashby-application-form-autofill-input-root') || e.type === 'checkbox' && e.closest('.ashby-application-form-input-yesno')) continue;
      if(e.type==='checkbox'&&e.closest('[role=group][data-ui],.application-field:has(>ul[data-qa=checkboxes])'))continue;
      if(e.type==='radio' && radioNames.has(e.name))continue;
      if(e.type==='radio')radioNames.add(e.name);
      const radios=e.type==='radio'?[...document.querySelectorAll<HTMLInputElement>('input[type=radio]')].filter(r=>r.name===e.name&&radioVisible(r)):[];
      const radioGroup = radios.length ? e.closest('fieldset,[role=radiogroup],[class*=consentRadioGroupItem]') : null;
      const uploadCandidate=e.type==='file'?e.closest('[role=group][aria-labelledby],fieldset'):null;
      const uploadGroup=uploadCandidate?.querySelectorAll('input:not([type=hidden]),select,textarea').length===1?uploadCandidate:null;
      let group = radioGroup ?? e.closest('.ashby-application-form-field-entry,.application-question,.application-field,.field,fieldset') ?? e.parentElement;
      const referenceIds=[...new Set((e.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean))];
      const referenceMatches=referenceIds.map(id=>[...(e.getRootNode() as Document|ShadowRoot).querySelectorAll(`[id="${CSS.escape(id)}"]`)]);
      const referenced=referenceMatches.every(matches=>matches.length===1)?referenceMatches.map(matches=>matches[0]!):[];
      const ownLabels = [...e.labels ?? []];
      const descriptiveIds = new Set((e.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
      const labelsOnly = referenced.filter(label => !descriptiveIds.has(label.id));
      let labelOwners: Element[] = labelsOnly.length ? labelsOnly : ownLabels;
      let label = labelsOnly.map(labelText).join(' ').trim() || clean(e.getAttribute('aria-label') ?? '') || ownLabels.map(labelText).join(' ');
      if(uploadGroup) {
        const owners=(uploadGroup.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean).flatMap(id=>{
          const matches=[...document.querySelectorAll(`[id="${CSS.escape(id)}"]`)];
          return matches.length===1&&uploadGroup.contains(matches[0]!)?matches:[];
        });
        if(!owners.length && uploadGroup.matches('fieldset')) {const legend=uploadGroup.querySelector(':scope > legend');if(legend)owners.push(legend);}
        if(owners.length){
          group=uploadGroup;
          if(!label || /^(?:attach|replace file|choose files?|select files?|upload)(?:\s*[✱*])?$/i.test(label))label=owners.map(labelText).join(' ');
          labelOwners=[...labelOwners,...owners];
        }
      }
      if (!(e.type==='radio'?radioVisible(e):visible(e)) && !(e.type === 'file' && group && visible(group))) continue;
      const eeoName = e.tagName === 'SELECT' && location.hostname === 'jobs.lever.co'
        ? /^eeo\[(race|veteran|disability|gender)\]$/.exec(e.name ?? '')?.[1] : undefined;
      if (eeoName) {
        label = {race:'Race',veteran:'Veteran status',disability:'Disability status',gender:'Gender'}[eeoName] ?? label;
      }
      const precedingLabel = e.closest('.application-field')?.previousElementSibling;
      const ashbyButtons = e.matches('.ashby-application-form-input-yesno');
      const ownsLabel = (candidate: Element) => candidate instanceof HTMLLabelElement
        ? candidate.control === e || (ashbyButtons && group?.matches('.ashby-application-form-field-entry') &&
          candidate === group.firstElementChild && !candidate.hasAttribute('for') && !candidate.control &&
          group.querySelectorAll('.ashby-application-form-input-yesno').length === 1)
        : candidate.matches('.application-label,.application-question-title,legend');
      if (!label && precedingLabel && ownsLabel(precedingLabel)) {
        labelOwners = [precedingLabel];
        label = labelText(precedingLabel);
      }
      if(e.matches('.application-field:has(>ul[data-qa=checkboxes])')){const owner=e.parentElement?.querySelector('.application-label');if(owner)label=labelText(owner);}
      if (!label) {
        for (let parent = e.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
          const candidate = parent.querySelector('label,legend,.application-label,.application-question-title');
          if (candidate && !ownsLabel(candidate)) break;
          if (candidate) { labelOwners = [candidate]; label = labelText(candidate); break; }
        }
      }
      if (e.type === 'file' && /resume/i.test(e.id + e.name)) label = 'Resume';
      if (!label) label = e.getAttribute('placeholder') ?? '';
      if(radios.length) {
        const owner=document.getElementById(radioGroup?.getAttribute('aria-labelledby')??'') ?? radioGroup?.querySelector('legend,.ashby-application-form-question-title') ?? (radioGroup?.matches('[class*=consentRadioGroupItem]') ? radioGroup.querySelector('p') : null) ?? e.closest('.ashby-application-form-field-entry')?.querySelector('.ashby-application-form-question-title') ?? e.closest('.application-field')?.parentElement?.querySelector('.application-label');
        if(!owner)throw new Error('Radio question owner missing');labelOwners=[owner];label=labelText(owner);
      }
      const section = e.closest('.ashby-application-form-section-container');
      const oneOf = /answer (?:1|one) of \d+ questions/i.test(section?.querySelector('h2')?.textContent ?? '');
      const sectionInputs = section ? [...section.querySelectorAll('textarea')] : [];
      const groupRequired = oneOf && !sectionInputs.some(t => t.value.trim()) && (sectionInputs[0] as Element) === e;
      const multiChecks=e.matches('[role=group][data-ui],.application-field:has(>ul[data-qa=checkboxes])')?[...e.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]:[];
      const requiredMarker = '[data-required=true],.required,.ashby-application-form-field-required,[class*=_required_]';
      const markedLabel = labelOwners.some(owner=>owner.matches(requiredMarker) ||
        !!owner.querySelector(requiredMarker) || /[✱*]\s*$/.test(labelContent(owner, true)) || (()=>{
          const original=clean(labelContent(owner));
          for(let cluster=owner.parentElement,depth=0;cluster && depth<2;cluster=cluster.parentElement,depth++) {
            if(cluster.querySelector('input,select,textarea'))break;
            const text=labelContent(cluster,true).trim();
            if(clean(text)===original && /(?:^[✱*]|[✱*]$)/.test(text))return true;
          }
          return false;
        })());
      const ashbyMarker = group?.matches('.ashby-application-form-field-entry') &&
        !!group.querySelector(':scope > .ashby-application-form-field-required');
      const uploadWrapper=e.type==='file'?e.closest('.ashby-application-form-field-entry,.application-question,.application-field,.field'):null;
      const uploadWrapperRequired=uploadWrapper?.querySelectorAll('input:not([type=hidden]),select,textarea').length===1 &&
        (uploadWrapper.matches('[data-required=true],[aria-required=true]') || !!uploadWrapper.querySelector(':scope > .ashby-application-form-field-required'));
      const required = !!e.closest('[data-input-type=select]')?.querySelector('input[required]') ||
        multiChecks.some(c=>c.required) || radios.some(r=>r.required || r.getAttribute('aria-required')==='true') ||
        groupRequired || e.required || e.getAttribute('aria-required') === 'true' || (!eeoName && markedLabel) || ashbyMarker || uploadWrapperRequired ||
        !!group?.matches('[data-required=true],[aria-required=true]');
      const maskedDate = location.hostname==='apply.workable.com' && e.type==='text' && e.placeholder==='MM/DD/YYYY' && e.inputMode==='tel';
      const kind = multiChecks.length?'multicheck':e.classList.contains('ashby-application-form-input-yesno') ? 'buttons' : e.type === 'file' ? 'file' : e.id === 'location-input' && e.closest('.application-field') ? 'location' : e.tagName === 'SELECT' ? 'select' : e.getAttribute('role') === 'combobox' ? 'combobox' : e.type === 'radio' ? 'radio' : e.type === 'checkbox' ? 'checkbox' : e.tagName === 'TEXTAREA' ? 'textarea' : maskedDate || e.type === 'date' ? 'date' : 'text';
      label = e.getAttribute('data-hunt-question-context') || label;
      const key = `hosted-${index}`;
      e.setAttribute('data-c3-hosted', key);
      const options = kind==='multicheck'?multiChecks.map(r=>[...r.labels??[]].map(labelText).join(' ')):kind==='radio'?radios.map(r=>[...r.labels??[]].map(labelText).join(' ')):kind === 'select' ? [...(raw as HTMLSelectElement).options].filter(o => !o.disabled && o.value).map(o => o.textContent?.trim() ?? '') : kind === 'buttons' ? [...e.querySelectorAll('button[data-option]')].map(o => o.textContent?.trim() ?? '') : [];
      const value = kind==='select'?[...(raw as HTMLSelectElement).selectedOptions].filter(o=>!o.disabled&&o.value).map(o=>o.textContent?.trim()??'').join('; '):kind==='multicheck'?multiChecks.filter(selected).map(r=>[...r.labels??[]].map(labelText).join(' ')).join('; '):kind==='radio'?radios.filter(selected).map(r=>[...r.labels??[]].map(labelText).join(' ')).join(''):kind === 'buttons' ? e.querySelector('[aria-pressed=true]')?.textContent?.trim() ?? '' : kind === 'combobox' ? committedChoice(e) : e.value ?? '';
      out.push({ key, label, required, kind, options, value, checked: radios.length?radios.some(selected):e.checked ?? false, files: e.files?.length ?? 0,
        valid: e.getAttribute('aria-invalid') !== 'true' && (!e.validity || e.validity.valid), name: e.name ?? '',
        inputType: e.type, min: e.min === '' ? null : Number(e.min), max: e.max === '' ? null : Number(e.max), step: e.step === 'any' ? null : Number(e.step || '1'), minLength: e.minLength, maxLength: e.maxLength, pattern: e.pattern ?? '', readOnly: e.readOnly ?? false });
    }
    return out;
  });
}

export async function hostedReviewDigest(page: Page, expectedResumeSha256?: string): Promise<string> {
  return (await hostedReviewSnapshot(page, expectedResumeSha256)).digest;
}

export async function hostedReviewSnapshot(page: Page, expectedResumeSha256?: string, resumeExpected?: boolean, resumeUpload?: ResumeUploadReceipt): Promise<{ digest: string; resumeExpected: boolean }> {
  requireHostedApplication(await observeHostedPage(page));
  const fields = await inspectHostedFields(page);
  resumeExpected ||= applicationTarget(page.url()).ats==='greenhouse' && await page.locator('[role=group][aria-labelledby=upload-label-resume] button[aria-label="Remove file"]').count()>0;
  const workableReceipt=await verifiedWorkableResume(page,resumeUpload,expectedResumeSha256);
  const submit = page.getByRole('button', { name: submitName });
  if (!fields.length || await submit.count() !== 1 || !await submit.isVisible() || !await submit.isEnabled()) throw new ApplicationPause('The application is not ready for review.');
  for (const f of fields) {
    const filled = f.kind === 'file' ? f.files > 0 || workableReceipt && await verifiedWorkableResume(page,resumeUpload,expectedResumeSha256,f.key) : f.kind === 'checkbox' || f.kind === 'radio' ? f.checked : !!f.value.trim();
    if (f.required && !filled || !f.valid && filled) throw new ApplicationPause('Required or invalid fields remain. Inspect the application.');
  }
  const invalidProxy = await page.locator('input[aria-hidden=true][required]').evaluateAll(es=>es.some(raw=>{const e=raw as HTMLInputElement;return !e.disabled && !e.validity.valid && e.closest('[class*=select],[data-input-type=select]')?.getClientRects().length}));
  if(invalidProxy)throw new ApplicationPause('A required dropdown has not committed its backing value.');
  if (await page.locator('[aria-invalid=true]:visible,[role=alert]:visible').filter({hasText:/required|invalid|error|failed/i}).count()) throw new ApplicationPause('The employer is showing a validation error.');
  if(await page.getByText(/Resume(?:-[a-f0-9]{12})?\.pdf failed to upload/i).count())throw new ApplicationPause('The resume upload failed.');
  const backing = await page.locator('input[type=hidden],select').evaluateAll(es=>es.map(raw=>{const e=raw as HTMLInputElement|HTMLSelectElement;return {name:e.name,value:e instanceof HTMLSelectElement?[...e.selectedOptions].map(o=>o.value):e.value}}));
  // Bind review to the attached bytes, not just the number of selected files.
  const attachments = await page.locator('input[type=file]').evaluateAll(async (elements, keys) => Promise.all(
    elements.filter(e=>keys.includes(e.getAttribute('data-c3-hosted')??'')).map(async raw => ({
      key: raw.getAttribute('data-c3-hosted'),
      files: await Promise.all([...(raw as HTMLInputElement).files??[]].map(async file => ({
        name: file.name,
        sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join(''),
      }))),
    }))), fields.filter(f=>f.kind==='file').map(f=>f.key));
  const resumeKeys = new Set(fields.filter(f=>f.kind==='file' && (f.required || f.files>0) && /resume|cv/i.test(f.label)).map(f=>f.key));
  const acknowledged=resumeExpected && (workableReceipt || !resumeKeys.size && (await verifiedClientResume(page,resumeUpload,expectedResumeSha256) || await verifiedGreenhouseResume(page,resumeUpload,expectedResumeSha256)));
  if (resumeExpected && !resumeKeys.size && !acknowledged) throw new ApplicationPause('The previously verified resume field is missing. Inspect the draft, then retry.');
  if (workableReceipt) {
    for(const key of resumeKeys)if(await verifiedWorkableResume(page,resumeUpload,expectedResumeSha256,key))resumeKeys.delete(key);
  }
  if (expectedResumeSha256 !== undefined) {
    if (attachments.some(a=>resumeKeys.has(a.key??'') && (a.files.length!==1 || a.files[0]!.sha256!==expectedResumeSha256))) throw new ApplicationPause('The attached resume does not match the resume selected for this job. Inspect the draft, then retry.');
  }
  const digest = createHash('sha256').update(page.url()).update(JSON.stringify(backing)).update(JSON.stringify(attachments)).update(JSON.stringify(acknowledged?resumeUpload:null)).update(JSON.stringify(fields.map(f => ({key:f.key,label:f.label,value:f.value,checked:f.checked,files:f.files,required:f.required})))).digest('hex');
  return { digest, resumeExpected: resumeKeys.size > 0 || !!acknowledged };
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
  const matching=createMatchingBacklog(input.learningRoot,input.url,effectiveProfileFacts(input.profile),'C3.1',sources.profileQuery.ownerDefaults);
  let pendingMatch:MatchingObservation|undefined;
  const resumeSha256 = createHash('sha256').update(input.resume).digest('hex');
  let resumeExpected = input.resumeExpected;
  let resumeUpload=input.resumeUpload;
  const savedNarrative = (input.profile as {profile:{facts:{factId:string;value:unknown}[]}}).profile.facts.find(f=>f.factId==='configured_narrative')?.value;
  const resolver = createApplicationAnswerResolver(sources.profileQuery, typeof savedNarrative==='string'?savedNarrative:undefined);
  const history: {label:string;kind:string;required:boolean;options:string[];result:string;question:ReturnType<typeof resolveQuestion>;answerKind?:string;lane?:string}[] = [];
  const facts = effectiveProfileFacts(input.profile);
  const fact = (id: string) => facts.find(f => f.factId === id)?.value;
  const ownerFact = (id: string) => facts.find(f=>f.factId===id&&f.provenance==='owner_provided'&&f.lane==='live_owner_fact')?.value;
  const [gpa, scale] = [ownerFact('education_gpa'),ownerFact('education_gpa_scale')];
  const scaledGpa = typeof gpa==='string' && typeof scale==='string' &&
    [gpa,scale].every(value=>/^\d+(?:\.\d+)?$/.test(value)) && Number(scale)>0 && Number(gpa)<=Number(scale)
    ? `${gpa}/${scale}` : undefined;
  const hasCloudExperience = sources.profilePlan.repeatables.some(section => section.section === 'experience' &&
    section.rows.some(row => row.fields.some(field => field.fieldId === 'experience.description' &&
      field.answer.kind === 'answered' && field.answer.lane === 'live_owner_fact' &&
      ['owner_provided','resume_verified'].includes(field.answer.provenance) &&
      /(?:^|[.!?\n])\s*(?:[-•]\s*)?(?:deployed|automated|configured|ran|maintained|migrated|standardized)\b(?:(?!\b(?:without|never|instead of|planned|proposed)\b)[^.!?\n]){0,110}\b(?:kubernetes|docker|aws|azure|gcp)\b/i.test(field.answer.value))));
  const hasNorthAmericanLocation = ['canada','ca','can','united states','united states of america','us','usa'].includes(
    normalizeCatalogText(String(ownerFact('country') ?? '')));
  const known = new Map<string,string>();
  const cookieDialog=page.getByRole('dialog',{name:'Cookie Consent',exact:true});
  try {
    if(target.ats==='workable')await page.addLocatorHandler(cookieDialog,async dialog=>{await dialog.getByRole('button',{name:'Decline all',exact:true}).click();});
    let lastState='',unchanged=0;
    for (let pass = 0; pass < 32; pass++) {
      assertTarget();
      const observation=await observeHostedPage(page);
      if(input.learningRoot) {mkdirSync(input.learningRoot,{recursive:true});writeFileSync(join(input.learningRoot,'page-observation.json'),JSON.stringify(observation));}
      requireHostedApplication(observation);
      progress('Filling application');
      const fields = (await inspectHostedFields(page)).sort((a,b)=>Number(b.kind==='file')-Number(a.kind==='file'));
      if (!resumeExpected && (fields.some(f=>f.kind==='file' && f.required && /resume|cv/i.test(f.label)) || target.ats==='greenhouse' && await page.locator('[role=group][aria-labelledby=upload-label-resume] button[aria-label="Remove file"]').count()>0)) {
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
        const current = (await inspectHostedFields(page)).find(x => x.key === f.key);
        if (!current || current.label !== f.label || current.kind !== f.kind) { changed = true; break; }
        f = current;
        const matchObservation:MatchingObservation={pageId:page.url(),fieldId:f.key,question:f.label,control:f.kind,
          options:f.options,required:f.required,outcome:'observed',constraints:{inputType:f.inputType,
            min:f.min,max:f.max,step:f.step,minLength:f.minLength,maxLength:f.maxLength,pattern:f.pattern,readOnly:f.readOnly}};
        matching.record(matchObservation);
        if (!isRecruitmentTermsConsent(f.label) && (/\b(?:consent|terms and conditions|terms of use|privacy policy|privacy notice)\b|^terms$|\bI confirm that I have read and understood\b/i.test(f.label) || f.options.some(option=>/\b(?:consent|authorize|agree)\b/i.test(option)))) {
          const answered = f.kind==='checkbox' ? f.checked : !!f.value.trim();
          if(answered || !f.required){known.set(identity,answered?'existing':'optional');continue;}
          if(sources.executionPolicy.answerFallbackPolicy!=='deterministic_site_valid_editable')throw new ApplicationPause('This application requires a consent decision. Choose it yourself on the employer page, then retry.');
        }
        if (!f.required) { known.set(identity,'optional'); continue; }
        if (f.kind === 'file') {
          if (!/resume|cv/i.test(f.label)) throw new ApplicationPause('This application requires an additional attachment.');
          const file = {name:target.ats==='workable'?`Resume-${resumeSha256.slice(0,12)}.pdf`:'Resume.pdf',mimeType:'application/pdf',buffer:input.resume};
          if(target.ats==='greenhouse' && await loc.evaluate(e=>e.closest('[data-allow-s3]')?.getAttribute('data-allow-s3'))!=='false') {
            resumeUpload=undefined;input.onResumeUpload?.(undefined);
            await page.waitForFunction(()=>performance.getEntriesByType('resource').some(e=>e.name.includes('/uncacheable_attributes/presigned_fields')&&(e as PerformanceResourceTiming).responseEnd>0),undefined,{timeout:20000});
            await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
            resumeUpload=await uploadGreenhouseResume(page,file);input.onResumeUpload?.(resumeUpload);
          } else if(target.ats==='workable' && await loc.getAttribute('data-ui')==='resume') {
            if(await verifiedWorkableResume(page,resumeUpload,resumeSha256,f.key)) {known.set(identity,'file');continue;}
            resumeUpload=await uploadWorkableResume(page,loc,file);input.onResumeUpload?.(resumeUpload);
          } else {
            resumeUpload=await selectClientResume(page,loc,file);input.onResumeUpload?.(resumeUpload);
          }
          await page.waitForTimeout(800);
          known.set(identity,'file'); changed = true; break;
        }
        if (f.kind === 'location' || f.kind === 'combobox' && (/location.*city|^(?:current )?location$/i.test(f.label) || await loc.evaluate(e=>e.closest('[data-field-path="_systemfield_location"]')!==null))) {
          const city = fact('city');
          if (typeof city !== 'string') throw new ApplicationPause('Add your location to the profile.');
          await loc.fill('');if(target.ats==='lever')await loc.pressSequentially(city,{delay:30});else await loc.fill(city);
          const choiceOwner = await loc.getAttribute('aria-controls');
          const choices = f.kind === 'location' ? page.locator('.dropdown-results .dropdown-location:visible')
            : choiceOwner ? page.locator(`[id=${JSON.stringify(choiceOwner)}] [role=option]:visible`)
            : page.locator('[role=listbox]:visible [role=option]:visible');
          try { await choices.first().waitFor({state:'visible',timeout:10000}); }
          catch {
            const qualified=[city,fact('region'),fact('country')].filter(value=>typeof value==='string'&&value.trim()).join(', ');
            if(qualified===city)throw new ApplicationPause('The employer did not return location suggestions. Choose your location on the employer page, then retry.');
            await loc.fill('');await loc.pressSequentially(qualified,{delay:30});
            try { await choices.first().waitFor({state:'visible',timeout:10000}); }
            catch { throw new ApplicationPause('The employer did not return location suggestions. Choose your location on the employer page, then retry.'); }
          }
          const labels = await choices.allTextContents();
          const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
          const region = fact('region'), country = fact('country');
          const matches = labels.map((label, index) => ({parts: label.split(',').map(normalize), index})).filter(({parts}) => {
            if (parts.length === 1) return parts[0] === normalize(city);
            if (parts.length !== 3 || parts[0] !== normalize(city) || typeof region !== 'string' || typeof country !== 'string') return false;
            const canadian = ['ca', 'can', 'canada'];
            if (canadian.includes(normalize(country)) && canadian.includes(parts[2]!)) {
              const expectedRegion = canonicalCanadianRegion(region);
              return !!expectedRegion && canonicalCanadianRegion(parts[1]!) === expectedRegion;
            }
            return parts[1] === normalize(region) && parts[2] === normalize(country);
          });
          // Some providers repeat the same city result. Identical full labels
          // still identify the saved city, province and country unambiguously.
          const exact = matches.length === 1 || matches.length > 1 && matches.every(match => match.parts.length === 3 && normalize(labels[match.index]!) === normalize(labels[matches[0]!.index]!)) ? matches[0]!.index : -1;
          const index = exact >= 0 ? exact : sources.profilePlan.mode === 'synthetic_test_non_submittable' ? 0 : -1;
          if(index<0)throw new ApplicationPause('Choose the exact location from the employer suggestions.');
          const expected=labels[index]!.trim();
          const ownedChoice=async()=>{
            const owner=await loc.getAttribute('aria-controls');
            if (owner !== choiceOwner) throw new ApplicationPause('The location menu changed. Inspect the selected location before retrying.');
            const options=owner?page.locator(`[id=${JSON.stringify(owner)}] [role=option]:visible`):choices;
            return options.filter({hasText:new RegExp('^'+expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).first();
          };
          try { await (await ownedChoice()).click({timeout:3000}); }
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
          if((await inspectHostedFields(page)).find(x=>x.key===f.key)?.value!==expected)throw new ApplicationPause('The location selection did not persist.');
          if(f.kind==='location' && !await page.locator('#selected-location').inputValue())throw new ApplicationPause('Location backing value is missing.');
          known.set(identity,expected);changed=true;continue;
        }
        if (f.kind === 'combobox' && f.value && f.valid &&
            await loc.evaluate(e=>!!e.closest('.select__control')?.querySelector('[class*=single-value],.select__multi-value__label'))) {
          matching.record({...matchObservation,observedAnswer:f.value,provisional:true,outcome:'unconfirmed',reason:'existing_selection_preserved'});
          known.set(identity,`existing:${f.value}`); continue;
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
        const unbounded=[f.label,...options].some(text=>[...text].length>512);
        const behavior = f.kind==='date'?'date':f.kind==='radio'?'radio':f.kind === 'buttons' || f.kind === 'combobox' || f.kind==='multicheck' ? 'listbox' : f.kind === 'checkbox' ? 'checkbox' : f.kind === 'textarea' ? 'textarea' : f.kind === 'select' ? 'select' : 'text';
        const field: ApplicationFieldObservation = {fieldId:fieldId(f.key),target:browserTargetToken(f.key),label:boundedText(unbounded?'Unrecognized required field':f.label),required:f.required,behavior,options:options.map((v,i)=>({id:optionId(`${f.key}-${i}`),label:boundedText(unbounded?`Unrecognized option ${i}`:v)})),state:(f.kind==='checkbox'?f.checked:!!f.value)?'populated':'empty', constraints:behavior==='text'||behavior==='textarea'?{inputType:/\b(?:url|website|linkedin(?: profile)?)\b/i.test(f.label)&&f.inputType==='text'?'url':['email','url','number'].includes(f.inputType)?f.inputType as 'email'|'url'|'number':'text',min:Number.isFinite(f.min)?f.min:null,max:Number.isFinite(f.max)?f.max:null,step:Number.isFinite(f.step)?f.step:null,minLength:f.minLength>=0?f.minLength:null,maxLength:f.maxLength>=0?f.maxLength:null,pattern:f.pattern||null,readOnly:f.readOnly}:undefined};
        matching.record({...matchObservation,options,constraints:field.constraints??matchObservation.constraints});
        const fallback=unbounded?provisionalUnboundedFieldAnswer({required:f.required,behavior,question:f.label,options,constraints:field.constraints}):undefined;
        const result = unbounded?{ok:true as const,value:{kind:'unbounded' as const}}:await resolver.resolve({mode:sources.profilePlan.mode,answerFallbackPolicy:sources.executionPolicy.answerFallbackPolicy,field,profileId:sources.profileId,profileRevision:sources.profileRevision,resume:{resumeId:sources.resumeIntent.artifact.resumeId,sha256:resumeSha256},resumeArtifact:sources.resumeIntent.artifact,
          employerNames:[matchingContext(input.url).company??'']},signal);
        const questionLabel = normalizeCatalogText(f.label);
        const useScaledGpa = questionLabel===averageGpaQuestion && f.inputType==='text' && !f.pattern &&
          scaledGpa && (f.maxLength<0 || scaledGpa.length<=f.maxLength);
        const direct = unbounded?undefined:useScaledGpa ? scaledGpa : profileFieldValue(f.label,facts);
        const profileSupportsYes = (hasCloudExperience && questionLabel === handsOnCloudQuestion) ||
          (hasNorthAmericanLocation && questionLabel === northAmericanLocationQuestion);
        const yes = options.filter(option=>option.toLowerCase()==='yes');
        const supportedChoice = profileSupportsYes && yes.length===1 && ['radio','select','buttons','combobox'].includes(f.kind) ? yes[0] : undefined;
        let expected: string | boolean;
        if (fallback) expected=fallback.answer;
        else if (typeof direct === 'string' && ['text','textarea'].includes(f.kind)) expected = direct;
        else if (supportedChoice !== undefined) expected = supportedChoice;
        else {
          if (!result.ok || result.value.kind !== 'resolved') {
            history.push({label:f.label,kind:f.kind,required:f.required,options,question:resolveQuestion(f.label),result:result.ok?result.value.kind:result.error.code});
            if (f.kind === 'combobox') await loc.press('Escape');
            known.set(identity, f.value && f.valid ? `existing:${f.value}` : 'unanswered');
            continue;
          }
          if (!f.required && result.value.lane !== 'live_owner_fact') {
            if (f.kind === 'combobox') await loc.press('Escape');
            known.set(identity, 'optional');
            continue;
          }
          const intent = result.value.intent;
          if(intent.kind==='text') expected=intent.value;
          else if(intent.kind==='date') expected=intent.isoDate;
          else if(intent.kind==='choice') expected=String(intent.expectedOption);
          else if(intent.kind==='toggle') expected=intent.checked;
          else throw new ApplicationPause('This field type is not supported on this application yet.');
        }
        const profileFact=supportedChoice!==undefined||typeof direct==='string'&&['text','textarea'].includes(f.kind);
        pendingMatch={...matchObservation,options,chosenAnswer:expected,
          provisional:unbounded||!profileFact&&result.ok&&result.value.kind==='resolved'&&result.value.lane==='synthetic_test_default',
          outcome:'attempted',reason:unbounded?'question_or_option_exceeds_readback_limit':profileFact?'profile_answer':result.ok&&result.value.kind==='resolved'?result.value.lane:'unmatched'};
        history.push({label:f.label,kind:f.kind,required:f.required,options,question:resolveQuestion(f.label),answerKind:result.ok&&result.value.kind==='resolved'?result.value.intent.kind:undefined,lane:profileFact?'profile_fact':result.ok&&result.value.kind==='resolved'?result.value.lane:undefined,result:result.ok?result.value.kind:result.error.code});
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
        else if(f.kind==='buttons') { await loc.getByRole('button',{name:String(expected),exact:true}).click(); if(await loc.locator('[aria-pressed=true]').innerText()!==expected)throw new ApplicationPause('The selected answer did not persist.'); }
        else if(f.kind==='select') { await loc.selectOption({label:String(expected)}); if(await loc.locator('option:checked').textContent()!==expected)throw new ApplicationPause('The selected answer did not persist.'); }
        else if(f.kind==='combobox') { const choice=popup!.filter({hasText:new RegExp('^'+String(expected).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')});if(await choice.count()!==1)throw new ApplicationPause('Dropdown choice is ambiguous.');await choice.click();await loc.blur();const after=(await inspectHostedFields(page)).find(x=>x.key===f.key);if(after?.value!==expected){await loc.click();const selected=popup!.locator('xpath=self::*[@aria-selected="true"]');if(await selected.count()!==1||(await selected.innerText()).trim()!==expected)throw new ApplicationPause('The selected dropdown answer could not be verified.');await loc.press('Escape');await loc.blur();} }
        else if(f.kind==='checkbox') { await loc.setChecked(expected===true);if(await loc.isChecked()!==(expected===true))throw new ApplicationPause('The checkbox answer did not persist.'); }
        else if(f.kind==='date' && f.inputType==='date') {await loc.fill(String(expected));await loc.blur();if(await loc.inputValue()!==expected)throw new ApplicationPause('The selected date did not persist.');}
        else if(f.kind==='date') {const [year,month,day]=String(expected).split('-');const display=`${month}/${day}/${year}`;await loc.fill('');await loc.pressSequentially(`${month}${day}${year}`);await loc.blur();if(await loc.inputValue()!==display)throw new ApplicationPause('The selected date did not persist.');}
        else {await loc.fill(String(expected));await loc.blur();const readback=await loc.inputValue();const same=readback===String(expected)||(/phone/i.test(f.label)&&readback.replace(/\D/g,'')===String(expected).replace(/\D/g,''));if(!same)throw new ApplicationPause('The text answer did not persist.');}
        const committed=(await inspectHostedFields(page)).find(x=>x.key===f.key&&x.label===f.label);
        matching.record({...pendingMatch,outcome:'verified',reason:'product_readback_confirmed'});pendingMatch=undefined;
        known.set(identity,String(f.kind==='checkbox'?committed?.checked:committed?.value??expected)); changed = true;
      }
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
