import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const expected = {
  schemaVersion: 1,
  stage: "s2",
  feature: "s2-f2-t3",
  assemblyBaseRevision: "7479b9fc89bc7853ab8a19b3f1096854d3fb2baf",
  acceptedInputs: {
    s2F0: "730846b57a8ab7901a9818794921f8f9da01e0ed",
    s2F1T5: "d6602abf41f181376164eac2d32d587fc6bf5a5b",
    s2F2T1: "1493a1dcf26bc53666d47385a5b4984dc842b026",
    s2F2T2Atomic: "523c3d78131a13692e3ba6c3e0afb3c7734ed2d2",
    s2F2IntegratedPrerequisites: "7479b9fc89bc7853ab8a19b3f1096854d3fb2baf",
  },
  frozenContractRevision: "100b6bbf360f2c2e3cd93384e1fba7c115a92f15",
  frozenContractTree: "13a8406e9c296b77aead3a0f961beba1110fba61",
};

test("S2-F2-T3 manifest pins the exact accepted non-self-referential assembly", () => {
  const value = JSON.parse(readFileSync(resolve("docs/s2-integration-manifest.json"), "utf8"));
  assert.deepEqual(value, expected);
  for (const revision of Object.values(expected.acceptedInputs)) {
    execFileSync("git", ["merge-base", "--is-ancestor", revision, expected.assemblyBaseRevision]);
  }
  assert.equal(
    execFileSync("git", ["cat-file", "-t", expected.frozenContractTree], { encoding: "utf8" }).trim(),
    "tree",
  );
});
