import { canonicalJson, dataRecord, sha256 } from "../shared.ts";
import type { BaselineReport } from "../runner/index.ts";

export interface ContractImpactInputs {
  readonly manifest: unknown;
  readonly fixtures: unknown;
  readonly variants: unknown;
  readonly baseline: BaselineReport;
}

interface TaskActivation {
  taskId: string;
  decision: "activated" | "not-activated";
  status: string;
  variantIds: string[];
  provingFixtures: string[];
  provingSlots: string[];
  exactDependencies: string[];
  exactBlocks: string[];
  reason: string;
}

export interface ContractImpact {
  schemaVersion: 1;
  impactId: "workday-40-contract-impact-v1";
  impactSha: string;
  basis: {
    manifestHash: string;
    fixtureManifestHash: string;
    variantMapHash: string;
    baselineHash: string;
    runtimeRevision: string;
    acceptedS2ContractRevision: string;
    acceptedS2ContractTree: string;
  };
  classifications: Array<{
    area: string;
    disposition: "no-change" | "fixture-manifest-delta" | "implementation-gap" | "owning-stage-contract-reopen";
    variantIds: string[];
    provingFixtures: string[];
    provingSlots: string[];
  }>;
  allowedTerminalCodes: string[];
  contractReopen: { required: boolean; owningStages: string[]; acceptedRevision: string | null };
  taskActivations: TaskActivation[];
}

const acceptedS2ContractRevision = "b98ebad34b74b3a318edfca4532a954bf07e1051";
const acceptedS2ContractTree = "94521b4c6468f88505c6cb55da608618002e2d61";
const f2Tasks = Array.from({ length: 13 }, (_, index) => `S3-F2-T${index + 1}`);
const f3Tasks = Array.from({ length: 12 }, (_, index) => `S3-F3-T${index + 1}`);
const activatedVariants = new Map([
  ["S3-F2-T2", ["WD-PAGE-AUTH-ACTION-V1"]],
  ["S3-F2-T3", ["WD-PAGE-EXTERNAL-STATE-V1"]],
  ["S3-F2-T5", ["WD-UI-SOURCE-SELECT-V1"]],
  ["S3-F2-T7", ["WD-UI-SCALAR-COMPOSITE-V1"]],
]);

export function buildContractImpact(inputs: ContractImpactInputs): ContractImpact {
  const manifest = requireRecord(inputs.manifest, "manifest");
  const fixtureManifest = requireRecord(inputs.fixtures, "fixture manifest");
  const variantMap = requireRecord(inputs.variants, "variant map");
  const variants = Array.isArray(variantMap.variants) ? variantMap.variants.map((variant) => requireRecord(variant, "variant")) : [];
  const allVariantIds = variants.map((variant) => String(variant.id)).sort();
  const allEvidence = evidenceFor(allVariantIds, variants);
  const tasks: TaskActivation[] = [...f2Tasks, ...f3Tasks].map((taskId) => {
    const directVariants = activatedVariants.get(taskId) ?? [];
    const isPlanOrMatrix = taskId === "S3-F2-T1" || taskId === "S3-F2-T13";
    const decision = directVariants.length > 0 || isPlanOrMatrix ? "activated" : "not-activated";
    const variantIds = isPlanOrMatrix ? allVariantIds : [...directVariants];
    const evidence = evidenceFor(variantIds, variants);
    return {
      taskId,
      decision,
      status: "",
      variantIds,
      provingFixtures: evidence.fixtures,
      provingSlots: evidence.slots,
      exactDependencies: dependencies(taskId, decision),
      exactBlocks: blocks(taskId, decision),
      reason: decision === "activated"
        ? "Sanitized corpus fixture evidence proves this reusable closure lane."
        : "No sanitized corpus fixture proves this candidate; it remains retired from this impact freeze.",
    };
  });
  const pageIds = variants.filter((variant) => variant.category === "page").map((variant) => String(variant.id)).sort();
  const controlIds = variants.filter((variant) => variant.category === "ui").map((variant) => String(variant.id)).sort();
  const classifications: ContractImpact["classifications"] = [
    classification("page", "implementation-gap", pageIds, variants),
    classification("control", "implementation-gap", controlIds, variants),
    classification("question", "no-change", [], variants),
    classification("answer", "no-change", [], variants),
    classification("option", "no-change", [], variants),
    classification("error", "no-change", ["WD-PAGE-EXTERNAL-STATE-V1"], variants),
    classification("event", "no-change", [], variants),
    classification("evidence", "fixture-manifest-delta", allVariantIds, variants),
    classification("recovery", "no-change", [], variants),
  ];
  const impact: ContractImpact = {
    schemaVersion: 1,
    impactId: "workday-40-contract-impact-v1",
    impactSha: "",
    basis: {
      manifestHash: String(dataRecord(manifest.freeze)?.digest ?? ""),
      fixtureManifestHash: String(dataRecord(fixtureManifest.freeze)?.digest ?? ""),
      variantMapHash: String(dataRecord(variantMap.freeze)?.digest ?? ""),
      baselineHash: inputs.baseline.reportHash,
      runtimeRevision: inputs.baseline.sourceRevision,
      acceptedS2ContractRevision,
      acceptedS2ContractTree,
    },
    classifications,
    allowedTerminalCodes: terminalCodes(inputs.baseline),
    contractReopen: { required: false, owningStages: [], acceptedRevision: null },
    taskActivations: tasks,
  };
  impact.impactSha = impactDigest(impact);
  for (const task of impact.taskActivations) task.status = `${task.decision}@${impact.impactSha}`;
  return impact;
}

