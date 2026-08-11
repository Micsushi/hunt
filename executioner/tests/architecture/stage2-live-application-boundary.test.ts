import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  runStage2ApplicationWalkFromOwnerConfig,
} from "../../src/composition/s2-application-walk-runner.ts";
import { stage2RealJourneyRuntimeBinding } from "../../src/acceptance/s2-production-binding.ts";
import type { PlaywrightPersistentBrowserFactoryOptions } from
  "../../src/browser/playwright-live/factory.ts";
import type { PlaywrightPersistentBrowserSessionOptions } from
  "../../src/browser/playwright-live/private/types.ts";

type FactoryCanInjectApplicationPage = "applicationPage" extends
  keyof PlaywrightPersistentBrowserFactoryOptions ? true : false;
type SessionCanInjectApplicationPage = "applicationPage" extends
  keyof PlaywrightPersistentBrowserSessionOptions ? true : false;

const factoryCanInjectApplicationPage: FactoryCanInjectApplicationPage = false;
const sessionCanInjectApplicationPage: SessionCanInjectApplicationPage = false;

test("the live CLI routes the outer gate into the bound F3-to-Review composition", async () => {
  assert.equal(factoryCanInjectApplicationPage, false);
  assert.equal(sessionCanInjectApplicationPage, false);
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
  assert.equal(typeof stage2RealJourneyRuntimeBinding.bind, "function");
  const runtime = await readFile(
    new URL("../../src/acceptance/s2-playwright-runtime.ts", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /ownedApplicationPageAccess/u);
  assert.doesNotMatch(runtime, /ownedApplicationPageAccess\][\s\S]{0,300}\(page\)/u);
  const applicationCapability = await readFile(
    new URL("../../src/browser/playwright-live/private/application-page-types.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(applicationCapability, /use:\s*\(page/u);
  assert.match(applicationCapability, /OwnedApplicationOperation/u);
  assert.doesNotMatch(applicationCapability, /execute\s*\([^)]*page/u);
  assert.doesNotMatch(applicationCapability, /PersistentPage/u);
  const factory = await readFile(
    new URL("../../src/browser/playwright-live/factory.ts", import.meta.url),
    "utf8",
  );
  const session = await readFile(
    new URL("../../src/browser/playwright-live/session.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(factory, /applicationPage\??:/u);
  assert.doesNotMatch(factory, /options\.applicationPage/u);
  assert.doesNotMatch(session, /options\.applicationPage\.execute/u);
  assert.doesNotMatch(session, /this\.#options\s*=\s*options/u);
  assert.match(session, /new RevocableWorkdayApplicationRuntime\(runtimeOptions\)/u);
  assert.match(session, /this\.#applicationRuntime\.revoke\(\)/u);
  assert.doesNotMatch(factory, /execute\s*:\s*(?:async\s*)?\([^)]*page/u);
  assert.match(runtime, /createPlaywrightPersistentBrowserSession/u);
  assert.doesNotMatch(runtime, /(?:click|press|activate)[A-Za-z]*(?:Submit|submit)/u);
  const composition = await readFile(
    new URL("../../src/acceptance/s2-journey.ts", import.meta.url),
    "utf8",
  );
  for (const checkpoint of [
    "checkpointForApplicationPage",
    "isValidApplicationPageSequence",
    "maximumApplicationPageVisits",
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

test("the standalone F3 slice fails closed without an explicitly injected binding", async () => {
  const result = await runStage2ApplicationWalkFromOwnerConfig({
    configPath: "C:\\protected\\transient\\run_20260803_abcdefghijklmnop\\owner-input.json",
    evidenceRoot: "C:\\protected\\retained\\run_20260803_abcdefghijklmnop\\evidence",
    checkpoint: "pre_review",
  }, new AbortController().signal);

  assert.deepEqual(result, { ok: false, code: "owner_config_invalid" });
});

test("the production Stage 2 MCP entry binds stdio to one prepared run only", async () => {
  const source = await readFile(
    new URL("../../scripts/run-s2-mcp.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /parseStage2RealAcceptanceArgs/u);
  assert.match(source, /createStage2McpFromPreparedRun/u);
  assert.match(source, /serveStage2McpStdio/u);
  assert.doesNotMatch(source, /(?:click|press|activate)[A-Za-z]*(?:Submit|submit)/u);
});
