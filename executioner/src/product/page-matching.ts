import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { boundedText, browserTargetToken, fieldId, optionId, disposeResumeArtifact } from '../contracts/index.ts';
import { createApplicationAnswerResolver, provisionalUnboundedFieldAnswer } from '../form/answers/resolver.ts';
import type { ApplicationFieldObservation } from '../form/answers/application-types.ts';
import { createMatchingBacklog, matchingContext, intentAnswer, type MatchingObservation } from './matching-backlog.ts';
import { productSources, effectiveProfileFacts } from './sources.ts';
import { profileFieldValue } from './profile-field.ts';
import { inspectQuestionMatch } from '../form/questions/catalog.ts';
import { equivalentAnswer, phoneCountryName } from '../deterministic/answer-equivalence.ts';
import { normalizeCatalogText } from '../form/questions/normalize.ts';

export interface PageQuestion extends MatchingObservation {
  signature:string; selected: string | boolean; valid: boolean; frameId?: string;
}
export interface PageAnswerPlan {
  fieldId:string; frameId?:string; signature:string; answer:string|boolean|null; query?:string; provisional:boolean; reason:string;
}
export interface MatchedPageResult {
  filled:string[]; skipped:{label:string;reason:string;fieldId?:string;frameId?:string}[]; matching?:PageQuestion[];
  resume?:'verified'|'missing'|'unverified'|'optional'; canUndo:boolean; canRedo:boolean; [key:string]:unknown;
}

