import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import {
  copyContractDataGraph,
  s2CommonPhaseIds,
  s2StableErrorPolicy,
  stepIds,
} from "../../contracts/index.ts";
import type {
  ClassificationLayer,
  IndependentBrowserTruthV1,
  LiveEvidenceArtifactManifestEntryV1,
  LiveEvidenceArtifactManifestV1,
  LiveEvidenceErrorV1,
  LiveEvidenceMilestoneV1,
  LiveEvidencePacketRequestV1,
  LiveEvidenceVerificationSummaryV1,
  MilestoneKind,
  MissingEvidenceKind,
  UnknownCandidateEvidenceV1,
  VerificationKind,
} from "./types.ts";

export type {
  IndependentBrowserTruthV1,
  LiveEvidenceArtifactManifestEntryV1,
  LiveEvidenceArtifactManifestV1,
  LiveEvidenceErrorV1,
  LiveEvidenceMilestoneV1,
  LiveEvidencePacketRequestV1,
  LiveEvidenceVerificationSummaryV1,
  UnknownCandidateEvidenceV1,
} from "./types.ts";

export const LIVE_EVIDENCE_MAX_ARTIFACTS = 3;
export const LIVE_EVIDENCE_MAX_ARTIFACT_BYTES = 4 * 1024;
export const LIVE_EVIDENCE_MAX_MANIFEST_BYTES = 4 * 1024;
export const LIVE_EVIDENCE_MAX_TOTAL_BYTES = 16 * 1024;

type AdmittedRequest = LiveEvidencePacketRequestV1;

export function writeLiveEvidencePacket(
  value: LiveEvidencePacketRequestV1,
): LiveEvidenceArtifactManifestV1 {
  const request = admitRequest(value);
  const root = admittedRoot(request.root);
  const target = join(root, "real-evidence");
  if (existsSync(target)) denied();

  // Browser truth is serialized and sealed before diagnostic comparison exists.
  const browserTruthBytes = serialize(request.browserTruth);
  const browserTruthSha256 = digest(browserTruthBytes);
  const comparison = Object.freeze({
    browserTruthSha256,
    reviewReached: request.diagnosticProjection.reviewReached,
    requiredFieldsComplete: request.diagnosticProjection.requiredFieldsComplete,
    submitActivated: request.diagnosticProjection.submitActivated,
    matchesBrowserTruth:
      request.diagnosticProjection.reviewReached === (request.browserTruth.page === "review") &&
      request.diagnosticProjection.requiredFieldsComplete ===
        (request.browserTruth.completionEvidenceIds.length > 0) &&
      request.diagnosticProjection.submitActivated === request.browserTruth.submitActivated,
  });
  const summaryBytes = serialize({
    schemaVersion: 1,
    evidenceRevision: request.packetRevision,
    sourceRevision: request.sourceRevision,
    configurationRevisionId: request.configurationRevisionId,
    configurationApprovalId: request.configurationApprovalId,
    journeyId: request.journeyId,
    sealedAt: request.sealedAt,
    milestones: request.milestones,
    verificationSummaries: request.verificationSummaries,
    errors: request.errors,
    missingEvidence: request.missingEvidence,
    diagnosticComparison: comparison,
  });
  const artifacts: { file: LiveEvidenceArtifactManifestEntryV1["file"]; bytes: Buffer }[] = [
    { file: "browser-truth.json", bytes: browserTruthBytes },
    { file: "summary.json", bytes: summaryBytes },
  ];
  if (request.unknownCandidate !== null) {
    artifacts.push({ file: "unknown-candidate.json", bytes: serialize(request.unknownCandidate) });
  }
  artifacts.sort((left, right) => left.file.localeCompare(right.file));
  enforceLimits(artifacts);

  const manifest: LiveEvidenceArtifactManifestV1 = Object.freeze({
    schemaVersion: 1,
    manifestRevision: "s2-real-evidence-manifest-v1",
    sourceRevision: request.sourceRevision,
    configurationRevisionId: request.configurationRevisionId,
    configurationApprovalId: request.configurationApprovalId,
    journeyId: request.journeyId,
    sealedAt: request.sealedAt,
    privacyScan: "pass",
    artifactCount: artifacts.length,
    totalArtifactBytes: artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0),
    retention: Object.freeze({
      retentionDays: request.retentionDays,
      deleteAfter: deleteAfter(request.sealedAt, request.retentionDays),
      disposition: "delete_after_retention",
      screenshotsRetained: false,
      rawDomRetained: false,
    }),
    artifacts: Object.freeze(artifacts.map(({ file, bytes }) => Object.freeze({
      file,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    }))),
  });
  const manifestBytes = serialize(manifest);
  if (manifestBytes.byteLength > LIVE_EVIDENCE_MAX_MANIFEST_BYTES ||
    manifest.totalArtifactBytes + manifestBytes.byteLength > LIVE_EVIDENCE_MAX_TOTAL_BYTES) denied();
  scanForbiddenTokens([...artifacts, { bytes: manifestBytes }], request.forbiddenTokens);

  const partial = join(root, `.real-evidence-${randomBytes(16).toString("hex")}.partial`);
  try {
    mkdirSync(partial, { mode: 0o700 });
    for (const artifact of artifacts) {
      writeFileSync(join(partial, artifact.file), artifact.bytes, {
        flag: "wx",
        flush: true,
        mode: 0o600,
      });
      chmodSync(join(partial, artifact.file), 0o600);
    }
    writeFileSync(join(partial, "manifest.json"), manifestBytes, {
      flag: "wx",
      flush: true,
      mode: 0o600,
    });
    chmodSync(join(partial, "manifest.json"), 0o600);
    if (existsSync(target)) denied();
    renameSync(partial, target);
    return manifest;
  } catch {
    rmSync(partial, { recursive: true, force: true });
    denied();
  }
}

