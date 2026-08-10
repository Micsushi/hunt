import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { isReviewedMonitorStructuralIds } from "./monitor-structures.ts";

const MAX_RECORDS = 128;
const AUTH_PAGES = new Set([
  "job_posting", "apply_choice", "email_sign_in_choice", "account_entry",
  "verification_required", "verification_navigation", "sign_in", "application_ready",
  "captcha", "mfa", "access_control", "unknown",
]);
const AUTH_MOMENTS = new Set([
  "state_observed", "before_mutation", "after_readback", "before_navigation", "transition",
]);
const APPLICATION_PAGES = new Set(["resume", "profile", "questionnaire", "review"]);
const APPLICATION_MOMENTS = new Set([
  "before_mutation", "after_readback", "before_navigation", "transition",
  "recovery_observed", "review_readback",
]);
const CONTROL_TYPES = new Set([
  "text", "textarea", "select", "radio", "checkbox", "date", "phone", "address",
  "file_upload", "repeatable",
]);
const QUESTION_TYPES = new Set([
  "identity", "contact", "employment", "education", "authorization", "legal",
  "compensation", "availability", "demographic", "narrative", "attachment",
  "unknown",
]);
const ANSWER_TYPES = new Set([
  "text", "boolean", "single_select", "multi_select", "date", "number", "file",
]);

export interface Stage2ReviewMonitorChainV1 {
  readonly journeyId: string;
  readonly targetHandleId: string;
  readonly classification: "review_verified" | "account_verified";
  readonly files: readonly string[];
}

export function readStage2ReviewMonitorChain(
  rootValue: string,
  expected: Stage2MonitorChainExpected,
): Stage2ReviewMonitorChainV1 {
  return readMonitorChain(rootValue, expected, "application", "review_verified", "monitor");
}

export function readStage2AuthMonitorChain(
  rootValue: string,
  expected: Stage2MonitorChainExpected,
): Stage2ReviewMonitorChainV1 {
  return readMonitorChain(rootValue, expected, "auth", "account_verified", "auth-monitor");
}

export interface Stage2MonitorChainExpected {
    readonly journeyId: string;
    readonly targetHandleId: string;
    readonly sourceRevision: string;
    readonly configSha256: string;
    readonly hostSha256: string;
    readonly tenantSha256: string;
    readonly postingSha256: string;
    readonly processLiveNonceSha256: string;
    readonly processIssuedAt: string;
    readonly processCheckedAt: string;
    readonly processExitObservedAt: string;
    readonly processInstanceSha256: string;
}

