import { createHash } from "node:crypto";

import {
  GmailProviderFailure,
  type GmailMessageTraceEvent,
  parseGmailMessage,
  parseMessageIds,
  type ParsedGmailMessage,
} from "./http-parser.ts";

const productionBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const maximumResponseBytes = 1_048_576;

export interface GmailHttpClientOptions {
  readonly baseUrl?: string;
  readonly allowLoopbackHttp?: boolean;
  readonly trace?: (event: GmailHttpClientTraceEvent) => void;
}

export type GmailHttpClientTraceEvent =
  | GmailMessageTraceEvent
  | "gmail_list_parse_started"
  | "gmail_list_parse_succeeded"
  | "gmail_list_parse_failed"
  | "gmail_message_parse_started"
  | "gmail_message_parse_succeeded"
  | "gmail_message_parse_skipped"
  | "gmail_message_parse_failed";
export interface GmailQueryAuthority {
  readonly accessValue: string;
  readonly senderAddress: string;
  readonly recipientAddress: string;
  readonly verificationHost: string;
  readonly verificationTtlSeconds: number;
}

export interface GmailQueryWindow {
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface QueriedGmailMessage extends ParsedGmailMessage {
  readonly replayCoordinate: Uint8Array;
}

export class GmailHttpClient {
  readonly #baseUrl: URL;
  readonly #trace: ((event: GmailHttpClientTraceEvent) => void) | undefined;

  constructor(options: GmailHttpClientOptions = {}) {
    this.#baseUrl = approvedBaseUrl(
      options.baseUrl ?? productionBase,
      options.allowLoopbackHttp === true,
    );
    this.#trace = options.trace;
  }

  async query(
    authority: GmailQueryAuthority,
    window: GmailQueryWindow,
    signal: AbortSignal,
  ): Promise<readonly QueriedGmailMessage[]> {
    const listUrl = new URL(`${this.#baseUrl.toString()}/messages`);
    listUrl.searchParams.set("maxResults", "2");
    listUrl.searchParams.set(
      "q",
      [
        `from:${authority.senderAddress}`,
        `to:${authority.recipientAddress}`,
        `after:${Math.floor(Date.parse(window.notBefore) / 1_000)}`,
        `before:${Math.ceil(Date.parse(window.notAfter) / 1_000)}`,
      ].join(" "),
    );
    this.#emit("gmail_list_parse_started");
    let ids: readonly string[];
    try {
      ids = parseMessageIds(
        await this.#request(listUrl, authority.accessValue, signal),
      );
      this.#emit("gmail_list_parse_succeeded");
    } catch (error) {
      this.#emit("gmail_list_parse_failed");
      throw error;
    }
    const output: QueriedGmailMessage[] = [];
    for (const id of ids) {
      if (signal.aborted) throw new GmailProviderFailure("operation_cancelled");
      const messageUrl = new URL(
        `${this.#baseUrl.toString()}/messages/${encodeURIComponent(id)}`,
      );
      messageUrl.searchParams.set("format", "full");
      this.#emit("gmail_message_parse_started");
      try {
        const parsed = parseGmailMessage(
          await this.#request(messageUrl, authority.accessValue, signal),
          { ...authority, ...window },
          (event) => this.#emit(event),
        );
        this.#emit(
          parsed === null
            ? "gmail_message_parse_skipped"
            : "gmail_message_parse_succeeded",
        );
        if (parsed !== null) {
          output.push({
            ...parsed,
            replayCoordinate: opaqueReplayCoordinate(id),
          });
        }
      } catch (error) {
        this.#emit("gmail_message_parse_failed");
        throw error;
      }
    }
    return output;
  }

  #emit(event: GmailHttpClientTraceEvent): void {
    try {
      this.#trace?.(event);
    } catch {
      // Diagnostic tracing cannot alter mailbox behavior.
    }
  }

  async #request(
    url: URL,
    accessValue: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw new GmailProviderFailure("operation_cancelled");
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessValue}`,
        },
        redirect: "error",
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new GmailProviderFailure("gmail_auth_denied");
      }
      if (response.status === 429) {
        throw new GmailProviderFailure("gmail_rate_limited");
      }
      if (!response.ok) {
        throw new GmailProviderFailure("gmail_network_unavailable");
      }
      const bytes = await readBoundedResponse(response, signal);
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (error) {
        if (error instanceof GmailProviderFailure) throw error;
        throw new GmailProviderFailure("mailbox_query_invalid");
      } finally {
        bytes.fill(0);
      }
    } catch (error) {
      if (error instanceof GmailProviderFailure) throw error;
      throw new GmailProviderFailure(
        signal.aborted ? "operation_cancelled" : "gmail_network_unavailable",
      );
    }
  }
}

function opaqueReplayCoordinate(providerIdentity: string): Uint8Array {
  return Uint8Array.from(
    createHash("sha256")
      .update("hunt-gmail-provider-record-v1\u0000", "utf8")
      .update(providerIdentity, "utf8")
      .digest(),
  );
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > maximumResponseBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailProviderFailure("mailbox_query_invalid");
  }

  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const output = new Uint8Array(maximumResponseBytes);
  let length = 0;
  let completed = false;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new GmailProviderFailure("operation_cancelled");
      }
      const { done, value } = await reader.read();
      if (done) break;
      try {
        if (length + value.byteLength > maximumResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new GmailProviderFailure("mailbox_query_invalid");
        }
        output.set(value, length);
        length += value.byteLength;
      } finally {
        value.fill(0);
      }
    }
    completed = true;
    return output.subarray(0, length);
  } finally {
    reader.releaseLock();
    if (!completed) output.fill(0);
  }
}

function approvedBaseUrl(value: string, allowLoopbackHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("invalid Gmail API base URL");
  }
  const loopback = url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.endsWith("/") ||
    (url.toString() !== productionBase && !(allowLoopbackHttp && loopback))
  ) {
    throw new TypeError("invalid Gmail API base URL");
  }
  return url;
}
