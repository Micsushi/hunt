import { createHash } from 'node:crypto';
import type { currentPageInterruption } from '../../../extension/form-page.js';
import { observePageSource, checkPageSource, oneClickPersonalReadySource } from '../../../extension/page-runtime/serialize.js';
import { inspectChoiceWidget } from '../../../extension/shared-choice-widget.js';
import type { Page, Frame, FileChooser, JSHandle } from 'playwright';
import { parseApplicationProfile } from '../../../src/profile/application-profile.ts';
import { fillVisibleFields } from '../../../extension/generic-fill.js';
import { bambooResumeControl } from '../../../extension/page-adapters/bamboo-resume.js';
import { annotateQuestionContext } from '../../../extension/question-context.js';
import { proveJobviteResumeInput } from '../../../extension/jobvite-resume.js';
import { genericApplicationTarget } from '../../../src/product/target.ts';
import { fillMatchedPage } from '../../../src/product/page-matching.ts';
import { openBambooApplication } from './bamboo-application-entry.ts';
import { effectiveProfileFacts } from '../../../src/product/sources.ts';
import { ApplicationPause, type SelectedResumeFill } from '../../../src/product/application-contract.ts';
import { pause } from '../../../src/product/application-wait.ts';
import { smartRecruitersPublication } from '../../../src/product/smartrecruiters-target.ts';

import { recordComponentFailure } from '../../../src/product/component-diagnostics.ts';

function chooserPause(message: string, operation: string): ApplicationPause {
  const pause = new ApplicationPause(message);
  recordComponentFailure(pause, 'uploads', operation);
  return pause;
}

interface ChooserProbes {
  blocked(): ReturnType<typeof currentPageInterruption>;
  personalReady(): boolean;
  bamboo: typeof bambooResumeControl;
  jobvite: typeof proveJobviteResumeInput;
}

// Keep the helpers private to this document. A navigation invalidates the handle.
function chooserProbes(page: Page): Promise<JSHandle<ChooserProbes>> {
  return page.evaluateHandle<ChooserProbes>(`({
    blocked: () => (${checkPageSource})((${observePageSource})()),
    personalReady: ${oneClickPersonalReadySource},
    bamboo: (${bambooResumeControl.toString()}),
    jobvite: (${proveJobviteResumeInput.toString()})
  })`);
}

/** Observe a native chooser without selecting a file; the shared filler owns bytes and history. */
export async function proveBambooResumeInput(page:Page, expectedUrl:string, signal:AbortSignal, expiresAt:number) {
  const probes = await chooserProbes(page);
  try {
    return await proveBambooInDocument(page, expectedUrl, signal, expiresAt, probes);
  } finally {
    await probes.dispose();
  }
}

