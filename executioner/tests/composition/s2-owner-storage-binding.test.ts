import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  matchesStage2OwnerStorageBinding,
  stage2StorageRootForOwnerBinding,
} from "../../src/composition/private/s2-owner-storage-binding.ts";

const storageRoot = resolve("hunt-storage-fixture");
const runKey = "run_20260804_0123456789abcdef";
const base = {
  ownerConfigPath: join(storageRoot, "transient", runKey, "owner-input.json"),
  runtimeRoot: join(storageRoot, "transient", runKey, "runtime"),
  ownerEvidenceRoot: join(storageRoot, "retained", runKey, "evidence"),
  requestedEvidenceRoot: join(storageRoot, "retained", runKey, "evidence"),
};

test("accepts the exact separated transient owner and retained evidence binding", () => {
  assert.equal(matchesStage2OwnerStorageBinding(base), true);
  assert.equal(stage2StorageRootForOwnerBinding(base), storageRoot);
});

test("rejects the legacy nested owner and every crossed owner binding", () => {
  const otherRun = "run_20260804_fedcba9876543210";
  const crossed = [
    { ...base, ownerConfigPath: join(base.runtimeRoot, "owner-input.json") },
    { ...base, ownerConfigPath: base.ownerConfigPath.replace("owner-input.json", "other.json") },
    { ...base, runtimeRoot: join(storageRoot, "transient", otherRun, "runtime") },
    { ...base, ownerEvidenceRoot: join(storageRoot, "retained", otherRun, "evidence") },
    { ...base, requestedEvidenceRoot: join(storageRoot, "retained", otherRun, "evidence") },
  ];
  for (const value of crossed) {
    assert.equal(matchesStage2OwnerStorageBinding(value), false);
  }
});
