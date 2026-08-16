const reviewedPages = new Set([
  "job_posting",
  "apply_choice",
  "email_sign_in_choice",
  "account_entry",
  "verification_required",
  "verification_navigation",
  "sign_in",
  "password_reset_request",
  "password_reset_email_sent",
  "password_reset_set",
  "application_ready",
  "resume",
  "profile",
  "questionnaire",
  "review",
]);

export function reviewedMonitorStructureId(page: string): string | undefined {
  return reviewedPages.has(page) ? `monitor_structure_${page}_v1` : undefined;
}

export function isReviewedMonitorStructuralIds(
  value: unknown,
  page?: string,
): value is readonly string[] {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") {
    return false;
  }
  if (page !== undefined) return value[0] === reviewedMonitorStructureId(page);
  return [...reviewedPages].some((candidate) =>
    value[0] === reviewedMonitorStructureId(candidate)
  );
}