export function validateContractImpact(input: unknown, inputs: ContractImpactInputs): string[] {
  const errors: string[] = [];
  const impact = dataRecord(input);
  if (impact === null || impact.schemaVersion !== 1 || impact.impactId !== "workday-40-contract-impact-v1") {
    return ["contract impact header is invalid"];
  }
  rejectExtra(
    impact,
    ["schemaVersion", "impactId", "impactSha", "basis", "classifications", "allowedTerminalCodes", "contractReopen", "taskActivations"],
    "contract impact",
    errors,
  );
  const basis = dataRecord(impact.basis);
  if (basis !== null) {
    rejectExtra(
      basis,
      [
        "manifestHash", "fixtureManifestHash", "variantMapHash", "baselineHash",
        "runtimeRevision", "acceptedS2ContractRevision", "acceptedS2ContractTree",
      ],
      "contract impact basis",
      errors,
    );
  }
  const classifications = Array.isArray(impact.classifications)
    ? impact.classifications.map((row) => requireRecord(row, "impact classification"))
    : [];
  for (const row of classifications) {
    rejectExtra(
      row,
      ["area", "disposition", "variantIds", "provingFixtures", "provingSlots"],
      `classification ${String(row.area)}`,
      errors,
    );
  }
  const contractReopen = dataRecord(impact.contractReopen);
  if (contractReopen !== null) {
    rejectExtra(
      contractReopen,
      ["required", "owningStages", "acceptedRevision"],
      "contractReopen",
      errors,
    );
  }
  const digest = impactDigest(impact);
  if (impact.impactSha !== digest) errors.push("impactSha does not match frozen impact content");
  const tasks = Array.isArray(impact.taskActivations) ? impact.taskActivations.map((task) => requireRecord(task, "task activation")) : [];
  const ids = new Set<string>();
  for (const task of tasks) {
    const id = String(task.taskId);
    rejectExtra(
      task,
      [
        "taskId", "decision", "status", "variantIds", "provingFixtures", "provingSlots",
        "exactDependencies", "exactBlocks", "reason",
      ],
      `task ${id}`,
      errors,
    );
    if (ids.has(id)) errors.push(`task ${id} is duplicated`);
    ids.add(id);
    if (!f2Tasks.includes(id) && !f3Tasks.includes(id)) errors.push(`task ${id} is unknown`);
    const decision = String(task.decision);
    if (task.status !== `${decision}@${impact.impactSha}`) errors.push(`task ${id} status does not match impactSha`);
    if (decision === "activated") {
      if (strings(task.provingFixtures).length === 0) errors.push(`activated task ${id} has no proving fixture`);
      if (strings(task.provingSlots).length === 0) errors.push(`activated task ${id} has no proving slot`);
    } else if (decision !== "not-activated") {
      errors.push(`task ${id} has invalid decision`);
    }
  }
  for (const expected of [...f2Tasks, ...f3Tasks]) if (!ids.has(expected)) errors.push(`candidate task ${expected} has no impact status`);
  const external = new Set(["S3-F1-T5", "S3-F4-T1"]);
  for (const task of tasks) {
    const id = String(task.taskId);
    for (const dependency of strings(task.exactDependencies)) {
      if (!ids.has(dependency) && !external.has(dependency)) errors.push(`task ${id} depends on unknown task ${dependency}`);
      const peer = tasks.find((candidate) => candidate.taskId === dependency);
      if (peer !== undefined && !strings(peer.exactBlocks).includes(id)) errors.push(`task graph link ${dependency} -> ${id} is nonreciprocal`);
    }
    for (const blocked of strings(task.exactBlocks)) {
      if (!ids.has(blocked) && !external.has(blocked)) errors.push(`task ${id} blocks unknown task ${blocked}`);
      const peer = tasks.find((candidate) => candidate.taskId === blocked);
      if (peer !== undefined && !strings(peer.exactDependencies).includes(id)) errors.push(`task graph link ${id} -> ${blocked} is nonreciprocal`);
    }
  }
  if (taskGraphHasCycle(tasks)) errors.push("task activation graph contains a cycle");
  const variants = Array.isArray(dataRecord(inputs.variants)?.variants)
    ? (dataRecord(inputs.variants)!.variants as unknown[]).map((variant) => requireRecord(variant, "variant"))
    : [];
  const fixtureIds = new Set(
    (Array.isArray(dataRecord(inputs.fixtures)?.fixtures) ? dataRecord(inputs.fixtures)!.fixtures as unknown[] : [])
      .map((fixture) => requireRecord(fixture, "fixture"))
      .map((fixture) => String(fixture.id)),
  );
  const slotIds = new Set(
    (Array.isArray(dataRecord(inputs.manifest)?.slots) ? dataRecord(inputs.manifest)!.slots as unknown[] : [])
      .map((slot) => requireRecord(slot, "slot"))
      .map((slot) => String(slot.slotId)),
  );
  for (const task of tasks) {
    for (const fixture of strings(task.provingFixtures)) if (!fixtureIds.has(fixture)) errors.push(`task ${task.taskId} references unknown fixture ${fixture}`);
    for (const slot of strings(task.provingSlots)) if (!slotIds.has(slot)) errors.push(`task ${task.taskId} references unknown slot ${slot}`);
    for (const variant of strings(task.variantIds)) if (!variants.some((row) => row.id === variant)) errors.push(`task ${task.taskId} references unknown variant ${variant}`);
  }
  if (canonicalJson(impact.allowedTerminalCodes) !== canonicalJson(terminalCodes(inputs.baseline))) errors.push("allowedTerminalCodes do not match the baseline evidence");
  const expected = buildContractImpact(inputs);
  if (canonicalJson(impact.basis) !== canonicalJson(expected.basis)) errors.push("contract impact basis does not match frozen inputs");
  if (canonicalJson(impact.classifications) !== canonicalJson(expected.classifications)) errors.push("contract impact classifications do not match corpus evidence");
  if (canonicalJson(impact.contractReopen) !== canonicalJson(expected.contractReopen)) errors.push("contract reopen decision is invalid");
  return [...new Set(errors)];
}

