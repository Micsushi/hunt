import { boundedText, browserTargetToken, fieldId, optionId, MAX_BROWSER_READBACK_CODE_POINTS } from '../contracts/index.ts';
import { createApplicationAnswerResolver } from '../form/answers/resolver.ts';
import type { ApplicationFieldObservation } from '../form/answers/application-types.ts';
import { inspectQuestionMatch, resolveQuestion } from '../form/questions/catalog.ts';
import { contractApprovedPrivacyChoices, isRecruitmentTermsConsent, protectedQuestionCategory } from '../form/questions/protected.ts';
import { normalizeCatalogText } from '../form/questions/normalize.ts';
import { equivalentAnswer, phoneCountryName } from '../deterministic/answer-equivalence.ts';
import { canonicalCanadianRegion } from '../composition/private/s2-derived-profile-country.ts';
import { recordComponentFailure } from './component-diagnostics.ts';
import { profileFieldValue } from './profile-field.ts';
import { intentAnswer, type MatchingObservation } from './matching-backlog.ts';
import type { productSources, effectiveProfileFacts } from './sources.ts';

const handsOnCloudQuestion = normalizeCatalogText('Do you have any hands-on experience with Kubernetes, Docker, or cloud platforms (e.g., AWS, Azure, GCP)?');
const northAmericanLocationQuestion = normalizeCatalogText('This role requires employees to be based in the United States or Canada. Are you currently located in the U.S. or Canada?');
const averageGpaQuestion = normalizeCatalogText('What is your average GPA?');

function provinceResidenceAnswer(question: string, canadianRegion: string | undefined): 'yes' | 'no' | undefined {
  if (!canadianRegion) return;
  const wording = question.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim();
  const list = /^do you (?:currently )?(?:reside|live) in ([\p{L}, ]+)\?$/iu.exec(wording)?.[1];
  if (!list) return;
  const provinces = list.split(/\s*,\s*(?:or\s+)?|\s+or\s+/iu).map(canonicalCanadianRegion);
  if (provinces.some(province => !province || ['Yukon','Northwest Territories','Nunavut'].includes(province))) return;
  return provinces.includes(canadianRegion) ? 'yes' : 'no';
}

export interface PageQuestion extends MatchingObservation {
  state?: ApplicationFieldObservation['state']; widget?: 'international-phone' | 'multi-checkbox' | 'province-menu' | 'native-multiple' | 'rippling-location'; signature:string; selected: string | boolean; valid: boolean; frameId?: string; formId?: string;
}
type PeerQuestion = Pick<PageQuestion, 'question' | 'selected' | 'frameId' | 'formId'>;
export interface PageAnswerPlan {
  fieldId:string; frameId?:string; signature:string; answer:string|boolean|null; query?:string; phoneCountry?:string; phoneDial?:string; provisional:boolean; reason:string; answerKind?:string; lane?:string;
}

export function matchLocationOption(labels: readonly string[], city: string, region: unknown, country: unknown): number {
  const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
  const matches = labels.map((label, index) => ({parts: label.split(',').map(normalize), index})).filter(({parts}) => {
    if (parts.length === 1) return parts[0] === normalize(city);
    if (parts.length !== 3 || parts[0] !== normalize(city) || typeof region !== 'string' || typeof country !== 'string') return false;
    const canadian = ['ca', 'can', 'canada'];
    if (canadian.includes(normalize(country)) && canadian.includes(parts[2]!)) {
      const expectedRegion = canonicalCanadianRegion(region);
      return !!expectedRegion && canonicalCanadianRegion(parts[1]!) === expectedRegion;
    }
    return parts[1] === normalize(region) && parts[2] === normalize(country);
  });
  // Some providers repeat the same city result. Identical full labels
  // still identify the saved city, province and country unambiguously.
  return matches.length === 1 || matches.length > 1 && matches.every(match => match.parts.length === 3 && normalize(labels[match.index]!) === normalize(labels[matches[0]!.index]!)) ? matches[0]!.index : -1;
}

