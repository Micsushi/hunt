(function () {
  var root = (window.__huntV2 = window.__huntV2 || {});

  var NON_DISCLOSURE_ALIASES = [
    "I choose not to disclose",
    "Choose not to disclose",
    "Prefer not to disclose",
    "I prefer not to answer",
    "Do not wish to disclose",
    "I do not wish to self-identify",
    "Decline to answer",
    "Not disclosed",
  ];

  function entry(id, config) {
    return Object.assign(
      {
        id: id,
        exactLabels: [],
        aliases: [],
        includeKeywords: [],
        excludeKeywords: [],
        profilePaths: [],
        defaultValue: "",
        answerType: "text",
        optionAliases: {},
      },
      config || {},
    );
  }

  var QUESTION_CATALOG = [
    entry("first_name", {
      aliases: ["first name", "given name", "legal first name"],
      profilePaths: ["firstName"],
    }),
    entry("middle_name", {
      aliases: ["middle name", "legal middle name"],
      profilePaths: ["middleName"],
    }),
    entry("last_name", {
      aliases: ["last name", "surname", "family name", "legal last name"],
      profilePaths: ["lastName"],
    }),
    entry("full_name", {
      aliases: ["full name", "legal name", "candidate name", "applicant name"],
      profilePaths: ["fullName"],
    }),
    entry("email", {
      aliases: ["email", "e-mail", "email address", "contact email"],
      profilePaths: ["email"],
    }),
    entry("phone", {
      aliases: ["phone", "phone number", "mobile", "cell", "telephone"],
      profilePaths: ["phone"],
    }),
    entry("phone_device_type", {
      aliases: ["phone device type", "phone type", "device type"],
      profilePaths: ["phoneDeviceType"],
      defaultValue: "Mobile",
    }),
    entry("phone_country_code", {
      aliases: [
        "phone country code",
        "country phone code",
        "country / territory phone code",
      ],
      profilePaths: ["phoneCountryCode"],
      defaultValue: "Canada (+1)",
      optionAliases: { "Canada (+1)": ["Canada", "+1", "CA +1"] },
    }),
    entry("city", {
      aliases: ["city", "current city", "home city"],
      profilePaths: ["city"],
    }),
    entry("province", {
      aliases: ["province", "state", "territory", "region"],
      profilePaths: ["province"],
    }),
    entry("country", {
      aliases: ["country", "current country"],
      profilePaths: ["country"],
      defaultValue: "Canada",
    }),
    entry("location", {
      aliases: ["location", "current location", "where are you located"],
      profilePaths: ["location"],
    }),
    entry("address_line_1", {
      aliases: ["address line 1", "street address", "address"],
      profilePaths: ["addressLine1"],
    }),
    entry("address_line_2", {
      aliases: ["address line 2", "apartment", "unit"],
      profilePaths: ["addressLine2"],
    }),
    entry("postal_code", {
      aliases: ["postal code", "zip code"],
      profilePaths: ["postalCode"],
    }),
    entry("linkedin", {
      aliases: ["linkedin", "linkedin url", "linkedin profile"],
      profilePaths: ["linkedinUrl"],
    }),
    entry("github", {
      aliases: ["github", "github url", "github profile"],
      profilePaths: ["githubUrl"],
    }),
    entry("website", {
      aliases: ["website", "portfolio", "personal site"],
      profilePaths: ["websiteUrl"],
    }),
    entry("resume_upload", {
      aliases: [
        "resume",
        "cv",
        "resume/cv",
        "upload a file",
        "select files",
        "select file",
        "drop files",
      ],
      defaultValue: "resume_upload",
      answerType: "file",
    }),
    entry("application_source", {
      aliases: ["how did you hear", "source", "application source"],
      profilePaths: [
        "applicationSourceDetail",
        "applicationSource",
        "applicationSourceCategory",
      ],
      defaultValue: "LinkedIn",
    }),
    entry("terms_acceptance", {
      aliases: [
        "terms and conditions",
        "accept terms",
        "accept terms and agreements",
        "read and consent",
        "consent to the terms",
        "accepttermsandagreements",
      ],
      defaultValue: true,
      answerType: "yes_no",
    }),
    entry("work_authorized", {
      aliases: [
        "authorized to work",
        "eligible to work",
        "entitled to work",
        "legally entitled to work",
        "legally authorized",
        "legal right to work",
        "right to work in the country",
        "work authorization",
      ],
      excludeKeywords: ["sponsor", "sponsorship"],
      profilePaths: ["workAuthorized"],
      defaultValue: true,
      answerType: "yes_no",
    }),
    entry("sponsorship_required", {
      aliases: ["sponsor", "sponsorship", "visa support"],
      profilePaths: ["sponsorshipRequired"],
      defaultValue: false,
      answerType: "yes_no",
    }),
    entry("canadian_citizen_pr", {
      aliases: ["canadian citizen", "permanent resident", "citizenship status"],
      profilePaths: ["canadianCitizenOrPermanentResident"],
      answerType: "yes_no",
    }),
    entry("previous_employer", {
      aliases: ["previously worked", "previously employed", "worked at"],
      profilePaths: ["previousEmployers"],
      defaultValue: false,
      answerType: "exact_previous_employer",
    }),
    entry("referral_or_family", {
      aliases: [
        "referral",
        "know anyone",
        "family member",
        "relative",
        "domestic partner",
      ],
      profilePaths: ["familyMemberAtCompany"],
      defaultValue: false,
      answerType: "yes_no",
    }),
    entry("degree_level", {
      aliases: ["degree level", "level of education", "education level"],
      profilePaths: ["degreeLevel"],
    }),
    entry("highest_education", {
      aliases: ["highest education", "highest level of education"],
      profilePaths: ["highestEducation", "degreeLevel"],
    }),
    entry("expected_graduation_year", {
      aliases: ["graduation year", "expected graduation"],
      profilePaths: ["expectedGraduationYear"],
    }),
    entry("salary_expectation", {
      aliases: ["salary", "compensation", "pay expectation"],
      profilePaths: ["salaryExpectationRange", "salaryExpectation"],
      defaultValue: "90,000 - 105,000",
    }),
    entry("disclosure_neutral", {
      aliases: [
        "gender",
        "disability",
        "veteran",
        "visible minority",
        "indigenous",
        "self-identify",
        "diversity",
        "sexual orientation",
      ],
      profilePaths: [
        "disclosureGender",
        "disclosureDisability",
        "disclosureVeteranStatus",
        "disclosureVisibleMinority",
        "disclosureIndigenousIdentity",
        "disclosureLgbqIdentity",
        "disclosureTransExperience",
      ],
      defaultValue: "I choose not to disclose",
      answerType: "non_disclosure",
      optionAliases: { "I choose not to disclose": NON_DISCLOSURE_ALIASES },
    }),
  ];

  root.fieldCatalog = {
    entries: QUESTION_CATALOG,
    nonDisclosureAliases: NON_DISCLOSURE_ALIASES,
  };
})();
