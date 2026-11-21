import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalProbeRegistry,
  createContractProviderFactory,
  createFixtureRuntimeFake,
  contractProviderFactories,
  statefulScenarioProviderFactories,
  runControlSliceCompatibilityProbe,
  runFieldSliceCompatibilityProbe,
} from "../../../src/testing/contracts/index.ts";

test("the canonical F2-F8 field slice reports every exact contract edge", async () => {
  const report = await runFieldSliceCompatibilityProbe();
  assert.equal(report.root, "F2-F8-field-slice");
  assert.equal(report.evidence, "canonical-fake-kit-only");
  assert.deepEqual(report.edges, [
    "F2.fixture.start",
    "F2.fixture.reset",
    "F2.fixture.setFault",
    "F2.fixture.cleanup-as-fixture-close",
    "F3.browser.start",
    "F3.browser.observe",
    "F3.browser.mutate",
    "F3.browser.navigate",
    "F3.browser.close",
    "F5.understanding.understand",
    "F6.answers.resolve",
    "F7.driver.drive",
    "F8.verifier.verify",
    "F8.navigation.complete",
    "F8.navigation.reconcile",
  ]);
  assert.deepEqual(report.controls, [
    "s1-field-given-name",
    "s1-field-family-name",
    "s1-field-phone-number",
    "s1-field-interest",
    "s1-field-work-authorization",
    "s1-field-age-requirement",
    "s1-field-sponsorship",
    "s1-field-country",
    "s1-field-start-date",
    "s1-field-resume",
  ]);
});

test("the canonical MCP/F9/F4/F10/F11 control slice reports every exact edge", async () => {
  const report = await runControlSliceCompatibilityProbe();
  assert.equal(report.root, "MCP-F9-F4-F10-F11-control-slice");
  assert.equal(report.evidence, "canonical-fake-kit-only");
  assert.deepEqual(report.edges, [
    "MCP.handle.start_journey",
    "MCP.handle.cancel_journey",
    "MCP.handle.journey_status",
    "MCP.handle.journey_result",
    "F9.journey.start",
    "F9.journey.cancel",
    "F9.journey.status",
    "F9.journey.result",
    "F4.intake.bootstrap",
    "F4.state.load",
    "F4.state.transition",
    "F4.profile.query",
    "F10.events.append",
    "F10.progress.read",
    "F10.failure.report",
    "F11.privacy.admit",
    "F11.safety.admit",
    "F11.evidence.write",
    "F11.evidence.read",
  ]);
});
