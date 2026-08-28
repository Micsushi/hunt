import { createHash } from "node:crypto";

import type { ApplicationProfileFactId } from
  "../../../../form/answers/application-types.ts";
import type {
  ProfileCanonicalAnswerType,
  ProfileQuestionType,
  ProfileRepeatableSection,
  ProfileUiBehavior,
} from "./types.ts";

export interface ProfileControlCatalogEntry {
  readonly fieldId: string;
  readonly selector: string;
  readonly uiBehavior: ProfileUiBehavior;
  readonly uiVariant: string;
}

export interface ProfileOwnerInputCatalogEntry {
  readonly fieldId: string;
  readonly factId: ApplicationProfileFactId;
  readonly questionType: ProfileQuestionType;
  readonly answerType: ProfileCanonicalAnswerType;
  readonly allowedOptions: readonly string[];
}

export interface RetainedProfileControlGuideEntry {
  readonly identity: string;
  readonly sanitizedLabel: string;
  readonly normalizedQuestionType: ProfileQuestionType;
  readonly behavior: "text" | "checkbox" | "search_select" | "multi_select" | "radio";
  readonly answerType: "text" | "url" | "boolean" | "single_select" | "multi_select";
  readonly required: boolean;
  readonly uiVariant: string;
  readonly allowedOptions: readonly string[];
}

export const retainedProfileControlGuide: readonly RetainedProfileControlGuideEntry[] =
  Object.freeze([
    retained("identity.given_name", "First Name", "identity", "text", "text", true, "workday_text_v2"),
    retained("identity.middle_name", "Middle Name", "identity", "text", "text", false, "workday_text_v2"),
    retained("identity.family_name", "Last Name", "identity", "text", "text", true, "workday_text_v2"),
    retained("identity.preferred_name", "Preferred Name", "identity", "text", "text", false, "workday_text_v1"),
    retained("identity.has_preferred_name", "I have a preferred name", "identity", "checkbox", "boolean", false, "workday_checkbox_v2", ["Yes", "No"]),
    retained("address.line1", "Address Line 1", "address", "text", "text", false, "workday_text_v2"),
    retained("address.line2", "Address Line 2", "address", "text", "text", false, "workday_text_v2"),
    retained("address.city", "City", "address", "text", "text", false, "workday_text_v2"),
    retained("address.country", "Country", "address", "search_select", "single_select", true, "workday_search_select_v2"),
    retained("address.region", "Province or Territory", "address", "search_select", "single_select", false, "workday_search_select_v2"),
    retained("address.postal_code", "Postal Code", "address", "text", "text", false, "workday_text_v2"),
    retained("contact.email", "Email", "identity", "text", "text", true, "workday_text_v2"),
    retained("phone.device_type", "Phone Device Type", "phone", "search_select", "single_select", true, "workday_search_select_v2"),
    retained("phone.country_code", "Country Phone Code", "phone", "search_select", "single_select", true, "workday_search_select_v2"),
    retained("phone.number", "Phone Number", "phone", "text", "text", true, "workday_phone_v2"),
    retained("phone.extension", "Phone Extension", "phone", "text", "text", false, "workday_text_v2"),
    retained("source.how_did_you_hear", "How Did You Hear About Us?", "application_source", "search_select", "single_select", true, "workday_source_select_v1"),
    retained("employment.previously_worked_for_organization", "Have you previously worked for this organization? If Yes, please answer the questions below. If No, please continue to the next page.", "prior_employment", "radio", "single_select", true, "workday_previous_worker_radio_v1", ["Yes", "No"]),
    retained("skills.values", "Type to Add Skills", "skill", "multi_select", "multi_select", false, "workday_multi_select_v1"),
    retained("social.linkedin", "LinkedIn", "social_network", "text", "url", false, "workday_text_v2"),
    retained("social.facebook", "Facebook", "social_network", "text", "text", false, "workday_text_v2"),
    retained("social.twitter", "Twitter", "social_network", "text", "text", false, "workday_text_v2"),
    retained("social.github", "GitHub", "social_network", "text", "text", false, "workday_text_v2"),
    retained("website.portfolio", "Portfolio Website", "website", "text", "text", false, "workday_text_v2"),
  ]);

const retainedProfileSanitizedLabelAliases: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "employment.previously_worked_for_organization": Object.freeze([
      "Have you previously worked for our company (this does not apply to contingent/contract work)?",
      "Have you previously been employed with Intermountain Health, SelectHealth, Intermountain Nevada, Intermountain Ventures, Castell, Tellica Imaging, Saltzer Health, an Intermountain Health company, Classic Air, an Intermountain Health company, or SCL Health, an Intermountain Health company? If No, please continue to the next page. If Yes, please enter additional information related to your previous employment. Note: If you are a current employee, please apply via your internal career account.",
    ]),
  });