/** Service-side authority; browser code only observes, commits and independently reads controls. */
export async function fillMatchedPage(input:{profile:unknown;resume:Buffer;url:string;root?:string;workflow:'C3.1'|'C3.2';
  signal:AbortSignal; call:(action:'status'|'fill',plans:PageAnswerPlan[]|undefined,runId:string)=>Promise<MatchedPageResult>}) {
  const sources=productSources(input.profile,input.resume);
  const facts=effectiveProfileFacts(input.profile);
  const narrative=facts.find(fact=>fact.factId==='configured_narrative')?.value;
  const resolver=createApplicationAnswerResolver(sources.profileQuery,typeof narrative==='string'?narrative:undefined);
  const runId=randomUUID();
  const root=input.root===undefined?undefined:join(input.root,runId);
  const backlog=createMatchingBacklog(root,input.url,facts,input.workflow,sources.profileQuery.ownerDefaults);
  const seen=new Set<string>(),filled=new Set<string>();
  const skipped=new Map<string,MatchedPageResult['skipped'][number]>();
  let result:MatchedPageResult={filled:[],skipped:[],canUndo:false,canRedo:false};
  try {
    for(let round=0;round<5;round++) {
      input.signal.throwIfAborted();
      const observed=await input.call('status',undefined,runId);
      const plans:PageAnswerPlan[]=[];
      for(const row of observed.matching??[]) {
        const {frameId,signature}=row;
        backlog.record({...row,outcome:'observed'});
        if(seen.has(signature))continue;
        seen.add(signature);
        if (!row.required) {
          plans.push({fieldId:row.fieldId,frameId,signature,answer:null,provisional:false,reason:'optional_field'});
          continue;
        }
        const questionFact=inspectQuestionMatch(row.question).factId;
        let addressCountryConflict=false;
        if (questionFact==='postal_code') {
          const savedCountry=facts.find(fact=>fact.factId==='country')?.value;
          const countries=(observed.matching??[]).filter(other=>other.frameId===row.frameId &&
            inspectQuestionMatch(other.question).factId==='country' && typeof other.selected==='string' && other.selected.trim());
          if (typeof savedCountry==='string' && countries.length===1 &&
              normalizeCatalogText(String(countries[0]!.selected))!==normalizeCatalogText(savedCountry)) {
            addressCountryConflict=true;
          }
        }
        // Keep the complete wording in the backlog; truncation could remove a
        // qualification and silently turn this into a different question.
        if ([row.question,...row.options].some(text=>[...text].length>512)) {
          const reason='question_or_option_exceeds_readback_limit';
          const fallback=provisionalUnboundedFieldAnswer({required:row.required,behavior:row.control,question:row.question,options:row.options,constraints:row.constraints as ApplicationFieldObservation['constraints']});
          const answer=fallback?.answer??null;
          plans.push({fieldId:row.fieldId,frameId,signature,answer,provisional:true,reason});
          backlog.record({...row,chosenAnswer:answer,provisional:true,outcome:answer===null?'unconfirmed':'attempted',reason});
          continue;
        }
        const field:ApplicationFieldObservation={fieldId:fieldId(row.fieldId),target:browserTargetToken(row.fieldId),
          label:boundedText(row.question),behavior:row.control as ApplicationFieldObservation['behavior'],required:row.required,
          options:row.options.map((label,index)=>({id:optionId(String(index)),label:boundedText(label)})),
          constraints:row.constraints as ApplicationFieldObservation['constraints'],queryable:row.queryable,searchQuery:row.searchQuery,state:'empty'};
        const resolution=await resolver.resolve({field,mode:sources.profilePlan.mode,
          answerFallbackPolicy:sources.executionPolicy.answerFallbackPolicy,profileId:sources.profileId,profileRevision:sources.profileRevision,
          resume:{resumeId:sources.resumeIntent.artifact.resumeId,sha256:sources.resumeIntent.artifact.sha256},resumeArtifact:sources.resumeIntent.artifact,
          employerNames:[matchingContext(input.url).company??'']},input.signal);
        const resolved=resolution.ok&&resolution.value.kind==='resolved'?resolution.value:undefined;
        const direct=['text','textarea'].includes(row.control)?profileFieldValue(row.question,facts):undefined;
        let provisional=addressCountryConflict || direct===undefined && (!resolved || resolved.lane==='synthetic_test_default');
        let answer=direct??(resolved?intentAnswer(resolved.intent):null);
        let reason=addressCountryConflict?'address_country_conflict':resolved?'answer_resolved':resolution.ok?resolution.value.kind:resolution.error.code;
        if(sources.executionPolicy.answerFallbackPolicy==='deterministic_site_valid_editable' &&
            questionFact==='phone_country_code' && !facts.some(fact=>fact.factId==='phone_country_code')) {
          const country=facts.find(fact=>fact.factId==='country')?.value;
          const options=typeof country==='string'?row.options.filter(option=>phoneCountryName(option)===normalizeCatalogText(country)):[];
          if(options.length===1){answer=options[0]!;provisional=true;reason='phone_country_inferred_from_residence';}
        }
        // Preserve the employer's equivalent spelling, without treating a typed choice as committed.
        if(row.valid && ['text','textarea'].includes(row.control) && typeof row.selected==='string' && row.selected.trim() &&
            typeof answer==='string' && questionFact && equivalentAnswer(row.selected,answer,questionFact)) answer=row.selected;
        const query=resolved?.intent.kind==='choice' && resolved.intent.optionId==='deferred-search' ? String(resolved.intent.expectedOption) : undefined;
        if(query!==undefined){answer=null;reason='choice_options_query';}
        const plan={fieldId:row.fieldId,frameId,signature,answer,...(query===undefined?{}:{query}),provisional,reason};
        plans.push(plan);
        backlog.record({...row,chosenAnswer:plan.answer,...(query===undefined?{}:{requestedQuery:query}),provisional,outcome:plan.answer===null&&query===undefined?'unconfirmed':'attempted',reason});
      }
      if(!plans.length && round>0){result={...result,canUndo:observed.canUndo,canRedo:observed.canRedo,incomplete:result.incomplete===true || observed.incomplete===true};break;}
      try {result=await input.call('fill',plans,runId);}
      catch(error) {
        for(const row of observed.matching??[]) {
          const plan=plans.find(plan=>plan.fieldId===row.fieldId && plan.frameId===row.frameId);
          if(plan && (plan.answer!=null || plan.query!==undefined))backlog.record({...row,chosenAnswer:plan.answer,requestedQuery:plan.query,provisional:true,outcome:'unconfirmed',reason:'page_action_not_confirmed'});
        }
        throw error;
      }
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
    return {...result,filled:[...filled],skipped:[...skipped.values()],needsOwnerReview:backlog.needsReview || result.incomplete===true};
  } finally {disposeResumeArtifact(sources.resumeIntent.artifact);}
}

export function pageMatchingRoot(root:string,url:string) {
  return join(root,'learning',`page-${createHash('sha256').update(url).digest('hex').slice(0,24)}`);
}
