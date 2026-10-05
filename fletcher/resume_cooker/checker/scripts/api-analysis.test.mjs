import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiReport } from "./api-analysis.mjs";
import { createCheck } from "./report-lib.mjs";

test("createApiReport stays opt-in and sends nothing when not enabled", async () => {
  const report = await createApiReport({ env: {}, resumeText: "secret" });

  assert.equal(report.status, "pass_with_warnings");
  assert.equal(report.content_left_machine, false);
  assert.equal(report.checks[0].id, "api_review_not_configured");
});

test("createApiReport warns when the provider adapter cannot be built", async () => {
  const report = await createApiReport({
    env: { RESUME_COOKER_ALLOW_API: "true", RESUME_COOKER_API_PROVIDER: "anthropic" },
    clientFactory: () => {
      throw new Error("ANTHROPIC_API_KEY is not set.");
    }
  });

  assert.equal(report.checks[0].id, "api_provider_unavailable");
  assert.match(report.checks[0].evidence, /ANTHROPIC_API_KEY/);
  assert.equal(report.content_left_machine, false);
});

test("createApiReport defaults enabled API review to OpenRouter", async () => {
  const report = await createApiReport({
    env: { RESUME_COOKER_ALLOW_API: "true", OPENROUTER_API_KEY: "k" },
    clientFactory: ({ provider }) => {
      assert.equal(provider, "openrouter");
      return {
        model: "m",
        review: async () => [
          createCheck({
            id: "review_complete",
            suite: "api",
            category: "api_review",
            status: "pass",
            contentLeftMachine: true
          })
        ]
      };
    }
  });

  assert.equal(report.content_left_machine, true);
});

test("createApiReport rejects empty client findings instead of reporting a pass", async () => {
  const report = await createApiReport({
    env: { RESUME_COOKER_ALLOW_API: "true", OPENROUTER_API_KEY: "k" },
    clientFactory: () => ({ model: "m", review: async () => [] })
  });

  assert.equal(report.status, "pass_with_warnings");
  assert.equal(report.checks[0].id, "api_review_invalid");
});

test("createApiReport refuses oversized API input without sending content", async () => {
  let called = false;
  const report = await createApiReport({
    env: {
      RESUME_COOKER_ALLOW_API: "true",
      RESUME_COOKER_API_PROVIDER: "openrouter",
      RESUME_COOKER_API_MAX_INPUT_CHARS: "3"
    },
    resumeText: "abcd",
    clientFactory: () => {
      called = true;
    }
  });

  assert.equal(called, false);
  assert.equal(report.content_left_machine, false);
  assert.equal(report.checks[0].id, "api_input_too_large");
});

test("createApiReport falls back to a secure input cap when configuration is malformed", async () => {
  let called = false;
  const report = await createApiReport({
    env: {
      RESUME_COOKER_ALLOW_API: "true",
      OPENROUTER_API_KEY: "k",
      RESUME_COOKER_API_MAX_INPUT_CHARS: "not-a-number"
    },
    resumeText: "x".repeat(24_001),
    clientFactory: () => {
      called = true;
    }
  });

  assert.equal(called, false);
  assert.equal(report.checks[0].id, "api_input_too_large");
});

test("createApiReport runs the injected client and records content leaving the machine", async () => {
  const report = await createApiReport({
    env: { RESUME_COOKER_ALLOW_API: "true", RESUME_COOKER_API_PROVIDER: "anthropic" },
    resumeText: "resume",
    jdText: "jd",
    clientFactory: () => ({
      model: "test-model",
      review: async ({ resumeText, jdText }) => {
        assert.equal(resumeText, "resume");
        assert.equal(jdText, "jd");
        return [
          createCheck({
            id: "clarity",
            suite: "api",
            category: "api_review",
            status: "warning",
            contentLeftMachine: true
          })
        ];
      }
    })
  });

  assert.equal(report.content_left_machine, true);
  assert.equal(report.checks[0].id, "clarity");
});

test("createApiReport turns a client error into a warning without crashing", async () => {
  const report = await createApiReport({
    env: { RESUME_COOKER_ALLOW_API: "true", RESUME_COOKER_API_PROVIDER: "anthropic" },
    clientFactory: () => ({
      model: "test-model",
      review: async () => {
        throw new Error("rate limited");
      }
    })
  });

  assert.equal(report.checks[0].id, "api_review_failed");
  assert.equal(report.checks[0].evidence, "Provider request failed.");
});
