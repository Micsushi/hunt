import { inspectChoiceWidget } from '../../extension/shared-choice-widget.js';
import type { Page, Frame, FileChooser } from 'playwright';
import { parseApplicationProfile } from '../profile/application-profile.ts';
import { fillVisibleFields, bambooResumeControl } from '../../extension/generic-fill.js';
import { annotateQuestionContext } from '../../extension/question-context.js';
import { proveJobviteResumeInput } from '../../extension/jobvite-resume.js';
import { genericApplicationTarget } from './target.ts';
import { fillMatchedPage } from './page-matching.ts';
import { effectiveProfileFacts } from './sources.ts';

/** Observe a native chooser without selecting a file; the shared filler owns bytes and history. */
export async function proveBambooResumeInput(page:Page, expectedUrl:string, signal:AbortSignal, expiresAt:number) {
  const check=()=>{signal.throwIfAborted();if (Date.now()>=expiresAt || page.url()!==expectedUrl) throw new Error('The application changed or this upload expired. Inspect it again.');};
  check();
  const found=await page.evaluateHandle(bambooResumeControl);
  const handles:{dispose():Promise<void>}[]=[found];
  let listener:((chooser:FileChooser)=>void)|undefined,timer:NodeJS.Timeout|undefined;
  try {
    if (!await found.evaluate(value=>value!==null)) return;
    const input=(await found.getProperty('input')).asElement();
    const button=(await found.getProperty('button')).asElement();
    if (!input || !button) return;
    handles.push(input,button);
    check();
    const observed:FileChooser[]=[];
    // Keep interception through validation, including any wrong chooser event.
    const event=new Promise<FileChooser|null>(resolve=>{
      listener=chooser=>{observed.push(chooser);resolve(chooser);};
      page.on('filechooser',listener);
      timer=setTimeout(()=>resolve(null),Math.max(1,Math.min(2500,expiresAt-Date.now())));
    });
    const [chooser]=await Promise.all([
      event,
      button.click({timeout:Math.max(1,Math.min(2500,expiresAt-Date.now())),noWaitAfter:true}),
    ]);
    check();
    if (!chooser || observed.length!==1) throw new Error('Choose File did not identify one upload field. No resume was sent.');
    const chosen=chooser.element();handles.push(chosen);
    if (!await input.evaluate((element,chosen)=>element===chosen && element.isConnected,chosen)) {
      throw new Error('Choose File opened a different upload field. No resume was sent.');
    }
    await page.evaluate(found=>{
      const {input,button,group,form}=found!;
      if (!input.isConnected || !button.isConnected || input.form!==form || !group.contains(input) || !group.contains(button)) throw new Error('The upload field changed.');
      const state=(globalThis as any).__huntC3PartialFill??={undo:[],redo:[],busy:false};
      if (state.busy || state.resumeAttempt) throw new Error('An upload is already pending review.');
      (state.nativeFileBindings??=new WeakMap()).set(input,{region:form,group,button});
    },found);
    check();
    // No setFiles call: the intercepted chooser receives no payload.
  } finally {
    clearTimeout(timer);if (listener) page.off('filechooser',listener);
    await Promise.allSettled(handles.map(handle=>handle.dispose()));
  }
}

/** Same partial filler as the extension. Never advances or submits an application. */
export async function fillGenericIdentityFields(page: Page | Frame, profile: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an HTTPS application page.');
  const admitted = parseApplicationProfile(profile);
  await page.evaluate(`void(globalThis.__huntC3ChoiceWidget=(${inspectChoiceWidget.toString()}))`);
  await page.evaluate(annotateQuestionContext);
  const result = await page.evaluate(fillVisibleFields, { facts: admitted.facts, action: 'fill' as const });
  signal.throwIfAborted();
  return result;
}

/** Queued unfamiliar jobs use the per-job PDF and the saved profile for this exact application. */
export async function fillGenericApplication(
  page: Page,
  expectedUrl: string,
  settings: unknown,
  resume: Buffer,
  signal: AbortSignal,
  learningRoot?: string,
) {
  signal.throwIfAborted();
  const expected = genericApplicationTarget(expectedUrl);
  const current = genericApplicationTarget(page.url());
  if (current.key !== expected.key) throw new Error('Open the application form for this exact posting before filling.');
  const expiresAt=Date.now()+15_000;
  const boundUrl=page.url();
  await page.evaluate(proveJobviteResumeInput,{expectedUrl:boundUrl,expiresAt});
  signal.throwIfAborted();
  await proveBambooResumeInput(page,boundUrl,signal,expiresAt);
  signal.throwIfAborted();
  if (page.url()!==boundUrl) throw new Error('The application page changed before filling.');
  const result = await fillMatchedPage({profile:settings,resume,url:boundUrl,root:learningRoot,workflow:'C3.1',signal,
    call:async(action,matchingPlans,matchingRunId)=>{
      await page.evaluate(`void(globalThis.__huntC3ChoiceWidget=(${inspectChoiceWidget.toString()}))`);
      await page.evaluate(annotateQuestionContext);
      return {...await page.evaluate(fillVisibleFields, {
    action,matchingPlans,matchingRunId,facts: effectiveProfileFacts(settings),
    expectedUrl: boundUrl,
    expiresAt,
    resume: action==='fill'?{name:'Resume.pdf', base64:resume.toString('base64')}:undefined,
    replaceExistingResume: true,
  })};}});
  signal.throwIfAborted();
  if (page.url() !== current.url && genericApplicationTarget(page.url()).key !== expected.key) {
    throw new Error('The application page changed while filling.');
  }
  return result;
}
