import { dataRecord, frozenDigest, sha256, sha256Pattern } from "../shared.ts";

export interface CorpusManifest {
  schemaVersion: 1;
  corpusId: "workday-40";
  source: Record<string, unknown>;
  ownerApproval: Record<string, unknown>;
  replacementPolicy: Record<string, unknown>;
  slots: Record<string, unknown>[];
  freeze: { algorithm: "sha256"; digest: string };
}

export interface CorpusManifestSource {
  readonly csv: string;
  readonly sourceRevision: string;
  readonly evidenceDigests: readonly string[];
  readonly unavailableSlots: ReadonlyMap<number, "maintenance" | "removed" | "closed" | "not_found" | "access_control">;
}

export function corpusManifestFromCsv(source: CorpusManifestSource): CorpusManifest {
  const rows = parseCsv(source.csv);
  const headers = rows.shift();
  if (JSON.stringify(headers?.slice(0, 4)) !== JSON.stringify(["company name", "job name", "country", "link"])) {
    throw new TypeError("corpus source CSV headers are unsupported");
  }
  if (rows.length < 40) throw new RangeError("corpus source CSV has fewer than 40 jobs");

  const slots = rows.slice(0, 40).map((row, index) => {
    if (row.length < 4) throw new TypeError(`corpus source row ${index + 2} is malformed`);
    const target = new URL(row[3]!);
    if (target.protocol !== "https:" || !target.hostname.endsWith(".myworkdayjobs.com")) {
      throw new TypeError(`corpus source row ${index + 2} is not a Workday job`);
    }
    target.search = "";
    target.hash = "";
    const tenantClass = target.hostname.match(/\.wd(1|3|5|10|12)\.myworkdayjobs\.com$/u)?.[1];
    if (tenantClass === undefined) throw new TypeError(`corpus source row ${index + 2} has an unsupported tenant`);
    const slotNumber = index + 1;
    const unavailableReason = source.unavailableSlots.get(slotNumber);
    return {
      slotId: `WD40-${String(slotNumber).padStart(3, "0")}`,
      jobRef: sha256(target.toString()),
      sourceRef: `corpus/workday-40/source.snapshot#row-${index + 2}`,
      tenantRef: `tenant.${sha256(target.hostname).slice(7, 23)}`,
      tenantClass: `wd${tenantClass}`,
      variantIntent: ["workday-posting", "account-or-direct-entry"],
      accountMode: "approved-existing-or-direct",
      availability: unavailableReason === undefined
        ? { kind: "available", observedAt: "2026-07-23" }
        : { kind: "unavailable", reason: unavailableReason, observedAt: "2026-07-23" },
      replacementDecision: unavailableReason === undefined
        ? { kind: "not-needed" }
        : {
            kind: "retain-unavailable",
            reason: "No equivalent replacement was approved; retain this external site-state lane.",
            approvalRef: "s3-f1-owner-delegation-2026-08-04",
          },
    };
  });

  return freezeCorpusManifest({
    schemaVersion: 1,
    corpusId: "workday-40",
    source: {
      kind: "committed_csv",
      reference: "corpus/workday-40/source.snapshot#rows-2-41",
      revision: source.sourceRevision,
      evidenceDigests: [...source.evidenceDigests],
    },
    ownerApproval: {
      status: "approved",
      recordRef: "s3-f1-owner-delegation-2026-08-04",
      approvedAt: "2026-08-04",
    },
    replacementPolicy: {
      immutableFields: ["slotId", "tenantRef", "variantIntent", "accountMode"],
      equivalenceFields: ["tenantRef", "variantIntent", "accountMode"],
      unavailableIsProductFailure: false,
    },
    slots,
  });
}

export function freezeCorpusManifest(value: Record<string, unknown>): CorpusManifest {
  const manifest = structuredClone(value) as unknown as CorpusManifest;
  manifest.freeze = { algorithm: "sha256", digest: frozenDigest(manifest) };
  return manifest;
}

