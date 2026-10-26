import assert from "node:assert/strict";
import { test } from "node:test";

import { runFrozenAcceptance } from "../../../src/corpus/acceptance/index.ts";
import { frozenAcceptedBundle } from "../accepted-fixture-source.ts";

test("restart replays all accepted fixtures and preserves reconciliation", async () => {
  const paths = await frozenAcceptedBundle();
  const identity = {
    sourceRevision: "a".repeat(40),
    sourceTree: "b".repeat(40),
    clean: true,
  };
  let calls = 0;
  const ports = {
    currentIdentity() {
      return identity;
    },
    async runFixture() {
      calls += 1;
      return { ok: true } as const;
    },
  };
  const first = await runFrozenAcceptance(
    paths.bundlePath,
    paths.ledgerPath,
    ports,
  );
  const second = await runFrozenAcceptance(
    paths.bundlePath,
    paths.ledgerPath,
    ports,
  );

  assert.equal(calls, 8);
  assert.equal(first.status, "accepted_fixture");
  assert.deepEqual(second.entries, first.entries);
  assert.equal(second.offlineTruthSeal, first.offlineTruthSeal);
});
