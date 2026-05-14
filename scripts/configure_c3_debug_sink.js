#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  makeWorkdayProfileDefaults,
  withWorkdayProfileAliases,
  workdayProfileCounts,
} = require("./c3_p_chrome_defaults");

const DEFAULT_PORT = 9222;
const DEFAULT_EXTENSION_ID = "cbdmkibihimaedoihjhpidclolglnncc";
const SETTINGS_KEY = "hunt.apply.settings";
const PROFILE_KEY = "hunt.apply.profile";

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    backendUrl: process.env.HUNT_BACKEND_URL || "http://127.0.0.1:8000",
    extensionId: process.env.HUNT_C3_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    envFile: ".env",
    seedWorkdayProfile: false,
    test: true,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--port") {
      args.port = Number(argv[++idx] || DEFAULT_PORT);
    } else if (arg === "--backend-url") {
      args.backendUrl = argv[++idx] || args.backendUrl;
    } else if (arg === "--extension-id") {
      args.extensionId = argv[++idx] || args.extensionId;
    } else if (arg === "--env-file") {
      args.envFile = argv[++idx] || args.envFile;
    } else if (arg === "--seed-workday-profile") {
      args.seedWorkdayProfile = true;
    } else if (arg === "--no-test") {
      args.test = false;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  console.log(
    [
      "Usage: node scripts/configure_c3_debug_sink.js [options]",
      "",
      "Writes backend URL, service token, and Local debug log sink settings into p chrome.",
      "The token is read from HUNT_SERVICE_TOKEN or --env-file and is never printed.",
      "",
      "Options:",
      "  --backend-url <url>  Backend URL. Default: http://127.0.0.1:8000",
      "  --extension-id <id> Unpacked C3 extension ID",
      "  --env-file <path>    Env file fallback. Default: .env",
      "  --port <port>        Chrome DevTools port. Default: 9222",
      "  --seed-workday-profile Seed p chrome profile defaults for Workday testing",
      "  --no-test            Do not post a test debug-log entry",
    ].join("\n"),
  );
}

function httpText(port, requestPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function readEnvToken(envFile) {
  if (process.env.HUNT_SERVICE_TOKEN) {
    return { token: process.env.HUNT_SERVICE_TOKEN, source: "environment" };
  }
  const envPath = path.resolve(envFile || ".env");
  if (!fs.existsSync(envPath)) {
    return { token: "", source: "" };
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^HUNT_SERVICE_TOKEN\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return { token: value, source: envPath };
  }
  return { token: "", source: "" };
}

function httpJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CDP connect timeout")),
        10000,
      );
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(event.error || new Error("CDP websocket error"));
      });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) {
          reject(
            new Error(message.error.message || JSON.stringify(message.error)),
          );
        } else {
          resolve(message.result);
        }
      }
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 30000) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ||
          result.exceptionDetails.exception?.description ||
          "Runtime.evaluate failed",
      );
    }
    return result.result?.value;
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

function js(value) {
  return JSON.stringify(value);
}

function findExtensionPage(targets) {
  return targets.find((target) =>
    String(target.url || "").includes("/src/options/options.html"),
  );
}

function findExtensionId(targets, fallbackExtensionId) {
  for (const target of targets) {
    const match = String(target.url || "").match(
      /^chrome-extension:\/\/([^/]+)/,
    );
    if (match) {
      return match[1];
    }
  }
  return fallbackExtensionId;
}

