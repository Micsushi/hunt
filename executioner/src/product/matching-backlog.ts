import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectQuestionMatch } from '../form/questions/catalog.ts';
import { normalizeCatalogText } from '../form/questions/normalize.ts';
import { rankQuestionCandidates, sameEmployer } from '../form/questions/matching.ts';
import { equivalentAnswer } from '../deterministic/answer-equivalence.ts';
import { mapVisibleOption } from '../form/options/mapper.ts';
import { writePrivateFileAtomic } from '../composition/private/s2-application-source-preparation.ts';
import type { ApplicationProfileQuery } from '../form/answers/application-types.ts';
import { boundedText, optionId, type FieldIntent } from '../contracts/index.ts';

export interface MatchingObservation {
  pageId: string; fieldId: string; question: string; control: string;
  options: readonly string[]; required: boolean; constraints?: unknown;
  chosenAnswer?: string | boolean | null;
  queryable?: boolean; searchQuery?: string; requestedQuery?: string;
  provisional?: boolean;
  observedAnswer?: unknown;
  outcome?: 'observed' | 'attempted' | 'verified' | 'driver_failed' | 'verification_failed' | 'unconfirmed';
  reason?: string;
}
export function intentAnswer(intent: FieldIntent): string | boolean | null {
  return intent.kind==='choice'?intent.expectedOption:intent.kind==='text'?intent.value:
    intent.kind==='toggle'?intent.checked:intent.kind==='date'?intent.isoDate:null;
}
export function matchingContext(url?:string) {
  if (!url) return {url:null,company:null};
  const parsed=new URL(url);
  if (!['http:','https:'].includes(parsed.protocol)) throw new Error('Invalid application address');
  parsed.username='';parsed.password='';parsed.hash='';
  for (const key of [...parsed.searchParams.keys()]) if (!/^(?:jobid|job_id|requisitionid|requisition_id|gh_jid)$/iu.test(key)) parsed.searchParams.delete(key);
  const company=/\.(?:myworkdayjobs|myworkdaysite)\.com$/iu.test(parsed.hostname)
    ? parsed.hostname.split('.')[0]! : parsed.pathname.split('/').filter(Boolean)[0]??parsed.hostname;
  return {url:parsed.href,company};
}

