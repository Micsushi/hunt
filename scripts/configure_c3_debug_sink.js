#!/usr/bin/env node
const crypto = require("crypto");
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
const DEFAULT_RESUME_KEY = "hunt.apply.defaultResume";
const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,";

function isSafePdfFilename(value) {
  const fileName = String(value || "");
  return (
    fileName.length > 4 &&
    fileName.length <= 128 &&
    !fileName.includes("..") &&
    /^[A-Za-z0-9][A-Za-z0-9._ -]*\.pdf$/i.test(fileName)
  );
}

function decodeStrictBase64(value) {
  const encoded = String(value || "");
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64");
  return decoded.toString("base64") === encoded ? decoded : null;
}

function defaultResumeIdentity(resume) {
  return {
    pdfFileName: String(resume?.pdfFileName || ""),
    pdfByteCount: Number(resume?.pdfByteCount || 0),
    pdfSha256: String(resume?.pdfSha256 || "").toLowerCase(),
  };
}

function isDefaultResumeReady(resume) {
  try {
    const identity = defaultResumeIdentity(resume);
    const dataUrl = String(resume?.pdfDataUrl || "");
    if (
      resume?.pdfMimeType !== "application/pdf" ||
      !isSafePdfFilename(identity.pdfFileName) ||
      !Number.isSafeInteger(identity.pdfByteCount) ||
      identity.pdfByteCount <= 0 ||
      identity.pdfByteCount > MAX_RESUME_BYTES ||
      !/^[a-f0-9]{64}$/.test(identity.pdfSha256) ||
      !dataUrl.startsWith(PDF_DATA_URL_PREFIX)
    ) {
      return false;
    }
    const decoded = decodeStrictBase64(dataUrl.slice(PDF_DATA_URL_PREFIX.length));
    if (
      !decoded ||
      decoded.length !== identity.pdfByteCount ||
      decoded.subarray(0, 5).toString("ascii") !== "%PDF-"
    ) {
      return false;
    }
    const actualSha256 = crypto.createHash("sha256").update(decoded).digest("hex");
    return actualSha256 === identity.pdfSha256;
  } catch (_error) {
    return false;
  }
}

async function isDefaultResumeReadyInBrowser(resume) {
  try {
    const fileName = String(resume?.pdfFileName || "");
    const byteCount = Number(resume?.pdfByteCount || 0);
    const expectedSha256 = String(resume?.pdfSha256 || "").toLowerCase();
    const prefix = "data:application/pdf;base64,";
    const dataUrl = String(resume?.pdfDataUrl || "");
    const safeFileName =
      fileName.length > 4 &&
      fileName.length <= 128 &&
      !fileName.includes("..") &&
      /^[A-Za-z0-9][A-Za-z0-9._ -]*\.pdf$/i.test(fileName);
    if (
      resume?.pdfMimeType !== "application/pdf" ||
      !safeFileName ||
      !Number.isSafeInteger(byteCount) ||
      byteCount <= 0 ||
      byteCount > 10 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(expectedSha256) ||
      !dataUrl.startsWith(prefix)
    ) {
      return false;
    }
    const encoded = dataUrl.slice(prefix.length);
    if (
      !encoded ||
      encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    ) {
      return false;
    }
    const binary = atob(encoded);
    if (
      btoa(binary) !== encoded ||
      binary.length !== byteCount ||
      binary.slice(0, 5) !== "%PDF-"
    ) {
      return false;
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const actualSha256 = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    return actualSha256 === expectedSha256;
  } catch (_error) {
    return false;
  }
}

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    backendUrl: process.env.HUNT_BACKEND_URL || "http://127.0.0.1:8000",
    extensionId: process.env.HUNT_C3_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    agentId: process.env.HUNT_C3_AGENT_ID || "",
    laneId: process.env.HUNT_C3_LANE_ID || "",
    sessionId: process.env.HUNT_C3_SESSION_ID || "",
    leaseId: process.env.HUNT_C3_LEASE_ID || "",
    envFile: ".env",
    resume: "",
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
    } else if (arg === "--agent-id") {
      args.agentId = argv[++idx] || args.agentId;
    } else if (arg === "--lane-id") {
      args.laneId = argv[++idx] || args.laneId;
    } else if (arg === "--session-id") {
      args.sessionId = argv[++idx] || args.sessionId;
    } else if (arg === "--lease-id") {
      args.leaseId = argv[++idx] || args.leaseId;
    } else if (arg === "--env-file") {
      args.envFile = argv[++idx] || args.envFile;
    } else if (arg === "--resume") {
      args.resume = argv[++idx] || args.resume;
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
      "  --backend-url <url>  Backend URL. Default: http://127.0.0.1:8000",
      "  --extension-id <id> Unpacked C3 extension ID",
      "  --agent-id <id>     Ledger agent id. Default: agent-pchrome-<port>",
      "  --lane-id <id>      Ledger lane id. Default: lane-pchrome-<port>",
      "  --session-id <id>   Ledger session id. Default: session-pchrome-<port>",
      "  --lease-id <id>     Optional active ledger lease id",
      "  --env-file <path>    Env file fallback. Default: .env",
      "  --port <port>        Chrome DevTools port. Default: 9222",
      "  --resume <pdf>       Readable PDF to seed as the isolated lane default resume",
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
  return (
    targets.find((target) =>
      String(target.url || "").startsWith(
        `chrome-extension://${extensionId}/src/background/index.js`,
      ),
    ) ||
    targets.find((target) =>
      String(target.url || "").startsWith(
        `chrome-extension://${extensionId}/src/options/options.html`,
      ),
    )
  );
}

