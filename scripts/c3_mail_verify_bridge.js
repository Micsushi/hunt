#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const { gmailAuthorizedToken, requestJson } = require("./lib/c3_gmail_oauth");

const DEFAULT_PORT = 8765;

function loadDotEnv(filePath = ".env") {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {
    provider: process.env.HUNT_C3_MAIL_PROVIDER || "fake",
    port: Number(process.env.HUNT_C3_MAIL_BRIDGE_PORT || DEFAULT_PORT),
    serve: false,
    once: false,
    checkAuth: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--provider" && next) {
      args.provider = next;
      i += 1;
    } else if (arg === "--port" && next) {
      args.port = Number(next);
      i += 1;
    } else if (arg === "--serve") {
      args.serve = true;
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--check-auth") {
      args.checkAuth = true;
    } else if (arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.serve && !args.once && !args.checkAuth) {
    args.serve = true;
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/c3_mail_verify_bridge.js [--serve|--once] [options]",
    "",
    "Options:",
    "  --provider fake|imap|gmail  Mail source, default env HUNT_C3_MAIL_PROVIDER or fake",
    "  --port <port>         HTTP bridge port, default 8765",
    "  --once                Read one JSON request from stdin and print JSON",
    "  --check-auth          Check mailbox credentials without reading links",
    "  --serve               Serve POST /verify-email",
  ].join("\n");
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
}

function quoteImapString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function decodeBase64Url(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function gmailQuerySince(since) {
  const date = since instanceof Date ? since : new Date(since);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `after:${year}/${month}/${day}`;
}

function imapDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function hostAllowed(host, allowlist) {
  const normalized = normalizeHost(host);
  if (!allowlist.length) {
    return true;
  }
  return allowlist.some((allowed) => {
    const clean = normalizeHost(allowed);
    return normalized === clean || normalized.endsWith(`.${clean}`);
  });
}

function requestExpectedHosts(request) {
  const fromRequest = Array.isArray(request.expectedDomains)
    ? request.expectedDomains
    : [];
  return fromRequest
    .concat(splitCsv(process.env.HUNT_C3_MAIL_LINK_HOST_ALLOWLIST))
    .map(normalizeHost)
    .filter(Boolean);
}

function safeVerificationLinks(text, request, { allowInsecure = false } = {}) {
  const expectedHosts = requestExpectedHosts(request);
  const matches = String(text || "").match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const seen = new Set();
  const candidates = [];
  for (const raw of matches) {
    let url;
    try {
      url = new URL(raw.replace(/[),.;]+$/g, ""));
    } catch {
      continue;
    }
    const key = url.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const lowerUrl = key.toLowerCase();
    if (
      lowerUrl.includes("unsubscribe") ||
      lowerUrl.includes("preference") ||
      lowerUrl.includes("privacy") ||
      lowerUrl.includes("reset-password") ||
      lowerUrl.includes("password-reset")
    ) {
      continue;
    }
    if (url.protocol !== "https:" && !allowInsecure) {
      continue;
    }
    if (!hostAllowed(url.hostname, expectedHosts)) {
      continue;
    }
    const contextIndex = Math.max(0, String(text).indexOf(raw) - 120);
    const context = String(text)
      .slice(contextIndex, contextIndex + raw.length + 240)
      .toLowerCase();
    if (!/(verify|confirm|activate|complete|account)/i.test(context)) {
      continue;
    }
    candidates.push(key);
  }
  return candidates;
}

function isLikelyPhoneNumber(digits) {
  return /^1?[2-9]\d{9}$/.test(digits) || /^(\d)\1{3,}$/.test(digits);
}

function verificationCodeCandidates(text) {
  const decoded = String(text || "").replace(/=\r?\n/g, "");
  const candidates = [];
  const patterns = [
    /(?:verification|verify|identity|one[-\s]?time|pass\s*code|passcode|otp|security)\D{0,80}\b(\d[\d\s-]{3,14}\d)\b/gi,
    /\b(\d[\d\s-]{3,14}\d)\b\D{0,80}(?:verification|verify|identity|one[-\s]?time|pass\s*code|passcode|otp|security)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(decoded))) {
      const code = String(match[1] || "").replace(/\D/g, "");
      if (code.length >= 4 && code.length <= 8 && !isLikelyPhoneNumber(code)) {
        candidates.push(code);
      }
    }
  }
  return [...new Set(candidates)];
}

