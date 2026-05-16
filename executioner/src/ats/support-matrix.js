export const ATS_SUPPORT_MATRIX = [
  {
    name: "workday",
    hostPatterns: ["workday.com", "myworkdayjobs.com"],
    supportLevel: "dedicated_adapter",
    adapter: "workday",
    notes:
      "Dedicated adapter for Workday fields, widgets, uploads, and multi-step hardening.",
  },
  {
    name: "greenhouse",
    hostPatterns: [
      "boards.greenhouse.io",
      "job-boards.greenhouse.io",
      "app.greenhouse.io",
    ],
    embeddedSelectors: ["#grnhse_app", 'iframe[src*="greenhouse.io"]'],
    supportLevel: "generic_backed_adapter",
    adapter: "greenhouse",
    notes:
      "Generic-backed adapter with iframe detection for hosted Greenhouse embeds such as Hootsuite.",
  },
  {
    name: "lever",
    hostPatterns: ["jobs.lever.co"],
    supportLevel: "generic_backed_adapter",
    adapter: "lever",
    notes:
      "Generic-backed adapter for simple Lever forms and canonical field names.",
  },
  {
    name: "ashby",
    hostPatterns: ["jobs.ashbyhq.com", "ashbyhq.com"],
    embeddedSelectors: ['iframe[src*="ashbyhq.com"]'],
    supportLevel: "generic_backed_adapter",
    adapter: "ashby",
    notes:
      "Generic-backed adapter for Ashby direct and embedded forms until fixture-smoked.",
  },
  {
    name: "smartrecruiters",
    hostPatterns: ["jobs.smartrecruiters.com", "smartrecruiters.com"],
    supportLevel: "generic_backed_adapter",
    adapter: "smartrecruiters",
    notes: "Generic-backed adapter for common SmartRecruiters pages.",
  },
  {
    name: "workable",
    hostPatterns: ["apply.workable.com", "workable.com"],
    supportLevel: "generic_backed_adapter",
    adapter: "workable",
    notes: "Generic-backed adapter for Workable apply pages.",
  },
  {
    name: "icims",
    hostPatterns: ["icims.com"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "Enterprise ATS detection only until fixture/live smoke exists.",
  },
  {
    name: "bamboohr",
    hostPatterns: ["bamboohr.com"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "Detection only until adapter support is proven.",
  },
  {
    name: "jobvite",
    hostPatterns: ["jobvite.com"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "Detection only until adapter support is proven.",
  },
  {
    name: "taleo",
    hostPatterns: ["taleo.net"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "Older enterprise portal detection only.",
  },
  {
    name: "oracle",
    hostPatterns: ["oraclecloud.com"],
    supportLevel: "generic_backed_adapter",
    adapter: "oracle",
    notes:
      "Generic-backed adapter for Oracle Recruiting / Candidate Experience flows such as email auth and profile forms.",
  },
  {
    name: "adp",
    hostPatterns: ["workforcenow.adp.com"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "ADP Workforce Now detection only.",
  },
  {
    name: "ukg",
    hostPatterns: ["ultipro.com", "ukg.com"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "UKG and UltiPro detection only.",
  },
  {
    name: "breezy",
    hostPatterns: ["breezy.hr"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "Detection only until adapter support is proven.",
  },
  {
    name: "jazzhr",
    hostPatterns: ["applytojob.com", "jazzhr.com"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "JazzHR detection only.",
  },
  {
    name: "recruitee",
    hostPatterns: ["recruitee.com"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "Detection only until adapter support is proven.",
  },
  {
    name: "pinpoint",
    hostPatterns: ["pinpointhq.com"],
    supportLevel: "detected_only",
    adapter: "",
    notes: "Detection only until adapter support is proven.",
  },
];

export function atsNamesWithAdapters() {
  return ATS_SUPPORT_MATRIX.filter((entry) => entry.adapter).map(
    (entry) => entry.name,
  );
}

export function genericBackedAtsNames() {
  return ATS_SUPPORT_MATRIX.filter(
    (entry) => entry.supportLevel === "generic_backed_adapter",
  ).map((entry) => entry.name);
}
