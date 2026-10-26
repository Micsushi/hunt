import type {
  LivePortResult,
  PersistentBrowserErrorCode,
  PersistentBrowserReconcileResult,
  TargetIdentityV1,
} from "../../../contracts/live/index.ts";
import { bounded } from "./port-results.ts";
import { cancelled, failure } from "./port-results.ts";
import type {
  ApprovedTargetBinding,
  OwnedTargetInspection,
  OwnedTargetObservation,
  OwnedTargetProbe,
  PersistentContext,
  PersistentPage,
} from "./types.ts";

type FactualTarget = Exclude<PersistentBrowserReconcileResult, { kind: "matched" }>;
export type OwnedPageReconciliation =
  | { readonly kind: "matched"; readonly page: PersistentPage }
  | FactualTarget;

export async function reconcileOwnedPages(
  context: PersistentContext,
  probe: OwnedTargetProbe,
  approvedTarget: ApprovedTargetBinding,
  expectedTarget: TargetIdentityV1,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<LivePortResult<OwnedPageReconciliation, PersistentBrowserErrorCode>> {
  const owned: Array<{
    readonly page: PersistentPage;
    readonly observation: Extract<OwnedTargetObservation, { ownership: "owned" }>;
  }> = [];
  for (const page of context.pages()) {
    if (signal.aborted) return cancelled();
    if (page.isClosed()) continue;
    const inspected = await bounded(
      probe.inspect(page, { ...approvedTarget, identity: expectedTarget }, signal),
      signal,
      timeoutMs,
    );
    if (inspected.kind === "cancelled") return cancelled();
    if (inspected.kind === "timeout") return failure("browser_timeout");
    if (inspected.kind === "error") return failure("browser_target_stale");
    if (inspected.value.ownership === "owned") {
      owned.push({ page, observation: inspected.value });
    }
  }
  const matched = owned.filter(
    ({ observation }) => observation.target.kind === "matched",
  );
  if (matched.length > 1 || (matched.length === 0 && owned.length > 1)) {
    return { ok: true, value: { kind: "target_ambiguous" } };
  }
  if (matched.length === 1) {
    return { ok: true, value: { kind: "matched", page: matched[0]!.page } };
  }
  if (owned.length === 0) return failure("browser_session_missing");
  const sole = owned[0]!.observation.target;
  return sole.kind === "matched"
    ? failure("browser_target_stale")
    : { ok: true, value: sole };
}

export async function inspectPinnedTarget(
  page: PersistentPage,
  probe: OwnedTargetProbe,
  approvedTarget: ApprovedTargetBinding,
  expectedTarget: TargetIdentityV1,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<LivePortResult<OwnedTargetInspection, PersistentBrowserErrorCode>> {
  const inspected = await bounded(
    probe.inspect(page, { ...approvedTarget, identity: expectedTarget }, signal),
    signal,
    timeoutMs,
  );
  if (inspected.kind === "cancelled") return cancelled();
  if (inspected.kind === "timeout") return failure("browser_timeout");
  if (inspected.kind === "error") return failure("browser_target_stale");
  if (inspected.value.ownership !== "owned") {
    return failure("browser_session_missing");
  }
  return {
    ok: true,
    value: {
      target: inspected.value.target,
      snapshot: inspected.value.snapshot,
    },
  };
}
