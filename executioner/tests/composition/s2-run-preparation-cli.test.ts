import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { parseStage2RunPreparationArgs } from "../../src/composition/s2-run-preparation-cli.ts";

const storageRoot = resolve("C:\\protected\\hunt-c3-storage");
const targetUrl = "https://blackrock.wd1.myworkdayjobs.com/en-US/Careers/job/Test_R265422";

test("run preparation CLI accepts only the storage root, exact target, and account mode", () => {
  assert.deepEqual(parseStage2RunPreparationArgs([
    "--storage-root", storageRoot,
    "--target-url", targetUrl,
    "--account-mode", "sign_in",
  ]), { storageRoot, targetUrl, accountMode: "sign_in" });
});

test("run preparation CLI rejects caller-supplied IDs and malformed argument sets", () => {
  for (const values of [
    ["--storage-root", storageRoot, "--target-url", targetUrl, "--account-mode", "other"],
    ["--storage-root", "relative", "--target-url", targetUrl, "--account-mode", "sign_in"],
    ["--storage-root", storageRoot, "--target-url", targetUrl, "--run-key", "remember-me"],
    ["--storage-root", storageRoot, "--target-url", targetUrl],
  ]) {
    assert.throws(() => parseStage2RunPreparationArgs(values), /invalid Stage 2 run preparation arguments/u);
  }
});
