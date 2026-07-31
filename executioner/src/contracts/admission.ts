import { types as utilTypes } from "node:util";
import { isResolvedResumeArtifact } from "./resume-artifact.ts";
import type { ResolvedResumeArtifact } from "./resume-artifact.ts";
import { phaseIds, stepIds } from "./types.ts";

import type {
  GuardRevision,
  JourneyId,
  OperationId,
  PortResult,
  PortError,
  BrowserMutationAdmissionSnapshot,
  BrowserMutationRequest,
  BrowserNavigationAdmissionSnapshot,
  BrowserNavigationRequest,
  BrowserEffectError,
  EvidenceAdmissionRequest,
  EvidenceAdmissionSnapshot,
  EvidenceError,
} from "./types.ts";

export type AdmissionPurpose = "privacy" | "safety" | "evidence";

export interface AdmissionBinding {
  readonly journeyId: JourneyId;
  readonly attemptId: OperationId;
  readonly guardRevision: GuardRevision;
}

export type FrozenJson =
  | null
  | string
  | number
  | boolean
  | ResolvedResumeArtifact
  | { readonly [key: string]: FrozenJson }
  | readonly FrozenJson[];

declare const admissionPermitBrand: unique symbol;
export interface AdmissionPermit {
  readonly [admissionPermitBrand]: true;
}

export interface AdmittedSnapshot<
  P extends AdmissionPurpose = AdmissionPurpose,
  S = FrozenJson,
>
  extends AdmissionBinding {
  readonly kind: "admitted";
  readonly purpose: P;
  readonly snapshot: S;
  readonly permit: AdmissionPermit;
}

export type AdmissionInputError = PortError<
  "admission_graph_invalid" | "admission_shape_invalid"
>;
export type AdmissionConsumptionError = PortError<
  "admission_invalid" | "admission_stale" | "admission_consumed" | "admission_mismatch"
>;
export type AdmissionError = AdmissionInputError | AdmissionConsumptionError;

export interface AdmissionConsumptionRequest<
  P extends AdmissionPurpose = AdmissionPurpose,
  S = FrozenJson,
> extends AdmissionBinding {
  readonly purpose: P;
  readonly snapshot: S;
  readonly admission: AdmittedSnapshot<P, S>;
}

interface StoredPermit extends AdmissionBinding {
  readonly purpose: AdmissionPurpose;
  readonly snapshot: FrozenJson;
  consumed: boolean;
}

const permits = new WeakMap<object, StoredPermit>();
const MAX_ADMISSION_DEPTH = 8;
const MAX_ADMISSION_NODES = 256;
const MAX_ADMISSION_STRING_CODE_POINTS = 512;

const topLevelKeys = {
  privacy: ["policyRevision", "semanticPayload"],
  safety: ["policyRevision", "capability", "effect"],
  evidence: ["journeyId", "operationId", "record"],
} as const satisfies Record<AdmissionPurpose, readonly string[]>;

interface CopyBudget {
  nodes: number;
}

function isBoundedString(value: string): boolean {
  let size = 0;
  for (const _codePoint of value) {
    size += 1;
    if (size > MAX_ADMISSION_STRING_CODE_POINTS) return false;
  }
  return true;
}

