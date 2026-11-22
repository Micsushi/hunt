import assert from 'node:assert/strict';
import test from 'node:test';
import type { parseApplicationProfile } from '../../src/profile/application-profile.ts';
import { chromium } from 'playwright';
import { verifiedScreeningTransition } from '../../src/product/extension-bridge.ts';
import { prepareCurrentPage } from '../../src/product/current-page-workflow.ts';
import { advanceSmartRecruiters } from '../../src/product/smartrecruiters-workflow.ts';
import { fillVisibleFields } from '../../extension/generic-fill.js';
import { observePageSource } from '../../extension/page-runtime/serialize.js';
import { applicantProfile, effectiveProfileFacts, productSources } from '../../src/product/sources.ts';
import { disposeResumeArtifact } from '../../src/contracts/resume-artifact.ts';
import { createPageAnswerPlanner } from '../../src/product/page-answer-planner.ts';

test('a postal dropdown selects only a unique match for the saved code', async () => {
  const profile = applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid',
    postal_code:'K1A 0B1',city:'Ottawa',region:'Ontario',country:'Canada'});
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
    const saved = 'K1A 0B1, Ottawa, ON, CA';
    const conflicts = ['K1A 0B2, Ottawa, ON, CA','K1A 0B1, Toronto, ON, CA',
      'K1A 0B1, Ottawa, QC, CA','K1A 0B1, Ottawa, ON, US','K1A 0B1, Ottawa, CA'];
    assert.equal((await propose([...conflicts, saved])).answer, saved);
    assert.equal((await propose([], saved)).answer, saved);
    assert.equal((await propose(conflicts)).answer, null);
    assert.equal((await propose([saved, 'K1A0B1, Ottawa, Ontario, Canada'])).answer, null);
    assert.equal((await propose([saved], conflicts[1])).answer, null);
  } finally { disposeResumeArtifact(sources.resumeIntent.artifact); }
});

