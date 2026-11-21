import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fillVisibleFields } from '../../extension/generic-fill.js';

test('Rippling phone inspection reveals the offscreen row and requires an actual selection', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = 'https://ats.rippling.com/fixture/jobs/68057679-c967-4707-9423-ea2db74de7c5/apply';
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `
      <form><div><input id="dial" aria-required="true" role="combobox" aria-haspopup="listbox" aria-expanded="false" value="+1 CA">
      <label>Phone number<input type="tel" required></label></div>
      <div id="menu" hidden role="listbox" aria-multiselectable="false" data-testid="menuList"
           data-count="245" data-search-state="settled" data-search-query="">
        <div data-virtuoso-scroller style="height:80px; overflow:auto"><div style="height:9800px">
          <div id="row" data-known-size="40" data-item-index="0"></div>
        </div></div>
      </div></form>` }));
    for (const committed of [true, false]) {
      await page.goto(url);
      await page.evaluate(committed => {
        const input = document.querySelector<HTMLInputElement>('#dial')!;
        const menu = document.querySelector<HTMLElement>('#menu')!;
        const row = document.querySelector<HTMLElement>('#row')!;
        const scroller = menu.querySelector('[data-virtuoso-scroller]')!;
        const render = () => {
          const index = Math.floor(scroller.scrollTop / 40);
          row.dataset.itemIndex = String(index);
          row.innerHTML = `<div id="menu-option-${index}" role="option" aria-selected="${committed && index === 36}"><span>${index === 36 ? '+1 CA' : '+1 US'}</span> - ${index === 36 ? 'Canada' : 'United States'}</div>`;
        };
        scroller.addEventListener('scroll', render);
        input.onclick = () => {
          menu.hidden = false;
          input.setAttribute('aria-controls', menu.id);
          input.setAttribute('aria-expanded', 'true');
          for (const owner of [input, menu]) owner.setAttribute('aria-activedescendant', 'menu-option-36');
          render();
        };
        input.onkeydown = event => {
          if (event.key !== 'Escape') return;
          menu.hidden = true;
          input.removeAttribute('aria-controls');
          input.setAttribute('aria-expanded', 'false');
        };
      }, committed);
      const result = await page.evaluate(fillVisibleFields, { action: 'status' as const, scope: 'page' as const });
      const row = result.matching?.find(field => field.question === 'Phone country code');
      assert.ok(row);
      assert.equal(row.selected, committed ? '+1 CA - Canada' : '');
      assert.equal(await page.locator('#dial').inputValue(), '+1 CA');
      assert.equal(await page.locator('#menu').isVisible(), false);
      assert.equal(await page.locator('[data-virtuoso-scroller]').evaluate(el => el.scrollTop), 0);
    }
  } finally { await browser.close(); }
});