function readMonitorChain(
  rootValue: string,
  expected: Stage2MonitorChainExpected,
  phase: "application" | "auth",
  finalClassification: "review_verified" | "account_verified",
  directoryName: "auth-monitor" | "monitor",
): Stage2ReviewMonitorChainV1 {
  try {
    const root = admittedDirectory(rootValue);
    const records = discoverRecords(root, phase);
    let previousAckSha256: string | null = null;
    let previousObservedAt = -1;
    const files: string[] = [];
    const operations: MonitorOperation[] = [];
    for (const [index, entry] of records.entries()) {
      const { ordinal, page, moment, prefix } = entry;
      const screenshotFile = `${prefix}.png`;
      const taxonomyFile = `${prefix}.taxonomy.json`;
      const requestFile = `${prefix}.request.json`;
      const ackFile = `${prefix}.ack.json`;
      const screenshot = stableFile(join(root, screenshotFile), 12 * 1024 * 1024, 8);
      validateStage2MonitorPng(screenshot);
      const taxonomyBytes = stableFile(join(root, taxonomyFile), 16 * 1024, 2);
      const requestBytes = stableFile(join(root, requestFile), 16 * 1024, 2);
      const ackBytes = stableFile(join(root, ackFile), 16 * 1024, 2);
      const taxonomy = record(JSON.parse(taxonomyBytes.toString("utf8")));
      exactKeys(taxonomy, [
        "schemaVersion", "evidenceRevision", "journeyId", "targetHandleId", "ordinal",
        "page", "moment", "fieldCount", "requiredFieldCount", "controlTypes",
        "questionTypes", "answerTypes", "validationState", "submitPresent",
        "submitActivated", "privacyScan",
      ]);
      if (
        taxonomy.schemaVersion !== 1 || taxonomy.evidenceRevision !== "s2-monitor-taxonomy-v1" ||
        !sameMoment(taxonomy, expected, ordinal, page, moment) ||
        !count(taxonomy.fieldCount) || !count(taxonomy.requiredFieldCount) ||
        (taxonomy.requiredFieldCount as number) > (taxonomy.fieldCount as number) ||
        !enumArray(taxonomy.controlTypes, CONTROL_TYPES) ||
        !enumArray(taxonomy.questionTypes, QUESTION_TYPES) ||
        !enumArray(taxonomy.answerTypes, ANSWER_TYPES) || taxonomy.validationState !== "clear" ||
        taxonomy.submitPresent !== (page === "review") || taxonomy.submitActivated !== false ||
        taxonomy.privacyScan !== "pass"
      ) denied();
      const request = record(JSON.parse(requestBytes.toString("utf8")));
      exactKeys(request, [
        "schemaVersion", "requestRevision", "journeyId", "targetHandleId", "operationId",
        "attempt", "ordinal", "page", "moment", "screenshotFile", "screenshotSha256", "taxonomyFile",
        "taxonomySha256", "previousAckSha256", "processLiveNonceSha256",
        "processIssuedAt", "processInstanceSha256", "monitorLiveTokenSha256", "issuedAt", "sourceRevision", "configSha256",
        "capturedIdentityDigests",
      ]);
      const issuedAt = timestamp(request.issuedAt);
      const processIssuedAt = timestamp(expected.processIssuedAt);
      if (
        request.schemaVersion !== 1 || request.requestRevision !== "s2-external-monitor-request-v1" ||
        !sameMoment(request, expected, ordinal, page, moment) ||
        !opaque(request.operationId, "operation") || !attempt(request.attempt) ||
        request.screenshotFile !== screenshotFile || request.screenshotSha256 !== digest(screenshot) ||
        request.taxonomyFile !== taxonomyFile || request.taxonomySha256 !== digest(taxonomyBytes) ||
        request.previousAckSha256 !== previousAckSha256 ||
        request.processLiveNonceSha256 !== expected.processLiveNonceSha256 ||
        request.processIssuedAt !== expected.processIssuedAt || issuedAt < processIssuedAt ||
        request.processInstanceSha256 !== expected.processInstanceSha256 ||
        !/^[0-9a-f]{64}$/u.test(expected.processInstanceSha256) ||
        request.monitorLiveTokenSha256 !== monitorLiveTokenSha256(expected) ||
        issuedAt < previousObservedAt || request.sourceRevision !== expected.sourceRevision ||
        request.configSha256 !== expected.configSha256 ||
        !/^[0-9a-f]{40}$/u.test(expected.sourceRevision) ||
        !/^[0-9a-f]{64}$/u.test(expected.configSha256) ||
        !identityDigests(request.capturedIdentityDigests, expected)
      ) denied();
      const ack = record(JSON.parse(ackBytes.toString("utf8")));
      exactKeys(ack, [
        "schemaVersion", "evidenceRevision", "status", "observer", "journeyId",
        "targetHandleId", "operationId", "attempt", "ordinal", "page", "moment", "requestFile", "requestSha256",
        "classification", "identityReconciliation", "identityDimensions",
        "observedIdentityDigests", "structuralDescriptionIds", "privacyScan",
        "submitPresent", "submitActivated", "observedAt",
      ]);
      const expectedClassification = index === records.length - 1
        ? finalClassification
        : "safe_to_continue";
      const observedAt = timestamp(ack.observedAt);
      if (
        ack.schemaVersion !== 1 || ack.evidenceRevision !== "s2-external-monitor-ack-v1" ||
        ack.status !== "acknowledged" || ack.observer !== "independent_visual_monitor" ||
        !sameMoment(ack, expected, ordinal, page, moment) || ack.requestFile !== requestFile ||
        ack.operationId !== request.operationId || ack.attempt !== request.attempt ||
        ack.requestSha256 !== digest(requestBytes) || ack.classification !== expectedClassification ||
        ack.identityReconciliation !== "matched" ||
        !exactArray(ack.identityDimensions, ["host", "posting", "title"]) ||
        !identityDigests(ack.observedIdentityDigests, expected) ||
        JSON.stringify(ack.observedIdentityDigests) !==
          JSON.stringify(request.capturedIdentityDigests) ||
        !structuralIds(ack.structuralDescriptionIds, page) ||
        ack.privacyScan !== "pass" || ack.submitPresent !== (page === "review") ||
        ack.submitActivated !== false || observedAt < issuedAt ||
        observedAt >= timestamp(expected.processExitObservedAt) ||
        timestamp(expected.processExitObservedAt) > timestamp(expected.processCheckedAt)
      ) denied();
      previousObservedAt = observedAt;
      previousAckSha256 = digest(ackBytes);
      operations.push(Object.freeze({
        ordinal,
        page,
        moment,
        operationId: request.operationId as string,
        attempt: request.attempt as number,
      }));
      files.push(
        `${directoryName}/${ackFile}`,
        `${directoryName}/${screenshotFile}`,
        `${directoryName}/${requestFile}`,
        `${directoryName}/${taxonomyFile}`,
      );
    }
    validateOperationSequence(phase, operations);
    return Object.freeze({
      journeyId: expected.journeyId,
      targetHandleId: expected.targetHandleId,
      classification: finalClassification,
      files: Object.freeze(files.sort()),
    });
  } catch {
    return denied();
  }
}

