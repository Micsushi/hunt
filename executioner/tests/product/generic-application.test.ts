import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';
import { fillGenericApplication, fillGenericIdentityFields } from '../../src/product/generic-application.ts';
import { genericApplicationTarget, productApplicationTarget } from '../../src/product/target.ts';
import { applicantProfile, effectiveProfileFacts } from '../../src/product/sources.ts';

test('validated website rows appear as saved URL answers without rewriting provenance', async () => {
  const input = {given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'};
  const saved = applicantProfile(input) as {profilePlan:{repeatables:unknown[]}};
  saved.profilePlan.repeatables.push({section:'websites',rows:['linkedin','github','portfolio'].map(rowKey=>({
    rowKey, fields:[{fieldId:'website.url',questionType:'website',answerType:'url',allowedOptions:[],
      answer:{kind:'answered',value:'https://example.invalid/'+rowKey,provenance:'resume_verified',lane:'live_owner_fact'}}],
  }))});
  const original = JSON.stringify(saved);
  const fact = (profile: unknown, id: string) => effectiveProfileFacts(profile).find(item=>item.factId===id);
  assert.equal(fact(saved,'linkedin_url')?.value,'https://example.invalid/linkedin');
  assert.equal(fact(saved,'linkedin_url')?.provenance,'resume_verified');
  assert.equal(JSON.stringify(saved),original);
  const resaved=applicantProfile({...input,given_name:'Updated',linkedin_url:'https://example.invalid/linkedin',
    github_url:'https://example.invalid/github',portfolio_url:'https://example.invalid/portfolio'},saved) as typeof saved;
  assert.deepEqual(resaved.profilePlan.repeatables,saved.profilePlan.repeatables);
  assert.equal(fact(resaved,'linkedin_url')?.provenance,'resume_verified');
  assert.equal(fact(resaved,'github_url')?.provenance,'resume_verified');
  assert.equal(fact(resaved,'portfolio_url')?.provenance,'resume_verified');
  const added=applicantProfile({...input,linkedin_url:'https://example.invalid/new'}) as typeof saved;
  assert.deepEqual(added.profilePlan.repeatables,[{section:'websites',rows:[{rowKey:'linkedin',fields:[{
    fieldId:'website.url',questionType:'website',answerType:'url',allowedOptions:[],
    answer:{kind:'answered',value:'https://example.invalid/new',provenance:'owner_provided',lane:'live_owner_fact'},
  }]}]}]);
  assert.equal(fact(added,'linkedin_url')?.value,'https://example.invalid/new');
  const edited=applicantProfile({...input,linkedin_url:'https://example.invalid/edited'},saved);
  assert.equal(fact(edited,'linkedin_url')?.value,'https://example.invalid/edited');
  assert.equal(fact(edited,'linkedin_url')?.provenance,'owner_provided');
  const cleared=applicantProfile({...input,linkedin_url:''},edited);
  assert.equal(fact(cleared,'linkedin_url'),undefined);
  assert.equal(fact(cleared,'github_url')?.value,'https://example.invalid/github');
  assert.equal(fact(JSON.parse(original),'linkedin_url')?.value,'https://example.invalid/linkedin');
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const url = 'https://example.applytojob.com/apply/WebsiteFixture';
    await page.route('**/*', route=>route.fulfill({contentType:'text/html',
      body:'<form><label>First name<input></label><label>Email<input required type="email"></label><label>LinkedIn URL<input required id="linkedin" type="url"></label><label>Resume<input type="file"></label></form>'}));
    await page.goto(url);
    await fillGenericApplication(page,url,saved,Buffer.from('%PDF-fixture'),AbortSignal.timeout(5000));
    assert.equal(await page.locator('#linkedin').inputValue(),'https://example.invalid/linkedin');
    assert.equal(JSON.stringify(saved),original);
  } finally { await browser.close(); }
});