export function validateCorpusManifest(input: unknown): string[] {
  const errors: string[] = [];
  const manifest = dataRecord(input);
  if (manifest === null) return ["manifest must be an object"];
  rejectExtra(manifest, ["schemaVersion", "corpusId", "source", "ownerApproval", "replacementPolicy", "slots", "freeze"], "manifest", errors);
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (manifest.corpusId !== "workday-40") errors.push("corpusId must be workday-40");
  validateSource(dataRecord(manifest.source), errors);
  validateApproval(dataRecord(manifest.ownerApproval), errors);
  validatePolicy(dataRecord(manifest.replacementPolicy), errors);

  const slots = Array.isArray(manifest.slots) ? manifest.slots : [];
  if (slots.length !== 40) errors.push("slots must contain exactly 40 entries");
  const slotIds = new Map<string, number>();
  const jobRefs = new Map<string, number>();
  slots.forEach((rawSlot, index) => {
    const slot = dataRecord(rawSlot);
    if (slot === null) {
      errors.push(`slots[${index}] must be an object`);
      return;
    }
    rejectExtra(slot, [
      "slotId", "jobRef", "sourceRef", "tenantRef", "tenantClass", "variantIntent",
      "accountMode", "availability", "replacementDecision",
    ], `slots[${index}]`, errors);
    const expectedId = `WD40-${String(index + 1).padStart(3, "0")}`;
    if (slot.slotId !== expectedId) errors.push(`slots[${index}].slotId must be ${expectedId}`);
    unique(slot.slotId, "slotId", index, slotIds, errors);
    if (typeof slot.jobRef !== "string" || !sha256Pattern.test(slot.jobRef)) {
      errors.push(`slots[${index}].jobRef must be an opaque sha256 reference`);
    } else {
      unique(slot.jobRef, "jobRef", index, jobRefs, errors);
    }
    if (slot.sourceRef !== `corpus/workday-40/source.snapshot#row-${index + 2}`) {
      errors.push(`slots[${index}].sourceRef does not match its frozen row`);
    }
    if (typeof slot.tenantRef !== "string" || !/^tenant\.[a-f0-9]{16}$/u.test(slot.tenantRef)) {
      errors.push(`slots[${index}].tenantRef must be opaque`);
    }
    if (typeof slot.tenantClass !== "string" || !/^wd(?:1|3|5|10|12)$/u.test(slot.tenantClass)) {
      errors.push(`slots[${index}].tenantClass is unsupported`);
    }
    if (!sameStrings(slot.variantIntent, ["workday-posting", "account-or-direct-entry"])) {
      errors.push(`slots[${index}].variantIntent is not frozen`);
    }
    if (slot.accountMode !== "approved-existing-or-direct") {
      errors.push(`slots[${index}].accountMode is unsupported`);
    }
    validateAvailability(slot, index, errors);
  });

  const freeze = dataRecord(manifest.freeze);
  if (freeze?.algorithm !== "sha256" || typeof freeze.digest !== "string" || !sha256Pattern.test(freeze.digest)) {
    errors.push("freeze must contain a sha256 digest");
  } else if (freeze.digest !== frozenDigest(manifest)) {
    errors.push("freeze.digest does not match canonical manifest content");
  }
  return errors;
}

function validateSource(source: Record<string, unknown> | null, errors: string[]): void {
  if (source !== null) rejectExtra(source, ["kind", "reference", "revision", "evidenceDigests"], "source", errors);
  if (
    source?.kind !== "committed_csv" ||
    source.reference !== "corpus/workday-40/source.snapshot#rows-2-41" ||
    typeof source.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.revision) ||
    !Array.isArray(source.evidenceDigests) ||
    source.evidenceDigests.length === 0 ||
    !source.evidenceDigests.every((value) => typeof value === "string" && sha256Pattern.test(value))
  ) {
    errors.push("source record is incomplete or unsafe");
  }
}

