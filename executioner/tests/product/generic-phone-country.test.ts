import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';

const url = 'https://canonical.com/careers/123/fixture/application';
const facts = [
  { factId: 'given_name', value: 'Fixture' },
  { factId: 'email_address', value: 'fixture@example.invalid' },
  { factId: 'country', value: 'Canada' },
  { factId: 'phone_number', value: '6135550100' },
];

test('a native phone field can reformat the planned number without losing the entry', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body:
      '<main><h1>Job application</h1><form><label for="first">First Name</label><input id="first" required><label for="email">Email</label><input id="email" type=email required>' +
      '<label for="phone">Phone number</label><input id="phone" type=tel required><label>Resume<input type=file></label></form></main>' }));
    for (const outcome of ['format', 'different-digit', 'invalid']) {
      await page.goto(url);
      await page.locator('[type=tel]').evaluate((field: HTMLInputElement, outcome) => {
        field.addEventListener('input', () => {
          if (!field.value) { field.setCustomValidity(''); return; }
          field.value = outcome === 'different-digit' ? '613 555 0199' : '613 555 0100';
          if (outcome === 'invalid') field.setCustomValidity('Rejected');
        });
      }, outcome);
      const inspection = await page.evaluate(fillVisibleFields, { facts, action: 'status' as const });
      const row = inspection.matching?.find(field => field.question === 'Phone number');
      assert.ok(row, JSON.stringify(inspection.matching?.map(field => field.question)));
      const result = await page.evaluate(fillVisibleFields, { facts, matchingPlans: [{
        fieldId: row.fieldId, signature: row.signature, provisional: false, reason: 'test_fact', answer: '(613) 555-0100',
      }] });
      const field = page.locator('[type=tel]');
      assert.equal(result.filled.includes('Phone number'), outcome === 'format');
      assert.equal(await field.inputValue(), outcome === 'format' ? '613 555 0100' : '');
      if (outcome === 'format') {
        await page.evaluate(fillVisibleFields, { action: 'undo' as const });
        assert.equal(await field.inputValue(), '');
        await page.evaluate(fillVisibleFields, { action: 'redo' as const });
        assert.equal(await field.inputValue(), '613 555 0100');
      }
    }
  } finally { await browser.close(); }
});
test('the SmartRecruiters phone validates on blur and preserves focus in another field', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const app = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/11111111-1111-4111-8111-111111111111';
    await page.route(app, route => route.fulfill({ contentType: 'text/html', body:
      '<main><oc-oneclick-form><h2>Personal information</h2><label>First name<input id="first"></label><label>Email<input type=email></label>' +
      '<spl-phone-field></spl-phone-field><oc-resume-upload><spl-dropzone data-test=resume-upload><label>Resume<input type=file></label></spl-dropzone></oc-resume-upload></oc-oneclick-form></main>' }));
    for (const focusedElsewhere of [false, true]) {
      await page.goto(app);
      await page.evaluate(() => {
        const root = document.querySelector('spl-phone-field')!.attachShadow({ mode: 'open' });
        root.innerHTML = '<input required type=tel aria-label="Phone number" aria-invalid=true>';
        const phone = root.querySelector('input')!;
        phone.onblur = () => phone.setAttribute('aria-invalid', String(!phone.value));
      });
      if (focusedElsewhere) await page.locator('#first').focus();
      const status = await page.evaluate(fillVisibleFields, { facts, action: 'status' as const });
      const phone = status.matching?.find(field => field.question === 'Phone number');
      assert.ok(phone);
      const result = await page.evaluate(fillVisibleFields, { facts, matchingPlans: [{
        fieldId: phone.fieldId, signature: phone.signature, provisional: false, reason: 'test_fact', answer: '6135550100',
      }] });
      assert.equal(result.filled.includes('Phone number'), !focusedElsewhere, JSON.stringify(result.skipped));
      const field = page.locator('input[type=tel]');
      if (focusedElsewhere) {
        assert.equal(await page.locator('#first').evaluate(el => el === document.activeElement), true);
        assert.equal(await field.inputValue(), '');
      } else {
        assert.equal(await field.getAttribute('aria-invalid'), 'false');
        await page.evaluate(fillVisibleFields, { action: 'undo' as const });
        assert.equal(await field.inputValue(), '');
        assert.equal(await field.getAttribute('aria-invalid'), 'true');
        await page.evaluate(fillVisibleFields, { action: 'redo' as const });
        assert.equal(await field.getAttribute('aria-invalid'), 'false');
      }
    }
  } finally { await browser.close(); }
});
const widget = (options = '', phone = '') => `<!doctype html>
<form>
  <label>First Name<input name="first"></label>
  <label>Email<input name="email" type="email"></label>
  <label for="phone">Phone</label>
  <div class="iti iti--allow-dropdown iti--show-flags iti--inline-dropdown">
    <div class="iti__country-container">
      <button type="button" class="iti__selected-country" role="combobox" aria-label="Selected country" aria-controls="iti-0__dropdown-content" aria-expanded="false" title="Guatemala">
        <span class="iti__flag iti__gt"></span><span class="iti__selected-dial-code">+502</span>
      </button>
      <div id="iti-0__dropdown-content" class="iti__dropdown-content iti__hide" hidden>
        <input type="text" aria-label="Search countries">
        <ul id="iti-0__country-listbox" role="listbox">
          <li id="iti-0__item-gt" class="iti__country" role="option" aria-selected="false" data-country-code="gt" data-dial-code="502"><span class="iti__country-name">Guatemala</span> <span class="iti__dial-code">+502</span></li>
          <li id="iti-0__item-ca" class="iti__country" role="option" aria-selected="false" data-country-code="ca" data-dial-code="1"><span class="iti__country-name">Canada</span> <span class="iti__dial-code">+1</span></li>
          <li id="iti-0__item-us" class="iti__country" role="option" aria-selected="false" data-country-code="us" data-dial-code="1"><span class="iti__country-name">United States</span> <span class="iti__dial-code">+1</span></li>
          ${options}
        </ul>
      </div>
    </div>
    <input id="phone" class="iti__tel-input" type="text" name="phone" data-intl-tel-input-id="0" value="${phone}" required>
  </div>
  <button type="button" onclick="window.submits++">Submit application</button><button type="button" onclick="window.advances++">Next</button>
</form>
<script>
  window.submits=0;window.advances=0;
  const trigger = document.querySelector('.iti__selected-country');
  const menu = document.getElementById(trigger.getAttribute('aria-controls'));
  const field = document.getElementById('phone');
  const list = menu.querySelector('[role=listbox]');
  const expanded = (value) => {
    trigger.setAttribute('aria-expanded', String(value));
    menu.hidden = !value;
    menu.classList.toggle('iti__hide', !value);
  };
  trigger.addEventListener('click', () => expanded(menu.hidden));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') expanded(false); });
  list.addEventListener('click', event => {
    const option = event.target.closest('[role=option]');
    if (!option) return;
    trigger.title = option.querySelector('.iti__country-name')?.textContent.trim();
    trigger.querySelector('.iti__flag').className = 'iti__flag iti__' + option.dataset.countryCode;
    trigger.querySelector('.iti__selected-dial-code').textContent = '+' + option.dataset.dialCode;
    field.dispatchEvent(new Event('countrychange', { bubbles: true }));
    expanded(false);
  });
  window.phoneCountryAtWrite = [];
  field.addEventListener('input', () => window.phoneCountryAtWrite.push(trigger.title));
</script>`;

