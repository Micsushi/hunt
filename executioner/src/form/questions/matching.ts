import { normalizeCatalogText, normalizedQuestionKeywords } from './normalize.ts';

export interface EmploymentQuestion {
  family: 'employment_relationship';
  period: 'current' | 'past' | 'ever';
  employer: string | null;
  negated: boolean;
  qualified: boolean;
  includesAnotherEmployer?: true;
}

/** Capture the company instead of adding one alias per employer. Keep qualifiers. */
export function employmentQuestion(text: string): EmploymentQuestion | undefined {
  const original = normalizeCatalogText(text).replace(/^\d+\s+/u,'');
  const value = original.replace(/\bworked as (?:a|an) (?:contractor|intern) (for|at)\b/u,'worked $1');
  if (/\b(?:relative|relatives|family|friend|referral|referred|contact|applied|application|eligible|authorized|authorised|sponsorship)\b/u.test(value)) return;
  const past = /\b(?:former|formerly|previous|previously|past|before|ever)\b/u.test(value);
  const current = /\b(?:current|currently|presently|existing|at present)\b/u.test(value) ||
    !past && /^are you\b.*\b(?:employee|associate|contractor|intern|employed)\b/u.test(value);
  if (!current && !past && !/^have you (?:worked|been employed)/u.test(value)) return;
  if (!/\b(?:employee|associate|contractor|intern|employed|worked|working|work)\b/u.test(value)) return;
  if (!/^(?:(?:are|were) you\b.*\b(?:employee|associate|contractor|intern|employed)\b|(?:have|did|do|are) you\b.*\b(?:worked|work|working|employed)\s+(?:for|at|by|here)\b)/u.test(value)) return;
  if (/\b(?:a staffing agency|an employment agency|armed forces customers)\b/u.test(value)) return;
  const match = /\b(?:employee|associate|contractor|intern|employed|worked|working|work)\s+(?:of|by|for|at|with)\s+(.+?)(?=\s+(?:if|including|excluding|this does|please|as a|as an|either|in any|within|during|over the|in the last|for any length of time)\b|$)/u.exec(value);
  const embedded = /\b(?:current or former|former or current|current|former)\s+(.+?)\s+(?:employee|associate|contractor|intern)\b/u.exec(value)?.[1];
  const groupEmployer = /^have you been previously employed by (.+?) or one of its subsidiaries$/u.exec(value)?.[1] ??
    /^are you currently employed by (.+?) or have you previously been employed by \1 or [\p{L}\p{N}]+$/u.exec(value)?.[1];
  const name = groupEmployer ?? match?.[1] ?? (embedded && !/^(?:or former|or current)$/u.test(embedded) ? embedded : undefined);
  const employer = !name || /^(?:us|here|our company|the company|this company|this organization|our organization|the organization)$/u.test(name) ? null : name;
  return {family:'employment_relationship',period:current && past || /\bever\b/u.test(value) ||
    !past && /^have you (?:worked|been employed)/u.test(value) ? 'ever' : current ? 'current' : 'past',
    employer,...(groupEmployer && employer ? {includesAnotherEmployer:true as const} : {}),
    negated:/\b(?:not|never|no longer)\b/u.test(value.split(/\b(?:if|including|excluding|this does|please)\b/u)[0]??''),
    qualified:!!groupEmployer || /\b(?:contract|contractor|contingent|intern|internship|subsidiar|affiliate|excluding|except|within|years|months|directly)\w*\b/u.test(original)};
}

export function applicantRefersSomeone(text: string): boolean {
  return /\b(?:did|have|do) you (?:ever |previously |personally |already |not |never )*(?:refer(?:red)?|recommend(?:ed)?)\b/u.test(normalizeCatalogText(text));
}

export function referralQuestion(text:string) {
  const value=normalizeCatalogText(text);
  if (applicantRefersSomeone(value) ||
      !/\b(?:refer|referred|referral|recommend|recommended)\b/u.test(value) ||
      !/\b(?:employees?|associates?|staff|referrals?)\b/u.test(value) ||
      /\b(?:name|email|number|who|which|describe|hear about|application source)\b/u.test(value)) return;
  const following = /\b(?:employees?|associates?|staff members?) (?:of|at|from) (.+?)(?=\s+(?:if|including|excluding|please|this does|refer(?:red)? you|recommend(?:ed)? you)\b|$)/u.exec(value)?.[1];
  const preceding = /\b(?:by|did|has) (.*?)\b(?:employees?|associates?|staff members?)\b/u.exec(value)?.[1];
  const alternative = preceding?.replace(/^.*?\b(?:friend|relative) or\b\s*/u, '');
  const employerPrefix = alternative && !/\b(?:friend|relative|or)\b/u.test(alternative) ? alternative : undefined;
  const name = following ?? employerPrefix?.trim().replace(/^(?:any of our|one of our|any|a|an|the|our)(?: |$)/u, '').replace(/^current(?: |$)/u, '').trim();
  return {family:'employee_referral',period:null,employer:!name || /^(?:our|this company|the company)$/u.test(name)?null:name,
    negated:/\b(?:not|never|without)\b/u.test(value),qualified:false};
}

export function sameEmployer(left: string, right: string): boolean {
  const key = (value: string) => normalizeCatalogText(value).replace(/\b(?:inc|incorporated|ltd|limited|llc|corp|corporation)\b/gu,'').replace(/\s+/gu,'');
  return key(left) !== '' && key(left) === key(right);
}

export interface MatchCandidate { id: string; score: number; label: string }

/** Local phrase ranking, not a probability or authority to use a profile fact. */
export function rankQuestionCandidates(entries: readonly {id:string;labels:readonly string[]}[], text: string): MatchCandidate[] {
  const aliases: Record<string,string> = {occupation:'job',position:'job',surname:'family',mobile:'phone',cell:'phone',discipline:'major',programme:'program',university:'school',institution:'school'};
  const tokens = (value: string) => new Set([...normalizedQuestionKeywords(value)].map(word=>aliases[word]??word));
  const target = tokens(text);
  const grams = (value:string) => { const s=normalizeCatalogText(value);return new Set(Array.from({length:Math.max(0,s.length-2)},(_,i)=>s.slice(i,i+3))); };
  const targetGrams = grams(text);
  const overlap = (a:ReadonlySet<string>,b:ReadonlySet<string>) => [...a].filter(x=>b.has(x)).length;
  const best = new Map<string,MatchCandidate>();
  for (const entry of entries) for (const label of entry.labels) {
    const other=tokens(label), otherGrams=grams(label);
    const tokenScore=2*overlap(target,other)/Math.max(1,target.size+other.size);
    const charScore=2*overlap(targetGrams,otherGrams)/Math.max(1,targetGrams.size+otherGrams.size);
    const score=Math.round((.8*tokenScore+.2*charScore)*1000)/1000;
    if (score>=.25 && score>(best.get(entry.id)?.score??0)) best.set(entry.id,{id:entry.id,score,label});
  }
  return [...best.values()].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,3);
}
