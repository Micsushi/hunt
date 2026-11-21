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

test("resuming a partial baseline reproduces the same immutable report", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-corpus-baseline-"));
  try {
    const report = createCorpusBaseline(inputs());
    const resumed = createCorpusBaseline(inputs(), report.outcomes.slice(0, 10));
    assert.deepEqual(resumed, report);
    const first = writeImmutableBaseline(resumed, root);
    const second = writeImmutableBaseline(report, root);
    assert.equal(first, second);
    assert.deepEqual(JSON.parse(readFileSync(first, "utf8")), report);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