function admitRequest(value: unknown): AdmittedRequest {
  const copied = copyContractDataGraph(value);
  if (!copied.ok) denied();
  const request = copied.value as unknown as AdmittedRequest;
  exactObject(request, [
    "schemaVersion", "packetRevision", "root", "sourceRevision", "configurationRevisionId",
    "configurationApprovalId", "journeyId", "sealedAt", "retentionDays", "milestones",
    "verificationSummaries", "errors", "missingEvidence", "browserTruth", "diagnosticProjection",
    "unknownCandidate", "forbiddenTokens",
  ]);
  if (
    request.schemaVersion !== 1 ||
    request.packetRevision !== "s2-real-evidence-packet-v1" ||
    typeof request.root !== "string" ||
    !/^[0-9a-f]{40}$/u.test(request.sourceRevision) ||
    !opaque(request.configurationRevisionId, "revision") ||
    !opaque(request.configurationApprovalId, "approval") ||
    !opaque(request.journeyId, "journey") ||
    !timestamp(request.sealedAt) ||
    request.retentionDays !== 30
  ) denied();
  parseMilestones(request.milestones);
  parseVerificationSummaries(request.verificationSummaries);
  parseErrors(request.errors);
  parseMissing(request.missingEvidence);
  parseBrowserTruth(request.browserTruth);
  parseProjection(request.diagnosticProjection);
  requireMissingEvidenceDisclosures(request);
  if (request.unknownCandidate !== null) parseUnknownCandidate(request.unknownCandidate);
  if (!Array.isArray(request.forbiddenTokens) || request.forbiddenTokens.length > 32 ||
    request.forbiddenTokens.some((token) => typeof token !== "string" || token.length < 3 || token.length > 512)) {
    denied();
  }
  return request;
}

