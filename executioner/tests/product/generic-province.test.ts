import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,type Page} from 'playwright';
import {fillVisibleFields} from '../../extension/generic-fill.js';
import {bambooAddressForm} from './bamboo-address-fixture.ts';

const url='https://fixture.bamboohr.com/careers/123';
const facts=[{factId:'given_name',value:'Fixture'},{factId:'email_address',value:'fixture@example.invalid'},
  {factId:'country',value:'Canada'},{factId:'region',value:'Alberta'}];
async function fixture(page:Page,extra=''){
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<form id="job-application-form">
    <label>First name<input name="first"></label><label>Email<input type="email" name="email"></label>
    <button id="country" type="button" class="fab-SelectToggle" aria-label="Country Canada" onclick="window.countryTouches++">Canada</button>
    <div class="fab-SelectToggle__container" id="container"><button id="province" aria-required="true" type="button" class="fab-SelectToggle" aria-label="Province –Select–" data-menu-id="fab-menu101" aria-expanded="false"><span class="fab-SelectToggle__content">–Select–</span></button></div>
    <button type="button" onclick="window.submits++">Submit application</button></form>
    <div id="fab-menu101" class="fab-MenuList" role="menu" hidden><div role="menuitem">Alberta</div><div role="menuitem">Ontario</div>${extra}</div>
    <script>window.countryTouches=0;window.submits=0;window.clears=0;window.selections=0;
      const button=document.getElementById('province'),menu=document.getElementById('fab-menu101'),container=document.getElementById('container');
      const close=()=>{menu.hidden=true;button.setAttribute('aria-expanded','false');};
      window.setProvince=value=>{button.setAttribute('aria-label','Province '+value);button.querySelector('.fab-SelectToggle__content').textContent=value;
        container.querySelector('.fab-SelectToggle__clearButton')?.remove();
        if(value!=='–Select–'){const clear=document.createElement('button');clear.type='button';clear.className='fab-SelectToggle__clearButton';clear.setAttribute('aria-label','Clear Selection');clear.textContent='×';clear.onclick=()=>{window.clears++;window.setProvince('–Select–');};container.append(clear);}
        close();};
      button.onclick=event=>{if(event.detail===0&&!event.isPrimary)return;const open=button.getAttribute('aria-expanded')!=='true';menu.hidden=!open;button.setAttribute('aria-expanded',String(open));};
      button.onkeydown=e=>{if(e.key==='Escape')close();};
      menu.onclick=e=>{const option=e.target.closest('[role=menuitem]');if(option){window.selections++;window.setProvince(option.textContent);}};
    </script>`}));
  await page.goto(url);
}

test('Bamboo data-menu-id portal selects saved province and Clear Selection restores blank on Undo',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const radios=await browser.newPage();
    await radios.route(url,route=>route.fulfill({contentType:'text/html',body:`<form id="job-application-form">
      <label>First name<input name="first"></label><label>Email<input type=email></label>
      <fieldset role="radiogroup" aria-required="true" data-fabric-component="RadioGroup"><legend>Application question</legend>
      ${['Yes','No'].map(name=>`<label data-fabric-component="Radio"><span class="MuiRadio-root"><input type=radio name=question value="${name}"></span>${name}</label>`).join('')}
      </fieldset><button>Submit application</button></form>`}));
    await radios.goto(url);
    const yes=radios.getByLabel('Yes',{exact:true});
    await yes.evaluate((input:HTMLInputElement)=>{
      input.checked=true; // Previous C3 versions changed only the hidden input.
      input.addEventListener('click',()=>input.parentElement!.classList.add('Mui-checked'));
    });
    const readRadios=()=>radios.evaluate(fillVisibleFields,{scope:'page' as const,action:'status' as const});
    const prior=await readRadios();
    const question=prior.matching?.find(row=>row.control==='radio');
    assert.ok(question);
    assert.equal(question.selected,'');
    assert.ok(prior.requiredIssues?.some(issue=>issue.label==='Application question'));
    const plans=[{fieldId:question.fieldId,signature:question.signature,provisional:false,reason:'test_fact',answer:'Yes'}];
    await radios.evaluate(fillVisibleFields,{scope:'page' as const,matchingPlans:plans});
    assert.equal((await readRadios()).matching?.find(row=>row.control==='radio')?.selected,'Yes');
    assert.equal(await radios.locator('.Mui-checked input:checked').count(),1);
    const radioUndo=await radios.evaluate(fillVisibleFields,{scope:'page' as const,action:'undo' as const});
    assert.ok(radioUndo.skipped.some(row=>row.label==='Application question' && row.reason==='radio_reset_unavailable'));
    assert.equal(await radios.locator('.Mui-checked input:checked').count(),1);
    await radios.close();
    const page=await browser.newPage();await fixture(page);
    await page.locator('#province').evaluate((e:HTMLButtonElement)=>e.click());
    assert.equal(await page.locator('#province').getAttribute('aria-expanded'),'false','Fabric ignores a zero-detail programmatic click');
    const province = page.locator('#province');
    await province.evaluate(element => element.removeAttribute('aria-required'));
    const optional = await page.evaluate(fillVisibleFields, {facts});
    assert.ok(optional.skipped.some(row => row.label === 'Province' && row.reason === 'optional_field'));
    await province.evaluate(element => element.setAttribute('aria-required','true'));
    const inspection = await page.evaluate(fillVisibleFields, {facts, action:'status' as const});
    const row = inspection.matching?.find(field => field.widget === 'province-menu');
    assert.ok(row, 'the shared planner can identify this composite widget');
    const binding = {fieldId:row.fieldId, signature:row.signature, provisional:false, reason:'test_fact'};
    const declined = await page.evaluate(fillVisibleFields, {facts, matchingPlans:[{...binding, answer:null}]});
    assert.ok(!declined.filled.includes('Province'), 'explicit null plan preserves this field even with saved facts');
    const result = await page.evaluate(fillVisibleFields, {
      facts:facts.filter(fact => fact.factId !== 'region' && fact.factId !== 'country' && fact.factId !== 'phone_number'),
      matchingPlans:[{...binding, answer:'Alberta'}],
    });
    assert.ok(result.filled.includes('Province'));
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province Alberta');
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province –Select–');assert.equal(await page.evaluate('clears'),1);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province Alberta');
    assert.equal(await page.evaluate('countryTouches+submits'),0);assert.equal(await page.locator('#country').getAttribute('aria-label'),'Country Canada');
    await page.evaluate(()=>{(window as any).setProvince('Ontario');});
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/Fields changed/);
    assert.equal(await page.locator('#province').getAttribute('aria-label'),'Province Ontario');

    const dynamic = await browser.newPage();
    await dynamic.route(url, route => route.fulfill({contentType:'text/html; charset=utf-8', body:bambooAddressForm}));
    await dynamic.goto(url);
    const address = {scope:'page' as const,facts:[...facts,{factId:'postal_code',value:'T2P 1J9'}]};
    const zip = dynamic.locator('input[name="zip.value"]');
    const state = dynamic.locator('select[name="state.value"]');
    const country = dynamic.locator('select[name="countryId.value"]');
    const read = async () => [await country.inputValue(),await state.inputValue(),await zip.inputValue()];
    const preserved = await dynamic.evaluate(fillVisibleFields,address);
    assert.deepEqual(await read(),['1','','']);
    assert.equal(preserved.profileCountryConflict,true);
    assert.deepEqual(preserved.skipped.filter(row => ['Country','State','ZIP'].includes(row.label)),[{label:'Country',reason:'saved_value_conflict'}]);
    const pinnedCanada = await dynamic.evaluate(fillVisibleFields,{...address,currentProfileCountry:'United States'});
    assert.equal(pinnedCanada.profileCountryConflict,undefined);
    assert.deepEqual(await read(),['1','','']);
    assert.deepEqual(pinnedCanada.skipped.filter(row => ['Country','State','ZIP'].includes(row.label)),[{label:'Country',reason:'saved_value_conflict'}]);
    await dynamic.getByRole('button',{name:'State –Select–'}).click();
    await dynamic.getByRole('menuitem',{name:'Colorado'}).click();
    await zip.fill('80202');
    const corrected = await dynamic.evaluate(fillVisibleFields,{...address,useProfileCountry:true});
    assert.deepEqual(corrected.filled,['Country','Province','Postal Code']);
    assert.deepEqual(await read(),['2','20','T2P 1J9']);
    const undone = await dynamic.evaluate(fillVisibleFields,{...address,action:'undo' as const});
    assert.deepEqual(await read(),['1','11','80202']);
    assert.equal(undone.profileCountryConflict,true);
    const redone = await dynamic.evaluate(fillVisibleFields,{...address,action:'redo' as const});
    assert.equal(redone.profileCountryConflict,undefined);
    assert.deepEqual(await read(),['2','20','T2P 1J9']);
    await zip.fill('T3A 1J9');
    const declinedUndo = await dynamic.evaluate(fillVisibleFields,{...address,action:'undo' as const});
    assert.ok(declinedUndo.skipped.some(row => row.reason === 'bamboo_address_restore_unconfirmed'));
    assert.deepEqual(await read(),['2','20','T3A 1J9']);
    assert.equal(await dynamic.locator('input[name="streetAddress.value"]').inputValue(),'Owner street');
    assert.equal(await dynamic.locator('input[name="city.value"]').inputValue(),'Owner city');
    assert.equal(await dynamic.locator('form').getAttribute('data-submissions'),'0');
  }finally{await browser.close();}
});

test('existing province, ambiguous option and conflicting menu binding stay untouched',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const kind of ['existing','duplicate','wrong-binding'] as const){
      const page=await browser.newPage();await fixture(page,kind==='duplicate'?'<div role="menuitem">Alberta</div>':'');
      if(kind==='existing')await page.evaluate(()=>{(window as any).setProvince('Ontario');});
      if(kind==='wrong-binding')await page.locator('#province').evaluate(e=>e.setAttribute('aria-controls','wrong-menu'));
      const result=await page.evaluate(fillVisibleFields,{facts});assert.equal(result.filled.includes('Province'),false);
      assert.equal(await page.locator('#province').getAttribute('aria-label'),kind==='existing'?'Province Ontario':'Province –Select–');
      assert.equal(await page.evaluate('clears+selections+countryTouches+submits'),0);await page.close();
    }
    const unavailable = await browser.newPage();
    await unavailable.route(url,route => route.fulfill({contentType:'text/html; charset=utf-8',body:bambooAddressForm}));
    await unavailable.goto(url);
    const refused = await unavailable.evaluate(fillVisibleFields,{scope:'page' as const,useProfileCountry:true,
      facts:[{factId:'country',value:'Canada'},{factId:'region',value:'Missing province'},{factId:'postal_code',value:'T2P 1J9'}]});
    assert.ok(refused.skipped.some(row => row.reason === 'bamboo_address_change_unconfirmed'));
    assert.equal(await unavailable.locator('select[name="countryId.value"]').inputValue(),'1');
    assert.equal(await unavailable.locator('select[name="state.value"]').inputValue(),'');
    assert.equal(await unavailable.locator('input[name="zip.value"]').inputValue(),'');
    for (const broken of [
      bambooAddressForm.replace('item.onclick = () => choose(value)', 'item.onclick = () => choose(name === "countryId.value" ? "1" : value)'),
      bambooAddressForm.replace('setTimeout(() => region(value), 35)','setTimeout(() => { if (value === "1") region(value); }, 35)'),
    ]) {
      const page = await browser.newPage();
      await page.route(url,route => route.fulfill({contentType:'text/html; charset=utf-8',body:broken}));
      await page.goto(url);
      const failed = await page.evaluate(fillVisibleFields,{scope:'page' as const,useProfileCountry:true,
        facts:[...facts,{factId:'postal_code',value:'T2P 1J9'}]});
      assert.deepEqual(failed.filled,[]);
      assert.ok(failed.skipped.some(row => row.reason === 'bamboo_address_change_unconfirmed'));
      assert.equal(await page.locator('select[name="countryId.value"]').inputValue(),'1');
      assert.equal(await page.locator('select[name="state.value"]').inputValue(),'');
      assert.equal(await page.locator('input[name="zip.value"]').inputValue(),'');
      await page.close();
    }
  }finally{await browser.close();}
});

test('edits to province or country during menu opening and selection are preserved',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for(const [control,phase] of [['province','open'],['province','selection'],['country','open']] as const){
      const page=await browser.newPage();await fixture(page);
      await page.evaluate(({phase,control})=>{
        document.getElementById(phase==='open'?'province':'fab-menu101')!.addEventListener('click',()=>{
          setTimeout(()=>{
            if(control==='province') (window as any).setProvince('Ontario');
            else document.getElementById('country')!.setAttribute('aria-label','Country United States');
          },20);
        },{once:true});
      },{phase,control});
      const result=await page.evaluate(fillVisibleFields,{facts});
      assert.equal(result.filled.includes('Province'),false);
      assert.equal(await page.locator('#province').getAttribute('aria-label'),control==='province'?'Province Ontario':'Province –Select–');
      assert.equal(await page.locator('#country').getAttribute('aria-label'),control==='country'?'Country United States':'Country Canada');
      assert.equal(await page.evaluate('clears+countryTouches+submits'),0);
      if(control==='country') assert.equal(await page.evaluate('selections'),0);
      await page.close();
    }
  }finally{await browser.close();}
});
