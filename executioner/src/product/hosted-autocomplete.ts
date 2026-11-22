import type { ElementHandle, Locator, Page } from 'playwright';
import { ApplicationPause } from './application-contract.ts';

// Lever replaces its option nodes after a debounced search. Its UI can finish
// even when the paired browser does not deliver the request completion event.
export async function searchLeverLocation(input: Locator, query: string) {
  const search = await input.evaluateHandle(element => {
    const editor = element as HTMLInputElement;
    const field = editor.closest('.application-field');
    const menus = field?.querySelectorAll('.dropdown-results');
    const menu = menus?.length === 1 ? menus[0] : null;
    return {editor, menu, previous: [...menu?.children ?? []], seen: [] as Element[]};
  });
  try {
    await input.fill('');
    await input.pressSequentially(query, {delay:30});
    const result = await input.page().waitForFunction(({search, query}) => {
      const {editor, menu} = search;
      if (!menu?.isConnected || !editor.isConnected || editor.value !== query ||
          editor.closest('.application-field') !== menu.closest('.application-field')) return false;
      const visible = (node: Element) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      const busy = menu.closest('.dropdown-container')?.querySelector('.dropdown-loading-results');
      const options = [...menu.querySelectorAll(':scope > div.dropdown-location')].filter(visible);
      if (!options.length || busy && visible(busy) || options.some(o => search.previous.includes(o))) {
        search.seen = [];
        return false;
      }
      const stable = options.length === search.seen.length && options.every((o,i) => search.seen[i] === o);
      search.seen = options;
      return stable;
    }, {search, query}, {polling:100, timeout:10000});
    await result.dispose();
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return false;
    throw error;
  } finally { await search.dispose(); }
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
