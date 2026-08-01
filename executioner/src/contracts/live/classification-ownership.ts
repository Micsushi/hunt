export const liveClassificationOwnership = [
  {
    contract: "AtsFamilyClassifier",
    owner: "F5",
    consumers: ["F9 live coordinator", "WorkdayPageTypeClassifier"],
    mutability: "read_only",
  },
  {
    contract: "WorkdayPageTypeClassifier",
    owner: "F5",
    consumers: ["F9 live coordinator", "UiBehaviorClassifier"],
    mutability: "read_only",
  },
  {
    contract: "UiBehaviorClassifier",
    owner: "F5",
    consumers: ["QuestionClassifier", "F7 reviewed driver dispatch"],
    mutability: "read_only",
  },
  {
    contract: "QuestionClassifier",
    owner: "F6",
    consumers: ["CanonicalAnswerTypeClassifier"],
    mutability: "read_only",
  },
  {
    contract: "CanonicalAnswerTypeClassifier",
    owner: "F6",
    consumers: [
      "VisibleOptionMapper",
      "F9 live coordinator",
      "F7 reviewed driver dispatch",
    ],
    mutability: "read_only",
  },
  {
    contract: "VisibleOptionMapper",
    owner: "F6",
    consumers: ["F9 live coordinator", "F7 reviewed driver dispatch"],
    mutability: "read_only",
  },
  {
    contract: "SanitizedUnknownCandidate",
    owner: "F11",
    consumers: ["named owner", "between-run component reviewer"],
    mutability: "data_only",
  },
  {
    contract: "ReviewedPromotionRecord",
    owner: "between_runs",
    consumers: ["authorized component source owner"],
    mutability: "data_only",
  },
] as const;