test('phone and associated country form one reversible change with conflict protection', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: widget() }));
    await page.goto(url);
    const phone = page.locator('#phone');
    const trigger = page.getByRole('combobox', { name: 'Selected country' });
    const current = async () => [await trigger.getAttribute('title'), await page.locator('.iti__selected-dial-code').textContent(), await phone.inputValue()];
    const inspection = await page.evaluate(fillVisibleFields, {facts, action:'status' as const});
    const row = inspection.matching?.find(field => field.widget === 'international-phone');
    assert.ok(row, 'the shared planner can identify this composite widget');
    const binding = {fieldId:row.fieldId, signature:row.signature, provisional:false, reason:'test_fact'};
    const declined = await page.evaluate(fillVisibleFields, {facts, matchingPlans:[{...binding, answer:null}]});
    assert.ok(!declined.filled.includes('Phone'), 'explicit null plan preserves this field even with saved facts');
    const result = await page.evaluate(fillVisibleFields, {
      facts:facts.filter(fact => fact.factId !== 'region' && fact.factId !== 'country' && fact.factId !== 'phone_number'),
      matchingPlans:[{...binding, answer:'6135550100', phoneCountry:'Canada'}],
    });
    assert.ok(result.filled.includes('Phone'));
    assert.deepEqual(await current(), ['Canada', '+1', '6135550100']);
    assert.deepEqual(await page.evaluate('window.phoneCountryAtWrite'), ['Canada']);
    await page.evaluate(fillVisibleFields, { action: 'undo' as const });
    assert.deepEqual(await current(), ['Guatemala', '+502', '']);
    await page.evaluate(fillVisibleFields, { action: 'redo' as const });
    assert.deepEqual(await current(), ['Canada', '+1', '6135550100']);
    await phone.fill('6135550199');
    await assert.rejects(page.evaluate(fillVisibleFields, { action: 'undo' as const }), /Fields changed|changed since/i);
    assert.deepEqual(await current(), ['Canada', '+1', '6135550199']);
    await phone.fill('6135550100');
    await trigger.click();
    await page.getByRole('option', { name: 'United States +1' }).click();
    await assert.rejects(page.evaluate(fillVisibleFields, { action: 'undo' as const }), /Fields changed|changed since/i);
    assert.deepEqual(await current(), ['United States', '+1', '6135550100']);
    assert.equal(await page.evaluate('submits+advances'),0);
  } finally {
    await browser.close();
  }
});

