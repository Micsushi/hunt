import type { Page } from 'playwright';
import { ApplicationPause } from './application-contract.ts';

/** Lever fades between parser messages. A locally selected file alone does not mean parsing is finished. */
export async function settleLeverResume(page: Page): Promise<boolean> {
  const read = await page.evaluateHandle(() => {
    const field = document.querySelector('li.application-question.resume > label > .application-field');
    const pickers = field?.querySelectorAll<HTMLInputElement>('a.visible-resume-upload input[type=file][name=resume][data-qa=input-resume]');
    const input = pickers?.length === 1 ? pickers[0] : undefined;
    const file = input?.files?.length === 1 ? input.files[0] : undefined;
    let sawParser = false;
    return () => {
      if (!field || !input || !file) return 'absent';
      if (!field.isConnected || !field.contains(input) || input.files?.[0] !== file) return 'changed';
      const visible = (element: Element | null, opacity = true) => Boolean(element &&
        !element.closest('[hidden],[inert],[aria-hidden=true]') && element.checkVisibility({visibilityProperty:true, opacityProperty:opacity}));
      const status = (selector: string) => field.querySelector(':scope > ' + selector);
      const working = status('.resume-upload-working'), success = status('.resume-upload-success'), failure = status('.resume-upload-failure');
      if (visible(field.closest('li.resume')?.querySelector(':scope > .resume-upload-oversize') ?? null)) return 'oversize';
      if (visible(failure)) return 'failed';
      if (visible(working,false) || visible(success,false) || visible(failure,false)) sawParser = true;
      if (visible(working,false) || (sawParser && !visible(success))) return false;
      const name = field.querySelector(':scope > a.visible-resume-upload > .filename');
      return visible(name) && name?.textContent?.trim() === file.name ? 'filename' : 'absent';
    };
  });
  try {
    const state = await page.waitForFunction(read => read(), read, {timeout:15_000, polling:100});
    const result = await state.jsonValue();
    await state.dispose();
    if (result === 'failed') throw new ApplicationPause('Lever could not auto-read the resume. Inspect the attachment and the application fields.');
    if (result === 'oversize') throw new ApplicationPause('Lever rejected the resume file size. Inspect the attachment.');
    if (result === 'changed') throw new ApplicationPause('The resume control changed while Lever was reading it. Inspect the draft.');
    return result === 'filename';
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new ApplicationPause('Lever has not finished reading the resume. Inspect the draft before retrying.');
    throw error;
  } finally { await read.dispose(); }
}
