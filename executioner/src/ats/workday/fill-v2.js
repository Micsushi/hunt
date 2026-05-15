// Workday V2 uses the shared field pipeline plus Workday-only inspectors and
// drivers injected from separate files before this serialized function runs.
export function createWorkdayFillV2Function() {
  return async function workdayFillV2(context) {
    if (!window.__huntV2?.fieldPipeline) {
      return {
        ok: false,
        reason: "missing_v2_pipeline",
        message: "C3 V2 shared pipeline scripts were not injected.",
      };
    }
    return window.__huntV2.fieldPipeline.runHuntV2Fill({
      ...context,
      atsType: "workday",
    });
  };
}
