import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { createCorpusBaseline } from "../../../src/corpus/runner/index.ts";
import {
  createPageUiExecutionRecord,
  pageUiImplementationDigest,
  validatePageUiExecutionRecord,
} from "../../../src/corpus/page-ui-plan/execution.ts";

const root = resolve(import.meta.dirname, "../../..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), "utf8"));

test("the frozen page/UI matrix reconciles exact execution proof on one implementation revision", () => {
  const manifest = readJson("corpus/workday-40/manifest.json");
  const fixtures = readJson("fixtures/workday/corpus/manifest.json");
  const variants = readJson("corpus/workday-40/variants.json");
  const plan = readJson("corpus/workday-40/page-ui-variants.json") as {
    impactSha: string;
    variants: readonly { id: string; affectedSlots: readonly string[] }[];
  };
  const impact = readJson("corpus/workday-40/contract-impact.json") as {
    impactSha: string;
    basis: { runtimeRevision: string };
    allowedTerminalCodes: readonly string[];
  };
  assert.equal(plan.impactSha, impact.impactSha);
  const implementationDigest = pageUiImplementationDigest(root, plan);
  const record = process.env.HUNT_PAGE_UI_EXECUTION_RECORD === undefined
    ? createPageUiExecutionRecord(plan, implementationDigest, plan.variants.map(({ id }) => id))
    : JSON.parse(process.env.HUNT_PAGE_UI_EXECUTION_RECORD) as unknown;
  assert.deepEqual(validatePageUiExecutionRecord(record, plan, implementationDigest), []);
  const baseline = createCorpusBaseline({
    manifest,
    fixtures,
    variants,
    sourceRevision: impact.basis.runtimeRevision,
    fixtureRoot: resolve(root, "fixtures/workday/corpus"),
  });
  const pairs = plan.variants.flatMap((variant) =>
    variant.affectedSlots.map((slotId) => ({ slotId, variantId: variant.id }))
  );
  assert.equal(pairs.length, 52);
  for (const { slotId, variantId } of pairs) {
    const outcome = baseline.outcomes.find((candidate) => candidate.slotId === slotId);
    assert.ok(outcome !== undefined, `missing ${slotId}`);
    assert.ok(outcome.affectedVariants.includes(variantId), `${slotId} did not run ${variantId}`);
  }
  const activatedSlots = new Set(pairs.map(({ slotId }) => slotId));
  assert.equal(activatedSlots.size, 38);
  assert.equal(activatedSlots.has("WD40-009"), false);
  assert.equal(activatedSlots.has("WD40-021"), false);
  const terminalCodes = [...new Set(baseline.outcomes.map((outcome) =>
    outcome.kind === "posting_unavailable" ? `${outcome.kind}:${outcome.reason}` : outcome.kind
  ))].sort();
  assert.deepEqual(terminalCodes, [...impact.allowedTerminalCodes].sort());
  assert.deepEqual(baseline.cleanup, { browserOpened: false, retainedRawCapture: false });
  assert.deepEqual(baseline.safety, { liveAccountMutation: false, finalSubmitActivated: false });
});

test("matrix reconciliation rejects a missing activated behavior execution", () => {
  const plan = readJson("corpus/workday-40/page-ui-variants.json") as {
    variants: readonly { id: string }[];
  };
  const digest = pageUiImplementationDigest(root, plan);
  const record = createPageUiExecutionRecord(plan, digest, plan.variants.slice(1).map(({ id }) => id));
  assert.ok(validatePageUiExecutionRecord(record, plan, digest).includes("not every activated variant executed"));
});
