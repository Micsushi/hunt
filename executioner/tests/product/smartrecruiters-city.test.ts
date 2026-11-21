import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';
import { applicantProfile, effectiveProfileFacts, productSources } from '../../src/product/sources.ts';
import { disposeResumeArtifact } from '../../src/contracts/resume-artifact.ts';
import { createPageAnswerPlanner } from '../../src/product/page-answer-planner.ts';

test('OneClick city search verifies the selected location and supports Undo and Redo', async () => {
  const browser = await chromium.launch({headless:true});
  const profile = applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid',city:'Example',region:'Ontario',country:'Canada'});
  const facts = effectiveProfileFacts(profile);
  const sources = productSources(profile, Buffer.from('%PDF-fixture'));
  const plan = createPageAnswerPlanner(sources,facts,'Fixture');
  try {
    const page = await browser.newPage();
    const url = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Fixture/publication/12345678-1111-2222-3333-111111111111';
    await page.route(url, route => route.fulfill({contentType:'text/html',body:
      '<main><oc-oneclick-form><h2>Personal information</h2><label>First Name<input></label><label>Email<input type=email></label>' +
      '<oc-location-autocomplete><spl-autocomplete id="city" label="City" data-test="location-autocomplete"></spl-autocomplete></oc-location-autocomplete>' +
      '<oc-resume-upload><spl-dropzone data-test="resume-upload"><label>Resume<input type=file></label></spl-dropzone></oc-resume-upload></oc-oneclick-form></main>'}));
    await page.goto(url);
    await page.evaluate(() => {
      const host = document.querySelector('spl-autocomplete')!;
      const root = host.attachShadow({mode:'open'});
      root.innerHTML = '<input aria-label="City" required role=combobox aria-autocomplete=list aria-controls="city-list" aria-expanded=false aria-invalid=true>' +
        '<spl-icon role=button aria-label="Clear City value" hidden>Clear</spl-icon><div id="city-list" role=listbox hidden></div>';
      const input = root.querySelector('input')!, menu = root.querySelector<HTMLElement>('[role=listbox]')!, clear = root.querySelector<HTMLElement>('spl-icon')!;
      const close = () => { input.setAttribute('aria-expanded','false'); menu.hidden = true; };
      input.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
      input.addEventListener('input', () => {
        menu.replaceChildren();
        if (!input.value) { close(); return; }
        input.setAttribute('aria-expanded','true'); menu.hidden = false;
        for (const label of ['Example, Ontario, Canada','Example, Ohio, United States']) {
          const item = document.createElement('spl-dropdown-item');
          item.innerHTML = '<div class="c-spl-autocomplete-default-option"><div data-sr-id="example-content"><spl-truncate></spl-truncate></div></div>';
          const title = item.querySelector<HTMLElement>('spl-truncate')!;
          title.title = label; title.textContent = label;
          const shadow = item.attachShadow({mode:'open'});
          shadow.innerHTML = '<div role=option aria-disabled=false><slot></slot></div>';
          shadow.querySelector('div')!.onclick = () => {
            input.value = label; host.setAttribute('value','[object Object]');
            clear.hidden = false; input.setAttribute('aria-invalid','false'); close();
          };
          menu.append(item);
        }
      });
      clear.onclick = () => {
        input.value = ''; host.removeAttribute('value'); clear.hidden = true;
        input.setAttribute('aria-invalid','true'); menu.replaceChildren(); close();
      };
    });
    const city = async () => {
      const status = await page.evaluate(fillVisibleFields,{facts,action:'status' as const});
      const row = status.matching?.find(field => field.question === 'City');
      assert.ok(row, JSON.stringify(status.matching?.map(r=>r.question)));
      return row;
    };
    const initial = await city();
    assert.equal(initial.queryable,true);
    const signal = new AbortController().signal;
    const search = await plan(initial,[initial],signal);
    assert.equal(search.query,'Example');
    await page.evaluate(fillVisibleFields,{facts,matchingPlans:[search]});
    const options = await city();
    assert.equal(options.selected,'');
    const selection = await plan(options,[options],signal);
    const answer = 'Example, Ontario, Canada';
    assert.equal(selection.answer,answer);
    const filled = await page.evaluate(fillVisibleFields,{facts,matchingPlans:[selection]});
    assert.deepEqual(filled.filled,['City'],JSON.stringify(filled.skipped));
    assert.equal((await city()).selected,answer);
    await page.evaluate(fillVisibleFields,{action:'undo' as const});
    assert.equal(await page.locator('input[role=combobox]').inputValue(),'');
    assert.equal(await page.locator('spl-autocomplete').getAttribute('value'),null);
    await page.evaluate(fillVisibleFields,{action:'redo' as const});
    assert.equal((await city()).selected,answer);
    await page.locator('input[role=combobox]').evaluate((el:HTMLInputElement) => { el.value = 'Owner edit'; });
    await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/changed/i);
    assert.equal(await page.locator('input[role=combobox]').inputValue(),'Owner edit');
  } finally { disposeResumeArtifact(sources.resumeIntent.artifact); await browser.close(); }
});