function classification(
  area: string,
  disposition: ContractImpact["classifications"][number]["disposition"],
  variantIds: string[],
  variants: Record<string, unknown>[],
): ContractImpact["classifications"][number] {
  const evidence = evidenceFor(variantIds, variants);
  return { area, disposition, variantIds, provingFixtures: evidence.fixtures, provingSlots: evidence.slots };
}

function evidenceFor(variantIds: readonly string[], variants: Record<string, unknown>[]): { fixtures: string[]; slots: string[] } {
  const rows = variants.filter((variant) => variantIds.includes(String(variant.id)));
  return {
    fixtures: [...new Set(rows.flatMap((variant) => strings(variant.fixtureIds)))].sort(),
    slots: [...new Set(rows.flatMap((variant) => strings(variant.affectedSlots)))].sort(),
  };
}

function dependencies(taskId: string, decision: string): string[] {
  if (decision !== "activated") return [];
  if (taskId === "S3-F2-T1") return ["S3-F1-T5"];
  if (activatedVariants.has(taskId)) return ["S3-F2-T1"];
  if (taskId === "S3-F2-T13") return [...activatedVariants.keys()].sort();
  return [];
}

function blocks(taskId: string, decision: string): string[] {
  if (decision !== "activated") return [];
  if (taskId === "S3-F2-T1") return [...activatedVariants.keys()].sort();
  if (activatedVariants.has(taskId)) return ["S3-F2-T13"];
  if (taskId === "S3-F2-T13") return ["S3-F4-T1"];
  return [];
}

function terminalCodes(baseline: BaselineReport): string[] {
  return [...new Set(baseline.outcomes.map((outcome) =>
    outcome.kind === "posting_unavailable" ? `${outcome.kind}:${outcome.reason}` : outcome.kind,
  ))].sort();
}

function impactDigest(input: unknown): string {
  const projected = structuredClone(requireRecord(input, "contract impact"));
  delete projected.impactSha;
  if (Array.isArray(projected.taskActivations)) {
    projected.taskActivations = projected.taskActivations.map((raw) => {
      const task = { ...requireRecord(raw, "task activation") };
      delete task.status;
      return task;
    });
  }
  return sha256(canonicalJson(projected));
}

function taskGraphHasCycle(tasks: Record<string, unknown>[]): boolean {
  const graph = new Map(tasks.map((task) => [String(task.taskId), strings(task.exactBlocks).filter((id) => f2Tasks.includes(id) || f3Tasks.includes(id))]));
  const active = new Set<string>();
  const complete = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return true;
    if (complete.has(id)) return false;
    active.add(id);
    for (const child of graph.get(id) ?? []) if (visit(child)) return true;
    active.delete(id);
    complete.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").sort() : [];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = dataRecord(value);
  if (record === null) throw new TypeError(`${label} must be an object`);
  return record;
}

function rejectExtra(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record).filter((key) => !allowedSet.has(key)).sort()) {
    errors.push(`${label} contains unsupported field ${key}`);
  }
}
