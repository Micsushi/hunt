import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createQuestionAnswerLearningCapture, type QuestionAnswerLearningCapture } from "../live/evidence/question-answer-learning.ts";
import { captureResumeArtifact, upstreamResumeId } from "../contracts/index.ts";
import { admitApplicationExecutionPolicy, answerModeAllowedByPolicy, liveApplicationExecutionPolicy } from "../contracts/application-execution-policy.ts";
import { parseApplicationProfile, createApplicationProfileQuery } from "../profile/application-profile.ts";
import { createConfiguredNarrativeProvider } from "../ats/workday/application/questions/index.ts";
import { createWorkdayResumeFileIntent } from "../ats/workday/application/resume/index.ts";
import { profileAnswerMatchesFact, validateProfileAuthority, type Stage2ApplicationOwnerSources } from "../composition/private/s2-application-owner-source.ts";
import { applicationTextProfileFactIds, applicationBooleanProfileFactIds, applicationNumberProfileFactIds } from '../form/answers/application-types.ts';

import { questionAnswerGuide, questionFor, generatedLearningDefaultFor } from '../form/questions/catalog.ts';
import { semanticSyntheticTestDefault } from '../form/answers/testing-policy.ts';
import type { ProfileRepeatablePlan } from '../ats/workday/application/profile/types.ts';
import { profileOwnerInputCatalog } from '../ats/workday/application/profile/catalog.ts';
import { createMatchingBacklog, intentAnswer, type MatchingObservation } from './matching-backlog.ts';

const websiteFacts = {linkedin:'linkedin_url', github:'github_url', portfolio:'portfolio_url'} as const;
type WebsiteFactId = (typeof websiteFacts)[keyof typeof websiteFacts];

function websiteFact(rowKey: string): WebsiteFactId | undefined {
  return Object.hasOwn(websiteFacts,rowKey) ? websiteFacts[rowKey as keyof typeof websiteFacts] : undefined;
}

function websiteUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Consent only belongs to the applicant who explicitly saved it. */
export function aiConsentAuthority(manifest: unknown) {
  if (!manifest) return undefined;
  const profile = parseApplicationProfile((manifest as {profile:unknown}).profile);
  const owner = profile.facts.find(fact => fact.factId === 'email_address')?.value ?? profile.profileId;
  const fact = profile.facts.find(fact => fact.factId === 'ai_evaluation_consent' && fact.provenance === 'owner_provided');
  return {owner, fact};
}

/** Product projections never change persisted facts or reattribute saved website answers. */
export function effectiveProfileFacts(value: unknown) {
  const manifest = value as {profile?:unknown;profilePlan?:unknown} | undefined;
  const profile = parseApplicationProfile(manifest?.profile);
  const facts = [...profile.facts];
  // Owner-requested defaults; explicit saved answers always take precedence.
  if ((manifest?.profilePlan as {mode?:unknown})?.mode === 'live') for (const factId of ['previously_worked_for_organization','associate_referral'] as const) {
    if (!facts.some(fact => fact.factId === factId)) facts.push({factId,value:false,provenance:'owner_provided',lane:'live_owner_fact'});
  }
  if ((manifest?.profilePlan as {mode?:unknown})?.mode === 'live' && !facts.some(fact=>fact.factId==='terms_consent')) {
    facts.push({factId:'terms_consent',value:true,provenance:'owner_provided',lane:'live_owner_fact'});
  }
  const plan = validateProfileAuthority(manifest?.profilePlan,facts);
  for (const row of plan.repeatables.find(section=>section.section==='websites')?.rows ?? []) {
    const factId = websiteFact(row.rowKey);
    if (!factId || facts.some(fact=>fact.factId===factId)) continue;
    const fields = row.fields.filter(field=>field.fieldId==='website.url');
    const answer = fields.length===1 && fields[0]?.answer;
    if (answer && answer.kind==='answered' && answer.provenance==='resume_verified' &&
        answer.lane==='live_owner_fact' && websiteUrl(answer.value)) {
      facts.push({factId,value:answer.value,provenance:answer.provenance,lane:answer.lane});
    }
  }
  const phoneCountry=plan.fields.filter(field=>field.fieldId==='phone.country_code');
  const phoneAnswer=phoneCountry.length===1 && phoneCountry[0]?.answer;
  if (!facts.some(fact=>fact.factId==='phone_country_code') && phoneAnswer && phoneAnswer.kind==='answered' &&
      typeof phoneAnswer.value==='string' && phoneAnswer.value.trim() && phoneAnswer.lane==='live_owner_fact' &&
      (phoneAnswer.provenance==='owner_provided' || phoneAnswer.provenance==='resume_verified')) {
    facts.push({factId:'phone_country_code',value:phoneAnswer.value,provenance:phoneAnswer.provenance,lane:phoneAnswer.lane});
  }
  const city=facts.find(fact=>fact.factId==='city'),region=facts.find(fact=>fact.factId==='region');
  if (!facts.some(fact=>fact.factId==='current_location') && city && typeof city.value==='string' && city.value.trim()) {
    const useRegion=region && typeof region.value==='string' && region.value.trim() && city.lane===region.lane && city.provenance===region.provenance;
    facts.push({factId:'current_location',value:useRegion?`${city.value}, ${region.value}`:city.value,provenance:city.provenance,lane:city.lane});
  }
  return facts;
}

