import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { boundedText, browserTargetToken, fieldId, optionId, disposeResumeArtifact } from '../contracts/index.ts';
import { createApplicationAnswerResolver } from '../form/answers/resolver.ts';
import type { ApplicationFieldObservation } from '../form/answers/application-types.ts';
import { productSources } from './sources.ts';
import { resolveQuestion } from '../form/questions/catalog.ts';
import { profileFieldValue } from './profile-field.ts';
import { canonicalCanadianRegion } from '../composition/private/s2-derived-profile-country.ts';
import { applicationTarget } from './target.ts';
import { ApplicationPause, type ProductInput } from './engine.ts';

const controls = 'input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea,.ashby-application-form-input-yesno,[role=group][data-ui]:has(input[type=checkbox]),.application-field:has(>ul[data-qa=checkboxes])';
const submitName = /^(submit application|submit|send application)$/i;

export async function inspectHostedFields(page: Page) {
  return page.locator(controls).evaluateAll(elements => {
    const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
    const clean = (s: string) => s.replace(/[✱*]/g, '').replace(/\s+/g, ' ').trim();
    const labelText = (e: Element) => {
      const copy = e.cloneNode(true) as Element;
      copy.querySelectorAll('input,select,textarea,button,svg,[role=option],.dropdown-container').forEach(x => x.remove());
      return clean(copy.textContent ?? '');
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
      const group = e.closest('.ashby-application-form-field-entry,.application-question,.application-field,.field,fieldset') ?? e.parentElement;
      if (!(e.type==='radio'?radioVisible(e):visible(e)) && !(e.type === 'file' && group && visible(group))) continue;
      const referenced = (e.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)).filter(Boolean) as Element[];
      let label = clean(e.getAttribute('aria-label') ?? '') || referenced.map(labelText).join(' ') || [...e.labels ?? []].map(labelText).join(' ');
      if(e.matches('.application-field:has(>ul[data-qa=checkboxes])')){const owner=e.parentElement?.querySelector('.application-label');if(owner)label=labelText(owner);}
      if (!label) {
        for (let parent = e.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
          const candidate = parent.querySelector('label,legend,.application-label,.application-question-title');
          if (candidate) { label = labelText(candidate); break; }
        }
      }
      if (e.type === 'file' && /resume/i.test(e.id + e.name)) label = 'Resume';
      if (!label) label = e.getAttribute('placeholder') ?? '';
      if(radios.length) {
        const owner=document.getElementById(e.closest('fieldset')?.getAttribute('aria-labelledby')??'') ?? e.closest('fieldset')?.querySelector('legend,.ashby-application-form-question-title') ?? e.closest('.ashby-application-form-field-entry')?.querySelector('.ashby-application-form-question-title') ?? e.closest('.application-field')?.parentElement?.querySelector('.application-label');
        if(!owner)throw new Error('Radio question owner missing');label=labelText(owner);
      }
      const ownLabel = [...e.labels ?? []].map(l => l.textContent).join(' ');
      const section = e.closest('.ashby-application-form-section-container');
      const oneOf = /answer (?:1|one) of \d+ questions/i.test(section?.querySelector('h2')?.textContent ?? '');
      const sectionInputs = section ? [...section.querySelectorAll('textarea')] : [];
      const groupRequired = oneOf && !sectionInputs.some(t => t.value.trim()) && (sectionInputs[0] as Element) === e;
      const multiChecks=e.matches('[role=group][data-ui],.application-field:has(>ul[data-qa=checkboxes])')?[...e.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]:[];
      const required = !!e.closest('[data-input-type=select]')?.querySelector('input[required]')||multiChecks.some(c=>c.required)||referenced.some(r=>/[✱*]/.test(r.textContent??''))||groupRequired || !!group?.querySelector('label[class*=_required_]') || e.required || e.getAttribute('aria-required') === 'true' || /[✱*]/.test(ownLabel) || !!group?.querySelector('[data-required=true],.required,.ashby-application-form-field-required');
      const kind = multiChecks.length?'multicheck':e.classList.contains('ashby-application-form-input-yesno') ? 'buttons' : e.type === 'file' ? 'file' : e.id === 'location-input' && e.closest('.application-field') ? 'location' : e.tagName === 'SELECT' ? 'select' : e.getAttribute('role') === 'combobox' ? 'combobox' : e.type === 'radio' ? 'radio' : e.type === 'checkbox' ? 'checkbox' : e.tagName === 'TEXTAREA' ? 'textarea' : 'text';
      const key = `hosted-${index}`;
      e.setAttribute('data-c3-hosted', key);
      const options = kind==='multicheck'?multiChecks.map(r=>[...r.labels??[]].map(labelText).join(' ')):kind==='radio'?radios.map(r=>[...r.labels??[]].map(labelText).join(' ')):kind === 'select' ? [...(raw as HTMLSelectElement).options].filter(o => !o.disabled && o.value).map(o => o.textContent?.trim() ?? '') : kind === 'buttons' ? [...e.querySelectorAll('button[data-option]')].map(o => o.textContent?.trim() ?? '') : [];
      const value = kind==='multicheck'?multiChecks.filter(selected).map(r=>[...r.labels??[]].map(labelText).join(' ')).join('; '):kind==='radio'?radios.filter(selected).map(r=>[...r.labels??[]].map(labelText).join(' ')).join(''):kind === 'buttons' ? e.querySelector('[aria-pressed=true]')?.textContent?.trim() ?? '' : kind === 'combobox' ? e.closest('.select__control')?.querySelector('[class*=single-value]')?.textContent?.trim() ?? ([...e.closest('.select__control')?.querySelectorAll('.select__multi-value__label')??[]].map(x=>x.textContent?.trim()).join('; ') || e.value || '') : e.value ?? '';
      out.push({ key, label, required, kind, options, value, checked: radios.length?radios.some(selected):e.checked ?? false, files: e.files?.length ?? 0,
        valid: e.getAttribute('aria-invalid') !== 'true' && (!e.validity || e.validity.valid), name: e.name ?? '',
        inputType: e.type, minLength: e.minLength, maxLength: e.maxLength, pattern: e.pattern ?? '', readOnly: e.readOnly ?? false });
    }
    return out;
  });
}