/** Private observations only. No method can promote a candidate into the matching dictionary. */
export function createMatchingBacklog(root:string|undefined, url?:string, facts:readonly {factId:string;value:unknown}[] = [], workflow:'C3.1'|'C3.2'='C3.1', ownerDefaults?:ApplicationProfileQuery['ownerDefaults']) {
  const context=matchingContext(url);
  const file=root===undefined?undefined:join(root,'matching-backlog.json');
  const records=new Map<string,MatchingObservation & {id:string;match:ReturnType<typeof inspectQuestionMatch>;firstSeen:string;lastSeen:string;attempts:unknown[]}>();
  if (file && existsSync(file)) {
    const saved=JSON.parse(readFileSync(file,'utf8'));
    if (saved.schemaVersion!==1 || saved.url!==context.url || !Array.isArray(saved.entries)) throw new Error('Matching backlog context changed');
    for (const row of saved.entries) records.set(row.id,row);
  }
  let needsReview=[...records.values()].some(row=>row.provisional);
  return {
    get needsReview(){return needsReview;},
    record(value:MatchingObservation) {
      // Transport bindings include the raw URL and never belong in durable evidence.
      const {signature: _signature, ...observation}=value as MatchingObservation & {signature?:string};
      value=observation;
      // Account credentials never belong in the question-review backlog.
      if (/\b(?:password|passcode|verification code|one time code)\b/iu.test(value.question)) return;
      if (/^https?:\/\//iu.test(value.pageId)) value={...value,pageId:matchingContext(value.pageId).url!};
      const match=inspectQuestionMatch(value.question);
      const scopeMatched=!match.context?.employer || context.company!==null && sameEmployer(context.company,match.context.employer);
      const applicable=scopeMatched && !match.context?.negated && !/\b(?:subsidiar|affiliate)\w*/iu.test(value.question);
      const factId=match.factId??(match.context?.family==='employment_relationship'?
        match.context.period==='current'?'current_associate':'previously_worked_for_organization':null);
      let fact=applicable?facts.find(fact=>fact.factId===factId):undefined;
      if(applicable && match.context?.period==='ever') {
        const current=facts.find(fact=>fact.factId==='current_associate');
        if(current?.value===true) fact=current;
        else if(fact?.value===false && current?.value!==false) fact=undefined;
      }
      const qualifiedPositive=match.context?.qualified===true && fact?.value===true;
      if(qualifiedPositive) fact=undefined;
      if(applicable && ownerDefaults && !qualifiedPositive && !fact && (match.context || match.factId==='associate_referral')) fact={factId:match.factId??'employment_relationship',value:false};
      const requestedAnswer=fact && ['string','boolean','number'].includes(typeof fact.value)?String(fact.value):null;
      const answerCandidates=requestedAnswer===null?[]:value.options.map((label,index)=>({id:String(index),labels:[label]}));
      const requestedAlternatives=applicable && match.factId==='application_source' && ownerDefaults?.applicationSources &&
        (requestedAnswer===null || ownerDefaults.applicationSources.some(source=>normalizeCatalogText(source)===normalizeCatalogText(requestedAnswer)))
        ? ownerDefaults.applicationSources : [];
      let answerMatch=requestedAnswer===null || !value.options.length ? null : value.options.some(label=>[...label].length>512)
        ? {kind:'option_no_match' as const} : mapVisibleOption(
        fact!.value as string|number|boolean,
        value.options.map((label,index)=>({id:optionId(String(index)),label:boundedText(label)})),match.factId??'');
      if (answerMatch?.kind!=='matched' && value.options.length && value.options.every(label=>[...label].length<=512)) {
        for (const alternative of requestedAlternatives) {
          const mapped=mapVisibleOption(alternative,value.options.map((label,index)=>({id:optionId(String(index)),label:boundedText(label)})),match.factId??'');
          if(mapped.kind==='matched'){answerMatch=mapped;break;}
        }
      }
      const provisional=value.provisional===true || ['unconfirmed','driver_failed','verification_failed'].includes(value.outcome??'') || match.provisional || !scopeMatched ||
        answerMatch!==null && answerMatch.kind!=='matched';
      if (provisional) needsReview=true;
      if (!file) return;
      const id=createHash('sha256').update(JSON.stringify([context.url,value.pageId,value.fieldId,value.question])).digest('hex');
      const previous=records.get(id),now=new Date().toISOString();
      const row={...previous,...value,options:[...value.options],id,match,scopeMatched,requestedAnswer,requestedAlternatives,answerMatch,
        outcome:value.outcome==='observed'&&previous?.outcome ? previous.outcome : value.outcome,
        answerCandidates:requestedAnswer===null?[]:rankQuestionCandidates(answerCandidates,requestedAnswer),
        equivalentOptions:requestedAnswer===null?[]:value.options.filter(option=>equivalentAnswer(option,requestedAnswer,match.factId??'')),
        provisional:provisional || previous?.provisional===true,
        firstSeen:previous?.firstSeen??now,lastSeen:now,attempts:previous?.attempts??[]};
      // Preserve attempts separately from subsequent observations and confirmed results.
      if (value.outcome && value.outcome!=='observed') row.attempts=[...row.attempts,{at:now,
        outcome:value.outcome,chosenAnswer:value.chosenAnswer??null,requestedQuery:value.requestedQuery??null,observedAnswer:value.observedAnswer??null,options:[...value.options],constraints:value.constraints??null,control:value.control,provisional,reason:value.reason??null}];
      records.set(id,row);
      mkdirSync(root!,{recursive:true,mode:0o700});
      writePrivateFileAtomic(file,Buffer.from(JSON.stringify({schemaVersion:1,workflow,...context,
        entries:[...records.values()]},null,2)));
    },
  };
}

/** Read one page of private run journals; query data never becomes a filesystem path. */
export function readMatchingBacklog(root:string, offset=0, limit=50) {
  const base=join(root,'learning');
  const directories=(path:string)=>existsSync(path)?readdirSync(path,{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.isSymbolicLink()).map(x=>x.name).sort():[];
  const files=directories(base).flatMap(job=>directories(join(base,job)).flatMap(run=>
    ['',...directories(join(base,job,run))].map(part=>({job,run,file:join(base,job,run,part,'matching-backlog.json')})))).filter(x=>existsSync(x.file));
  const selected=files.slice(offset,offset+limit);
  return {runs:selected.map(({job,run,file})=>({job,run,...JSON.parse(readFileSync(file,'utf8'))})),
    nextOffset:offset+selected.length<files.length?offset+selected.length:null,totalRuns:files.length};
}
