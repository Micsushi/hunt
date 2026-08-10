import type {
  ProfileRepeatableSection,
  ProfileUiBehavior,
} from "./types.ts";

export interface ProfileControlCatalogEntry {
  readonly fieldId: string;
  readonly selector: string;
  readonly uiBehavior: ProfileUiBehavior;
  readonly uiVariant: string;
}

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
  ]);

interface RepeatableFieldCatalogEntry {
  readonly fieldId: string;
  readonly suffix: string;
  readonly uiBehavior: ProfileUiBehavior;
  readonly uiVariant: string;
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

const repeatableDate = (fieldId: string, suffix: string): RepeatableFieldCatalogEntry => ({
  fieldId,
  suffix,
  uiBehavior: "date",
  uiVariant: "workday_date_v1",
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
        repeatableText("experience.company", "company"),
        repeatableText("experience.title", "jobTitle"),
        repeatableDate("experience.start_date", "startDate"),
        repeatableDate("experience.end_date", "endDate"),
      ],
    },
    {
      section: "education",
      sectionSelector: '[data-automation-id="educationSection"]',
      rowSelector:
        '[data-row-id], [data-automation-id^="education-"]:not([data-automation-id*="--"])',
      addSelector: '[data-automation-id="addEducation"]',
      fields: [
        repeatableText("education.school", "school"),
        repeatableText("education.degree", "degree"),
        repeatableText("education.field_of_study", "fieldOfStudy"),
        repeatableDate("education.start_date", "startDate"),
        repeatableDate("education.end_date", "endDate"),
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
  ]);