export async function hostedReviewDigest(page: Page): Promise<string> {
  const fields = await inspectHostedFields(page);
  const submit = page.getByRole('button', { name: submitName });
  if (!fields.length || await submit.count() !== 1 || !await submit.isVisible() || !await submit.isEnabled()) throw new ApplicationPause('The application is not ready for review.');
  for (const f of fields) {
    const filled = f.kind === 'file' ? f.files > 0 : f.kind === 'checkbox' || f.kind === 'radio' ? f.checked : !!f.value.trim();
    if (f.required && !filled || !f.valid && filled) throw new ApplicationPause('Required or invalid fields remain. Inspect the application.');
  }
  const invalidProxy = await page.locator('input[aria-hidden=true][required]').evaluateAll(es=>es.some(raw=>{const e=raw as HTMLInputElement;return !e.disabled && !e.validity.valid && e.closest('[class*=select],[data-input-type=select]')?.getClientRects().length}));
  if(invalidProxy)throw new ApplicationPause('A required dropdown has not committed its backing value.');
  if (await page.locator('[aria-invalid=true]:visible,[role=alert]:visible').filter({hasText:/required|invalid|error|failed/i}).count()) throw new ApplicationPause('The employer is showing a validation error.');
  if(await page.getByText(/Resume\.pdf failed to upload/i).count())throw new ApplicationPause('The resume upload failed.');
  const backing = await page.locator('input[type=hidden]').evaluateAll(es=>es.map(raw=>{const e=raw as HTMLInputElement;return {name:e.name,value:e.value}}));
  return createHash('sha256').update(page.url()).update(JSON.stringify(backing)).update(JSON.stringify(fields.map(f => ({key:f.key,label:f.label,value:f.value,checked:f.checked,files:f.files,required:f.required})))).digest('hex');
}

