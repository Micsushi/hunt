import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { inspectQuestionMatch } from '../form/questions/catalog.ts';
import { normalizeCatalogText } from '../form/questions/normalize.ts';
import { rankQuestionCandidates, sameEmployer } from '../form/questions/matching.ts';
import { equivalentAnswer } from '../deterministic/answer-equivalence.ts';
import { mapVisibleOption } from '../form/options/mapper.ts';
import { writePrivateFileAtomic } from '../composition/private/s2-application-source-preparation.ts';
import type { ApplicationProfileQuery } from '../form/answers/application-types.ts';
import { matchingContext } from './target.ts';
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
  const save = (pageSteps?: FillStep[]) => {
    if (!file || !root) return;
    mkdirSync(root,{recursive:true,mode:0o700});
    writePrivateFileAtomic(file,Buffer.from(JSON.stringify({schemaVersion:1,workflow,...context,
      entries:[...records.values()],pageSteps},null,2)));
  };
  return {
    company: context.company,
    get needsReview(){return needsReview;},
    record(value:MatchingObservation) {
      // Transport bindings include the raw URL and never belong in durable evidence.
      const {signature: _signature, ...observation}=value as MatchingObservation & {signature?:string};
      value=observation;
      // Account credentials never belong in the question-review backlog.
      if (/\b(?:password|passcode|verification code|one time code)\b/iu.test(value.question)) return;
      if (/^https?:\/\//iu.test(value.pageId)) value={...value,pageId:matchingContext(value.pageId).url!};
      const match=inspectQuestionMatch(value.question, context.company ? [context.company] : []);
      const scopeMatched=!match.context?.employer || context.company!==null && sameEmployer(context.company,match.context.employer);
      const applicable=scopeMatched && !match.context?.negated && !(match.context && 'includesAnotherEmployer' in match.context) && !/\b(?:subsidiar|affiliate)\w*/iu.test(value.question);
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
      save();
    },
    finishPageLog(filled: string[], skipped: {label:string;reason:string}[]) {
      if (!file || workflow !== 'C3.2') return;
      try {
        const steps: FillStep[] = filled.slice(0,200).map(label=>({label:fieldLabel(label),outcome:'changed',reason:'field_changed'}));
        for (const row of skipped.slice(0,200)) steps.push(skipStep(row.label,row.reason));
        save(steps);
      } catch { /* Field reporting must never turn a completed fill into a retry. */ }
    },
  };
}

interface FillStep {
  label:string;
  outcome:'changed'|'existing'|'skipped'|'unconfirmed'|'suggested';
  reason:string;
}
const skipReasons = new Set(['password_field_preserved','account_fields_preserved','optional_field','existing_value_preserved',
  'needs_owner_answer','saved_value_conflict','address_country_conflict','postal_code_requires_review','optional_consent_skipped',
  'required_attachment_missing','required_resume_missing','resume_control_not_identified','existing_attachment_preserved',
  'employer_submission_disabled','button_choice_interaction_unsupported','choice_not_unique','field_changed_before_fill']);
const uncertainReasons = new Set(['page_action_not_confirmed','value_not_accepted','value_changed_after_fill','previous_control_write_unconfirmed',
  'required_attachment_unconfirmed','screening_choice_not_confirmed','choice_commit_or_reset_unconfirmed','resume_attachment_not_verified']);
function fieldLabel(value:unknown) {
  if (typeof value !== 'string' || /https?:|www\.|\S+@\S+|[a-z\d_-]{32,}|[?&](?:code|token|key)=/i.test(value)) return 'Form field';
  if (/password|passcode/i.test(value)) return /re.enter|confirm|repeat/i.test(value)?'Password (Re-enter)':'Password';
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim().slice(0,140) || 'Form field';
}
function skipStep(label:unknown,reason:unknown):FillStep {
  if (reason==='saved_value_already_present' || reason==='existing_value_confirmed') {
    return {label:fieldLabel(label),outcome:'existing',reason:'existing_value_confirmed'};
  }
  if (reason==='selected_resume_already_present') return {label:fieldLabel(label),outcome:'existing',reason};
  if (typeof reason==='string' && uncertainReasons.has(reason)) return {label:fieldLabel(label),outcome:'unconfirmed',reason};
  return {label:fieldLabel(label),outcome:'skipped',reason:typeof reason==='string' && skipReasons.has(reason)?reason:'not_filled'};
}
interface LoggedAttempt {outcome?:string;reason?:string;provisional?:boolean}
function matchingStep(question:unknown, attempts:LoggedAttempt[]):FillStep {
  const label=fieldLabel(question), last=attempts.at(-1);
  if (last?.outcome==='verified') {
    const write = [...attempts].reverse().find(a=>a.outcome==='verified' && a.reason==='product_readback_confirmed');
    if (write) return write.provisional?{label,outcome:'suggested',reason:'suggested_answer'}:{label,outcome:'changed',reason:'product_readback_confirmed'};
    if (last.reason==='existing_value_confirmed') return {label,outcome:'existing',reason:last.reason};
  }
  if (last?.outcome==='unconfirmed' && last.reason && skipReasons.has(last.reason)) return skipStep(label,last.reason);
  return {label,outcome:'unconfirmed',reason:last?.reason && uncertainReasons.has(last.reason)?last.reason:'outcome_unconfirmed'};
}

/** Return only field labels and fixed result codes. The underlying private journal contains answers. */
export function readPageFillLog(pageRoot:string) {
  const runs:{at:string;steps:FillStep[]}[]=[];
  if (!existsSync(pageRoot)) return {runs};
  const files=readdirSync(pageRoot,{withFileTypes:true}).flatMap(entry=>{
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) return [];
    const path=join(pageRoot,entry.name,'matching-backlog.json');
    const stat=lstatSync(path,{throwIfNoEntry:false});
    return stat?.isFile()?[{path,at:stat.mtime}]:[];
  }).sort((a,b)=>b.at.getTime()-a.at.getTime());
  for (const file of files) {
    try {
      const data=JSON.parse(readFileSync(file.path,'utf8'));
      if (data.schemaVersion!==1 || data.workflow!=='C3.2' || !Array.isArray(data.entries)) continue;
      const steps:FillStep[]=data.entries.slice(0,200).map((r:{question:unknown;attempts?:LoggedAttempt[]})=>
        matchingStep(r.question,Array.isArray(r.attempts)?r.attempts:[]));
      if (Array.isArray(data.pageSteps)) for (const row of data.pageSteps.slice(0,400)) {
        const label=fieldLabel(row.label);
        const step:FillStep = row.outcome==='changed'?{label,outcome:'changed',reason:'field_changed'}:skipStep(label,row.reason);
        if (step.reason==='value_changed_after_fill') {
          const writes=steps.filter(s=>s.label===label && (s.outcome==='changed'||s.outcome==='suggested'));
          if (writes.length===1) steps.splice(steps.indexOf(writes[0]!),1);
        }
        if (steps.some(s=>s.label===label && (s.reason===step.reason ||
          step.reason==='field_changed' && ['changed','suggested','unconfirmed'].includes(s.outcome) ||
          step.outcome==='existing' && ['changed','suggested'].includes(s.outcome)))) continue;
        steps.push(step);
      }
      runs.push({at:file.at.toISOString(),steps});
      if (runs.length===4) break;
    } catch { /* A single unreadable historical run must not hide the rest of the page's history. */ }
  }
  return {runs};
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
