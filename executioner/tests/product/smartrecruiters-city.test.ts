import assert from 'node:assert/strict';
import test from 'node:test';
import type { parseApplicationProfile } from '../../src/profile/application-profile.ts';
import { chromium } from 'playwright';
import { verifiedScreeningTransition } from '../../src/product/extension-bridge.ts';
import { prepareCurrentPage } from '../../src/product/current-page-workflow.ts';
import { advanceSmartRecruiters } from '../../src/product/smartrecruiters-workflow.ts';
import { fillVisibleFields } from '../../extension/generic-fill.js';
import { applicantProfile, effectiveProfileFacts, productSources } from '../../src/product/sources.ts';
import { disposeResumeArtifact } from '../../src/contracts/resume-artifact.ts';
import { createPageAnswerPlanner } from '../../src/product/page-answer-planner.ts';

test('a postal dropdown selects only a unique match for the saved code', async () => {
  const profile = applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid',postal_code:'K1A 0B1'});
  const sources = productSources(profile, Buffer.from('%PDF-fixture'));
  try {
    const plan = createPageAnswerPlanner(sources, effectiveProfileFacts(profile), 'Fixture');
    const propose = (options: string[], selected = '') => {
      const row = {pageId:'page',fieldId:'postal',signature:'postal',question:'Postal code / zip code*',
        required:true,control:'listbox',selected,valid:Boolean(selected),queryable:true,options};
      return plan(row, [row], AbortSignal.timeout(5000));
    };
    assert.equal((await propose([])).query, 'K1A 0B1');
    assert.equal((await propose(['K1A0B2','K1A0B1'])).answer, 'K1A0B1');
    assert.equal((await propose(['K1A0B1','K1A 0B1'])).answer, null);
    assert.equal((await propose(['K1A0B2'])).answer, null);
    assert.equal((await propose(['K1A0B1'], 'K1A 0B2')).answer, null);
    assert.equal((await propose([], 'K1A0B1')).answer, 'K1A0B1');
  } finally { disposeResumeArtifact(sources.resumeIntent.artifact); }
});

test('OneClick city search verifies the selected location and supports Undo and Redo', async () => {
  const browser = await chromium.launch({headless:true});
  const profile = applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid',city:'Example',region:'Ontario',country:'Canada'});
  const facts = effectiveProfileFacts(profile);
  const sources = productSources(profile, Buffer.from('%PDF-fixture'));
  const plan = createPageAnswerPlanner(sources,facts,'Fixture');
  try {
    const page = await browser.newPage();
    const url = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/12345678-1111-2222-3333-111111111111';
    await page.route(url, route => route.fulfill({contentType:'text/html',body:
      '<main><oc-oneclick-form><h2>Personal information</h2><label>First Name<input></label><label>Email<input type=email></label>' +
      '<oc-location-autocomplete><spl-autocomplete id="city" label="City" data-test="location-autocomplete"></spl-autocomplete></oc-location-autocomplete>' +
      '<oc-resume-upload><spl-dropzone data-test="resume-upload"><label>Resume<input type=file></label></spl-dropzone></oc-resume-upload></oc-oneclick-form></main>'}));
    await page.goto(url);
    await page.evaluate(() => {
      const host = document.querySelector('spl-autocomplete')!;
      const root = host.attachShadow({mode:'open'});
      root.innerHTML = '<input aria-label="City*" required role=combobox aria-autocomplete=list aria-controls="city-list" aria-expanded=false aria-invalid=true>' +
        '<spl-icon role=button aria-label="Clear City value" hidden>Clear</spl-icon><div id="city-list" role=listbox hidden></div>';
      const input = root.querySelector('input')!, menu = root.querySelector<HTMLElement>('[role=listbox]')!, clear = root.querySelector<HTMLElement>('spl-icon')!;
      const close = () => { input.setAttribute('aria-expanded','false'); menu.hidden = true; };
      input.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
      input.addEventListener('input', () => {
        menu.replaceChildren();
        if (!input.value) { close(); return; }
        input.setAttribute('aria-expanded','true'); menu.hidden = false;
        for (const label of ['Example, Ontario, Canada','Example, Ohio, United States']) {
          const option = document.createElement('spl-select-option');
          option.innerHTML = '<div class="c-spl-autocomplete-default-option"><div data-sr-id="example-content"><spl-truncate></spl-truncate></div></div>';
          const title = option.querySelector<HTMLElement>('spl-truncate')!;
          title.title = label; title.textContent = label;
          const item = document.createElement('spl-dropdown-item');
          const forwardingRoot = option.attachShadow({mode:'open'});
          forwardingRoot.append(item);
          item.append(document.createElement('slot'));
          const shadow = item.attachShadow({mode:'open'});
          shadow.innerHTML = '<div role=option aria-disabled=false><slot></slot></div>';
          shadow.querySelector('div')!.onclick = () => {
            input.value = label; host.setAttribute('value','[object Object]');
            clear.hidden = false; input.setAttribute('aria-invalid','false'); close();
          };
          menu.append(option);
        }
      });
      clear.onclick = () => {
        input.value = ''; host.removeAttribute('value'); clear.hidden = true;
        input.setAttribute('aria-invalid','true'); menu.replaceChildren(); close();
      };
    });
    const city = async () => {
      const status = await page.evaluate(fillVisibleFields,{facts,action:'status' as const});
      const row = status.matching?.find(field => field.question === 'City*');
      assert.ok(row, JSON.stringify(status.matching?.map(r=>r.question)));
      return row;
    };
    const initial = await city();
    assert.equal(initial.queryable,true);
    const signal = new AbortController().signal;
    const search = await plan(initial,[initial],signal);
    assert.equal(search.query,'Example');
    await page.evaluate(fillVisibleFields,{facts,matchingPlans:[search]});
    const options = await city();
    assert.equal(options.selected,'');
    const selection = await plan(options,[options],signal);
    const answer = 'Example, Ontario, Canada';
    assert.equal(selection.answer,answer);
    const filled = await page.evaluate(fillVisibleFields,{facts,matchingPlans:[selection]});
    assert.deepEqual(filled.filled,['City*'],JSON.stringify(filled.skipped));
    assert.equal((await city()).selected,answer);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('input[role=combobox]').inputValue(),'');
    assert.equal(await page.locator('spl-autocomplete').getAttribute('value'),null);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});
    assert.equal((await city()).selected,answer);
    await page.locator('input[role=combobox]').evaluate((el:HTMLInputElement) => { el.value = 'Owner edit'; });
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/changed/i);
    assert.equal(await page.locator('input[role=combobox]').inputValue(),'Owner edit');
  } finally { disposeResumeArtifact(sources.resumeIntent.artifact); await browser.close(); }
});