function isBlockedExtensionTab(target, extensionId) {
  const url = String(target.url || "");
  const title = String(target.title || "");
  return (
    target.type === "page" &&
    (url === `chrome-extension://${extensionId}` ||
      url === `chrome-extension://${extensionId}/` ||
      (url.startsWith("chrome-error://") &&
        (title.includes(`${extensionId} is blocked`) ||
          title.includes("ERR_BLOCKED_BY_CLIENT"))))
  );
}

async function closeBlockedExtensionTabs(port, targets, extensionId) {
  const blocked = targets.filter((target) =>
    isBlockedExtensionTab(target, extensionId),
  );
  for (const target of blocked) {
    await httpText(port, `/json/close/${target.id}`).catch(() => "");
  }
  return blocked.length;
}

async function targetHasExtensionApi(target) {
  if (!target?.webSocketDebuggerUrl) {
    return false;
  }
  const client = await new CdpClient(target.webSocketDebuggerUrl).connect();
  try {
    return Boolean(
      await client.evaluate(
        `Boolean(globalThis.chrome && chrome.storage && chrome.storage.local && chrome.runtime)`,
        5000,
      ),
    );
  } catch (_error) {
    return false;
  } finally {
    client.close();
  }
}

async function closeTarget(port, target) {
  if (target?.id) {
    await httpText(port, `/json/close/${target.id}`).catch(() => "");
  }
}

async function createBackgroundTarget(port, url) {
  const version = await httpJson(port, "/json/version");
  if (!version?.webSocketDebuggerUrl) {
    throw new Error("Could not find browser DevTools websocket.");
  }
  const browserClient = await new CdpClient(
    version.webSocketDebuggerUrl,
  ).connect();
  try {
    return await browserClient.send(
      "Target.createTarget",
      {
        url,
        background: true,
      },
      10000,
    );
  } finally {
    browserClient.close();
  }
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
  const closedBlockedCount = await closeBlockedExtensionTabs(
    port,
    targets,
    extensionId,
  );
  if (closedBlockedCount) {
    targets = await httpJson(port, "/json/list");
  }
  const existing = findExtensionPage(targets, extensionId);
  if (existing?.webSocketDebuggerUrl) {
    if (await targetHasExtensionApi(existing)) {
      return existing;
    }
    await closeTarget(port, existing);
    targets = await httpJson(port, "/json/list");
  }
  const url = `chrome-extension://${extensionId}/src/options/options.html`;
  for (let pageAttempt = 0; pageAttempt < 3; pageAttempt += 1) {
    await createBackgroundTarget(port, url);
    let opened = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const refreshed = await httpJson(port, "/json/list");
      opened = findExtensionPage(refreshed, extensionId);
      if (opened?.webSocketDebuggerUrl) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!opened?.webSocketDebuggerUrl) {
      continue;
    }
    if (await targetHasExtensionApi(opened)) {
      return opened;
    }
    await closeTarget(port, opened);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Hunt Apply Options page opened without extension APIs after 3 attempts.");
}

