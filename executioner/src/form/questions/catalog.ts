import type {
  ProfileFactId,
  UiBehaviorId,
} from "../../contracts/index.ts";
import {
  assertCatalogHasNoCollisions,
  resolveCatalogText,
  type ReviewedCatalogEntry,
} from "./normalize.ts";

type QuestionSource =
  | {
      readonly kind: "profile";
      readonly factId: ProfileFactId;
      readonly ownerProvidedOnly?: true;
    }
  | { readonly kind: "narrative"; readonly factId: "configured_narrative" }
  | { readonly kind: "resume" };

interface QuestionCatalogEntry extends ReviewedCatalogEntry<string> {
  readonly behavior: UiBehaviorId;
  readonly source: QuestionSource;
}

function entry<I extends string>(
  id: I,
  label: string,
  behavior: UiBehaviorId,
  source: QuestionSource,
) {
  return Object.freeze({
    id,
    labels: Object.freeze([label]),
    behavior,
    provenance: "reviewed_catalog" as const,
    source: Object.freeze(source),
  });
}

export const questionCatalog = Object.freeze([
  entry("s1-question-given-name", "Given name", "text", { kind: "profile", factId: "given_name" }),
  entry("s1-question-family-name", "Family name", "text", { kind: "profile", factId: "family_name" }),
  entry("s1-question-phone-number", "Phone number", "text", { kind: "profile", factId: "phone_number" }),
  entry("s1-question-configured-narrative", "Brief interest statement", "textarea", { kind: "narrative", factId: "configured_narrative" }),
  entry("s1-question-work-authorization", "Are you authorized to work in this location?", "radio", { kind: "profile", factId: "work_authorization", ownerProvidedOnly: true }),
  entry("s1-question-age-requirement-met", "I am at least 18 years of age.", "checkbox", { kind: "profile", factId: "age_requirement_met", ownerProvidedOnly: true }),
  entry("s1-question-sponsorship-required", "Will you require sponsorship?", "select", { kind: "profile", factId: "sponsorship_required", ownerProvidedOnly: true }),
  entry("s1-question-country", "Country", "listbox", { kind: "profile", factId: "country" }),
  entry("s1-question-earliest-start-date", "Available start date", "date", { kind: "profile", factId: "earliest_start_date", ownerProvidedOnly: true }),
  entry("s1-question-resume", "Resume", "file_upload", { kind: "resume" }),
] as const satisfies readonly QuestionCatalogEntry[]);

assertCatalogHasNoCollisions(questionCatalog);

export type CanonicalQuestionId = (typeof questionCatalog)[number]["id"];

export function resolveQuestion(text: string) {
  return resolveCatalogText(questionCatalog, text);
}

export function questionFor(id: CanonicalQuestionId) {
  return questionCatalog.find((question) => question.id === id);
}
