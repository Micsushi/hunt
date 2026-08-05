import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createCorpusBaseline,
  validateBaselineReport,
  writeImmutableBaseline,
} from "../../../src/corpus/runner/index.ts";
import { freezeCorpusManifest } from "../../../src/corpus/manifest/index.ts";

function inputs() {
  return {
    manifest: JSON.parse(readFileSync(resolve("corpus/workday-40/manifest.json"), "utf8")),
    fixtures: JSON.parse(readFileSync(resolve("fixtures/workday/corpus/manifest.json"), "utf8")),
    variants: JSON.parse(readFileSync(resolve("corpus/workday-40/variants.json"), "utf8")),
    sourceRevision: "16c48bd1470addc9d9480d785ae84e412edd55ef",
    fixtureRoot: resolve("fixtures/workday/corpus"),
  };
}

test("the offline baseline is sequential, complete, and reproducible", () => {
  const first = createCorpusBaseline(inputs());
  const second = createCorpusBaseline(inputs());
  assert.deepEqual(first, second);
  assert.deepEqual(validateBaselineReport(first, inputs()), []);
  assert.equal(first.outcomes.length, 40);
  assert.deepEqual(first.outcomes.map((outcome: { sequence: number }) => outcome.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.equal(first.outcomes.filter((outcome: { kind: string }) => outcome.kind === "application_ready").length, 29);
  assert.equal(first.outcomes.filter((outcome: { kind: string; reason?: string }) => outcome.kind === "posting_unavailable" && outcome.reason === "maintenance").length, 11);
  assert.equal(JSON.stringify(first).toLowerCase().includes("submit"), true);
  assert.equal(first.safety.finalSubmitActivated, false);
});

test("a partial sequential report resumes without changing the final report", () => {
  const full = createCorpusBaseline(inputs());
  const resumed = createCorpusBaseline(inputs(), full.outcomes.slice(0, 10));
  assert.deepEqual(resumed, full);
});

test("access control is not collapsed into dead-posting state", () => {
  const changed = inputs();
  changed.manifest.slots[0].availability = {
    kind: "unavailable",
    reason: "access_control",
    observedAt: "2026-07-23",
  };
  changed.manifest = freezeCorpusManifest(changed.manifest);
  const report = createCorpusBaseline(changed);
  assert.equal(report.outcomes[0]!.kind, "access_blocked");
  assert.equal(report.outcomes[0]!.reason, "access_control");
});

test("baseline preflight rejects a malformed frozen manifest", () => {
  const changed = inputs();
  changed.manifest.slots[1].jobRef = changed.manifest.slots[0].jobRef;
  assert.throws(() => createCorpusBaseline(changed), /baseline manifest validation failed/u);
});

test("immutable reports are reused only when their bytes are unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-corpus-baseline-"));
  try {
    const report = createCorpusBaseline(inputs());
    const first = writeImmutableBaseline(report, root);
    const second = writeImmutableBaseline(report, root);
    assert.equal(first, second);
    assert.deepEqual(JSON.parse(readFileSync(first, "utf8")), report);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
