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

export function deriveProfileCountry(
  facts: readonly unknown[],
): DerivedProfileCountry | undefined {
  const regions = facts.filter((value): value is {
    readonly factId: string;
    readonly value: string;
    readonly provenance: string;
  } => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const fact = value as Record<string, unknown>;
    return fact.factId === "region" && typeof fact.value === "string" &&
      ["owner_provided", "resume_verified", "configured_template"].includes(
        fact.provenance as string,
      );
  });
  if (regions.length !== 1) return undefined;
  const region = regions[0]!.value.normalize("NFC").replace(/\s+/gu, " ").trim()
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
  if (!Array.isArray(facts) || !Array.isArray(fields) || fields.some((field) =>
    typeof field === "object" && field !== null && !Array.isArray(field) &&
    (field as { readonly fieldId?: unknown }).fieldId === "address.country"
  )) return plan;
  const country = deriveProfileCountry(facts);
  if (country === undefined) return plan;
  return {
    ...(plan as Record<string, unknown>),
    fields: [...fields, {
      fieldId: "address.country",
      questionType: "address",
      answerType: "option",
      answer: { kind: "answered", value: country.canonicalValue, provenance: "journey_derived" },
      optionMapping: {
        canonicalValue: country.canonicalValue,
        visibleOption: country.visibleOption,
        provenance: "visible_option",
      },
    }],
  };
}