function readResumeSeed(resumePath) {
  const absolutePath = path.resolve(resumePath || "");
  let stat;
  try {
    fs.accessSync(absolutePath, fs.constants.R_OK);
    stat = fs.statSync(absolutePath);
  } catch (_error) {
    throw new Error("resume_preflight_missing: configured resume is not readable");
  }
  if (!stat.isFile() || path.extname(absolutePath).toLowerCase() !== ".pdf") {
    throw new Error("resume_preflight_missing: configured resume must be a PDF file");
  }
  if (stat.size <= 0 || stat.size > MAX_RESUME_BYTES) {
    throw new Error(
      `resume_preflight_missing: configured resume must be 1-${MAX_RESUME_BYTES} bytes`,
    );
  }
  const pdf = fs.readFileSync(absolutePath);
  if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("resume_preflight_missing: configured resume is not a PDF document");
  }
  const pdfFileName = path.basename(absolutePath);
  if (!isSafePdfFilename(pdfFileName)) {
    throw new Error("resume_preflight_missing: configured resume filename is unsafe");
  }
  return {
    label: pdfFileName,
    sourceType: "local_pdf",
    pdfPath: absolutePath,
    pdfFileName,
    pdfMimeType: "application/pdf",
    pdfDataUrl: `${PDF_DATA_URL_PREFIX}${pdf.toString("base64")}`,
    pdfByteCount: pdf.length,
    pdfSha256: crypto.createHash("sha256").update(pdf).digest("hex"),
    texPath: "",
    versionId: "c3-isolated-lane-default",
    jobId: "",
    updatedAt: new Date(stat.mtimeMs).toISOString(),
  };
}

