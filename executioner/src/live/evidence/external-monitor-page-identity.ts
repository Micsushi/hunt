export interface ObservedOwnedControlStructure {
  readonly actionFlags: ReadonlySet<string>;
  readonly editFlags: ReadonlySet<string>;
}

export interface ObservedStageCounts {
  readonly myInformation: number;
  readonly myExperience: number;
  readonly applicationQuestions: number;
  readonly voluntaryDisclosures: number;
  readonly selfIdentify: number;
  readonly review: number;
}

export function observedStructurePage(
  flags: ReadonlySet<string>,
  activeStageTitles: readonly string[] = [],
  owned: ObservedOwnedControlStructure = inferredOwnedStructure(flags),
): string {
  const activeApplicationPage = observedActiveApplicationPage(flags, activeStageTitles);
  if (owned.actionFlags.has("Sign In") &&
      (owned.editFlags.has("Password") || flags.has("Forgot your password?"))) {
    return "sign_in";
  }
  if (activeApplicationPage !== undefined &&
      (owned.actionFlags.has("Next") || owned.actionFlags.has("Save and Continue"))) {
    return activeApplicationPage;
  }
  if (owned.actionFlags.has("Create Account") || flags.has("Create Account")) {
    return "account_entry";
  }
  if (observedSubmitPresent(owned) && flags.has("Review")) return "review";
  if (flags.has("Reset Password")) return "password_reset_set";
  if (flags.has("Send Verification Email")) return "verification_required";
  if (flags.has("Forgot Password")) return "password_reset_request";
  if (flags.has("Sign in with email")) return "email_sign_in_choice";
  if (activeApplicationPage !== undefined) return activeApplicationPage;
  if (flags.has("Application Questions") || flags.has("Voluntary Disclosures") ||
      flags.has("Self Identify")) return "questionnaire";
  if (flags.has("Upload a resume") || flags.has("Upload Resume") ||
      flags.has("Resume, Cover Letter and References") ||
      flags.has("Upload a file (5MB max)")) return "resume";
  if (flags.has("My Information") || flags.has("My Experience")) return "profile";
  if (owned.actionFlags.has("Apply Manually") || flags.has("Apply Manually")) {
    return "apply_choice";
  }
  if (owned.actionFlags.has("Apply") || owned.actionFlags.has("Apply Now") ||
      flags.has("Apply") || flags.has("Apply Now")) return "job_posting";
  if (owned.actionFlags.has("Sign In") || flags.has("Sign In")) return "account_entry";
  denied();
}

export function observedSubmitPresent(owned: ObservedOwnedControlStructure): boolean {
  return owned.actionFlags.has("Submit") || owned.actionFlags.has("Submit application");
}

export function observedStructureIdentityTitles(
  page: string,
  _flags: ReadonlySet<string>,
  activeStageTitles: readonly string[] = [],
): readonly string[] {
  const titles = page === "profile"
    ? ["My Information", "My Experience"]
    : page === "questionnaire"
      ? ["Application Questions", "Voluntary Disclosures", "Self Identify"]
      : page === "review" ? ["Review"] : [];
  const active = new Set(activeStageTitles);
  return Object.freeze(titles.filter((title) => active.has(title)));
}

export function observedActiveStageTitles(counts: ObservedStageCounts): readonly string[] {
  const entries = [
    ["My Information", counts.myInformation],
    ["My Experience", counts.myExperience],
    ["Application Questions", counts.applicationQuestions],
    ["Voluntary Disclosures", counts.voluntaryDisclosures],
    ["Self Identify", counts.selfIdentify],
    ["Review", counts.review],
  ] as const;
  const maximum = Math.max(...entries.map(([, count]) => count));
  if (maximum < 2) return Object.freeze([]);
  const titles = entries.filter(([, count]) => count === maximum).map(([title]) => title);
  return Object.freeze(titles.length === 1 ? titles : []);
}

function observedActiveApplicationPage(
  flags: ReadonlySet<string>,
  activeStageTitles: readonly string[],
): string | undefined {
  if (activeStageTitles.length !== 1) return undefined;
  const active = activeStageTitles[0]!;
  if (["Application Questions", "Voluntary Disclosures", "Self Identify"].includes(active)) {
    return "questionnaire";
  }
  if (active === "My Experience" &&
      (flags.has("Upload a resume") || flags.has("Upload Resume") ||
        flags.has("Resume, Cover Letter and References") ||
        flags.has("Upload a file (5MB max)"))) return "resume";
  if (active === "My Information" || active === "My Experience") return "profile";
  return undefined;
}

function inferredOwnedStructure(flags: ReadonlySet<string>): ObservedOwnedControlStructure {
  const actions = [
    "Apply", "Apply Now", "Apply Manually", "Create Account", "Sign In", "Next",
    "Save and Continue", "Submit", "Submit application",
  ];
  const edits = ["Email Address", "Password"];
  return Object.freeze({
    actionFlags: new Set(actions.filter((value) => flags.has(value))),
    editFlags: new Set(edits.filter((value) => flags.has(value))),
  });
}

function denied(): never {
  throw new TypeError("external monitor observer denied");
}
