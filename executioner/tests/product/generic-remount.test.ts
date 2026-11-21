import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';

const facts = [
  { factId: 'given_name', value: 'Fixture' },
  { factId: 'email_address', value: 'fixture@example.invalid' },
  { factId: 'address_line1', value: '10 Fixture Street' },
  { factId: 'city', value: 'Ottawa' },
  { factId: 'region', value: 'Ontario' },
  { factId: 'postal_code', value: 'K1A 0B1' },
  { factId: 'earliest_start_date', value: '2027-01-05' },
  { factId: 'salary_expectations', value: 'CAD 80,000 per year' },
];
const contact = '<label>First name<input name="first" required></label><label>Email<input type="email" name="email" required></label>';
const bambooFields = `
  <label for="FabricTextField78">Address *</label><input id="FabricTextField78" name="streetAddress.value">
  <label for="FabricTextField79">City *</label><input id="FabricTextField79" name="city.value">
  <label for="FabricTextField80">Postal Code *</label><input id="FabricTextField80" name="zip.value">
  <label for="FabricTextField81">Date Available</label><input required id="FabricTextField81" placeholder="mm/dd/yyyy">`;
const bambooForm = (script: string) => `<form id="job-application-form">${contact}
  <div id="address-controls">${bambooFields}</div><button type="button">Submit application</button>
  </form><script>${script}</script>`;
const remount = `
  let generation = 0;
  const remount = () => {
    for (const old of document.querySelectorAll('#address-controls input')) {
      const label = old.labels[0];
      const next = old.cloneNode();
      next.value = old.value;
      next.id = 'FabricTextField' + (++generation + 100);
      label.htmlFor = next.id;
      old.replaceWith(next);
    }
  };`;

test('BambooHR remounts before and after writes preserve verified field history', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = 'https://fixture.bamboohr.com/careers/823';
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: bambooForm(`
      ${remount}
      document.querySelector('form').addEventListener('input', remount);
    `) }));
    await page.goto(url);
    const controls = page.locator('#address-controls input');
    const values = () => controls.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value));
    const expected = ['10 Fixture Street', 'Ottawa', 'K1A 0B1', '01/05/2027'];
    const result = await page.evaluate(fillVisibleFields, { facts });
    assert.deepEqual(await values(), expected);
    assert.equal(await page.locator('#FabricTextField78').count(), 0);
    assert.equal(result.filled.filter(label => /Address|City|Postal/.test(label)).length, 3);
    assert.ok(result.filled.includes('Date Available'));
    await page.evaluate(fillVisibleFields, { action: 'undo' as const });
    assert.deepEqual(await values(), ['', '', '', '']);
    await page.evaluate(fillVisibleFields, { action: 'redo' as const });
    assert.deepEqual(await values(), expected);
    await controls.nth(1).evaluate(node => { (node as HTMLInputElement).value = 'Manual city'; });
    await assert.rejects(page.evaluate(fillVisibleFields, { action: 'undo' as const }), /Fields changed/);
    assert.deepEqual(await values(), ['10 Fixture Street', 'Manual city', 'K1A 0B1', '01/05/2027']);
  } finally {
    await browser.close();
  }
});

test('BambooHR remount refuses ambiguous same-form semantic matches', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = 'https://fixture.bamboohr.com/careers/823';
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: bambooForm(`
      ${remount}
      document.querySelector('[name=first]').addEventListener('input', () => {
        remount();
        document.querySelector('#address-controls').insertAdjacentHTML('beforeend',
          '<label for="FabricTextField900">City *</label><input id="FabricTextField900" name="city.value">');
      }, {once:true});
    `) }));
    await page.goto(url);
    const result = await page.evaluate(fillVisibleFields, { facts });
    assert.deepEqual(await page.locator('[name="city.value"]').evaluateAll(nodes =>
      nodes.map(node => (node as HTMLInputElement).value)), ['', '']);
    assert.ok(result.skipped.some(item => item.label.startsWith('City') &&
      /ambiguous|stable_identity/.test(item.reason)));
    assert.equal(await page.locator('[name="zip.value"]').inputValue(), 'K1A 0B1');
  } finally {
    await browser.close();
  }
});

test('JazzHR aliases require the address group and native text salary', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form>${contact}<div class="form-group" id="resumator-address">
      <label id="resumator-address-label" for="resumator-address-value">Address</label>
      <div id="resumator-address-field">
        <input required id="resumator-address-value" name="resumator-address-value" placeholder="Address">
        <input required id="resumator-city-value" name="resumator-city-value" placeholder="City">
        <input required id="resumator-state-value" name="resumator-state-value" placeholder="State/Province">
        <input required id="resumator-postal-value" name="resumator-postal-value" placeholder="Postal">
      </div>
      </div><label>Desired salary<input required id="text-salary" type="text"></label>
      <button type="button">Submit application</button></form>
      <form id="other">${contact}
        <input required id="resumator-city-value" name="resumator-city-value" placeholder="City">
        <label>Desired salary<input required id="numeric-salary" type="number"></label>
        <button type="button">Submit application</button></form>`);
    // Use a separate page for the duplicate identifier: the valid Jazz group
    // requires each document ID to be unique.
    await page.locator('#other [name="resumator-city-value"]').evaluate(node => node.remove());
    await page.evaluate(fillVisibleFields, { facts });
    assert.equal(await page.locator('#resumator-address-value').inputValue(), '10 Fixture Street');
    assert.equal(await page.locator('#resumator-city-value').inputValue(), 'Ottawa');
    assert.equal(await page.locator('#resumator-state-value').inputValue(), 'Ontario');
    assert.equal(await page.locator('#resumator-postal-value').inputValue(), 'K1A 0B1');
    assert.equal(await page.locator('#text-salary').inputValue(), 'CAD 80,000 per year');
    assert.equal(await page.locator('#numeric-salary').inputValue(), '');
    await page.setContent(`<form>${contact}
      <input required id="resumator-city-value" name="resumator-city-value" placeholder="City">
      <button type="button">Submit application</button></form>`);
    await page.evaluate(fillVisibleFields, { facts });
    assert.equal(await page.locator('#resumator-city-value').inputValue(), '');
  } finally {
    await browser.close();
  }
});
