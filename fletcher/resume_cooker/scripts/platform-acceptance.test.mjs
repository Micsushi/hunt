import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertGitStatusUnchanged,
  assessPlatformClaim,
  auditPackageFiles,
  hashPackageContents,
  resolveAcceptanceOutput,
  sanitizePlatformEvidence,
  validateCliReport,
  waitForPreviewPdf
} from "./platform-acceptance.mjs";

const passingChecks = [
  { id: "root-ci", required: true, status: "pass" },
  { id: "production-audit", required: true, status: "pass" },
  { id: "package", required: true, status: "pass" },
  { id: "fresh-install", required: true, status: "pass" },
  { id: "public-pdf-check", required: true, status: "pass" },
  { id: "public-compare", required: true, status: "pass" },
  { id: "preview-lifecycle", required: true, status: "pass" },
  { id: "artifact-privacy", required: true, status: "pass" },
  { id: "browser-ui", required: true, status: "pass" }
];
const passingIdentities = {
  node: "v22.17.0",
  npm: "11.4.2",
  docker: "28.3.2",
  browser: "Chromium 138.0",
  desktop: { available: true, kind: "local-display" }
};

test("platform acceptance certifies only a matching real desktop with every required row", () => {
  assert.deepEqual(
    assessPlatformClaim({
      claim: "windows",
      platform: "win32",
      inContainer: false,
      identities: passingIdentities,
      checks: passingChecks
    }),
    {
      certified: true,
      claim: "windows",
      evidence_class: "T2-capability:windows",
      reason: "All required windows desktop acceptance rows passed."
    }
  );
});

test("platform acceptance rejects malformed schema/privacy reports", () => {
  const valid = {
    schema_version: 1,
    command: "compare",
    status: "pass_with_warnings",
    content_left_machine: false,
    checks: []
  };
  assert.equal(validateCliReport(valid, { command: "compare" }), valid);

  for (const report of [
    { ...valid, schema_version: 2 },
    { ...valid, content_left_machine: true },
    { ...valid, content_left_machine: undefined },
    { ...valid, command: "check" },
    { ...valid, status: "skipped" }
  ]) {
    assert.throws(() => validateCliReport(report, { command: "compare" }), /invalid packaged/i);
  }

  assert.throws(
    () =>
      validateCliReport(
        {
          schema_version: 1,
          command: "tools",
          status: "pass",
          content_left_machine: false
        },
        { command: "tools", requireTools: true }
      ),
    /tools/
  );
});

test("platform acceptance package audit requires support docs and rejects private/runtime files", () => {
  const valid = [
    "README.md",
    "WINDOWS_COMPATIBILITY.md",
    "MACOS_COMPATIBILITY.md",
    "LINUX_COMPATIBILITY.md",
    "docs/container-boundary.md",
    "docs/platform-acceptance.md",
    "cli/resume-cooker.mjs",
    "fixtures/compare/corrupt.pdf",
    "LICENSE",
    "package.json"
  ];
  const validAudit = auditPackageFiles(valid);
  assert.equal(validAudit.ok, true);
  assert.deepEqual(validAudit.forbidden, []);
  assert.deepEqual(validAudit.missing, []);

  const invalid = [
    ...valid.filter((path) => path !== "MACOS_COMPATIBILITY.md"),
    ".env",
    ".runtime/x",
    "resume/source/current.tex",
    "resume/source/ats.tex",
    "fixtures/resume_extracted_text.txt"
  ];
  const invalidAudit = auditPackageFiles(invalid);
  assert.equal(invalidAudit.ok, false);
  assert.deepEqual(invalidAudit.forbidden, [
    ".env",
    ".runtime/x",
    "fixtures/resume_extracted_text.txt",
    "resume/source/ats.tex",
    "resume/source/current.tex"
  ]);
  assert.deepEqual(invalidAudit.missing, ["MACOS_COMPATIBILITY.md"]);
});
