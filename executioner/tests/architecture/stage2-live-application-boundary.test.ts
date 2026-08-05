import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  runStage2ApplicationWalkFromOwnerConfig,
} from "../../src/composition/s2-application-walk-runner.ts";

test("the live CLI routes the outer gate into the bound F3-to-Review composition", async () => {
  const gateSource = await readFile(
    new URL("../../scripts/run-s2-acceptance.ts", import.meta.url),
    "utf8",
  );
  const source = await readFile(
    new URL("../../scripts/run-s2-review.ts", import.meta.url),
    "utf8",
  );
  assert.match(gateSource, /createLocalStage2AcceptancePorts/u);
  assert.match(gateSource, /executeStage2AcceptanceCli/u);
  assert.match(source, /runStage2RealJourney/u);
  assert.match(source, /stage2RealJourneyRuntimeBinding/u);
  const production = await readFile(
    new URL("../../src/acceptance/s2-production-binding.ts", import.meta.url),
    "utf8",
  );
  assert.match(production, /createStage2ApplicationWalkProductionBinding/u);
  assert.match(production, /createStage2RealJourneyProductionBinding/u);
  const composition = await readFile(
    new URL("../../src/acceptance/s2-journey.ts", import.meta.url),
    "utf8",
  );
  for (const checkpoint of [
    "resume_verified",
    "profile_verified",
    "questionnaire_verified",
    "pre_review",
  ]) assert.match(composition, new RegExp(checkpoint, "u"));
  assert.match(composition, /recoverBrowserInterruption/u);
  assert.match(composition, /stopAtVerifiedReview/u);
  assert.match(composition, /writeLiveEvidencePacket/u);
  const slice = await readFile(
    new URL("../../scripts/run-s2-real.ts", import.meta.url),
    "utf8",
  );
  assert.match(slice, /s2-application-walk-runner/u);
});

test("production composition fails closed until the live application runtime is injected", async () => {
  const result = await runStage2ApplicationWalkFromOwnerConfig({
    configPath: "C:\\protected\\transient\\run_20260803_abcdefghijklmnop\\owner-input.json",
    evidenceRoot: "C:\\protected\\retained\\run_20260803_abcdefghijklmnop\\evidence",
    checkpoint: "pre_review",
  }, new AbortController().signal);

  assert.deepEqual(result, { ok: false, code: "owner_config_invalid" });
});
