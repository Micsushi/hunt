import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium, type Page} from 'playwright';
import {fillVisibleFields} from '../../extension/generic-fill.js';
import {fillMatchedPage} from '../../src/product/page-matching.ts';
import {applicantProfile, effectiveProfileFacts, productSources} from '../../src/product/sources.ts';
import {createPageAnswerPlanner} from '../../src/product/page-answer-planner.ts';

const url = 'https://jobs.jobvite.com/parkland/job/123/apply';
const resume = {name:'Resume.pdf', base64:'JVBERg=='};
const group = (question:string, type:string, name:string, options:string[]) => `
  <div class="jv-form-field-${type} ng-invalid-required">
    <fieldset class="jv-input-group"><legend>${question}*</legend>
      ${options.map(option => `<label>${option}<input type="${type}" name="${name}"
        ${type === 'radio' ? 'required' : ''}></label>`).join('')}
    </fieldset>
  </div>`;
const html = (groups:string) => `
  <style>input[type=radio],input[type=checkbox]{visibility:hidden;width:0;height:0}</style>
  <article ng-controller="JVApply"><form name="scopeData.applyForm" ng-submit="submitApplication()">
    <section ng-form="scopeData.step2" ng-if="showStep(2)">${groups}
      <label>School<input required value="x"></label>
    </section><button type="submit">Send Application</button>
  </form></article>`;
const simpleGroups = group('Previous employment?', 'radio', 'f0', ['Yes', 'No']) +
  group('Available intakes?', 'checkbox', 'f2', ['January', 'May']);

async function openFixture(page:Page, groups = simpleGroups) {
  await page.route(url, route => route.fulfill({contentType:'text/html', body:html(groups)}));
  await page.goto(url);
  await page.evaluate(() => {
    (window as any).submits = 0;
    document.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      (window as any).submits++;
    });
    const step = document.querySelector('[ng-form]');
    (globalThis as any).__huntC3PartialFill = {
      undo:[], redo:[], busy:false, resumeAttempt:{acknowledgedPanel:() => step},
    };
  });
}
async function status(page:Page) {
  return page.evaluate(fillVisibleFields, {action:'status' as const});
}

test('owned Jobvite screening groups select exact labels', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await openFixture(page);
    const observed = await status(page);
    const rows = observed.matching!.filter(row => row.question.includes('?*'));
    assert.equal(rows.length, 2);
    const plans = rows.map(row => ({
      fieldId:row.fieldId, signature:row.signature, answer:row.control === 'radio' ? 'No' : 'January',
      reason:'fixture', provisional:true,
    }));
    const result = await page.evaluate(fillVisibleFields, {
      action:'fill' as const, queuedScreening:true, expectedUrl:url,
      expiresAt:Date.now()+5000, resume, matchingPlans:plans,
    });
    assert.equal(await page.locator('input[name=f0]').nth(1).isChecked(), true);
    assert.equal(await page.locator('input[name=f2]').first().isChecked(), true);
    assert.equal(await page.locator('input[name=f2]').nth(1).isChecked(), false);
    assert.equal(result.filled.length, 2);
    await page.evaluate(fillVisibleFields, {action:'undo' as const});
    assert.equal(await page.locator('input[name=f0]').nth(1).isChecked(), false);
    assert.equal(await page.locator('input[name=f2]').first().isChecked(), false);
    await page.evaluate(fillVisibleFields, {action:'redo' as const});
    assert.equal(await page.locator('input[name=f0]').nth(1).isChecked(), true);
    await page.locator('input[name=f2]').nth(1).evaluate(element => (element as HTMLInputElement).checked = true);
    await assert.rejects(page.evaluate(fillVisibleFields, {action:'undo' as const}), /Fields changed/);
    assert.equal(await page.locator('input[name=f2]').nth(1).isChecked(), true);
  } finally { await browser.close(); }
});

test('changed and already selected groups are preserved', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const optionalLater = group('Additional intakes?', 'checkbox', 'f3', ['January', 'May'])
      .replace('Additional intakes?*', 'Additional intakes?');
    await openFixture(page, simpleGroups + optionalLater);
    const observed = await status(page);
    const plans = observed.matching!.filter(row => row.question.includes('?')).map(row => ({
      fieldId:row.fieldId, signature:row.signature, answer:row.control === 'radio' ? 'No' : 'January',
      reason:'fixture', provisional:true,
    }));
    assert.equal(plans.length, 3);
    await page.locator('input[name=f0]').first().evaluate(element => (element as HTMLInputElement).checked = true);
    await page.locator('input[name=f2]').first().evaluate(element => element.replaceWith(element.cloneNode()));
    await page.getByText('Additional intakes?', {exact:false}).evaluate(legend => {
      legend.closest('.jv-form-field-checkbox')!.classList.remove('ng-invalid-required');
    });
    await page.evaluate(fillVisibleFields, {
      action:'fill' as const, queuedScreening:true, expectedUrl:url,
      expiresAt:Date.now()+5000, resume, matchingPlans:plans,
    });
    assert.equal(await page.locator('input[name=f0]').first().isChecked(), true);
    assert.equal(await page.locator('input[name=f0]').nth(1).isChecked(), false);
    assert.equal(await page.locator('input[name=f2]').first().isChecked(), false);
    assert.equal(await page.locator('input[name=f3]:checked').count(), 0);
  } finally { await browser.close(); }
});

