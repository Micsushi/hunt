import type { Page } from 'playwright';

/** A queued BambooHR posting can open its empty application inside the same document. */
export async function openBambooApplication(page: Page, expectedUrl: string, signal: AbortSignal) {
  const url = new URL(expectedUrl);
  if (!url.hostname.endsWith('.bamboohr.com') || !/^\/careers\/\d+\/?$/.test(url.pathname)) return;
  signal.throwIfAborted();
  const documentHandle = await page.evaluateHandle(() => document);
  try {
    // The public posting metadata arrives before BambooHR mounts either its
    // listing button or its application. Wait without opening a second tab.
    await page.waitForFunction(({doc, expected}) => doc !== document || location.href !== expected ||
      !doc.querySelector('meta[property="og:url"]') ||
      !!doc.querySelector('button[data-bi-id="careers-site-apply-button"],form,input:not([readonly],[type=hidden]),select,textarea'),
    {doc:documentHandle, expected:expectedUrl}, {timeout:5000, polling:100});
    signal.throwIfAborted();
    const opened = await documentHandle.evaluate((doc, expected) => {
      if (doc !== document || location.href !== expected) throw new Error('The posting changed before opening its form.');
      const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility === 'visible' &&
        !e.closest('[hidden],[inert],[aria-hidden=true]');
      const canonical = doc.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content;
      const title = doc.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content.trim();
      const mains = doc.querySelectorAll('main');
      const headings = [...doc.querySelectorAll('h1')].filter(visible);
      if (mains.length !== 1 || headings.length !== 1 || !mains[0]!.contains(headings[0]!) ||
          !title || headings[0]!.textContent.trim() !== title ||
          canonical?.replace(/\/$/, '') !== (location.origin + location.pathname).replace(/\/$/, '')) return false;
      // The share-link textbox is read-only. Any form or other editable surface
      // means this is no longer the pristine listing.
      if (doc.forms.length || [...doc.querySelectorAll('input,textarea,select,[contenteditable=true],[role=form],dialog,[role=dialog],iframe,[type=submit]')]
        .some(e => visible(e) && !(e instanceof HTMLInputElement && e.type === 'text' && e.readOnly && e.value === canonical))) return false;
      const buttons = [...mains[0]!.querySelectorAll<HTMLButtonElement>('button[data-bi-id="careers-site-apply-button"]')].filter(visible);
      if (!buttons.length || buttons.some(b => b.type !== 'button' || b.disabled || b.matches(':disabled,[aria-disabled=true],[form],[formaction]') ||
          b.form || b.closest('a,[role=form]') || (b.getAttribute('aria-label') ?? b.textContent).trim() !== 'Apply for This Job')) return false;
      const button = buttons.find(b => {
        const box = b.getBoundingClientRect();
        return b.contains(doc.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      });
      if (!button) return false;
      button.click();
      return true;
    }, expectedUrl);
    if (opened) {
      await page.waitForFunction(({doc, expected}) => doc === document && location.href === expected &&
        [...doc.querySelectorAll('form#job-application-form')].some(f => f.getClientRects().length &&
          f.querySelector('input[type=email],input[type=text][name=email]')),
      {doc:documentHandle, expected:expectedUrl}, {timeout:5000, polling:100});
    }
  } finally {
    await documentHandle.dispose();
  }
  signal.throwIfAborted();
}
