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
  readonly questionType: ProfileQuestionType;
  readonly answerType: ProfileCanonicalAnswerType;
}

export const profileOwnerInputCatalog: readonly ProfileOwnerInputCatalogEntry[] =
  Object.freeze([
    {
      fieldId: "source.how_did_you_hear",
      questionType: "application_source",
      answerType: "option",
    },
    {
      fieldId: "employment.previously_worked_for_organization",
      questionType: "prior_employment",
      answerType: "option",
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
  selector: [
    `button[id="${id}"][role="combobox"]`,
    `button[id="${id}"][aria-haspopup="listbox"]`,
  ].join(", "),
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
        '[data-automation-id^="formField-source"] button[type="button"][role="combobox"]',
        '[data-automation-id^="formField-source"] button[type="button"][aria-haspopup="listbox"]',
        '[id^="source--"][role="combobox"]:not(button):not(input)',
        'input:not([type])[id^="source--"][role="combobox"]',
        'input[type="text"][id^="source--"][role="combobox"]',
        'input[type="search"][id^="source--"][role="combobox"]',
        'button[type="button"][id^="source--"][role="combobox"]',
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
    v2Text("identity.family_name", "name--legalName--lastName"),
    {
      fieldId: "identity.has_preferred_name",
      selector: 'input[id="name--preferredCheck"][type="checkbox"]',
      uiBehavior: "checkbox",
      uiVariant: "workday_checkbox_v2",
    },
    v2Text("address.line1", "address--addressLine1"),
    v2Text("address.city", "address--city"),
    v2Search("address.country", "country--country"),
    v2Search("address.region", "address--countryRegion"),
    v2Text("address.postal_code", "address--postalCode"),
    v2Text("contact.email", "emailAddress--emailAddress"),
    v2Search("phone.device_type", "phoneNumber--phoneType"),
    v2Text("phone.country_code", "phoneNumber--countryPhoneCode"),
    {
      fieldId: "phone.number",
      selector: 'input[id="phoneNumber--phoneNumber"]',
      uiBehavior: "phone",
      uiVariant: "workday_phone_v2",
    },
    v2Text("phone.extension", "phoneNumber--extension"),
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
