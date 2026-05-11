import { ATS_SUPPORT_MATRIX } from "./support-matrix.js";

// ATS registry: single source of truth for URL-based detection.
// Detection order matters: first match wins.
export const ATS_REGISTRY = ATS_SUPPORT_MATRIX.map((entry) => ({
  name: entry.name,
  hostPatterns: entry.hostPatterns,
  supportLevel: entry.supportLevel,
  adapter: entry.adapter,
}));

function hostFromUrl(value = "") {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch (_error) {
    return String(value || "").toLowerCase();
  }
}

function hostMatchesPattern(host, pattern) {
  const normalizedHost = String(host || "").toLowerCase();
  const normalizedPattern = String(pattern || "").toLowerCase();
  return (
    normalizedHost === normalizedPattern ||
    normalizedHost.endsWith("." + normalizedPattern)
  );
}

// Returns the ATS name for a URL string, or "unknown".
export function detectAtsFromUrl(url = "") {
  const host = hostFromUrl(url);
  for (const entry of ATS_REGISTRY) {
    if (
      entry.hostPatterns.some((pattern) => hostMatchesPattern(host, pattern))
    ) {
      return entry.name;
    }
  }
  return "unknown";
}

export function chooseDetectedAtsType({
  pageUrl = "",
  frameUrls = [],
  embeddedAtsTypes = [],
  availableAdapters = [],
} = {}) {
  const adapterSet = new Set(availableAdapters || []);
  const candidates = [];
  const addCandidate = (name) => {
    if (name && name !== "unknown" && !candidates.includes(name)) {
      candidates.push(name);
    }
  };
  const topAts = detectAtsFromUrl(pageUrl);
  addCandidate(topAts);
  (frameUrls || []).forEach((frameUrl) =>
    addCandidate(detectAtsFromUrl(frameUrl)),
  );
  (embeddedAtsTypes || []).forEach(addCandidate);

  if (adapterSet.has(topAts)) {
    return topAts;
  }
  const supportedCandidate = candidates.find((name) => adapterSet.has(name));
  if (supportedCandidate) {
    return supportedCandidate;
  }
  return topAts !== "unknown" ? topAts : candidates[0] || "unknown";
}

// Returns every host pattern across all registered ATSs.
// Useful for building manifest match lists programmatically.
export function allHostPatterns() {
  return ATS_REGISTRY.flatMap((entry) => entry.hostPatterns);
}