function verificationResultFromMessage({
  decoded,
  request,
  source,
  receivedAt,
}) {
  const links = [...new Set(safeVerificationLinks(decoded, request))];
  const subjectMatch = String(decoded || "").match(/^Subject:\s*(.+)$/im);
  const subject = subjectMatch ? subjectMatch[1].trim() : "";
  if (links.length === 1) {
    return {
      ok: true,
      method: "link",
      link: links[0],
      source,
      subject,
      receivedAt: receivedAt.toISOString(),
    };
  }
  if (links.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: "Multiple safe verification links matched.",
    };
  }
  const codes = verificationCodeCandidates(decoded);
  if (codes.length === 1) {
    return {
      ok: true,
      method: "code",
      code: codes[0],
      source,
      subject,
      receivedAt: receivedAt.toISOString(),
    };
  }
  if (codes.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: "Multiple verification codes matched.",
    };
  }
  return null;
}

async function verifyFake(request) {
  const link =
    process.env.HUNT_C3_FAKE_VERIFY_LINK ||
    request.fakeVerifyLink ||
    "http://127.0.0.1:8766/email_verified.html";
  const code = process.env.HUNT_C3_FAKE_VERIFY_CODE || request.fakeVerifyCode;
  if (code) {
    return {
      ok: true,
      method: "code",
      code: String(code).replace(/\D/g, ""),
      source: "fake",
      subject: "Verification Code",
      receivedAt: new Date().toISOString(),
    };
  }
  const url = new URL(link);
  if (request.email && !url.searchParams.has("email")) {
    url.searchParams.set("email", request.email);
  }
  return {
    ok: true,
    method: "link",
    link: url.toString(),
    source: "fake",
    subject: "Verify your email",
    receivedAt: new Date().toISOString(),
  };
}

