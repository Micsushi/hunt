import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  runFrozenAcceptance,
  verifyAcceptanceReport,
} from "../../../src/corpus/acceptance/index.ts";
import { auditAcceptanceArtifacts } from "../../../src/corpus/audit/index.ts";
import { frozenAcceptedBundle } from "../accepted-fixture-source.ts";

test("accepted fixtures precede honest offline 40-slot reconciliation", async () => {
  const paths = await frozenAcceptedBundle();
  const calls: string[] = [];
  let retry = true;
  const report = await runFrozenAcceptance(
    paths.bundlePath,
    paths.ledgerPath,
    {
      currentIdentity() {
        return {
          sourceRevision: "a".repeat(40),
          sourceTree: "b".repeat(40),
          clean: true,
        };
      },
      async runFixture(fixtureId) {
        calls.push(fixtureId);
        if (retry) {
          retry = false;
          return { ok: false, code: "fixture_transient", retryable: true };
        }
        return { ok: true };
      },
    },
  );

  assert.equal(report.status, "accepted_fixture");
  assert.equal(report.mode, "deterministic_fixture");
  assert.equal(report.truthKind, "offline_fixture_artifacts");
  assert.equal(report.liveCorpusCertified, false);
  assert.equal(report.liveReviewCertified, false);
  assert.equal(report.reconciledCount, 40);
  assert.equal(report.entries.length, 40);
  assert.deepEqual(report.entries.map((entry) => entry.slotId), Array.from(
    { length: 40 },
    (_, index) => `WD40-${String(index + 1).padStart(3, "0")}`,
  ));
  assert.deepEqual(
    report.entries.filter((entry) => entry.variantIds.length === 0)
      .map((entry) => entry.slotId),
    ["WD40-009", "WD40-021"],
  );
  assert.deepEqual(calls, [
    "wd-page-auth-action-v1",
    "wd-page-auth-action-v1",
    "wd-page-external-state-v1",
    "wd-ui-scalar-composite-v1",
    "wd-ui-source-select-v1",
  ]);
  assert.deepEqual(verifyAcceptanceReport(report), []);
  assert.doesNotMatch(
    JSON.stringify(report),
    /review_reached|live_review|browser_truth|submit|password|@/iu,
  );
});

test("fixture failure and stale recovery ledger fail closed", async () => {
  const paths = await frozenAcceptedBundle();
  const identity = {
    sourceRevision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    clean: true,
  };
  const rejected = await runFrozenAcceptance(
    paths.bundlePath,
    paths.ledgerPath,
    {
      currentIdentity() {
        return identity;
      },
      async runFixture() {
        return { ok: false, code: "fixture_failed", retryable: true };
      },
    },
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.fixtures[0]?.attempts, 2);
  assert.equal(rejected.reconciledCount, 0);

  await writeFile(
    paths.ledgerPath,
    JSON.stringify({
      schemaVersion: 1,
      bundleIdentity: "sha256." + "0".repeat(64),
      fixtures: [],
      entries: [],
      seal: "sha256." + "0".repeat(64),
    }),
  );
  let called = false;
  await assert.rejects(
    () => runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, {
      currentIdentity() {
        return identity;
      },
      async runFixture() {
        called = true;
        return { ok: true };
      },
    }),
    /acceptance ledger invalid/,
  );
  assert.equal(called, false);
});

test("report seal and source identity cannot be forged", async () => {
  const paths = await frozenAcceptedBundle();
  let checks = 0;
  await assert.rejects(
    () => runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, {
      currentIdentity() {
        checks += 1;
        return {
          sourceRevision: (checks > 1 ? "c" : "a").repeat(40),
          sourceTree: "b".repeat(40),
          clean: true,
        };
      },
      async runFixture() {
        return { ok: true };
      },
    }),
    /frozen source drift/,
  );

  const validPaths = await frozenAcceptedBundle();
  const report = await runFrozenAcceptance(
    validPaths.bundlePath,
    validPaths.ledgerPath,
    {
      currentIdentity() {
        return {
          sourceRevision: "a".repeat(40),
          sourceTree: "b".repeat(40),
          clean: true,
        };
      },
      async runFixture() {
        return { ok: true };
      },
    },
  );
  assert.ok(
    verifyAcceptanceReport({ ...report, reconciledCount: 39 }).includes(
      "acceptance_report_seal_invalid",
    ),
  );
  await writeFile(
    join(validPaths.bundlePath, "..", "report.json"),
    JSON.stringify(report),
  );
  assert.deepEqual(await auditAcceptanceArtifacts(
    validPaths.bundlePath,
    {
      sourceRevision: "a".repeat(40),
      sourceTree: "b".repeat(40),
      clean: true,
    },
  ), []);
});
