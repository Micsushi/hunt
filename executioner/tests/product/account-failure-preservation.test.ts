import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillApplication } from '../../src/product/engine.ts';
import { applicantProfile } from '../../src/product/sources.ts';
import type { AccountEvent } from '../../src/product/account-journal.ts';

test('Workday preserves a credential failure when subsequent page inspection also fails', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const url = 'https://fixture.wd1.myworkdayjobs.com/External/job/City/Job_R1';
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`
      <div data-automation-id="signInPage"><label>Email<input data-automation-id="email" type="email"></label>
      <label>Password<input data-automation-id="password" type="password"></label>
      <div data-automation-id="noCaptchaWrapper"><button type="button" role="button" data-automation-id="click_filter"
        onclick="window.signInAttempts=(window.signInAttempts||0)+1"><span data-automation-id="signInSubmitButton">Sign In</span></button></div></div>`}));
    await page.goto(url);
    const original = new Error('fixture credential readback failed');
    const probe = new Error('fixture browser closed during assessment inspection');
    const locator = page.locator.bind(page);
    let originalTriggered = false;
    let probeAttempts = 0;
    page.locator = (selector,options) => {
      const result = locator(selector,options);
      if (selector === '[data-automation-id="email"]') {
        result.inputValue = async () => {originalTriggered=true; throw original;};
      } else if (originalTriggered) {
        result.count = async () => {probeAttempts++; throw probe;};
      }
      return result;
    };
    const events: AccountEvent[] = [];
    const profile=applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid'});
    await assert.rejects(fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture'),
      credentials:{email:'fixture@example.invalid',password:'fixture-only'},recordAccountAction:event=>events.push(event)},
      AbortSignal.timeout(10000),()=>{}),error=>error===original);
    assert.equal(probeAttempts,1);
    assert.deepEqual(events,['sign_in_fields_started','sign_in_fields_failed']);
    assert.equal(await page.evaluate('window.signInAttempts || 0'),0);
  } finally {
    await browser.close();
  }
});
