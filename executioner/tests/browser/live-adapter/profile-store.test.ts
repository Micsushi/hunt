import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

test("profile cleanup revalidates beyond three transient Windows removal races", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-profile-cleanup-race-"));
  const profilePath = join(root, "profile");
  let removalCalls = 0;
  const store = new FileProfileStore(async (path, options) => {
    removalCalls += 1;
    assert.equal(path, profilePath);
    assert.deepEqual(options, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    if (removalCalls <= 3) {
      throw Object.assign(new Error("transient Windows profile lock"), { code: "EPERM" });
    }
    await rm(path, options);
  });
  try {
    await store.write(profilePath, {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      profileLeaseId: liveFixtures.session.profileLeaseId,
      sessionId: liveFixtures.session.sessionId,
      target: liveFixtures.target,
      admittedAt: liveFixtures.issuedAt,
      leaseExpiresAt: liveFixtures.expiresAt,
    });
    await store.cleanupPartial(profilePath);
    assert.equal(removalCalls, 4);
    assert.equal(await store.read(profilePath), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile cleanup admits only an empty direct directory held until process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunt-profile-process-lock-"));
  const profilePath = join(root, "profile");
  let removalCalls = 0;
  const store = new FileProfileStore(async (path) => {
    removalCalls += 1;
    for (const child of await readdir(path)) {
      await rm(join(path, child), { recursive: true, force: true });
    }
    throw Object.assign(new Error("directory handle remains held by this process"), {
      code: "EPERM",
    });
  });
  try {
    await store.write(profilePath, {
      schemaVersion: 1,
      journeyId: liveFixtures.journeyId,
      profileLeaseId: liveFixtures.session.profileLeaseId,
      sessionId: liveFixtures.session.sessionId,
      target: liveFixtures.target,
      admittedAt: liveFixtures.issuedAt,
      leaseExpiresAt: liveFixtures.expiresAt,
    });
    await store.cleanupPartial(profilePath);
    assert.equal(removalCalls, 1);
    assert.deepEqual(await readdir(profilePath), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