export function retainedProfileTextSha256(value: string): string {
  return createHash("sha256").update(
    value.normalize("NFC").replace(/[\u2018\u2019\u02bc]/gu, "'")
      .replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US"),
    "utf8",
  ).digest("hex");
}

export function retainedProfileLabelSha256Matches(
  identity: string,
  observedSha256: string | null,
): boolean {
  if (observedSha256 === null) return false;
  const guide = retainedProfileControlGuide.find((entry) => entry.identity === identity);
  if (guide === undefined) return false;
  const labels = [
    guide.sanitizedLabel,
    ...(retainedProfileSanitizedLabelAliases[identity] ?? []),
  ];
  return labels.some((label) => retainedProfileTextSha256(label) === observedSha256);
}

function retained(
  identity: string,
  sanitizedLabel: string,
  normalizedQuestionType: ProfileQuestionType,
  behavior: RetainedProfileControlGuideEntry["behavior"],
  answerType: RetainedProfileControlGuideEntry["answerType"],
  required: boolean,
  uiVariant: string,
  allowedOptions: readonly string[] = [],
): RetainedProfileControlGuideEntry {
  return Object.freeze({
    identity,
    sanitizedLabel,
    normalizedQuestionType,
    behavior,
    answerType,
    required,
    uiVariant,
    allowedOptions: Object.freeze([...allowedOptions]),
  });
}

export const profileOwnerInputCatalog: readonly ProfileOwnerInputCatalogEntry[] =
  Object.freeze([
    {
      fieldId: "source.how_did_you_hear",
      factId: "application_source",
      questionType: "application_source",
      answerType: "option",
      allowedOptions: Object.freeze([]),
    },
    {
      fieldId: "employment.previously_worked_for_organization",
      factId: "previously_worked_for_organization",
      questionType: "prior_employment",
      answerType: "option",
      allowedOptions: Object.freeze(["Yes", "No"]),
    },
  ]);

export const profileRequiredControlSelector = [
  "input[required]",
  'input[aria-required="true"]',
  "textarea[required]",
  'textarea[aria-required="true"]',
  "select[required]",
  'select[aria-required="true"]',
  '[role][aria-required="true"]',
  '[contenteditable="true"][aria-required="true"]',
].join(", ");

export const profileInteractiveControlSelector = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
  "textarea",
  "select",
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="radiogroup"]',
  '[role="listbox"][aria-multiselectable="true"]',
  '[contenteditable="true"]',
  'button[aria-haspopup="listbox"]',
].join(", ");

const text = (fieldId: string, automationId: string): ProfileControlCatalogEntry => ({
  fieldId,
  selector: `[data-automation-id="${automationId}"]`,
  uiBehavior: "text",
  uiVariant: "workday_text_v1",
});

const search = (fieldId: string, automationId: string): ProfileControlCatalogEntry => ({
  fieldId,
  selector: `[data-automation-id="${automationId}"]`,
  uiBehavior: "search_select",
  uiVariant: "workday_search_select_v1",
});

const v2Text = (fieldId: string, id: string): ProfileControlCatalogEntry => ({
  fieldId,
  selector: `[id="${id}"]`,
  uiBehavior: "text",
  uiVariant: "workday_text_v2",
});

const v2Search = (fieldId: string, id: string): ProfileControlCatalogEntry => ({
  fieldId,
  selector: `button[id="${id}"], button[data-automation-id="${id}"]`,
  uiBehavior: "search_select",
  uiVariant: "workday_search_select_v2",
});