async function ensureExtensionPage(port, targets, fallbackExtensionId) {
  const existing = findExtensionPage(targets);
  if (existing?.webSocketDebuggerUrl) {
    return existing;
  }
  const extensionId = findExtensionId(targets, fallbackExtensionId);
  const url = `chrome-extension://${extensionId}/src/options/options.html`;
  await httpText(port, `/json/new?${encodeURIComponent(url)}`, "PUT");
  const refreshed = await httpJson(port, "/json/list");
  const opened = findExtensionPage(refreshed);
  if (!opened?.webSocketDebuggerUrl) {
    throw new Error("Could not open the Hunt Apply Options page in p chrome.");
  }
  return opened;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const { token, source } = readEnvToken(args.envFile);
  const targets = await httpJson(args.port, "/json/list");
  const extensionPage = await ensureExtensionPage(
    args.port,
    targets,
    args.extensionId,
  );

  const client = await new CdpClient(
    extensionPage.webSocketDebuggerUrl,
  ).connect();
  try {
    const result = await client.evaluate(
      `(async () => {
        const backendUrl = ${js(args.backendUrl)};
        const serviceToken = ${js(token)};
        const seedProfile = ${js(args.seedWorkdayProfile)};
        const workdayProfileDefaults = ${js(
          withWorkdayProfileAliases(makeWorkdayProfileDefaults()),
        )};
        const existing = await chrome.storage.sync.get([${js(SETTINGS_KEY)}]);
        const current = existing[${js(SETTINGS_KEY)}] || {};
        const next = {
          settingsVersion: 3,
          autofillOnLoad: false,
          manualFillEnabled: true,
          autoPromptEnabled: true,
          autoClickNextAfterFill: false,
          fillRequiredOnly: true,
          autoExportLogs: false,
          autoExportLogPrefix: "hunt-c3-logs",
          debugLogSinkEnabled: true,
          c4PollingEnabled: false,
          pollIntervalSeconds: 60,
          heartbeatIntervalSeconds: 120,
          oneActiveRunLock: true,
          allowGeneratedAnswers: true,
          flagLowConfidenceAnswers: true,
          llmAnswerFallbackEnabled: true,
          stripLongDash: true,
          ...current,
          backendUrl,
          serviceToken,
          debugLogSinkEnabled: true
        };
        await chrome.storage.sync.set({ [${js(SETTINGS_KEY)}]: next });
        const profileCountsFor = ${workdayProfileCounts.toString()};
        let profileCounts = null;
        if (seedProfile) {
          const storedProfile = await chrome.storage.local.get([${js(PROFILE_KEY)}]);
          const currentProfile = storedProfile[${js(PROFILE_KEY)}] || {};
          const mergedProfile = {
            ...currentProfile,
            ...workdayProfileDefaults,
            accountEmail: currentProfile.accountEmail || workdayProfileDefaults.accountEmail,
            accountPassword: currentProfile.accountPassword || workdayProfileDefaults.accountPassword,
            skills: Array.isArray(currentProfile.skills) && currentProfile.skills.length
              ? currentProfile.skills
              : workdayProfileDefaults.skills,
            workExperience: Array.isArray(currentProfile.workExperience) && currentProfile.workExperience.length
              ? currentProfile.workExperience
              : workdayProfileDefaults.workExperience,
            education: Array.isArray(currentProfile.education) && currentProfile.education.length
              ? currentProfile.education
              : workdayProfileDefaults.education,
            websites: Array.isArray(currentProfile.websites) && currentProfile.websites.length
              ? currentProfile.websites
              : workdayProfileDefaults.websites
          };
          await chrome.storage.local.set({ [${js(PROFILE_KEY)}]: mergedProfile });
          profileCounts = profileCountsFor(mergedProfile);
          setTimeout(() => window.location.reload(), 100);
        } else {
          const storedProfile = await chrome.storage.local.get([${js(PROFILE_KEY)}]);
          profileCounts = profileCountsFor(storedProfile[${js(PROFILE_KEY)}] || {});
        }
        let testResult = { skipped: true };
        if (${js(args.test)}) {
          const response = await fetch(backendUrl.replace(/\\/+$/, "") + "/api/c3/debug-log", {
            method: "POST",
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/json",
              ...(serviceToken ? { "Authorization": "Bearer " + serviceToken } : {})
            },
            body: JSON.stringify({
              eventType: "p_chrome.debug_sink_configured",
              extensionTime: new Date().toISOString(),
              payload: { source: "scripts/configure_c3_debug_sink.js" }
            })
          });
          testResult = {
            ok: response.ok,
            status: response.status,
            body: await response.text()
          };
        }
        return {
          backendUrl: next.backendUrl,
          debugLogSinkEnabled: next.debugLogSinkEnabled,
          hasServiceToken: Boolean(next.serviceToken),
          profileCounts,
          testResult
        };
      })()`,
      45000,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          backendUrl: result.backendUrl,
          debugLogSinkEnabled: result.debugLogSinkEnabled,
          hasServiceToken: result.hasServiceToken,
          profileCounts: result.profileCounts || null,
          tokenSource: source ? "found" : "missing",
          testOk: result.testResult?.ok === true,
          testStatus: result.testResult?.status || null,
        },
        null,
        2,
      ),
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
