import {
  GmailProviderFailure,
  parseGmailMessage,
  parseMessageIds,
  type ParsedGmailMessage,
} from "./http-parser.ts";

const productionBase = "https://gmail.googleapis.com/gmail/v1/users/me";
const maximumResponseBytes = 1_048_576;

export interface GmailHttpClientOptions {
  readonly baseUrl?: string;
  readonly allowLoopbackHttp?: boolean;
}
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

export class GmailHttpClient {
  readonly #baseUrl: URL;

  constructor(options: GmailHttpClientOptions = {}) {
    this.#baseUrl = approvedBaseUrl(
      options.baseUrl ?? productionBase,
      options.allowLoopbackHttp === true,
    );
  }

  async query(
    authority: GmailQueryAuthority,
    window: GmailQueryWindow,
    signal: AbortSignal,
  ): Promise<readonly ParsedGmailMessage[]> {
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
    const ids = parseMessageIds(
      await this.#request(listUrl, authority.accessValue, signal),
    );
    const output: ParsedGmailMessage[] = [];
    for (const id of ids) {
      if (signal.aborted) throw new GmailProviderFailure("operation_cancelled");
      const messageUrl = new URL(
        `${this.#baseUrl.toString()}/messages/${encodeURIComponent(id)}`,
      );
      messageUrl.searchParams.set("format", "full");
      const parsed = parseGmailMessage(
        await this.#request(messageUrl, authority.accessValue, signal),
        { ...authority, ...window },
      );
      if (parsed !== null) output.push(parsed);
    }
    return output;
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
      const bytes = new Uint8Array(await response.arrayBuffer());
      try {
        if (bytes.byteLength > maximumResponseBytes) {
          throw new GmailProviderFailure("mailbox_query_invalid");
        }
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