export const profileScalarControlCatalog: readonly ProfileControlCatalogEntry[] =
  Object.freeze([
    text("identity.given_name", "legalNameSection_firstName"),
    text("identity.family_name", "legalNameSection_lastName"),
    text("identity.preferred_name", "preferredNameSection_preferredName"),
    text("address.line1", "addressSection_addressLine1"),
    text("address.city", "addressSection_city"),
    search("address.country", "addressSection_countryRegion"),
    search("address.region", "addressSection_regionSubdivision1"),
    text("address.postal_code", "addressSection_postalCode"),
    search("phone.country_code", "phone-country-code"),
    {
      fieldId: "phone.number",
      selector: '[data-automation-id="phone-number"]',
      uiBehavior: "phone",
      uiVariant: "workday_phone_v1",
    },
    {
      fieldId: "source.how_did_you_hear",
      selector: [
        '[data-automation-id="sourcePrompt"]:not(button):not(input)',
        'input:not([type])[data-automation-id="sourcePrompt"]',
        'input[type="text"][data-automation-id="sourcePrompt"]',
        'input[type="search"][data-automation-id="sourcePrompt"]',
        'button[type="button"][data-automation-id="sourcePrompt"]',
        '[data-automation-id^="formField-source"] [role="combobox"]:not(button):not(input)',
        '[data-automation-id^="formField-source"] input:not([type])[role="combobox"]',
        '[data-automation-id^="formField-source"] input[type="text"][role="combobox"]',
        '[data-automation-id^="formField-source"] input[type="search"][role="combobox"]',
        '[data-automation-id^="formField-source"] input:not([type])[id^="source--"]',
        '[data-automation-id^="formField-source"] input[type="text"][id^="source--"]',
        '[data-automation-id^="formField-source"] button[type="button"][role="combobox"]',
        '[data-automation-id^="formField-source"] button[type="button"][aria-haspopup="listbox"]',
        '[id^="source--"][role="combobox"]:not(button):not(input)',
        'input:not([type])[id^="source--"][role="combobox"]',
        'input[type="text"][id^="source--"][role="combobox"]',
        'input[type="search"][id^="source--"][role="combobox"]',
        'button[type="button"][id^="source--"][role="combobox"]',
        'button[type="button"][id^="source--"][aria-haspopup="listbox"]',
      ].join(", "),
      uiBehavior: "search_select",
      uiVariant: "workday_source_select_v1",
    },
    {
      fieldId: "employment.previously_worked_for_organization",
      selector: 'input[name="candidateIsPreviousWorker"]',
      uiBehavior: "radio_group",
      uiVariant: "workday_previous_worker_radio_v1",
    },
    v2Text("identity.given_name", "name--legalName--firstName"),
    v2Text("identity.middle_name", "name--legalName--middleName"),
    v2Text("identity.family_name", "name--legalName--lastName"),
    {
      fieldId: "identity.has_preferred_name",
      selector: 'input[id="name--preferredCheck"][type="checkbox"]',
      uiBehavior: "checkbox",
      uiVariant: "workday_checkbox_v2",
    },
    v2Text("address.line1", "address--addressLine1"),
    v2Text("address.line2", "address--addressLine2"),
    {
      fieldId: "address.city",
      selector: '[id="address--city"], [id="addresss--city"]',
      uiBehavior: "text",
      uiVariant: "workday_text_v2",
    },
    v2Search("address.country", "country--country"),
    v2Search("address.region", "address--countryRegion"),
    v2Text("address.postal_code", "address--postalCode"),
    v2Text("contact.email", "emailAddress--emailAddress"),
    v2Search("phone.device_type", "phoneNumber--phoneType"),
    {
      fieldId: "phone.country_code",
      selector: 'input[id="phoneNumber--countryPhoneCode"]',
      uiBehavior: "search_select",
      uiVariant: "workday_search_select_v2",
    },
    {
      fieldId: "phone.number",
      selector: 'input[id="phoneNumber--phoneNumber"]',
      uiBehavior: "phone",
      uiVariant: "workday_phone_v2",
    },
    v2Text("phone.extension", "phoneNumber--extension"),
    {
      fieldId: "skills.values",
      selector: 'input[id="skills--skills"]',
      uiBehavior: "multi_select",
      uiVariant: "workday_multi_select_v1",
    },
    v2Text("social.linkedin", "socialNetworkAccounts--linkedInAccount"),
    v2Text("social.facebook", "socialNetworkAccounts--facebookAccount"),
    v2Text("social.twitter", "socialNetworkAccounts--twitterAccount"),
    {
      fieldId: "social.github",
      selector: [
        '[id="socialNetworkAccounts--githubAccount"]',
        '[id="socialNetworkAccounts--github"]',
      ].join(", "),
      uiBehavior: "text",
      uiVariant: "workday_text_v2",
    },
    {
      fieldId: "website.portfolio",
      selector: [
        '[id="socialNetworkAccounts--portfolioAccount"]',
        '[id="socialNetworkAccounts--portfolio"]',
        '[id="socialNetworkAccounts--portfolioURL"]',
      ].join(", "),
      uiBehavior: "text",
      uiVariant: "workday_text_v2",
    },
  ]);

interface RepeatableFieldCatalogEntry {
  readonly fieldId: string;
  readonly suffix: string;
  readonly uiBehavior: ProfileUiBehavior;
  readonly uiVariant: string;
  readonly indexed?: boolean;
}

