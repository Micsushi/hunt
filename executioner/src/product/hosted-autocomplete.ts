import type { ElementHandle, Locator, Page } from 'playwright';
import { ApplicationPause } from './application-contract.ts';

// Wait for Lever's debounced employer search to finish. A previous query's menu
// can remain visible until its replacement request starts.
export async function searchLeverLocation(input: Locator, query: string) {
  const url = new URL(input.page().url());
  const settled = input.page().waitForResponse(response => {
    const result = new URL(response.url());
    return result.origin === url.origin && result.pathname === '/searchLocations' &&
      result.searchParams.get('text') === query && response.request().frame() === input.page().mainFrame();
  }, {timeout:10000}).then(async response => response.ok() && !await response.finished()).catch(() => false);
  await input.fill('');
  await input.pressSequentially(query, {delay:30});
  if (!await settled) throw new ApplicationPause('The employer location search did not finish.');
}

type AshbyInput = HTMLInputElement & { huntRestoredChoice?: string };

// Ashby restores selectedItemText on blur and discards a nonempty search query.
// Exercise that distinction before letting the passive Review reader use the value.
export async function verifyAshbyAutocomplete(input: Locator, expected: string) {
  const element = await input.elementHandle() as ElementHandle<AshbyInput>;
  try {
    if (!await element.evaluate(e => location.hostname === 'jobs.ashbyhq.com' &&
      e.matches('input.ashby-application-form-input-autocomplete[role=combobox][aria-autocomplete=list]'))) return;
    if (await element.inputValue() !== expected || !expected.trim()) throw new ApplicationPause('The selected dropdown answer did not persist.');
    const query = expected.length > 1 ? expected.slice(0, -1).trimEnd() || expected + ' ' : expected + 'x';
    await element.fill(query);
    if (await element.inputValue() !== query) throw new ApplicationPause('The employer did not display the dropdown search.');
    await element.press('Escape');
    if (await element.inputValue() !== query) throw new ApplicationPause('The dropdown search changed before its selection could be verified.');
    const result = await element.evaluate((e, expected) => {
      e.blur();
      if (!e.isConnected || e === document.activeElement || e.getAttribute('aria-expanded') !== 'false' ||
          e.value !== expected || e.getAttribute('aria-invalid') === 'true') return {restored:false, value:e.value};
      e.huntRestoredChoice = expected;
      const clear = () => {
        delete e.huntRestoredChoice;
        e.removeEventListener('input', clear);
        e.removeEventListener('change', clear);
      };
      e.addEventListener('input', clear);
      e.addEventListener('change', clear);
      return {restored:true, value:e.value};
    }, expected);
    if (!result.restored) {
      // A nonempty Ashby query leaves selectedItemText untouched. Restore the
      // owner's original display without blurring it away a second time.
      if (result.value !== expected && await element.inputValue() === result.value) {
        await element.fill(expected);
        await element.press('Escape');
      }
      throw new ApplicationPause('The employer did not restore the selected dropdown answer after search.');
    }
  } finally { await element.dispose(); }
}


export async function preserveAshbyChoices(page: Page, fields: readonly {key: string; required: boolean; kind: string; value: string}[]) {
  const candidates = await page.locator('input.ashby-application-form-input-autocomplete[role=combobox][aria-autocomplete=list]:visible').evaluateAll(
    (inputs, fields) => inputs.flatMap(node => {
      const e = node as HTMLInputElement;
      const field = fields.find(f => f.key === e.dataset.c3Hosted && f.kind === 'combobox');
      if (!field || !e.value || field.value) return [];
      return [{key:field.key, value:e.value, required:field.required,
        editing:e === document.activeElement || e.getAttribute('aria-expanded') !== 'false'}];
    }), fields);
  if (candidates.some(choice=>choice.editing)) throw new ApplicationPause('A dropdown has an unfinished search. Its text has been preserved.');
  for (const choice of candidates) {
    if (choice.required) await verifyAshbyAutocomplete(page.locator(`[data-c3-hosted="${choice.key}"]`), choice.value);
  }
}
