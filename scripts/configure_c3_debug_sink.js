#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  DEFAULT_ACCOUNT_PASSWORD,
  makeWorkdayProfileDefaults,
  withWorkdayProfileAliases,
  workdayProfileCounts,
} = require("./c3_p_chrome_defaults");

const DEFAULT_PORT = 9222;
const DEFAULT_EXTENSION_ID = "cbdmkibihimaedoihjhpidclolglnncc";
const SETTINGS_KEY = "hunt.apply.settings";
const RUNTIME_CONFIG_KEY = "hunt.apply.runtimeConfig";
const PROFILE_KEY = "hunt.apply.profile";
const BROWSER_CONTEXT_KEY = "hunt.apply.browserContext";

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    backendUrl: process.env.HUNT_BACKEND_URL || "http://127.0.0.1:8004",
    extensionId: process.env.HUNT_C3_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    envFile: ".env",
    seedWorkdayProfile: false,
    autoNext: false,
    test: true,
    inspectOnly: false,
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
    } else if (arg === "--auto-next") {
      args.autoNext = true;
    } else if (arg === "--no-auto-next") {
      args.autoNext = false;
    } else if (arg === "--no-test") {
      args.test = false;
    } else if (arg === "--inspect-only") {
      args.inspectOnly = true;
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
      "Writes local p chrome runtime overrides for backend URL, service token, debug sink, and auto-next.",
      "The token is read from HUNT_SERVICE_TOKEN or --env-file and is never printed.",
      "",
      "Options:",
      "  --backend-url <url>  Backend URL. Default: http://127.0.0.1:8004",
      "  --extension-id <id> Unpacked C3 extension ID",
      "  --env-file <path>    Env file fallback. Default: .env",
      "  --port <port>        Chrome DevTools port. Default: 9222",
      "  --seed-workday-profile Seed p chrome profile defaults for Workday testing",
      "  --auto-next         Enable extension auto-next/page walk for full-flow testing",
      "  --no-auto-next      Keep fill on the current page for direct debugging. Default",
      "  --no-test            Do not post a test debug-log entry",
      "  --inspect-only       Read p chrome C3 effective settings without writing storage",
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

function findExtensionPage(targets, extensionId) {
  return targets.find((target) =>
    String(target.url || "").startsWith(
      `chrome-extension://${extensionId}/src/options/options.html`,
    ),
  );
}

function findExtensionId(targets, fallbackExtensionId) {
  const huntWorker = targets.find((target) =>
    String(target.url || "").includes("/src/background/index.js"),
  );
  const huntMatch = String(huntWorker?.url || "").match(
    /^chrome-extension:\/\/([^/]+)/,
  );
  if (huntMatch) {
    return huntMatch[1];
  }
  if (fallbackExtensionId) {
    return fallbackExtensionId;
  }
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
  const extensionId = findExtensionId(targets, fallbackExtensionId);
  const existing = findExtensionPage(targets, extensionId);
  if (existing?.webSocketDebuggerUrl) {
    return existing;
  }
  const url = `chrome-extension://${extensionId}/src/options/options.html`;
  await httpText(port, `/json/new?${encodeURIComponent(url)}`, "PUT");
  const refreshed = await httpJson(port, "/json/list");
  const opened = findExtensionPage(refreshed, extensionId);
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
        const autoNext = ${js(args.autoNext)};
        const inspectOnly = ${js(args.inspectOnly)};
        const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
        const browserContext = {
          name: "p_chrome",
          configuredBy: "scripts/configure_c3_debug_sink.js",
          devtoolsPort: String(${js(args.port)})
        };
        const workdayProfileDefaults = ${js(
          withWorkdayProfileAliases(makeWorkdayProfileDefaults()),
        )};
        const existing = await chrome.storage.sync.get([${js(SETTINGS_KEY)}]);
        const current = existing[${js(SETTINGS_KEY)}] || {};
        const existingLocal = await chrome.storage.local.get([
          ${js(RUNTIME_CONFIG_KEY)},
          ${js(BROWSER_CONTEXT_KEY)},
          ${js(PROFILE_KEY)}
        ]);
        const currentRuntimeConfig = existingLocal[${js(RUNTIME_CONFIG_KEY)}] || {};
        const currentBrowserContext = existingLocal[${js(BROWSER_CONTEXT_KEY)}] || {};
        const nextRuntimeConfigCore = {
          backendUrl,
          serviceToken,
          debugLogSinkEnabled: true,
          autoClickNextAfterFill: autoNext,
        };
        const nextRuntimeConfig = {
          ...currentRuntimeConfig,
          ...nextRuntimeConfigCore,
          configuredBy: "scripts/configure_c3_debug_sink.js",
          configuredAt: sameJson(
            {
              backendUrl: currentRuntimeConfig.backendUrl,
              serviceToken: currentRuntimeConfig.serviceToken,
              debugLogSinkEnabled: currentRuntimeConfig.debugLogSinkEnabled,
              autoClickNextAfterFill: currentRuntimeConfig.autoClickNextAfterFill
            },
            nextRuntimeConfigCore
          )
            ? currentRuntimeConfig.configuredAt || ""
            : new Date().toISOString()
        };
        const effective = {
          ...current,
          backendUrl: nextRuntimeConfig.backendUrl || current.backendUrl || "",
          serviceToken: nextRuntimeConfig.serviceToken || current.serviceToken || "",
          debugLogSinkEnabled:
            nextRuntimeConfig.debugLogSinkEnabled ?? current.debugLogSinkEnabled,
          autoClickNextAfterFill:
            nextRuntimeConfig.autoClickNextAfterFill ?? current.autoClickNextAfterFill,
          useFieldPipelineV2: true
        };
        const writes = {
          runtimeConfig: false,
          browserContext: false,
          profile: false
        };
        if (inspectOnly) {
          const profileCountsFor = ${workdayProfileCounts.toString()};
          const profileCounts = profileCountsFor(existingLocal[${js(PROFILE_KEY)}] || {});
          const inspectedRuntimeConfig = currentRuntimeConfig || {};
          const inspectedEffective = {
            ...current,
            backendUrl: inspectedRuntimeConfig.backendUrl || current.backendUrl || "",
            serviceToken: inspectedRuntimeConfig.serviceToken || current.serviceToken || "",
            debugLogSinkEnabled:
              inspectedRuntimeConfig.debugLogSinkEnabled ?? current.debugLogSinkEnabled,
            autoClickNextAfterFill:
              inspectedRuntimeConfig.autoClickNextAfterFill ?? current.autoClickNextAfterFill,
            useFieldPipelineV2: true
          };
          return {
            backendUrl: inspectedEffective.backendUrl || "",
            browserContext: currentBrowserContext.name || "",
            debugLogSinkEnabled: Boolean(inspectedEffective.debugLogSinkEnabled),
            hasServiceToken: Boolean(inspectedEffective.serviceToken),
            profileCounts,
            useFieldPipelineV2: true,
            autoClickNextAfterFill: Boolean(inspectedEffective.autoClickNextAfterFill),
            testResult: { skipped: true },
            writes,
            inspectOnly: true
          };
        }
        if (!sameJson(currentRuntimeConfig, nextRuntimeConfig)) {
          await chrome.storage.local.set({ [${js(RUNTIME_CONFIG_KEY)}]: nextRuntimeConfig });
          writes.runtimeConfig = true;
        }
        const nextBrowserContext = {
          ...browserContext,
          configuredAt: sameJson(
            {
              name: currentBrowserContext.name,
              configuredBy: currentBrowserContext.configuredBy,
              devtoolsPort: currentBrowserContext.devtoolsPort
            },
            browserContext
          )
            ? currentBrowserContext.configuredAt
            : new Date().toISOString()
        };
        if (!sameJson(currentBrowserContext, nextBrowserContext)) {
          await chrome.storage.local.set({ [${js(BROWSER_CONTEXT_KEY)}]: nextBrowserContext });
          writes.browserContext = true;
        }
        const profileCountsFor = ${workdayProfileCounts.toString()};
        let profileCounts = null;
        if (seedProfile) {
          const currentProfile = existingLocal[${js(PROFILE_KEY)}] || {};
          const cleanKey = (value) => String(value || "").trim().toLowerCase();
          const repeatableKey = (entry, kind) => {
            if (!entry || typeof entry === "string") {
              return cleanKey(entry);
            }
            if (kind === "work") {
              return [
                entry.jobTitle || entry.title || entry.position || "",
                entry.company || entry.employer || entry.companyName || ""
              ].map(cleanKey).join("|");
            }
            if (kind === "education") {
              return [
                entry.school || entry.university || entry.schoolName || "",
                entry.degree || entry.degreeLevel || entry.credential || ""
              ].map(cleanKey).join("|");
            }
            if (kind === "website") {
              return cleanKey(entry.url || entry.href || entry.websiteUrl || entry.website || entry.link || "");
            }
            return JSON.stringify(entry || {}).toLowerCase();
          };
          const topUpRepeatables = (currentValue, defaultValue, kind) => {
            const currentList = Array.isArray(currentValue) ? currentValue : [];
            const defaultList = Array.isArray(defaultValue) ? defaultValue : [];
            const merged = [];
            const seen = new Set();
            for (const entry of currentList) {
              const key = repeatableKey(entry, kind);
              if (key && !seen.has(key)) {
                merged.push(entry);
                seen.add(key);
              }
            }
            for (const entry of defaultList) {
              const key = repeatableKey(entry, kind);
              if (!seen.has(key)) {
                merged.push(entry);
                seen.add(key);
              }
            }
            return merged.length ? merged : defaultList;
          };
          const mergedProfile = {
            ...currentProfile,
            ...workdayProfileDefaults,
            email: workdayProfileDefaults.email,
            accountEmail: workdayProfileDefaults.accountEmail,
            accountPassword:
              !currentProfile.accountPassword ||
              currentProfile.accountPassword === "Hunt123456!" ||
              currentProfile.accountPassword === "Hunt12345678!" ||
              currentProfile.accountPassword === "Hunt12345678901!" ||
              String(currentProfile.accountPassword || "").length < 16
                ? workdayProfileDefaults.accountPassword || ${js(DEFAULT_ACCOUNT_PASSWORD)}
                : currentProfile.accountPassword,
            skills: Array.isArray(currentProfile.skills) && currentProfile.skills.length
              ? currentProfile.skills
              : workdayProfileDefaults.skills,
            workExperience: topUpRepeatables(
              currentProfile.workExperience,
              workdayProfileDefaults.workExperience,
              "work"
            ),
            education: topUpRepeatables(
              currentProfile.education,
              workdayProfileDefaults.education,
              "education"
            ),
            websites: topUpRepeatables(
              currentProfile.websites,
              workdayProfileDefaults.websites,
              "website"
            )
          };
          if (!sameJson(currentProfile, mergedProfile)) {
            await chrome.storage.local.set({ [${js(PROFILE_KEY)}]: mergedProfile });
            writes.profile = true;
          }
          profileCounts = profileCountsFor(mergedProfile);
          if (writes.profile) {
            setTimeout(() => window.location.reload(), 100);
          }
        } else {
          profileCounts = profileCountsFor(existingLocal[${js(PROFILE_KEY)}] || {});
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
              browserContext: nextBrowserContext.name,
              browserContextConfiguredBy: nextBrowserContext.configuredBy,
              browserContextConfiguredAt: nextBrowserContext.configuredAt,
              browserContextDevtoolsPort: nextBrowserContext.devtoolsPort,
              pipelineVersion: "v2",
              useFieldPipelineV2: true,
              settingsVersion: current.settingsVersion || 6,
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
          backendUrl: effective.backendUrl,
          browserContext: nextBrowserContext.name,
          debugLogSinkEnabled: effective.debugLogSinkEnabled,
          hasServiceToken: Boolean(effective.serviceToken),
          profileCounts,
          useFieldPipelineV2: effective.useFieldPipelineV2,
          autoClickNextAfterFill: effective.autoClickNextAfterFill,
          testResult,
          writes,
          inspectOnly: false
        };
      })()`,
      45000,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          backendUrl: result.backendUrl,
          browserContext: result.browserContext,
          debugLogSinkEnabled: result.debugLogSinkEnabled,
          useFieldPipelineV2: result.useFieldPipelineV2,
          autoClickNextAfterFill: result.autoClickNextAfterFill,
          hasServiceToken: result.hasServiceToken,
          profileCounts: result.profileCounts || null,
          tokenSource: source ? "found" : "missing",
          testOk: result.testResult?.ok === true,
          testStatus: result.testResult?.status || null,
          writes: result.writes || null,
          inspectOnly: Boolean(result.inspectOnly),
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
