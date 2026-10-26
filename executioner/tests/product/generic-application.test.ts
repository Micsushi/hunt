import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';
import { fillGenericIdentityFields } from '../../src/product/generic-application.ts';
import { applicantProfile } from '../../src/product/sources.ts';

test('generic partial fill preserves choices and edits, supports French fields and reversible saved answers', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.HUNT_C3_CHROMIUM ? { executablePath: process.env.HUNT_C3_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<form>
      <label>Prénom<input name=first></label><label>Legal Last Name<textarea name=last></textarea></label>
      <label>Adresse e-mail<input name=email type=email></label><label>City<input name=city value="Owner edit"></label>
      <label>Country<select name=country><option value="">Choose</option><option value=US>United States</option></select></label>
      <fieldset><legend>Degree</legend><label><input type=checkbox>Masters</label><label><input type=checkbox>PhD</label></fieldset>
      <input type=file><button onclick="window.submitted=true;return false">Submit application</button></form>
      <form><label>Email<input name=newsletter type=email></label><button>Subscribe</button></form>` }));
    await page.goto('https://employer.example.test/apply');
    const source = applicantProfile({ given_name: 'Test', family_name: 'Applicant', email_address: 'test@example.invalid', city: 'New York', country: 'United States' }) as { profile: unknown };
    const result = await fillGenericIdentityFields(page, source.profile, AbortSignal.timeout(5000));
    assert.equal(result.filled.length, 4);
    assert.equal(await page.locator('[name=first]').inputValue(), 'Test');
    assert.equal(await page.locator('[name=last]').inputValue(), 'Applicant');
    assert.equal(await page.locator('[name=country]').inputValue(), 'US');
    assert.equal(await page.locator('[name=city]').inputValue(), 'Owner edit');
    assert.equal(await page.locator('[name=newsletter]').inputValue(), '');
    assert.equal(await page.locator(':checked').count(), 1);
    assert.equal(await page.evaluate(() => (window as unknown as { submitted?: boolean }).submitted), undefined);
    await page.evaluate(fillVisibleFields, { action: 'undo' as const });
    assert.equal(await page.locator('[name=first]').inputValue(), '');
    await page.evaluate(fillVisibleFields, { action: 'redo' as const });
    assert.equal(await page.locator('[name=first]').inputValue(), 'Test');
    await page.locator('[name=first]').fill('New owner edit');
    await assert.rejects(page.evaluate(fillVisibleFields, { action: 'undo' as const }), /Fields changed/);
    assert.equal(await page.locator('[name=first]').inputValue(), 'New owner edit');
    assert.equal((await page.evaluate(fillVisibleFields, { action: 'status' as const })).canUndo, true);
  } finally { await browser.close(); }
});
