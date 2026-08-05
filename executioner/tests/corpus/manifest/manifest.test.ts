import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  corpusManifestFromCsv,
  freezeCorpusManifest,
  validateCorpusManifest,
} from "../../../src/corpus/manifest/index.ts";

function candidate(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    corpusId: "workday-40",
    source: {
      kind: "committed_csv",
      reference: "wd_test_jobs.csv#rows-2-41",
      revision: "16c48bd1470addc9d9480d785ae84e412edd55ef",
      evidenceDigests: ["sha256." + "a".repeat(64)],
    },
    ownerApproval: {
      status: "approved",
      recordRef: "s3-f1-owner-delegation-2026-08-04",
      approvedAt: "2026-08-04",
    },
    replacementPolicy: {
      immutableFields: ["slotId", "tenantRef", "variantIntent", "accountMode"],
      equivalenceFields: ["tenantRef", "variantIntent", "accountMode"],
      unavailableIsProductFailure: false,
    },
    slots: Array.from({ length: 40 }, (_, index) => ({
      slotId: `WD40-${String(index + 1).padStart(3, "0")}`,
      jobRef: `sha256.${String(index + 1).padStart(64, "0")}`,
      sourceRef: `wd_test_jobs.csv#row-${index + 2}`,
      tenantRef: `tenant.${String(index + 1).padStart(16, "0")}`,
      tenantClass: "wd5",
      variantIntent: ["workday-posting", "account-or-direct-entry"],
      accountMode: "approved-existing-or-direct",
      availability:
        index === 0
          ? { kind: "unavailable", reason: "maintenance", observedAt: "2026-07-23" }
          : { kind: "available", observedAt: "2026-07-23" },
      replacementDecision:
        index === 0
          ? {
              kind: "retain-unavailable",
              reason: "No equivalent replacement was approved; retain the site-state lane.",
              approvalRef: "s3-f1-owner-delegation-2026-08-04",
            }
          : { kind: "not-needed" },
    })),
  };
}

test("a frozen corpus has exactly 40 immutable, privacy-safe slots", () => {
  const frozen = freezeCorpusManifest(candidate());
  assert.deepEqual(validateCorpusManifest(frozen), []);
  assert.match(frozen.freeze.digest, /^sha256\.[a-f0-9]{64}$/u);

  const duplicate = structuredClone(frozen);
  duplicate.slots[1]!.jobRef = duplicate.slots[0]!.jobRef;
  assert.deepEqual(validateCorpusManifest(duplicate), [
    "slots[1].jobRef duplicates slots[0].jobRef",
    "freeze.digest does not match canonical manifest content",
  ]);
});

test("replacement equivalence and unavailable site state are enforced", () => {
  const replacement = candidate();
  const slots = replacement.slots as Record<string, unknown>[];
  slots[0]!.availability = { kind: "replaced", observedAt: "2026-07-23" };
  slots[0]!.replacementDecision = {
    kind: "replacement-approved",
    replacementJobRef: "sha256." + "f".repeat(64),
    tenantRef: "tenant.wrong",
    variantIntent: ["workday-posting", "account-or-direct-entry"],
    accountMode: "approved-existing-or-direct",
    reason: "Current posting preserves the frozen lane.",
    approvalRef: "s3-f1-owner-delegation-2026-08-04",
  };
  const frozen = freezeCorpusManifest(replacement);
  assert.deepEqual(validateCorpusManifest(frozen), [
    "slots[0].replacementDecision does not preserve tenantRef",
  ]);
});

test("manifest admission rejects extra URL and employer-specific fields", () => {
  const extra = candidate();
  (extra.slots as Record<string, unknown>[])[0]!.jobUrl = "https://tenant.invalid/job/1";
  const frozen = freezeCorpusManifest(extra);
  assert.deepEqual(validateCorpusManifest(frozen), [
    "slots[0] contains unsupported field jobUrl",
  ]);
});

test("source reconciliation derives opaque jobs and tenants without committing URLs", () => {
  const csv = [
    '"company name","job name","country","link"',
    ...Array.from(
      { length: 40 },
      (_, index) =>
        `"Company ${index}","Role ${index}","US","https://tenant${index}.wd5.myworkdayjobs.com/site/job/location/role_${index}?source=LinkedIn"`,
    ),
  ].join("\n");
  const manifest = corpusManifestFromCsv({
    csv,
    sourceRevision: "16c48bd1470addc9d9480d785ae84e412edd55ef",
    evidenceDigests: ["sha256." + "a".repeat(64)],
    unavailableSlots: new Map([[1, "maintenance"]]),
  });

  assert.deepEqual(validateCorpusManifest(manifest), []);
  assert.equal(JSON.stringify(manifest).includes("https://"), false);
  assert.notEqual(manifest.slots[0]!.jobRef, manifest.slots[1]!.jobRef);
  assert.equal(manifest.slots[0]!.tenantClass, "wd5");
});

test("the committed Workday manifest is frozen and valid", () => {
  const manifest = JSON.parse(
    readFileSync(resolve("corpus/workday-40/manifest.json"), "utf8"),
  );
  assert.deepEqual(validateCorpusManifest(manifest), []);
});
