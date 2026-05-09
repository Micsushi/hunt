export const FILL_ROUTE_NAMES = {
  standaloneGeneric: "standalone_generic",
  standaloneAtsSpecific: "standalone_ats_specific",
  dbGeneric: "db_generic",
  dbAtsSpecific: "db_ats_specific",
  c4Generic: "c4_generic",
  c4AtsSpecific: "c4_ats_specific",
};

export function classifyFillSource(activeApplyContext = {}) {
  if (!activeApplyContext.jobId) {
    return "standalone";
  }
  const sourceMode = String(activeApplyContext.sourceMode || "").toLowerCase();
  const source = String(activeApplyContext.source || "").toLowerCase();
  if (
    sourceMode.includes("c4") ||
    sourceMode.includes("coordinator") ||
    source.includes("c4") ||
    source.includes("coordinator")
  ) {
    return "c4";
  }
  return "db";
}

export function selectFillRoute({
  activeApplyContext = {},
  detectedAtsType = "unknown",
  availableAdapters = [],
}) {
  const fillSource = classifyFillSource(activeApplyContext);
  const requestedAtsType = activeApplyContext.atsType || detectedAtsType;
  const hasAtsAdapter =
    requestedAtsType &&
    requestedAtsType !== "unknown" &&
    availableAdapters.includes(requestedAtsType);
  const adapterName = hasAtsAdapter ? requestedAtsType : "generic";
  const strategy = hasAtsAdapter ? "ats_specific" : "generic";
  const routeName =
    FILL_ROUTE_NAMES[
      `${fillSource}${hasAtsAdapter ? "AtsSpecific" : "Generic"}`
    ];

  return {
    routeName,
    fillSource,
    strategy,
    adapterName,
    requestedAtsType: requestedAtsType || "unknown",
    detectedAtsType: detectedAtsType || "unknown",
    usedGenericFallback:
      strategy === "generic" &&
      requestedAtsType &&
      requestedAtsType !== "unknown" &&
      requestedAtsType !== "generic",
  };
}