async function proveBambooInDocument(page:Page, expectedUrl:string, signal:AbortSignal, expiresAt:number, probes:JSHandle<ChooserProbes>) {
  const check=()=>{signal.throwIfAborted();if (Date.now()>=expiresAt || page.url()!==expectedUrl) throw new Error('The application changed or this upload expired. Inspect it again.');};
  check();
  const found = await probes.evaluateHandle(driver => driver.bamboo());
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
    const blocked = await found.evaluate((previous, {driver, expectedUrl, expiresAt}) => {
      if (location.href !== expectedUrl || Date.now() >= expiresAt) throw new Error('The upload action expired or the application changed.');
      const interruption = driver.blocked();
      if (interruption) return interruption;
      const current = driver.bamboo();
      if (!current || !previous || current.input !== previous.input || current.button !== previous.button ||
          current.form !== previous.form || current.group !== previous.group) throw new Error('The upload field changed.');
      current.button.click();
    }, {driver:probes, expectedUrl, expiresAt});
    if (blocked) return blocked;
    const chooser = await event;
    check();
    if (!chooser || observed.length!==1) throw chooserPause('Choose File did not identify one upload field. No resume was sent.', 'observe_file_chooser');
    const chosen=chooser.element();handles.push(chosen);
    if (!await input.evaluate((element,chosen)=>element===chosen && element.isConnected,chosen)) {
      throw chooserPause('Choose File opened a different upload field. No resume was sent.', 'bind_file_chooser');
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

// Inspect before annotating fields. The bundled filler checks again at the actual fill.
function prepareGenericDocument(page: Page | Frame) {
  return page.evaluate<ReturnType<typeof currentPageInterruption>>(`(() => {
    const blocked = (${checkPageSource})((${observePageSource})());
    if (blocked) return blocked;
    globalThis.__huntC3ChoiceWidget = (${inspectChoiceWidget.toString()});
    (${annotateQuestionContext.toString()})();
  })()`);
}

/** Same partial filler as the extension. Never advances or submits an application. */
export async function fillGenericIdentityFields(page: Page | Frame, profile: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an HTTPS application page.');
  const admitted = parseApplicationProfile(profile);
  const interruption = await prepareGenericDocument(page);
  if (interruption) return interruption;
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
  selectedResumeFill?: SelectedResumeFill,
) {
  signal.throwIfAborted();
  const expected = genericApplicationTarget(expectedUrl);
  const current = genericApplicationTarget(page.url());
  if (current.key !== expected.key) throw new Error('Open the application form for this exact posting before filling.');
  const boundUrl=page.url();
  await openBambooApplication(page, boundUrl, signal);
  const probes = await chooserProbes(page);
  let expiresAt:number;
  try {
    if (smartRecruitersPublication(new URL(boundUrl))?.screening === false) {
      const deadline = Date.now()+10_000;
      for (;;) {
        signal.throwIfAborted();
        if (page.url() !== boundUrl) throw new ApplicationPause('The employer page changed before its application form was ready.');
        const state = await probes.evaluate(driver => driver.blocked() ?? driver.personalReady());
        if (state === true) break;
        if (state && state.observation.kind !== 'loading') return {...state, needsOwnerReview:true, resume:undefined};
        // The employer can omit the upload. Inspect each field through the normal ownership checks.
        if (Date.now() >= deadline) break;
        await pause(signal);
      }
    }
    expiresAt=Date.now()+15_000;
    const interruption = await probes.evaluate(async (driver, request) => {
      const blocked = driver.blocked();
      if (blocked) return blocked;
      await driver.jobvite(request);
    }, {expectedUrl:boundUrl, expiresAt});
    if (interruption) return {...interruption, needsOwnerReview:true, resume:undefined};
    signal.throwIfAborted();
    const bambooInterruption = await proveBambooInDocument(page, boundUrl, signal, expiresAt, probes);
    if (bambooInterruption) return {...bambooInterruption, needsOwnerReview:true, resume:undefined};
  } finally {
    await probes.dispose();
  }
  signal.throwIfAborted();
  if (page.url()!==boundUrl) throw new Error('The application page changed before filling.');
  const reconcile = selectedResumeFill && smartRecruitersPublication(new URL(boundUrl))?.screening === false &&
    !await page.evaluate(url=>(globalThis as any).__huntC3PartialFill?.resumeAttempt?.url===url,boundUrl);
  const sha256 = reconcile ? createHash('sha256').update(resume).digest('hex') : '';
  let isolated = false;
  const result = await fillMatchedPage({profile:settings,resume,url:boundUrl,root:learningRoot,workflow:'C3.1',signal,
    call:async(action,matchingPlans,matchingRunId)=>{
      const interruption = await prepareGenericDocument(page);
      if (interruption) return interruption;
      const request = {
        action, matchingPlans, matchingRunId, queuedScreening: true,
        facts: effectiveProfileFacts(settings),
        expectedUrl: boundUrl,
        expiresAt,
        resume: action === 'fill' ? {name: 'Resume.pdf', base64: resume.toString('base64')} : undefined,
        replaceExistingResume: true,
      };
      if (reconcile) {
        const report = await selectedResumeFill(request,sha256);
        if (report==='attachment_conflict' || !report && isolated) {
          throw new ApplicationPause('The existing attachment no longer matches C3’s selected upload. To replace it, delete it on the employer page, reload, then choose Prepare this job and Run.');
        }
        if (report) { isolated = true; return report; }
      }
      return {...await page.evaluate(fillVisibleFields,request)};
    }});
  signal.throwIfAborted();
  if (isolated) await page.evaluate(url=>{
    if (location.href!==url) throw new Error('The selected application changed.');
    // The guarded Next action uses its own marker in the main world.
    (globalThis as any).__huntC3PartialFill ??= {undo:[],redo:[],busy:false};
  },boundUrl);
  if (page.url() !== current.url && genericApplicationTarget(page.url()).key !== expected.key) {
    throw new Error('The application page changed while filling.');
  }
  return result;
}
