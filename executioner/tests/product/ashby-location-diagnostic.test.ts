import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillApplication } from '../../src/product/engine.ts';
import { applicantProfile } from '../../src/product/sources.ts';

test('Location selection clears a fixed header and reports a persistent obstruction without advancing', async () => {
  const evidence = await mkdtemp(join(tmpdir(),'hunt-location-'));
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    const url = 'https://jobs.ashbyhq.com/fixture/11111111-1111-4111-8111-111111111111/application';
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`
      <label>Name<input required></label><label>Email<input type="email" required></label>
      <div data-field-path="_systemfield_location"><label for="location">Location</label>
      <input id="location" role="combobox" aria-controls=":r0:" required>
      <div role="listbox" id=":r0:" hidden><div role="option">Edmonton, Alberta, Canada</div></div>
      <div id="obstruction" hidden style="position:fixed;inset:0;z-index:10"></div></div>
      <button onclick="window.submitted=true">Submit application</button>
      <script>const place=document.querySelector('#location');place.oninput=()=>{
        document.getElementById(':r0:').hidden=!place.value;
        document.querySelector('#obstruction').hidden=!place.value;
      };</script>`}));
    await page.goto(url);
    const profile = applicantProfile({given_name:'Fixture',family_name:'Applicant',email_address:'fixture@example.invalid',city:'Edmonton',region:'Alberta',country:'Canada'});
    await assert.rejects(fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture'),learningRoot:evidence},AbortSignal.timeout(12000),()=>{}),/Timeout or control change while selecting the location/);
    const receipt = await readFile(join(evidence,'hosted-questions.json'),'utf8');
    assert.match(receipt,/location_click_intercepted/);
    assert.doesNotMatch(receipt,/Edmonton|obstruction|pointer events/);
    assert.equal(await page.evaluate('window.submitted'),undefined);

    // The same owned choice can be exposed below a fixed employer header.
    await page.reload();
    await page.evaluate(() => {
      document.body.style.cssText = 'margin-top:900px;min-height:2000px';
      const place = document.querySelector<HTMLInputElement>('#location')!;
      const panel = document.getElementById(':r0:')!, option = panel.firstElementChild as HTMLElement;
      const header = document.getElementById('obstruction')!;
      header.className = 'main-header';
      header.style.cssText = 'position:fixed;inset:0 0 auto;height:160px;z-index:10';
      place.addEventListener('input', () => {
        if (!place.value) return;
        scrollTo({top:scrollY + option.getBoundingClientRect().top - 50, behavior:'instant'});
        const box = option.getBoundingClientRect();
        header.dataset.intercepted = String(document.elementFromPoint(box.x + box.width/2, box.y + box.height/2) === header);
      });
      option.onclick = () => {
        place.value = option.textContent!;
        option.setAttribute('aria-selected','true');
        panel.hidden = true;
      };
    });
    const filled = await fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{});
    assert.ok(filled.reviewDigest);
    assert.equal(await page.locator('#obstruction').getAttribute('data-intercepted'),'true');
    assert.equal(await page.locator('[role=option]').getAttribute('aria-selected'),'true');
    assert.equal(await page.evaluate('window.submitted'),undefined);
  } finally {
    await browser.close();
    await rm(evidence,{recursive:true,force:true});
  }
});