// Employer-specific answers and legal consent must be decided on each application.
const perApplication = new Set(['terms_consent', 'previously_worked_for_organization', 'associate_referral', 'current_associate', 'previously_applied', 'relatives_employed']);
export const applicantFields = [
  ...applicationTextProfileFactIds.map(id => ({id, type:'text'})),
  ...applicationBooleanProfileFactIds.map(id => ({id, type:'boolean'})),
  ...applicationNumberProfileFactIds.map(id => ({id, type:'number'})),
].filter(field => !perApplication.has(field.id) && !['phone_country_code','current_location'].includes(field.id)).map(field => {
  const question = questionAnswerGuide.map(entry => questionFor(entry.id)).find(question => question?.source && 'factId' in question.source && question.source.factId === field.id);
  const source = question?.source;
  const suggestedValue = question ? semanticSyntheticTestDefault(question.labels[0]!) ??
    (source && 'syntheticDefault' in source ? source.syntheticDefault : undefined) ?? generatedLearningDefaultFor(question.id) : undefined;
  return {...field, ...(suggestedValue === undefined ? {} : {suggestedValue})};
});

const basicFields = {
  address_line1: ["address.line1", "address", "text"],
  address_line2: ["address.line2", "address", "text"],
  given_name: ["identity.given_name", "identity", "text"],
  family_name: ["identity.family_name", "identity", "text"],
  email_address: ["contact.email", "identity", "text"],
  city: ["address.city", "address", "text"],
  country: ["address.country", "address", "option"],
  region: ["address.region", "address", "option"],
  postal_code: ["address.postal_code", "address", "text"],
  phone_number: ["phone.number", "phone", "phone"],
} as const;

