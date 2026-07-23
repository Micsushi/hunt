function count(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function currentStepTitle(probe = {}) {
  return String(probe?.currentStep?.title || "").trim();
}

export function classifyWorkdayRuntimeProbe(probe = {}) {
  if (probe.workdayHost !== true) {
    return {
      ready: true,
      empty: false,
      reason: "non_workday_surface",
    };
  }
  const visibleSurfaceCount = Math.max(
    count(probe.visibleControlCount),
    count(probe.applicationFieldCount),
    count(probe.validationErrorCount),
    probe.finalSubmitVisible ? 1 : 0,
  );
  const hasRenderedText = Boolean(String(probe.bodyHead || "").trim());
  const hasStep = Boolean(currentStepTitle(probe));
  if (probe.loadingIndicatorVisible && !hasStep && visibleSurfaceCount === 0) {
    return {
      ready: false,
      empty: false,
      reason: "workday_runtime_loading",
    };
  }
  const rootEmpty = Boolean(
    probe.rootPresent && count(probe.rootChildCount) === 0,
  );
  const empty = Boolean(
    probe.ok !== false &&
    !probe.loadingIndicatorVisible &&
    !hasStep &&
    visibleSurfaceCount === 0 &&
    (rootEmpty || !hasRenderedText),
  );

  if (empty) {
    return {
      ready: false,
      empty: true,
      reason: "workday_runtime_not_ready",
    };
  }

  return {
    ready: true,
    empty: false,
    reason: "workday_runtime_surface_ready",
  };
}