for (const scenario of [
  {field:'City',query:'Example',options:['Example, Ontario, Canada','Example, Ohio, United States'],delay:0},
  {field:'Postal code / zip code',query:'K1A 0B1',options:['K1A 0B1, Example, ON, CAN'],delay:250},
]) test(`OneClick ${scenario.field} verifies the selected location and supports Undo and Redo`, async () => {
  const browser = await chromium.launch({headless:true});
  const profile = applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid',city:'Example',region:'Ontario',country:'Canada',postal_code:'K1A 0B1'});
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
    await page.evaluate(({field,options,delay}) => {
      const host = document.querySelector<HTMLElement>('spl-autocomplete')!;
      host.setAttribute('label',field);
      const root = host.attachShadow({mode:'open'});
      root.innerHTML = '<input aria-label="City*" required role=combobox aria-autocomplete=list aria-controls="city-list" aria-expanded=false aria-invalid=true>' +
        '<spl-icon role=button aria-label="Clear City value" hidden>Clear</spl-icon><div id="city-list" role=listbox hidden></div>';
      const input = root.querySelector('input')!, menu = root.querySelector<HTMLElement>('[role=listbox]')!, clear = root.querySelector<HTMLElement>('spl-icon')!;
      input.setAttribute('aria-label',field+'*');
      clear.setAttribute('aria-label','Clear '+field+' value');
      const close = () => { input.setAttribute('aria-expanded','false'); menu.hidden = true; };
      input.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
      input.addEventListener('input', () => {
        menu.replaceChildren();
        if (!input.value) { close(); return; }
        input.setAttribute('aria-expanded','true'); menu.hidden = false;
        for (const label of options) {
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
            close();
            host.dataset.clicks = String(Number(host.dataset.clicks ?? 0)+1);
            setTimeout(() => { clear.hidden = false; input.setAttribute('aria-invalid','false'); },delay);
          };
          menu.append(option);
        }
      });
      clear.onclick = () => {
        input.value = ''; host.removeAttribute('value'); clear.hidden = true;
        input.setAttribute('aria-invalid','true'); menu.replaceChildren(); close();
      };
    },scenario);
    const location = async () => {
      const status = await page.evaluate(fillVisibleFields,{facts,action:'status' as const});
      const row = status.matching?.find(field => field.question === scenario.field+'*');
      assert.ok(row, JSON.stringify(status.matching?.map(r=>r.question)));
      return row;
    };
    const initial = await location();
    assert.equal(initial.queryable,true);
    const signal = new AbortController().signal;
    const search = await plan(initial,[initial],signal);
    assert.equal(search.query,scenario.query);
    await page.evaluate(fillVisibleFields,{facts,matchingPlans:[search]});
    const options = await location();
    assert.equal(options.selected,'');
    const selection = await plan(options,[options],signal);
    const answer = scenario.options[0];
    assert.equal(selection.answer,answer);
    const filled = await page.evaluate(fillVisibleFields,{facts,matchingPlans:[selection]});
    assert.deepEqual(filled.filled,[scenario.field+'*'],JSON.stringify(filled.skipped));
    assert.equal((await location()).selected,answer);
    assert.equal(await page.locator('spl-autocomplete').getAttribute('data-clicks'),'1');
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('input[role=combobox]').inputValue(),'');
    assert.equal(await page.locator('spl-autocomplete').getAttribute('value'),null);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});
    assert.equal((await location()).selected,answer);
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
    assert.match(String(await advanceSmartRecruiters(page,page.url(),report,signal)??''),/final submission button is enabled/);
    const screeningUrl = page.url();
    const inspect = (expected = screeningUrl) => page.evaluate<{kind:string;signals:string[];screeningSubmissionControl?:string}>(`(${observePageSource})(${JSON.stringify(expected)})`);
    const final = page.locator('oc-nav-screening-questions spl-button button');
    const enabled = await inspect();
    assert.equal(enabled.kind,'application');
    assert.equal(enabled.screeningSubmissionControl,'enabled');
    assert.ok(enabled.signals.includes('submission_control'));
    assert.equal((await inspect(url)).screeningSubmissionControl,undefined);
    for (const [control,css] of [[final,'width:0;height:0;padding:0;border:0'],[final,'opacity:0'],
      [page.locator('oc-nav-screening-questions spl-button'),'opacity:0'],[page.locator('main'),'opacity:0']] as const) {
      await control.evaluate((e,css)=>e.setAttribute('style',css),css);
      assert.equal((await inspect()).screeningSubmissionControl,'unknown');
      assert.equal(await advanceSmartRecruiters(page,screeningUrl,report,signal),undefined);
      await control.evaluate(e=>e.removeAttribute('style'));
    }
    await final.evaluate((el:HTMLButtonElement)=>{el.disabled=true;});
    assert.equal((await inspect()).screeningSubmissionControl,'disabled');
    assert.match(String(await advanceSmartRecruiters(page,screeningUrl,report,signal)),/submission disabled/);
    await final.evaluate((el:HTMLButtonElement)=>{el.disabled=false;});
    await page.locator('oc-nav-screening-questions').evaluate(nav=>nav.appendChild(nav.firstElementChild!.cloneNode(true)));
    assert.equal((await inspect()).screeningSubmissionControl,'unknown');
    assert.equal((await inspect()).signals.includes('submission_control'),false);
    assert.equal(await advanceSmartRecruiters(page,screeningUrl,report,signal),undefined);
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


