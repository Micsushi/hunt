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
    "Not declared",
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
      exactLabels: ["name"],
      aliases: [
        "full name",
        "legal name",
        "candidate name",
        "applicant name",
        "enter your name",
        "please enter your name",
      ],
      profilePaths: ["fullName"],
    }),
    entry("email", {
      aliases: ["email", "e-mail", "email address", "contact email"],
      profilePaths: ["email"],
    }),
    entry("account_password", {
      aliases: [
        "password",
        "new password",
        "verify new password",
        "confirm password",
      ],
      excludeKeywords: [
        "current password",
        "old password",
        "existing password",
        "temporary password",
      ],
      profilePaths: ["accountPassword"],
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
    entry("workday_system_usage", {
      aliases: [
        "use or work on the workday system",
        "work on the workday system",
        "current job do you use or work",
      ],
      excludeKeywords: ["describe your interactions", "describe interactions"],
      defaultValue: "No, I do not use the Workday system in my current job",
    }),
    entry("truthful_application_acknowledgement", {
      aliases: [
        "please enter yes if you acknowledge",
        "acknowledge that you have read",
        "acknowledge that you understand",
        "truthfully and accurately",
        "information is true",
      ],
      defaultValue: true,
      answerType: "yes_no",
    }),
    entry("identity_verification_upon_hire", {
      aliases: [
        "provide verification of your identity upon hire",
        "provide verification of your identify upon hire",
        "provide proof of identity upon hire",
        "verify your identity upon hire",
        "identity verification upon hire",
      ],
      defaultValue: true,
      answerType: "yes_no",
    }),
    entry("relocation_consideration", {
      aliases: ["would you consider relocating for this role"],
      profilePaths: ["relocationPreference", "willingToRelocate"],
      defaultValue: "I am local to where the job is posted",
    }),
    entry("non_compete_restriction", {
      aliases: [
        "non-compete or non-solicitation restrictions",
        "non compete or non solicitation restrictions",
      ],
      defaultValue: false,
      answerType: "yes_no",
    }),
    entry("us_government_employee", {
      aliases: [
        "current or former employee of the united states government",
        "former employee of the united states government",
      ],
      defaultValue: false,
      answerType: "yes_no",
    }),
    entry("export_control_restricted_region", {
      aliases: [
        "export control laws",
        "current citizen, national or resident",
        "current citizen national or resident",
      ],
      defaultValue: false,
      answerType: "yes_no",
    }),
    entry("related_current_employee", {
      aliases: [
        "related to a current workday employee",
        "related to a current employee",
      ],
      defaultValue: false,
      answerType: "yes_no",
    }),
    entry("related_customer_or_government_official", {
      aliases: [
        "direct business interactions with workday",
        "related to an employee of a customer",
        "related to a government official",
      ],
      defaultValue: false,
      answerType: "yes_no",
    }),
    entry("city", {
      aliases: ["city", "current city", "home city"],
      profilePaths: ["city"],
    }),
    entry("province", {
      aliases: ["province", "state", "province territory", "region"],
      profilePaths: ["province"],
      optionAliases: {
        Alberta: ["AB"],
        "British Columbia": ["BC", "B.C."],
        Manitoba: ["MB"],
        "New Brunswick": ["NB"],
        "Newfoundland and Labrador": ["NL"],
        "Northwest Territories": ["NT"],
        "Nova Scotia": ["NS"],
        Nunavut: ["NU"],
        Ontario: ["ON"],
        "Prince Edward Island": ["PE", "PEI"],
        Quebec: ["QC"],
        Saskatchewan: ["SK"],
        Yukon: ["YT"],
      },
    }),
    entry("country", {
      aliases: [
        "country",
        "current country",
        "country territory",
        "country region",
      ],
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
    entry("technical_skills", {
      aliases: [
        "type to add skills",
        "add skills",
        "skills describe your knowledge",
        "skills",
      ],
      profilePaths: ["skills", "skillList", "technicalSkills"],
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
        "applicationSourceCategory",
        "applicationSource",
        "applicationSourceDetail",
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
        "agree with the terms",
        "agree with the terms and conditions",
        "career privacy notice",
        "privacy notice",
        "agree to the above career privacy notice",
        "by continuing, you agree",
        "check the box to continue",
        "agree to creating this account",
        "creating this account",
        "allow me to apply",
        "account to allow me to apply",
        "accepttermsandagreements",
        "non disclosure agreement",
        "non-disclosure agreement",
        "arbitration agreement",
        "mutual arbitration agreement",
      ],
      defaultValue: true,
      answerType: "yes_no",
    }),
    entry("sms_application_contact_opt_out", {
      aliases: [
        "reach out to me via sms",
        "sms regarding my application",
        "sms regarding my application and candidate experience",
        "message and data rates may apply",
        "i can opt-out at any time",
      ],
      defaultValue: "Opt-Out",
      optionAliases: {
        "Opt-Out": ["Opt-Out", "Opt Out", "OptOut"],
      },
    }),
    entry("automated_ai_processing_opt_out", {
      aliases: [
        "automated tools such as ai",
        "support review of your application",
        "match you with relevant existing and future open roles",
        "prefer not to have your application processed by these tools",
        "opting out will not impact your eligibility",
      ],
      defaultValue: "Opt-Out",
      optionAliases: {
        "Opt-Out": ["Opt-Out", "Opt Out", "OptOut"],
      },
    }),
    entry("current_date", {
      aliases: [
        "today's date",
        "todays date",
        "enter today's date",
        "enter todays date",
        "please enter today's date",
        "please enter todays date",
        "date signed",
        "date signed on",
        "signed on",
      ],
      defaultValue: "today",
    }),
    entry("work_authorized", {
      aliases: [
        "authorized to work",
        "able to legally work",
        "eligible to work",
        "entitled to work",
        "legally entitled to work",
        "legally allowed to work",
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
      aliases: [
        "previously worked",
        "previously employed",
        "previously been employed",
        "previously employed by",
        "ever worked for",
        "worked for",
        "worked at",
        "employee or as a contractor",
        "employee or contractor",
        "current employee",
        "current atco employee",
      ],
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
    entry("background_check_consent", {
      aliases: [
        "willing to complete a background",
        "willing to complete a background security check",
        "willing to complete a criminal background check",
        "able to clear a criminal background check",
        "complete a background security check",
        "complete a background check",
        "clear a criminal background check",
        "criminal record and references",
        "reference check",
      ],
      excludeKeywords: ["convicted", "criminal offence", "criminal offense"],
      defaultValue: true,
      answerType: "yes_no",
    }),
    entry("union_membership", {
      aliases: [
        "member of cewa",
        "cewa",
        "union member",
        "member of a union",
        "member of union",
      ],
      profilePaths: ["cewaMember", "unionMembership"],
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
    entry("desired_start_date", {
      aliases: [
        "desired start date",
        "available start date",
        "available to start",
        "available to start work",
        "date are you available to start work",
        "earliest date that you could start work",
        "earliest date you could start work",
        "could start work",
        "accept a job offer",
        "start work date",
      ],
      profilePaths: ["desiredStartDate"],
      defaultValue: "2026-05-25",
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