test('site rejection restores the original phone and country without advancing',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await page.route(url,r=>r.fulfill({contentType:'text/html',body:widget()}));await page.goto(url);
    await page.locator('#phone').evaluate((e:HTMLInputElement)=>e.addEventListener('input',()=>{if(e.value)e.value='';}));
    const result=await page.evaluate(fillVisibleFields,{facts});
    assert.equal(result.filled.includes('Phone'),false);assert.ok(result.skipped.some(item=>item.label==='Phone'&&item.reason==='phone_country_requires_review'));
    assert.equal(await page.locator('#phone').inputValue(),'');
    assert.equal(await page.getByRole('combobox',{name:'Selected country'}).getAttribute('title'),'Guatemala');
    assert.equal(await page.locator('.iti__selected-dial-code').textContent(),'+502');
    assert.equal(await page.evaluate('submits+advances'),0);
  }finally{await browser.close();}
});

test('ambiguous country choices and existing phone numbers stay untouched', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [options, value] of [
      ['<li id="iti-0__item-ca" class="iti__country" role="option" aria-selected="false" data-country-code="ca" data-dial-code="1"><span class="iti__country-name">Canada</span> <span class="iti__dial-code">+1</span></li>', ''],
      ['', '5025550100'],
    ] as const) {
      const page = await browser.newPage();
      await page.route(url, route => route.fulfill({ contentType: 'text/html', body: widget(options, value) }));
      await page.goto(url);
      const result = await page.evaluate(fillVisibleFields, { facts });
      assert.equal(await page.getByRole('combobox', { name: 'Selected country' }).getAttribute('title'), 'Guatemala');
      assert.equal(await page.locator('#phone').inputValue(), value);
      assert.ok(!result.filled.includes('Phone'));
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('manual phone or country edits survive asynchronous selection and post-write verification',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    for (const edit of ['number','country','post-write'] as const) {
      const page=await browser.newPage();await page.route(url,r=>r.fulfill({contentType:'text/html',body:widget()}));await page.goto(url);
      await page.evaluate(edit=>{
        const phone=document.getElementById('phone') as HTMLInputElement;
        if(edit==='post-write') {
          phone.addEventListener('input',()=>{if(phone.value==='6135550100')setTimeout(()=>{phone.value='OWNER-EDIT';},20);});
        } else {
          phone.addEventListener('countrychange',()=>{
            if (document.querySelector<HTMLButtonElement>('.iti__selected-country')!.title!=='Canada') return;
            setTimeout(()=>{
              if(edit==='number'){phone.value='OWNER-EDIT';phone.dispatchEvent(new Event('input',{bubbles:true}));}
              else (document.getElementById('iti-0__item-us') as HTMLElement).click();
            },20);
          },{once:true});
        }
      },edit);
      const result=await page.evaluate(fillVisibleFields,{facts});assert.equal(result.filled.includes('Phone'),false);
      assert.equal(await page.locator('#phone').inputValue(),edit==='country'?'':'OWNER-EDIT');
      assert.equal(await page.getByRole('combobox',{name:'Selected country'}).getAttribute('title'),edit==='country'?'United States':'Canada');
      assert.equal(await page.evaluate('submits+advances'),0);await page.close();
    }
  }finally{await browser.close();}
});