test('direct screening fills reversible listboxes and leaves radios to the queue', async () => {
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
        for (const option of menu.querySelectorAll('spl-dropdown-item')) {
          const state=option.shadowRoot!.querySelector('[role=option]')!;
          if (state.hasAttribute('aria-selected'))state.setAttribute('aria-selected','false');
        }
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
          for (const option of menu.querySelectorAll('spl-dropdown-item')) {
            const state=option.shadowRoot!.querySelector('[role=option]')!;
            if (state.hasAttribute('aria-selected'))state.setAttribute('aria-selected',String(option===node));
          }
        };
        menu.append(node);
      }
    });
    const snapshot=async()=> (await page.evaluate(fillVisibleFields,{action:'status' as const})).matching!;
    const initial=await snapshot();
    assert.deepEqual(initial.map(row=>row.question).sort(),['Eligible for the role?','Employer privacy notice','Former employee?'].sort());
    const plansFor=(rows:typeof initial)=>rows.filter(row=>row.control!=='checkbox').map(row=>({fieldId:row.fieldId,signature:row.signature,
      answer:row.control==='radio'?'Yes':'Non | No',provisional:false,reason:'saved_fact'}));
    const cdp=await page.context().newCDPSession(page);
    const {frameTree}=await cdp.send('Page.getFrameTree');
    const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'screening-popup'});
    const directAction=async (input:Parameters<typeof fillVisibleFields>[0]):Promise<Awaited<ReturnType<typeof fillVisibleFields>>>=>{
      const response=await cdp.send('Runtime.evaluate',{contextId:executionContextId,awaitPromise:true,returnByValue:true,
        expression:'('+fillVisibleFields.toString()+')('+JSON.stringify({...input,scope:'page',expectedUrl:url})+')'});
      if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
      return response.result.value;
    };
    const directPlans=plansFor((await directAction({action:'status'})).matching!);
    const popup=()=>directAction({matchingPlans:directPlans});
    const choice=page.locator('spl-autocomplete input');
    const clear=page.locator('spl-autocomplete [aria-label="Clear value"]');
    const backing=()=>page.locator('spl-autocomplete').evaluate((host:Element & {value?:{value:string}})=>host.value?.value ?? '');
    assert.deepEqual((await popup()).filled,[]);
    assert.equal(await backing(),'');
    assert.equal(await choice.getAttribute('aria-expanded'),'false');
    const publishSelection=(id:string)=>page.locator('spl-autocomplete').evaluate((host:Element & {value?:{value:string}},id)=>{
      const options=host.shadowRoot!.querySelectorAll('spl-dropdown-item');
      [...options].forEach((option,index)=>option.shadowRoot!.querySelector('[role=option]')!
        .setAttribute('aria-selected',String(id===['a','b'][index])));
      if(id)host.value={value:id};
    },id);
    await publishSelection('');
    await clear.evaluate(node=>node.setAttribute('aria-disabled','true'));
    assert.deepEqual((await popup()).filled,[]);
    assert.equal(await backing(),'');
    assert.equal(await choice.getAttribute('aria-expanded'),'false');
    await clear.evaluate(node=>node.removeAttribute('aria-disabled'));
    await clear.evaluate(node=>node.removeAttribute('aria-label'));
    assert.deepEqual((await popup()).filled,[]);
    assert.equal(await backing(),'');
    assert.equal(await choice.getAttribute('aria-expanded'),'false');
    await page.locator('spl-autocomplete spl-icon').evaluate(node=>node.setAttribute('aria-label','Clear value'));

    const direct=await popup();
    assert.deepEqual(direct.filled,['Former employee?']);
    assert.equal(await backing(),'a');
    const host=page.locator('spl-autocomplete');
    const selectedLabel=async()=> (await directAction({action:'status'})).matching?.find(row=>row.control==='listbox')?.selected;
    await host.evaluate((el:Element & {value?:{value:string}})=>{
      el.value={value:'retired-id'};el.setAttribute('value','retired-id');
    });
    assert.equal(await selectedLabel(),'');
    await assert.rejects(directAction({action:'undo'}),/edits were preserved/);
    assert.equal(await backing(),'retired-id');
    await publishSelection('a');
    for (const reflection of [null,'','[object Object]','a']) {
      await host.evaluate((el,value)=>value===null?el.removeAttribute('value'):el.setAttribute('value',value),reflection);
      assert.equal(await selectedLabel(),'Non | No');
      await publishSelection('');
      assert.equal(await selectedLabel(),'');
      await publishSelection('a');
    }
    assert.equal((await snapshot()).find(row=>row.control==='radio')?.selected,'');
    assert.equal(page.url(),url);
    assert.deepEqual((await directAction({action:'undo'})).filled,['Former employee?']);
    assert.equal(await backing(),'');
    await clear.evaluate(node=>node.setAttribute('aria-disabled','true'));
    await assert.rejects(directAction({action:'redo'}),/edits were preserved/);
    assert.equal(await backing(),'');
    await clear.evaluate(node=>node.removeAttribute('aria-disabled'));
    assert.deepEqual((await directAction({action:'redo'})).filled,['Former employee?']);
    assert.equal(await backing(),'a');
    await publishSelection('b');
    assert.equal(await choice.inputValue(),'Non | No','display can remain stale after backing changes');
    await assert.rejects(directAction({action:'undo'}),/edits were preserved/);
    assert.equal(await backing(),'b');
    await choice.click();
    await page.getByRole('option',{name:'Oui | Yes'}).click();
    await assert.rejects(directAction({action:'undo'}),/edits were preserved/);
    assert.equal(await backing(),'b');
    assert.equal((await popup()).filled.length,0);
    assert.equal(await backing(),'b');
    await choice.click();
    await page.getByRole('option',{name:'Non | No'}).click();
    await directAction({action:'undo'});
    await cdp.detach();
    const plans=plansFor(initial);
    const undoChoice=()=>page.evaluate(fillVisibleFields,{action:'undo' as const});
    const redoChoice=()=>page.evaluate(fillVisibleFields,{action:'redo' as const});
    const queued=await page.evaluate(fillVisibleFields,{matchingPlans:plans,queuedScreening:true});
    assert.deepEqual(queued.filled.sort(),['Eligible for the role?','Former employee?'],JSON.stringify(queued.skipped));
    const selected=await snapshot();
    assert.equal(selected.find(row=>row.control==='radio')?.selected,'Yes');
    assert.equal(selected.find(row=>row.control==='listbox')?.selected,'Non | No');
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