test('only the queued OneClick personal footer advances and the final action remains untouched', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const url = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/abcd1234-1111-2222-3333-111111111111';
    await page.route(url,route=>route.fulfill({contentType:'text/html',body:
      '<main><oc-oneclick-form><oc-personal-information></oc-personal-information><oc-nav-first-page>' +
      '<footer data-test=footer><oc-button data-test=footer-next><spl-button>Next</spl-button></oc-button></footer></oc-nav-first-page></oc-oneclick-form></main>'}));
    const openPersonal = async () => {
      await page.goto(url);
      await page.evaluate(() => {
        const host = document.querySelector('spl-button')!;
        host.attachShadow({mode:'open'}).innerHTML = '<button type=button><slot></slot></button>';
        (globalThis as any).__huntC3PartialFill = {busy:false,undo:[],redo:[]};
        (globalThis as any).submissions = 0;
        host.addEventListener('click', () => {
          history.pushState({},'',location.pathname+'/screening');
          document.querySelector('main')!.innerHTML = '<oc-screening-questions><h2>Preliminary questions</h2><oc-screening-questions-form>' +
            '<label>Years of experience<input required></label></oc-screening-questions-form><oc-nav-screening-questions>' +
            '<oc-button data-test=footer-submit><spl-button>Submit</spl-button></oc-button></oc-nav-screening-questions></oc-screening-questions>';
          document.querySelector('spl-button')!.attachShadow({mode:'open'}).innerHTML='<button type=button><slot></slot></button>';
          document.querySelector('spl-button')!.shadowRoot!.querySelector('button')!.onclick = () => { (globalThis as any).submissions++; };
        });
      });
    };
    await openPersonal();
    const report = {skipped:[{reason:'resume_filename_visible_contents_unverified'}],resume:'unverified',
      componentFailure:{component:'uploads' as const,operation:'verify_attachment'}};
    const signal = new AbortController().signal;
    const screeningTransition=(url:string)=>verifiedScreeningTransition(page,url);
    const next = page.locator('spl-button button');
    await next.evaluate((e:HTMLButtonElement)=>{ e.type='submit'; });
    assert.equal(await advanceSmartRecruiters(page,url,report,signal,screeningTransition),undefined);
    await next.evaluate((e:HTMLButtonElement)=>{ e.type='button'; });
    assert.equal(await advanceSmartRecruiters(page,url,{...report,skipped:[{reason:'value_not_accepted'}]},signal,screeningTransition),undefined);
    assert.equal(await advanceSmartRecruiters(page,url,{...report,componentFailure:{component:'uploads',operation:'upload'}},signal,screeningTransition),undefined);
    assert.equal(await advanceSmartRecruiters(page,url,{...report,skipped:[...report.skipped,{reason:'value_not_accepted'}]},signal,screeningTransition),undefined);
    assert.equal(await advanceSmartRecruiters(page,url,report,signal),undefined);
    assert.equal(page.url(),url);
    assert.deepEqual(await advanceSmartRecruiters(page,url,report,signal,screeningTransition),{screeningUrl:url+'/screening'});
    const field = (await page.evaluate(fillVisibleFields,{action:'status' as const})).matching?.find(row=>row.question==='Years of experience');
    assert.ok(field);
    const result=await page.evaluate(fillVisibleFields,{matchingPlans:[{fieldId:field.fieldId,signature:field.signature,answer:'3',provisional:false,reason:'test_fact'}]});
    assert.deepEqual(result.filled,['Years of experience']);
    assert.equal(result.resume,'unverified');
    assert.match(String(await advanceSmartRecruiters(page,page.url(),report,signal)??''),/final submission button/);
    assert.equal(await page.evaluate(()=>(globalThis as any).submissions),0);
    await openPersonal();
    await next.evaluate((button:HTMLButtonElement)=>{
      const click=button.click.bind(button);
      button.click=()=>{click();throw new Error('fixture lost action acknowledgement');};
    });
    assert.match(String(await advanceSmartRecruiters(page,url,report,signal,screeningTransition)),/attempted Next.*employer step/);
    assert.equal(page.url(),url+'/screening');
    assert.equal(await page.evaluate(()=>(globalThis as any).submissions),0);
    await openPersonal();
    const interrupted = new AbortController();
    page.once('framenavigated',()=>interrupted.abort());
    assert.match(String(await advanceSmartRecruiters(page,url,report,interrupted.signal,screeningTransition)),/clicked Next once.*screening step/);
    assert.equal(page.url(),url+'/screening');
    assert.equal(await page.evaluate(()=>(globalThis as any).submissions),0);
  } finally { await browser.close(); }
});


