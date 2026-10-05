import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAnthropicClient,
  createOpenRouterClient,
  createProviderClient,
  parseFindings
} from "./api-providers.mjs";

test("createProviderClient requires a key for anthropic", () => {
  assert.throws(
    () => createProviderClient({ provider: "anthropic", env: {} }),
    /ANTHROPIC_API_KEY/
  );
});

test("createProviderClient requires a key for openrouter", () => {
  assert.throws(
    () => createProviderClient({ provider: "openrouter", env: {} }),
    /OPENROUTER_API_KEY/
  );
});

test("createProviderClient rejects unknown providers", () => {
  assert.throws(
    () => createProviderClient({ provider: "mystery", env: {} }),
    /No API adapter implemented/
  );
});

test("parseFindings maps model JSON into normalized checks", () => {
  const text =
    '[{"id":"x","category":"quality","severity":"high","status":"fail","evidence":"e","suggested_fix":"f"}]';
  const checks = parseFindings(text, "m", "openrouter");

  assert.equal(checks.length, 1);
  assert.equal(checks[0].severity, "high");
  assert.equal(checks[0].status, "fail");
  assert.equal(checks[0].provider, "openrouter");
  assert.equal(checks[0].content_left_machine, true);
});

test("parseFindings falls back to a warning on unparseable output", () => {
  const checks = parseFindings("not json at all", "m");

  assert.equal(checks[0].id, "api_review_unparseable");
  assert.equal(checks[0].status, "warning");
});

test("parseFindings treats empty and invalid provider arrays as unavailable, never pass", () => {
  for (const text of [
    "[]",
    '[{"id":"x","category":"quality","severity":"critical","status":"pass","evidence":"e","suggested_fix":"f"}]',
    '[{"id":"x","category":"quality","severity":"low","status":"pass","evidence":7,"suggested_fix":"f"}]',
    `noise [{"id":"x","category":"quality","severity":"low","status":"pass","evidence":"e","suggested_fix":"f"}] tail`
  ]) {
    const checks = parseFindings(text, "m");
    assert.equal(checks.length, 1);
    assert.match(checks[0].id, /^api_review_(?:invalid|unparseable)$/);
    assert.equal(checks[0].status, "warning");
  }
});

test("anthropic client posts to the API and parses findings via injected fetch", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '[{"id":"clarity","category":"quality","severity":"low","status":"warning","evidence":"e","suggested_fix":"f"}]'
          }
        ]
      })
    };
  };

  const client = createAnthropicClient({ apiKey: "k", model: "test-model", fetchImpl });
  const checks = await client.review({ resumeText: "r", jdText: "j" });

  assert.match(captured.url, /api\.anthropic\.com/);
  assert.equal(captured.init.headers["x-api-key"], "k");
  assert.equal(checks[0].id, "clarity");
  assert.equal(checks[0].model, "test-model");
});

test("anthropic client raises on a non-ok response", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    text: async () => "Authorization: Bearer provider-secret"
  });
  const client = createAnthropicClient({ apiKey: "k", fetchImpl });

  await assert.rejects(
    () => client.review({ resumeText: "r" }),
    (error) =>
      error.code === "API_HTTP_ERROR" &&
      error.status === 429 &&
      !/provider-secret|Authorization|Bearer/.test(error.message)
  );
});

test("openrouter client posts chat completions and parses findings via injected fetch", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '[{"id":"jd_fit","category":"fit","severity":"low","status":"warning","evidence":"e","suggested_fix":"f"}]'
            }
          }
        ]
      })
    };
  };

  const client = createOpenRouterClient({
    apiKey: "k",
    model: "openai/test",
    fetchImpl,
    referer: "https://example.invalid",
    title: "Resume Cooker Test"
  });
  const checks = await client.review({ resumeText: "r", jdText: "j" });

  assert.match(captured.url, /openrouter\.ai/);
  assert.equal(captured.init.headers.authorization, "Bearer k");
  assert.equal(captured.init.headers["http-referer"], "https://example.invalid");
  assert.equal(captured.init.headers["x-openrouter-title"], "Resume Cooker Test");
  assert.equal(checks[0].id, "jd_fit");
  assert.equal(checks[0].provider, "openrouter");
  assert.equal(checks[0].model, "openai/test");
});

test("openrouter client raises on a non-ok response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, text: async () => "no credits" });
  const client = createOpenRouterClient({ apiKey: "k", fetchImpl });

  await assert.rejects(() => client.review({ resumeText: "r" }), /402/);
});

test("provider response size is enforced while streaming", async () => {
  const chunk = new Uint8Array(64 * 1024);
  let pulls = 0;
  const fetchImpl = async () =>
    new globalThis.Response(
      new globalThis.ReadableStream({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
          if (pulls === 100) controller.close();
        }
      })
    );
  const client = createOpenRouterClient({ apiKey: "k", fetchImpl });

  await assert.rejects(
    () => client.review({ resumeText: "r" }),
    (error) => error.code === "API_RESPONSE_INVALID"
  );
  assert.ok(pulls < 100, `expected early stream cancellation, read ${pulls} chunks`);
});

test("provider timeout remains active while reading the response body", async () => {
  const fetchImpl = async (_url, init) =>
    new globalThis.Response(
      new globalThis.ReadableStream({
        start(controller) {
          init.signal.addEventListener(
            "abort",
            () => controller.error(new globalThis.DOMException("aborted", "AbortError")),
            { once: true }
          );
        }
      })
    );
  const client = createOpenRouterClient({ apiKey: "k", fetchImpl, timeoutMs: 20 });

  await assert.rejects(
    () => client.review({ resumeText: "r" }),
    (error) => error.name === "AbortError"
  );
});