function parseMilestones(value: readonly LiveEvidenceMilestoneV1[]): void {
  const expected = ["account_verified", "application_completed", "review_reached", "submit_guarded"] as const;
  if (!Array.isArray(value) || value.length !== expected.length) denied();
  const kinds = new Set<string>();
  for (const item of value) {
    exactObject(item, ["kind", "status"]);
    if (!["account_verified", "application_completed", "review_reached", "submit_guarded"].includes(item.kind) ||
      !["verified", "missing"].includes(item.status) || kinds.has(item.kind)) denied();
    kinds.add(item.kind);
  }
  if (expected.some((kind) => !kinds.has(kind))) denied();
}

function parseVerificationSummaries(value: readonly LiveEvidenceVerificationSummaryV1[]): void {
  const expected = ["account", "resume", "required_fields", "review", "submit_guard"] as const;
  if (!Array.isArray(value) || value.length !== expected.length) denied();
  const kinds = new Set<string>();
  for (const item of value) {
    exactObject(item, ["kind", "status", "verifiedCount"]);
    if (!["account", "resume", "required_fields", "review", "submit_guard"].includes(item.kind) ||
      !["verified", "missing"].includes(item.status) || !boundedCount(item.verifiedCount) ||
      (item.status === "missing" && item.verifiedCount !== 0) || kinds.has(item.kind)) denied();
    kinds.add(item.kind);
  }
  if (expected.some((kind) => !kinds.has(kind))) denied();
}

function parseErrors(value: readonly LiveEvidenceErrorV1[]): void {
  if (!Array.isArray(value) || value.length > 16) denied();
  for (const item of value as readonly LiveEvidenceErrorV1[]) {
    exactObject(item, ["code", "component", "phase", "step", "retryable"]);
    if (!Object.hasOwn(s2StableErrorPolicy, item.code)) denied();
    const policy = s2StableErrorPolicy[item.code];
    if (item.component !== policy.owner || item.retryable !== policy.retryable ||
      !(s2CommonPhaseIds as readonly string[]).includes(item.phase) ||
      !(stepIds as readonly string[]).includes(item.step)) denied();
  }
}

function parseMissing(value: readonly MissingEvidenceKind[]): void {
  if (!Array.isArray(value) || value.length > 6 || new Set(value).size !== value.length ||
    value.some((item) => ![
      "account_verification", "application_completion", "required_fields_verification",
      "resume_verification", "review_proof", "submit_presence",
    ].includes(item))) denied();
}

function requireMissingEvidenceDisclosures(request: AdmittedRequest): void {
  const missing = new Set(request.missingEvidence);
  const required = new Set<MissingEvidenceKind>();
  const milestoneCodes: Partial<Record<MilestoneKind, MissingEvidenceKind>> = {
    account_verified: "account_verification",
    application_completed: "application_completion",
    review_reached: "review_proof",
    submit_guarded: "submit_presence",
  };
  const verificationCodes: Partial<Record<VerificationKind, MissingEvidenceKind>> = {
    account: "account_verification",
    resume: "resume_verification",
    required_fields: "required_fields_verification",
    review: "review_proof",
    submit_guard: "submit_presence",
  };
  for (const item of request.milestones) {
    const code = milestoneCodes[item.kind];
    if (item.status === "missing" && code !== undefined) required.add(code);
  }
  for (const item of request.verificationSummaries) {
    const code = verificationCodes[item.kind];
    if (item.status === "missing" && code !== undefined) required.add(code);
  }
  if (request.browserTruth.page === "unknown") required.add("review_proof");
  if (!request.browserTruth.submitStructurallyPresent) required.add("submit_presence");
  if (missing.size !== required.size || [...required].some((code) => !missing.has(code))) denied();
}

function parseBrowserTruth(value: IndependentBrowserTruthV1): void {
  exactObject(value, [
    "schemaVersion", "observer", "page", "reviewSignatureIds", "completionEvidenceIds",
    "submitStructurallyPresent", "submitActivated",
  ]);
  if (value.schemaVersion !== 1 || value.observer !== "independent_browser" ||
    !["review", "unknown"].includes(value.page) || value.submitActivated !== false ||
    typeof value.submitStructurallyPresent !== "boolean") denied();
  const minimum = value.page === "review" ? 1 : 0;
  parseIds(value.reviewSignatureIds, "review_signature", 8, minimum);
  parseIds(value.completionEvidenceIds, "completion_evidence", 16, minimum);
}

