import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  normalizeCapture,
  replayFixture,
  validateCorpusFixtures,
} from "../../../src/corpus/capture/index.ts";
import { frozenDigest } from "../../../src/corpus/shared.ts";

const structuralCapture = {
  schemaVersion: 1,
  captureMode: "read-only-approved-page",
  fixtureId: "wd-page-auth-action-v1",
  captureRevision: "legacy-v2-20260723",
  provingSlots: ["WD40-002", "WD40-006"],
  variantIds: ["WD-PAGE-AUTH-ACTION-V1"],
  observation: {
    pageKind: "auth",
    siteState: "available",
    controls: [
      { id: "auth-primary", kind: "button", role: "account-action", required: true, state: "actionable" },
    ],
    questions: [],
  },
};

test("capture admission is structural, bounded, and deterministic", () => {
  const first = normalizeCapture(structuralCapture);
  const reordered = normalizeCapture({
    ...structuralCapture,
    variantIds: [...structuralCapture.variantIds].reverse(),
    provingSlots: [...structuralCapture.provingSlots].reverse(),
  });
  assert.deepEqual(first, reordered);
  assert.match(first.semanticHash, /^sha256\.[a-f0-9]{64}$/u);
  assert.deepEqual(replayFixture(first), first.observation);

  assert.throws(
    () => normalizeCapture({ ...structuralCapture, rawPageText: "private page" }),
    /capture contains forbidden key: rawPageText/u,
  );
  assert.throws(
    () => normalizeCapture({ ...structuralCapture, applicantEmail: "person@example.invalid" }),
    /capture contains unsupported key: applicantEmail/u,
  );
  assert.throws(
    () => normalizeCapture({ ...structuralCapture, provingSlots: Array(41).fill("WD40-001") }),
    /provingSlots exceeds 40 entries/u,
  );
  assert.throws(
    () => normalizeCapture({ ...structuralCapture, semanticHash: "sha256." + "0".repeat(64) }),
    /semanticHash does not match normalized structural content/u,
  );
});

test("the committed corpus fixture set is sanitized and replays offline", () => {
  const root = resolve("fixtures/workday/corpus");
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
  const corpus = JSON.parse(readFileSync(resolve("corpus/workday-40/manifest.json"), "utf8"));
  assert.deepEqual(validateCorpusFixtures(root, manifest, corpus), []);
});

test("fixture manifest rows reject raw source metadata", () => {
  const root = resolve("fixtures/workday/corpus");
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
  manifest.fixtures[0].sourceUrl = "https://tenant.invalid/job/1";
  manifest.freeze.digest = frozenDigest(manifest);
  const corpus = JSON.parse(readFileSync(resolve("corpus/workday-40/manifest.json"), "utf8"));
  assert.ok(validateCorpusFixtures(root, manifest, corpus).includes(
    `fixtures[0] contains unsupported field sourceUrl`,
  ));
});
