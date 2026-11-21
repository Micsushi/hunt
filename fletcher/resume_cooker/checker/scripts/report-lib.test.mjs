import assert from "node:assert/strict";
import { test } from "node:test";
import { createCheck, sanitizeProcessMessage, sanitizeReportValue, summarizeChecks } from "./report-lib.mjs";

test("summarizeChecks maps blockers to fail and warnings to pass_with_warnings", () => {
  assert.equal(summarizeChecks([createCheck({ id: "ok", category: "test" })]), "pass");
  assert.equal(
    summarizeChecks([createCheck({ id: "warn", category: "test", status: "warning" })]),
    "pass_with_warnings"
  );
  assert.equal(
    summarizeChecks([
      createCheck({ id: "fail", category: "test", severity: "blocker", status: "fail" })
    ]),
    "fail"
  );
});

test("sanitizeReportValue recursively removes host paths and assigned secrets", () => {
  const value = sanitizeReportValue({
    evidence: "C:\\Users\\Jane Doe\\private-resume.pdf",
    nested: [
      "/home/private/report.json",
      "/tmp/private resume/report.json",
      "\\\\server\\private share\\resume.pdf",
      "C:/Users/Jane Doe/private.pdf",
      "file:///C:/Users/Jane%20Doe/private.pdf",
      { token: "token=secret-value" }
    ],
    credentials: {
      authorization: "Bearer top-level-secret",
      apiKey: "sk-ant-api03-private",
      password: "correct horse battery staple",
      message: "Authorization: Bearer header-secret x-api-key: key-secret https://user:pass@example.test/a?token=query-secret sk-or-v1-providersecret"
    },
    url: "https://example.test/public"
  });

  assert.doesNotMatch(
    JSON.stringify(value),
    /Users|Jane|server|private|resume\/report|secret-value|file:/
  );
  assert.match(value.evidence, /\[path\]/);
  assert.equal(value.url, "https://example.test/public");
  assert.equal(
    sanitizeProcessMessage("failed at /tmp/private-resume.json\nagain"),
    "failed at [path] again"
  );
  assert.equal(value.credentials.authorization, "[redacted]");
  assert.equal(value.credentials.apiKey, "[redacted]");
  assert.equal(value.credentials.password, "[redacted]");
  assert.doesNotMatch(JSON.stringify(value), /top-level-secret|correct horse|header-secret|key-secret|user:pass|query-secret|providersecret/);
});
