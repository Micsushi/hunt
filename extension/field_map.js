const FIELD_MAP = {
  email:          ["email", "e-mail", "email_address", "emailaddress", "user_email", "applicant_email"],
  phone:          ["phone", "telephone", "mobile", "cell", "phone_number", "phonenumber", "tel"],
  firstName:      ["first_name", "firstname", "fname", "given_name", "givenname", "first"],
  lastName:       ["last_name", "lastname", "lname", "surname", "family_name", "familyname", "last"],
  fullName:       ["full_name", "fullname", "name", "your_name", "applicant_name", "candidate_name"],
  address:        ["address", "street", "address_line", "street_address", "address1", "address_line_1"],
  city:           ["city", "town", "municipality"],
  province:       ["state", "province", "region", "state_province"],
  postalCode:     ["zip", "postal", "zip_code", "postal_code", "zipcode", "postalcode"],
  country:        ["country", "nation", "country_name"],
  linkedin:       ["linkedin", "linked_in", "linkedin_url", "linkedin_profile"],
  github:         ["github", "git_hub", "github_url", "github_profile"],
  portfolio:      ["portfolio", "website", "personal_website", "url", "personal_url", "homepage"],
  school:         ["school", "university", "college", "institution", "school_name", "education_institution"],
  degree:         ["degree", "education_level", "degree_type", "education_degree"],
  fieldOfStudy:   ["major", "field_of_study", "discipline", "program", "area_of_study", "concentration"],
  gpa:            ["gpa", "grade", "cgpa", "grade_point"],
  graduationDate: ["graduation", "grad_date", "expected_graduation", "graduation_date", "graduation_year"],
  salary:         ["salary", "compensation", "desired_salary", "expected_salary", "salary_expectation"],
  startDate:      ["start_date", "available_date", "availability", "earliest_start", "available_start"],
  jobTitle:       ["current_title", "job_title", "current_job_title", "position_title"],
  company:        ["current_company", "current_employer", "employer", "company_name"],
};

const LABEL_KEYWORDS = {
  email:          ["email address", "e-mail", "email"],
  phone:          ["phone number", "telephone", "mobile number", "cell phone", "phone"],
  firstName:      ["first name", "given name"],
  lastName:       ["last name", "surname", "family name"],
  fullName:       ["full name", "your name", "name"],
  address:        ["street address", "address line", "mailing address", "address"],
  city:           ["city", "town"],
  province:       ["state", "province", "state/province"],
  postalCode:     ["zip code", "postal code", "zip/postal"],
  country:        ["country"],
  linkedin:       ["linkedin"],
  github:         ["github"],
  portfolio:      ["portfolio", "website", "personal website"],
  school:         ["school", "university", "college", "institution"],
  degree:         ["degree", "education level"],
  fieldOfStudy:   ["major", "field of study", "area of study"],
  gpa:            ["gpa", "grade point"],
  graduationDate: ["graduation date", "expected graduation", "graduation year"],
  salary:         ["desired salary", "salary expectation", "expected compensation"],
  startDate:      ["start date", "available date", "earliest start date", "availability"],
  jobTitle:       ["current title", "job title"],
  company:        ["current company", "current employer"],
};

const FILE_FIELDS = {
  resume:      ["resume", "cv", "curriculum_vitae", "resume_upload"],
  coverLetter: ["cover_letter", "coverletter", "cover", "cover_letter_upload"],
};

function getFieldLabel(field) {
  if (field.id) {
    const label = document.querySelector(`label[for="${field.id}"]`);
    if (label) return label.textContent.trim().toLowerCase();
  }

  const parent = field.closest("label");
  if (parent) return parent.textContent.trim().toLowerCase();

  const ariaLabel = field.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim().toLowerCase();

  const ariaLabelledBy = field.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    const el = document.getElementById(ariaLabelledBy);
    if (el) return el.textContent.trim().toLowerCase();
  }

  return "";
}

function detectFieldType(field) {
  const attrs = [
    field.getAttribute("name"),
    field.getAttribute("id"),
    field.getAttribute("placeholder"),
    field.getAttribute("aria-label"),
    field.getAttribute("autocomplete"),
    field.getAttribute("data-automation-id"),
  ]
    .filter(Boolean)
    .map((a) => a.toLowerCase());

  const label = getFieldLabel(field);

  for (const [fieldType, keywords] of Object.entries(FIELD_MAP)) {
    for (const kw of keywords) {
      for (const attr of attrs) {
        if (attr.includes(kw)) return fieldType;
      }
    }
  }

  for (const [fieldType, keywords] of Object.entries(LABEL_KEYWORDS)) {
    for (const kw of keywords) {
      if (label.includes(kw)) return fieldType;
    }
  }

  return null;
}

function detectFileFieldType(field) {
  if (field.type !== "file") return null;

  const attrs = [
    field.getAttribute("name"),
    field.getAttribute("id"),
    field.getAttribute("aria-label"),
    field.getAttribute("accept"),
  ]
    .filter(Boolean)
    .map((a) => a.toLowerCase());

  const label = getFieldLabel(field);

  for (const [fileType, keywords] of Object.entries(FILE_FIELDS)) {
    for (const kw of keywords) {
      for (const attr of attrs) {
        if (attr.includes(kw)) return fileType;
      }
      if (label.includes(kw)) return fileType;
    }
  }

  if (label.includes("upload") || label.includes("attach")) return "resume";

  return null;
}
