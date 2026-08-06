import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { runStaticCorpusAudit, validateIssueDispositions } from "../../src/corpus/audit/index.ts";
import { scanCorpusPrivacyFiles } from "../../src/corpus/audit/privacy.ts";

const impactSha =
  "sha256.0ef3d9b22e2813d3f459c2c8fab4c344f24f0ab886f23cf69de72ca97c3c62d4";

test("corpus audit preserves privacy, MCP capability, and module-size gates", async () => {
  const report = await runStaticCorpusAudit(resolve("."));

  assert.equal(report.status, "passed");
  assert.equal(report.acceptedImpactSha, impactSha);
  assert.deepEqual(report.dormantF3Artifacts, []);
  assert.deepEqual(report.privacyViolations, []);
  assert.deepEqual(report.exposedCapabilities, [
    "cancel_journey",
    "journey_result",
    "journey_status",
    "start_journey",
  ]);
  assert.equal(report.blockingIssues.length, 0);
  assert.deepEqual(report.schemaIssues, []);
  assert.ok(report.largeModules.length > 0);
  assert.ok(report.largeModules.every((module) => module.disposition.length > 0));
  assert.doesNotMatch(JSON.stringify(report), /password|access_token|@/iu);
});

test("issue gate blocks P0/P1 and undispositioned P2 findings", () => {
  assert.deepEqual(validateIssueDispositions([
    { id: "issue-1", severity: "P1", disposition: "fixed", regressionImpact: "covered" },
    { id: "issue-2", severity: "P2", disposition: "", regressionImpact: "covered" },
    { id: "issue-unknown", severity: "P4" as never, disposition: "ignored", regressionImpact: "unknown" },
  ]), ["blocking_issue:issue-1", "issue_severity_invalid:issue-unknown", "p2_disposition_missing:issue-2"]);
  assert.deepEqual(validateIssueDispositions([
    { id: "issue-3", severity: "P2", disposition: "accepted", regressionImpact: "no_behavior_change" },
  ]), []);
});

test("corpus privacy scan includes operator scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-corpus-privacy-"));
  try {
    await mkdir(join(root, "scripts"));
    await writeFile(
      join(root, "scripts", "operator.ts"),
      `const owner = 'person@${"example.com"}';\n`,
    );
    assert.deepEqual(scanCorpusPrivacyFiles(root), [{
      file: "scripts/operator.ts",
      code: "real_email",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