export async function fillHostedApplication(page: Page, input: ProductInput, signal: AbortSignal, progress: (stage: string) => void) {
  const target = applicationTarget(input.url);
  const assertTarget = () => { signal.throwIfAborted(); if (applicationTarget(page.url()).key !== target.key) throw new ApplicationPause('The tab moved to a different job.'); };
  assertTarget();
  if (target.ats === 'lever' && !/\/apply\/?$/.test(new URL(page.url()).pathname)) await page.goto(target.url.replace(/\/$/,'')+'/apply', {waitUntil:'domcontentloaded'});
  if (target.ats === 'ashby' && !/\/application\/?$/.test(new URL(page.url()).pathname)) await page.goto(target.url.replace(/\/$/,'')+'/application', {waitUntil:'domcontentloaded'});
  if(target.ats==='workable'&&!/\/apply\/?$/.test(new URL(page.url()).pathname))await page.goto(target.url.replace(/\/$/,'')+'/apply/',{waitUntil:'domcontentloaded'});
  if(target.ats==='workable'){const decline=page.getByRole('button',{name:'Decline all',exact:true});if(await decline.isVisible().catch(()=>false))await decline.click();}
  await page.locator('input[type=email],input[name=email],input[id=email]').first().waitFor({state:'visible',timeout:30000});
  const sources = productSources(input.profile, input.resume);
  const savedNarrative = (input.profile as {profile:{facts:{factId:string;value:unknown}[]}}).profile.facts.find(f=>f.factId==='configured_narrative')?.value;
  const resolver = createApplicationAnswerResolver(sources.profileQuery, typeof savedNarrative==='string'?savedNarrative:undefined);
  const history: {label:string;kind:string;required:boolean;options:string[];result:string;question:ReturnType<typeof resolveQuestion>;answerKind?:string;lane?:string}[] = [];
  const facts = (input.profile as {profile:{facts:{factId:string;value:unknown}[]}}).profile.facts;
  const fact = (id: string) => facts.find(f => f.factId === id)?.value;
  const known = new Map<string,string>();
  const cookieDialog=page.getByRole('dialog',{name:'Cookie Consent',exact:true});
  try {
    if(target.ats==='workable')await page.addLocatorHandler(cookieDialog,async dialog=>{await dialog.getByRole('button',{name:'Decline all',exact:true}).click();});
    let lastState='',unchanged=0;
    for (let pass = 0; pass < 32; pass++) {
      assertTarget();
      progress('Filling application');
      const fields = (await inspectHostedFields(page)).sort((a,b)=>Number(b.kind==='file')-Number(a.kind==='file'));
      const state=JSON.stringify(fields);unchanged=state===lastState?unchanged+1:0;lastState=state;
      if(unchanged>2)throw new ApplicationPause('The application is not making progress.');
      let changed = false;
      for (const f of fields) {
        assertTarget();
        if (!f.label) { if(f.required) throw new ApplicationPause('A required field has no readable question label.'); continue; }
        const identity = JSON.stringify([f.key,f.label,f.kind,f.required,f.options]);
        if (known.has(identity)) {
          const previous=known.get(identity);
          if(previous==='optional'||previous==='unanswered'||previous==='existing'||previous==='file'&&f.files>0||String(f.kind==='checkbox'?f.checked:f.value)===previous)continue;
          known.delete(identity);
        }
        const loc = page.locator(`[data-c3-hosted="${f.key}"]`);
        const current = (await inspectHostedFields(page)).find(x => x.key === f.key);
        if (!current || current.label !== f.label || current.kind !== f.kind) { changed = true; break; }
        if (!f.required && profileFieldValue(f.label,facts)===undefined && !/^(first name|last name|full name|name|email|phone|resume|resume\/cv)$/i.test(f.label)) { known.set(identity,'optional'); continue; }
        if([...f.label].length>512)throw new ApplicationPause('This required question exceeds the supported label length; review it for an assessment.');
        if (f.kind === 'file') {
          if (!/resume|cv/i.test(f.label)) throw new ApplicationPause('This application requires an additional attachment.');
          const file = {name:'Resume.pdf',mimeType:'application/pdf',buffer:input.resume};
          if(target.ats==='greenhouse') {
            const uploaded=page.locator('[role=group][aria-labelledby=upload-label-resume]');
            await page.waitForFunction(()=>performance.getEntriesByType('resource').some(e=>e.name.includes('/uncacheable_attributes/presigned_fields')&&(e as PerformanceResourceTiming).responseEnd>0),undefined,{timeout:20000});
            await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
            await uploaded.locator('input[type=file]').setInputFiles(file);
            await uploaded.getByText('Resume.pdf',{exact:false}).waitFor({state:'visible',timeout:30000});
          } else {
            await loc.setInputFiles(file);
            if (!await loc.evaluate((e:HTMLInputElement)=>e.files?.length===1 && e.files[0]!.name==='Resume.pdf')) throw new ApplicationPause('Resume attachment could not be verified.');
          }
          await page.waitForTimeout(800);
          known.set(identity,'file'); changed = true; continue;
        }
        if (f.kind === 'location' || f.kind === 'combobox' && (/location.*city/i.test(f.label) || await loc.evaluate(e=>e.closest('[data-field-path="_systemfield_location"]')!==null))) {
          const city = fact('city');
          if (typeof city !== 'string') throw new ApplicationPause('Add your location to the profile.');
          await loc.fill('');if(target.ats==='lever')await loc.pressSequentially(city,{delay:30});else await loc.fill(city);
          const choices = f.kind === 'location' ? page.locator('.dropdown-results .dropdown-location:visible') : page.locator('[role=listbox]:visible [role=option]');
          await choices.first().waitFor({state:'visible',timeout:10000});
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
          const exact = matches.length === 1 ? matches[0]!.index : -1;
          const index = exact >= 0 ? exact : sources.profilePlan.mode === 'synthetic_test_non_submittable' ? 0 : -1;
          if(index<0)throw new ApplicationPause('Choose the exact location from the employer suggestions.');
          const expected=labels[index]!.trim();await choices.nth(index).click();await loc.blur();
          if((await inspectHostedFields(page)).find(x=>x.key===f.key)?.value!==expected)throw new ApplicationPause('The location selection did not persist.');
          if(f.kind==='location' && !await page.locator('#selected-location').inputValue())throw new ApplicationPause('Location backing value is missing.');
          known.set(identity,expected);changed=true;continue;
        }
        if (f.value && f.valid && ['text','textarea','multicheck'].includes(f.kind)) { known.set(identity,'existing');continue; }
        let options = f.options;
        let popup: ReturnType<Page['locator']> | undefined;
        if (f.kind === 'combobox') {
          await loc.click();
          const owner = await loc.getAttribute('aria-controls');
          popup = owner ? page.locator(`[id=${JSON.stringify(owner)}] [role=option]`) : page.locator('[role=listbox]:visible [role=option]');
          await popup.first().waitFor({state:'visible',timeout:5000}).catch(()=>{});
          options = (await popup.allTextContents()).map(x=>x.trim()).filter(Boolean);
          if (!options.length) throw new ApplicationPause('A required dropdown did not expose its choices.');
        }
        const behavior = f.kind==='radio'?'radio':f.kind === 'buttons' || f.kind === 'combobox' || f.kind==='multicheck' ? 'listbox' : f.kind === 'checkbox' ? 'checkbox' : f.kind === 'textarea' ? 'textarea' : f.kind === 'select' ? 'select' : 'text';
        const field: ApplicationFieldObservation = {fieldId:fieldId(f.key),target:browserTargetToken(f.key),label:boundedText(f.label),required:f.required,behavior,options:options.map((v,i)=>({id:optionId(`${f.key}-${i}`),label:boundedText(v)})),state:f.value?'populated':'empty', constraints:behavior==='text'||behavior==='textarea'?{inputType:/\b(?:url|website|linkedin(?: profile)?)\b/i.test(f.label)&&f.inputType==='text'?'url':['email','url','number'].includes(f.inputType)?f.inputType as 'email'|'url'|'number':'text',min:null,max:null,minLength:f.minLength>=0?f.minLength:null,maxLength:f.maxLength>=0?f.maxLength:null,pattern:f.pattern||null,readOnly:f.readOnly}:undefined};
        const result = await resolver.resolve({mode:sources.profilePlan.mode,answerFallbackPolicy:sources.executionPolicy.answerFallbackPolicy,field,profileId:sources.profileId,profileRevision:sources.profileRevision,resume:{resumeId:sources.resumeIntent.artifact.resumeId,sha256:createHash('sha256').update(input.resume).digest('hex')},resumeArtifact:sources.resumeIntent.artifact},signal);
        const direct = profileFieldValue(f.label,facts);
        let expected: string | boolean;
        if (typeof direct === 'string' && ['text','textarea'].includes(f.kind)) expected = direct;
        else {
          if (!result.ok || result.value.kind !== 'resolved') {
            if (f.kind === 'combobox') await loc.press('Escape');
            known.set(identity, 'unanswered');
            continue;
          }
          const intent = result.value.intent;
          if(intent.kind==='text') expected=intent.value;
          else if(intent.kind==='choice') expected=String(intent.expectedOption);
          else if(intent.kind==='toggle') expected=intent.checked;
          else throw new ApplicationPause('This field type is not supported on this application yet.');
        }
        const profileFact=typeof direct==='string'&&['text','textarea'].includes(f.kind);
        history.push({label:f.label,kind:f.kind,required:f.required,options,question:resolveQuestion(f.label),answerKind:result.ok&&result.value.kind==='resolved'?result.value.intent.kind:undefined,lane:profileFact?'profile_fact':result.ok&&result.value.kind==='resolved'?result.value.lane:undefined,result:result.ok?result.value.kind:result.error.code});
        if(f.kind==='radio') {const radios=page.locator(`input[type=radio][name=${JSON.stringify(f.name)}]`);const index=options.indexOf(String(expected));if(index<0||options.lastIndexOf(String(expected))!==index)throw new ApplicationPause('Radio choice is ambiguous.');const radio=radios.nth(index);if(await radio.getAttribute('aria-hidden')==='true')await radio.locator('xpath=ancestor::label[1]').click();else await radio.check();if(!await radios.nth(index).evaluate((e:HTMLInputElement)=>e.closest('[role=radio]')?e.closest('[role=radio]')!.getAttribute('aria-checked')==='true':e.checked))throw new ApplicationPause('The radio answer did not persist.');}
        else if(f.kind==='multicheck'){const index=options.indexOf(String(expected));if(index<0)throw new ApplicationPause('Checkbox group answer is missing.');const boxes=loc.locator('input[type=checkbox]');const box=boxes.nth(index);if(await box.getAttribute('aria-hidden')==='true')await box.locator('xpath=ancestor::*[@role="checkbox"][1]').click();else await box.setChecked(true);if(!await box.evaluate((e:HTMLInputElement)=>e.closest('[role=checkbox]')?e.closest('[role=checkbox]')!.getAttribute('aria-checked')==='true':e.checked))throw new ApplicationPause('Checkbox group answer did not persist.');}
        else if(f.kind==='buttons') { await loc.getByRole('button',{name:String(expected),exact:true}).click(); if(await loc.locator('[aria-pressed=true]').innerText()!==expected)throw new ApplicationPause('The selected answer did not persist.'); }
        else if(f.kind==='select') { await loc.selectOption({label:String(expected)}); if(await loc.locator('option:checked').textContent()!==expected)throw new ApplicationPause('The selected answer did not persist.'); }
        else if(f.kind==='combobox') { const choice=popup!.filter({hasText:new RegExp('^'+String(expected).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')});if(await choice.count()!==1)throw new ApplicationPause('Dropdown choice is ambiguous.');await choice.click();await loc.blur();const after=(await inspectHostedFields(page)).find(x=>x.key===f.key);if(after?.value!==expected){await loc.click();const selected=popup!.locator('xpath=self::*[@aria-selected="true"]');if(await selected.count()!==1||(await selected.innerText()).trim()!==expected)throw new ApplicationPause('The selected dropdown answer could not be verified.');await loc.press('Escape');await loc.blur();} }
        else if(f.kind==='checkbox') { await loc.setChecked(expected===true);if(await loc.isChecked()!==(expected===true))throw new ApplicationPause('The checkbox answer did not persist.'); }
        else {await loc.fill(String(expected));await loc.blur();const readback=await loc.inputValue();const same=readback===String(expected)||(/phone/i.test(f.label)&&readback.replace(/\D/g,'')===String(expected).replace(/\D/g,''));if(!same)throw new ApplicationPause('The text answer did not persist.');}
        const committed=(await inspectHostedFields(page)).find(x=>x.key===f.key&&x.label===f.label);
        known.set(identity,String(f.kind==='checkbox'?committed?.checked:committed?.value??expected)); changed = true;
      }
      if (!changed) {assertTarget();progress('Verifying application');const digest=await hostedReviewDigest(page);await page.waitForTimeout(500);assertTarget();if(await hostedReviewDigest(page)!==digest)continue;return {reviewDigest:digest,completedPages:1};}
      await page.waitForTimeout(300);
    }
    throw new ApplicationPause('The form kept changing. Inspect the remaining fields.');
  } finally {
    if(target.ats==='workable')await page.removeLocatorHandler(cookieDialog).catch(()=>{});
    disposeResumeArtifact(sources.resumeIntent.artifact);
    if(input.learningRoot){mkdirSync(input.learningRoot,{recursive:true});writeFileSync(join(input.learningRoot,'hosted-questions.json'),JSON.stringify({ats:target.ats,questions:history},null,2));}
  }
}
