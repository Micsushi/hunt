import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { livePortNames } from "../../src/contracts/live/index.ts";

test("F1-T2 remains inside F3 ownership and does not widen the frozen live ports", async () => {
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
  const session = await source("session.ts");
  const factory = await source("factory.ts");
  for (const forbidden of [
    "/ats/",
    "/form/",
    "/testing/",
    "/live/preflight/",
    "connectOverCDP",
    "bringToFront",
  ]) {
    assert.equal((session + factory).includes(forbidden), false, forbidden);
  }
});

test("owned inspection remains a class capability with value-free fields", async () => {
  const liveTypes = await source("private/types.ts");
  const publicFacade = await source("index.ts");
  assert.match(liveTypes, /ValueFreeOwnedPageSnapshot/u);
  assert.match(liveTypes, /traitIds/u);
  for (const forbidden of ["rawHtml", "rawText", "origin", "pathname", "href"]) {
    assert.equal(liveTypes.includes(forbidden), false, forbidden);
  }
  assert.equal(publicFacade.includes("OwnedTargetProbe"), false);
  assert.equal(publicFacade.includes("ValueFreeOwnedPageSnapshot"), false);
});

async function source(relativePath: string): Promise<string> {
  return readFile(
    new URL(`../../src/browser/playwright-live/${relativePath}`, import.meta.url),
    "utf8",
  );
}
