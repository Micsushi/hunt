import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createFrozenBundle, type FreezeSource } from "../../../src/corpus/freeze/index.ts";
import { auditAcceptanceArtifacts } from "../../../src/corpus/audit/index.ts";
import {
  runFrozenAcceptance,
  verifyAcceptanceReport,
  type AcceptedOutcome,
  type AcceptancePorts,
} from "../../../src/corpus/acceptance/index.ts";

async function frozen(): Promise<{ bundlePath: string; ledgerPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "hunt-corpus-acceptance-"));
  await mkdir(join(root, "fixtures"));
  await writeFile(join(root, "package-lock.json"), "lock\n");
  const slots = Array.from({ length: 40 }, (_, index) => ({
    slotId: `slot-${String(index + 1).padStart(2, "0")}`,
    availability: index === 39 ? "removed" : "available",
    variantFamily: index % 2 === 0 ? "account" : "questionnaire",
  }));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, slots }));
  await writeFile(join(root, "variant-map.json"), JSON.stringify({ schemaVersion: 1, families: ["account", "questionnaire"] }));
  await writeFile(join(root, "config.json"), JSON.stringify({ schemaVersion: 1, mode: "deterministic_fixture", maxAttemptsPerSlot: 2, accountRefs: ["account-primary"] }));
  await writeFile(join(root, "fixtures", "account.json"), '{"expected":"passed"}\n');
  await writeFile(join(root, "fixtures", "questionnaire.json"), '{"expected":"passed"}\n');
  await writeFile(join(root, "fixtures", "fixture-matrix.json"), JSON.stringify({ schemaVersion: 1, expected: "passed", families: ["account", "questionnaire"] }));
  const source: FreezeSource = {
    repositoryRoot: root,
    executionerRoot: root,
    sourceRevision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    clean: true,
    packageLockPath: join(root, "package-lock.json"),
    manifestPath: join(root, "manifest.json"),
    variantMapPath: join(root, "variant-map.json"),
    configPath: join(root, "config.json"),
    fixtureRoot: join(root, "fixtures"),
  };
  const bundlePath = join(root, ".runtime", "bundle.json");
  await createFrozenBundle(source, bundlePath);
  return { bundlePath, ledgerPath: join(root, ".runtime", "ledger.json") };
}

function ports(overrides: Partial<AcceptancePorts> = {}) {
  const calls: string[] = [];
  let transient = true;
  const review = { kind: "review_reached" } as const satisfies AcceptedOutcome;
  const truth = new Map(
    Array.from({ length: 40 }, (_, index) => [
      `slot-${String(index + 1).padStart(2, "0")}`,
      index === 39 ? { kind: "policy_stop", reason: "removed" } as const : review,
    ]),
  );
  const value: AcceptancePorts = {
    currentIdentity() {
      return { sourceRevision: "a".repeat(40), sourceTree: "b".repeat(40), clean: true };
    },
    async runFixture(fixtureId) {
      calls.push(`fixture:${fixtureId}`);
      return { ok: true };
    },
    async captureAndSealTruth(slotIds) {
      calls.push("truth:sealed");
      assert.equal(slotIds.length, 40);
      return { seal: "truth-seal", outcomes: truth };
    },
    async runSlot(slotId) {
      calls.push(`run:${slotId}`);
      if (slotId === "slot-01" && transient) {
        transient = false;
        return { ok: false, code: "browser_timeout", retryable: true };
      }
      return { ok: true, outcome: truth.get(slotId)! };
    },
    ...overrides,
  };
  return { calls, value };
}