interface DiscoveredRecord {
  readonly ordinal: number;
  readonly page: string;
  readonly moment: string;
  readonly prefix: string;
}

interface MonitorOperation {
  readonly ordinal: number;
  readonly page: string;
  readonly moment: string;
  readonly operationId: string;
  readonly attempt: number;
}

interface OperationGroup {
  readonly fromPage: string;
  readonly toPage: string;
  readonly kind: "mutation" | "navigation" | "observation" | "recovery" | "review";
  readonly attempt: number;
}

function discoverRecords(root: string, phase: "application" | "auth"): readonly DiscoveredRecord[] {
  const names = readdirSync(root).sort();
  if (names.length < 4 || names.length > MAX_RECORDS * 4 || names.length % 4 !== 0) denied();
  const records = new Map<number, { page: string; moment: string; prefix: string; extensions: Set<string> }>();
  const pages = phase === "auth" ? AUTH_PAGES : APPLICATION_PAGES;
  const moments = phase === "auth" ? AUTH_MOMENTS : APPLICATION_MOMENTS;
  for (const name of names) {
    const match = /^(\d{4})-([a-z_]+)-([a-z_]+)\.(ack\.json|png|request\.json|taxonomy\.json)$/u.exec(name);
    if (match === null) denied();
    const ordinal = Number.parseInt(match[1]!, 10);
    const page = match[2]!;
    const moment = match[3]!;
    const extension = match[4]!;
    if (!pages.has(page) || !moments.has(moment)) denied();
    const prefix = `${match[1]}-${page}-${moment}`;
    const existing = records.get(ordinal);
    if (existing === undefined) {
      records.set(ordinal, { page, moment, prefix, extensions: new Set([extension]) });
    } else {
      if (existing.page !== page || existing.moment !== moment || existing.prefix !== prefix ||
        existing.extensions.has(extension)) denied();
      existing.extensions.add(extension);
    }
  }
  const ordered = [...records.entries()].sort(([left], [right]) => left - right);
  if (ordered.length < 1 || ordered.length > MAX_RECORDS) denied();
  return Object.freeze(ordered.map(([ordinal, value], index) => {
    if (ordinal !== index + 1 || value.extensions.size !== 4) denied();
    return Object.freeze({ ordinal, page: value.page, moment: value.moment, prefix: value.prefix });
  }));
}

function validateOperationSequence(
  phase: "application" | "auth",
  operations: readonly MonitorOperation[],
): void {
  const groups: OperationGroup[] = [];
  const usedOperationIds = new Set<string>();
  for (let index = 0; index < operations.length;) {
    const current = operations[index]!;
    let kind: OperationGroup["kind"];
    let width = 1;
    if (current.moment === "before_mutation") {
      kind = "mutation";
      width = 2;
      sameOperationPair(current, operations[index + 1], "after_readback");
    } else if (current.moment === "before_navigation") {
      kind = "navigation";
      width = 2;
      sameOperationPair(current, operations[index + 1], "transition");
    } else if (phase === "auth" && current.moment === "state_observed") {
      kind = "observation";
    } else if (phase === "application" && current.moment === "recovery_observed") {
      kind = "recovery";
    } else if (phase === "application" && current.moment === "review_readback") {
      kind = "review";
    } else {
      denied();
    }
    if (usedOperationIds.has(current.operationId)) denied();
    usedOperationIds.add(current.operationId);
    groups.push(Object.freeze({
      fromPage: current.page,
      toPage: operations[index + width - 1]!.page,
      kind,
      attempt: current.attempt,
    }));
    index += width;
  }
  validateAttempts(groups);
  if (phase === "application") validateApplicationSequence(groups);
  else validateAuthSequence(groups);
}

