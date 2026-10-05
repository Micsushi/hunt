import { Buffer } from "node:buffer";
import { createCheck } from "./report-lib.mjs";

export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5-mini";
const defaultTimeoutMs = 30_000;
const defaultMaxTokens = 1024;
const maxProviderResponseBytes = 128 * 1024;
const maxFindings = 50;

// Builds the concrete provider client for the configured provider. Throws with
// an actionable message when a provider has no adapter or is missing its key so
// the caller can turn the failure into a single warning check.
export function createProviderClient({
  provider,
  env = process.env,
  fetchImpl = globalThis.fetch
} = {}) {
  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
    return createAnthropicClient({
      apiKey,
      model: env.RESUME_COOKER_API_MODEL || DEFAULT_ANTHROPIC_MODEL,
      fetchImpl,
      timeoutMs: boundedInteger(env.RESUME_COOKER_API_TIMEOUT_MS, defaultTimeoutMs, 1, 120_000),
      maxTokens: boundedInteger(env.RESUME_COOKER_API_MAX_TOKENS, defaultMaxTokens, 1, 8192)
    });
  }
  if (provider === "openrouter") {
    const apiKey = env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
    return createOpenRouterClient({
      apiKey,
      model: env.RESUME_COOKER_API_MODEL || DEFAULT_OPENROUTER_MODEL,
      fetchImpl,
      timeoutMs: boundedInteger(env.RESUME_COOKER_API_TIMEOUT_MS, defaultTimeoutMs, 1, 120_000),
      maxTokens: boundedInteger(env.RESUME_COOKER_API_MAX_TOKENS, defaultMaxTokens, 1, 8192),
      referer: env.OPENROUTER_SITE_URL || env.RESUME_COOKER_OPENROUTER_SITE_URL || "",
      title: env.OPENROUTER_SITE_NAME || env.RESUME_COOKER_OPENROUTER_TITLE || "Resume Cooker"
    });
  }
  throw new Error(`No API adapter implemented for provider "${provider}".`);
}

export function createAnthropicClient({
  apiKey,
  model = DEFAULT_ANTHROPIC_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxTokens = 1024
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available for the Anthropic client.");
  }

  timeoutMs = boundedInteger(timeoutMs, defaultTimeoutMs, 1, 120_000);
  maxTokens = boundedInteger(maxTokens, defaultMaxTokens, 1, 8192);

  async function review({ resumeText = "", jdText = "" }) {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: buildReviewPrompt(resumeText, jdText) }]
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(ANTHROPIC_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw providerHttpError("Anthropic", response.status);
      }

      const payload = await readBoundedJson(response);
      const text = extractAnthropicText(payload);
      return parseFindings(text, model, "anthropic");
    } finally {
      clearTimeout(timer);
    }
  }

  return { provider: "anthropic", model, review };
}

export function createOpenRouterClient({
  apiKey,
  model = DEFAULT_OPENROUTER_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxTokens = 1024,
  referer = "",
  title = "Resume Cooker"
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("No fetch implementation available for the OpenRouter client.");
  }

  timeoutMs = boundedInteger(timeoutMs, defaultTimeoutMs, 1, 120_000);
  maxTokens = boundedInteger(maxTokens, defaultMaxTokens, 1, 8192);

  async function review({ resumeText = "", jdText = "" }) {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: buildReviewPrompt(resumeText, jdText) }]
    };

    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    };
    if (referer) headers["http-referer"] = referer;
    if (title) headers["x-openrouter-title"] = title;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(OPENROUTER_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw providerHttpError("OpenRouter", response.status);
      }

      const payload = await readBoundedJson(response);
      const text = extractOpenRouterText(payload);
      return parseFindings(text, model, "openrouter");
    } finally {
      clearTimeout(timer);
    }
  }

  return { provider: "openrouter", model, review };
}

