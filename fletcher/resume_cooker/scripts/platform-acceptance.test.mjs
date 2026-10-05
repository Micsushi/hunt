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

test("platform acceptance rejects OS mismatch, container desktop, missing browser, and skips", () => {
  const cases = [
    {
      input: {
        claim: "macos",
        platform: "win32",
        inContainer: false,
        identities: passingIdentities,
        checks: passingChecks
      },
      reason: /requires darwin/
    },
    {
      input: {
        claim: "linux",
        platform: "linux",
        inContainer: true,
        identities: passingIdentities,
        checks: passingChecks
      },
      reason: /container cannot certify/
    },
    {
      input: {
        claim: "macos",
        platform: "darwin",
        inContainer: false,
        identities: passingIdentities,
        checks: passingChecks.filter((check) => check.id !== "browser-ui")
      },
      reason: /browser-ui/
    },
    {
      input: {
        claim: "linux",
        platform: "linux",
        inContainer: false,
        identities: passingIdentities,
        checks: passingChecks.map((check) =>
          check.id === "package" ? { ...check, status: "skipped" } : check
        )
      },
      reason: /package/
    }
  ];

  for (const { input, reason } of cases) {
    const result = assessPlatformClaim(input);
    assert.equal(result.certified, false);
    assert.match(result.reason, reason);
  }
});

test("platform acceptance allows headless core evidence without a desktop support claim", () => {
  const result = assessPlatformClaim({
    claim: "core",
    platform: "linux",
    inContainer: true,
    identities: { ...passingIdentities, browser: null, desktop: { available: false } },
    checks: passingChecks.filter((check) => check.id !== "browser-ui")
  });
  assert.deepEqual(result, {
    certified: true,
    claim: "core",
    evidence_class: "T2-core",
    reason: "All required core acceptance rows passed."
  });
});

test("platform acceptance rejects incomplete runtimes and missing desktop/display evidence", () => {
  for (const [identities, reason] of [
    [{ ...passingIdentities, node: "v21.7.3" }, /Node 22/],
    [{ ...passingIdentities, npm: null }, /npm identity/],
    [{ ...passingIdentities, docker: null }, /Docker identity/],
    [{ ...passingIdentities, browser: null }, /browser identity/],
    [{ ...passingIdentities, desktop: { available: false } }, /desktop\/display/]
  ]) {
    const result = assessPlatformClaim({
      claim: "linux",
      platform: "linux",
      inContainer: false,
      identities,
      checks: passingChecks
    });
    assert.equal(result.certified, false);
    assert.match(result.reason, reason);
  }
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

test("acceptance output must stay under ignored runtime evidence storage", () => {
  const workspaceRoot =
    process.platform === "win32" ? "C:\\workspace\\resume-cooker" : "/workspace/resume-cooker";
  const valid = resolveAcceptanceOutput({
    workspaceRoot,
    output: ".runtime/platform-acceptance/custom.json",
    claim: "core",
    hostPlatform: "linux"
  });
  assert.match(valid.replaceAll("\\", "/"), /\.runtime\/platform-acceptance\/custom\.json$/);
  assert.throws(
    () =>
      resolveAcceptanceOutput({
        workspaceRoot,
        output: "evidence.json",
        claim: "core",
        hostPlatform: "linux"
      }),
    /ignored \.runtime\/platform-acceptance/
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

test("package is private, MIT licensed, and excludes resume-content directories", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "MIT");
  assert.ok(!packageJson.files.includes("resume/source/"));
  assert.ok(packageJson.files.includes("!fixtures/resume_extracted_text.txt"));
});

test("package inventory hash changes with file content, not input order", async () => {
  const root = await mkdtemp(join(tmpdir(), "resume-cooker-package-hash-"));
  await writeFile(join(root, "a.txt"), "alpha", "utf8");
  await writeFile(join(root, "b.txt"), "beta", "utf8");
  const first = await hashPackageContents(["a.txt", "b.txt"], { workspaceRoot: root });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(await hashPackageContents(["b.txt", "a.txt"], { workspaceRoot: root }), first);

  await writeFile(join(root, "b.txt"), "changed", "utf8");
  assert.notEqual(await hashPackageContents(["a.txt", "b.txt"], { workspaceRoot: root }), first);
});

test("acceptance Git status proof rejects any tracked or untracked delta", () => {
  assert.doesNotThrow(() => assertGitStatusUnchanged("same\n", "same\n"));
  assert.throws(
    () => assertGitStatusUnchanged("same\n", "same\n?? escaped.txt\n"),
    /Git status changed/
  );
});

test("platform acceptance evidence removes workspace paths, secrets, and raw output", () => {
  const evidence = sanitizePlatformEvidence(
    {
      workspace: "C:\\Users\\person\\resume",
      token: "token=abc123",
      checks: [
        { id: "root-ci", stdout: "private resume text", stderr: "secret=xyz", status: "pass" }
      ]
    },
    { workspaceRoot: "C:\\Users\\person\\resume" }
  );

  assert.deepEqual(evidence, {
    workspace: "[workspace]",
    token: "[redacted]",
    checks: [{ id: "root-ci", status: "pass" }]
  });
  assert.doesNotMatch(JSON.stringify(evidence), /person|abc123|private resume|xyz/);
});

test("preview acceptance waits for the initial compile before requesting the PDF", async () => {
  const requested = [];
  let statusCalls = 0;
  const authenticatedFetch = async (path) => {
    requested.push(path);
    if (path === "/api/status") {
      statusCalls += 1;
      return globalThis.Response.json({
        state: statusCalls === 1 ? "running" : "current",
        builtAt: statusCalls === 1 ? null : "2026-07-27T00:00:00.000Z"
      });
    }
    if (path === "/preview.pdf") {
      return new globalThis.Response(new Uint8Array([1, 2, 3]));
    }
    return new globalThis.Response(null, { status: 404 });
  };

  const pdf = await waitForPreviewPdf(authenticatedFetch, {
    timeoutMs: 100,
    sleepImpl: async () => {}
  });

  assert.equal(pdf.byteLength, 3);
  assert.deepEqual(requested, ["/api/status", "/api/status", "/preview.pdf"]);
});
