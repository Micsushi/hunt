import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createCheck,
  createReport,
  mergeReports,
  sanitizeProcessMessage,
  sanitizeReportValue,
  summarizeChecks,
  writeReport
} from "./report-lib.mjs";

test("createReport emits the documented schema version", () => {
  const report = createReport({ stage: "preflight", checks: [] });

  assert.equal(report.schema_version, 1);
});

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

test("mergeReports preserves content-left-machine metadata", () => {
  const local = createReport({
    stage: "preflight",
    suite: "local",
    checks: [createCheck({ id: "local_ok", category: "test" })]
  });
  const api = createReport({
    stage: "preflight",
    suite: "api",
    contentLeftMachine: true,
    checks: [createCheck({ id: "api_warn", category: "test", status: "warning" })]
  });

  const merged = mergeReports({
    stage: "preflight",
    suite: "full",
    reports: [local, api]
  });

  assert.equal(merged.status, "pass_with_warnings");
  assert.equal(merged.content_left_machine, true);
  assert.equal(merged.checks.length, 2);
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
});

test("sanitizeReportValue redacts secret-bearing keys, headers, URLs, and provider tokens", () => {
  const sanitized = sanitizeReportValue({
    authorization: "Bearer top-level-secret",
    apiKey: "sk-ant-api03-private",
    nested: {
      password: "correct horse battery staple",
      message:
        "Authorization: Bearer header-secret x-api-key: key-secret https://user:pass@example.test/a?token=query-secret sk-or-v1-providersecret"
    }
  });
  const serialized = JSON.stringify(sanitized);

  assert.equal(sanitized.authorization, "[redacted]");
  assert.equal(sanitized.apiKey, "[redacted]");
  assert.equal(sanitized.nested.password, "[redacted]");
  assert.doesNotMatch(
    serialized,
    /top-level-secret|private|correct horse|header-secret|key-secret|user:pass|query-secret|providersecret/
  );
});

test("writeReport returns only relative or redacted output paths", async (t) => {
  const relativePath = ".runtime/tests/report-write.json";
  const absolutePath = resolve(".runtime/tests/report-write-absolute.json");
  t.after(async () => {
    await rm(relativePath, { force: true });
    await rm(absolutePath, { force: true });
  });

  assert.equal(await writeReport({ status: "pass" }, relativePath), relativePath);
  assert.equal(await writeReport({ status: "pass" }, absolutePath), "[path]");
});