function copyDataGraph(
  value: unknown,
  budget: CopyBudget,
  depth = 0,
): FrozenJson | undefined {
  budget.nodes += 1;
  if (budget.nodes > MAX_ADMISSION_NODES || depth > MAX_ADMISSION_DEPTH) {
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return isBoundedString(value) ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (isResolvedResumeArtifact(value)) return value;
  if (typeof value !== "object" || utilTypes.isProxy(value)) return undefined;

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) return undefined;
    const dataKeys = keys.filter((key) => key !== "length") as string[];
    if (
      dataKeys.length !== value.length ||
      dataKeys.some((key, index) => key !== `${index}`)
    ) {
      return undefined;
    }
    const copy: FrozenJson[] = [];
    for (const key of dataKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      const child = copyDataGraph(descriptor.value, budget, depth + 1);
      if (child === undefined) return undefined;
      copy.push(child);
    }
    return Object.freeze(copy);
  }

  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) return undefined;
  const copy: Record<string, FrozenJson> = Object.create(prototype) as Record<string, FrozenJson>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return undefined;
    }
    const child = copyDataGraph(descriptor.value, budget, depth + 1);
    if (child === undefined) return undefined;
    Object.defineProperty(copy, key, {
      value: child,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(copy);
}

export function copyContractDataGraph(
  input: unknown,
): PortResult<FrozenJson, AdmissionError> {
  const snapshot = copyDataGraph(input, { nodes: 0 });
  return snapshot === undefined
    ? {
        ok: false,
        error: { code: "admission_graph_invalid", retryable: false },
      }
    : { ok: true, value: snapshot };
}

function hasExactTopLevelKeys(
  value: FrozenJson,
  purpose: AdmissionPurpose,
): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...topLevelKeys[purpose]].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function jsonObject(
  value: FrozenJson | undefined,
): value is { readonly [key: string]: FrozenJson } {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: { readonly [key: string]: FrozenJson },
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function boundedOpaque(value: FrozenJson | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
}

function validBrowserMutation(value: FrozenJson | undefined): boolean {
  if (!jsonObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "set_text") {
    return exactKeys(value, ["kind", "target", "text"]) && boundedOpaque(value.target) && typeof value.text === "string";
  }
  if (value.kind === "set_date") {
    if (
      !exactKeys(value, ["kind", "target", "isoDate"]) ||
      !boundedOpaque(value.target) ||
      typeof value.isoDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(value.isoDate)
    ) return false;
    const date = new Date(`${value.isoDate}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value.isoDate;
  }
  if (value.kind === "set_checked") {
    return exactKeys(value, ["kind", "target", "checked"]) && boundedOpaque(value.target) && typeof value.checked === "boolean";
  }
  if (value.kind === "select") {
    return exactKeys(value, ["kind", "target", "option"]) && boundedOpaque(value.target) && typeof value.option === "string";
  }
  if (value.kind === "upload") {
    return exactKeys(value, ["kind", "target", "artifact"]) && boundedOpaque(value.target) && isResolvedResumeArtifact(value.artifact);
  }
  return false;
}

function validBinding(binding: AdmissionBinding): boolean {
  return (
    /^journey_[A-Za-z0-9_-]{16,64}$/u.test(binding.journeyId) &&
    /^operation_[A-Za-z0-9_-]{16,64}$/u.test(binding.attemptId) &&
    boundedOpaque(binding.guardRevision)
  );
}

function validPurposeShape(
  snapshot: FrozenJson,
  purpose: AdmissionPurpose,
  binding: AdmissionBinding,
): boolean {
  if (!jsonObject(snapshot)) return false;
  if (purpose === "privacy") {
    const payload = snapshot.semanticPayload;
    return (
      snapshot.policyRevision === binding.guardRevision &&
      payload !== undefined &&
      jsonObject(payload) &&
      Object.values(payload).every(
        (value) =>
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean",
      )
    );
  }
  if (purpose === "safety") {
    const effect = snapshot.effect;
    return (
      snapshot.policyRevision === binding.guardRevision &&
      typeof snapshot.capability === "string" &&
      ["field_mutation", "navigate_next"].includes(snapshot.capability) &&
      effect !== undefined &&
      jsonObject(effect) &&
      ((snapshot.capability === "field_mutation" &&
        exactKeys(effect, ["kind", "sessionId", "pageId", "operationId", "mutation"]) &&
        effect.kind === "browser_mutation" &&
        typeof effect.sessionId === "string" &&
        /^browser_session_[A-Za-z0-9_-]{16,64}$/u.test(effect.sessionId) &&
        boundedOpaque(effect.pageId) &&
        effect.operationId === binding.attemptId &&
        effect.mutation !== undefined &&
        validBrowserMutation(effect.mutation)) ||
        (snapshot.capability === "navigate_next" &&
          exactKeys(effect, ["kind", "sessionId", "pageId", "operationId", "action"]) &&
          effect.kind === "browser_navigation" &&
          typeof effect.sessionId === "string" &&
          /^browser_session_[A-Za-z0-9_-]{16,64}$/u.test(effect.sessionId) &&
          boundedOpaque(effect.pageId) &&
          effect.operationId === binding.attemptId &&
          effect.action === "next") ||
        false)
    );
  }

  const record = snapshot.record;
  return (
    snapshot.journeyId === binding.journeyId &&
    snapshot.operationId === binding.attemptId &&
    record !== undefined &&
    jsonObject(record) &&
    exactKeys(record, ["id", "kind", "component", "phase", "step", "sha256"]) &&
    typeof record.id === "string" &&
    /^evidence_[A-Za-z0-9_-]{16,64}$/u.test(record.id) &&
    typeof record.kind === "string" &&
    ["semantic_snapshot", "operation_receipt", "verification"].includes(
      record.kind,
    ) &&
    typeof record.component === "string" &&
    /^F(?:[2-9]|10|11)$/u.test(record.component) &&
    typeof record.phase === "string" &&
    (phaseIds as readonly string[]).includes(record.phase) &&
    typeof record.step === "string" &&
    (stepIds as readonly string[]).includes(record.step) &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.sha256)
  );
}

export function admitContractSnapshot<P extends AdmissionPurpose, const S>(
  input: S,
  purpose: P,
  binding: AdmissionBinding,
): PortResult<AdmittedSnapshot<P, S>, AdmissionError> {
  const copied = copyContractDataGraph(input);
  if (!copied.ok) return copied;
  const snapshot = copied.value;
  if (
    !validBinding(binding) ||
    !hasExactTopLevelKeys(snapshot, purpose) ||
    !validPurposeShape(snapshot, purpose, binding)
  ) {
    return {
      ok: false,
      error: { code: "admission_shape_invalid", retryable: false },
    };
  }

  const permit = Object.freeze({}) as AdmissionPermit;
  permits.set(permit, { ...binding, purpose, snapshot, consumed: false });
  return {
    ok: true,
    value: Object.freeze({ kind: "admitted", purpose, ...binding, snapshot, permit }) as AdmittedSnapshot<P, S>,
  };
}

export function bindAdmissionRequest<P extends AdmissionPurpose, const S>(
  admission: AdmittedSnapshot<P, S>,
): AdmissionConsumptionRequest<P, S> {
  return Object.freeze({
    purpose: admission.purpose,
    journeyId: admission.journeyId,
    attemptId: admission.attemptId,
    guardRevision: admission.guardRevision,
    snapshot: admission.snapshot,
    admission,
  });
}

export function consumeAdmissionPermit(
  request: AdmissionConsumptionRequest<AdmissionPurpose, unknown>,
): PortResult<FrozenJson, AdmissionError> {
  const admission = request.admission;
  const stored = permits.get(admission.permit);
  if (stored === undefined) {
    return {
      ok: false,
      error: { code: "admission_invalid", retryable: false },
    };
  }
  if (stored.consumed) {
    return {
      ok: false,
      error: { code: "admission_consumed", retryable: false },
    };
  }
  if (
    stored.guardRevision !== request.guardRevision ||
    admission.guardRevision !== request.guardRevision
  ) {
    return {
      ok: false,
      error: { code: "admission_stale", retryable: false },
    };
  }
  if (
    stored.purpose !== request.purpose ||
    admission.purpose !== request.purpose ||
    stored.journeyId !== request.journeyId ||
    admission.journeyId !== request.journeyId ||
    stored.attemptId !== request.attemptId ||
    admission.attemptId !== request.attemptId ||
    stored.snapshot !== request.snapshot ||
    admission.snapshot !== request.snapshot
  ) {
    return {
      ok: false,
      error: { code: "admission_mismatch", retryable: false },
    };
  }

  stored.consumed = true;
  return { ok: true, value: stored.snapshot };
}

export function consumeBrowserMutationAdmission(
  request: BrowserMutationRequest,
): PortResult<BrowserMutationAdmissionSnapshot, BrowserEffectError> {
  return consumeAdmissionPermit(request) as PortResult<
    BrowserMutationAdmissionSnapshot,
    BrowserEffectError
  >;
}

export function consumeBrowserNavigationAdmission(
  request: BrowserNavigationRequest,
): PortResult<BrowserNavigationAdmissionSnapshot, BrowserEffectError> {
  return consumeAdmissionPermit(request) as PortResult<
    BrowserNavigationAdmissionSnapshot,
    BrowserEffectError
  >;
}

export function consumeEvidenceAdmission(
  request: EvidenceAdmissionRequest,
): PortResult<EvidenceAdmissionSnapshot, EvidenceError> {
  return consumeAdmissionPermit(request) as PortResult<
    EvidenceAdmissionSnapshot,
    EvidenceError
  >;
}