/** Owner-entered values use the same profile contract as imported C3 profiles. */
export function applicantProfile(values: unknown, previous?: unknown): unknown {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Enter your applicant details.");
  const input = values as Record<string, unknown>;
  const old = previous as { profile?: { facts: { factId: string; value: unknown; provenance: string }[]; revision: number; discoveredFields?: unknown[] }; profilePlan?: { mode: string; fields: { fieldId: string }[]; repeatables: ProfileRepeatablePlan[] }; executionPolicy?: unknown } | undefined;
  if (old?.profilePlan && old.profilePlan.mode !== "live") throw new Error("Import an updated profile to edit a test profile. Its application policy is preserved.");
  const facts: {factId:string;value:string|number|boolean;provenance:string;lane:string}[] = [], fields = [];
  for (const [factId, [fieldId, questionType, answerType]] of Object.entries(basicFields)) {
    const value = input[factId];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 300 || !value.trim()) throw new Error("Check your applicant details.");
    const answer = { kind: "answered", value: value.trim(), provenance: "owner_provided", lane: "live_owner_fact" };
    facts.push({ factId, value: answer.value, provenance: answer.provenance, lane: answer.lane });
    fields.push({ fieldId, questionType, answerType, allowedOptions: [], answer,
      ...(answerType === "option" ? { optionMapping: { canonicalValue: answer.value, visibleOption: answer.value, provenance: "visible_option" } } : {}) });
  }
  for (const required of ["given_name", "family_name", "email_address"]) if (!facts.some(f => f.factId === required)) throw new Error("Enter your name and email.");
  const edited = new Set<string>(Object.keys(basicFields));
  const savedWebsites = old?.profilePlan?.repeatables.find(section=>section.section==='websites');
  for (const field of applicantFields) {
    if (field.id in basicFields || !(field.id in input)) continue;
    const raw = input[field.id];
    const savedRow = savedWebsites?.rows.find(row=>websiteFact(row.rowKey)===field.id);
    const savedLinks = savedRow?.fields.filter(item=>item.fieldId==='website.url') ?? [];
    const savedLink = savedLinks.length===1 && savedLinks[0]?.answer;
    if (!old?.profile?.facts.some(fact=>fact.factId===field.id) &&
        savedLink && savedLink.kind==='answered' && savedLink.provenance==='resume_verified' &&
        savedLink.lane==='live_owner_fact' && websiteUrl(savedLink.value) && raw===savedLink.value) continue;
    edited.add(field.id);
    if (raw === '') continue;
    if (typeof raw !== 'string' || raw.length > 4000) throw new Error('Check your saved answers.');
    if (Object.values(websiteFacts).some(id=>id===field.id) && !websiteUrl(raw.trim())) {
      throw new Error('Enter a complete website URL without credentials.');
    }
    let value: string | number | boolean = raw.trim();
    if (field.type === 'boolean') {
      if (!['true','false'].includes(raw)) throw new Error('Choose Yes, No, or leave the answer blank.');
      value = raw === 'true';
    } else if (field.type === 'number') {
      value = Number(raw);
      if (!raw.trim() || !Number.isFinite(value) || value < 0) throw new Error('Enter a nonnegative number.');
    }
    if (value !== '') facts.push({factId:field.id, value, provenance:field.id==='configured_narrative'?'configured_template':'owner_provided', lane:'live_owner_fact'});
  }
  const replaced = new Set(Object.values(basicFields).map(f => f[0] as string));
  const profile = parseApplicationProfile({ profileId: "product-applicant", revision: (old?.profile?.revision ?? 0) + 1,
    facts: [...(old?.profile?.facts ?? []).filter(f => !edited.has(f.factId)), ...facts], unsetFactIds: [], discoveredFields: old?.profile?.discoveredFields ?? [] });
  const beforeFacts = new Map(old?.profile?.facts.map(fact => [fact.factId, fact]));
  const afterFacts = new Map<string, (typeof profile.facts)[number]>(profile.facts.map(fact => [fact.factId, fact]));
  const rowFactIds: Record<string, string> = {
    'experience.company':'current_company', 'experience.title':'current_title',
    'education.school':'education_institution', 'education.field_of_study':'education_field_of_study',
    'education.start_year':'education_start_year', 'education.end_year':'education_end_year', 'education.gpa':'education_gpa',
  };
  const repeatables = (old?.profilePlan?.repeatables ?? []).map(section => ({...section, rows:section.rows.flatMap(row=>{
    const id = section.section==='websites' ? websiteFact(row.rowKey) : undefined;
    if (!id || !edited.has(id)) return [row];
    const value = afterFacts.get(id)?.value;
    if (!websiteUrl(value)) return [];
    return [{...row, fields:row.fields.map(field=>field.fieldId==='website.url' &&
      (field.answer.kind!=='answered' || field.answer.value!==value)
      ? {...field,answer:{kind:'answered' as const,value,provenance:'owner_provided' as const,lane:'live_owner_fact' as const}}
      : field)}];
  }).map(row => ({...row, fields:row.fields.map(field => {
    const oldId = field.fieldId === 'education.degree' ? beforeFacts.has('education_degree') ? 'education_degree' : 'highest_education' : rowFactIds[field.fieldId];
    const nextId = field.fieldId === 'education.degree' ? afterFacts.has('education_degree') ? 'education_degree' : 'highest_education' : oldId;
    if (!oldId || !nextId || field.answer.kind !== 'answered' || field.answer.provenance !== 'owner_provided') return field;
    const before = beforeFacts.get(oldId), after = afterFacts.get(nextId);
    if (before?.provenance !== 'owner_provided' || !profileAnswerMatchesFact(field.answerType, field.answer.value, before.value) ||
        (!(oldId in input) && !(nextId in input)) || (before.value === after?.value && oldId === nextId)) return field;
    const label = oldId.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
    if ((oldId in input && input[oldId] === '') || !after || typeof after.value !== 'string') {
      throw new Error(`${label} is used in saved detailed history. Replace its value rather than clearing it.`);
    }
    if (field.optionMapping && (!profileAnswerMatchesFact(field.answerType, field.optionMapping.canonicalValue, before.value) || field.optionMapping.visibleOption !== before.value)) {
      throw new Error(`${label} has a custom option in saved detailed history. Update that profile mapping before changing it.`);
    }
    const value = field.answerType === "multi_select" ? JSON.stringify([after.value]) : after.value;
    return {...field, answer:{...field.answer, value}, ...(field.optionMapping ? {optionMapping:{...field.optionMapping, canonicalValue:value, visibleOption:after.value}} : {})};
  })}))})).filter(section=>section.rows.length);
  const websiteSection = repeatables.find(section=>section.section==='websites');
  const missingWebsiteRows = Object.entries(websiteFacts).flatMap(([rowKey,id])=>{
    const value = afterFacts.get(id)?.value;
    if (!edited.has(id) || !websiteUrl(value) || websiteSection?.rows.some(row=>row.rowKey===rowKey)) return [];
    return [{rowKey,fields:[{fieldId:'website.url',questionType:'website' as const,answerType:'url' as const,allowedOptions:[],
      answer:{kind:'answered' as const,value,provenance:'owner_provided' as const,lane:'live_owner_fact' as const}}]}];
  });
  if (missingWebsiteRows.length) {
    if (websiteSection) websiteSection.rows.push(...missingWebsiteRows);
    else repeatables.push({section:'websites',rows:missingWebsiteRows});
  }
  return { profile, profilePlan: { mode: "live", pageType: "profile", fields: [...(old?.profilePlan?.fields ?? []).filter(f => !replaced.has(f.fieldId)), ...fields],
    repeatables }, executionPolicy: input.answer_policy === undefined ? old?.executionPolicy ?? {...liveApplicationExecutionPolicy('live'), answerFallbackPolicy:'owner_facts_only'} : {
      ...liveApplicationExecutionPolicy('live'), answerFallbackPolicy: input.answer_policy === 'test' ? 'deterministic_site_valid_editable' : 'owner_facts_only',
    } };
}