function decodeQuotedPrintable(value) {
  return String(value || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-fA-F]{2})/g, (_match, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function imapReadLine(socket, timeoutMs) {
  if (!socket.__huntBuffer) {
    socket.__huntBuffer = Buffer.alloc(0);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("imap_read_timeout"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function tryLine() {
      const index = socket.__huntBuffer.indexOf("\r\n");
      if (index >= 0) {
        const line = socket.__huntBuffer.subarray(0, index).toString("utf8");
        socket.__huntBuffer = socket.__huntBuffer.subarray(index + 2);
        cleanup();
        resolve(line);
        return true;
      }
      return false;
    }
    function onData(chunk) {
      socket.__huntBuffer = Buffer.concat([socket.__huntBuffer, chunk]);
      tryLine();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    if (tryLine()) {
      return;
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function imapCommand(socket, tag, command, timeoutMs = 15000) {
  socket.write(`${tag} ${command}\r\n`);
  const lines = [];
  while (true) {
    const line = await imapReadLine(socket, timeoutMs);
    lines.push(line);
    if (line.startsWith(`${tag} OK`)) {
      return { ok: true, lines };
    }
    if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
      return { ok: false, lines };
    }
  }
}

function imapLiteralLength(line) {
  const match = String(line || "").match(/\{(\d+)\}$/);
  return match ? Number(match[1]) : 0;
}

function imapReadBytes(socket, byteCount, timeoutMs) {
  if (!byteCount) {
    return Promise.resolve("");
  }
  if (!socket.__huntBuffer) {
    socket.__huntBuffer = Buffer.alloc(0);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("imap_literal_timeout"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function tryRead() {
      if (socket.__huntBuffer.length >= byteCount) {
        const output = socket.__huntBuffer
          .subarray(0, byteCount)
          .toString("utf8");
        socket.__huntBuffer = socket.__huntBuffer.subarray(byteCount);
        cleanup();
        resolve(output);
        return true;
      }
      return false;
    }
    function onData(chunk) {
      socket.__huntBuffer = Buffer.concat([socket.__huntBuffer, chunk]);
      tryRead();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    if (tryRead()) {
      return;
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function imapFetchPart(socket, sequence, part, timeoutMs = 20000) {
  const tag = `A${Date.now().toString().slice(-6)}`;
  socket.write(`${tag} FETCH ${sequence} ${part}\r\n`);
  let body = "";
  while (true) {
    const line = await imapReadLine(socket, timeoutMs);
    const literalLength = imapLiteralLength(line);
    if (literalLength) {
      body += await imapReadBytes(socket, literalLength, timeoutMs);
      continue;
    }
    if (line.startsWith(`${tag} OK`)) {
      return body;
    }
    if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
      throw new Error(`imap_fetch_failed:${line}`);
    }
  }
}

async function imapFetchBody(socket, sequence, timeoutMs = 30000) {
  return imapFetchPart(socket, sequence, "BODY.PEEK[]", timeoutMs);
}

async function imapFetchHeaders(socket, sequence, timeoutMs = 15000) {
  return imapFetchPart(
    socket,
    sequence,
    "BODY.PEEK[HEADER.FIELDS (DATE TO FROM SUBJECT)]",
    timeoutMs,
  );
}

function imapConnect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(30000);
    socket.on("timeout", () => {
      socket.destroy(new Error("imap_socket_timeout"));
    });
    socket.once("error", reject);
  });
}

async function verifyImap(request) {
  const email = process.env.HUNT_C3_MAIL_EMAIL || request.email || "";
  const password = process.env.HUNT_C3_MAIL_PASSWORD || "";
  const host = process.env.HUNT_C3_MAIL_IMAP_HOST || "";
  const port = Number(process.env.HUNT_C3_MAIL_IMAP_PORT || 993);
  const secure = process.env.HUNT_C3_MAIL_IMAP_SECURE !== "false";
  const mailbox =
    process.env.HUNT_C3_MAIL_IMAP_MAILBOX ||
    (host.includes("gmail") ? "[Gmail]/All Mail" : "INBOX");
  if (!email || !password || !host) {
    return {
      ok: false,
      reason: "mailbox_auth_failed",
      message: "IMAP email, password, and host are required.",
    };
  }
  const timeoutSeconds = Number(
    request.timeoutSeconds || process.env.HUNT_C3_MAIL_MAX_WAIT_SECONDS || 90,
  );
  const maxSearchMessages = Number(
    request.maxSearchMessages ||
      process.env.HUNT_C3_MAIL_MAX_SEARCH_MESSAGES ||
      75,
  );
  const deadline = Date.now() + timeoutSeconds * 1000;
  const since = request.since ? new Date(request.since) : new Date(Date.now());
  const senderAllowlist = splitCsv(process.env.HUNT_C3_MAIL_FROM_ALLOWLIST);

  while (Date.now() < deadline) {
    let socket;
    try {
      socket = await imapConnect({ host, port, secure });
      await imapReadLine(socket, 15000);
      let result = await imapCommand(
        socket,
        "A001",
        `LOGIN ${JSON.stringify(email)} ${JSON.stringify(password)}`,
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: "mailbox_auth_failed",
          message: "IMAP login failed.",
        };
      }
      result = await imapCommand(
        socket,
        "A002",
        `SELECT ${quoteImapString(mailbox)}`,
      );
      if (!result.ok) {
        throw new Error("imap_select_failed");
      }
      // IMAP SEARCH SINCE is date-only and Gmail can bucket late-evening
      // messages by local mailbox date. Search one day wider, then keep the
      // precise receivedAt >= since filter below.
      const imapSearchSince = new Date(since.getTime() - 24 * 60 * 60 * 1000);
      result = await imapCommand(
        socket,
        "A003",
        `SEARCH SINCE ${imapDate(imapSearchSince)}`,
      );
      const searchLine = result.lines.find((line) =>
        line.startsWith("* SEARCH"),
      );
      const ids = String(searchLine || "")
        .replace("* SEARCH", "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        // Gmail All Mail can contain many newer test messages after Workday's
        // original verification email. Do not cap this at a tiny page.
        .slice(-Math.max(12, maxSearchMessages))
        .reverse();
      for (const id of ids) {
        const headers = decodeQuotedPrintable(
          await imapFetchHeaders(socket, id),
        );
        const receivedMatch = headers.match(/^Date:\s*(.+)$/im);
        const receivedAt = receivedMatch
          ? new Date(receivedMatch[1])
          : new Date();
        if (Number.isFinite(receivedAt.getTime()) && receivedAt < since) {
          continue;
        }
        const toMatch = headers.match(/^To:\s*(.+)$/im);
        if (
          request.email &&
          toMatch &&
          !toMatch[1]
            .toLowerCase()
            .includes(String(request.email).toLowerCase())
        ) {
          continue;
        }
        const fromMatch = headers.match(/^(From|Return-Path):\s*(.+)$/im);
        const senderAllowed =
          !senderAllowlist.length ||
          !fromMatch ||
          senderAllowlist.some((hostPart) =>
            fromMatch[2].toLowerCase().includes(hostPart),
          );
        const raw = await imapFetchBody(socket, id);
        const decoded = decodeQuotedPrintable(raw);
        const verification = verificationResultFromMessage({
          decoded,
          request,
          source: "imap",
          receivedAt,
        });
        if (!senderAllowed && !verification) {
          continue;
        }
        if (verification) {
          return verification;
        }
      }
    } catch (error) {
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: "mailbox_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      if (socket) {
        socket.end();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return {
    ok: false,
    reason: "timeout",
    message: "Manual email verification required.",
  };
}

async function checkImapAuth() {
  const email = process.env.HUNT_C3_MAIL_EMAIL || "";
  const password = process.env.HUNT_C3_MAIL_PASSWORD || "";
  const host = process.env.HUNT_C3_MAIL_IMAP_HOST || "";
  const port = Number(process.env.HUNT_C3_MAIL_IMAP_PORT || 993);
  const secure = process.env.HUNT_C3_MAIL_IMAP_SECURE !== "false";
  if (!email || !password || !host) {
    return {
      ok: false,
      provider: "imap",
      reason: "missing_mail_settings",
      message: "IMAP email, password, and host are required.",
      host,
      port,
      secure,
      hasEmail: Boolean(email),
      hasPassword: Boolean(password),
    };
  }
  let socket;
  try {
    socket = await imapConnect({ host, port, secure });
    await imapReadLine(socket, 15000);
    const login = await imapCommand(
      socket,
      "A001",
      `LOGIN ${JSON.stringify(email)} ${JSON.stringify(password)}`,
    );
    if (!login.ok) {
      return {
        ok: false,
        provider: "imap",
        reason: "mailbox_auth_failed",
        message: "IMAP login failed.",
        host,
        port,
        secure,
      };
    }
    const select = await imapCommand(socket, "A002", "SELECT INBOX");
    return {
      ok: select.ok,
      provider: "imap",
      reason: select.ok ? "" : "mailbox_select_failed",
      message: select.ok
        ? "IMAP login and INBOX access succeeded."
        : "IMAP login succeeded but INBOX could not be selected.",
      host,
      port,
      secure,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "imap",
      reason: "mailbox_connection_failed",
      message: error instanceof Error ? error.message : String(error),
      host,
      port,
      secure,
    };
  } finally {
    if (socket) {
      socket.end();
    }
  }
}

async function verifyGmail(request) {
  const timeoutSeconds = Number(
    request.timeoutSeconds || process.env.HUNT_C3_MAIL_MAX_WAIT_SECONDS || 90,
  );
  const deadline = Date.now() + timeoutSeconds * 1000;
  const since = request.since ? new Date(request.since) : new Date(Date.now());
  const senderAllowlist = splitCsv(process.env.HUNT_C3_MAIL_FROM_ALLOWLIST);
  let auth;
  try {
    auth = await gmailAuthorizedToken(request);
  } catch (error) {
    return {
      ok: false,
      reason: "mailbox_auth_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  while (Date.now() < deadline) {
    try {
      const q = gmailQuerySince(since);
      const listUrl = new URL(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      );
      listUrl.searchParams.set("maxResults", "12");
      if (q) {
        listUrl.searchParams.set("q", q);
      }
      const listed = await requestJson(listUrl.toString(), {
        headers: { Authorization: `Bearer ${auth.token.access_token}` },
      });
      const messages = Array.isArray(listed.messages) ? listed.messages : [];
      for (const message of messages) {
        const detail = await requestJson(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=raw`,
          {
            headers: { Authorization: `Bearer ${auth.token.access_token}` },
          },
        );
        const receivedAt = detail.internalDate
          ? new Date(Number(detail.internalDate))
          : new Date();
        if (Number.isFinite(receivedAt.getTime()) && receivedAt < since) {
          continue;
        }
        const raw = decodeBase64Url(detail.raw);
        const toMatch = raw.match(/^To:\s*(.+)$/im);
        if (
          request.email &&
          toMatch &&
          !toMatch[1]
            .toLowerCase()
            .includes(String(request.email).toLowerCase())
        ) {
          continue;
        }
        const fromMatch = raw.match(/^(From|Return-Path):\s*(.+)$/im);
        const senderAllowed =
          !senderAllowlist.length ||
          !fromMatch ||
          senderAllowlist.some((hostPart) =>
            fromMatch[2].toLowerCase().includes(hostPart),
          );
        const decoded = decodeQuotedPrintable(raw);
        const verification = verificationResultFromMessage({
          decoded,
          request,
          source: "gmail",
          receivedAt,
        });
        if (!senderAllowed && !verification) {
          continue;
        }
        if (verification) {
          return verification;
        }
      }
    } catch (error) {
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: "mailbox_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return {
    ok: false,
    reason: "timeout",
    message: "Manual email verification required.",
  };
}

async function checkGmailAuth() {
  try {
    const auth = await gmailAuthorizedToken();
    const listed = await requestJson(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
      {
        headers: { Authorization: `Bearer ${auth.token.access_token}` },
      },
    );
    return {
      ok: true,
      provider: "gmail",
      email: auth.email,
      message: "Gmail token refresh and messages.list succeeded.",
      visibleMessages: Array.isArray(listed.messages)
        ? listed.messages.length
        : 0,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "gmail",
      reason: "mailbox_auth_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkMailAuth(options = {}) {
  const provider = String(
    options.provider || process.env.HUNT_C3_MAIL_PROVIDER || "fake",
  ).toLowerCase();
  if (provider === "fake") {
    return {
      ok: true,
      provider: "fake",
      message: "Fake provider does not require mailbox authentication.",
    };
  }
  if (provider === "imap") {
    return checkImapAuth();
  }
  if (provider === "gmail") {
    return checkGmailAuth();
  }
  return {
    ok: false,
    provider,
    reason: "unsupported_provider",
    message: `Unsupported mail provider: ${provider}`,
  };
}

async function verifyEmail(request = {}, options = {}) {
  const provider = String(
    options.provider ||
      request.provider ||
      process.env.HUNT_C3_MAIL_PROVIDER ||
      "fake",
  ).toLowerCase();
  if (provider === "fake") {
    return verifyFake(request);
  }
  if (provider === "imap") {
    return verifyImap(request);
  }
  if (provider === "gmail") {
    return verifyGmail(request);
  }
  return {
    ok: false,
    reason: "unsupported_provider",
    message: `Unsupported mail provider: ${provider}`,
  };
}

function readStdinJson() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) {
        req.destroy(new Error("request_too_large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function startServer(args) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, provider: args.provider });
      return;
    }
    if (req.method !== "POST" || req.url !== "/verify-email") {
      sendJson(res, 404, { ok: false, reason: "not_found" });
      return;
    }
    try {
      const request = await readRequestJson(req);
      const result = await verifyEmail(request, { provider: args.provider });
      sendJson(res, result.ok ? 200 : 422, result);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        reason: "bridge_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.listen(args.port, "127.0.0.1", () => {
    console.log(
      `C3 mail verify bridge listening on http://127.0.0.1:${args.port} provider=${args.provider}`,
    );
  });
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.checkAuth) {
    const result = await checkMailAuth({ provider: args.provider });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (args.once) {
    const request = await readStdinJson();
    const result = await verifyEmail(request, { provider: args.provider });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  startServer(args);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  checkMailAuth,
  safeVerificationLinks,
  verificationCodeCandidates,
  verifyEmail,
};