test('queued screening choices require independent backing and the popup preserves them', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const url = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/abcd1234-1111-2222-3333-111111111111/screening';
    await page.route(url,route=>route.fulfill({contentType:'text/html',body:
      '<main><oc-screening-questions><h1>Preliminary questions</h1><oc-screening-questions-form>' +
      '<sr-screening-questions-form data-test=screening-questions-form><sr-question-field-radio><spl-radio-group required value="">' +
      '<span slot=label-content>Eligible for the role?</span><spl-radio label=Yes role=radio value=1 aria-checked=false aria-disabled=false>Yes</spl-radio>' +
      '<spl-radio label=No role=radio value=0 aria-checked=false aria-disabled=false>No</spl-radio></spl-radio-group></sr-question-field-radio>' +
      '<sr-question-field-select><spl-autocomplete id=question_past></spl-autocomplete></sr-question-field-select></sr-screening-questions-form>' +
      '</oc-screening-questions-form><oc-consent-decisions><spl-checkbox data-test=consent-box><span slot=label-content>Employer privacy notice</span></spl-checkbox>' +
      '</oc-consent-decisions><oc-nav-screening-questions><button>Submit</button></oc-nav-screening-questions></oc-screening-questions></main>'}));
    await page.goto(url);
    await page.evaluate(() => {
      const group=document.querySelector('spl-radio-group')!;
      group.attachShadow({mode:'open'}).innerHTML='<slot name=label-content></slot><fieldset role=radiogroup aria-required=true><slot></slot></fieldset>';
      for (const node of group.querySelectorAll('spl-radio')) node.addEventListener('click',()=> {
        group.setAttribute('value',node.getAttribute('value')!);
        for (const peer of group.querySelectorAll('spl-radio')) peer.setAttribute('aria-checked',String(peer===node));
      });
      const consent=document.querySelector('spl-checkbox')!;
      consent.attachShadow({mode:'open'}).innerHTML='<slot name=label-content></slot><label>*<input type=checkbox aria-required=true></label>';
      const rows=[{fieldValue:'a',id:'a',label:'Non | No'},{fieldValue:'b',id:'b',label:'Oui | Yes'}];
      document.querySelector('sr-screening-questions-form')!.setAttribute('definition',JSON.stringify({questions:[
        {id:'past',label:'Former employee?',type:'select',required:true,fields:[{multipleChoice:false,questionsFieldValues:rows}]}]}));
      const host=document.querySelector('spl-autocomplete')!;
      const root=host.attachShadow({mode:'open'});
      root.innerHTML='<input role=combobox id=question_past aria-required=true aria-invalid=false aria-controls=menu aria-expanded=false><spl-icon role=button aria-label="Clear value" hidden>Clear</spl-icon><div id=menu role=listbox hidden></div>';
      const input=root.querySelector('input')!, menu=root.querySelector<HTMLElement>('[role=listbox]')!;
      input.onclick=()=>{input.setAttribute('aria-expanded','true');menu.hidden=false;};
      const clear=root.querySelector<HTMLElement>('[aria-label="Clear value"]')!;
      clear.onclick=()=>{
        input.value='';(host as HTMLElement & {value:unknown}).value=undefined;
        host.removeAttribute('value');clear.hidden=true;
      };
      for (const row of rows) {
        const node=document.createElement('spl-dropdown-item');
        node.innerHTML='<div class="c-spl-autocomplete-default-option"><div class="c-spl-autocomplete-option-content"><spl-truncate></spl-truncate></div></div>';
        const title=node.querySelector<HTMLElement>('spl-truncate')!;
        title.title=row.label;title.textContent=row.label;
        node.attachShadow({mode:'open'}).innerHTML='<div role=option aria-disabled=false><slot></slot></div>';
        node.onclick=()=>{
          input.value=row.label;input.setAttribute('aria-expanded','false');menu.hidden=true;
          (host as HTMLElement & {value:unknown}).value={value:row.id};
          host.setAttribute('value','[object Object]');clear.hidden=false;
        };
        menu.append(node);
      }
    });
    const snapshot=async()=> (await page.evaluate(fillVisibleFields,{action:'status' as const})).matching!;
    const initial=await snapshot();
    assert.deepEqual(initial.map(row=>row.question).sort(),['Eligible for the role?','Employer privacy notice','Former employee?'].sort());
    const plans=initial.filter(row=>row.control!=='checkbox').map(row=>({fieldId:row.fieldId,signature:row.signature,
      answer:row.control==='radio'?'Yes':'Non | No',provisional:false,reason:'saved_fact'}));
    const popup=await page.evaluate(fillVisibleFields,{matchingPlans:plans});
    assert.deepEqual(popup.filled,[]);
    assert.equal((await snapshot()).filter(row=>row.selected).length,0);
    const queued=await page.evaluate(fillVisibleFields,{matchingPlans:plans,queuedScreening:true});
    assert.deepEqual(queued.filled.sort(),['Eligible for the role?','Former employee?'],JSON.stringify(queued.skipped));
    const selected=await snapshot();
    assert.equal(selected.find(row=>row.control==='radio')?.selected,'Yes');
    assert.equal(selected.find(row=>row.control==='listbox')?.selected,'Non | No');
    const undoChoice=()=>page.evaluate(fillVisibleFields,{action:'undo' as const});
    const redoChoice=()=>page.evaluate(fillVisibleFields,{action:'redo' as const});
    const choice=page.locator('spl-autocomplete input');
    assert.deepEqual((await undoChoice()).filled,['Former employee?']);
    assert.equal(await choice.inputValue(),'');
    assert.equal((await snapshot()).find(row=>row.control==='radio')?.selected,'Yes');
    assert.deepEqual((await redoChoice()).filled,['Former employee?']);
    assert.equal(await choice.inputValue(),'Non | No');
    const clearChoice=page.getByRole('button',{name:'Clear value'});
    await clearChoice.evaluate(button=>button.setAttribute('aria-disabled','true'));
    await assert.rejects(undoChoice(),/edits were preserved/);
    await clearChoice.evaluate(button=>button.removeAttribute('aria-disabled'));
    await page.evaluate(()=>history.pushState({},'',location.pathname+'?another-draft'));
    await assert.rejects(undoChoice(),/edits were preserved/);
    await page.evaluate(()=>history.replaceState({},'',location.pathname));
    await choice.click();
    await page.getByRole('option',{name:'Oui | Yes'}).click();
    await assert.rejects(undoChoice(),/edits were preserved/);
    assert.equal(await choice.inputValue(),'Oui | Yes');
    await choice.click();
    await page.getByRole('option',{name:'Non | No'}).click();
    await undoChoice();

    // Stop the C3 run immediately after the employer commits the selection.
    const expiresAt=await page.evaluate(()=>{
      const deadline=Date.now()+60000;
      (globalThis as any).savedNow=Date.now;
      document.querySelector('spl-autocomplete')!.shadowRoot!.querySelector('spl-dropdown-item')!
        .addEventListener('click',()=>{Date.now=()=>deadline+1;},{once:true});
      return deadline;
    });
    await assert.rejects(page.evaluate(fillVisibleFields,{matchingPlans:plans,queuedScreening:true,expiresAt}),/expired/);
    await page.evaluate(()=>{Date.now=(globalThis as any).savedNow;});
    assert.equal(await choice.inputValue(),'Non | No');
    assert.deepEqual((await undoChoice()).filled,['Former employee?']);
    await redoChoice();
    const checkbox=selected.find(row=>row.control==='checkbox')!;
    const consent=await page.evaluate(fillVisibleFields,{matchingPlans:[{fieldId:checkbox.fieldId,signature:checkbox.signature,answer:true,provisional:false,reason:'saved_consent'}]});
    assert.deepEqual(consent.filled,['Employer privacy notice']);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('input[type=checkbox]').isChecked(),false);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});
    await page.locator('spl-checkbox').evaluate(host=>{
      host.querySelector('[slot=label-content]')!.textContent='You declare that you have read and agree to the privacy notice of Fixture.';
      (globalThis as any).consentUpdates=0;
      host.shadowRoot!.querySelector('input')!.addEventListener('change',()=>{(globalThis as any).consentUpdates++;});
    });
    const checked=(await snapshot()).find(row=>row.control==='checkbox')!;
    for (const granted of [true,false]) {
      const base=applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid'}) as {profile: ReturnType<typeof parseApplicationProfile>};
      const profile={...base,profile:{...base.profile,unsetFactIds:base.profile.unsetFactIds.filter(id=>id!=='terms_consent'),facts:[...base.profile.facts,{factId:'terms_consent',value:granted,provenance:'owner_provided',lane:'live_owner_fact'}]}};
      const sources=productSources(profile,Buffer.from('%PDF-fixture'));
      try {
        const planner=createPageAnswerPlanner(sources,effectiveProfileFacts(profile),'Fixture');
        const compare=await planner(checked,[checked],new AbortController().signal);
        assert.equal(compare.answer,granted);
        const result=await page.evaluate(fillVisibleFields,{matchingPlans:[compare]});
        assert.ok(result.skipped.some(row=>row.label===checked.question && row.reason===(granted?'saved_value_already_present':'saved_value_conflict')));
        assert.equal(await page.locator('input[type=checkbox]').isChecked(),true);
        assert.equal(await page.evaluate(()=>(globalThis as any).consentUpdates),0);
      } finally {disposeResumeArtifact(sources.resumeIntent.artifact);}
    }
    const untouched=await page.evaluate(fillVisibleFields,{matchingPlans:[]});
    const observation=untouched.matching?.find(row=>row.fieldId===checked.fieldId);
    assert.ok(observation);
    assert.equal(Object.hasOwn(observation,'chosenAnswer'),false);
    assert.equal(Object.hasOwn(observation,'reason'),false);
    await page.locator('spl-autocomplete').evaluate((host:any)=>{host.value=undefined;});
    assert.equal((await snapshot()).find(row=>row.control==='listbox')?.selected,'');
    await page.locator('spl-radio-group').evaluate(group=>{
      group.setAttribute('value','');
      for(const radio of group.querySelectorAll('spl-radio')) radio.setAttribute('aria-checked','false');
      group.querySelector('span')!.textContent='Vérification d’emploi | If advanced to an offer, you consent to respecting the employment verification and background check process.';
    });
    const profile=applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'fixture@example.invalid'});
    await assert.rejects(prepareCurrentPage(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(10000),()=>{}),
      /Employment verification and background check consent: choose your answer on the employer page/);
    assert.equal(await page.locator('spl-radio-group').getAttribute('value'),'');

  } finally {await browser.close();}
});
