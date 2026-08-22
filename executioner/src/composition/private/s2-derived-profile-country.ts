const CANADIAN_REGIONS = new Map([
  ["ab", "Alberta"], ["alberta", "Alberta"],
  ["bc", "British Columbia"], ["british columbia", "British Columbia"],
  ["mb", "Manitoba"], ["manitoba", "Manitoba"],
  ["nb", "New Brunswick"], ["new brunswick", "New Brunswick"],
  ["nl", "Newfoundland and Labrador"],
  ["newfoundland and labrador", "Newfoundland and Labrador"],
  ["nt", "Northwest Territories"], ["northwest territories", "Northwest Territories"],
  ["ns", "Nova Scotia"], ["nova scotia", "Nova Scotia"],
  ["nu", "Nunavut"], ["nunavut", "Nunavut"],
  ["on", "Ontario"], ["ontario", "Ontario"],
  ["pe", "Prince Edward Island"], ["prince edward island", "Prince Edward Island"],
  ["qc", "Quebec"], ["quebec", "Quebec"],
  ["sk", "Saskatchewan"], ["saskatchewan", "Saskatchewan"],
  ["yt", "Yukon"], ["yukon", "Yukon"],
]);

export interface DerivedProfileCountry {
  readonly canonicalValue: "CA";
  readonly visibleOption: "Canada";
}

interface AuthoritativeTextFact {
  readonly factId: string;
  readonly value: string;
  readonly provenance: "owner_provided" | "resume_verified" | "configured_template";
  readonly lane: "live_owner_fact";
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
  const region = normalizeRegion(fact.value);
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
      allowedOptions: [country.visibleOption],
      answer: {
        kind: "answered",
        value: country.canonicalValue,
        provenance: "journey_derived",
        lane: "live_owner_fact",
      },
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
    const visibleOption = CANADIAN_REGIONS.get(normalizeRegion(region.value)) ?? region.value;
    additions.push({
      fieldId: "address.region",
      questionType: "address",
      answerType: "option",
      allowedOptions: [visibleOption],
      answer: {
        kind: "answered",
        value: region.value,
        provenance: region.provenance,
        lane: "live_owner_fact",
      },
      optionMapping: {
        canonicalValue: region.value,
        visibleOption,
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

function normalizeRegion(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim()
    .toLocaleLowerCase("en-US");
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
    allowedOptions: [],
    answer: {
      kind: "answered",
      value: fact.value,
      provenance: fact.provenance,
      lane: "live_owner_fact",
    },
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
      fact.lane === "live_owner_fact" &&
      AUTHORITATIVE_PROVENANCE.has(fact.provenance as AuthoritativeTextFact["provenance"]);
  });
  return matches.length === 1 ? matches[0] : undefined;
}