export function createPageAnswerPlanner(
  sources: ReturnType<typeof productSources>,
  facts: ReturnType<typeof effectiveProfileFacts>,
  company: string | null,
  postingEmployer?: string,
) {
  const employerNames = [company, postingEmployer].filter((name): name is string => !!name);
  const narrative = facts.find(fact => fact.factId === 'configured_narrative')?.value;
  const resolver = createApplicationAnswerResolver(sources.profileQuery, typeof narrative === 'string' ? narrative : undefined);
  const ownerFact = (id: string) => facts.find(f=>f.factId===id&&f.provenance==='owner_provided'&&f.lane==='live_owner_fact')?.value;
  const [gpa, scale] = [ownerFact('education_gpa'),ownerFact('education_gpa_scale')];
  const scaledGpa = typeof gpa==='string' && typeof scale==='string' &&
    [gpa,scale].every(value=>/^\d+(?:\.\d+)?$/.test(value)) && Number(scale)>0 && Number(gpa)<=Number(scale)
    ? `${gpa}/${scale}` : undefined;
  const hasCloudExperience = sources.profilePlan.repeatables.some(section => section.section === 'experience' &&
    section.rows.some(row => row.fields.some(field => field.fieldId === 'experience.description' &&
      field.answer.kind === 'answered' && field.answer.lane === 'live_owner_fact' &&
      ['owner_provided','resume_verified'].includes(field.answer.provenance) &&
      /(?:^|[.!?\n])\s*(?:[-•]\s*)?(?:deployed|automated|configured|ran|maintained|migrated|standardized)\b(?:(?!\b(?:without|never|instead of|planned|proposed)\b)[^.!?\n]){0,110}\b(?:kubernetes|docker|aws|azure|gcp)\b/i.test(field.answer.value))));
  const country = normalizeCatalogText(String(ownerFact('country') ?? ''));
  const hasNorthAmericanLocation = ['canada','ca','can','united states','united states of america','us','usa'].includes(country);
  const canadianRegion = ['canada','ca','can'].includes(country)
    ? canonicalCanadianRegion(String(ownerFact('region') ?? '').normalize('NFD').replace(/\p{M}/gu, '')) : undefined;


  async function planAnswer(
    row: PageQuestion, observations: readonly PeerQuestion[], signal: AbortSignal,
  ): Promise<PageAnswerPlan> {
    const binding = {fieldId: row.fieldId, frameId: row.frameId, signature: row.signature};
    if (!row.required) {
      return {...binding, answer: null, provisional: false, reason: 'optional_field'};
    }
    const constraints = row.constraints as ApplicationFieldObservation['constraints'];
    const populated = row.selected === true || typeof row.selected === 'string' && !!row.selected.trim();
    const state = row.state ?? (populated ? 'populated' : 'empty');
    if (constraints?.readOnly || row.state === 'hidden' || row.state === 'ambiguous') {
      const readback = constraints?.readOnly && state === 'populated';
      return {...binding, answer: null, provisional: !readback, reason: readback ? 'readback_only' : 'unsupported'};
    }
    const isLong = (value: string) => [...value].length > MAX_BROWSER_READBACK_CODE_POINTS;
    const longQuestion = isLong(row.question);
    const longOptions = row.options.some(isLong);
    const unbounded = longQuestion || longOptions;
    const consent = protectedQuestionCategory(row.question, undefined, row.options) === "consent";
    // Compare an already checked declaration to the owner's decision. The browser preserves a conflict.
    if (row.control==='checkbox' && row.selected===true && row.valid && consent && isRecruitmentTermsConsent(row.question,employerNames)) {
      const saved=ownerFact('terms_consent');
      if (typeof saved==='boolean') return {...binding,answer:saved,provisional:false,reason:'owner_consent_readback',lane:'live_owner_fact'};
    }
    if (!unbounded && !consent && row.widget === 'province-menu') {
      const country = facts.find(fact => fact.factId === 'country')?.value;
      const region = facts.find(fact => fact.factId === 'region')?.value;
      const applicable = typeof country === 'string' && normalizeCatalogText(country) === 'canada' &&
        typeof region === 'string' && Boolean(region.trim());
      return {...binding, answer: applicable ? region : null, provisional: !applicable,
        reason: applicable ? 'profile_answer' : 'province_requires_review'};
    }
    if (!unbounded && !consent && row.widget === 'international-phone') {
      const savedPhoneCountry = facts.find(fact => fact.factId === 'phone_country_code')?.value;
      const residence = facts.find(fact => fact.factId === 'country')?.value;
      const numericDial = typeof savedPhoneCountry === 'string' && /^\+\d{1,3}$/.test(savedPhoneCountry.trim()) ? savedPhoneCountry.trim().slice(1) : undefined;
      const country = typeof savedPhoneCountry === 'string' && !numericDial
        ? phoneCountryName(savedPhoneCountry) ?? savedPhoneCountry
        : residence;
      const number = facts.find(fact => fact.factId === 'phone_number')?.value;
      if (typeof country !== 'string' || !country.trim() || typeof number !== 'string' || !number.trim()) {
        return {...binding, answer: null, provisional: true, reason: 'phone_country_requires_review'};
      }
      const inferred = typeof savedPhoneCountry !== 'string' || numericDial !== undefined;
      return {...binding, answer: number, phoneCountry: country, ...(numericDial && {phoneDial: numericDial}), provisional: inferred,
        reason: inferred ? 'phone_country_inferred_from_residence' : 'answer_resolved'};
    }
    const questionFact=inspectQuestionMatch(row.question, employerNames).factId;
    // A committed screening radio needs the expected answer for comparison. The browser preserves the selection.
    const compareBackgroundCheck = state === 'populated' && row.valid && row.control === 'radio' &&
      consent && questionFact === 'background_check_willing';
    let addressCountryConflict=false;
    if (questionFact==='postal_code' && row.formId) {
      const savedCountry=facts.find(fact=>fact.factId==='country')?.value;
      const countries=observations.filter(other=>other.frameId===row.frameId && other.formId===row.formId &&
        inspectQuestionMatch(other.question).factId==='country');
      const selected = countries.length === 1 ? countries[0]!.selected : undefined;
      if (typeof savedCountry==='string' && typeof selected==='string' && selected.trim() &&
          normalizeCatalogText(selected)!==normalizeCatalogText(savedCountry)) {
        addressCountryConflict=true;
      }
    }
    // Opaque structural labels never match a truncated question. The resolver receives the full wording.
    const field:ApplicationFieldObservation={fieldId:fieldId(row.fieldId),target:browserTargetToken(row.fieldId),
      label:boundedText(longQuestion ? 'Unclassified question' : row.question), ...(longQuestion && {rawQuestion:row.question}),
      behavior:row.control as ApplicationFieldObservation['behavior'],required:row.required,
      options:row.options.map((label,index)=>({id:optionId(String(index)),label:boundedText(isLong(label) ? `Unclassified option ${index}` : label)})),
      ...(longOptions && {rawOptions:row.options}), constraints, readOnly:constraints?.readOnly,
      queryable:row.queryable,searchQuery:row.searchQuery,state:compareBackgroundCheck ? 'empty' : state, populatedValueValid:row.valid};
    const resolution=await resolver.resolve({field,mode:sources.profilePlan.mode,
      answerFallbackPolicy:sources.executionPolicy.answerFallbackPolicy,profileId:sources.profileId,profileRevision:sources.profileRevision,
      resume:{resumeId:sources.resumeIntent.artifact.resumeId,sha256:sources.resumeIntent.artifact.sha256},resumeArtifact:sources.resumeIntent.artifact,
      employerNames:employerNames},signal);
    const resolved=resolution.ok&&resolution.value.kind==='resolved'?resolution.value:undefined;
    if (unbounded || consent) {
      const intent = resolved?.intent;
      const answer = intent?.kind === 'choice'
        ? row.options[field.options.findIndex(option => option.id === intent.optionId)] ?? null
        : intent ? intentAnswer(intent) : null;
      return {...binding, answer, provisional: !resolved || resolved.lane === 'synthetic_test_default',
        reason: resolved ? 'answer_resolved' : resolution.ok ? resolution.value.kind : resolution.error.code,
        answerKind: intent?.kind, lane: resolved?.lane};
    }
    const label = normalizeCatalogText(row.question);
    const fitsGpa = label === averageGpaQuestion && constraints?.inputType === 'text' && !constraints.pattern &&
      scaledGpa && (constraints.maxLength == null || scaledGpa.length <= constraints.maxLength);
    const text = ['text', 'textarea'].includes(row.control)
      ? fitsGpa ? scaledGpa : profileFieldValue(row.question, facts)
      : undefined;
    const positive = (hasCloudExperience && label === handsOnCloudQuestion) ||
      (hasNorthAmericanLocation && label === northAmericanLocationQuestion);
    const binary = positive ? 'yes' : provinceResidenceAnswer(row.question, canadianRegion);
    const binaryChoices = binary && row.widget !== 'multi-checkbox' && ['radio', 'select', 'listbox'].includes(row.control)
      ? row.options.filter(option => option.toLowerCase() === binary) : [];
    const city = facts.find(fact => fact.factId === 'city')?.value;
    const locationChoice = (questionFact === 'current_location' || questionFact === 'city') && row.control === 'listbox';
    if (locationChoice && row.queryable && !populated && (!row.searchQuery || row.widget==='rippling-location' && row.searchQuery===city) && !row.options.length &&
        typeof city === 'string' && city.trim() && [...city].length <= MAX_BROWSER_READBACK_CODE_POINTS) {
      return {...binding, answer:null, query:city, provisional:false, reason:'choice_options_query', lane:'profile_fact'};
    }
    const locationIndex = locationChoice && typeof city === 'string'
      ? matchLocationOption(row.options, city, facts.find(fact => fact.factId === 'region')?.value,
          facts.find(fact => fact.factId === 'country')?.value)
      : -1;
    const direct = text ?? row.options[locationIndex] ?? (binaryChoices.length === 1 ? binaryChoices[0] : undefined);
    let provisional = addressCountryConflict || direct === undefined && (!resolved || resolved.lane === 'synthetic_test_default');
    let answer = direct ?? (resolved ? intentAnswer(resolved.intent) : null);
    let reason = addressCountryConflict ? 'address_country_conflict' : direct !== undefined ? 'profile_answer' :
      resolved ? 'answer_resolved' : resolution.ok ? resolution.value.kind : resolution.error.code;
    if(sources.executionPolicy.answerFallbackPolicy==='deterministic_site_valid_editable' &&
        questionFact==='phone_country_code' && !facts.some(fact=>fact.factId==='phone_country_code')) {
      const country=facts.find(fact=>fact.factId==='country')?.value;
      const options=typeof country==='string'?row.options.filter(option=>phoneCountryName(option)===normalizeCatalogText(country)):[];
      if(options.length===1){answer=options[0]!;provisional=true;reason='phone_country_inferred_from_residence';}
    }
    // Preserve the employer's equivalent spelling, without treating a typed choice as committed.
    if(row.valid && ['text','textarea'].includes(row.control) && typeof row.selected==='string' && row.selected.trim() &&
        typeof answer==='string' && questionFact && equivalentAnswer(row.selected,answer,questionFact)) answer=row.selected;
    const query=direct===undefined && resolved?.intent.kind==='choice' && resolved.intent.optionId==='deferred-search' ? String(resolved.intent.expectedOption) : undefined;
    if(query!==undefined){answer=null;reason='choice_options_query';}
    return {...binding,answer,...(query===undefined?{}:{query}),provisional,reason,
      answerKind: resolved?.intent.kind, lane: direct !== undefined ? 'profile_fact' : resolved?.lane};
  }

  return async (row: PageQuestion, observations: readonly PeerQuestion[], signal: AbortSignal) => {
    try {
      const plan = await planAnswer(row, observations, signal);
      if (plan.reason === 'protected_answer_denied') return plan;
      if (row.widget === 'native-multiple' && row.required && !row.selected && plan.provisional && typeof plan.answer === 'string') {
        const question = resolveQuestion(row.question, employerNames);
        const sensitive = protectedQuestionCategory(row.question, question.kind === 'resolved' ? question.id : undefined) ||
          /\b(?:nationalit(?:y|ies)|citizenships?|ethnic(?:ity|ities)?|medical|diagnos(?:is|es)|disabilit(?:y|ies)|disabled|religio(?:n|ns|us)|faith|pronouns?|gender|orientation|ancestry|racial)\b/u.test(normalizeCatalogText(row.question));
        const neutral = row.options.filter(option => contractApprovedPrivacyChoices.some(
          choice => normalizeCatalogText(option) === normalizeCatalogText(choice)));
        if (!sensitive && !neutral.length) return plan;
        return {...plan, answer: neutral.length === 1 ? neutral[0]! : null,
          reason: neutral.length === 1 ? 'neutral_disclosure' : 'multiple_choice_requires_owner_answer'};
      }
      return plan;
    } catch (error) {
      if (!signal.aborted) recordComponentFailure(error, 'answer_matching', 'plan_answer');
      throw error;
    }
  };
}
