import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { disposeResumeArtifact } from '../contracts/index.ts';
import { createMatchingBacklog } from './matching-backlog.ts';
import { productSources, effectiveProfileFacts } from './sources.ts';
import { createPageAnswerPlanner, type PageAnswerPlan, type PageQuestion } from './page-answer-planner.ts';
import { type ComponentFailure } from './component-diagnostics.ts';
export type { PageAnswerPlan, PageQuestion } from './page-answer-planner.ts';

export interface FrameReport { frameId: string; status: string; error?: string }
export interface MatchedPageResult {
  frames?: FrameReport[];
  filled:string[]; skipped:{label:string;reason:string;fieldId?:string;frameId?:string;componentFailure?:ComponentFailure}[]; componentFailure?:ComponentFailure; matching?:PageQuestion[];
  resume?:'verified'|'missing'|'unverified'|'optional'; canUndo:boolean; canRedo:boolean; [key:string]:unknown;
}

/** Service-side authority; browser code only observes, commits and independently reads controls. */
export async function fillMatchedPage(input:{profile:unknown;resume:Buffer;url:string;root?:string;workflow:'C3.1'|'C3.2';
  signal:AbortSignal; call:(action:'status'|'fill',plans:PageAnswerPlan[]|undefined,runId:string)=>Promise<MatchedPageResult>}) {
  const sources=productSources(input.profile,input.resume);
  const facts=effectiveProfileFacts(input.profile);
  const runId=randomUUID();
  const root=input.root===undefined?undefined:join(input.root,runId);
  const backlog=createMatchingBacklog(root,input.url,facts,input.workflow,sources.profileQuery.ownerDefaults);
  const seen=new Set<string>(),filled=new Set<string>();
  const skipped=new Map<string,MatchedPageResult['skipped'][number]>();
  const unavailableFrames = new Map<string, FrameReport>();
  function observeFrames(report: MatchedPageResult) {
    for (const frame of report.frames ?? []) {
      if (frame.status === 'unavailable') unavailableFrames.set(frame.frameId, frame);
      else if (['complete', 'partial', 'ignored_empty_frame', 'ignored_security_widget'].includes(frame.status)) {
        unavailableFrames.delete(frame.frameId);
      }
    }
  }
  let result:MatchedPageResult={filled:[],skipped:[],canUndo:false,canRedo:false};
  try {
    const planAnswer = createPageAnswerPlanner(sources, facts, backlog.company);
    for(let round=0;round<5;round++) {
      input.signal.throwIfAborted();
      const observed=await input.call('status',undefined,runId);
      observeFrames(observed);
      const plans:PageAnswerPlan[]=[];
      for(const row of observed.matching??[]) {
        backlog.record({...row, outcome: 'observed'});
        const key = JSON.stringify([row.frameId, row.fieldId, row.signature]);
        if (seen.has(key)) continue;
        seen.add(key);
        const plan = await planAnswer(row, observed.matching ?? [], input.signal);
        plans.push(plan);
        if (row.required) {
          backlog.record({...row, chosenAnswer: plan.answer, requestedQuery: plan.query,
            provisional: plan.provisional, reason: plan.reason,
            outcome: plan.answer === null && plan.query === undefined ? 'unconfirmed' : 'attempted'});
        }
      }
      if (!plans.length && (round > 0 || observed.componentFailure?.component === 'page_state')) {
        for (const row of observed.skipped) skipped.set(JSON.stringify(row), row);
        result = {
          ...result,
          ...(observed.observation !== undefined && {observation: observed.observation}),
          ...(observed.frames !== undefined && {frames: observed.frames}),
          ...(observed.componentFailure && {componentFailure: observed.componentFailure}),
          canUndo: observed.canUndo,
          canRedo: observed.canRedo,
          incomplete: observed.matching?.some(row => row.required && (!row.valid ||
            (typeof row.selected === 'string' && !row.selected.trim()))) === true ||
            result.resume === 'unverified' ||
            observed.incomplete === true || result.incomplete === true &&
            (!result.frames?.some(frame => frame.status === 'unavailable') || !!result.componentFailure),
        };
        break;
      }
      try {result=await input.call('fill',plans,runId);}
      catch(error) {
        for(const row of observed.matching??[]) {
          const plan=plans.find(plan=>plan.fieldId===row.fieldId && plan.frameId===row.frameId);
          if(plan && (plan.answer!=null || plan.query!==undefined))backlog.record({...row,chosenAnswer:plan.answer,requestedQuery:plan.query,provisional:true,outcome:'unconfirmed',reason:'page_action_not_confirmed'});
        }
        throw error;
      }
      observeFrames(result);
      result.filled.forEach(label=>filled.add(label));
      result.skipped.forEach(row=>skipped.set(JSON.stringify(row),row));
      // A changed observation before any write is recoverable after a fresh plan.
      // Never clear a different field/frame or a post-write failure.
      for(const row of result.matching??[]) if(row.outcome==='verified' &&
          result.matching?.filter(other=>other.fieldId===row.fieldId && other.frameId===row.frameId).length===1) {
        for(const [key,skip] of skipped) if(skip.fieldId===row.fieldId && skip.frameId===row.frameId &&
          skip.label===row.question && skip.reason==='field_changed_before_fill') skipped.delete(key);
      }
      for(const row of result.matching??[]) backlog.record({...row,provisional:row.provisional || row.outcome!=='verified'});
      if(round===4)result={...result,incomplete:true};
    }
    if (unavailableFrames.size) {
      // A disappearing child is still unresolved until that exact frame is inspected or excluded.
      const frames = (result.frames ?? []).filter(frame => !unavailableFrames.has(frame.frameId));
      result = {...result, incomplete: true, frames: [...frames, ...unavailableFrames.values()]};
    }
    const remaining = [...skipped.values()];
    const firstFailure = remaining.find(skip => skip.componentFailure)?.componentFailure;
    const {componentFailure: lastFailure, ...report} = result;
    const failure = lastFailure?.component === 'page_state' ? lastFailure :
      firstFailure ?? (result.skipped.some(skip => skip.componentFailure) ? undefined : lastFailure);
    return {...report, filled: [...filled], skipped: remaining, ...(failure ? {componentFailure: failure} : {}),
      needsOwnerReview: backlog.needsReview || result.incomplete === true};
  } finally {disposeResumeArtifact(sources.resumeIntent.artifact);}
}

export function pageMatchingRoot(root:string,url:string) {
  return join(root,'learning',`page-${createHash('sha256').update(url).digest('hex').slice(0,24)}`);
}
