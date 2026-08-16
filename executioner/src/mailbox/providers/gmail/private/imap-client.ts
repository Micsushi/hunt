import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const maximumOutputBytes = 1_048_576;
const timeoutMs = 30_000;

const imapQueryScript = String.raw`
import email
import hashlib
import html
import imaplib
import json
import re
import sys
from datetime import datetime, timezone
from email.policy import default
from email.utils import getaddresses, parsedate_to_datetime
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

def fail(code):
    raise SystemExit(code)

def verification_url(content, expected_host):
    found = set()
    marker = re.compile(r'(verify|verification|activate|activation|confirm|confirmation)', re.I)
    for raw in re.findall(r'https://[^\s"\'<>]+', html.unescape(content)):
        try:
            value = urlsplit(raw)
            if value.scheme != 'https' or value.hostname.lower() != expected_host or value.port is not None:
                continue
            if value.username is not None or value.password is not None or value.fragment:
                continue
            token = any((marker.search(name) or re.search(r'(token|code|key)', name, re.I)) and val for name, val in parse_qsl(value.query, keep_blank_values=True))
            segments = [unquote(part) for part in value.path.split('/') if part]
            marker_index = next((i for i, part in enumerate(segments) if marker.search(part)), -1)
            if not token and not (marker_index >= 0 and marker_index < len(segments) - 1):
                continue
            found.add(urlunsplit(value))
        except Exception:
            continue
    return next(iter(found)) if len(found) == 1 else None

request_bytes = bytearray(sys.stdin.buffer.read(65537))
try:
    if len(request_bytes) < 2 or len(request_bytes) > 65536:
        fail(4)
    request = json.loads(request_bytes.decode('utf-8'))
    if sorted(request) != ['accountPassword','companyName','notAfter','notBefore','recipientAddress','verificationHost']:
        fail(4)
    start = datetime.fromisoformat(request['notBefore'].replace('Z', '+00:00'))
    end = datetime.fromisoformat(request['notAfter'].replace('Z', '+00:00'))
    client = None
    try:
        client = imaplib.IMAP4_SSL('imap.gmail.com', 993, timeout=20)
        status, _ = client.login(request['recipientAddress'], request['accountPassword'])
        if status != 'OK':
            fail(2)
        status, _ = client.select('INBOX', readonly=True)
        if status != 'OK':
            fail(3)
        since = start.strftime('%d-%b-%Y')
        before = datetime.fromtimestamp(end.timestamp() + 86400, timezone.utc).strftime('%d-%b-%Y')
        status, data = client.search(None, 'SINCE', since, 'BEFORE', before, 'TO', '"' + request['recipientAddress'] + '"')
        if status != 'OK' or len(data) != 1:
            fail(3)
        ids = data[0].split() if data[0] else []
        if len(ids) > 16:
            fail(4)
        output = []
        for message_id in ids:
            status, fetched = client.fetch(message_id, '(BODY.PEEK[] INTERNALDATE)')
            if status != 'OK':
                fail(3)
            raw = next((item[1] for item in fetched if isinstance(item, tuple) and isinstance(item[1], bytes)), None)
            if raw is None or len(raw) < 1 or len(raw) > 1048576:
                fail(4)
            message = email.message_from_bytes(raw, policy=default)
            received = parsedate_to_datetime(message.get('Date'))
            if received is None:
                continue
            if received.tzinfo is None:
                received = received.replace(tzinfo=timezone.utc)
            received = received.astimezone(timezone.utc)
            if received < start or received > end:
                continue
            addresses = [address.lower() for _, address in getaddresses(message.get_all('To', []))]
            if request['recipientAddress'] not in addresses:
                continue
            parts = []
            if message.is_multipart():
                for part in message.walk():
                    if part.get_content_type() not in ('text/plain', 'text/html'):
                        continue
                    value = part.get_content()
                    if isinstance(value, str):
                        parts.append(value)
            else:
                value = message.get_content()
                if isinstance(value, str):
                    parts.append(value)
            content = '\n'.join([str(message.get('Subject', ''))] + parts)
            if request['companyName'].casefold() not in content.casefold():
                continue
            target = verification_url(content, request['verificationHost'])
            if target is None:
                continue
            output.append({
                'receivedAt': received.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                'replayIdentity': hashlib.sha256(b'hunt-gmail-imap-record-v1\0' + message_id).hexdigest(),
                'verificationTarget': target,
            })
        sys.stdout.write(json.dumps({'messages': output}, separators=(',', ':')))
    except imaplib.IMAP4.error:
        fail(2)
    except (OSError, TimeoutError):
        fail(3)
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass
finally:
    for index in range(len(request_bytes)):
        request_bytes[index] = 0
`;