test("fixtures precede sealed truth and sequential reconciled corpus execution", async () => {
  const paths = await frozen();
  const fake = ports();
  const report = await runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, fake.value);

  assert.equal(report.status, "accepted_fixture");
  assert.equal(report.mode, "deterministic_fixture");
  assert.equal(report.liveCorpusCertified, false);
  assert.equal(report.slotCount, 40);
  assert.equal(report.acceptedCount, 40);
  assert.match(report.truthSeal, /^sha256\.[0-9a-f]{64}$/u);
  assert.notEqual(report.truthSeal, "truth-seal");
  const lastFixture = Math.max(...fake.calls.map((call, index) => call.startsWith("fixture:") ? index : -1));
  assert.ok(fake.calls.indexOf("truth:sealed") > lastFixture);
  assert.ok(fake.calls.indexOf("truth:sealed") < fake.calls.findIndex((call) => call.startsWith("run:")));
  assert.equal(fake.calls.filter((call) => call === "run:slot-01").length, 2);
  assert.doesNotMatch(JSON.stringify(report), /submit|password|@/iu);
  assert.deepEqual(verifyAcceptanceReport(report), []);
  assert.ok(verifyAcceptanceReport({ ...report, acceptedCount: 39 }).length > 0);
});

test("diagnostic disagreement is an acceptance blocker", async () => {
  const paths = await frozen();
  const fake = ports({
    async runSlot() {
      return { ok: true, outcome: { kind: "policy_stop", reason: "manual_intervention" } };
    },
  });
  const report = await runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, fake.value);

  assert.equal(report.status, "rejected");
  assert.equal(report.entries[0]?.code, "browser_truth_mismatch");
  assert.equal(report.acceptedCount, 0);
});

test("restart reexecutes slots instead of trusting ledger claims", async () => {
  const paths = await frozen();
  const first = ports();
  await runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, first.value);
  const resumed = ports();
  const report = await runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, resumed.value);

  assert.equal(report.status, "accepted_fixture");
  assert.equal(resumed.calls.filter((call) => call.startsWith("run:")).length, 41);
});

test("restart reruns an accepted slot when fresh browser truth changes", async () => {
  const paths = await frozen();
  await runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, ports().value);
  const resumed = ports({
    async captureAndSealTruth(slotIds) {
      return {
        seal: "forged",
        outcomes: new Map(slotIds.map((slotId) => [
          slotId,
          slotId === "slot-01"
            ? { kind: "policy_stop", reason: "removed" } as const
            : slotId === "slot-40"
              ? { kind: "policy_stop", reason: "removed" } as const
              : { kind: "review_reached" } as const,
        ])),
      };
    },
  });
  const report = await runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, resumed.value);

  assert.equal(resumed.calls.filter((call) => call === "run:slot-01").length, 2);
  assert.equal(report.entries[0]?.status, "rejected");
});

test("source drift and unsafe port outcomes fail closed", async () => {
  const paths = await frozen();
  let checks = 0;
  const drifted = ports({
    currentIdentity() {
      checks += 1;
      return {
        sourceRevision: (checks > 1 ? "c" : "a").repeat(40),
        sourceTree: "b".repeat(40),
        clean: true,
      };
    },
  });
  await assert.rejects(
    () => runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, drifted.value),
    /frozen source drift/,
  );
  assert.equal(drifted.calls.some((call) => call.startsWith("run:")), false);

  const unsafePaths = await frozen();
  const unsafe = ports({
    async runSlot() {
      return {
        ok: true,
        outcome: { kind: "review_reached", rawText: "private value" } as never,
      };
    },
  });
  await assert.rejects(
    () => runFrozenAcceptance(unsafePaths.bundlePath, unsafePaths.ledgerPath, unsafe.value),
    /acceptance outcome invalid/,
  );
});

test("artifact audit validates the sealed report, ledger, and recovery bounds", async () => {
  const paths = await frozen();
  const report = await runFrozenAcceptance(paths.bundlePath, paths.ledgerPath, ports().value);
  const reportPath = join(paths.bundlePath, "..", "report.json");
  await writeFile(reportPath, JSON.stringify(report));
  const current = { sourceRevision: "a".repeat(40), sourceTree: "b".repeat(40), clean: true };

  assert.deepEqual(await auditAcceptanceArtifacts(paths.bundlePath, current), []);
  await writeFile(reportPath, JSON.stringify({ ...report, acceptedCount: 39 }));
  assert.ok((await auditAcceptanceArtifacts(paths.bundlePath, current)).includes("acceptance_report_seal_invalid"));
});
