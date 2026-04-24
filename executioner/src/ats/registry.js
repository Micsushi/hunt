// ATS registry: single source of truth for URL-based detection.
// When adding a new adapter: add an entry here and a host_permissions
// entry in manifest.json. Detection order matters — first match wins.
export const ATS_REGISTRY = [
  {
    name: "workday",
    hostPatterns: ["workday.com", "myworkdayjobs.com"]
  },
  {
    name: "greenhouse",
    hostPatterns: ["boards.greenhouse.io", "app.greenhouse.io"]
  },
  {
    name: "lever",
    hostPatterns: ["jobs.lever.co"]
  },
  {
    name: "ashby",
    hostPatterns: ["jobs.ashbyhq.com"]
  },
  {
    name: "smartrecruiters",
    hostPatterns: ["jobs.smartrecruiters.com"]
  },
  {
    name: "icims",
    hostPatterns: ["icims.com"]
  },
  {
    name: "bamboohr",
    hostPatterns: ["bamboohr.com"]
  }
];

// Returns the ATS name for a URL string, or "unknown".
export function detectAtsFromUrl(url = "") {
  for (const entry of ATS_REGISTRY) {
    if (entry.hostPatterns.some((p) => url.includes(p))) {
      return entry.name;
    }
  }
  return "unknown";
}

// Returns every host pattern across all registered ATSs.
// Useful for building manifest match lists programmatically.
export function allHostPatterns() {
  return ATS_REGISTRY.flatMap((entry) => entry.hostPatterns);
}
