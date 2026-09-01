function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

export function profileKnownAliasMatches(
  fieldId: string,
  actual: string,
  expected: string,
): boolean | undefined {
  const pair = new Set([normalized(actual), normalized(expected)]);
  if (fieldId === "phone.device_type") {
    return pair.size === 1 || pair.size === 2 && pair.has("mobile") && pair.has("cell");
  }
  if (fieldId === "source.how_did_you_hear") {
    if (pair.size === 1) return true;
    return pair.size === 2 && pair.has("recruiter") &&
      (pair.has("direct sourcing") || pair.has("recruiter outreach"));
  }
  return undefined;
}
