import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { inspectHostedFields, hostedReviewSnapshot } from '../../src/product/hosted-application.ts';
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

    // The portal removes its option nodes after click. Blur restores the actual
    // selected answer even after a different search string has been displayed.
    await page.reload();
    await page.evaluate(() => {
      const place = document.querySelector<HTMLInputElement>('#location')!;
      const menu = document.getElementById(':r0:')!;
      place.className = 'ashby-application-form-input-autocomplete';
      place.setAttribute('aria-autocomplete', 'list');
      place.setAttribute('aria-expanded', 'false');
      let selected = '';
      function close() {
        menu.hidden = true;
        place.setAttribute('aria-expanded', 'false');
        place.removeAttribute('aria-controls');
      }
      place.oninput = () => {
        menu.hidden = false;
        place.setAttribute('aria-expanded', 'true');
        place.setAttribute('aria-controls', menu.id);
      };
      place.onkeydown = event => { if (event.key === 'Escape') close(); };
      place.onblur = () => { place.value = selected; };
      menu.firstElementChild!.addEventListener('click', () => {
        selected = menu.firstElementChild!.textContent!;
        place.value = selected;
        close();
      });
    });
    await fillApplication(page,{url,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{});
    const ashbyValue = async () => (await inspectHostedFields(page)).find(f=>f.kind==='combobox')?.value;
    assert.equal(await ashbyValue(),'Edmonton, Alberta, Canada');
    await page.locator('#location').fill('Typed, not selected');
    assert.equal(await ashbyValue(),'');
    await page.locator('#location').blur();
    await assert.rejects(hostedReviewSnapshot(page), /Required or invalid fields/);

    const lever = 'https://jobs.lever.co/fixture/11111111-1111-4111-8111-111111111111/apply';
    await page.route(lever, route=>route.fulfill({contentType:'text/html',body:`
      <form><label>Email<input type="email" required></label><label>Name<input required></label>
      <div class="application-field"><label>Current location<input class="location-input" id="location-input" name="location" required></label>
      <input type="hidden" id="selected-location" name="selectedLocation">
      <div class="dropdown-results" hidden><div class="dropdown-location">Edmonton, Kentucky, US</div><div class="dropdown-location">Edmonton, AB, CAN</div></div></div>
      <button>Submit application</button></form>
      <script>
        const input=document.querySelector('#location-input'), menu=document.querySelector('.dropdown-results');
        input.oninput=()=>{menu.hidden=!input.value};
        document.querySelector('form').onsubmit=e=>{window.submitted=true;e.preventDefault()};
        input.onkeydown=e=>{
          const active=menu.querySelector('.dropdown-location-active');
          if(e.key==='ArrowDown'){
            e.preventDefault();
            const next=active?.nextElementSibling||menu.firstElementChild;
            active?.classList.remove('dropdown-location-active');
            next.classList.add('dropdown-location-active');
          }
          if(e.key==='Enter'&&active){
            input.value=active.textContent;
            document.querySelector('#selected-location').value=JSON.stringify({name:active.textContent});
            menu.hidden=true;
          }
        };
      </script>`}));
    await page.goto(lever);
    await fillApplication(page,{url:lever,profile,resume:Buffer.from('%PDF-fixture')},AbortSignal.timeout(12000),()=>{});
    assert.equal(await page.locator('#location-input').inputValue(),'Edmonton, AB, CAN');
    assert.equal(await page.evaluate('window.submitted'),undefined);
    await page.locator('#selected-location').evaluate((e:HTMLInputElement)=>{e.value='{"name":"Other city"}';});
    await assert.rejects(hostedReviewSnapshot(page), /Required or invalid fields/);
  } finally {
    await browser.close();
    await rm(evidence,{recursive:true,force:true});
  }
});