export interface ProfileRepeatableCatalogEntry {
  readonly section: ProfileRepeatableSection;
  readonly sectionSelector: string;
  readonly rowSelector: string;
  readonly addSelector: string;
  readonly fields: readonly RepeatableFieldCatalogEntry[];
}

const repeatableText = (fieldId: string, suffix: string): RepeatableFieldCatalogEntry => ({
  fieldId,
  suffix,
  uiBehavior: "text",
  uiVariant: "workday_text_v1",
});

const repeatable = (
  fieldId: string,
  suffix: string,
  uiBehavior: ProfileUiBehavior,
  uiVariant: string,
): RepeatableFieldCatalogEntry => ({ fieldId, suffix, uiBehavior, uiVariant });

const legacyRepeatable = (
  fieldId: string,
  suffix: string,
  uiBehavior: ProfileUiBehavior,
  uiVariant: string,
): RepeatableFieldCatalogEntry => ({
  fieldId,
  suffix,
  uiBehavior,
  uiVariant,
  indexed: false,
});

export const profileRepeatableCatalog: readonly ProfileRepeatableCatalogEntry[] =
  Object.freeze([
    {
      section: "experience",
      sectionSelector: '[data-automation-id="workExperienceSection"]',
      rowSelector:
        '[data-row-id], [data-automation-id^="workExperience-"]:not([data-automation-id*="--"])',
      addSelector: '[data-automation-id="addWorkExperience"]',
      fields: [
        repeatableText("experience.company", "companyName"),
        legacyRepeatable("experience.company", "company", "text", "workday_text_v1"),
        repeatableText("experience.title", "jobTitle"),
        repeatableText("experience.location", "location"),
        repeatable("experience.current", "currentlyWorkHere", "checkbox", "workday_checkbox_v2"),
        repeatable("experience.start_month", "startDate-dateSectionMonth-input", "month", "workday_month_v1"),
        repeatable("experience.start_year", "startDate-dateSectionYear-input", "year", "workday_year_v1"),
        repeatable("experience.end_month", "endDate-dateSectionMonth-input", "month", "workday_month_v1"),
        repeatable("experience.end_year", "endDate-dateSectionYear-input", "year", "workday_year_v1"),
        repeatable("experience.description", "roleDescription", "textarea", "workday_textarea_v1"),
        legacyRepeatable("experience.start_date", "startDate", "date", "workday_date_v1"),
        legacyRepeatable("experience.end_date", "endDate", "date", "workday_date_v1"),
      ],
    },
    {
      section: "education",
      sectionSelector: '[data-automation-id="educationSection"]',
      rowSelector:
        '[data-row-id], [data-automation-id^="education-"]:not([data-automation-id*="--"])',
      addSelector: '[data-automation-id="addEducation"]',
      fields: [
        repeatableText("education.school", "schoolName"),
        legacyRepeatable("education.school", "school", "text", "workday_text_v1"),
        repeatable("education.degree", "degree", "select", "workday_select_v1"),
        repeatable("education.field_of_study", "fieldOfStudy", "multi_select", "workday_multi_select_v1"),
        repeatable("education.gpa", "gradeAverage", "number", "workday_number_v1"),
        repeatable("education.start_year", "firstYearAttended-dateSectionYear-input", "year", "workday_year_v1"),
        repeatable("education.end_year", "lastYearAttended-dateSectionYear-input", "year", "workday_year_v1"),
        legacyRepeatable("education.start_date", "startDate", "date", "workday_date_v1"),
        legacyRepeatable("education.end_date", "endDate", "date", "workday_date_v1"),
      ],
    },
    {
      section: "skills",
      sectionSelector: '[data-automation-id="skillsSection"]',
      rowSelector:
        '[data-row-id], [data-automation-id^="skills-"]:not([data-automation-id*="--"])',
      addSelector: '[data-automation-id="addSkill"]',
      fields: [{
        fieldId: "skills.name",
        suffix: "name",
        uiBehavior: "search_select",
        uiVariant: "workday_search_select_v1",
      }],
    },
    {
      section: "websites",
      sectionSelector: [
        '[data-automation-id="websitesSection"]',
        '[data-automation-id="websiteSection"]',
      ].join(", "),
      rowSelector: [
        '[data-row-id]',
        '[data-automation-id^="websites-"]:not([data-automation-id*="--"])',
        '[data-automation-id^="website-"]:not([data-automation-id*="--"])',
      ].join(", "),
      addSelector: '[data-automation-id="addWebsite"]',
      fields: [
        repeatableText("website.url", "website"),
        repeatableText("website.url", "url"),
      ],
    },
  ]);