/** Discovery metadata only. Product readbacks are not independent campaign monitor proof. */
export function productQuestionLearning(root: string | undefined, sources: Stage2ApplicationOwnerSources, url?:string, profile?:unknown) {
  const backlog=createMatchingBacklog(root,url,profile===undefined?[]:effectiveProfileFacts(profile),'C3.1',(sources.profileQuery as import('../form/answers/application-types.ts').ApplicationProfileQuery).ownerDefaults);
  const operations=new Map<string,MatchingObservation>();
  const capture = root === undefined ? undefined : createQuestionAnswerLearningCapture({ root, mode: sources.profilePlan.mode,
    executionPolicy: sources.executionPolicy, sensitiveValues: sources.sensitiveValues });
  let observed = false, pending = false, failed = false;
  const recordBacklog=(value:MatchingObservation)=>{try {backlog.record(value);} catch {failed=true;}};
  const observation=(value:Pick<Parameters<QuestionAnswerLearningCapture['recordObserved']>[0], 'field' | 'pageId'>):MatchingObservation=>({
    pageId:value.pageId??'questionnaire',fieldId:value.field.fieldId,question:value.field.rawQuestion ?? value.field.label,
    control:value.field.behavior,options:value.field.rawOptions ?? value.field.options.map(option=>option.label),required:value.field.required,
    constraints:'constraints' in value.field?value.field.constraints:undefined,outcome:'observed'});
  const answerValue = (value: Parameters<QuestionAnswerLearningCapture['recordAttempt']>[0]) => {
    const intent = value.intent;
    const index = intent.kind === 'choice' ? value.field.options.findIndex(option => option.id === intent.optionId) : -1;
    return value.field.rawOptions?.[index] ?? intentAnswer(value.intent);
  };
  const reviewNeeded = new Map<string, boolean>();
  const questionKey = (value: Parameters<QuestionAnswerLearningCapture["recordObserved"]>[0]) => JSON.stringify([value.pageId, value.field.fieldId]);
  const recordObserved: QuestionAnswerLearningCapture["recordObserved"] = value => {
    observed = true;
    reviewNeeded.set(questionKey(value), true);
    recordBacklog(observation(value));
    try { capture?.recordObserved(value); } catch { failed = true; }
  };
  let salaryUnitsNeedReview = false;
  const sink: QuestionAnswerLearningCapture = {
    recordSalaryAmount(value) {
      salaryUnitsNeedReview = true;
      recordBacklog({...observation(value),
        chosenAnswer:value.amount,observedAnswer:value.amount,provisional:true,outcome:"unconfirmed",reason:"salary_units_need_review"});
    },
    recordObserved,
    recordUnset: recordObserved,
    recordAttempt(value) {
      recordObserved(value);
      reviewNeeded.set(questionKey(value), value.lane === "synthetic_test_default");
      const entry={...observation(value),chosenAnswer:answerValue(value),provisional:value.lane==='synthetic_test_default',outcome:'attempted' as const,
        reason:value.lane==='synthetic_test_default'?'editable_fallback':'profile_answer'};
      operations.set(value.operationId,entry);recordBacklog(entry);
    },
    recordPendingProfile(value) {
      pending = true;
      reviewNeeded.set(JSON.stringify([value.pageId, value.rowKey, value.fieldId]), true);
      recordBacklog({pageId:value.pageId,fieldId:`${value.rowKey??''}:${value.fieldId}`,question:value.exactQuestion,
        control:value.observedUi?.behavior??value.controlType,options:value.options,required:value.required,
        constraints:value.constraints,chosenAnswer:value.committedReadback??value.testDefault,provisional:true,
        outcome:value.validation==='not_attempted'?'observed':value.validation,reason:'profile_mapping_pending'});
      try { capture?.recordPendingProfile?.({ ...value, testDefault: null, provenance: null,
        validation: "not_attempted", committedReadback: null }); } catch { failed = true; }
    },
    record(value) {recordBacklog({...observation(value),chosenAnswer:answerValue(value),
      provisional:value.lane==='synthetic_test_default',outcome:'verified',reason:'product_readback_confirmed'});},
    recordFailure(value) {const entry=operations.get(value.operationId);if(entry)recordBacklog({...entry,
      outcome:value.stage==='driver'?'driver_failed':'verification_failed',reason:value.code});},
    monitorAck() {}, monitorBatchAck() {},
    // The runtime can request an early seal on failure. Preserve all observations
    // until the engine's finally block, including later pages and recovery paths.
    write: () => null,
  };
  return { sink, get salaryUnitsNeedReview() { return salaryUnitsNeedReview; }, get needsOwnerReview() { return backlog.needsReview || [...reviewNeeded.values()].some(Boolean); }, finish() {
    if (root === undefined || capture === undefined || !observed && !pending && !failed) return;
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const digest = capture.write();
      if (failed || observed && digest === null || pending && !existsSync(join(root, "pending-profile-questions.json"))) {
        throw new Error("Learning journal unavailable");
      }
    } catch {
      throw new Error("C3 could not preserve discovered questions. Your draft is preserved. Check disk space and access, then retry.");
    }
  } };
}

