import type { ElementHandle, Locator } from 'playwright';
import { ApplicationPause } from './application-contract.ts';

// Lever replaces its search results after a debounce. Its keyboard interaction keeps
// focus on the input, even when a fixed header or moving dropdown covers the option.
type LeverInput = HTMLInputElement & { huntLocationKeyGuard?: (event: KeyboardEvent) => void };

export async function chooseLeverLocation(input: Locator, labels: string[], index: number, query: string) {
  const field = input.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " application-field ")][1]');
  const choices = field.locator('.dropdown-results .dropdown-location:visible');
  const expected = labels[index]!;
  const element = await input.elementHandle() as ElementHandle<LeverInput>;
  try {
    if (await field.locator('input#selected-location[type=hidden][name=selectedLocation]').count() !== 1 ||
        labels.filter(label => label.trim() === expected.trim()).length !== 1) {
      throw new ApplicationPause('The location choices or backing field are ambiguous.');
    }
    for (let step = 0; step <= labels.length; step++) {
      const active = await element.evaluate((e, { labels, index, query }) => {
        const field = e.closest('.application-field');
        const options = [...field?.querySelectorAll<HTMLElement>('.dropdown-results .dropdown-location') ?? []]
          .filter(o => o.getClientRects().length && getComputedStyle(o).visibility !== 'hidden');
        if (document.activeElement !== e || e.value !== query || options.length !== labels.length ||
            options.some((o, i) => o.textContent !== labels[i]) || field?.querySelectorAll('#location-input').length !== 1 ||
            field.querySelectorAll('.dropdown-results').length !== 1) return 'changed';
        const active = options.filter(o => o.classList.contains('dropdown-location-active'));
        if (active.length > 1) return 'changed';
        if (active[0] !== options[index]) return 'next';
        const option = active[0]!;
        // Cancel native implicit form submission even if the site removes its key
        // handler. Only the verified input and exact highlighted option may receive Enter.
        const guard = (event: KeyboardEvent) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const highlighted = field.querySelectorAll('.dropdown-results .dropdown-location-active');
          if (e.value !== query || highlighted.length !== 1 || highlighted[0] !== option ||
              option.textContent !== labels[index] || !option.getClientRects().length) event.stopImmediatePropagation();
        };
        e.huntLocationKeyGuard = guard;
        e.addEventListener('keydown', guard, true);
        return 'ready';
      }, { labels, index, query });
      if (active === 'ready') {
        await element.press('Enter');
        return;
      }
      if (active === 'changed' || step === labels.length) break;
      await element.press('ArrowDown');
      if (!await choices.count()) break;
    }
    throw new ApplicationPause('The employer did not highlight the exact location.');
  } finally {
    try {
      await element.evaluate(e => {
        if (e.huntLocationKeyGuard) e.removeEventListener('keydown', e.huntLocationKeyGuard, true);
        delete e.huntLocationKeyGuard;
      });
    } finally { await element.dispose(); }
  }
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
    await element.evaluate(e => e.blur());
    const restored = await element.evaluate((e, expected) => {
      if (!e.isConnected || e === document.activeElement || e.getAttribute('aria-expanded') !== 'false' ||
          e.value !== expected || e.getAttribute('aria-invalid') === 'true') return false;
      e.huntRestoredChoice = expected;
      const clear = () => {
        delete e.huntRestoredChoice;
        e.removeEventListener('input', clear);
        e.removeEventListener('change', clear);
      };
      e.addEventListener('input', clear);
      e.addEventListener('change', clear);
      return true;
    }, expected);
    if (!restored) {
      if (await element.inputValue() === query) {
        await element.fill(expected);
        await element.press('Escape');
        await element.evaluate(e => e.blur());
      }
      throw new ApplicationPause('The employer did not restore the selected dropdown answer after search.');
    }
  } finally { await element.dispose(); }
}
