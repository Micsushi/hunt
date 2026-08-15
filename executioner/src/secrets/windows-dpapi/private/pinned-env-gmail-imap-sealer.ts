import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

import type { GmailOAuthSealRequest } from "./interactive-gmail-oauth-sealer.ts";
import { decodeAccountCredentialBundleV1 } from "./account-credential-bundle.ts";
import { WindowsDpapiBridge } from "../bridge.ts";

const maximumSourceBytes = 64 * 1024;
const emailPrefix = Buffer.from("HUNT_C3_MAIL_EMAIL=", "ascii");
const passwordPrefix = Buffer.from("HUNT_C3_MAIL_PASSWORD=", "ascii");

export interface WindowsPinnedEnvGmailImapSealerOptions {
  readonly sourcePath: string;
  readonly expectedSha256: string;
  readonly bridge?: WindowsDpapiBridge;
}

export class WindowsPinnedEnvGmailImapSealer {
  readonly #sourcePath: string;
  readonly #expectedSha256: Uint8Array;
  readonly #bridge: WindowsDpapiBridge;

  constructor(options: WindowsPinnedEnvGmailImapSealerOptions) {
    if (
      !isAbsolute(options.sourcePath) ||
      normalize(options.sourcePath) !== options.sourcePath ||
      !/^[0-9a-f]{64}$/u.test(options.expectedSha256)
    ) {
      throw new TypeError("pinned Gmail IMAP migration invalid");
    }
    this.#sourcePath = options.sourcePath;
    this.#expectedSha256 = Buffer.from(options.expectedSha256, "hex");
    this.#bridge = options.bridge ?? new WindowsDpapiBridge();
  }

  async seal(request: GmailOAuthSealRequest, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new Error("Gmail IMAP sealing cancelled");
    const source = await readPinnedSource(this.#sourcePath, this.#expectedSha256);
    let accountPlaintext: Uint8Array | undefined;
    let accountEmail: Uint8Array | undefined;
    let accountPassword: Uint8Array | undefined;
    let mailboxEmail: Uint8Array | undefined;
    let mailboxPassword: Uint8Array | undefined;
    let bundle: Uint8Array | undefined;
    try {
      mailboxEmail = uniqueValue(source, emailPrefix, 320);
      mailboxPassword = uniqueValue(source, passwordPrefix, 4_096);
      accountPlaintext = await this.#bridge.unprotect(
        request.accountCiphertext,
        request.accountMetadata,
        signal,
      );
      const account = decodeAccountCredentialBundleV1(accountPlaintext);
      if (account === null) throw new Error("Gmail IMAP account binding invalid");
      accountEmail = account.email;
      accountPassword = account.password;
      if (!sameBytes(accountEmail, mailboxEmail)) {
        throw new Error("Gmail IMAP account binding invalid");
      }
      const policy = await readCompanyPolicy(request.senderPolicyConfigPath);
      if (
        policy.verificationHost !== request.binding.verificationHost ||
        policy.verificationTenant !== request.binding.verificationTenant
      ) {
        throw new Error("Gmail IMAP policy binding invalid");
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const value = {
        accountPassword: decoder.decode(mailboxPassword),
        companyName: policy.companyName,
        format: "gmail-imap-app-password-bundle-v1",
        journeyId: request.binding.journeyId,
        recipientAddress: decoder.decode(mailboxEmail).toLowerCase(),
        recipientBindingId: request.binding.recipientBindingId,
        scope: "gmail.imap.readonly",
        senderPolicyId: request.binding.senderPolicyId,
        target: request.binding.target,
        verificationHost: request.binding.verificationHost,
        verificationTenant: request.binding.verificationTenant,
        verificationTtlSeconds: request.binding.verificationTtlSeconds,
      } as const;
      bundle = new TextEncoder().encode(JSON.stringify(value));
      return await this.#bridge.protect(bundle, request.gmailMetadata, signal);
    } catch (error) {
      throw new Error(
        signal.aborted ? "Gmail IMAP sealing cancelled" : "Gmail IMAP sealing failed",
        { cause: error },
      );
    } finally {
      source.fill(0);
      accountPlaintext?.fill(0);
      accountEmail?.fill(0);
      accountPassword?.fill(0);
      mailboxEmail?.fill(0);
      mailboxPassword?.fill(0);
      bundle?.fill(0);
    }
  }
}

async function readPinnedSource(path: string, expected: Uint8Array): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumSourceBytes) {
    throw new Error("Gmail IMAP source invalid");
  }
  if (comparable(await realpath(path)) !== comparable(resolve(path))) {
    throw new Error("Gmail IMAP source invalid");
  }
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest();
  try {
    if (!timingSafeEqual(digest, expected)) throw new Error("Gmail IMAP source invalid");
    return new Uint8Array(bytes);
  } finally {
    digest.fill(0);
    bytes.fill(0);
  }
}

function uniqueValue(source: Uint8Array, prefix: Uint8Array, maximum: number): Uint8Array {
  const input = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const matches: Uint8Array[] = [];
  let start = 0;
  for (let cursor = 0; cursor <= input.byteLength; cursor += 1) {
    if (cursor !== input.byteLength && input[cursor] !== 0x0a) continue;
    let end = cursor;
    if (end > start && input[end - 1] === 0x0d) end -= 1;
    const line = input.subarray(start, end);
    if (line.subarray(0, prefix.byteLength).equals(prefix)) {
      const value = line.subarray(prefix.byteLength);
      if (value.byteLength < 1 || value.byteLength > maximum) {
        throw new Error("Gmail IMAP source invalid");
      }
      matches.push(new Uint8Array(value));
    }
    start = cursor + 1;
  }
  if (matches.length !== 1) {
    for (const value of matches) value.fill(0);
    throw new Error("Gmail IMAP source invalid");
  }
  new TextDecoder("utf-8", { fatal: true }).decode(matches[0]);
  return matches[0]!;
}

async function readCompanyPolicy(path: string): Promise<{
  readonly companyName: string;
  readonly verificationHost: string;
  readonly verificationTenant: string;
}> {
  const bytes = await readFile(path);
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
        "companyName", "contractRevision", "schemaVersion", "verificationHost", "verificationTenant",
      ]) ||
      (value as Record<string, unknown>).schemaVersion !== 1 ||
      (value as Record<string, unknown>).contractRevision !== "s2-gmail-company-policy-v1" ||
      typeof (value as Record<string, unknown>).companyName !== "string" ||
      typeof (value as Record<string, unknown>).verificationHost !== "string" ||
      typeof (value as Record<string, unknown>).verificationTenant !== "string"
    ) throw new Error("Gmail IMAP policy invalid");
    return value as {
      readonly companyName: string;
      readonly verificationHost: string;
      readonly verificationTenant: string;
    };
  } finally {
    bytes.fill(0);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function comparable(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}
