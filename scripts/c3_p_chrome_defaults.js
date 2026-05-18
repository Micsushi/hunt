"use strict";

const DEFAULT_ACCOUNT_EMAIL = "hunt.executioner.test@gmail.com";
const DEFAULT_ACCOUNT_PASSWORD =
  process.env.HUNT_C3_TEST_ACCOUNT_PASSWORD || "Hunt12345678!";

function makeDefaultWorkExperience() {
  return {
    jobTitle: "Software Developer Intern",
    company: "INVIDI Technologies",
    location: "Edmonton, Alberta, Canada",
    startMonth: "05",
    startYear: "2025",
    endMonth: "08",
    endYear: "2025",
    current: false,
    description:
      "Built browser automation, data tooling, and production software features.",
  };
}

function makeDefaultEducation() {
  return {
    school: "University of Alberta",
    degree: "Bachelor's Degree",
    degreeLevel: "Bachelors",
    fieldOfStudy: "Computer Science",
    startMonth: "09",
    startYear: "2021",
    endMonth: "04",
    endYear: "2026",
    overallResult: "3.7",
  };
}

function makeWorkdayProfileDefaults(options = {}) {
  const accountEmail = options.accountEmail || DEFAULT_ACCOUNT_EMAIL;
  const accountPassword = options.accountPassword || DEFAULT_ACCOUNT_PASSWORD;
  return {
    fullName: "Michael Shi",
    email: accountEmail,
    accountEmail,
    accountPassword,
    phone: "7804923111",
    phoneDeviceType: "Mobile",
    phoneCountryCode: "Canada (+1)",
    location: "Edmonton, Alberta, Canada",
    city: "Edmonton",
    province: "Alberta",
    country: "Canada",
    addressLine1: "10180 101 Street NW",
    addressLine2: "",
    postalCode: "T5J 3S4",
    linkedinUrl: "https://linkedin.com/in/wjshi",
    githubUrl: "https://github.com/micsushi",
    websiteUrl: "https://mshi.ca",
    applicationSource: "Job Board",
    applicationSourceCategory: "Job Board",
    applicationSourceDetail: "LinkedIn",
    workAuthorized: true,
    canadianCitizenOrPermanentResident: "yes",
    sinStartsWithNine: "no",
    sinExpiryDate: "",
    interestedTemporaryShortContract: "yes",
    employmentStatusDesired: "Temporary",
    sponsorshipRequired: false,
    willingToRelocate: true,
    openToAnyLocation: true,
    salaryFlexible: true,
    familyMemberAtCompany: "No",
    reliabilityStatusClearance:
      "Yes, I meet the requirements to obtain Reliability Status Clearance.",
    previousDeloitteErnstYoung:
      "No, I have not worked at either Deloitte LLP or Ernst & Young.",
    languageSkillsStatement: "I am fluent in English only",
    salaryExpectationRange: "90,000 - 105,000",
    salaryExpectation: "95000",
    desiredStartDate: "2026-05-25",
    coOpTermsCompleted: "2",
    availableSummer2026: "Yes",
    availableInterviewWindow: "Yes",
    expectedGraduationYear: "2026",
    previousEmployers: "",
    relativesCurrentlyEmployed: "no",
    criminalConvictionUnpardoned: "no",
    openWorkPermit: "no",
    disclosureGender: "",
    disclosureTransExperience: "",
    disclosureLgbqIdentity: "",
    disclosureDisability: "",
    disclosureIndigenousIdentity: "",
    disclosureVisibleMinority: "",
    disclosureVeteranStatus: "",
    skills: ["Python", "React"],
    workExperience: [makeDefaultWorkExperience()],
    education: [makeDefaultEducation()],
    websites: [
      "https://mshi.ca",
      "https://linkedin.com/in/wjshi",
      "https://github.com/micsushi",
    ],
    notes: "",
  };
}

function withWorkdayProfileAliases(profile) {
  const source = { ...profile };
  const work = Array.isArray(source.workExperience)
    ? source.workExperience
    : [];
  const education = Array.isArray(source.education) ? source.education : [];
  const skills = Array.isArray(source.skills) ? source.skills : [];
  const websites = Array.isArray(source.websites) ? source.websites : [];
  return {
    ...source,
    skillList: skills,
    pastJobs: work.map((entry) => ({
      title: entry.jobTitle,
      employer: entry.company,
      location: entry.location,
      startMonth: entry.startMonth,
      startYear: entry.startYear,
      endMonth: entry.endMonth,
      endYear: entry.endYear,
      current: entry.current,
      description: entry.description,
    })),
    employmentHistory: work.map((entry) => ({
      position: entry.jobTitle,
      companyName: entry.company,
      location: entry.location,
      fromMonth: entry.startMonth,
      fromYear: entry.startYear,
      toMonth: entry.endMonth,
      toYear: entry.endYear,
      description: entry.description,
    })),
    educationHistory: education.map((entry) => ({
      university: entry.school,
      credential: entry.degree,
      degreeLevel: entry.degreeLevel,
      fieldOfStudy: entry.fieldOfStudy,
      startMonth: entry.startMonth,
      startYear: entry.startYear,
      endMonth: entry.endMonth,
      endYear: entry.endYear,
      overallResult: entry.overallResult,
    })),
    links: websites,
  };
}

function workdayProfileCounts(profile) {
  return {
    workExperience: Array.isArray(profile.workExperience)
      ? profile.workExperience.length
      : 0,
    education: Array.isArray(profile.education) ? profile.education.length : 0,
    skills: Array.isArray(profile.skills) ? profile.skills.length : 0,
    websites: Array.isArray(profile.websites)
      ? profile.websites.length
      : [profile.websiteUrl, profile.linkedinUrl, profile.githubUrl].filter(
          Boolean,
        ).length,
    languages: Array.isArray(profile.languages) ? profile.languages.length : 0,
  };
}

module.exports = {
  DEFAULT_ACCOUNT_EMAIL,
  DEFAULT_ACCOUNT_PASSWORD,
  makeWorkdayProfileDefaults,
  withWorkdayProfileAliases,
  workdayProfileCounts,
};
