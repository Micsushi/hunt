"use strict";

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { URLSearchParams } = require("node:url");

const DEFAULT_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function requestJson(url, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body ? Buffer.from(body) : null;
    const req = https.request(
      {
        method,
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            reject(new Error(`Invalid JSON response: ${text.slice(0, 300)}`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(`HTTP ${res.statusCode}: ${JSON.stringify(data)}`),
            );
            return;
          }
          resolve(data);
        });
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function readGmailClientConfig(credentialsPath) {
  const resolved =
    credentialsPath || process.env.HUNT_C3_GMAIL_CREDENTIALS_PATH || "";
  if (!resolved) {
    throw new Error("HUNT_C3_GMAIL_CREDENTIALS_PATH is required.");
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const config = parsed.installed || parsed.web;
  if (!config?.client_id || !config?.client_secret) {
    throw new Error(
      "Gmail OAuth client JSON is missing client_id or client_secret.",
    );
  }
  return config;
}

function tokenPathFor(tokenDir, email) {
  const safe = String(email || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.@-]/g, "_");
  return path.join(tokenDir, `${safe}.json`);
}

async function refreshGmailAccessToken(config, saved) {
  if (!saved?.token?.refresh_token) {
    throw new Error("Saved Gmail token does not include a refresh_token.");
  }
  const token = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      refresh_token: saved.token.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  return {
    ...saved.token,
    ...token,
  };
}

function gmailTokenSettings(request = {}) {
  const email =
    process.env.HUNT_C3_GMAIL_ACCOUNT_EMAIL ||
    process.env.HUNT_C3_MAIL_EMAIL ||
    request.email ||
    "";
  const tokenDir =
    process.env.HUNT_C3_GMAIL_TOKEN_DIR || "secrets/gmail-tokens";
  return {
    email,
    tokenDir,
    tokenPath: tokenPathFor(tokenDir, email),
  };
}

async function gmailAuthorizedToken(request = {}) {
  const { email, tokenPath } = gmailTokenSettings(request);
  if (!email) {
    throw new Error("Gmail account email is required.");
  }
  const config = readGmailClientConfig(request.credentialsPath);
  const saved = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  const token = await refreshGmailAccessToken(config, saved);
  const profile = await requestJson(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
    },
  );
  if (profile.emailAddress.toLowerCase() !== email.toLowerCase()) {
    throw new Error(
      `Authorized ${profile.emailAddress}, but expected ${email}.`,
    );
  }
  fs.writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        ...saved,
        email: profile.emailAddress,
        scope:
          saved.scope ||
          process.env.HUNT_C3_GMAIL_SCOPES ||
          DEFAULT_GMAIL_SCOPE,
        token,
        refreshedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return { email: profile.emailAddress, token };
}

async function verifyGmailAccess(token, expectedAccount) {
  const profile = await requestJson(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
    },
  );
  if (
    expectedAccount &&
    profile.emailAddress.toLowerCase() !== expectedAccount.toLowerCase()
  ) {
    throw new Error(
      `Authorized ${profile.emailAddress}, but expected ${expectedAccount}.`,
    );
  }
  const messages = await requestJson(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
    },
  );
  return {
    email: profile.emailAddress,
    messagesVisible: Array.isArray(messages.messages)
      ? messages.messages.length
      : 0,
  };
}

module.exports = {
  DEFAULT_GMAIL_SCOPE,
  gmailAuthorizedToken,
  gmailTokenSettings,
  readGmailClientConfig,
  refreshGmailAccessToken,
  requestJson,
  tokenPathFor,
  verifyGmailAccess,
};
