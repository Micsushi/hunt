import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';
import { fillGenericApplication, fillGenericIdentityFields } from './retired-queue/generic-application.ts';
import { applicantProfile, effectiveProfileFacts } from '../../src/product/sources.ts';
import { fillMatchedPage } from '../../src/product/page-matching.ts';



test('validated website rows appear as saved URL answers without rewriting provenance', async () => {
  const input = {given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',
    earliest_start_date:'2027-01-20',salary_expectations:'CAD 85000'};
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

    const currentPage = async () => fillMatchedPage({
      profile:saved, resume:Buffer.from('%PDF-fixture'), url:page.url(), workflow:'C3.2',signal:AbortSignal.timeout(12000),
      call:async(action,matchingPlans,matchingRunId)=>({...await page.evaluate(fillVisibleFields,{
        action,matchingPlans,matchingRunId,scope:'page' as const,facts:effectiveProfileFacts(saved),
        resume:action==='fill'?{name:'Resume.pdf',base64:Buffer.from('%PDF-fixture').toString('base64')}:undefined,
      })}),
    });
    await page.goto('https://account.example.test/register');
    await page.setContent(`<form><label>Full name<input id="name" autocomplete="name"></label>
      <label>Email<input id="email" type="email" value="manual@example.invalid"></label>
      <label>LinkedIn URL<input id="linkedin" type="url"></label>
      <label>New password<input type="password" autocomplete="new-password"></label>
      <label>Notes<input id="notes" value="private note"></label><label>Unknown prompt<input required id="unknown"></label>
      <label>Agree to terms<input type="checkbox" required></label><label>Photo<input type="file"></label>
      <button type="button">Create account</button></form>`);
    const inspect = await page.evaluate(fillVisibleFields,{action:'status' as const,scope:'page' as const});
    assert.deepEqual(inspect.matching?.map(row=>row.question),['Full name','Email','LinkedIn URL']);
    const current=await currentPage();
    assert.deepEqual(current.filled,['Full name','LinkedIn URL']);
    assert.equal(current.resume,'optional');
    assert.equal(await page.locator('#name').inputValue(),'Fixture Applicant');
    assert.equal(await page.locator('#linkedin').inputValue(),'https://example.invalid/linkedin');
    assert.equal(await page.locator('#email').inputValue(),'manual@example.invalid');
    assert.equal(await page.locator('#notes').inputValue(),'private note');
    assert.equal(await page.locator('#unknown').inputValue(),'');
    assert.equal(await page.locator('input[type=password]').inputValue(),'');
    assert.equal(await page.locator('input[type=checkbox]').isChecked(),false);
    assert.equal(await page.locator('input[type=file]').inputValue(),'');
    await page.evaluate(fillVisibleFields,{action:'undo' as const,scope:'page' as const});
    assert.equal(await page.locator('#linkedin').inputValue(),'');
    await page.evaluate(fillVisibleFields,{action:'redo' as const,scope:'page' as const});
    assert.equal(await page.locator('#linkedin').inputValue(),'https://example.invalid/linkedin');

    await page.setContent(`<form onsubmit="throw Error('Unexpected profile submit')">
      <label>First Name<input required></label><label>Last Name<input required></label>
      <label>Email<input id="contact" value="fixture@example.invalid" required></label>
      <h2>Create a login to access your application</h2>
      <label>Email/Login*<input id="login" autocomplete="username" required></label>
      <label>Password*<input type="password" value="private-fixture" required></label>
      <label>Password (Re-enter)*<input type="password" required></label>
      <button>Submit Profile</button></form>`);
    const registered=await currentPage();
    assert.equal(await page.locator('#login').inputValue(),'fixture@example.invalid');
    assert.ok(registered.filled.includes('Email/Login*'));
    assert.ok(!registered.filled.includes('Email'));
    assert.deepEqual(registered.skipped.filter(item=>item.reason==='password_field_preserved').map(item=>item.label),
      ['Password','Password (Re-enter)']);
    assert.doesNotMatch(JSON.stringify(registered),/private-fixture/);
    assert.deepEqual(await page.locator('input[type=password]').evaluateAll(nodes=>nodes.map(n=>(n as HTMLInputElement).value)),['private-fixture','']);
    await page.evaluate(fillVisibleFields,{action:'undo' as const,scope:'page' as const});
    assert.equal(await page.locator('#login').inputValue(),'');
    assert.equal(await page.locator('#contact').inputValue(),'fixture@example.invalid');
    await page.locator('#login').fill('existing@example.invalid');
    await currentPage();
    assert.equal(await page.locator('#login').inputValue(),'existing@example.invalid');
    await page.setContent('<form><label>Email/Login<input id="login"></label><label>Password<input type="password" autocomplete="current-password"></label><button>Sign in</button></form>');
    await currentPage();
    assert.equal(await page.locator('#login').inputValue(),'');
    await page.goto(url);
    await page.setContent(`<form id="job-application-form"><label>Date Available<input placeholder="mm/dd/yyyy"></label>
      <label>Desired Pay<input></label><label>Website, Blog or Portfolio<input></label><label>LinkedIn URL<input></label>
      <label>Unsupported optional prompt<input></label><button type="button">Submit application</button></form>`);
    await currentPage();
    assert.deepEqual(await page.locator('form input').evaluateAll(nodes=>nodes.map(node=>(node as HTMLInputElement).value)),
      ['01/20/2027','CAD 85000','https://example.invalid/portfolio','https://example.invalid/linkedin','']);
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