function sameOperationPair(
  before: MonitorOperation,
  after: MonitorOperation | undefined,
  expectedMoment: "after_readback" | "transition",
): void {
  if (
    after === undefined || after.ordinal !== before.ordinal + 1 ||
    after.moment !== expectedMoment || after.operationId !== before.operationId ||
    after.attempt !== before.attempt
  ) denied();
}

function validateAttempts(groups: readonly OperationGroup[]): void {
  const attempts = new Map<string, number>();
  for (const group of groups) {
    const key = group.kind === "navigation"
      ? `${group.fromPage}->${group.toPage}:${group.kind}`
      : `${group.fromPage}:${group.kind}`;
    const expected = (attempts.get(key) ?? 0) + 1;
    if (group.attempt !== expected || group.attempt > 8) denied();
    attempts.set(key, group.attempt);
  }
}

function validateApplicationSequence(groups: readonly OperationGroup[]): void {
  const coverage = new Set<string>();
  let currentPage = "resume";
  for (const [index, group] of groups.entries()) {
    if (group.fromPage !== currentPage) denied();
    if (group.kind === "review") {
      if (group.fromPage !== "review" || group.toPage !== "review" || index !== groups.length - 1) {
        denied();
      }
    } else if (group.fromPage === "review" || group.kind === "observation") {
      denied();
    }
    if (group.kind === "mutation") {
      if (group.toPage !== group.fromPage) denied();
      coverage.add(`${group.fromPage}:mutation`);
    } else if (group.kind === "navigation") {
      const expected = group.fromPage === "resume" ? "profile"
        : group.fromPage === "profile" ? "questionnaire"
          : group.fromPage === "questionnaire" ? "review" : undefined;
      if (group.toPage !== group.fromPage && group.toPage !== expected) denied();
      if (group.toPage === expected) coverage.add(`${group.fromPage}:navigation`);
    } else if (group.kind === "recovery" && group.toPage !== group.fromPage) {
      denied();
    }
    currentPage = group.toPage;
  }
  if (groups.at(-1)?.kind !== "review") denied();
  for (const page of ["resume", "profile", "questionnaire"]) {
    if (!coverage.has(`${page}:mutation`) || !coverage.has(`${page}:navigation`)) denied();
  }
}

function validateAuthSequence(groups: readonly OperationGroup[]): void {
  let currentPage = groups[0]?.fromPage;
  if (currentPage === undefined || !safeAuthPage(currentPage)) denied();
  for (const group of groups) {
    if (group.fromPage !== currentPage || !safeAuthPage(group.toPage)) denied();
    if (group.kind === "mutation") {
      if (group.toPage !== group.fromPage && !legalAuthTransition(group.fromPage, group.toPage)) {
        denied();
      }
    } else if (group.kind === "navigation") {
      if (!legalAuthTransition(group.fromPage, group.toPage)) denied();
    } else if (group.kind !== "observation" || group.toPage !== group.fromPage) {
      denied();
    }
    currentPage = group.toPage;
  }
  const final = groups.at(-1);
  if (final?.toPage !== "application_ready" || final.kind !== "observation") denied();
}

function safeAuthPage(page: string): boolean {
  return page !== "captcha" && page !== "mfa" && page !== "access_control" && page !== "unknown" &&
    AUTH_PAGES.has(page);
}

function legalAuthTransition(from: string, to: string): boolean {
  const edges: Readonly<Record<string, readonly string[]>> = {
    job_posting: ["apply_choice", "email_sign_in_choice", "account_entry", "application_ready"],
    apply_choice: ["email_sign_in_choice", "account_entry", "application_ready"],
    email_sign_in_choice: ["account_entry", "sign_in", "application_ready"],
    account_entry: ["verification_required", "verification_navigation", "sign_in", "application_ready"],
    verification_required: ["verification_navigation", "sign_in", "application_ready"],
    verification_navigation: ["sign_in", "application_ready"],
    sign_in: ["application_ready"],
    application_ready: [],
  };
  return edges[from]?.includes(to) === true;
}