test('generic React Select leaves the Sirion country unchanged without a verified native reset', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form>
      <label>First name<input id="first"></label><label>Email<input required type="email"></label>
      <label id="country-label">Country*</label>
      <div class="select__control"><div class="select__value-container"></div>
        <input id="country" role="combobox" aria-labelledby="country-label" aria-expanded="false" aria-autocomplete="list">
      </div>
      <div role="listbox" id="iti-0__country-listbox"><div role="option">Canada +1</div></div>
      <div role="listbox" id="react-select-country-listbox" hidden>
        <div role="option">United States +1</div><div role="option">Canada +1</div>
      </div><button type="button">Submit application</button></form>
      <script>
      const control = document.querySelector('#country');
      const list = document.querySelector('#react-select-country-listbox');
      control.onclick = () => {
        list.hidden = false;
        control.setAttribute('aria-expanded','true');
        control.setAttribute('aria-controls',list.id);
      };
      list.onclick = event => {
        document.querySelector('.select__value-container').innerHTML = '<div class="select__single-value">' + event.target.textContent + '</div>';
        list.hidden = true;
        control.setAttribute('aria-expanded','false');
      };
      </script>`);
    const result = await page.evaluate(fillVisibleFields, { facts: [
      { factId: 'given_name', value: 'Fixture' }, { factId: 'email_address', value: 'fixture@example.invalid' },
      { factId: 'country', value: 'Canada' },
    ] });
    assert.equal(await page.locator('.select__single-value').count(), 0);
    assert.equal(await page.locator('#country').getAttribute('aria-expanded'), 'false');
    assert.ok(!result.filled.includes('Country*'));
    assert.ok(result.skipped.some(field => field.reason === 'custom_choice_not_reversible'));
    await page.evaluate(fillVisibleFields, { action: 'undo' as const });
    assert.equal(await page.locator('#first').inputValue(), '');
  } finally {
    await browser.close();
  }
});

test('queued unfamiliar application uses the selected PDF only at the admitted posting', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html',
      body: '<form><label>First name<input required id="name"></label><label>Email<input required type="email"></label><label>Resume<input required id="resume" type="file"></label><button onclick="window.submitted=true">Submit application</button></form>' }));
    const posting = 'https://example.applytojob.com/apply/TestID/Engineer';
    const other = 'https://example.applytojob.com/apply/OtherID/Engineer';
    const profile = applicantProfile({ given_name: 'Saved', family_name: 'Applicant', email_address: 'saved@example.invalid' });
    const bytes = Buffer.from('%PDF-selected');
    assert.equal(productApplicationTarget(posting).ats, 'generic');
    assert.throws(() => genericApplicationTarget('https://passport.amazon.jobs/'));
    assert.throws(() => genericApplicationTarget('https://www.example.com/login'));
    await page.goto(other);
    await assert.rejects(fillGenericApplication(page, posting, profile, bytes, AbortSignal.timeout(5000)), /exact posting/);
    assert.equal(await page.locator('#name').inputValue(), '');
    await page.goto(posting);
    const previous = Buffer.from('%PDF-existing manual resume');
    await page.locator('#resume').setInputFiles({name:'previous.pdf',mimeType:'application/pdf',buffer:previous});
    const partial = await page.evaluate(fillVisibleFields, {resume:{name:'Resume.pdf',base64:bytes.toString('base64')},
      facts:[{factId:'given_name',value:'Saved'},{factId:'email_address',value:'saved@example.invalid'}]});
    assert.ok(partial.skipped.some(field => field.reason === 'existing_attachment_preserved'));
    await fillGenericApplication(page, posting, profile, bytes, AbortSignal.timeout(5000));
    assert.equal(await page.locator('#name').inputValue(), 'Saved');
    assert.equal(await page.locator('#resume').evaluate(async (e: HTMLInputElement) => await e.files?.[0]?.text()), bytes.toString());
    await page.evaluate(fillVisibleFields, {action:'undo' as const});
    assert.deepEqual(await page.locator('#resume').evaluate(async (e: HTMLInputElement) => [
      e.files?.[0]?.name, await e.files?.[0]?.text(),
    ]), ['previous.pdf', previous.toString()]);
    await page.evaluate(fillVisibleFields, {action:'redo' as const});
    assert.equal(await page.locator('#resume').evaluate(async (e: HTMLInputElement) => await e.files?.[0]?.text()), bytes.toString());
    assert.equal(await page.evaluate('window.submitted'), undefined);
    await page.goto(posting);
    await page.locator('#name').fill('Owner edit');
    const conflict = await fillGenericApplication(page, posting, profile, bytes, AbortSignal.timeout(5000));
    assert.equal(await page.locator('#name').inputValue(), 'Owner edit');
    assert.ok(conflict.skipped.some(field => field.reason === 'saved_value_conflict'));
    await page.goto(posting);
    await page.evaluate(() => {
      const name = document.querySelector<HTMLInputElement>('#name')!;
      const events: string[] = [];
      name.addEventListener('input', () => events.push('input:' + name.value));
      document.querySelector('#resume')!.addEventListener('change', () => {
        setTimeout(() => {
          events.push('parser:' + name.value);
          name.value = 'Parser value';
          name.dataset.events = JSON.stringify(events);
        }, 30);
      });
    });
    const parsed = await fillGenericApplication(page, posting, profile, bytes, AbortSignal.timeout(5000));
    assert.equal(await page.locator('#name').inputValue(), 'Parser value');
    assert.ok(!parsed.filled.includes('First name'));
    assert.equal(await page.locator('#name').getAttribute('data-events'), '["parser:"]');
    for (const reason of ['field_changed_before_fill', 'saved_value_conflict']) {
      assert.ok(parsed.skipped.some(field => field.label === 'First name' && field.reason === reason), reason);
    }
  } finally {
    await browser.close();
  }
});

test('generic partial fill preserves choices and edits, supports French fields and reversible saved answers', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<form>
      <label>Prénom<input required name=first></label><label>Legal Last Name<textarea required name=last></textarea></label>
      <label>Adresse e-mail<input required name=email type=email></label><label>City<input name=city value="Owner edit"></label>
      <label>Country<select required name=country><option value="">Choose</option><option value=US>United States</option></select></label>
      <label>Legal Name<input required name=legal></label><label>Full Legal Name<input required name=fulllegal></label>
      <label>Phone number?<input required name=phone></label>
      <label>Nom Complet / Name<input required name=bilingualname></label>
      <label>Adresse courriel / Email<input required name=bilingualemail type=email></label>
      <label>Numéro de téléphone / Phone Number<input required name=bilingualphone></label>
      <label>Previous legal name<input name=previouslegal></label><label>Emergency contact phone number<input name=emergency></label>
      <label>City<input name=cityproxy aria-hidden=true tabindex=-1></label>
      <div aria-hidden=true><label>Country<input name=countryproxy></label></div>
      <div inert><label>Phone<input name=inertphone></label></div>
      <fieldset><legend>Degree</legend><label><input type=checkbox>Masters</label><label><input type=checkbox>PhD</label></fieldset>
      <input type=file><button onclick="window.submitted=true;return false">Submit application</button></form>
      <form><label>Email<input name=newsletter type=email></label><button>Subscribe</button></form>` }));
    await page.goto('https://employer.example.test/apply');
    const source = applicantProfile({ given_name: 'Test', family_name: 'Applicant', email_address: 'test@example.invalid', phone_number:'4035550100', city: 'New York', country: 'United States' }) as { profile: unknown };
    const result = await fillGenericIdentityFields(page, source.profile, AbortSignal.timeout(5000));
    assert.equal(result.filled.length, 10);
    assert.equal(await page.locator('[name=bilingualname]').inputValue(),'Test Applicant');
    assert.equal(await page.locator('[name=bilingualemail]').inputValue(),'test@example.invalid');
    assert.equal(await page.locator('[name=bilingualphone]').inputValue(),'4035550100');
    assert.equal(await page.locator('[name=legal]').inputValue(),'Test Applicant');
    assert.equal(await page.locator('[name=fulllegal]').inputValue(),'Test Applicant');
    assert.equal(await page.locator('[name=phone]').inputValue(),'4035550100');
    assert.equal(await page.locator('[name=previouslegal]').inputValue(),'');
    assert.equal(await page.locator('[name=emergency]').inputValue(),'');
    for(const name of ['cityproxy','countryproxy','inertphone'])assert.equal(await page.locator(`[name=${name}]`).inputValue(),'');
    assert.equal(await page.locator('[name=first]').inputValue(), 'Test');
    assert.equal(await page.locator('[name=last]').inputValue(), 'Applicant');
    assert.equal(await page.locator('[name=country]').inputValue(), 'US');
    assert.equal(await page.locator('[name=city]').inputValue(), 'Owner edit');
    assert.equal(await page.locator('[name=newsletter]').inputValue(), '');
    assert.equal(await page.locator(':checked').count(), 1);
    assert.equal(await page.evaluate(() => (window as unknown as { submitted?: boolean }).submitted), undefined);
    await page.evaluate(fillVisibleFields, { action: 'undo' as const });
    assert.equal(await page.locator('[name=first]').inputValue(), '');
    assert.equal(await page.locator('[name=legal]').inputValue(), '');
    assert.equal(await page.locator('[name=phone]').inputValue(), '');
    for(const name of ['bilingualname','bilingualemail','bilingualphone'])assert.equal(await page.locator(`[name=${name}]`).inputValue(),'');
    await page.evaluate(fillVisibleFields, { action: 'redo' as const });
    assert.equal(await page.locator('[name=first]').inputValue(), 'Test');
    assert.equal(await page.locator('[name=bilingualemail]').inputValue(),'test@example.invalid');
    await page.locator('[name=legal]').fill('Existing legal name');
    await fillGenericIdentityFields(page, source.profile, AbortSignal.timeout(5000));
    assert.equal(await page.locator('[name=legal]').inputValue(),'Existing legal name');
    await page.locator('[name=first]').fill('New owner edit');
    await assert.rejects(page.evaluate(fillVisibleFields, { action: 'undo' as const }), /Fields changed/);
    assert.equal(await page.locator('[name=first]').inputValue(), 'New owner edit');
    assert.equal((await page.evaluate(fillVisibleFields, { action: 'status' as const })).canUndo, true);
  } finally { await browser.close(); }
});
