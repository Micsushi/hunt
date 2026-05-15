// Generic V2 adapter. The shared V2 scripts are injected as page globals before
// this serialized function runs.
export function createGenericFillV2Function() {
  return async function genericFillV2(context) {
    if (!window.__huntV2?.fieldPipeline) {
      return {
        ok: false,
        reason: "missing_v2_pipeline",
        message: "C3 V2 shared pipeline scripts were not injected.",
      };
    }
    return window.__huntV2.fieldPipeline.runHuntV2Fill({
      ...context,
      atsType: context.fillRoute?.adapterName || "generic",
    });
  };
}
