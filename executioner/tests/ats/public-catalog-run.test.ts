import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createPublicCatalogRun,
  failPublicCatalogRun,
  finalizePublicCatalogRun,
  preservePublicCatalogFailure,
  tryFailPublicCatalogRun,
} from "../../scripts/public-catalog-run.ts";

test("catalog runs publish a unique hash-bound candidate and evidence pair", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hunt-public-catalog-run-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const first = createPublicCatalogRun(root, "run-first");
  const second = createPublicCatalogRun(root, "run-second");
  assert.notEqual(first.stagingDirectory, second.stagingDirectory);

  const candidate = "company name,job name,link\nAcme,Engineer,https://example.invalid\n";
  const evidence = '{"matched":true}\n';
  writeFileSync(first.candidatePath, candidate, { encoding: "utf8", flag: "wx" });
  writeFileSync(first.evidencePath, evidence, { encoding: "utf8", flag: "wx" });
  const published = finalizePublicCatalogRun(first, {
    sourceSha256: "a".repeat(64),
    rows: 100,
    verified: true,
  });
  const manifest = JSON.parse(readFileSync(published.manifestPath, "utf8"));

  assert.equal(existsSync(first.stagingDirectory), false);
  assert.equal(existsSync(published.directory), true);
  assert.equal(manifest.runId, "run-first");
  assert.equal(manifest.verified, true);
  assert.equal(manifest.candidateSha256, createHash("sha256").update(candidate).digest("hex"));
  assert.equal(manifest.evidenceSha256, createHash("sha256").update(evidence).digest("hex"));
});

test("failed catalog runs are retained under an explicitly failed directory", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hunt-public-catalog-run-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const run = createPublicCatalogRun(root, "run-failed");
  const failedDirectory = failPublicCatalogRun(run);

  assert.equal(existsSync(run.stagingDirectory), false);
  assert.equal(existsSync(failedDirectory), true);
  assert.match(failedDirectory, /\.failed$/u);
});

test("catalog run creation refuses a pre-existing staging directory", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hunt-public-catalog-run-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "run-existing.tmp"));
  assert.throws(() => createPublicCatalogRun(root, "run-existing"), /already exists/u);
});

test("failed-run retention cannot mask the original refresh error", (context) => {
  const root = mkdtempSync(join(tmpdir(), "hunt-public-catalog-run-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const run = createPublicCatalogRun(root, "run-mask-check");
  mkdirSync(run.failedDirectory);
  const original = new Error("original refresh failure");
  assert.equal(tryFailPublicCatalogRun(run), null);
  assert.throws(() => preservePublicCatalogFailure(run, original), (error) => error === original);
});
