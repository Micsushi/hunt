import { types as utilTypes } from "node:util";

import type {
  RecoveryBrowserPageTruth,
  RecoveryCheckpoint,
  RecoveryPageKind,
  RecoveryTerminal,
} from "./types.ts";

export const recoveryPageOrder: Readonly<Record<RecoveryPageKind, number>> = {
  account: 0,
  verification: 1,
  profile: 2,
  questionnaire: 3,
  review: 4,
};

export function validBrowserSnapshot(
  value: unknown,
): value is { readonly pages: readonly RecoveryBrowserPageTruth[] } {
  return exactRecord(value, ["pages"]) &&
    Array.isArray(value.pages) &&
    value.pages.every(validBrowserPage);
}

export function validCheckpoint(value: unknown): value is RecoveryCheckpoint {
  if (!exactRecord(value, [
    "schemaVersion", "journeyId", "sourceRevision", "revision", "target",
    "page", "verification", "terminal",
  ])) return false;
  return value.schemaVersion === 1 &&
    typeof value.journeyId === "string" &&
    typeof value.sourceRevision === "string" &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 &&
    validTarget(value.target) &&
    validPage(value.page, false) &&
    ["not_required", "required", "verified"].includes(value.verification as string) &&
    (
      value.terminal === null ||
      (validTerminal(value.terminal) && value.terminal.journeyId === value.journeyId)
    );
}

export function validTerminal(value: unknown): value is RecoveryTerminal {
  return exactRecord(value, [
    "schemaVersion", "journeyId", "operationId", "code", "retryable", "attempts",
  ]) && value.schemaVersion === 1 && typeof value.journeyId === "string" &&
    typeof value.operationId === "string" && value.retryable === false &&
    ["recovery_state_ambiguous", "recovery_target_mismatch", "journey_retry_exhausted"].includes(value.code as string) &&
    validAttempts(value.attempts);
}

export function sameTarget(
  left: RecoveryCheckpoint["target"],
  right: RecoveryCheckpoint["target"],
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.atsFamily === right.atsFamily && left.hostId === right.hostId &&
    left.tenantId === right.tenantId && left.postingId === right.postingId;
}

export function sameCheckpoint(
  left: RecoveryCheckpoint,
  right: RecoveryCheckpoint,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.journeyId === right.journeyId &&
    left.sourceRevision === right.sourceRevision &&
    left.revision === right.revision &&
    sameTarget(left.target, right.target) &&
    left.page.id === right.page.id && left.page.kind === right.page.kind &&
    left.verification === right.verification &&
    (
      left.terminal === null
        ? right.terminal === null
        : right.terminal !== null && sameTerminal(left.terminal, right.terminal)
    );
}

export function sameTerminal(left: RecoveryTerminal, right: RecoveryTerminal): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.journeyId === right.journeyId &&
    left.operationId === right.operationId &&
    left.code === right.code && left.retryable === right.retryable &&
    left.attempts.reload === right.attempts.reload &&
    left.attempts.stale_handle === right.attempts.stale_handle &&
    left.attempts.transient_network === right.attempts.transient_network &&
    left.attempts.popup === right.attempts.popup &&
    left.attempts.interrupted_process === right.attempts.interrupted_process &&
    left.attempts.total === right.attempts.total;
}

function validBrowserPage(value: unknown): value is RecoveryBrowserPageTruth {
  if (!exactRecord(value, ["page", "target", "verification", "surface"])) return false;
  return validPage(value.page, true) &&
    validTarget(value.target) &&
    ["not_required", "required", "verified", "unknown"].includes(value.verification as string) &&
    ["primary", "popup"].includes(value.surface as string);
}

function validPage(value: unknown, browser: boolean): boolean {
  if (!exactRecord(value, ["id", "kind"]) || typeof value.id !== "string") return false;
  const kinds = browser
    ? [...Object.keys(recoveryPageOrder), "unknown", "ambiguous"]
    : Object.keys(recoveryPageOrder);
  return kinds.includes(value.kind as string);
}

function validTarget(value: unknown): boolean {
  return exactRecord(value, ["schemaVersion", "atsFamily", "hostId", "tenantId", "postingId"]) &&
    value.schemaVersion === 1 && value.atsFamily === "workday" &&
    [value.hostId, value.tenantId, value.postingId].every((part) => typeof part === "string");
}

function validAttempts(value: unknown): boolean {
  if (!exactRecord(value, [
    "reload", "stale_handle", "transient_network", "popup", "interrupted_process", "total",
  ])) return false;
  return Object.values(value).every((attempt) =>
    Number.isSafeInteger(attempt) && Number(attempt) >= 0
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  return actual.length === keys.length &&
    keys.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    });
}