test('screening leaves certifications and conviction disclosures for the owner', async () => {
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    const url='https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/abcd1234-1111-2222-3333-111111111111/screening';
    const conviction='Have you ever been convicted of a criminal offence for which you have not received a pardon?';
    const radioGroup=(id:string,question:string,selected='',values=['1','0'])=>
      '<sr-question-field-radio><spl-radio-group id="'+id+'" value="'+selected+'"><span slot="label-content">'+question+'</span>'+
        values.map(value=>'<spl-radio role="radio" aria-disabled="false" value="'+value+'" aria-checked="'+(value===selected)+
          '" label="'+(value==='1'?'Yes':'No')+'">'+(value==='1'?'Yes':'No')+'</spl-radio>').join('')+'</spl-radio-group></sr-question-field-radio>';
    await page.route('**/*',route=>route.request().url()===url?route.fulfill({contentType:'text/html',body:
      '<main><oc-screening-questions><oc-screening-questions-form><sr-screening-questions-form data-test="screening-questions-form">' +
      '<sr-question-field-checkbox><spl-checkbox id="accuracy"><span slot="label-content">I certify that the statements on my application are true and complete.</span></spl-checkbox></sr-question-field-checkbox>' +
      '<sr-question-field-checkbox><spl-checkbox id="already-checked"><span slot="label-content">I attest that my application is accurate.</span></spl-checkbox></sr-question-field-checkbox>' +
      '<sr-question-field-checkbox><spl-checkbox id="unknown"></spl-checkbox></sr-question-field-checkbox>' +
      radioGroup('conviction-existing','Have you ever had a criminal conviction?','0') +
      radioGroup('conviction',conviction) + radioGroup('conviction-reversed','Have you ever pled guilty to a felony?','',['0','1']) +
      radioGroup('casier','Avez-vous un casier judiciaire ?') +
      radioGroup('accuracy-statement','The statements in this application are true and complete.') +
      radioGroup('accuracy-single','All information on my application is accurate.') +
      radioGroup('accuracy-question','Is the information in your application correct?') +
      radioGroup('background','Are you willing to undergo a background check?') +
      '<label>Preferred orientation schedule<select required><option value="">Choose one</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option></select></label>' +
      '</sr-screening-questions-form></oc-screening-questions-form>' +
      '<oc-consent-decisions><spl-checkbox id="privacy" data-test="consent-box"><span slot="label-content">I agree to the privacy notice</span></spl-checkbox></oc-consent-decisions>' +
      '<oc-nav-screening-questions><oc-button data-test="footer-submit"><spl-button id="submit">Submit</spl-button></oc-button></oc-nav-screening-questions>' +
      '</oc-screening-questions></main>'}):route.abort());
    await page.goto(url);
    await page.evaluate(()=>{
      for(const host of document.querySelectorAll('spl-checkbox')) {
        const root=host.attachShadow({mode:'open'});
        root.innerHTML='<slot name="label-content"></slot><label>*<input type="checkbox" aria-required="true"></label>';
        const input=root.querySelector('input')!;
        if(host.id==='already-checked') input.checked=true;
        input.onchange=()=>host.setAttribute('data-changed','true');
      }
      for(const group of document.querySelectorAll('spl-radio-group')) {
        group.attachShadow({mode:'open'}).innerHTML='<slot name="label-content"></slot><fieldset role="radiogroup" aria-required="true"><slot></slot></fieldset>';
        for(const option of group.querySelectorAll('spl-radio')) option.addEventListener('click',()=>{
          group.setAttribute('value',option.getAttribute('value')!);
          group.setAttribute('data-changed','true');
          for(const peer of group.querySelectorAll('spl-radio')) peer.setAttribute('aria-checked',String(option===peer));
        });
      }
      const submit=document.querySelector('#submit')!;
      const footer=submit.attachShadow({mode:'open'});
      footer.innerHTML='<button type="button"><slot></slot></button>';
      footer.querySelector('button')!.onclick=()=>submit.setAttribute('data-clicked','true');
    });
    const base=applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid'}) as {profile:ReturnType<typeof parseApplicationProfile>};
    const profile={...base,profile:{...base.profile,unsetFactIds:base.profile.unsetFactIds.filter(id=>id!=='background_check_willing'),
      facts:[...base.profile.facts,{factId:'background_check_willing',value:true,provenance:'owner_provided',lane:'live_owner_fact'}]}};
    let pause: Error | undefined;
    try {
      await prepareCurrentPage(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{});
    } catch(error) {
      if(!(error instanceof Error)) throw error;
      pause=error;
    }
    assert.equal(await page.locator('#accuracy input').isChecked(),false);
    assert.equal(await page.locator('#unknown input').isChecked(),false);
    assert.equal(await page.locator('#already-checked input').isChecked(),true);
    assert.equal(await page.locator('#already-checked').getAttribute('data-changed'),null);
    assert.equal(await page.locator('#privacy input').isChecked(),true);
    for(const id of ['conviction','conviction-reversed','conviction-existing','casier','accuracy-statement','accuracy-single','accuracy-question']) {
      assert.equal(await page.locator('#'+id).getAttribute('value'),id==='conviction-existing'?'0':'');
      assert.equal(await page.locator('#'+id).getAttribute('data-changed'),null);
    }
    assert.equal(await page.locator('#background').getAttribute('value'),'1');
    assert.equal(await page.locator('select').inputValue(),'morning');
    assert.match(pause?.message??'',/I certify.*choose your answer on the employer page/i);
    assert.match(pause?.message??'',/had a criminal conviction\?: choose your answer on the employer page/i);
    assert.match(pause?.message??'',/convicted.*choose your answer on the employer page/i);
    assert.match(pause?.message??'',/Review suggested answers and unresolved fields/);
    assert.equal(await page.locator('#submit').getAttribute('data-clicked'),null);
    assert.equal(page.url(),url);
  } finally { await browser.close(); }
});
