import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesStage2OwnerStorageBinding,
  stage2StorageRootForOwnerBinding,
} from "../../src/composition/private/s2-owner-storage-binding.ts";

test("accepts the exact separated transient owner and retained evidence binding", () => {
  assert.equal(matchesStage2OwnerStorageBinding({
    ownerConfigPath: "C:\\Hunt\\transient\\run_20260804_0123456789abcdef\\owner-input.json",
    runtimeRoot: "C:\\Hunt\\transient\\run_20260804_0123456789abcdef\\runtime",
    ownerEvidenceRoot: "C:\\Hunt\\retained\\run_20260804_0123456789abcdef\\evidence",
    requestedEvidenceRoot: "C:\\Hunt\\retained\\run_20260804_0123456789abcdef\\evidence",
  }), true);
  assert.equal(stage2StorageRootForOwnerBinding({
    ownerConfigPath: "C:\\Hunt\\transient\\run_20260804_0123456789abcdef\\owner-input.json",
    runtimeRoot: "C:\\Hunt\\transient\\run_20260804_0123456789abcdef\\runtime",
    ownerEvidenceRoot: "C:\\Hunt\\retained\\run_20260804_0123456789abcdef\\evidence",
    requestedEvidenceRoot: "C:\\Hunt\\retained\\run_20260804_0123456789abcdef\\evidence",
  }), "C:\\Hunt");
});

test("rejects the legacy nested owner and every crossed owner binding", () => {
  const base = {
    ownerConfigPath: "C:\\Hunt\\transient\\run_20260804_0123456789abcdef\\owner-input.json",
    runtimeRoot: "C:\\Hunt\\transient\\run_20260804_0123456789abcdef\\runtime",
    ownerEvidenceRoot: "C:\\Hunt\\retained\\run_20260804_0123456789abcdef\\evidence",
    requestedEvidenceRoot: "C:\\Hunt\\retained\\run_20260804_0123456789abcdef\\evidence",
  };
  const crossed = [
    { ...base, ownerConfigPath: `${base.runtimeRoot}\\owner-input.json` },
    { ...base, ownerConfigPath: base.ownerConfigPath.replace("owner-input.json", "other.json") },
    { ...base, runtimeRoot: "C:\\Hunt\\transient\\run_20260804_fedcba9876543210\\runtime" },
    { ...base, ownerEvidenceRoot: "C:\\Hunt\\retained\\run_20260804_fedcba9876543210\\evidence" },
    { ...base, requestedEvidenceRoot: "C:\\Hunt\\retained\\run_20260804_fedcba9876543210\\evidence" },
  ];
  for (const value of crossed) {
    assert.equal(matchesStage2OwnerStorageBinding(value), false);
  }
});
