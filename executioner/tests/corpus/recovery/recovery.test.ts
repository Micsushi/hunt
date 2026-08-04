import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFrozenAcceptance, type AcceptancePorts } from "../../../src/corpus/acceptance/index.ts";
import { createFrozenBundle } from "../../../src/corpus/freeze/index.ts";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hunt-corpus-recovery-"));
  await mkdir(join(root, "fixtures"));
  await writeFile(join(root, "package-lock.json"), "lock\n");
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, slots: Array.from({ length: 40 }, (_, index) => ({ slotId: `slot-${index + 1}`, availability: "available", variantFamily: "account" })) }));
  await writeFile(join(root, "variant-map.json"), '{"schemaVersion":1,"families":["account"]}');
  await writeFile(join(root, "config.json"), '{"schemaVersion":1,"mode":"deterministic_fixture","maxAttemptsPerSlot":2,"accountRefs":["account-primary"]}');
  await writeFile(join(root, "fixtures", "account.json"), "{}\n");
  const bundlePath = join(root, ".runtime", "bundle.json");
  await createFrozenBundle({ repositoryRoot: root, executionerRoot: root, sourceRevision: "a".repeat(40), sourceTree: "b".repeat(40), clean: true, packageLockPath: join(root, "package-lock.json"), manifestPath: join(root, "manifest.json"), variantMapPath: join(root, "variant-map.json"), configPath: join(root, "config.json"), fixtureRoot: join(root, "fixtures") }, bundlePath);
  return { root, bundlePath, ledgerPath: join(root, ".runtime", "ledger.json") };
}

test("retry is bounded and a stale ledger cannot cross a freeze identity", async () => {
  const value = await setup();
  let calls = 0;
  const ports: AcceptancePorts = {
    async runFixture() { return { ok: true }; },
    async captureAndSealTruth(ids) { return { seal: "sealed", outcomes: new Map(ids.map((id) => [id, { kind: "review_reached" } as const])) }; },
    async runSlot() { calls += 1; return { ok: false, code: "browser_timeout", retryable: true }; },
  };
  const report = await runFrozenAcceptance(value.bundlePath, value.ledgerPath, ports);
  assert.equal(report.status, "rejected");
  assert.equal(calls, 80);
  assert.ok(report.entries.every((entry) => entry.attempts === 2));

  const ledger = JSON.parse(await (await import("node:fs/promises")).readFile(value.ledgerPath, "utf8"));
  ledger.bundleIdentity = "different";
  await writeFile(value.ledgerPath, JSON.stringify(ledger));
  await assert.rejects(
    () => runFrozenAcceptance(value.bundlePath, value.ledgerPath, ports),
    /ledger identity mismatch/,
  );
});

test("frozen input drift stops recovery before corpus work", async () => {
  const value = await setup();
  await writeFile(join(value.root, "fixtures", "account.json"), '{"drift":true}\n');
  let called = false;
  const ports: AcceptancePorts = {
    async runFixture() { called = true; return { ok: true }; },
    async captureAndSealTruth() { throw new Error("unreachable"); },
    async runSlot() { throw new Error("unreachable"); },
  };
  await assert.rejects(
    () => runFrozenAcceptance(value.bundlePath, value.ledgerPath, ports),
    /frozen input drift/,
  );
  assert.equal(called, false);
});
