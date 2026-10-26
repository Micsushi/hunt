import type { TargetIdentityV1 } from "../../../../contracts/live/index.ts";

export interface SealedGmailOauthBundle {
  readonly kind: "oauth";
  readonly accessValue: string;
  readonly companyName: string;
  readonly recipientAddress: string;
  readonly verificationHost: string;
  readonly verificationTtlSeconds: number;
}

export interface SealedGmailImapBundle {
  readonly kind: "imap";
  readonly accountPassword: string;
  readonly companyName: string;
  readonly recipientAddress: string;
  readonly verificationHost: string;
  readonly verificationTtlSeconds: number;
}

export type SealedGmailBundle = SealedGmailOauthBundle | SealedGmailImapBundle;

export class SealedGmailAuthorizationFailure extends Error {
  readonly code: "gmail_auth_denied" | "mailbox_query_invalid";

  constructor(code: SealedGmailAuthorizationFailure["code"]) {
    super(code);
    this.code = code;
  }
}

export function parseSealedGmailBundle(
  bytes: Readonly<Uint8Array>,
  binding: {
    readonly journeyId: string;
    readonly recipientBindingId: string;
    readonly senderPolicyId: string;
    readonly target: TargetIdentityV1;
  },
  approvedPolicy: {
    readonly host: Readonly<Uint8Array>;
    readonly tenant: Readonly<Uint8Array>;
  },
): SealedGmailBundle {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SealedGmailAuthorizationFailure("gmail_auth_denied");
  }
  if (!record(value)) throw new SealedGmailAuthorizationFailure("gmail_auth_denied");
  const commonKeys = [
    "companyName", "format", "journeyId", "recipientAddress",
    "recipientBindingId", "scope", "senderPolicyId", "target",
    "verificationHost", "verificationTenant", "verificationTtlSeconds",
  ];
  const oauth = value.format === "gmail-oauth-bundle-v2";
  const imap = value.format === "gmail-imap-app-password-bundle-v1";
  const exactKeys = [...commonKeys, oauth ? "accessValue" : "accountPassword"].sort();
  if (
    (!oauth && !imap) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(exactKeys) ||
    (oauth && value.scope !== "https://www.googleapis.com/auth/gmail.readonly") ||
    (imap && value.scope !== "gmail.imap.readonly") ||
    (oauth && !secret(value.accessValue)) ||
    (imap && !secret(value.accountPassword)) ||
    typeof value.recipientAddress !== "string" || !email(value.recipientAddress) ||
    typeof value.companyName !== "string" || !company(value.companyName) ||
    typeof value.verificationHost !== "string" || !host(value.verificationHost) ||
    typeof value.verificationTenant !== "string" || !tenant(value.verificationTenant) ||
    !Number.isSafeInteger(value.verificationTtlSeconds) ||
    Number(value.verificationTtlSeconds) < 60 ||
    Number(value.verificationTtlSeconds) > 86_400
  ) throw new SealedGmailAuthorizationFailure("gmail_auth_denied");
  if (
    value.journeyId !== binding.journeyId ||
    value.recipientBindingId !== binding.recipientBindingId ||
    value.senderPolicyId !== binding.senderPolicyId ||
    !sameTarget(value.target, binding.target)
  ) throw new SealedGmailAuthorizationFailure("mailbox_query_invalid");
  let approvedHost: string;
  let approvedTenant: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    approvedHost = decoder.decode(approvedPolicy.host);
    approvedTenant = decoder.decode(approvedPolicy.tenant);
  } catch {
    throw new SealedGmailAuthorizationFailure("mailbox_query_invalid");
  }
  if (
    !host(approvedHost) || !tenant(approvedTenant) ||
    value.verificationHost !== approvedHost || value.verificationTenant !== approvedTenant
  ) throw new SealedGmailAuthorizationFailure("mailbox_query_invalid");
  const common = {
    companyName: value.companyName,
    recipientAddress: value.recipientAddress,
    verificationHost: value.verificationHost,
    verificationTtlSeconds: Number(value.verificationTtlSeconds),
  };
  return oauth
    ? { kind: "oauth", accessValue: value.accessValue as string, ...common }
    : { kind: "imap", accountPassword: value.accountPassword as string, ...common };
}

function sameTarget(value: unknown, expected: TargetIdentityV1): boolean {
  return record(value) && value.schemaVersion === expected.schemaVersion &&
    value.atsFamily === expected.atsFamily && value.hostId === expected.hostId &&
    value.tenantId === expected.tenantId && value.postingId === expected.postingId;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 4_096;
}

function email(value: string): boolean {
  return value === value.toLowerCase() && value.length <= 254 && /^[^\s@]+@[^\s@]+$/u.test(value);
}

function company(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && value === value.trim() && !/[\p{Cc}]/u.test(value);
}

function host(value: string): boolean {
  return value === value.toLowerCase() && value.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}

function tenant(value: string): boolean {
  return value === value.toLowerCase() && value.length >= 1 && value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(value);
}
