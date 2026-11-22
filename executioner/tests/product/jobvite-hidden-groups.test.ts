import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium, type Page} from 'playwright';
import {fillVisibleFields} from '../../extension/generic-fill.js';
import {applicantProfile, effectiveProfileFacts, productSources} from '../../src/product/sources.ts';
import {createPageAnswerPlanner} from '../../src/product/page-answer-planner.ts';

const url = 'https://jobs.jobvite.com/parkland/job/123/apply';
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

async function openFixture(page:Page, groups:string) {
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



test('current-page matching reads committed Jobvite groups and leaves unsupported choices for the owner', async () => {
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
    await openFixture(page, groups + group('Available intakes?', 'checkbox', 'intake', ['January','May']));
    const observed = await status(page);
    assert.equal(observed.incomplete, true);
    assert.equal(observed.skipped.filter(item => item.reason === 'required_choice_unconfirmed').length, 3);
    assert.equal(observed.matching!.some(row => row.question.includes('statements')), false);
    const intake=observed.matching!.find(row=>row.question.startsWith('Available intakes'));
    assert.ok(intake);
    assert.deepEqual(intake.options,['January','May']);
    const plan={fieldId:intake.fieldId,signature:intake.signature,answer:'May',provisional:false,reason:'saved_fact'};
    const direct=await page.evaluate(fillVisibleFields,{action:'fill' as const,scope:'page' as const,expectedUrl:url,matchingPlans:[plan]});
    assert.ok(direct.incomplete);
    assert.equal(await page.locator('[name=intake]:checked').count(),0);
    await page.locator('label').filter({hasText:'January'}).click();
    const selected=(await status(page)).matching!.find(row=>row.fieldId===intake.fieldId);
    assert.equal(selected?.selected,'January');
    assert.equal(selected?.valid,true);
    await page.evaluate(fillVisibleFields,{action:'fill' as const,scope:'page' as const,expectedUrl:url,matchingPlans:[plan]});
    assert.equal(await page.locator('[name=intake]').first().isChecked(),true);
    assert.equal(await page.locator('[name=intake]').last().isChecked(),false);
    assert.equal(await page.evaluate('window.submits'),0);
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