export interface GmailImapQueryAuthority {
  readonly accountPassword: string;
  readonly companyName: string;
  readonly recipientAddress: string;
  readonly verificationHost: string;
}

export interface GmailImapQueryWindow {
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface QueriedGmailImapMessage {
  readonly receivedAt: string;
  readonly verificationTarget: Uint8Array;
  readonly replayCoordinate: Uint8Array;
}

export class GmailImapFailure extends Error {
  readonly code: "operation_cancelled" | "gmail_auth_denied" | "gmail_network_unavailable" | "mailbox_query_invalid";

  constructor(code: GmailImapFailure["code"]) {
    super(code);
    this.code = code;
  }
}

export class GmailImapClient {
  readonly #executable: string;

  constructor(executable = "python.exe") {
    this.#executable = executable;
  }

  async query(
    authority: GmailImapQueryAuthority,
    window: GmailImapQueryWindow,
    signal: AbortSignal,
  ): Promise<readonly QueriedGmailImapMessage[]> {
    if (signal.aborted) throw new GmailImapFailure("operation_cancelled");
    const input = encodeGmailImapQueryRequest(authority, window);
    try {
      const output = await this.#run(input, signal);
      try {
        return parseOutput(output, authority.verificationHost, window);
      } finally {
        output.fill(0);
      }
    } finally {
      input.fill(0);
    }
  }

  #run(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, ["-c", imapQueryScript], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: GmailImapFailure, value?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        for (const chunk of chunks) chunk.fill(0);
        if (error !== undefined) reject(error);
        else resolve(value!);
      };
      const cancel = () => {
        child.kill();
        finish(new GmailImapFailure("operation_cancelled"));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new GmailImapFailure("gmail_network_unavailable"));
      }, timeoutMs);
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", () => finish(new GmailImapFailure("gmail_network_unavailable")));
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maximumOutputBytes) {
          chunk.fill(0);
          child.kill();
          finish(new GmailImapFailure("mailbox_query_invalid"));
          return;
        }
        chunks.push(Buffer.from(chunk));
        chunk.fill(0);
      });
      child.once("close", (code) => {
        if (code !== 0) {
          finish(new GmailImapFailure(code === 2 ? "gmail_auth_denied" : code === 4 ? "mailbox_query_invalid" : "gmail_network_unavailable"));
          return;
        }
        const output = Buffer.concat(chunks);
        finish(undefined, new Uint8Array(output));
        output.fill(0);
      });
      child.stdin.once("error", () => undefined);
      child.stdin.end(input);
    });
  }
}

export function encodeGmailImapQueryRequest(
  authority: GmailImapQueryAuthority,
  window: GmailImapQueryWindow,
): Buffer {
  return Buffer.from(JSON.stringify({
    accountPassword: authority.accountPassword,
    companyName: authority.companyName,
    notAfter: window.notAfter,
    notBefore: window.notBefore,
    recipientAddress: authority.recipientAddress,
    verificationHost: authority.verificationHost,
  }), "utf8");
}

function parseOutput(
  bytes: Uint8Array,
  expectedHost: string,
  window: GmailImapQueryWindow,
): readonly QueriedGmailImapMessage[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GmailImapFailure("mailbox_query_invalid");
  }
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.messages) || value.messages.length > 2) {
    throw new GmailImapFailure("mailbox_query_invalid");
  }
  return value.messages.map((message) => {
    if (
      !record(message) ||
      JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(["receivedAt", "replayIdentity", "verificationTarget"]) ||
      typeof message.receivedAt !== "string" ||
      Date.parse(message.receivedAt) < Date.parse(window.notBefore) ||
      Date.parse(message.receivedAt) > Date.parse(window.notAfter) ||
      typeof message.replayIdentity !== "string" || !/^[0-9a-f]{64}$/u.test(message.replayIdentity) ||
      typeof message.verificationTarget !== "string"
    ) throw new GmailImapFailure("mailbox_query_invalid");
    const target = admittedTarget(message.verificationTarget, expectedHost);
    return {
      receivedAt: new Date(message.receivedAt).toISOString(),
      verificationTarget: new TextEncoder().encode(target),
      replayCoordinate: Uint8Array.from(createHash("sha256").update(message.replayIdentity, "ascii").digest()),
    };
  });
}

function admittedTarget(value: string, expectedHost: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== expectedHost || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new GmailImapFailure("mailbox_query_invalid");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