function buildReviewPrompt(resumeText, jdText) {
  return [
    "You are an ATS and resume-quality reviewer.",
    "Review the resume below and, if a job description is provided, its fit for that role.",
    "Return ONLY a JSON array. Each element must be an object with keys:",
    'id, category, severity ("low"|"medium"|"high"|"blocker"), status ("pass"|"warning"|"fail"),',
    "evidence (short string), suggested_fix (short string).",
    "Do not invent facts about the candidate. Do not include any prose outside the JSON array.",
    "",
    "=== RESUME ===",
    resumeText || "(none provided)",
    "",
    "=== JOB DESCRIPTION ===",
    jdText || "(none provided)"
  ].join("\n");
}

function extractAnthropicText(payload) {
  const parts = payload?.content;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function extractOpenRouterText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return typeof content === "string" ? content : "";
}

// Maps model output into normalized checks. Falls back to a single warning check
// when the model did not return parseable JSON, so a bad response never crashes.
export function parseFindings(text, model, provider = "api") {
  const findings = tryParseJsonArray(text);
  if (!findings) {
    return [
      createCheck({
        id: "api_review_unparseable",
        suite: "api",
        category: "api_review",
        severity: "low",
        status: "warning",
        provider,
        model,
        contentLeftMachine: true,
        evidence: "API review response was not parseable JSON.",
        suggestedFix: "Inspect the raw provider response or retry with a stricter prompt."
      })
    ];
  }
  if (!validFindings(findings)) {
    return [invalidReviewCheck(model, provider)];
  }

  return findings.map((finding, index) =>
    createCheck({
      id: finding.id || `api_review_finding_${index + 1}`,
      suite: "api",
      category: finding.category || "api_review",
      severity: normalizeSeverity(finding.severity),
      status: normalizeStatus(finding.status),
      provider,
      model,
      contentLeftMachine: true,
      evidence: String(finding.evidence || "").slice(0, 500),
      suggestedFix: String(finding.suggested_fix || "").slice(0, 500)
    })
  );
}

function tryParseJsonArray(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxProviderResponseBytes) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validFindings(findings) {
  if (findings.length < 1 || findings.length > maxFindings) return false;
  const allowedKeys = new Set([
    "id",
    "category",
    "severity",
    "status",
    "evidence",
    "suggested_fix"
  ]);
  return findings.every(
    (finding) =>
      finding &&
      typeof finding === "object" &&
      !Array.isArray(finding) &&
      Object.keys(finding).every((key) => allowedKeys.has(key)) &&
      typeof finding.id === "string" &&
      /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(finding.id) &&
      boundedString(finding.category, 100) &&
      ["low", "medium", "high", "blocker"].includes(finding.severity) &&
      ["pass", "warning", "fail"].includes(finding.status) &&
      boundedString(finding.evidence, 500) &&
      boundedString(finding.suggested_fix, 500)
  );
}

function boundedString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function invalidReviewCheck(model, provider) {
  return createCheck({
    id: "api_review_invalid",
    suite: "api",
    category: "api_review",
    severity: "low",
    status: "warning",
    provider,
    model,
    contentLeftMachine: true,
    evidence: "API review returned no valid bounded findings.",
    suggestedFix: "Retry the provider review; do not treat this response as a passing analysis."
  });
}

function normalizeSeverity(value) {
  return value;
}

function normalizeStatus(value) {
  return value;
}

function providerHttpError(provider, status) {
  const error = new Error(`${provider} API request failed with HTTP status ${status}.`);
  error.code = "API_HTTP_ERROR";
  error.status = Number.isInteger(status) ? status : null;
  return error;
}

async function readBoundedJson(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxProviderResponseBytes) {
    throw invalidProviderResponse("API response exceeded the allowed size.");
  }
  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maxProviderResponseBytes) {
          await reader.cancel();
          throw invalidProviderResponse("API response exceeded the allowed size.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return parseProviderJson(Buffer.concat(chunks).toString("utf8"));
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxProviderResponseBytes) {
      throw invalidProviderResponse("API response exceeded the allowed size.");
    }
    return parseProviderJson(text);
  }
  return response.json();
}

export function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function parseProviderJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw invalidProviderResponse("API response was not valid JSON.");
  }
}

function invalidProviderResponse(message) {
  const error = new Error(message);
  error.code = "API_RESPONSE_INVALID";
  return error;
}
