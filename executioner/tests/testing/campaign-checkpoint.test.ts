import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireCampaignLock, baselineEvidencePresent, contentDigest, evidenceDigest, verifyCampaignCheckpoint } from "../../src/testing/campaign-checkpoint.ts";

test("a zero-exit or skipped browser suite cannot pass without every evidence packet", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-campaign-evidence-"));
  assert.equal(baselineEvidencePresent(root, ["job"]), false);
  mkdirSync(join(root, "job"));
  const result = { job: "job", transport: "synthetic_browser", terminal: "review", externalRequests: 0, progress: [{ checkpoint: "pre_review" }] };
  writeFileSync(join(root, "job/result.json"), JSON.stringify(result));
  writeFileSync(join(root, "job/review.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(120)]));
  writeFileSync(join(root, "job/trace.zip"), Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.alloc(120)]));
  assert.equal(baselineEvidencePresent(root, ["job"]), true);
  assert.equal(baselineEvidencePresent(root, ["job", "missing"]), false);
  writeFileSync(join(root, "job/result.json"), JSON.stringify({ ...result, externalRequests: 1 }));
  assert.equal(baselineEvidencePresent(root, ["job"]), false);
});

test("concurrent campaign cannot acquire or steal another run's lock", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-campaign-lock-"));
  const release = acquireCampaignLock(root);
  assert.throws(() => acquireCampaignLock(root), { code: "EEXIST" });
  release();
  release();
  acquireCampaignLock(root)();
});

test("source, gate identity and evidence mutation cannot silently reuse a checkpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "hunt-campaign-checkpoint-"));
  writeFileSync(join(root, "result.json"), "synthetic pass");
  const hash = evidenceDigest(root);
  assert.equal(hash, contentDigest(root, ["result.json"]));
  const checkpoint = { schemaVersion: 1, sourceSha256: "source", gates: [{ id: "baseline-1", status: "passed", directory: "attempt-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", evidenceSha256: hash }] };
  assert.deepEqual(verifyCampaignCheckpoint(checkpoint, "source", ["baseline-1"]), checkpoint);
  assert.throws(() => verifyCampaignCheckpoint(checkpoint, "other-source", ["baseline-1"]), /source mismatch/);
  assert.throws(() => verifyCampaignCheckpoint(checkpoint, "source", ["other-gate"]), /invalid checkpoint/);
  assert.throws(() => verifyCampaignCheckpoint({ ...checkpoint, gates: [...checkpoint.gates, ...checkpoint.gates] }, "source", ["baseline-1"]), /invalid checkpoint/);
  assert.throws(() => verifyCampaignCheckpoint({ ...checkpoint, gates: [{ ...checkpoint.gates[0], directory: "../../foreign" }] }, "source", ["baseline-1"]), /invalid checkpoint/);
  writeFileSync(join(root, "result.json"), "tampered");
  assert.notEqual(evidenceDigest(root), hash);
});
