import { smartRecruitersPublication } from './smartrecruiters-target.ts';
import type { Page } from 'playwright';
import type { ComponentFailure } from './component-diagnostics.ts';
import { pause } from './application-wait.ts';

const firstFooter = 'oc-nav-first-page footer[data-test=footer]';
const safeSkips = new Set(['optional_field','saved_value_already_present','selected_resume_already_present',
  'resume_filename_visible_contents_unverified']);

export async function advanceSmartRecruiters(page:Page, url:string, report:{
  skipped:{reason:string}[]; resume?:string; componentFailure?:ComponentFailure;
}, signal:AbortSignal, screeningTransition?: (url:string) => () => Promise<void>): Promise<string | {screeningUrl:string} | undefined> {
  const target = new URL(url);
  const publication = smartRecruitersPublication(target);
  if (!publication || page.url() !== url) return;
  const owner = page.locator(publication.screening ? 'main oc-screening-questions' : 'main oc-oneclick-form');
  if (await owner.count() !== 1) return;
  const footer = owner.locator(firstFooter);
  const submit = publication.screening
    ? owner.locator('oc-nav-screening-questions oc-button[data-test=footer-submit] spl-button').filter({hasText:/^\s*Submit(?: application)?\s*$/i}).locator('button')
    : owner.getByRole('button',{name:/^(?:submit(?: application)?|send application)$/i});
  const terminal = async () => {
    if (page.url() !== url || await submit.count() !== 1 || !await submit.isVisible()) return;
    const review = owner.getByRole('heading',{name:/^review(?: your application)?$/i});
    return await review.count() === 1 && await review.isVisible()
      ? 'The employer Review screen is open. C3 stopped before submission.'
      : 'The employer shows its final submission button. C3 stopped before submission.';
  };
  const end = await terminal();
  if (end) return end;
  if (publication.screening || !screeningTransition) return;
  const filenameOnly = report.resume === 'unverified' && report.skipped.some(item => item.reason === 'resume_filename_visible_contents_unverified');
  const failure = report.componentFailure;
  if (failure && !(filenameOnly && failure.component === 'uploads' && failure.operation === 'verify_attachment')) return;
  if (report.skipped.some(item => !safeSkips.has(item.reason)) ||
      !filenameOnly && !['verified','optional'].includes(report.resume ?? '')) return;
  const personal = owner.locator('oc-personal-information');
  const host = footer.locator('oc-button[data-test=footer-next] spl-button');
  const next = host.locator('button[type=button]');
  if (await footer.count() !== 1 || await personal.count() !== 1 || await host.count() !== 1 ||
      await next.count() !== 1 || !await next.isVisible() || !await next.isEnabled()) return;
  if (await owner.locator('input:invalid:visible,select:invalid:visible,textarea:invalid:visible,[aria-invalid=true]:visible,[aria-busy=true]:visible').count() ||
      await page.locator('[role=dialog]:visible,dialog[open]:visible').count()) return;
  const handle = await next.elementHandle();
  if (!handle) return;
  let sent = false, clicked = false;
  try {
    await handle.scrollIntoViewIfNeeded({timeout:2000});
    signal.throwIfAborted();
    const allowScreening = screeningTransition(url);
    sent = true;
    clicked = await handle.evaluate((node,url) => {
      const button = node as HTMLButtonElement;
      const host = (button.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
      const action = host?.closest('oc-button[data-test=footer-next]');
      const footer = action?.closest('footer[data-test=footer]');
      const first = footer?.closest('oc-nav-first-page');
      const form = first?.closest('oc-oneclick-form');
      if (location.href !== url || !host?.matches('spl-button') || !form || !form.closest('main') ||
          form.querySelectorAll('oc-personal-information').length !== 1 || form.querySelectorAll('oc-nav-first-page').length !== 1 ||
          footer!.querySelectorAll('oc-button[data-test=footer-next]').length !== 1 || host.innerText.trim() !== 'Next' ||
          !button.isConnected || button.type !== 'button' || button.form || button.disabled || button.hasAttribute('formaction') ||
          host.closest('[inert],[hidden],[aria-disabled=true],[aria-hidden=true]') || host.hasAttribute('disabled') ||
          host.shadowRoot?.querySelectorAll('button').length !== 1 || button.getAttribute('aria-disabled') === 'true') return false;
      const rect = button.getBoundingClientRect(), x = rect.left + rect.width/2, y = rect.top + rect.height/2;
      let hit = document.elementFromPoint(x,y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x,y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (!hit || !(hit === host || button.contains(hit) || host.contains(hit))) return false;
      const state = (globalThis as any).__huntC3PartialFill;
      if (!state || state.busy || state.smartRecruitersNextPanel === first) return false;
      state.smartRecruitersNextPanel = first;
      button.click();
      return true;
    }, url);
    if (!clicked) return;
    await allowScreening();
    const deadline = Date.now() + 4000;
    do {
      await pause(signal);
      if (page.url() !== url) {
        const current = new URL(page.url()), next = smartRecruitersPublication(current);
        if (next?.screening && next.base === publication.base && current.search === target.search) return {screeningUrl:current.href};
        break;
      }
      const end = await terminal();
      if (end) return end;
    } while (Date.now() < deadline);
    if (page.url() === url && await owner.count() === 1 && !await personal.count() && !await next.count()) {
      return 'C3 clicked Next and the personal-information step closed. Inspect the new employer step.';
    }
  } catch (error) {
    if (!sent) throw error;
    if (!clicked) return 'C3 attempted Next. Check which employer step is open before retrying.';
  } finally {
    // Releasing a handle from the previous document cannot undo a click or invalidate its observation.
    await handle.dispose().catch(()=>{});
  }
  return 'C3 clicked Next once. Check the employer screening step before retrying.';
}
