import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createQuestionAnswerLearningCapture, type QuestionAnswerLearningCapture } from "../live/evidence/question-answer-learning.ts";
import { captureResumeArtifact, upstreamResumeId } from "../contracts/index.ts";
import { admitApplicationExecutionPolicy, answerModeAllowedByPolicy, liveApplicationExecutionPolicy } from "../contracts/application-execution-policy.ts";
import { parseApplicationProfile, createApplicationProfileQuery } from "../profile/application-profile.ts";
import { createConfiguredNarrativeProvider } from "../ats/workday/application/questions/index.ts";
import { createWorkdayResumeFileIntent } from "../ats/workday/application/resume/index.ts";
import { validateProfileAuthority, type Stage2ApplicationOwnerSources } from "../composition/private/s2-application-owner-source.ts";
import { applicationTextProfileFactIds, applicationBooleanProfileFactIds, applicationNumberProfileFactIds } from '../form/answers/application-types.ts';

// Employer-specific answers and legal consent must be decided on each application.
const perApplication = new Set(['terms_consent', 'previously_worked_for_organization', 'associate_referral', 'current_associate', 'previously_applied', 'relatives_employed']);
export const applicantFields = [
  ...applicationTextProfileFactIds.map(id => ({id, type:'text'})),
  ...applicationBooleanProfileFactIds.map(id => ({id, type:'boolean'})),
  ...applicationNumberProfileFactIds.map(id => ({id, type:'number'})),
].filter(field => !perApplication.has(field.id));

const basicFields = {
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
  const old = previous as { profile?: { facts: { factId: string }[]; revision: number; discoveredFields?: unknown[] }; profilePlan?: { mode: string; fields: { fieldId: string }[]; repeatables: unknown[] }; executionPolicy?: unknown } | undefined;
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
  for (const field of applicantFields) {
    if (field.id in basicFields || !(field.id in input)) continue;
    edited.add(field.id);
    const raw = input[field.id];
    if (raw === '') continue;
    if (typeof raw !== 'string' || raw.length > 4000) throw new Error('Check your saved answers.');
    let value: string | number | boolean = raw.trim();
    if (field.type === 'boolean') {
      if (!['true','false'].includes(raw)) throw new Error('Choose Yes, No, or leave the answer blank.');
      value = raw === 'true';
    } else if (field.type === 'number') {
      value = Number(raw);
      if (!raw.trim() || !Number.isFinite(value) || value < 0) throw new Error('Enter a nonnegative number.');
    }
    if (value !== '') facts.push({factId:field.id, value, provenance:'owner_provided', lane:'live_owner_fact'});
  }
  const replaced = new Set(Object.values(basicFields).map(f => f[0] as string));
  const profile = parseApplicationProfile({ profileId: "product-applicant", revision: (old?.profile?.revision ?? 0) + 1,
    facts: [...(old?.profile?.facts ?? []).filter(f => !edited.has(f.factId)), ...facts], unsetFactIds: [], discoveredFields: old?.profile?.discoveredFields ?? [] });
  return { profile, profilePlan: { mode: "live", pageType: "profile", fields: [...(old?.profilePlan?.fields ?? []).filter(f => !replaced.has(f.fieldId)), ...fields],
    repeatables: old?.profilePlan?.repeatables ?? [] }, executionPolicy: input.answer_policy === undefined ? old?.executionPolicy ?? liveApplicationExecutionPolicy('live') : {
      ...liveApplicationExecutionPolicy('live'), answerFallbackPolicy: input.answer_policy === 'test' ? 'deterministic_site_valid_editable' : 'owner_facts_only',
    } };
}

/** Discovery metadata only. Product readbacks are not independent campaign monitor proof. */
export function productQuestionLearning(root: string, sources: Stage2ApplicationOwnerSources) {
  const capture = createQuestionAnswerLearningCapture({ root, mode: sources.profilePlan.mode,
    executionPolicy: sources.executionPolicy, sensitiveValues: sources.sensitiveValues });
  let observed = false, pending = false, failed = false;
  const recordObserved: QuestionAnswerLearningCapture["recordObserved"] = value => {
    observed = true;
    try { capture.recordObserved(value); } catch { failed = true; }
  };
  const sink: QuestionAnswerLearningCapture = {
    recordObserved, recordUnset: recordObserved, recordAttempt: recordObserved,
    recordPendingProfile(value) {
      pending = true;
      try { capture.recordPendingProfile?.({ ...value, testDefault: null, provenance: null,
        validation: "not_attempted", committedReadback: null }); } catch { failed = true; }
    },
    record() {}, recordFailure() {}, monitorAck() {}, monitorBatchAck() {},
    // The runtime can request an early seal on failure. Preserve all observations
    // until the engine's finally block, including later pages and recovery paths.
    write: () => null,
  };
  return { sink, finish() {
    if (!observed && !pending && !failed) return;
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
  const profile = parseApplicationProfile(manifest.profile);
  const profilePlan = validateProfileAuthority(manifest.profilePlan, profile.facts);
  // Older campaign profiles predate the explicit transport policy. Keep their
  // answer mode and forbid submission when importing them into the live product.
  const executionPolicy = admitApplicationExecutionPolicy(manifest.executionPolicy === undefined
    ? liveApplicationExecutionPolicy(profilePlan.mode) : manifest.executionPolicy);
  if (!answerModeAllowedByPolicy(executionPolicy, profilePlan.mode)) throw new Error("Profile policy mismatch.");
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
    profileQuery: createApplicationProfileQuery(profile),
    narrative: createConfiguredNarrativeProvider({ revision: "product-v1", template: typeof narrative?.value === "string" ? narrative.value : undefined }),
    sensitiveValues: profile.facts.flatMap(f => typeof f.value === "string" ? [f.value] : []),
  };
}
