import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';
import { applicantProfile, effectiveProfileFacts, productSources } from '../../src/product/sources.ts';
import { disposeResumeArtifact } from '../../src/contracts/resume-artifact.ts';
import { createPageAnswerPlanner } from '../../src/product/page-answer-planner.ts';

test('Rippling location commits a matched suggestion, reverses it and preserves unowned full text', async () => {
  const browser = await chromium.launch();
  const profile = applicantProfile({given_name:'Test',family_name:'Applicant',email_address:'test@example.invalid',city:'Example',region:'Ontario',country:'Canada'});
  const facts=effectiveProfileFacts(profile), sources=productSources(profile,Buffer.from('%PDF-fixture'));
  const plan=createPageAnswerPlanner(sources,facts,'Fixture');
  const url='https://ats.rippling.com/fixture/jobs/68057679-c967-4707-9423-ea2db74de7c5/apply';
  try {
    const page=await browser.newPage();
    await page.route(url,route=>route.fulfill({contentType:'text/html',body:`
      <form><label>First name<input></label><label>Email<input type=email></label>
        <span id="city-label">Location</span><div data-testid="location">
          <input id="city" aria-required="true" aria-labelledby="city-label" aria-label="textbox" aria-autocomplete="list" aria-haspopup="listbox">
        </div><input type=hidden data-testid=input-externalPlaceId><label>Resume<input type=file></label></form>`}));
    const answer='Example, ON, Canada';
    for(const scenario of ['', 'Example', answer, 'open city search']){
      const original=scenario==='open city search'?'Example':scenario;
      await page.goto(url);
      await page.evaluate(({original,answer})=>{
        const input=document.querySelector<HTMLInputElement>('#city')!, owner=input.parentElement!;
        const place=document.querySelector<HTMLInputElement>('[data-testid=input-externalPlaceId]')!;
        const close=()=>{owner.querySelector('ul')?.remove();input.setAttribute('aria-controls','city-list');};
        close();
        input.value=original;
        input.onkeydown=e=>{if(e.key==='Escape')close();};
        input.oninput=()=>{
          close();place.value='';if(!input.value)return;
          const menu=document.createElement('ul');
          menu.id='city-list';menu.dataset.testid='menuList';menu.setAttribute('role','listbox');menu.setAttribute('aria-labelledby','city-label');
          input.setAttribute('aria-controls',menu.id);owner.append(menu);
          for(const text of ['Example, TX, United States',answer]){
            const option=document.createElement('li');option.dataset.selectable='true';option.setAttribute('role','option');
            option.innerHTML='<div data-testid="menuListLabel"></div>';option.firstChild!.textContent=text;menu.append(option);
            option.onclick=()=>{input.value=text;place.value='place-'+text;close();};
          }
        };
      },{original,answer});
      if(scenario==='open city search') await page.locator('#city').dispatchEvent('input');
      const status=async()=>{
        const result=await page.evaluate(fillVisibleFields,{facts,action:'status' as const});
        const row=result.matching?.find(r=>r.widget==='rippling-location');assert.ok(row,JSON.stringify(result.matching?.map(r=>r.question)));return row;
      };
      const apply=async()=>{
        const row=await status(), proposal=await plan(row,[row],new AbortController().signal);
        return page.evaluate(fillVisibleFields,{facts,matchingPlans:[proposal]});
      };
      if(original===answer){
        const result=await apply();assert.ok(result.skipped.some(s=>s.reason==='existing_search_query_preserved'));
        assert.equal((await status()).selected,'');continue;
      }
      if(scenario!=='open city search')await apply();
      const selected=await apply();
      assert.ok(selected.filled.includes('Location'),JSON.stringify(selected.skipped));assert.equal((await status()).selected,answer);
      assert.ok(await page.locator('[data-testid=input-externalPlaceId]').inputValue());
      await page.evaluate(fillVisibleFields,{action:'undo' as const});
      assert.equal(await page.locator('#city').inputValue(),original);
      assert.equal(await page.locator('[data-testid=input-externalPlaceId]').inputValue(),'');
      await page.evaluate(fillVisibleFields,{action:'redo' as const});assert.equal((await status()).selected,answer);
      await page.locator('#city').fill('Owner edit');await page.locator('#city').fill(answer);
      assert.equal((await status()).selected,'');
      await assert.rejects(page.evaluate(fillVisibleFields,{action:'undo' as const}),/changed/i);
    }
  } finally {disposeResumeArtifact(sources.resumeIntent.artifact);await browser.close();}
});