function parseProjection(value: LiveEvidencePacketRequestV1["diagnosticProjection"]): void {
  exactObject(value, ["reviewReached", "requiredFieldsComplete", "submitActivated"]);
  if (typeof value.reviewReached !== "boolean" || typeof value.requiredFieldsComplete !== "boolean" ||
    value.submitActivated !== false) denied();
}

function parseUnknownCandidate(value: UnknownCandidateEvidenceV1): void {
  exactObject(value, [
    "schemaVersion", "layer", "acceptedSchemaId", "acceptedRevisionId", "structuralTraitIds",
    "controlCount", "requiredControlCount", "optionCount", "reviewLineage",
  ]);
  const layers: readonly ClassificationLayer[] = [
    "ats_family", "workday_page_type", "ui_behavior", "question", "answer_type", "visible_option",
  ];
  if (value.schemaVersion !== 1 || !layers.includes(value.layer) ||
    !opaque(value.acceptedSchemaId, "schema") || !opaque(value.acceptedRevisionId, "classification_revision") ||
    !boundedCount(value.controlCount) || !boundedCount(value.requiredControlCount) ||
    !boundedCount(value.optionCount) || value.requiredControlCount > value.controlCount) denied();
  parseIds(value.structuralTraitIds, "structural_trait", 32, 1);
  const expectedLineage = layers.slice(0, layers.indexOf(value.layer));
  if (!Array.isArray(value.reviewLineage) || value.reviewLineage.length !== expectedLineage.length) denied();
  const classificationIds = new Set<string>();
  for (const [index, entry] of value.reviewLineage.entries()) {
    exactObject(entry, ["layer", "classificationId"]);
    if (entry.layer !== expectedLineage[index] || !opaque(entry.classificationId, "classification") ||
      classificationIds.has(entry.classificationId)) denied();
    classificationIds.add(entry.classificationId);
  }
}

function parseIds(value: readonly string[], prefix: string, maximum: number, minimum = 1): void {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum ||
    new Set(value).size !== value.length || value.some((item) => !opaque(item, prefix))) denied();
}

function enforceLimits(
  artifacts: readonly { readonly bytes: Buffer }[],
): void {
  if (artifacts.length > LIVE_EVIDENCE_MAX_ARTIFACTS ||
    artifacts.some(({ bytes }) => bytes.byteLength > LIVE_EVIDENCE_MAX_ARTIFACT_BYTES) ||
    artifacts.reduce((total, { bytes }) => total + bytes.byteLength, 0) > LIVE_EVIDENCE_MAX_TOTAL_BYTES) denied();
}

function scanForbiddenTokens(
  artifacts: readonly { readonly bytes: Buffer }[],
  forbiddenTokens: readonly string[],
): void {
  for (const token of forbiddenTokens) {
    const bytes = Buffer.from(token, "utf8");
    try {
      if (artifacts.some((artifact) => artifact.bytes.includes(bytes))) denied();
    } finally {
      bytes.fill(0);
    }
  }
}

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deleteAfter(sealedAt: string, retentionDays: number): string {
  return new Date(Date.parse(sealedAt) + retentionDays * 86_400_000).toISOString();
}

function boundedCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 64;
}

function opaque(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`, "u").test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function exactObject(value: unknown, expected: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) denied();
}

function admittedRoot(value: string): string {
  try {
    if (!isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
      !statSync(value).isDirectory() || comparable(realpathSync.native(value)) !== comparable(resolve(value))) denied();
    return realpathSync.native(value);
  } catch {
    return denied();
  }
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("live evidence denied");
}
