export type GmailProviderFailureCode =
  | "operation_cancelled"
  | "gmail_auth_denied"
  | "gmail_rate_limited"
  | "gmail_network_unavailable"
  | "mailbox_query_invalid";

export class GmailProviderFailure extends Error {
  readonly code: GmailProviderFailureCode;

  constructor(code: GmailProviderFailureCode) {
    super(code);
    this.name = "GmailProviderFailure";
    this.code = code;
  }
}

export interface ParsedGmailMessage {
  readonly receivedAt: string;
  readonly verificationTarget: Uint8Array;
}

export function parseMessageIds(value: unknown): readonly string[] {
  if (!record(value)) throw new GmailProviderFailure("mailbox_query_invalid");
  if (!("messages" in value)) return [];
  if (!Array.isArray(value.messages) || value.messages.length > 2) {
    throw new GmailProviderFailure("mailbox_query_invalid");
  }
  return value.messages.map((item) => {
    if (!record(item) || typeof item.id !== "string" || !bounded(item.id, 1, 256)) {
      throw new GmailProviderFailure("mailbox_query_invalid");
    }
    return item.id;
  });
}

export function parseGmailMessage(
  value: unknown,
  expected: {
    readonly senderAddress: string;
    readonly recipientAddress: string;
    readonly verificationHost: string;
    readonly notBefore: string;
    readonly notAfter: string;
    readonly verificationTtlSeconds: number;
  },
): ParsedGmailMessage | null {
  if (
    !record(value) ||
    typeof value.internalDate !== "string" ||
    !/^\d{10,16}$/u.test(value.internalDate) ||
    !record(value.payload)
  ) {
    throw new GmailProviderFailure("mailbox_query_invalid");
  }
  const received = Number(value.internalDate);
  if (!Number.isSafeInteger(received)) {
    throw new GmailProviderFailure("mailbox_query_invalid");
  }
  let receivedAt: string;
  try {
    receivedAt = new Date(received).toISOString();
  } catch {
    throw new GmailProviderFailure("mailbox_query_invalid");
  }
  if (
    received < Date.parse(expected.notBefore) ||
    received > Date.parse(expected.notAfter)
  ) {
    return null;
  }
  const headers = headerMap(value.payload.headers);
  if (
    address(headers.get("from")) !== expected.senderAddress ||
    address(headers.get("to")) !== expected.recipientAddress
  ) {
    return null;
  }
  const target = verificationTarget(value.payload, expected.verificationHost);
  if (target === null) return null;
  return { receivedAt, verificationTarget: target };
}

function headerMap(value: unknown): Map<string, string> {
  if (!Array.isArray(value) || value.length > 64) {
    throw new GmailProviderFailure("mailbox_query_invalid");
  }
  const output = new Map<string, string>();
  for (const header of value) {
    if (
      !record(header) ||
      typeof header.name !== "string" ||
      typeof header.value !== "string" ||
      !bounded(header.name, 1, 64) ||
      !bounded(header.value, 1, 1_024)
    ) {
      throw new GmailProviderFailure("mailbox_query_invalid");
    }
    output.set(header.name.toLowerCase(), header.value);
  }
  return output;
}

function address(value: string | undefined): string | null {
  if (value === undefined) return null;
  const angle = /<([^<>]+)>/u.exec(value)?.[1];
  const candidate = (angle ?? value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/u.test(candidate) ? candidate : null;
}

function verificationTarget(
  payload: Record<string, unknown>,
  expectedHost: string,
): Uint8Array | null {
  const candidates = new Set<string>();
  for (const encoded of bodySegments(payload, 0)) {
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      throw new GmailProviderFailure("mailbox_query_invalid");
    }
    const bytes = Buffer.from(encoded, "base64url");
    try {
      const decoded = bytes.toString("utf8");
      for (const match of decoded.matchAll(/https:\/\/[^\s"'<>]+/gu)) {
        try {
          const rawCandidate = match[0].replaceAll("&amp;", "&");
          if (rawCandidate.length > 4_096) continue;
          const candidate = new URL(rawCandidate);
          const canonical = candidate.toString();
          const decodedCanonical = decodeURI(canonical);
          if (
            canonical.length <= 4_096 &&
            !/[\u0000-\u001f\u007f]/u.test(decodedCanonical) &&
            candidate.protocol === "https:" &&
            candidate.hostname.toLowerCase() === expectedHost &&
            candidate.port === "" &&
            candidate.username === "" &&
            candidate.password === "" &&
            candidate.hash === "" &&
            carriesVerificationToken(candidate)
          ) {
            candidates.add(canonical);
            if (candidates.size > 1) return null;
          }
        } catch {
          // Ignore a malformed candidate and continue within the bounded payload.
        }
      }
    } finally {
      bytes.fill(0);
    }
  }
  if (candidates.size !== 1) return null;
  return new TextEncoder().encode([...candidates][0]);
}

function carriesVerificationToken(candidate: URL): boolean {
  const marker = /(?:verify|verification|activate|activation|confirm|confirmation)/iu;
  for (const [name, value] of candidate.searchParams) {
    if (marker.test(name) || /(?:token|code|key)/iu.test(name)) {
      if (value.length > 0) return true;
    }
  }
  const segments = candidate.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
  const markerIndex = segments.findIndex((segment) => marker.test(segment));
  return markerIndex >= 0 && markerIndex < segments.length - 1;
}

function bodySegments(
  payload: Record<string, unknown>,
  depth: number,
): string[] {
  if (depth > 8) throw new GmailProviderFailure("mailbox_query_invalid");
  const output: string[] = [];
  if (record(payload.body) && typeof payload.body.data === "string") {
    if (!bounded(payload.body.data, 1, 512_000)) {
      throw new GmailProviderFailure("mailbox_query_invalid");
    }
    output.push(payload.body.data);
  }
  if ("parts" in payload) {
    if (!Array.isArray(payload.parts) || payload.parts.length > 32) {
      throw new GmailProviderFailure("mailbox_query_invalid");
    }
    for (const part of payload.parts) {
      if (!record(part)) throw new GmailProviderFailure("mailbox_query_invalid");
      output.push(...bodySegments(part, depth + 1));
    }
  }
  return output;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum;
}
