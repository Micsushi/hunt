#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { URL, URLSearchParams } = require("node:url");

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function parseArgs(argv) {
  const args = {
    credentialsPath: process.env.HUNT_C3_GMAIL_CREDENTIALS_PATH || "",
    tokenDir: process.env.HUNT_C3_GMAIL_TOKEN_DIR || "secrets/gmail-tokens",
    account: process.env.HUNT_C3_GMAIL_ACCOUNT_EMAIL || "",
    scope: process.env.HUNT_C3_GMAIL_SCOPES || DEFAULT_SCOPE,
    port: Number(process.env.HUNT_C3_GMAIL_OAUTH_PORT || 8767),
    useSavedToken: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--credentials" && next) {
      args.credentialsPath = next;
      i += 1;
    } else if (arg === "--token-dir" && next) {
      args.tokenDir = next;
      i += 1;
    } else if (arg === "--account" && next) {
      args.account = next;
      i += 1;
    } else if (arg === "--scope" && next) {
      args.scope = next;
      i += 1;
    } else if (arg === "--port" && next) {
      args.port = Number(next);
      i += 1;
    } else if (arg === "--use-saved-token") {
      args.useSavedToken = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readClientConfig(credentialsPath) {
  if (!credentialsPath) {
    throw new Error("Missing --credentials or HUNT_C3_GMAIL_CREDENTIALS_PATH.");
  }
  const parsed = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  const config = parsed.installed || parsed.web;
  if (!config?.client_id || !config?.client_secret) {
    throw new Error("OAuth client JSON must include installed.client_id and installed.client_secret.");
  }
  return config;
}

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
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${text.slice(0, 300)}`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(data)}`));
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

function waitForCode(port, state) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400);
        res.end("Invalid OAuth state.");
        reject(new Error("Invalid OAuth state."));
        server.close();
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400);
        res.end(`OAuth error: ${error}`);
        reject(new Error(`OAuth error: ${error}`));
        server.close();
        return;
      }
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Gmail OAuth consent received. You can close this tab.");
      resolve(code);
      server.close();
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

function tokenPathFor(tokenDir, email) {
  const safe = String(email).toLowerCase().replace(/[^a-z0-9_.@-]/g, "_");
  return `${tokenDir}/${safe}.json`;
}

async function refreshAccessToken(config, saved) {
  if (!saved?.token?.refresh_token) {
    throw new Error("Saved token does not include a refresh_token.");
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

async function verifyGmailAccess(token, expectedAccount) {
  const profile = await requestJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (expectedAccount && profile.emailAddress.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error(`Authorized ${profile.emailAddress}, but expected ${expectedAccount}.`);
  }
  const messages = await requestJson(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
    {
      headers: { Authorization: `Bearer ${token.access_token}` },
    },
  );
  return {
    email: profile.emailAddress,
    messagesVisible: Array.isArray(messages.messages) ? messages.messages.length : 0,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = readClientConfig(args.credentialsPath);
  if (args.useSavedToken) {
    if (!args.account) {
      throw new Error("--use-saved-token requires --account or HUNT_C3_GMAIL_ACCOUNT_EMAIL.");
    }
    const outputPath = tokenPathFor(args.tokenDir, args.account);
    const saved = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const token = await refreshAccessToken(config, saved);
    const result = await verifyGmailAccess(token, args.account);
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          ...saved,
          token,
          refreshedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log(`Saved token refresh OK for ${result.email}`);
    console.log(`Gmail messages.list OK, visible messages: ${result.messagesVisible}`);
    return;
  }
  const redirectUri = `http://127.0.0.1:${args.port}/oauth2callback`;
  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: args.scope,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  if (args.account) {
    params.set("login_hint", args.account);
  }
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  console.log("Open this URL in your browser and approve Gmail read access:");
  console.log(authUrl);
  const code = await waitForCode(args.port, state);
  const token = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const result = await verifyGmailAccess(token, args.account);
  fs.mkdirSync(args.tokenDir, { recursive: true });
  const outputPath = tokenPathFor(args.tokenDir, result.email);
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        email: result.email,
        scope: args.scope,
        token,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`OAuth OK for ${result.email}`);
  console.log(`Gmail messages.list OK, visible messages: ${result.messagesVisible}`);
  console.log(`Token saved to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