export function validateStage2MonitorPng(bytes: Buffer): void {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.byteLength < 128 || !bytes.subarray(0, 8).equals(signature)) denied();
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImage = false;
  let sawEnd = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) denied();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 12 * 1024 * 1024 || end > bytes.byteLength) denied();
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([typeBytes, data])) !== storedCrc) denied();
    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) denied();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (
        width < 320 || width > 8192 || height < 200 || height > 8192 ||
        data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0
      ) denied();
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd || length < 1) denied();
      compressed.push(Buffer.from(data));
      sawImage = true;
    } else if (type === "IEND") {
      if (!sawImage || sawEnd || length !== 0 || end !== bytes.byteLength) denied();
      sawEnd = true;
    } else {
      denied();
    }
    offset = end;
  }
  if (!sawHeader || !sawImage || !sawEnd || offset !== bytes.byteLength) denied();
  let inflated: Buffer | undefined;
  try {
    const expectedBytes = (width * 4 + 1) * height;
    if (expectedBytes > 64 * 1024 * 1024) denied();
    inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedBytes });
    if (inflated.byteLength !== expectedBytes) denied();
    const rowBytes = width * 4 + 1;
    for (let row = 0; row < height; row += 1) {
      const filter = inflated[row * rowBytes];
      if (filter === undefined || filter > 4) denied();
    }
  } finally {
    inflated?.fill(0);
    for (const item of compressed) item.fill(0);
  }
}

function monitorLiveTokenSha256(expected: Stage2MonitorChainExpected): string {
  return digest(Buffer.from(
    `s2-monitor-live-v1\0${expected.processLiveNonceSha256}\0${expected.journeyId}\0${expected.targetHandleId}`,
    "utf8",
  ));
}

function identityDigests(
  value: unknown,
  expected: { readonly hostSha256: string; readonly tenantSha256: string; readonly postingSha256: string },
): boolean {
  const digests = record(value);
  exactKeys(digests, ["hostSha256", "tenantSha256", "postingSha256", "titleSha256"]);
  return digests.hostSha256 === expected.hostSha256 &&
    digests.tenantSha256 === expected.tenantSha256 &&
    digests.postingSha256 === expected.postingSha256 &&
    typeof digests.titleSha256 === "string" && /^[0-9a-f]{64}$/u.test(digests.titleSha256);
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sameMoment(
  value: Record<string, unknown>,
  expected: { readonly journeyId: string; readonly targetHandleId: string },
  ordinal: number,
  page: string,
  moment: string,
): boolean {
  return value.journeyId === expected.journeyId && value.targetHandleId === expected.targetHandleId &&
    value.ordinal === ordinal && value.page === page && value.moment === moment;
}

function stableFile(path: string, maximumBytes: number, minimumBytes: number): Buffer {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 ||
    before.size < minimumBytes || before.size > maximumBytes ||
    comparable(realpathSync.native(path)) !== comparable(resolve(path))
  ) denied();
  const bytes = readFileSync(path);
  const after = statSync(path);
  if (
    !after.isFile() || after.nlink !== 1 || after.size !== bytes.byteLength ||
    after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs
  ) denied();
  return bytes;
}

function admittedDirectory(value: string): string {
  if (
    !isAbsolute(value) || normalize(value) !== value || lstatSync(value).isSymbolicLink() ||
    !statSync(value).isDirectory() ||
    comparable(realpathSync.native(value)) !== comparable(resolve(value))
  ) denied();
  return realpathSync.native(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key, index) => keys[index] !== key)) denied();
}

function enumArray(value: unknown, allowed: ReadonlySet<string>): boolean {
  return Array.isArray(value) && value.length <= 16 &&
    new Set(value).size === value.length && value.every((item) => allowed.has(item));
}

function attempt(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 8;
}

function opaque(value: unknown, prefix: string): value is string {
  return typeof value === "string" &&
    new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,64}$`, "u").test(value);
}

function structuralIds(value: unknown, page?: string): boolean {
  return isReviewedMonitorStructuralIds(value, page);
}

function exactArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
}

function count(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 256;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value
  ) denied();
  return Date.parse(value);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparable(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function denied(): never {
  throw new Error("review monitor chain denied");
}
