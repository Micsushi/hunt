import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { liveFixtures } from "../../../src/testing/live/index.ts";
import { FileProfileStore } from "../../../src/browser/playwright-live/private/file-profile-store.ts";

test("profile marker is atomic, value-free, exact, and removable only by its owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-profile-store-"));
  const profilePath = join(root, "profile");
  const store = new FileProfileStore();
  const marker = {
    schemaVersion: 1 as const,
    journeyId: liveFixtures.journeyId,
    profileLeaseId: liveFixtures.session.profileLeaseId,
    sessionId: liveFixtures.session.sessionId,
    target: liveFixtures.target,
    admittedAt: liveFixtures.issuedAt,
    leaseExpiresAt: liveFixtures.expiresAt,
  };
  try {
    assert.equal(await store.read(profilePath), undefined);
    await store.write(profilePath, marker);
    assert.deepEqual(await store.read(profilePath), marker);
    const raw = await readFile(join(profilePath, ".hunt-profile-v1.json"), "utf8");
    for (const forbidden of ["https://", "myworkdayjobs", "Example_R12345"]) {
      assert.equal(raw.includes(forbidden), false, forbidden);
    }
    await assert.rejects(
      store.cleanup(profilePath, { ...marker, journeyId: liveFixtures.otherJourneyId }),
      /marker mismatch/u,
    );
    assert.deepEqual(await store.read(profilePath), marker);
    await store.cleanup(profilePath, marker);
    assert.equal(await store.read(profilePath), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
