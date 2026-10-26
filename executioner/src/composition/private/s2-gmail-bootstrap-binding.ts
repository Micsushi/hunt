import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute, normalize } from "node:path";

const EXACT_KEYS = [
  "schemaVersion",
  "contractRevision",
  "revisionId",
  "journeyId",
  "gmailHandleId",
  "desktopClientId",
  "installedClientConfigPath",
  "senderPolicyConfigPath",
  "verificationHost",
].sort();

export interface GmailBootstrapExpectedBinding {
  readonly revisionId: string;
  readonly journeyId: string;
  readonly gmailHandleId: string;
}

export interface GmailBootstrapInputV3 extends GmailBootstrapExpectedBinding {
  readonly schemaVersion: 1;
  readonly contractRevision: "s2-gmail-bootstrap-v3";
  readonly desktopClientId: string;
  readonly installedClientConfigPath: string;
  readonly senderPolicyConfigPath: string;
  readonly verificationHost: string;
}

export function admitGmailBootstrapInput(
  value: unknown,
  expected: GmailBootstrapExpectedBinding,
): GmailBootstrapInputV3 | null {
  if (!record(value) || !exactKeys(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    value.contractRevision !== "s2-gmail-bootstrap-v3" ||
    value.revisionId !== expected.revisionId ||
    value.journeyId !== expected.journeyId ||
    value.gmailHandleId !== expected.gmailHandleId ||
    typeof value.desktopClientId !== "string" ||
    !/^\d{6,32}-[A-Za-z0-9_-]{8,128}\.apps\.googleusercontent\.com$/u.test(
      value.desktopClientId,
    ) ||
    typeof value.installedClientConfigPath !== "string" ||
    value.installedClientConfigPath.length > 4096 ||
    !isAbsolute(value.installedClientConfigPath) ||
    normalize(value.installedClientConfigPath) !== value.installedClientConfigPath ||
    typeof value.senderPolicyConfigPath !== "string" ||
    value.senderPolicyConfigPath.length > 4096 ||
    !isAbsolute(value.senderPolicyConfigPath) ||
    normalize(value.senderPolicyConfigPath) !== value.senderPolicyConfigPath ||
    value.senderPolicyConfigPath.toLowerCase() === value.installedClientConfigPath.toLowerCase() ||
    typeof value.verificationHost !== "string" ||
    !validHost(value.verificationHost)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    contractRevision: "s2-gmail-bootstrap-v3",
    revisionId: value.revisionId,
    journeyId: value.journeyId,
    gmailHandleId: value.gmailHandleId,
    desktopClientId: value.desktopClientId,
    installedClientConfigPath: value.installedClientConfigPath,
    senderPolicyConfigPath: value.senderPolicyConfigPath,
    verificationHost: value.verificationHost,
  });
}

export function deriveSenderPolicyId(
  binding: GmailBootstrapExpectedBinding & { readonly recipientBindingId?: string },
): `sender_policy_${string}` {
  const digest = createHash("sha256")
    .update("hunt-s2-sender-policy-v1\0", "utf8")
    .update(binding.revisionId, "utf8")
    .update("\0", "utf8")
    .update(binding.journeyId, "utf8")
    .update("\0", "utf8")
    .update(binding.gmailHandleId, "utf8")
    .update("\0", "utf8")
    .update(binding.recipientBindingId ?? "", "utf8")
    .digest("hex")
    .slice(0, 32);
  return `sender_policy_${digest}`;
}

function exactKeys(value: Record<string, unknown>): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(EXACT_KEYS);
}

function validHost(value: string): boolean {
  return isIP(value) === 0 && value === value.toLowerCase() &&
    value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