function makePublicResult(result, tokenSource) {
  return {
    ok: true,
    backendUrl: result.backendUrl,
    browserContext: result.browserContext,
    debugLogSinkEnabled: result.debugLogSinkEnabled,
    ledgerEnabled: result.ledgerEnabled,
    ledgerBackendUrl: result.ledgerBackendUrl,
    agentId: result.agentId,
    laneId: result.laneId,
    sessionId: result.sessionId,
    leaseId: result.leaseId,
    useFieldPipelineV2: result.useFieldPipelineV2,
    autoClickNextAfterFill: result.autoClickNextAfterFill,
    hasServiceToken: result.hasServiceToken,
    profileCounts: result.profileCounts || null,
    defaultResumeReady: Boolean(result.defaultResumeReady),
    defaultResumeIdentity: result.defaultResumeIdentity || null,
    tokenSource: tokenSource ? "found" : "missing",
    testOk: result.testResult?.ok === true,
    testStatus: result.testResult?.status || null,
    testError: result.testResult?.error || null,
    writes: result.writes || null,
    inspectOnly: Boolean(result.inspectOnly),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.seedWorkdayProfile && !args.resume) {
    throw new Error(
      "resume_preflight_missing: --seed-workday-profile requires --resume <pdf>",
    );
  }
  const resumeSeed = args.resume ? readResumeSeed(args.resume) : null;
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
        const agentId = ${js(args.agentId || `agent-pchrome-${args.port}`)};
        const laneId = ${js(args.laneId || `lane-pchrome-${args.port}`)};
        const sessionId = ${js(args.sessionId || `session-pchrome-${args.port}`)};
        const leaseId = ${js(args.leaseId || "")};
        const seedProfile = ${js(args.seedWorkdayProfile)};
        const autoNext = ${js(args.autoNext)};
        const inspectOnly = ${js(args.inspectOnly)};
        const resumeSeed = ${js(resumeSeed)};
        const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
        const defaultResumeReadyFor = ${isDefaultResumeReadyInBrowser.toString()};
        const defaultResumeIdentityFor = ${defaultResumeIdentity.toString()};
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
          ${js(PROFILE_KEY)},
          ${js(DEFAULT_RESUME_KEY)}
        ]);
        const currentRuntimeConfig = existingLocal[${js(RUNTIME_CONFIG_KEY)}] || {};
        const currentBrowserContext = existingLocal[${js(BROWSER_CONTEXT_KEY)}] || {};
        const nextRuntimeConfigCore = {
          backendUrl,
          serviceToken,
          debugLogSinkEnabled: true,
          ledgerEnabled: true,
          ledgerBackendUrl: backendUrl,
          agentId,
          laneId,
          sessionId,
          leaseId,
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
              ledgerEnabled: currentRuntimeConfig.ledgerEnabled,
              ledgerBackendUrl: currentRuntimeConfig.ledgerBackendUrl,
              agentId: currentRuntimeConfig.agentId,
              laneId: currentRuntimeConfig.laneId,
              sessionId: currentRuntimeConfig.sessionId,
              leaseId: currentRuntimeConfig.leaseId,
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
          ledgerEnabled:
            nextRuntimeConfig.ledgerEnabled ?? current.ledgerEnabled,
          ledgerBackendUrl:
            nextRuntimeConfig.ledgerBackendUrl || current.ledgerBackendUrl || "",
          agentId: nextRuntimeConfig.agentId || current.agentId || "",
          laneId: nextRuntimeConfig.laneId || current.laneId || "",
          sessionId: nextRuntimeConfig.sessionId || current.sessionId || "",
          leaseId: nextRuntimeConfig.leaseId || current.leaseId || "",
          autoClickNextAfterFill:
            nextRuntimeConfig.autoClickNextAfterFill ?? current.autoClickNextAfterFill,
          useFieldPipelineV2: true
        };
        const writes = {
          runtimeConfig: false,
          browserContext: false,
          profile: false,
          resume: false
        };
        if (inspectOnly) {
          const profileCountsFor = ${workdayProfileCounts.toString()};
          const profileCounts = profileCountsFor(existingLocal[${js(PROFILE_KEY)}] || {});
          const inspectedRuntimeConfig = currentRuntimeConfig || {};
          const defaultResumeReady = await defaultResumeReadyFor(
            existingLocal[${js(DEFAULT_RESUME_KEY)}] || {},
          );
          const inspectedDefaultResume = existingLocal[${js(DEFAULT_RESUME_KEY)}] || {};
          const inspectedEffective = {
            ...current,
            backendUrl: inspectedRuntimeConfig.backendUrl || current.backendUrl || "",
            serviceToken: inspectedRuntimeConfig.serviceToken || current.serviceToken || "",
            debugLogSinkEnabled:
              inspectedRuntimeConfig.debugLogSinkEnabled ?? current.debugLogSinkEnabled,
            ledgerEnabled:
              inspectedRuntimeConfig.ledgerEnabled ?? current.ledgerEnabled,
            ledgerBackendUrl:
              inspectedRuntimeConfig.ledgerBackendUrl || current.ledgerBackendUrl || "",
            agentId: inspectedRuntimeConfig.agentId || current.agentId || "",
            laneId: inspectedRuntimeConfig.laneId || current.laneId || "",
            sessionId: inspectedRuntimeConfig.sessionId || current.sessionId || "",
            leaseId: inspectedRuntimeConfig.leaseId || current.leaseId || "",
            autoClickNextAfterFill:
              inspectedRuntimeConfig.autoClickNextAfterFill ?? current.autoClickNextAfterFill,
            useFieldPipelineV2: true
          };
          return {
            backendUrl: inspectedEffective.backendUrl || "",
            browserContext: currentBrowserContext.name || "",
            debugLogSinkEnabled: Boolean(inspectedEffective.debugLogSinkEnabled),
            ledgerEnabled: Boolean(inspectedEffective.ledgerEnabled),
            ledgerBackendUrl: inspectedEffective.ledgerBackendUrl || "",
            agentId: inspectedEffective.agentId || "",
            laneId: inspectedEffective.laneId || "",
            sessionId: inspectedEffective.sessionId || "",
            leaseId: inspectedEffective.leaseId || "",
            hasServiceToken: Boolean(inspectedEffective.serviceToken),
            profileCounts,
            defaultResumeReady: Boolean(defaultResumeReady),
            defaultResumeIdentity: defaultResumeReady
              ? defaultResumeIdentityFor(inspectedDefaultResume)
              : null,
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
        const currentDefaultResume = existingLocal[${js(DEFAULT_RESUME_KEY)}] || {};
        if (resumeSeed && !sameJson(currentDefaultResume, resumeSeed)) {
          await chrome.storage.local.set({ [${js(DEFAULT_RESUME_KEY)}]: resumeSeed });
          writes.resume = true;
        }
        const effectiveDefaultResume = resumeSeed || currentDefaultResume;
        const defaultResumeReady = await defaultResumeReadyFor(
          effectiveDefaultResume,
        );
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
        } else {
          profileCounts = profileCountsFor(existingLocal[${js(PROFILE_KEY)}] || {});
        }
        let testResult = { skipped: true };
        if (${js(args.test)}) {
          try {
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
          } catch (error) {
            testResult = {
              ok: false,
              status: null,
              body: "",
              error: error?.message || String(error)
            };
          }
        }
        if (writes.profile) {
          setTimeout(() => window.location.reload(), 100);
        }
        return {
          backendUrl: effective.backendUrl,
          browserContext: nextBrowserContext.name,
          debugLogSinkEnabled: effective.debugLogSinkEnabled,
          ledgerEnabled: Boolean(effective.ledgerEnabled),
          ledgerBackendUrl: effective.ledgerBackendUrl || "",
          agentId: effective.agentId || "",
          laneId: effective.laneId || "",
          sessionId: effective.sessionId || "",
          leaseId: effective.leaseId || "",
          hasServiceToken: Boolean(effective.serviceToken),
          profileCounts,
          defaultResumeReady: Boolean(defaultResumeReady),
          defaultResumeIdentity: defaultResumeReady
            ? defaultResumeIdentityFor(effectiveDefaultResume)
            : null,
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
        makePublicResult(result, source),
        null,
        2,
      ),
    );
  } finally {
    client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  MAX_RESUME_BYTES,
  defaultResumeIdentity,
  isDefaultResumeReady,
  isDefaultResumeReadyInBrowser,
  makePublicResult,
  parseArgs,
  readResumeSeed,
};