/** The product and campaign use the same admitted profile, answer and file contracts. */
export function productSources(value: unknown, pdf: Buffer): Stage2ApplicationOwnerSources {
  if (!value || typeof value !== "object" || pdf.length > 5 * 1024 * 1024 ||
      pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("Choose a valid profile and PDF resume.");
  const manifest = value as Record<string, unknown>;
  const storedProfile = parseApplicationProfile(manifest.profile);
  const facts = effectiveProfileFacts(manifest);
  const profile = parseApplicationProfile({...storedProfile,facts,
    unsetFactIds:storedProfile.unsetFactIds.filter(id=>!facts.some(fact=>fact.factId===id))});
  let profilePlan = validateProfileAuthority(manifest.profilePlan, profile.facts);
  if (profilePlan.mode === 'live') for (const entry of profileOwnerInputCatalog) {
    if (profilePlan.fields.some(field=>field.fieldId===entry.fieldId && field.answer.kind==='answered')) continue;
    const fact = facts.find(fact=>fact.factId===entry.factId);
    if (fact?.provenance !== 'owner_provided' || !['string','boolean'].includes(typeof fact.value)) continue;
    const value = typeof fact.value === 'boolean' ? fact.value ? 'Yes' : 'No' : fact.value;
    profilePlan = validateProfileAuthority({...profilePlan, fields:[...profilePlan.fields.filter(field=>field.fieldId!==entry.fieldId), {
      fieldId:entry.fieldId, questionType:entry.questionType, answerType:entry.answerType, allowedOptions:entry.allowedOptions,
      answer:{kind:'answered',value,provenance:fact.provenance,lane:fact.lane},
      optionMapping:{canonicalValue:value,visibleOption:value,provenance:'visible_option'},
    }]}, facts);
  }
  // Older campaign profiles predate the explicit transport policy. Keep their
  // answer mode and forbid submission when importing them into the live product.
  const savedExecutionPolicy = admitApplicationExecutionPolicy(manifest.executionPolicy === undefined
    ? liveApplicationExecutionPolicy(profilePlan.mode) : manifest.executionPolicy);
  if (!answerModeAllowedByPolicy(savedExecutionPolicy, profilePlan.mode)) throw new Error("Profile policy mismatch.");
  // Draft-only defaults are reviewed separately and never become saved owner facts.
  const executionPolicy = profilePlan.mode === 'live'
    ? Object.freeze({...savedExecutionPolicy, answerFallbackPolicy:'deterministic_site_valid_editable' as const})
    : savedExecutionPolicy;
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const capture = () => {
    const result = captureResumeArtifact({ resumeId: upstreamResumeId(`resume_${sha256.slice(0, 24)}`), sha256 }, pdf);
    if (!result.ok) throw new Error("Resume could not be captured.");
    return result.value;
  };
  const intent = createWorkdayResumeFileIntent({ artifactId: upstreamResumeId(`resume_${sha256.slice(0, 24)}`), artifact: capture(), fileType: "pdf" });
  if (!intent.ok) throw new Error("Resume is invalid.");
  const narrative = profile.facts.find(f => f.factId === "configured_narrative");
  return {
    resumeIntent: intent.value, captureUploadArtifact: capture, profilePlan, executionPolicy,
    profileId: profile.profileId, profileRevision: profile.revision,
    profileQuery: {
      ...createApplicationProfileQuery({...profile, facts:profile.facts.filter(fact =>
        !['previously_worked_for_organization','associate_referral'].includes(fact.factId) ||
        storedProfile.facts.some(saved=>saved.factId===fact.factId))}),
      ...(profilePlan.mode==='live' ? {ownerDefaults:{employmentRelationship:false as const,associateReferral:false as const,applicationSources:['Job board','LinkedIn']}} : {}),
    },
    narrative: createConfiguredNarrativeProvider({ revision: "product-v1", template: typeof narrative?.value === "string" ? narrative.value : undefined }),
    sensitiveValues: effectiveProfileFacts(manifest).flatMap(f => typeof f.value === "string" ? [f.value] : []),
  };
}
