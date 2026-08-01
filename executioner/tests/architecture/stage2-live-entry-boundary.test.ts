import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { livePortNames } from "../../src/contracts/live/index.ts";

test("F1-T3 remains F5 read-only classification without widening live ports", async () => {
  assert.deepEqual(livePortNames, [
    "PersistentBrowserSession",
    "SecretStore",
    "CredentialMutationAdapter",
    "PrivilegedGmailAuthExecutor",
    "MailboxProvider",
    "VerificationArtifact",
    "PrivilegedVerificationNavigator",
    "LiveCheckpointStore",
    "LiveEvidenceSink",
  ]);
  const production = await sources([
    "ats/workday/live/classifiers.ts",
    "ats/workday/live/account-state.ts",
    "ats/workday/live/verification.ts",
  ]);
  for (const forbidden of [
    "browser/playwright-live",
    "targetUrl",
    "rawText",
    "rawHtml",
    "href",
    "selector",
    "credential",
    "password",
  ]) {
    assert.equal(production.includes(forbidden), false, forbidden);
  }
});

test("T5 public classified-account seam cannot see structural traits", async () => {
  const publicTypes = await source("ats/workday/live/types.ts");
  const publicFacade = await source("ats/workday/live/index.ts");
  for (const forbidden of [
    "LiveEntryStructuralSource",
    "LiveEntryStructuralSnapshot",
    "traitIds",
    "controlCount",
    "requiredControlCount",
    "optionCount",
  ]) {
    assert.equal(publicTypes.includes(forbidden), false, forbidden);
    assert.equal(publicFacade.includes(forbidden), false, forbidden);
  }
  for (const required of [
    "ClassifiedAccountObservationSource",
    "classificationId",
    "sourceRevisionId",
    "snapshotId",
    "documentGenerationId",
  ]) {
    assert.equal(publicTypes.includes(required), true, required);
  }
});

test("composition is the sole T2-to-T3 structural adapter", async () => {
  const adapter = await source("composition/s2-live-entry-source.ts");
  assert.match(adapter, /inspectOwnedTarget/u);
  assert.match(adapter, /inspectFresh/u);
  assert.equal(adapter.includes("playwright-live/private"), false);
  assert.equal(adapter.includes("src/browser"), false);
});

async function sources(relativePaths: readonly string[]): Promise<string> {
  return (await Promise.all(relativePaths.map(source))).join("\n");
}

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../../src/${relativePath}`, import.meta.url), "utf8");
}
