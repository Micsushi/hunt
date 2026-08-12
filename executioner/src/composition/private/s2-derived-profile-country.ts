const CANADIAN_REGIONS = new Set([
  "ab", "alberta", "bc", "british columbia", "mb", "manitoba", "nb",
  "new brunswick", "newfoundland and labrador", "nl", "northwest territories",
  "nova scotia", "ns", "nt", "nu", "nunavut", "on", "ontario", "pe",
  "prince edward island", "qc", "quebec", "saskatchewan", "sk", "yt", "yukon",
]);

export interface DerivedProfileCountry {
  readonly canonicalValue: "CA";
  readonly visibleOption: "Canada";
}

interface AuthoritativeTextFact {
  readonly factId: string;
  readonly value: string;
  readonly provenance: "owner_provided" | "resume_verified" | "configured_template";
}

const AUTHORITATIVE_PROVENANCE = new Set<AuthoritativeTextFact["provenance"]>([
  "owner_provided",
  "resume_verified",
  "configured_template",
]);

export function deriveProfileCountry(
  facts: readonly unknown[],
): DerivedProfileCountry | undefined {
  const fact = uniqueTextFact(facts, "region");
  if (fact === undefined) return undefined;
  const region = fact.value.normalize("NFC").replace(/\s+/gu, " ").trim()
    .toLocaleLowerCase("en-US");
  return CANADIAN_REGIONS.has(region)
    ? Object.freeze({ canonicalValue: "CA", visibleOption: "Canada" })
    : undefined;
}

export function withDerivedProfileCountry(
  profile: unknown,
  plan: unknown,
): unknown {
  if (
    typeof profile !== "object" || profile === null || Array.isArray(profile) ||
    typeof plan !== "object" || plan === null || Array.isArray(plan)
  ) return plan;
  const facts = (profile as { readonly facts?: unknown }).facts;
  const fields = (plan as { readonly fields?: unknown }).fields;
  if (!Array.isArray(facts) || !Array.isArray(fields)) return plan;
  const planned = new Set(fields.flatMap((field) =>
    typeof field === "object" && field !== null && !Array.isArray(field) &&
      typeof (field as { readonly fieldId?: unknown }).fieldId === "string"
      ? [(field as { readonly fieldId: string }).fieldId]
      : []
  ));
  const additions: unknown[] = [];
  const country = deriveProfileCountry(facts);
  if (country !== undefined && !planned.has("address.country")) {
    additions.push({
      fieldId: "address.country",
      questionType: "address",
      answerType: "option",
      answer: { kind: "answered", value: country.canonicalValue, provenance: "journey_derived" },
      optionMapping: {
        canonicalValue: country.canonicalValue,
        visibleOption: country.visibleOption,
        provenance: "visible_option",
      },
    });
  }
  addTextFact(additions, planned, facts, "email_address", "contact.email", "identity");
  addTextFact(additions, planned, facts, "city", "address.city", "address");
  const region = uniqueTextFact(facts, "region");
  if (region !== undefined && !planned.has("address.region")) {
    additions.push({
      fieldId: "address.region",
      questionType: "address",
      answerType: "option",
      answer: { kind: "answered", value: region.value, provenance: region.provenance },
      optionMapping: {
        canonicalValue: region.value,
        visibleOption: region.value,
        provenance: "visible_option",
      },
    });
  }
  if (additions.length === 0) return plan;
  return {
    ...(plan as Record<string, unknown>),
    fields: [...fields, ...additions],
  };
}

function addTextFact(
  additions: unknown[],
  planned: ReadonlySet<string>,
  facts: readonly unknown[],
  factId: string,
  fieldId: string,
  questionType: "identity" | "address",
): void {
  if (planned.has(fieldId)) return;
  const fact = uniqueTextFact(facts, factId);
  if (fact === undefined) return;
  additions.push({
    fieldId,
    questionType,
    answerType: "text",
    answer: { kind: "answered", value: fact.value, provenance: fact.provenance },
  });
}

function uniqueTextFact(
  facts: readonly unknown[],
  factId: string,
): AuthoritativeTextFact | undefined {
  const matches = facts.filter((value): value is AuthoritativeTextFact => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const fact = value as Record<string, unknown>;
    return fact.factId === factId &&
      typeof fact.value === "string" && fact.value.trim() !== "" &&
      AUTHORITATIVE_PROVENANCE.has(fact.provenance as AuthoritativeTextFact["provenance"]);
  });
  return matches.length === 1 ? matches[0] : undefined;
}
