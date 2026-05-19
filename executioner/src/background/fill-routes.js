export const FILL_ROUTE_NAMES = {
  filler: "filler",
  atsFiller: "ats_filler",
  dbFiller: "db_filler",
  dbAtsFiller: "db_ats_filler",
  c4Filler: "c4_filler",
  c4AtsFiller: "c4_ats_filler",
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
  const contextAtsType = String(activeApplyContext.atsType || "").toLowerCase();
  const requestedAtsType =
    contextAtsType &&
    contextAtsType !== "generic" &&
    contextAtsType !== "unknown"
      ? contextAtsType
      : detectedAtsType;
  const hasAtsAdapter =
    requestedAtsType &&
    requestedAtsType !== "unknown" &&
    availableAdapters.includes(requestedAtsType);
  const adapterName = hasAtsAdapter ? requestedAtsType : "generic";
  const strategy = hasAtsAdapter ? "ats_specific" : "generic";
  const routeKey =
    fillSource === "standalone"
      ? hasAtsAdapter
        ? "atsFiller"
        : "filler"
      : `${fillSource}${hasAtsAdapter ? "AtsFiller" : "Filler"}`;
  const routeName = FILL_ROUTE_NAMES[routeKey];

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