test('ordinary queue planner resolves prior-employment and provisional choices', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const groups = group('Have you previously worked for Parkland, Sunoco or any affliate?', 'radio', 'f0', ['Yes', 'No']) +
      group('Which intake(s) are you available for? (Select all that apply)', 'checkbox', 'f1',
        ['January 2027', 'May 2027', 'September 2027']) +
      group('What work term length(s) are you available for? (Select all that apply)', 'checkbox', 'f2',
        ['4-Months', '8-Months', '12-Months']) +
      group('Will you be returning to full-time post-secondary studies for at least one academic semester following the completion of your work term?',
        'radio', 'f3', ['Yes', 'No']);
    await openFixture(page, groups);
    const profile = applicantProfile({given_name:'Fixture', family_name:'Applicant', email_address:'fixture@example.invalid'});
    const facts = effectiveProfileFacts(profile);
    const result = await fillMatchedPage({
      profile, resume:Buffer.from('%PDF-fixture'), url, workflow:'C3.1', signal:AbortSignal.timeout(15000),
      call:async (action, matchingPlans, matchingRunId) => ({...await page.evaluate(fillVisibleFields, {
        action, matchingPlans, matchingRunId, facts, queuedScreening:true, expectedUrl:url,
        expiresAt:Date.now()+10000, resume:action === 'fill' ? resume : undefined,
      })}),
    });
    const selected = await page.locator('fieldset').evaluateAll(fieldsets => fieldsets.map(fieldset =>
      Array.from(fieldset.querySelectorAll('input')).filter(input => input.checked)
        .map(input => input.parentElement!.textContent!.trim())));
    assert.deepEqual(selected, [['No'], ['January 2027'], ['4-Months'], ['Yes']]);
    assert.equal(result.filled.length, 4);
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
  } finally { await browser.close(); }
});
test('individual required checkboxes and single attestations remain unresolved', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const groups = `<div class="jv-form-field-checkbox ng-invalid-required">
      <fieldset class="jv-input-group"><legend>Required choices*</legend>
        <label>One<input type="checkbox" name="f0" required checked></label>
        <label>Two<input type="checkbox" name="f0" aria-required="true"></label>
      </fieldset></div><div class="jv-form-field-checkbox ng-invalid-required">
      <fieldset class="jv-input-group"><legend>The statements in this application are true and complete*</legend>
        <label>Yes<input type="checkbox" name="f1" required></label>
      </fieldset></div>`;
    await openFixture(page, groups);
    const observed = await status(page);
    assert.equal(observed.incomplete, true);
    assert.equal(observed.skipped.filter(item => item.reason === 'required_choice_unconfirmed').length, 2);
    assert.equal(observed.matching!.some(row => row.question.includes('statements')), false);
    assert.equal(await page.locator('input[name=f1]').isChecked(), false);
  } finally { await browser.close(); }
});
test('a saved Sunoco company overrides the compound prior-employment default', async () => {
  const profile = applicantProfile({
    given_name:'Fixture', family_name:'Applicant', email_address:'fixture@example.invalid', current_company:'Sunoco',
  });
  const planner = createPageAnswerPlanner(productSources(profile, Buffer.from('%PDF-fixture')),
    effectiveProfileFacts(profile), 'parkland');
  const result = await planner({
    pageId:url, fieldId:'fixture', signature:'fixture',
    question:'Have you previously worked for Parkland, Sunoco or any affliate?*',
    control:'radio', options:['Yes', 'No'], required:true, selected:'', valid:false,
  }, [], AbortSignal.timeout(5000));
  assert.equal(result.answer, 'Yes');
  assert.equal(result.lane, 'live_owner_fact');
});
test('a preselected protected choice remains untouched and reports denial', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await openFixture(page, group('Background check?', 'radio', 'f0', ['Yes', 'No']));
    await page.locator('input[name=f0]').first().evaluate(element => (element as HTMLInputElement).checked = true);
    const observed = await status(page);
    const row = observed.matching!.find(item => item.question.includes('Background check'))!;
    const result = await page.evaluate(fillVisibleFields, {
      action:'fill' as const, queuedScreening:true, expectedUrl:url, expiresAt:Date.now()+5000, resume,
      matchingPlans:[{fieldId:row.fieldId, signature:row.signature, answer:null,
        reason:'protected_answer_denied', provisional:true}],
    });
    assert.equal(await page.locator('input[name=f0]').first().isChecked(), true);
    assert.ok(result.matching!.some(item => item.reason === 'protected_answer_denied'));
  } finally { await browser.close(); }
});