function validateApproval(approval: Record<string, unknown> | null, errors: string[]): void {
  if (approval !== null) rejectExtra(approval, ["status", "recordRef", "approvedAt"], "ownerApproval", errors);
  if (
    approval?.status !== "approved" ||
    typeof approval.recordRef !== "string" ||
    !/^s3-f1-[a-z0-9-]+$/u.test(approval.recordRef) ||
    typeof approval.approvedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(approval.approvedAt)
  ) {
    errors.push("ownerApproval is incomplete");
  }
}

function validatePolicy(policy: Record<string, unknown> | null, errors: string[]): void {
  if (policy !== null) rejectExtra(policy, ["immutableFields", "equivalenceFields", "unavailableIsProductFailure"], "replacementPolicy", errors);
  if (
    !sameStrings(policy?.immutableFields, ["slotId", "tenantRef", "variantIntent", "accountMode"]) ||
    !sameStrings(policy?.equivalenceFields, ["tenantRef", "variantIntent", "accountMode"]) ||
    policy?.unavailableIsProductFailure !== false
  ) {
    errors.push("replacementPolicy does not freeze equivalence and site-state rules");
  }
}

function validateAvailability(slot: Record<string, unknown>, index: number, errors: string[]): void {
  const availability = dataRecord(slot.availability);
  const decision = dataRecord(slot.replacementDecision);
  const kind = availability?.kind;
  if (availability !== null) {
    rejectExtra(
      availability,
      kind === "unavailable" ? ["kind", "reason", "observedAt"] : ["kind", "observedAt"],
      `slots[${index}].availability`,
      errors,
    );
  }
  if (!new Set(["available", "unavailable", "replaced"]).has(String(kind))) {
    errors.push(`slots[${index}].availability is unsupported`);
    return;
  }
  if (typeof availability?.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(availability.observedAt)) {
    errors.push(`slots[${index}].availability.observedAt is invalid`);
  }
  if (kind === "available") {
    if (decision !== null) rejectExtra(decision, ["kind"], `slots[${index}].replacementDecision`, errors);
    if (decision?.kind !== "not-needed") errors.push(`slots[${index}].replacementDecision must be not-needed`);
    return;
  }
  if (kind === "unavailable") {
    if (decision !== null) rejectExtra(decision, ["kind", "reason", "approvalRef"], `slots[${index}].replacementDecision`, errors);
    if (!new Set(["maintenance", "removed", "closed", "not_found", "access_control"]).has(String(availability?.reason))) {
      errors.push(`slots[${index}].availability.reason is unsupported`);
    }
    if (
      decision?.kind !== "retain-unavailable" ||
      typeof decision.reason !== "string" ||
      decision.reason.length < 20 ||
      typeof decision.approvalRef !== "string"
    ) {
      errors.push(`slots[${index}].replacementDecision must retain or replace unavailable evidence explicitly`);
    }
    return;
  }
  if (
    decision?.kind !== "replacement-approved" ||
    typeof decision.replacementJobRef !== "string" ||
    !sha256Pattern.test(decision.replacementJobRef) ||
    typeof decision.reason !== "string" ||
    decision.reason.length < 20 ||
    typeof decision.approvalRef !== "string"
  ) {
    errors.push(`slots[${index}].replacementDecision is incomplete`);
    return;
  }
  if (decision !== null) {
    rejectExtra(
      decision,
      ["kind", "replacementJobRef", "tenantRef", "variantIntent", "accountMode", "reason", "approvalRef"],
      `slots[${index}].replacementDecision`,
      errors,
    );
  }
  for (const field of ["tenantRef", "variantIntent", "accountMode"] as const) {
    if (JSON.stringify(decision[field]) !== JSON.stringify(slot[field])) {
      errors.push(`slots[${index}].replacementDecision does not preserve ${field}`);
    }
  }
}

function unique(
  value: unknown,
  field: string,
  index: number,
  seen: Map<string, number>,
  errors: string[],
): void {
  if (typeof value !== "string") return;
  const first = seen.get(value);
  if (first !== undefined) errors.push(`slots[${index}].${field} duplicates slots[${first}].${field}`);
  else seen.set(value, index);
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
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

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new TypeError("corpus source CSV contains an unterminated quote");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
